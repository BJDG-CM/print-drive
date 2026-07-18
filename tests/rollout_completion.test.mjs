import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pollPagesDeployment } from '../portable/deployment.mjs';
import { GitHubApiError, MemoryToken, validateAuthentication } from '../portable/remote_updater.mjs';
import { inspectSourceDirectory } from '../portable/source_directory.mjs';
import { renderPortableUi } from '../portable/ui.mjs';
import { parseChecksumSidecar, validateReleaseMetadata, verifyPublishedRelease } from '../scripts/verify_release_assets.mjs';
import { runGitHubIntegration } from '../scripts/integration_github.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG = { owner: 'BJDG-CM', repo: 'print-drive', branch: 'main', encryptedOutputPath: 'files' };

test('PAT authentication validates repository write access without persisting the token', async () => {
    const token = new MemoryToken();
    token.set('github_pat_test_value');
    const api = { request: async () => ({ permissions: { push: true } }) };
    assert.deepEqual(await validateAuthentication(api, CONFIG), { authenticated: true, canPush: true });
    token.clear();
    assert.equal(token.get(), null);

    const denied = { request: async () => { throw new GitHubApiError('not found', { status: 404 }); } };
    await assert.rejects(() => validateAuthentication(denied, CONFIG), (error) => error.code === 'REPOSITORY_NOT_ACCESSIBLE');
    const noWrite = { request: async () => ({ permissions: { push: false } }) };
    await assert.rejects(() => validateAuthentication(noWrite, CONFIG), (error) => error.code === 'CONTENTS_WRITE_REQUIRED');
});

test('Pages deployment is confirmed only after served metadata, manifest hash, and object reachability match', async () => {
    const manifest = Buffer.from('encrypted manifest');
    const digest = createHash('sha256').update(manifest).digest('hex');
    const responses = [
        new Response(JSON.stringify({ buildId: 'build-1', vault: { manifestSha256: digest } }), { status: 200 }),
        new Response(manifest, { status: 200 }),
        new Response(Buffer.from('ciphertext'), { status: 200 })
    ];
    const result = await pollPagesDeployment({
        pagesUrl: 'https://example.test/print-drive/', manifestSha256: digest,
        objectPath: `files/${'a'.repeat(32)}.bin`, fetchFunction: async () => responses.shift(), timeoutMs: 100
    });
    assert.equal(result.status, 'confirmed');

    let clock = 0;
    const pending = await pollPagesDeployment({
        pagesUrl: 'https://example.test/', manifestSha256: digest,
        fetchFunction: async () => new Response(JSON.stringify({ vault: { manifestSha256: '0'.repeat(64) } }), { status: 200 }),
        now: () => clock, delay: async (milliseconds) => { clock += milliseconds; }, intervalMs: 10, timeoutMs: 20
    });
    assert.equal(pending.status, 'pending');
});

test('public release verifier requires exactly two non-empty assets and matches downloaded SHA-256', async () => {
    const archive = Buffer.from('portable zip fixture');
    const digest = createHash('sha256').update(archive).digest('hex');
    const release = {
        tag_name: 'portable-v1.0.1', draft: false, prerelease: false, html_url: 'https://github.test/release',
        assets: [
            { name: 'PrintDrive-Portable-windows-x64.zip', size: archive.length, browser_download_url: 'https://downloads.test/archive' },
            { name: 'PrintDrive-Portable-windows-x64.zip.sha256', size: 100, browser_download_url: 'https://downloads.test/checksum' }
        ]
    };
    assert.equal(validateReleaseMetadata(release, 'portable-v1.0.1').size, 2);
    assert.equal(parseChecksumSidecar(`${digest}  PrintDrive-Portable-windows-x64.zip\n`), digest);
    const fetchFunction = async (url) => {
        const value = String(url);
        if (value.includes('/releases/tags/')) return new Response(JSON.stringify(release), { status: 200 });
        if (value.endsWith('/archive')) return new Response(archive, { status: 200 });
        return new Response(`${digest}  PrintDrive-Portable-windows-x64.zip\n`, { status: 200 });
    };
    const result = await verifyPublishedRelease({ fetchFunction, apiBase: 'https://api.test', tag: 'portable-v1.0.1', attempts: 1 });
    assert.equal(result.sha256, digest);
    assert.throws(() => validateReleaseMetadata({ ...release, assets: [...release.assets, { name: 'extra', size: 1, browser_download_url: 'https://x.test' }] }), /exactly/);
});

test('portable UI makes PAT, arbitrary source selection, plan metrics, and deployment states explicit', () => {
    const html = renderPortableUi('test-nonce');
    for (const value of ['Fine-grained personal access token', '다른 폴더 선택', '변경 없음', '암호화 업로드', 'Pages 배포', '배포되지 않음 — PR 병합 필요']) {
        assert(html.includes(value), `missing portable UI copy: ${value}`);
    }
    assert(!html.includes('token:document.getElementById'));
});

test('selected source inspection counts nested files and bytes without persisting a path', async () => {
    await mkdir(path.join(ROOT, '.tmp'), { recursive: true });
    const directory = await mkdtemp(path.join(ROOT, '.tmp', 'source-inspection-'));
    try {
        await mkdir(path.join(directory, 'nested'));
        await writeFile(path.join(directory, 'root.txt'), 'root');
        await writeFile(path.join(directory, 'nested', 'child.txt'), 'child');
        const result = await inspectSourceDirectory(directory);
        assert.equal(result.files, 2);
        assert.equal(result.bytes, 9);
        assert.equal(result.path, path.resolve(directory));
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
});

test('real GitHub integration test is opt-in and rejects main before network access', async () => {
    await assert.rejects(() => runGitHubIntegration({}), /opt-in/);
    await assert.rejects(() => runGitHubIntegration({
        PRINT_DRIVE_INTEGRATION_TOKEN: 'not-printed',
        PRINT_DRIVE_INTEGRATION_REPO: 'BJDG-CM/print-drive',
        PRINT_DRIVE_INTEGRATION_BRANCH: 'main',
        PRINT_DRIVE_INTEGRATION_PASSPHRASE: 'not-printed'
    }), /must not be main/);
});
