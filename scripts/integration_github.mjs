#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHubApi, GitHubApiError, applyAtomicEncryptedUpdate, fetchExactVaultSnapshot, validateAuthentication } from '../portable/remote_updater.mjs';
import { buildWorkspaceUpdate } from '../portable/workspace_update.mjs';
import { decryptFileV2, decryptManifestV2, parseEnvelopeText, unlockVaultKey } from '../vault_format.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function runGitHubIntegration(environment = process.env) {
    const token = required(environment.PRINT_DRIVE_INTEGRATION_TOKEN, 'PRINT_DRIVE_INTEGRATION_TOKEN');
    const repository = required(environment.PRINT_DRIVE_INTEGRATION_REPO, 'PRINT_DRIVE_INTEGRATION_REPO');
    const branch = required(environment.PRINT_DRIVE_INTEGRATION_BRANCH, 'PRINT_DRIVE_INTEGRATION_BRANCH');
    const passphrase = required(environment.PRINT_DRIVE_INTEGRATION_PASSPHRASE, 'PRINT_DRIVE_INTEGRATION_PASSPHRASE');
    if (!/^print-drive-integration\/[A-Za-z0-9._-]+$/.test(branch) || branch === 'main') {
        throw new Error('Integration branch must use print-drive-integration/<name> and must not be main.');
    }
    const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) throw new Error('PRINT_DRIVE_INTEGRATION_REPO must be owner/repo.');
    const [, owner, repo] = match;
    const api = new GitHubApi({ token });
    const baseConfig = { owner, repo, branch: 'main', encryptedOutputPath: 'files' };
    const testConfig = { ...baseConfig, branch };
    await validateAuthentication(api, baseConfig);
    const repositoryInfo = await api.request('GET', `/repos/${owner}/${repo}`);
    if (repositoryInfo.default_branch !== 'main') throw new Error(`Integration requires default branch main; found ${repositoryInfo.default_branch}.`);
    try {
        await api.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        throw new Error(`Refusing to reuse existing integration branch: ${branch}.`);
    } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
    const mainRef = await api.request('GET', `/repos/${owner}/${repo}/git/ref/heads/main`);
    await api.request('POST', `/repos/${owner}/${repo}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: mainRef.object.sha } });
    let cleanupError = null;
    await mkdir(path.join(ROOT, '.tmp'), { recursive: true });
    const temporary = await mkdtemp(path.join(ROOT, '.tmp', 'github-integration-'));
    const workspace = path.join(temporary, 'source');
    const unique = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const relativePath = `integration/${unique}/same-name.txt`;
    const plaintext = Buffer.from(`Print Drive integration ${unique}\n`, 'utf8');
    try {
        await mkdir(path.dirname(path.join(workspace, ...relativePath.split('/'))), { recursive: true });
        await writeFile(path.join(workspace, ...relativePath.split('/')), plaintext);
        const snapshot = await fetchExactVaultSnapshot(api, testConfig);
        const previousRoot = process.env.PRINT_DRIVE_ROOT;
        const previousPortable = process.env.PRINT_DRIVE_PORTABLE_MODE;
        process.env.PRINT_DRIVE_ROOT = temporary;
        process.env.PRINT_DRIVE_PORTABLE_MODE = '1';
        let update;
        try {
            update = await buildWorkspaceUpdate({ snapshot, workspaceDirectory: workspace, passphrase, mode: 'add-replace' });
        } finally {
            restoreEnvironment('PRINT_DRIVE_ROOT', previousRoot);
            restoreEnvironment('PRINT_DRIVE_PORTABLE_MODE', previousPortable);
        }
        const applied = await applyAtomicEncryptedUpdate(api, testConfig, update);
        const confirmed = await fetchExactVaultSnapshot(api, testConfig);
        if (confirmed.baseSha !== applied.commitSha) throw new Error('Integration ref did not advance to the applied commit.');
        const envelope = parseEnvelopeText(confirmed.files.get('files/manifest.enc').toString('utf8'));
        if (envelope.manifest.schema !== 3) throw new Error(`Expected schema 3 after nested update; found ${envelope.manifest.schema}.`);
        const unlocked = unlockVaultKey(envelope, passphrase);
        try {
            const manifest = decryptManifestV2(envelope, unlocked.vaultKey);
            const file = manifest.files.find((entry) => entry.relativePath === relativePath);
            if (!file) throw new Error('Nested integration file is missing from the remote manifest.');
            const decrypted = decryptFileV2(file, confirmed.files.get(`files/${file.blobId}.bin`), unlocked.vaultKey, envelope.vaultId);
            try {
                if (!decrypted.equals(plaintext)) throw new Error('Remote integration plaintext verification failed.');
            } finally {
                decrypted.fill(0);
            }
        } finally {
            unlocked.vaultKey.fill(0);
        }
        return { branch, commitSha: applied.commitSha, relativePath, schema: 3, verified: true };
    } finally {
        try {
            await api.request('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
        } catch (error) {
            cleanupError = error;
        }
        await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (cleanupError) console.error(`Integration cleanup failed. Delete branch manually: ${branch}. ${cleanupError.message}`);
    }
}

function required(value, name) {
    if (!value) throw new Error(`${name} is required; this destructive integration test is opt-in and never runs in normal CI.`);
    return value;
}

function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runGitHubIntegration()
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => { console.error(error.message); process.exit(1); });
}
