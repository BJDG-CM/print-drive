#!/usr/bin/env node
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'smoke-test-password-1234';
const MANIFEST_AAD = 'print-drive:manifest:v1';

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

        const envelope = JSON.parse(await readFile(path.join(outputDir, 'manifest.enc'), 'utf8'));
        const key = pbkdf2Sync(
            PASSWORD,
            Buffer.from(envelope.crypto.kdf.salt, 'base64'),
            envelope.crypto.kdf.iterations,
            32,
            'sha256'
        );
        const manifest = JSON.parse(decryptGcm(
            key,
            Buffer.from(envelope.manifest.iv, 'base64'),
            Buffer.from(envelope.manifest.data, 'base64'),
            Buffer.from(MANIFEST_AAD, 'utf8')
        ).toString('utf8'));

        if (manifest.files.length !== 1 || manifest.files[0].name !== 'sample.txt') {
            throw new Error('Decrypted manifest did not contain the smoke-test file.');
        }

        const fileMeta = manifest.files[0];
        const encryptedFile = await readFile(path.join(tempRoot, fileMeta.path));
        const paddedPlaintext = decryptGcm(
            key,
            Buffer.from(fileMeta.iv, 'base64'),
            encryptedFile,
            Buffer.from(`print-drive:file:${fileMeta.id}:v1`, 'utf8')
        );
        const plaintext = paddedPlaintext.subarray(0, fileMeta.size);
        const hash = createHash('sha256').update(plaintext).digest('hex');
        if (hash !== fileMeta.sha256 || plaintext.toString('utf8') !== 'print-drive smoke test\n') {
            throw new Error('Decrypted file content did not pass integrity checks.');
        }

        console.log('Encryption/decryption smoke test passed.');
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
        await encryptMain(['--padding-bytes', '0']);
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

function decryptGcm(key, iv, encrypted, aad) {
    const ciphertext = encrypted.subarray(0, encrypted.byteLength - 16);
    const tag = encrypted.subarray(encrypted.byteLength - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
