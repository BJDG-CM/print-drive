import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashStableSourceFile, main as encryptMain } from '../encrypt_files.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'state-cache-fixture-password-2026';

test('source state cache hashes only candidates and supports explicit audits', async () => {
    await withFixture(async (fixture) => {
        for (let index = 0; index < 100; index++) {
            await writeFile(path.join(fixture.sourceDir, `file-${String(index).padStart(3, '0')}.txt`), `value-${index}\n`);
        }
        const initial = await runEncrypt(fixture, ['--iterations', '200000', '--padding-bytes', '0']);
        assert.equal(initial.sourceFilesHashed, 100);

        const noOp = await runEncrypt(fixture);
        assert.deepEqual(metricSubset(noOp), {
            sourceFilesHashed: 0,
            sourceBytesRead: 0,
            blobDecryptions: 0,
            newBlobs: 0,
            unchangedBlobs: 100,
            manifestChanged: false
        });

        await writeFile(path.join(fixture.sourceDir, 'file-042.txt'), 'changed\n');
        const modified = await runEncrypt(fixture);
        assert.equal(modified.sourceFilesHashed, 1);
        assert.equal(modified.newBlobs, 1);
        assert.equal(modified.unchangedBlobs, 99);

        await writeFile(path.join(fixture.sourceDir, 'added.txt'), 'added\n');
        const added = await runEncrypt(fixture);
        assert.equal(added.sourceFilesHashed, 1);
        assert.equal(added.newBlobs, 1);

        await unlink(path.join(fixture.sourceDir, 'file-000.txt'));
        const deleted = await runEncrypt(fixture);
        assert.equal(deleted.sourceFilesHashed, 0);
        assert.equal(deleted.newBlobs, 0);

        await rename(path.join(fixture.sourceDir, 'file-001.txt'), path.join(fixture.sourceDir, 'renamed-001.txt'));
        const renamed = await runEncrypt(fixture);
        assert.equal(renamed.sourceFilesHashed, 1);
        assert.equal(renamed.newBlobs, 0);

        const fullScan = await runEncrypt(fixture, ['--full-scan']);
        assert.equal(fullScan.sourceFilesHashed, 100);
        assert.equal(fullScan.blobDecryptions, 0);
        const verifyAll = await runEncrypt(fixture, ['--verify-all']);
        assert.equal(verifyAll.sourceFilesHashed, 0);
        assert.equal(verifyAll.blobDecryptions, 100);

        await writeFile(fixture.statePath, '{bad json');
        const corrupt = await runEncrypt(fixture);
        assert.equal(corrupt.sourceFilesHashed, 100);

        const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
        state.revision += 1;
        await writeFile(fixture.statePath, `${JSON.stringify(state)}\n`);
        const mismatched = await runEncrypt(fixture);
        assert.equal(mismatched.sourceFilesHashed, 100);
    });
});

test('state replacement failure preserves the old state and causes a safe scan next run', async () => {
    await withFixture(async (fixture) => {
        await writeFile(path.join(fixture.sourceDir, 'one.txt'), 'one\n');
        await writeFile(path.join(fixture.sourceDir, 'two.txt'), 'two\n');
        await runEncrypt(fixture, ['--iterations', '200000', '--padding-bytes', '0']);
        const previousState = await readFile(fixture.statePath);

        await writeFile(path.join(fixture.sourceDir, 'one.txt'), 'one changed\n');
        process.env.PRINT_DRIVE_FAILPOINT = 'before-state-commit';
        await assert.rejects(runEncrypt(fixture), /before-state-commit/);
        delete process.env.PRINT_DRIVE_FAILPOINT;
        assert.deepEqual(await readFile(fixture.statePath), previousState);

        const recovered = await runEncrypt(fixture);
        assert.equal(recovered.sourceFilesHashed, 2);
        assert.equal(recovered.manifestChanged, false);
    });
});

test('source mutation during hashing is rejected', async () => {
    await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'hash-mutation-'));
    const sourcePath = path.join(root, 'changing.bin');
    try {
        await writeFile(sourcePath, Buffer.alloc(64 * 1024 * 1024, 0x41));
        const before = await stat(sourcePath, { bigint: true });
        const hashing = hashStableSourceFile(sourcePath, before, 'changing.bin');
        await new Promise((resolve) => setTimeout(resolve, 5));
        const handle = await open(sourcePath, 'r+');
        try {
            await handle.write(Buffer.from([0x42]), 0, 1, 0);
        } finally {
            await handle.close();
        }
        await assert.rejects(hashing, /changed while it was being hashed/);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
});

async function withFixture(callback) {
    await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'state-cache-'));
    const fixture = {
        root,
        sourceDir: path.join(root, 'source'),
        outputDir: path.join(root, 'files'),
        passwordFile: path.join(root, 'passphrase'),
        statePath: path.join(root, '.print-drive-state.json')
    };
    await mkdir(fixture.sourceDir);
    await mkdir(fixture.outputDir);
    try {
        await callback(fixture);
    } finally {
        delete process.env.PRINT_DRIVE_FAILPOINT;
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function runEncrypt(fixture, extra = []) {
    const previous = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_PASSPHRASE = PASSWORD;
    try {
        return await encryptMain([
            '--source', fixture.sourceDir,
            '--out', fixture.outputDir,
            '--password-file', fixture.passwordFile,
            ...extra
        ]);
    } finally {
        if (previous === undefined) delete process.env.PRINT_DRIVE_PASSPHRASE;
        else process.env.PRINT_DRIVE_PASSPHRASE = previous;
    }
}

function metricSubset(stats) {
    return {
        sourceFilesHashed: stats.sourceFilesHashed,
        sourceBytesRead: stats.sourceBytesRead,
        blobDecryptions: stats.blobDecryptions,
        newBlobs: stats.newBlobs,
        unchangedBlobs: stats.unchangedBlobs,
        manifestChanged: stats.manifestChanged
    };
}
