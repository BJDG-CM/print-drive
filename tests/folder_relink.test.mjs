import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as encryptMain, readSourceFiles } from '../encrypt_files.mjs';
import { logicalPathKey, normalizeLogicalPath } from '../logical_path.js';
import { classifyRelink, relinkSource } from '../scripts/relink_source.mjs';
import { decryptManifestV2, parseEnvelopeText, unlockVaultKey } from '../vault_format.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'recursive-relink-fixture-password';

test('recursive source discovery preserves safe logical paths and reuses blobs on moves', async () => {
    await withFixture(async (fixture) => {
        await mkdir(path.join(fixture.source, '학교', 'A'), { recursive: true });
        await mkdir(path.join(fixture.source, '학교', 'B'), { recursive: true });
        await writeFile(path.join(fixture.source, '학교', 'A', '과제.txt'), 'same basename A\n');
        await writeFile(path.join(fixture.source, '학교', 'B', '과제.txt'), 'same basename B\n');
        await runEncrypt(fixture);

        const initial = await unlockFixture(fixture);
        assert.equal(initial.envelope.manifest.schema, 3);
        assert.deepEqual(initial.manifest.files.map((file) => file.relativePath), [
            '학교/A/과제.txt',
            '학교/B/과제.txt'
        ]);
        const movedBefore = initial.manifest.files.find((file) => file.relativePath === '학교/A/과제.txt');
        initial.vaultKey.fill(0);

        await mkdir(path.join(fixture.source, '보관'), { recursive: true });
        await rename(
            path.join(fixture.source, '학교', 'A', '과제.txt'),
            path.join(fixture.source, '보관', '이동됨.txt')
        );
        const stats = await runEncrypt(fixture);
        assert.equal(stats.newBlobs, 0);
        const movedAfter = await unlockFixture(fixture);
        const moved = movedAfter.manifest.files.find((file) => file.relativePath === '보관/이동됨.txt');
        assert.equal(moved.blobId, movedBefore.blobId);
        assert.equal(moved.logicalId, movedBefore.logicalId);
        movedAfter.vaultKey.fill(0);
    });
});

test('logical paths reject traversal, slash ambiguity, device names, and normalization collisions', () => {
    for (const value of ['../secret.txt', '/absolute.txt', 'a//b.txt', 'a/./b.txt', 'a\\b.txt', 'CON.txt', 'folder/name.']) {
        assert.throws(() => normalizeLogicalPath(value), /Unsafe logical relative path/);
    }
    assert.equal(normalizeLogicalPath('e\u0301cole/문서.txt'), 'école/문서.txt');
    assert.equal(logicalPathKey('Folder/FILE.txt'), logicalPathKey('folder/file.txt'));
    assert.equal(logicalPathKey('e\u0301cole/a.txt'), logicalPathKey('école/a.txt'));
});

test('recursive discovery rejects source symlinks', async (t) => {
    await withFixture(async (fixture) => {
        await writeFile(path.join(fixture.root, 'outside.txt'), 'outside');
        try {
            await symlink(path.join(fixture.root, 'outside.txt'), path.join(fixture.source, 'linked.txt'));
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`symlink creation is unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(() => readSourceFiles(fixture.source, { fullScan: true }), /Symbolic links are not allowed/);
    });
});

test('exact relink rebuilds state and config without changing the encrypted vault', async () => {
    await withFixture(async (fixture) => {
        await mkdir(path.join(fixture.source, 'nested'), { recursive: true });
        await writeFile(path.join(fixture.source, 'nested', 'one.txt'), 'one\n');
        await runEncrypt(fixture);
        const manifestBefore = await readFile(path.join(fixture.output, 'manifest.enc'));
        await rm(path.join(fixture.root, '.print-drive-state.json'), { force: true });
        await writeFile(fixture.config, `${JSON.stringify({
            sourceDirectory: fixture.source,
            encryptedOutputDirectory: fixture.output,
            autoSync: true,
            allowedBranch: 'main',
            remote: 'origin'
        }, null, 2)}\n`);

        await withEnvironment({
            PRINT_DRIVE_CONFIG: fixture.config,
            PRINT_DRIVE_PASSPHRASE: PASSWORD,
            PRINT_DRIVE_SKIP_GIT_PREFLIGHT_FOR_TESTS: '1'
        }, () => relinkSource([
            '--source', fixture.source,
            '--out', fixture.output,
            '--password-file', fixture.password,
            '--adopt'
        ]));
        assert.deepEqual(await readFile(path.join(fixture.output, 'manifest.enc')), manifestBefore);
        const state = JSON.parse(await readFile(path.join(fixture.root, '.print-drive-state.json'), 'utf8'));
        assert.equal(state.version, 2);
        assert.equal(state.files[0].relativePath, 'nested/one.txt');
    });
});

test('relink classification separates exact, changed, local-only, remote-only, and moves', () => {
    const local = [
        source('exact.txt', 'a'), source('changed.txt', 'new'), source('local.txt', 'l'), source('new/place.txt', 'move')
    ];
    const remoteFiles = [
        remoteFile('exact.txt', 'a'), remoteFile('changed.txt', 'old'), remoteFile('remote.txt', 'r'), remoteFile('old/place.txt', 'move')
    ];
    const result = classifyRelink(local, remoteFiles);
    assert.deepEqual({
        exact: result.exact.length,
        changed: result.changed.length,
        localOnly: result.localOnly.length,
        remoteOnly: result.remoteOnly.length,
        moved: result.moved.length
    }, { exact: 1, changed: 1, localOnly: 1, remoteOnly: 1, moved: 1 });
});

async function withFixture(callback) {
    await mkdir(path.join(ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(ROOT, '.tmp', 'folder-relink-'));
    const fixture = {
        root,
        source: path.join(root, 'source'),
        output: path.join(root, 'files'),
        password: path.join(root, 'passphrase'),
        config: path.join(root, 'print-drive.config.json')
    };
    fixture.initial = true;
    await mkdir(fixture.source);
    await mkdir(fixture.output);
    await writeFile(fixture.password, `${PASSWORD}\n`);
    try { await callback(fixture); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

async function runEncrypt(fixture) {
    const args = [
        '--source', fixture.source,
        '--out', fixture.output,
        '--password-file', fixture.password
    ];
    if (fixture.initial) args.push('--iterations', '200000', '--padding-bytes', '0');
    const result = await withEnvironment({ PRINT_DRIVE_PASSPHRASE: PASSWORD }, () => encryptMain(args));
    fixture.initial = false;
    return result;
}

async function unlockFixture(fixture) {
    const envelope = parseEnvelopeText(await readFile(path.join(fixture.output, 'manifest.enc'), 'utf8'));
    const { vaultKey } = unlockVaultKey(envelope, PASSWORD);
    return { envelope, manifest: decryptManifestV2(envelope, vaultKey), vaultKey };
}

async function withEnvironment(values, callback) {
    const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { return await callback(); } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function source(relativePath, hash) { return { relativePath, name: path.posix.basename(relativePath), size: 1, sha256: hash }; }
function remoteFile(relativePath, hash) { return { relativePath, name: path.posix.basename(relativePath), size: 1, sha256: hash }; }
