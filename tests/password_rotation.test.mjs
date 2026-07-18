import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as encryptMain } from '../encrypt_files.mjs';
import { rotatePassword } from '../set_password.mjs';
import {
    WrongPasswordError,
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OLD_PASSWORD = 'old-fixture-password-2026';
const NEW_PASSWORD = 'new-fixture-password-2026';

test('password rotation changes only key slots and local password, never manifest body or blobs', async () => {
    await withVault(async (fixture) => {
        const before = await snapshot(fixture);
        await rotatePassword({
            outputDir: fixture.outputDir,
            manifestName: 'manifest.enc',
            passwordFile: fixture.passwordFile,
            iterations: 200000,
            currentPassword: OLD_PASSWORD,
            newPassword: NEW_PASSWORD
        });
        const after = await snapshot(fixture);

        assert.equal(after.envelope.keySlots.length, 1);
        assert.equal(after.envelope.manifest.data, before.envelope.manifest.data);
        assert.deepEqual(after.envelope.manifest, before.envelope.manifest);
        assert.deepEqual(after.envelope.objectIndex, before.envelope.objectIndex);
        assert.deepEqual(after.blobs, before.blobs);
        assert.equal((await readFile(fixture.passwordFile, 'utf8')).trim(), NEW_PASSWORD);
        assert.throws(() => unlockVaultKey(after.envelope, OLD_PASSWORD), WrongPasswordError);
        const { vaultKey } = unlockVaultKey(after.envelope, NEW_PASSWORD);
        assert.deepEqual(decryptManifestV2(after.envelope, vaultKey), before.manifest);
    });
});

test('encrypt_files --rotate-passphrase keeps legacy CLI intent but rotates only the VMK key slot', async () => {
    await withVault(async (fixture) => {
        const before = await snapshot(fixture);
        const previousPassword = process.env.PRINT_DRIVE_PASSPHRASE;
        process.env.PRINT_DRIVE_PASSPHRASE = OLD_PASSWORD;
        try {
            await encryptMain([
                '--out', fixture.outputDir,
                '--password-file', fixture.passwordFile,
                '--rotate-passphrase',
                '--iterations', '200000'
            ]);
        } finally {
            restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassword);
        }
        const generatedPassword = (await readFile(fixture.passwordFile, 'utf8')).trim();
        assert.notEqual(generatedPassword, OLD_PASSWORD);
        const after = await snapshotWithPassword(fixture, generatedPassword);
        assert.deepEqual(after.blobs, before.blobs);
        assert.deepEqual(after.envelope.manifest, before.envelope.manifest);
        assert.deepEqual(after.envelope.objectIndex, before.envelope.objectIndex);
    });
});

for (const failpoint of [
    'rotation-before-dual-slot',
    'rotation-after-dual-slot',
    'rotation-before-password-file',
    'rotation-after-password-file',
    'rotation-before-final-slot',
    'rotation-after-final-slot'
]) {
    test(`rotation failpoint ${failpoint} leaves the persisted password able to unlock a valid vault`, async () => {
        await withVault(async (fixture) => {
            const before = await snapshot(fixture);
            const previousFailpoint = process.env.PRINT_DRIVE_FAILPOINT;
            process.env.PRINT_DRIVE_FAILPOINT = failpoint;
            try {
                await assert.rejects(
                    rotatePassword({
                        outputDir: fixture.outputDir,
                        manifestName: 'manifest.enc',
                        passwordFile: fixture.passwordFile,
                        iterations: 200000,
                        currentPassword: OLD_PASSWORD,
                        newPassword: NEW_PASSWORD
                    }),
                    new RegExp(failpoint)
                );
            } finally {
                restoreEnv('PRINT_DRIVE_FAILPOINT', previousFailpoint);
            }

            const after = await snapshot(fixture);
            assert.equal(after.envelope.manifest.data, before.envelope.manifest.data);
            assert.deepEqual(after.blobs, before.blobs);
            const persistedPassword = (await readFile(fixture.passwordFile, 'utf8')).trim();
            const unlocked = unlockVaultKey(after.envelope, persistedPassword);
            assert.deepEqual(decryptManifestV2(after.envelope, unlocked.vaultKey), before.manifest);
            assert.equal(
                canUnlock(after.envelope, OLD_PASSWORD) || canUnlock(after.envelope, NEW_PASSWORD),
                true
            );
        });
    });
}

async function withVault(callback) {
    await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'rotation-'));
    const fixture = {
        root,
        sourceDir: path.join(root, 'private_files'),
        outputDir: path.join(root, 'files'),
        passwordFile: path.join(root, 'fixture-passphrase')
    };
    await mkdir(fixture.sourceDir, { recursive: true });
    await mkdir(fixture.outputDir, { recursive: true });
    await writeFile(path.join(fixture.outputDir, '.gitkeep'), '');
    await writeFile(path.join(fixture.sourceDir, 'alpha.txt'), 'alpha fixture\n', 'utf8');
    await writeFile(path.join(fixture.sourceDir, 'beta.txt'), 'beta fixture\n', 'utf8');
    await writeFile(fixture.passwordFile, `${OLD_PASSWORD}\n`, 'utf8');
    const previousPassphrase = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_PASSPHRASE = OLD_PASSWORD;
    try {
        await encryptMain([
            '--source', fixture.sourceDir,
            '--out', fixture.outputDir,
            '--password-file', fixture.passwordFile,
            '--iterations', '200000',
            '--padding-bytes', '0'
        ]);
        restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassphrase);
        await callback(fixture);
    } finally {
        restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassphrase);
        delete process.env.PRINT_DRIVE_FAILPOINT;
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function snapshot(fixture) {
    const envelope = parseEnvelopeText(await readFile(path.join(fixture.outputDir, 'manifest.enc'), 'utf8'));
    validateEnvelopeV2(envelope);
    const password = canUnlock(envelope, NEW_PASSWORD) ? NEW_PASSWORD : OLD_PASSWORD;
    const { vaultKey } = unlockVaultKey(envelope, password);
    const manifest = decryptManifestV2(envelope, vaultKey);
    const blobs = new Map();
    for (const name of (await readdir(fixture.outputDir)).filter((name) => /^[0-9a-f]{32}\.bin$/.test(name)).sort()) {
        blobs.set(name, createHash('sha256').update(await readFile(path.join(fixture.outputDir, name))).digest('hex'));
    }
    return { envelope, manifest, blobs };
}

async function snapshotWithPassword(fixture, password) {
    const envelope = parseEnvelopeText(await readFile(path.join(fixture.outputDir, 'manifest.enc'), 'utf8'));
    validateEnvelopeV2(envelope);
    const { vaultKey } = unlockVaultKey(envelope, password);
    const manifest = decryptManifestV2(envelope, vaultKey);
    const blobs = new Map();
    for (const name of (await readdir(fixture.outputDir)).filter((name) => /^[0-9a-f]{32}\.bin$/.test(name)).sort()) {
        blobs.set(name, createHash('sha256').update(await readFile(path.join(fixture.outputDir, name))).digest('hex'));
    }
    return { envelope, manifest, blobs };
}

function canUnlock(envelope, password) {
    try {
        unlockVaultKey(envelope, password);
        return true;
    } catch {
        return false;
    }
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
