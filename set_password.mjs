#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    open,
    readFile,
    rename,
    rm
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { displayPath, getConfiguredPaths } from './paths.mjs';
import { withVaultWriterLock } from './writer_lock.mjs';
import {
    DEFAULT_ITERATIONS,
    FORMAT_VERSION,
    createPasswordKeySlot,
    decryptManifestV2,
    parseEnvelopeText,
    randomHex,
    serializeEnvelope,
    unlockVaultKey,
    validateEnvelopeV2
} from './vault_format.mjs';

const DEFAULT_MANIFEST_NAME = 'manifest.enc';

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const { outputDir, passwordFile } = getConfiguredPaths(options);
    let newPassword = options.password;
    if (newPassword === null) {
        const first = await promptHidden('New password: ');
        const second = await promptHidden('Confirm new password: ');
        if (first !== second) {
            throw new Error('New passwords do not match.');
        }
        newPassword = first;
    }
    validatePassword(newPassword, options);
    await rotatePassword({
        outputDir,
        manifestName: options.manifestName,
        passwordFile,
        iterations: options.iterations,
        newPassword
    });
}

export async function rotatePassword(options) {
    const outputDir = path.resolve(options.outputDir);
    return withVaultWriterLock(outputDir, () => rotatePasswordUnlocked({ ...options, outputDir }));
}

async function rotatePasswordUnlocked(options) {
    const outputDir = path.resolve(options.outputDir);
    const passwordFile = path.resolve(options.passwordFile);
    const manifestName = options.manifestName || DEFAULT_MANIFEST_NAME;
    const manifestPath = path.join(outputDir, manifestName);
    if (passwordFile === manifestPath) {
        throw new Error('Password file and encrypted manifest must be different files.');
    }
    if (!await exists(manifestPath)) {
        throw new Error('No encrypted manifest exists. Create or migrate the v2 vault before rotating its password.');
    }

    const envelope = parseEnvelopeText(await readFile(manifestPath, 'utf8'));
    if (envelope.version !== FORMAT_VERSION) {
        throw new Error('Password rotation requires a v2 vault. Run encrypt_files.mjs --migrate-v1 first.');
    }
    validateEnvelopeV2(envelope);

    const currentPassword = options.currentPassword ?? await readCurrentPassword(passwordFile);
    const generatedPassword = options.generatedPassword === true;
    const newPassword = options.newPassword ?? (
        generatedPassword ? randomBytes(24).toString('base64url') : null
    );
    if (!newPassword) {
        throw new Error('A new password is required.');
    }
    validatePassword(newPassword, { allowWeakPassword: generatedPassword });

    const { vaultKey, slotId: currentSlotId } = unlockVaultKey(envelope, currentPassword);
    const originalManifest = decryptManifestV2(envelope, vaultKey);
    const currentSlot = envelope.keySlots.find((slot) => slot.id === currentSlotId);
    const newSlot = createPasswordKeySlot(newPassword, vaultKey, envelope.vaultId, {
        iterations: options.iterations ?? DEFAULT_ITERATIONS
    });

    const dualEnvelope = {
        ...envelope,
        keySlots: [currentSlot, newSlot]
    };
    validateEnvelopeV2(dualEnvelope);
    verifyEnvelopePassword(dualEnvelope, currentPassword, originalManifest);
    verifyEnvelopePassword(dualEnvelope, newPassword, originalManifest);

    triggerFailpoint('rotation-before-dual-slot');
    await replaceEnvelopeAtomic(manifestPath, dualEnvelope);
    triggerFailpoint('rotation-after-dual-slot');
    triggerFailpoint('rotation-before-password-file');

    await replaceSecretFileAtomic(passwordFile, `${newPassword}\n`);
    triggerFailpoint('rotation-after-password-file');
    triggerFailpoint('rotation-before-final-slot');

    const finalEnvelope = {
        ...envelope,
        keySlots: [newSlot]
    };
    validateEnvelopeV2(finalEnvelope);
    verifyEnvelopePassword(finalEnvelope, newPassword, originalManifest);
    await replaceEnvelopeAtomic(manifestPath, finalEnvelope);
    triggerFailpoint('rotation-after-final-slot');

    console.log(`Password rotation complete for ${displayPath(manifestPath)}; encrypted blob count changed: 0.`);
    console.log(`Updated ${displayPath(passwordFile)} atomically.`);
    return { newPassword, keySlotId: newSlot.id };
}

function verifyEnvelopePassword(envelope, password, expectedManifest) {
    const { vaultKey } = unlockVaultKey(envelope, password);
    const manifest = decryptManifestV2(envelope, vaultKey);
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
        throw new Error('Password rotation changed the encrypted manifest body unexpectedly.');
    }
}

