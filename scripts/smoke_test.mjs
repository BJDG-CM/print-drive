#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    decryptFileV2,
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'smoke-test-password-1234';

async function main() {
    const tempBase = path.join(ROOT, '.tmp');
    await mkdir(tempBase, { recursive: true });
    const tempRoot = await mkdtemp(path.join(tempBase, 'print-drive-smoke-'));
    const sourceDir = path.join(tempRoot, 'private_files');
    const outputDir = path.join(tempRoot, 'files');

    try {
        await mkdir(sourceDir, { recursive: true });
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, '.gitkeep'), '');
        await writeFile(path.join(sourceDir, 'sample.txt'), 'print-drive smoke test\n', 'utf8');

        await runEncryptWithExternalProjectRoot(tempRoot);

        const outputNames = await readdir(outputDir);
        const encryptedNames = outputNames.filter((name) => /^[0-9a-f]{32}\.bin$/.test(name));
        if (!outputNames.includes('manifest.enc') || encryptedNames.length !== 1) {
            throw new Error(`Unexpected encrypted output: ${outputNames.join(', ')}`);
        }

        const envelope = parseEnvelopeText(await readFile(path.join(outputDir, 'manifest.enc'), 'utf8'));
        validateEnvelopeV2(envelope);
        const { vaultKey } = unlockVaultKey(envelope, PASSWORD);
        const manifest = decryptManifestV2(envelope, vaultKey);
        if (manifest.files.length !== 1 || manifest.files[0].name !== 'sample.txt') {
            throw new Error('Decrypted manifest did not contain the smoke-test file.');
        }

        const file = manifest.files[0];
        const encrypted = await readFile(path.join(outputDir, `${file.blobId}.bin`));
        const plaintext = decryptFileV2(file, encrypted, vaultKey, envelope.vaultId);
        if (plaintext.toString('utf8') !== 'print-drive smoke test\n') {
            throw new Error('Decrypted file content did not pass integrity checks.');
        }

        console.log('v2 encryption/decryption smoke test passed.');
    } finally {
        await removeTempRoot(tempRoot);
    }
}

async function runEncryptWithExternalProjectRoot(tempRoot) {
    const previousRoot = process.env.PRINT_DRIVE_ROOT;
    const previousPassphrase = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_ROOT = tempRoot;
    process.env.PRINT_DRIVE_PASSPHRASE = PASSWORD;

    try {
        const moduleUrl = new URL(`../encrypt_files.mjs?smoke=${Date.now()}`, import.meta.url);
        const { main: encryptMain } = await import(moduleUrl.href);
        await encryptMain(['--iterations', '200000', '--padding-bytes', '0']);
    } finally {
        restoreEnv('PRINT_DRIVE_ROOT', previousRoot);
        restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassphrase);
    }
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

async function removeTempRoot(tempRoot) {
    try {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
        // Windows/OneDrive can briefly lock files. .tmp/ is ignored, so cleanup is best effort.
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
