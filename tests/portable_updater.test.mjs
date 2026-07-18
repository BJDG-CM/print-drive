import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyAtomicEncryptedUpdate,
    fetchExactVaultSnapshot,
    GITHUB_BLOB_LIMIT_BYTES,
    GitHubApiError,
    MemoryToken,
    pollDeviceFlow,
    publishFallbackBranch,
    redactSensitive,
    startDeviceFlow
} from '../portable/remote_updater.mjs';
import { validateWorkspaceConfig } from '../portable/main.mjs';

const BASE = '1'.repeat(40);
const TREE = '2'.repeat(40);
const COMMIT = '3'.repeat(40);
const CONFIG = Object.freeze({ owner: 'BJDG-CM', repo: 'print-drive', branch: 'main', encryptedOutputPath: 'files' });

test('device flow keeps token in memory and redacts it from errors', async () => {
    const responses = [
        new Response(JSON.stringify({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }), { status: 200 }),
        new Response(JSON.stringify({ access_token: 'github_pat_sensitive_value' }), { status: 200 })
    ];
    const fetchFunction = async () => responses.shift();
    const state = await startDeviceFlow({ clientId: 'public-client-id', fetchFunction });
    const tokenValue = await pollDeviceFlow({ clientId: 'public-client-id', deviceCode: state.deviceCode, fetchFunction });
    const token = new MemoryToken();
    token.set(tokenValue);
    assert.equal(token.get(), tokenValue);
    assert.equal(redactSensitive(`failed ${tokenValue}`, tokenValue), 'failed [redacted]');
    token.clear();
    assert.equal(token.get(), null);
});

test('exact commit snapshot reads manifest and blobs from one base tree', async () => {
    const api = new FixtureApi();
    api.on('GET', '/repos/BJDG-CM/print-drive/git/ref/heads/main', { object: { sha: BASE } });
    api.on('GET', `/repos/BJDG-CM/print-drive/git/commits/${BASE}`, { tree: { sha: TREE } });
    api.on('GET', `/repos/BJDG-CM/print-drive/git/trees/${TREE}?recursive=1`, {
        truncated: false,
        tree: [
            { path: 'files/manifest.enc', type: 'blob', sha: 'a'.repeat(40) },
            { path: `files/${'b'.repeat(32)}.bin`, type: 'blob', sha: 'c'.repeat(40) },
            { path: 'app.js', type: 'blob', sha: 'd'.repeat(40) }
        ]
    });
    api.on('GET', `/repos/BJDG-CM/print-drive/git/blobs/${'a'.repeat(40)}`, blob('manifest'));
    api.on('GET', `/repos/BJDG-CM/print-drive/git/blobs/${'c'.repeat(40)}`, blob('ciphertext'));
    const snapshot = await fetchExactVaultSnapshot(api, CONFIG);
    assert.equal(snapshot.baseSha, BASE);
    assert.deepEqual([...snapshot.files.keys()], ['files/manifest.enc', `files/${'b'.repeat(32)}.bin`]);
    assert.equal(api.calls.some((call) => call.path.includes('app.js')), false);
});

test('atomic apply creates blobs, one tree/commit, deletes stale objects, and updates ref without force', async () => {
    const api = applyFixture();
    const update = validUpdate();
    const result = await applyAtomicEncryptedUpdate(api, CONFIG, update);
    assert.equal(result.commitSha, COMMIT);
    const treeCall = api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/trees'));
    assert.equal(treeCall.options.body.base_tree, TREE);
    assert(treeCall.options.body.tree.some((entry) => entry.path === `files/${'e'.repeat(32)}.bin` && entry.sha === null));
    assert(treeCall.options.body.tree.every((entry) => entry.path.startsWith('files/')));
    const refCall = api.calls.at(-1);
    assert.deepEqual(refCall.options.body, { sha: COMMIT, force: false });
});

