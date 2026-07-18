import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as encryptMain } from '../encrypt_files.mjs';
import {
    V1_MANIFEST_AAD,
    decryptFileV2,
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'v1-migration-fixture-password-2026';
const CREATED_AT = '2026-07-18T00:00:00.000Z';

test('v1 requires an explicit migration flag and migrates every verified plaintext transactionally', async () => {
    await withV1Fixture(async (fixture) => {
        const originalManifest = await readFile(path.join(fixture.outputDir, 'manifest.enc'));
        const originalBlobs = await blobSnapshot(fixture.outputDir);

        await assert.rejects(runMigration(fixture, { explicit: false }), /--migrate-v1/);
        assert.deepEqual(await readFile(path.join(fixture.outputDir, 'manifest.enc')), originalManifest);
        assert.deepEqual(await blobSnapshot(fixture.outputDir), originalBlobs);

        await runMigration(fixture, { explicit: true });
        const envelope = parseEnvelopeText(await readFile(path.join(fixture.outputDir, 'manifest.enc'), 'utf8'));
        validateEnvelopeV2(envelope);
        const { vaultKey } = unlockVaultKey(envelope, PASSWORD);
        const manifest = decryptManifestV2(envelope, vaultKey);
        assert.equal(manifest.files.length, fixture.plaintexts.size);
        assert.equal(manifest.revision, 1);
        for (const file of manifest.files) {
            const encrypted = await readFile(path.join(fixture.outputDir, `${file.blobId}.bin`));
            assert.deepEqual(
                decryptFileV2(file, encrypted, vaultKey, envelope.vaultId),
                fixture.plaintexts.get(file.name)
            );
        }
        const migratedNames = new Set(envelope.objectIndex.objects.map((object) => `${object.blobId}.bin`));
        assert.deepEqual(new Set((await blobSnapshot(fixture.outputDir)).keys()), migratedNames);
        for (const oldName of originalBlobs.keys()) {
            assert.equal(migratedNames.has(oldName), false);
        }
    });
});

test('v1 migration failure before manifest commit preserves the complete v1 generation', async () => {
    await withV1Fixture(async (fixture) => {
        const originalManifest = await readFile(path.join(fixture.outputDir, 'manifest.enc'));
        const originalBlobs = await blobSnapshot(fixture.outputDir);
        await assert.rejects(
            runMigration(fixture, { explicit: true, failpoint: 'before-manifest-commit' }),
            /before-manifest-commit/
        );
        assert.deepEqual(await readFile(path.join(fixture.outputDir, 'manifest.enc')), originalManifest);
        assert.deepEqual(await blobSnapshot(fixture.outputDir), originalBlobs);

        await runMigration(fixture, { explicit: true });
        const envelope = parseEnvelopeText(await readFile(path.join(fixture.outputDir, 'manifest.enc'), 'utf8'));
        assert.equal(envelope.version, 2);
    });
});

async function withV1Fixture(callback) {
    await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'migration-v1-'));
    const fixture = {
        root,
        sourceDir: path.join(root, 'private_files'),
        outputDir: path.join(root, 'files'),
        passwordFile: path.join(root, 'fixture-passphrase'),
        plaintexts: new Map([
            ['alpha.txt', Buffer.from('alpha v1 fixture\n', 'utf8')],
            ['한글.txt', Buffer.from('한글 v1 fixture\n', 'utf8')]
        ])
    };
    await mkdir(fixture.sourceDir, { recursive: true });
    await mkdir(fixture.outputDir, { recursive: true });
    await writeFile(path.join(fixture.outputDir, '.gitkeep'), '');
    await writeFile(fixture.passwordFile, `${PASSWORD}\n`, 'utf8');
    await createV1Vault(fixture);
    try {
        await callback(fixture);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function createV1Vault(fixture) {
    const salt = randomBytes(32);
    const key = pbkdf2Sync(PASSWORD, salt, 200000, 32, 'sha256');
    const files = [];
    for (const [name, plaintext] of fixture.plaintexts) {
        const id = randomBytes(16).toString('hex');
        const iv = randomBytes(12);
        const encrypted = encryptGcm(
            key,
            iv,
            plaintext,
            Buffer.from(`print-drive:file:${id}:v1`, 'utf8')
        );
        await writeFile(path.join(fixture.outputDir, `${id}.bin`), encrypted);
        files.push({
            id,
            name,
            size: plaintext.byteLength,
            encryptedSize: encrypted.byteLength,
            extension: 'txt',
            type: 'text',
            mime: 'text/plain',
            path: `files/${id}.bin`,
            modifiedAt: CREATED_AT,
            iv: iv.toString('base64'),
            sha256: createHash('sha256').update(plaintext).digest('hex')
        });
    }
    const manifest = {
        version: 1,
        createdAt: CREATED_AT,
        files
    };
    const manifestIv = randomBytes(12);
    const manifestData = encryptGcm(
        key,
        manifestIv,
        Buffer.from(JSON.stringify(manifest), 'utf8'),
        Buffer.from(V1_MANIFEST_AAD, 'utf8')
    );
    const envelope = {
        version: 1,
        app: 'print-drive',
        crypto: {
            kdf: {
                name: 'PBKDF2',
                hash: 'SHA-256',
                iterations: 200000,
                salt: salt.toString('base64')
            },
            cipher: {
                name: 'AES-GCM',
                keyLength: 256,
                ivLength: 12,
                tagLength: 128
            },
            padding: { blockSize: 0 }
        },
        manifest: {
            iv: manifestIv.toString('base64'),
            data: manifestData.toString('base64')
        }
    };
    await writeFile(
        path.join(fixture.outputDir, 'manifest.enc'),
        `${JSON.stringify(envelope, null, 2)}\n`,
        'utf8'
    );
}

async function runMigration(fixture, options) {
    const previousPassword = process.env.PRINT_DRIVE_PASSPHRASE;
    const previousFailpoint = process.env.PRINT_DRIVE_FAILPOINT;
    process.env.PRINT_DRIVE_PASSPHRASE = PASSWORD;
    if (options.failpoint) {
        process.env.PRINT_DRIVE_FAILPOINT = options.failpoint;
    } else {
        delete process.env.PRINT_DRIVE_FAILPOINT;
    }
    const args = [
        '--source', fixture.sourceDir,
        '--out', fixture.outputDir,
        '--password-file', fixture.passwordFile,
        '--iterations', '200000',
        '--padding-bytes', '0'
    ];
    if (options.explicit) {
        args.push('--migrate-v1');
    }
    try {
        await encryptMain(args);
    } finally {
        restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassword);
        restoreEnv('PRINT_DRIVE_FAILPOINT', previousFailpoint);
    }
}

async function blobSnapshot(outputDir) {
    const result = new Map();
    for (const name of (await readdir(outputDir)).filter((name) => /^[0-9a-f]{32}\.bin$/.test(name)).sort()) {
        result.set(name, createHash('sha256').update(await readFile(path.join(outputDir, name))).digest('hex'));
    }
    return result;
}

function encryptGcm(key, iv, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
