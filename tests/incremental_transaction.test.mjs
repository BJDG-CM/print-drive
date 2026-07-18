import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as encryptMain } from '../encrypt_files.mjs';
import {
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'incremental-fixture-password-2026';

test('100-file no-op, modify, add, delete, and unambiguous rename reuse immutable blobs', async () => {
    await withFixture('incremental-', async (fixture) => {
        for (let index = 0; index < 100; index += 1) {
            await writeFile(
                path.join(fixture.sourceDir, `file-${String(index).padStart(3, '0')}.txt`),
                `synthetic-${index}\n`,
                'utf8'
            );
        }

        await runEncrypt(fixture, { initial: true });
        const initial = await snapshot(fixture);
        assert.equal(initial.manifest.files.length, 100);
        assert.equal(initial.blobs.size, 100);

        await runEncrypt(fixture);
        const noOp = await snapshot(fixture);
        assert.deepEqual(noOp.manifestBytes, initial.manifestBytes);
        assert.deepEqual(noOp.blobs, initial.blobs);

        await writeFile(path.join(fixture.sourceDir, 'file-042.txt'), 'synthetic-42-modified\n', 'utf8');
        await runEncrypt(fixture);
        const modified = await snapshot(fixture);
        assert.equal(modified.manifest.revision, 2);
        assert.equal(intersectionSize(initial.blobs, modified.blobs), 99);
        assert.equal(modified.blobs.size, 100);
        const old42 = initial.manifest.files.find((file) => file.name === 'file-042.txt');
        const new42 = modified.manifest.files.find((file) => file.name === 'file-042.txt');
        assert.equal(new42.logicalId, old42.logicalId);
        assert.notEqual(new42.blobId, old42.blobId);

        await writeFile(path.join(fixture.sourceDir, 'added.txt'), 'added synthetic file\n', 'utf8');
        await runEncrypt(fixture);
        const added = await snapshot(fixture);
        assert.equal(added.blobs.size, 101);
        assert.equal(intersectionSize(modified.blobs, added.blobs), 100);

        await rm(path.join(fixture.sourceDir, 'file-000.txt'));
        await runEncrypt(fixture);
        const deleted = await snapshot(fixture);
        assert.equal(deleted.blobs.size, 100);
        assert.equal(deleted.manifest.files.some((file) => file.name === 'file-000.txt'), false);

        const beforeRename = deleted.manifest.files.find((file) => file.name === 'file-001.txt');
        await rename(
            path.join(fixture.sourceDir, 'file-001.txt'),
            path.join(fixture.sourceDir, 'renamed-001.txt')
        );
        await runEncrypt(fixture);
        const renamed = await snapshot(fixture);
        const afterRename = renamed.manifest.files.find((file) => file.name === 'renamed-001.txt');
        assert.equal(afterRename.logicalId, beforeRename.logicalId);
        assert.equal(afterRename.blobId, beforeRename.blobId);
        assert.equal(afterRename.ciphertextSha256, beforeRename.ciphertextSha256);
        assert.deepEqual(renamed.blobs, deleted.blobs);
    });
});

test('pre-commit failure rolls back new blobs; post-commit failure leaves a valid recoverable manifest', async () => {
    await withFixture('transaction-', async (fixture) => {
        await writeFile(path.join(fixture.sourceDir, 'one.txt'), 'one\n', 'utf8');
        await writeFile(path.join(fixture.sourceDir, 'two.txt'), 'two\n', 'utf8');
        await runEncrypt(fixture, { initial: true });
        const baseline = await snapshot(fixture);

        await writeFile(path.join(fixture.sourceDir, 'one.txt'), 'one changed\n', 'utf8');
        await assert.rejects(
            runEncrypt(fixture, { failpoint: 'before-manifest-commit' }),
            /before-manifest-commit/
        );
        const rolledBack = await snapshot(fixture);
        assert.deepEqual(rolledBack.manifestBytes, baseline.manifestBytes);
        assert.deepEqual(rolledBack.blobs, baseline.blobs);

        await writeFile(path.join(fixture.sourceDir, 'one.txt'), 'one changed again\n', 'utf8');
        await assert.rejects(
            runEncrypt(fixture, { failpoint: 'after-manifest-commit' }),
            /after-manifest-commit/
        );
        const committed = await snapshot(fixture, { allowStale: true });
        assert.equal(committed.manifest.revision, baseline.manifest.revision + 1);
        for (const object of committed.envelope.objectIndex.objects) {
            assert.equal(committed.blobs.has(`${object.blobId}.bin`), true);
        }
        assert.ok(committed.blobs.size > committed.envelope.objectIndex.objects.length);

        await runEncrypt(fixture);
        const recovered = await snapshot(fixture);
        assert.equal(recovered.blobs.size, recovered.envelope.objectIndex.objects.length);
        assert.equal(recovered.manifest.revision, committed.manifest.revision);
    });
});

async function withFixture(prefix, callback) {
    await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(REPO_ROOT, '.tmp', prefix));
    const fixture = {
        root,
        sourceDir: path.join(root, 'private_files'),
        outputDir: path.join(root, 'files'),
        passwordFile: path.join(root, 'fixture-passphrase')
    };
    await mkdir(fixture.sourceDir, { recursive: true });
    await mkdir(fixture.outputDir, { recursive: true });
    await writeFile(path.join(fixture.outputDir, '.gitkeep'), '');
    try {
        await callback(fixture);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function runEncrypt(fixture, options = {}) {
    const previousPassphrase = process.env.PRINT_DRIVE_PASSPHRASE;
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
        '--password-file', fixture.passwordFile
    ];
    if (options.initial) {
        args.push('--iterations', '200000', '--padding-bytes', '0');
    }
    try {
        await encryptMain(args);
    } finally {
        restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassphrase);
        restoreEnv('PRINT_DRIVE_FAILPOINT', previousFailpoint);
    }
}

async function snapshot(fixture, options = {}) {
    const manifestBytes = await readFile(path.join(fixture.outputDir, 'manifest.enc'));
    const envelope = parseEnvelopeText(manifestBytes.toString('utf8'));
    validateEnvelopeV2(envelope);
    const { vaultKey } = unlockVaultKey(envelope, PASSWORD);
    const manifest = decryptManifestV2(envelope, vaultKey);
    const blobs = new Map();
    for (const name of (await readdir(fixture.outputDir)).filter((name) => /^[0-9a-f]{32}\.bin$/.test(name)).sort()) {
        blobs.set(name, sha256(await readFile(path.join(fixture.outputDir, name))));
    }
    if (!options.allowStale) {
        assert.deepEqual(
            [...blobs.keys()],
            envelope.objectIndex.objects.map((object) => `${object.blobId}.bin`).sort()
        );
    }
    return { manifestBytes, envelope, manifest, blobs };
}

function intersectionSize(left, right) {
    let count = 0;
    for (const [name, digest] of left) {
        if (right.get(name) === digest) {
            count += 1;
        }
    }
    return count;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
