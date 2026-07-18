import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as encryptMain } from '../encrypt_files.mjs';
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
import { buildWorkspaceUpdate } from '../portable/workspace_update.mjs';
import { createEncryptedManifest, createObjectIndex, decryptManifestV2, parseEnvelopeText, serializeEnvelope, unlockVaultKey } from '../vault_format.mjs';

const BASE = '1'.repeat(40);
const TREE = '2'.repeat(40);
const COMMIT = '3'.repeat(40);
const CONFIG = Object.freeze({ owner: 'BJDG-CM', repo: 'print-drive', branch: 'main', encryptedOutputPath: 'files' });
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

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

test('portable workspace update preserves remote-only files and encrypts nested additions', async () => {
    const fixture = await mkdtemp(path.join(ROOT, '.tmp', 'portable-workspace-'));
    const originalSource = path.join(fixture, 'original');
    const output = path.join(fixture, 'files');
    const workspace = path.join(fixture, 'Workspace');
    const passwordFile = path.join(fixture, 'passphrase');
    const passphrase = 'portable-workspace-test-passphrase';
    await Promise.all([mkdir(originalSource), mkdir(output), mkdir(workspace)]);
    try {
        await writeFile(path.join(originalSource, 'remote-only.txt'), 'keep remote\n');
        await writeFile(passwordFile, `${passphrase}\n`);
        await encryptMain([
            '--source', originalSource, '--out', output, '--password-file', passwordFile,
            '--iterations', '200000', '--padding-bytes', '0'
        ]);
        await mkdir(path.join(workspace, '폴더'));
        await writeFile(path.join(workspace, '폴더', '추가.txt'), 'nested addition\n');
        const snapshotFiles = new Map();
        for (const name of await readdir(output)) {
            if (name === 'manifest.enc' || /^[0-9a-f]{32}\.bin$/.test(name)) {
                snapshotFiles.set(`files/${name}`, await readFile(path.join(output, name)));
            }
        }
        const previousMode = process.env.PRINT_DRIVE_PORTABLE_MODE;
        const previousRoot = process.env.PRINT_DRIVE_ROOT;
        process.env.PRINT_DRIVE_PORTABLE_MODE = '1';
        process.env.PRINT_DRIVE_ROOT = fixture;
        let update;
        try {
            update = await buildWorkspaceUpdate({
                snapshot: { baseSha: BASE, baseTreeSha: TREE, files: snapshotFiles, prefix: 'files' },
                workspaceDirectory: workspace,
                passphrase,
                mode: 'add-replace'
            });
        } finally {
            restoreEnvironment('PRINT_DRIVE_PORTABLE_MODE', previousMode);
            restoreEnvironment('PRINT_DRIVE_ROOT', previousRoot);
        }
        assert.deepEqual(update.plan.additions, ['폴더/추가.txt']);
        assert.deepEqual(update.plan.removals, []);
        const envelope = parseEnvelopeText(update.files.get('files/manifest.enc').toString('utf8'));
        const { vaultKey } = unlockVaultKey(envelope, passphrase);
        try {
            const manifest = decryptManifestV2(envelope, vaultKey);
            assert.deepEqual(manifest.files.map((file) => file.relativePath).sort(), ['remote-only.txt', '폴더/추가.txt']);
        } finally {
            vaultKey.fill(0);
        }
    } finally {
        await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
});

test('portable nested-folder update operationally migrates schema 2 to 3 and remains browser-readable', async () => {
    const fixture = await mkdtemp(path.join(ROOT, '.tmp', 'portable-schema-migration-'));
    const originalSource = path.join(fixture, 'original');
    const output = path.join(fixture, 'files');
    const workspace = path.join(fixture, 'Workspace');
    const passwordFile = path.join(fixture, 'passphrase');
    const passphrase = 'portable-schema-two-to-three-passphrase';
    await Promise.all([mkdir(originalSource), mkdir(output), mkdir(workspace)]);
    try {
        await writeFile(path.join(originalSource, 'root.txt'), 'schema 2 root remains\n');
        await writeFile(passwordFile, `${passphrase}\n`);
        await encryptMain(['--source', originalSource, '--out', output, '--password-file', passwordFile, '--iterations', '200000', '--padding-bytes', '0']);
        const currentEnvelope = parseEnvelopeText(await readFile(path.join(output, 'manifest.enc'), 'utf8'));
        const unlocked = unlockVaultKey(currentEnvelope, passphrase);
        try {
            const currentManifest = decryptManifestV2(currentEnvelope, unlocked.vaultKey);
            const legacyFiles = currentManifest.files.map(({ relativePath: _relativePath, ...file }) => file);
            const encryptedLegacy = createEncryptedManifest({ ...currentManifest, files: legacyFiles }, unlocked.vaultKey, currentEnvelope.vaultId, {
                schema: 2, id: currentManifest.id, revision: currentManifest.revision
            });
            await writeFile(path.join(output, 'manifest.enc'), serializeEnvelope({
                ...currentEnvelope,
                objectIndex: createObjectIndex(legacyFiles),
                manifest: encryptedLegacy.descriptor
            }));
        } finally {
            unlocked.vaultKey.fill(0);
        }
        await mkdir(path.join(workspace, 'first'), { recursive: true });
        await mkdir(path.join(workspace, 'second'), { recursive: true });
        await writeFile(path.join(workspace, 'first', 'same-name.txt'), 'first nested\n');
        await writeFile(path.join(workspace, 'second', 'same-name.txt'), 'second nested\n');
        const snapshotFiles = new Map();
        for (const name of await readdir(output)) {
            if (name === 'manifest.enc' || /^[0-9a-f]{32}\.bin$/.test(name)) snapshotFiles.set(`files/${name}`, await readFile(path.join(output, name)));
        }
        const previousMode = process.env.PRINT_DRIVE_PORTABLE_MODE;
        const previousRoot = process.env.PRINT_DRIVE_ROOT;
        process.env.PRINT_DRIVE_PORTABLE_MODE = '1';
        process.env.PRINT_DRIVE_ROOT = fixture;
        let update;
        try {
            update = await buildWorkspaceUpdate({
                snapshot: { baseSha: BASE, baseTreeSha: TREE, files: snapshotFiles, prefix: 'files' },
                workspaceDirectory: workspace, passphrase, mode: 'add-replace'
            });
        } finally {
            restoreEnvironment('PRINT_DRIVE_PORTABLE_MODE', previousMode);
            restoreEnvironment('PRINT_DRIVE_ROOT', previousRoot);
        }
        assert([...update.files.keys()].every((value) => value === 'files/manifest.enc' || /^files\/[0-9a-f]{32}\.bin$/.test(value)));
        const targetEnvelope = parseEnvelopeText(update.files.get('files/manifest.enc').toString('utf8'));
        assert.equal(targetEnvelope.manifest.schema, 3);
        const targetUnlocked = unlockVaultKey(targetEnvelope, passphrase);
        try {
            const targetManifest = decryptManifestV2(targetEnvelope, targetUnlocked.vaultKey);
            assert.deepEqual(targetManifest.files.map((file) => file.relativePath).sort(), ['first/same-name.txt', 'root.txt', 'second/same-name.txt']);
        } finally {
            targetUnlocked.vaultKey.fill(0);
        }
        if (!globalThis.crypto) globalThis.crypto = webcrypto;
        if (!globalThis.location) globalThis.location = new URL('https://example.test/print-drive/');
        const browserCrypto = await import('../crypto.js');
        const context = await browserCrypto.unlockVault(passphrase, targetEnvelope);
        try {
            const browserManifest = await browserCrypto.decryptManifest(targetEnvelope, context);
            assert.deepEqual(browserManifest.files.map((file) => file.relativePath).sort(), ['first/same-name.txt', 'root.txt', 'second/same-name.txt']);
        } finally {
            context.rawKeyBytes.fill(0);
        }
    } finally {
        await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
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
function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