async function replaceEnvelopeAtomic(manifestPath, envelope) {
    const outputDir = path.dirname(manifestPath);
    await mkdir(outputDir, { recursive: true });
    const stageRoot = await mkdtemp(path.join(path.dirname(outputDir), '.print-drive-rotate-'));
    const stagedPath = path.join(stageRoot, path.basename(manifestPath));
    try {
        await writeDurableExclusive(stagedPath, serializeEnvelope(envelope), 0o644);
        await rename(stagedPath, manifestPath);
        await syncDirectoryBestEffort(path.dirname(manifestPath));
    } finally {
        await rm(stageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function replaceSecretFileAtomic(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const secretStageDir = path.join(path.dirname(filePath), '.tmp');
    await mkdir(secretStageDir, { recursive: true });
    const temporaryPath = path.join(
        secretStageDir,
        `${path.basename(filePath)}.${randomHex(8)}.tmp`
    );
    try {
        await writeDurableExclusive(temporaryPath, value, 0o600);
        await rename(temporaryPath, filePath);
        try {
            await chmod(filePath, 0o600);
        } catch {
            // Windows may not apply POSIX modes. Never log the secret value.
        }
        await syncDirectoryBestEffort(path.dirname(filePath));
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function writeDurableExclusive(filePath, data, mode) {
    const handle = await open(filePath, 'wx', mode);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function syncDirectoryBestEffort(directory) {
    try {
        const handle = await open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Directory fsync is not consistently available on Windows.
    }
}

async function readCurrentPassword(passwordFile) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) {
        return process.env.PRINT_DRIVE_PASSPHRASE;
    }
    if (!await exists(passwordFile)) {
        throw new Error(`Current password file not found: ${displayPath(passwordFile)}`);
    }
    const value = stripOneLineEnding(await readFile(passwordFile, 'utf8'));
    if (!value) {
        throw new Error(`Current password file is empty: ${displayPath(passwordFile)}`);
    }
    return value;
}

function parseArgs(args) {
    const options = {
        allowWeakPassword: false,
        allowCliPassword: false,
        passwordFile: null,
        output: null,
        manifestName: DEFAULT_MANIFEST_NAME,
        iterations: DEFAULT_ITERATIONS,
        password: null
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--allow-weak-password') {
            options.allowWeakPassword = true;
        } else if (arg === '--allow-cli-password') {
            options.allowCliPassword = true;
        } else if (arg === '--password-file') {
            options.passwordFile = requireValue(args, ++index, arg);
        } else if (arg === '--out') {
            options.output = requireValue(args, ++index, arg);
        } else if (arg === '--manifest') {
            options.manifestName = requireValue(args, ++index, arg);
        } else if (arg === '--iterations') {
            options.iterations = Number(requireValue(args, ++index, arg));
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positional.push(arg);
        }
    }
    if (positional.length > 0 && !options.allowCliPassword) {
        throw new Error('CLI password input is disabled by default because it can remain in shell history.');
    }
    if (positional.length > 1) {
        throw new Error('Only one new password argument is allowed.');
    }
    if (positional.length === 1) {
        options.password = positional[0];
    }
    if (!Number.isInteger(options.iterations) || options.iterations < 200000 || options.iterations > 2000000) {
        throw new Error('--iterations must be an integer from 200000 through 2000000.');
    }
    if (!options.manifestName || path.basename(options.manifestName) !== options.manifestName) {
        throw new Error('--manifest must be a filename, not a path.');
    }
    return options;
}

function requireValue(args, index, optionName) {
    if (!args[index]) {
        throw new Error(`${optionName} requires a value.`);
    }
    return args[index];
}

function validatePassword(password, options) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('Password is required.');
    }
    if (Array.from(password).length > 1024) {
        throw new Error('Password must not exceed 1024 Unicode characters.');
    }
    const numericOnly = /^\d+$/.test(password);
    if (numericOnly && password.length < 8) {
        throw new Error('Numeric-only passwords must be at least 8 digits, even with --allow-weak-password.');
    }
    const weakReasons = [];
    if (Array.from(password).length < 12) {
        weakReasons.push('passwords shorter than 12 characters are not allowed by default');
    }
    if (numericOnly) {
        weakReasons.push('numeric-only passwords are considered weak');
    }
    if (weakReasons.length > 0 && !options.allowWeakPassword) {
        throw new Error(`Weak password rejected: ${weakReasons.join('; ')}.`);
    }
    if (weakReasons.length > 0) {
        console.warn(`Warning: weak password accepted (${weakReasons.join('; ')}).`);
    }
}

function triggerFailpoint(name) {
    const configured = (process.env.PRINT_DRIVE_FAILPOINT || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (configured.includes(name)) {
        const error = new Error(`Injected Print Drive failure at ${name}.`);
        error.code = 'ERR_PRINT_DRIVE_FAILPOINT';
        error.failpoint = name;
        throw error;
    }
}

function stripOneLineEnding(value) {
    return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

function promptHidden(question) {
    if (!process.stdin.isTTY) {
        throw new Error('No TTY available. Use --allow-cli-password only if shell history exposure is acceptable.');
    }
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        let input = '';
        stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const onData = (char) => {
            if (char === '\u0003') {
                stdout.write('\n');
                process.exit(1);
            }
            if (char === '\r' || char === '\n') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.off('data', onData);
                stdout.write('\n');
                resolve(input);
                return;
            }
            if (char === '\u0008' || char === '\u007f') {
                input = input.slice(0, -1);
                return;
            }
            input += char;
        };
        stdin.on('data', onData);
    });
}

function printHelp() {
    console.log(`Usage: node set_password.mjs [options]

Options:
  --password-file <path>      Local ignored passphrase file.
  --out <dir>                 Public encrypted output directory.
  --manifest <name>           Encrypted manifest filename. Default: ${DEFAULT_MANIFEST_NAME}
  --iterations <number>       PBKDF2 count for the new key slot. Default: ${DEFAULT_ITERATIONS}
  --allow-cli-password        Allow one positional new password argument.
  --allow-weak-password       Explicitly allow a weak new password.

Rotation changes only key slots and the local password file. Manifest ciphertext and blobs remain byte-identical.
`);
}

async function exists(filePath) {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
