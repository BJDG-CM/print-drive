#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, validateConfigObject } from '../config.mjs';
import { fileRelativePath, readSourceFiles, writeSourceState } from '../encrypt_files.mjs';
import { getConfiguredPaths, getProjectConfig, PROJECT_ROOT } from '../paths.mjs';
import {
    decryptFileV2,
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';

export async function restoreSource(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const loaded = getProjectConfig();
    const runtime = getConfiguredPaths({
        source: options.source,
        output: options.output,
        passwordFile: options.passwordFile,
        requireDirectories: false
    });

    await assertTargetIsSafe(runtime.sourceDir, options.forceEmpty);
    const passphrase = await readPassphrase(runtime.passwordFile);
    const manifestPath = path.join(runtime.outputDir, 'manifest.enc');
    const envelope = parseEnvelopeText(await readFile(manifestPath, 'utf8'));
    validateEnvelopeV2(envelope);
    if (options.expectedVaultId && envelope.vaultId !== options.expectedVaultId) {
        throw new Error(`Vault ID mismatch: expected ${options.expectedVaultId}, found ${envelope.vaultId}.`);
    }

    const unlocked = unlockVaultKey(envelope, passphrase);
    const stagingParent = path.dirname(runtime.sourceDir);
    await mkdir(stagingParent, { recursive: true });
    const staging = await mkdtemp(path.join(stagingParent, '.print-drive-restore-'));
    let manifest;
    try {
        manifest = decryptManifestV2(envelope, unlocked.vaultKey);
        for (const file of manifest.files) {
            const relativePath = fileRelativePath(file);
            const target = path.join(staging, ...relativePath.split('/'));
            const encrypted = await readFile(path.join(runtime.outputDir, `${file.blobId}.bin`));
            const plaintext = decryptFileV2(file, encrypted, unlocked.vaultKey, envelope.vaultId);
            try {
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, plaintext, { flag: 'wx', mode: 0o600 });
            } finally {
                plaintext.fill(0);
                encrypted.fill(0);
            }
        }

        const restored = await readSourceFiles(staging, { fullScan: true });
        verifyExactMatch(restored, manifest.files);

        await rm(runtime.sourceDir, { recursive: true, force: true });
        await rename(staging, runtime.sourceDir);
        await updateLocalConfig(loaded, runtime.sourceDir);
        const finalFiles = await readSourceFiles(runtime.sourceDir, { fullScan: true });
        const statePath = path.join(path.dirname(runtime.outputDir), '.print-drive-state.json');
        await writeSourceState(statePath, runtime.sourceDir, finalFiles, envelope, manifest, { fullAudit: true });

        console.log(`Restored ${finalFiles.length} file(s) to ${runtime.sourceDir}.`);
        console.log('Encrypted manifest and blobs were not modified.');
        return { restored: finalFiles.length, vaultId: envelope.vaultId, sourceDirectory: runtime.sourceDir };
    } finally {
        unlocked.vaultKey.fill(0);
        await rm(staging, { recursive: true, force: true });
    }
}

export function verifyExactMatch(sourceFiles, remoteFiles) {
    const local = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    if (local.size !== remoteFiles.length) {
        throw new Error(`Restored file count mismatch: expected ${remoteFiles.length}, found ${local.size}.`);
    }
    for (const remote of remoteFiles) {
        const relativePath = fileRelativePath(remote);
        const file = local.get(relativePath);
        if (!file) throw new Error(`Restored file is missing: ${relativePath}`);
        if (file.size !== remote.size || file.sha256 !== remote.sha256) {
            throw new Error(`Restored file verification failed: ${relativePath}`);
        }
    }
}

async function assertTargetIsSafe(target, forceEmpty) {
    try {
        const info = await stat(target);
        if (!info.isDirectory()) throw new Error(`${target} exists but is not a directory.`);
        const files = await readSourceFiles(target, { fullScan: true });
        if (files.length > 0 && !forceEmpty) {
            throw new Error('Source directory is not empty. Move existing files elsewhere or pass --force-empty after reviewing them.');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function readPassphrase(passwordFile) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) return process.env.PRINT_DRIVE_PASSPHRASE;
    try {
        await access(passwordFile);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('No passphrase is available. Set PRINT_DRIVE_PASSWORD_FILE or PRINT_DRIVE_PASSPHRASE.');
        }
        throw error;
    }
    const value = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
    if (!value) throw new Error('The configured passphrase file is empty.');
    return value;
}

async function updateLocalConfig(loaded, sourceDirectory) {
    const value = validateConfigObject({
        ...(loaded.fromFile ? loaded.config : DEFAULT_CONFIG),
        sourceDirectory
    });
    const target = loaded.configPath || path.join(PROJECT_ROOT, 'print-drive.config.json');
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

function parseArgs(args) {
    const options = { source: null, output: null, passwordFile: null, expectedVaultId: null, forceEmpty: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--source') options.source = required(args, ++index, arg);
        else if (arg === '--out') options.output = required(args, ++index, arg);
        else if (arg === '--password-file') options.passwordFile = required(args, ++index, arg);
        else if (arg === '--expected-vault-id') options.expectedVaultId = required(args, ++index, arg);
        else if (arg === '--force-empty') options.forceEmpty = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (!options.source) throw new Error('--source <plaintext-folder> is required.');
    if (options.expectedVaultId && !/^[0-9a-f]{32}$/.test(options.expectedVaultId)) {
        throw new Error('--expected-vault-id must be 32 lowercase hex characters.');
    }
    return options;
}

function required(args, index, option) {
    if (!args[index]) throw new Error(`${option} requires a value.`);
    return args[index];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    restoreSource().catch((error) => {
        console.error(`Source restore failed: ${error.message}`);
        process.exit(1);
    });
}