test('base changes, validation errors, and interrupted uploads never update the remote ref', async () => {
    const changed = new FixtureApi();
    changed.on('GET', '/repos/BJDG-CM/print-drive/git/ref/heads/main', { object: { sha: '9'.repeat(40) } });
    await assert.rejects(() => applyAtomicEncryptedUpdate(changed, CONFIG, validUpdate()), (error) => error.code === 'BASE_SHA_CHANGED');
    assert.equal(changed.calls.some((call) => call.method !== 'GET'), false);

    const invalid = new FixtureApi();
    const outside = validUpdate();
    outside.files.set('README.md', Buffer.from('no'));
    await assert.rejects(() => applyAtomicEncryptedUpdate(invalid, CONFIG, outside), /outside encrypted output/);
    assert.equal(invalid.calls.length, 0);
    const oversized = validUpdate();
    oversized.files.set(`files/${'f'.repeat(32)}.bin`, new Uint8Array(GITHUB_BLOB_LIMIT_BYTES + 1));
    await assert.rejects(() => applyAtomicEncryptedUpdate(invalid, CONFIG, oversized), /blob-size limit/);
    assert.equal(invalid.calls.length, 0);

    const interrupted = new FixtureApi();
    interrupted.on('GET', '/repos/BJDG-CM/print-drive/git/ref/heads/main', { object: { sha: BASE } });
    interrupted.on('POST', '/repos/BJDG-CM/print-drive/git/blobs', { sha: '4'.repeat(40) });
    interrupted.on('POST', '/repos/BJDG-CM/print-drive/git/blobs', new GitHubApiError('synthetic interruption'));
    await assert.rejects(() => applyAtomicEncryptedUpdate(interrupted, CONFIG, validUpdate()), /synthetic interruption/);
    assert.equal(interrupted.calls.some((call) => call.method === 'PATCH'), false);
    assert.equal(interrupted.calls.some((call) => call.path.endsWith('/git/trees')), false);
});

test('ref conflicts abort direct apply and branch protection fallback opens a PR without deployment claim', async () => {
    const api = applyFixture({ refError: new GitHubApiError('protected', { status: 403 }) });
    const update = validUpdate();
    let pending;
    await assert.rejects(() => applyAtomicEncryptedUpdate(api, CONFIG, update), (error) => {
        pending = error.pendingCommitSha;
        return error.code === 'BRANCH_PROTECTION_BLOCKED' && pending === COMMIT;
    });
    const fallback = new FixtureApi();
    fallback.on('POST', '/repos/BJDG-CM/print-drive/git/refs', { ref: 'created' });
    fallback.on('POST', '/repos/BJDG-CM/print-drive/pulls', { html_url: 'https://github.example/pr/1' });
    const result = await publishFallbackBranch(fallback, CONFIG, update, pending);
    assert.equal(result.pullRequestUrl, 'https://github.example/pr/1');
    assert.equal(result.deployed, false);
});

test('portable configuration rejects secrets and incomplete repository scope', () => {
    const valid = validateWorkspaceConfig({
        version: 1, owner: 'BJDG-CM', repo: 'print-drive', branch: 'main', encryptedOutputPath: 'files',
        applicationId: 'print-drive', expectedVaultId: 'a'.repeat(32), pagesUrl: 'https://example.test', oauthClientId: ''
    });
    assert.equal(valid.owner, 'BJDG-CM');
    assert.throws(() => validateWorkspaceConfig({ ...valid, token: 'secret' }), /형식|secret/);
});

class FixtureApi {
    constructor() { this.routes = new Map(); this.calls = []; }
    on(method, path, value) {
        const key = `${method} ${path}`;
        this.routes.set(key, [...(this.routes.get(key) || []), value]);
    }
    async request(method, path, options = {}) {
        this.calls.push({ method, path, options });
        const key = `${method} ${path}`;
        const values = this.routes.get(key) || [];
        if (!values.length) throw new Error(`Unexpected fixture call: ${key}`);
        const value = values.shift();
        if (value instanceof Error) throw value;
        return structuredClone(value);
    }
}

function applyFixture(options = {}) {
    const api = new FixtureApi();
    api.on('GET', '/repos/BJDG-CM/print-drive/git/ref/heads/main', { object: { sha: BASE } });
    api.on('POST', '/repos/BJDG-CM/print-drive/git/blobs', { sha: '4'.repeat(40) });
    api.on('POST', '/repos/BJDG-CM/print-drive/git/blobs', { sha: '5'.repeat(40) });
    api.on('POST', '/repos/BJDG-CM/print-drive/git/trees', { sha: '6'.repeat(40) });
    api.on('POST', '/repos/BJDG-CM/print-drive/git/commits', { sha: COMMIT });
    api.on('PATCH', '/repos/BJDG-CM/print-drive/git/ref/heads/main', options.refError || { object: { sha: COMMIT } });
    return api;
}

function validUpdate() {
    return {
        baseSha: BASE,
        baseTreeSha: TREE,
        baseEncryptedPaths: new Set(['files/manifest.enc', `files/${'e'.repeat(32)}.bin`]),
        files: new Map([
            ['files/manifest.enc', Buffer.from('manifest')],
            [`files/${'d'.repeat(32)}.bin`, Buffer.from('ciphertext')]
        ])
    };
}

function blob(value) { return { encoding: 'base64', content: Buffer.from(value).toString('base64') }; }
