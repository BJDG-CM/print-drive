import { randomBytes } from 'node:crypto';

export const GITHUB_BLOB_LIMIT_BYTES = 100 * 1024 * 1024;

export class GitHubApiError extends Error {
    constructor(message, options = {}) {
        super(redactSensitive(message, options.token), { cause: options.cause });
        this.name = 'GitHubApiError';
        this.code = options.code || 'GITHUB_API_FAILED';
        this.status = options.status || null;
        this.response = options.response || null;
        this.responseHeaders = Object.freeze(options.responseHeaders || {});
    }
}

export class MemoryToken {
    #value = null;
    set(value) {
        if (typeof value !== 'string' || !value) throw new Error('GitHub token is required.');
        this.clear();
        this.#value = value;
    }
    get() { return this.#value; }
    clear() { this.#value = null; }
}

export class GitHubApi {
    constructor(options = {}) {
        this.fetch = options.fetch || globalThis.fetch;
        this.token = options.token || null;
        this.apiBase = options.apiBase || 'https://api.github.com';
        if (typeof this.fetch !== 'function') throw new Error('fetch is required.');
    }

    async request(method, pathname, options = {}) {
        const token = options.token || this.token;
        const response = await this.fetch(new URL(pathname, this.apiBase), {
            method,
            headers: {
                Accept: options.accept || 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(options.headers || {})
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: options.signal
        });
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: 'non-JSON GitHub response' }; }
        if (!response.ok) {
            throw new GitHubApiError(`GitHub API ${method} ${pathname} failed (${response.status}): ${payload?.message || 'unknown error'}`, {
                status: response.status,
                response: payload,
                responseHeaders: safeResponseHeaders(response.headers),
                token,
                code: response.status === 409 || response.status === 422 ? 'GITHUB_CONFLICT' : 'GITHUB_API_FAILED'
            });
        }
        return payload;
    }
}

export async function validateAuthentication(api, config) {
    validateRepositoryConfig(config);
    try {
        const repository = await api.request('GET', repoPath(config, ''));
        if (repository?.permissions && repository.permissions.push === false) {
            throw new GitHubApiError('Token can read the repository but cannot write Contents.', {
                status: 403,
                code: 'CONTENTS_WRITE_REQUIRED'
            });
        }
        return { authenticated: true, canPush: repository?.permissions?.push !== false };
    } catch (error) {
        if (!(error instanceof GitHubApiError)) throw error;
        const message = String(error.response?.message || error.message || '');
        const sso = error.responseHeaders['x-github-sso'];
        const remaining = error.responseHeaders['x-ratelimit-remaining'];
        if (error.status === 401) error.code = 'INVALID_TOKEN';
        else if (error.status === 404) error.code = 'REPOSITORY_NOT_ACCESSIBLE';
        else if (error.status === 403 && sso) error.code = 'SSO_AUTHORIZATION_REQUIRED';
        else if ((error.status === 403 || error.status === 429) && remaining === '0') error.code = 'GITHUB_RATE_LIMITED';
        else if (error.status === 403 && /resource not accessible|permission|write access|forbidden/i.test(message)) error.code = 'CONTENTS_WRITE_REQUIRED';
        throw error;
    }
}

export async function startDeviceFlow({ clientId, fetchFunction = globalThis.fetch, scope = '' }) {
    if (!/^[A-Za-z0-9_-]+$/.test(clientId || '')) throw new Error('A public GitHub OAuth/GitHub App client ID is required.');
    const body = new URLSearchParams({ client_id: clientId });
    if (scope) body.set('scope', scope);
    const response = await fetchFunction('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const value = await response.json();
    if (!response.ok || !value.device_code || !value.user_code || !value.verification_uri) {
        throw new GitHubApiError(`GitHub device flow could not start (${response.status}).`, { status: response.status });
    }
    return {
        deviceCode: value.device_code,
        userCode: value.user_code,
        verificationUri: value.verification_uri,
        expiresIn: value.expires_in,
        interval: Math.max(5, value.interval || 5)
    };
}

export async function pollDeviceFlow({ clientId, deviceCode, fetchFunction = globalThis.fetch, signal, interval = 5 }) {
    let waitSeconds = Math.max(5, interval);
    while (!signal?.aborted) {
        const response = await fetchFunction('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            }),
            signal
        });
        const value = await response.json();
        if (value.access_token) return value.access_token;
        if (value.error === 'slow_down') waitSeconds += 5;
        else if (value.error !== 'authorization_pending') {
            throw new GitHubApiError(`GitHub device authorization failed: ${value.error || response.status}.`, { status: response.status });
        }
        await abortableDelay(waitSeconds * 1000, signal);
    }
    const error = new Error('GitHub device authorization was cancelled.');
    error.name = 'AbortError';
    throw error;
}

export async function fetchExactVaultSnapshot(api, config) {
    validateRepositoryConfig(config);
    const prefix = normalizedOutputPrefix(config.encryptedOutputPath);
    const ref = await api.request('GET', refPath(config));
    const baseSha = ref.object?.sha;
    const commit = await api.request('GET', repoPath(config, `/git/commits/${baseSha}`));
    const baseTreeSha = commit.tree?.sha;
    const tree = await api.request('GET', repoPath(config, `/git/trees/${baseTreeSha}?recursive=1`));
    if (tree.truncated) throw new GitHubApiError('GitHub returned a truncated repository tree; no update can be planned safely.', { code: 'TRUNCATED_TREE' });
    const entries = tree.tree.filter((entry) => entry.type === 'blob' && isEncryptedPath(entry.path, prefix));
    const files = new Map();
    for (const entry of entries) {
        const blob = await api.request('GET', repoPath(config, `/git/blobs/${entry.sha}`));
        if (blob.encoding !== 'base64') throw new GitHubApiError(`Unsupported Git blob encoding for ${entry.path}.`);
        files.set(entry.path, Buffer.from(blob.content.replace(/\s/g, ''), 'base64'));
    }
    const manifestPath = `${prefix}/manifest.enc`;
    if (!files.has(manifestPath)) throw new GitHubApiError(`Remote snapshot ${baseSha} is missing ${manifestPath}.`, { code: 'MANIFEST_MISSING' });
    return { baseSha, baseTreeSha, files, entries, prefix };
}

export async function applyAtomicEncryptedUpdate(api, config, update) {
    validateRepositoryConfig(config);
    validateUpdate(update, normalizedOutputPrefix(config.encryptedOutputPath));
    const currentRef = await api.request('GET', refPath(config));
    if (currentRef.object?.sha !== update.baseSha) {
        throw new GitHubApiError('The target branch changed after preview. Fetch the new base and review a new plan.', {
            code: 'BASE_SHA_CHANGED',
            status: 409
        });
    }

    const created = new Map();
    for (const [filePath, bytes] of [...update.files].sort(([left], [right]) => left.localeCompare(right))) {
        const blob = await api.request('POST', repoPath(config, '/git/blobs'), {
            body: { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
        });
        created.set(filePath, blob.sha);
    }
    const targetPaths = new Set(update.files.keys());
    const treeEntries = [...created].map(([filePath, sha]) => ({ path: filePath, mode: '100644', type: 'blob', sha }));
    for (const stalePath of update.baseEncryptedPaths) {
        if (!targetPaths.has(stalePath)) treeEntries.push({ path: stalePath, mode: '100644', type: 'blob', sha: null });
    }
    const tree = await api.request('POST', repoPath(config, '/git/trees'), {
        body: { base_tree: update.baseTreeSha, tree: treeEntries }
    });
    const commit = await api.request('POST', repoPath(config, '/git/commits'), {
        body: {
            message: update.message || 'Update encrypted Print Drive vault',
            tree: tree.sha,
            parents: [update.baseSha]
        }
    });
    try {
        await api.request('PATCH', refPath(config), { body: { sha: commit.sha, force: false } });
    } catch (error) {
        if (error instanceof GitHubApiError && [403, 409, 422].includes(error.status)) {
            const protectionRejected = error.status === 403
                || (error.status === 422 && /protected branch|branch protection|protected ref/i.test(error.response?.message || error.message));
            error.code = protectionRejected ? 'BRANCH_PROTECTION_BLOCKED' : 'REF_UPDATE_CONFLICT';
            error.pendingCommitSha = commit.sha;
        }
        throw error;
    }
    return { commitSha: commit.sha, branch: config.branch, direct: true };
}

export async function publishFallbackBranch(api, config, update, pendingCommitSha) {
    if (!/^[0-9a-f]{40}$/.test(pendingCommitSha || '')) throw new Error('A pending commit SHA is required for fallback.');
    const branch = `print-drive-update/${Date.now()}-${randomBytes(4).toString('hex')}`;
    await api.request('POST', repoPath(config, '/git/refs'), {
        body: { ref: `refs/heads/${branch}`, sha: pendingCommitSha }
    });
    const pull = await api.request('POST', repoPath(config, '/pulls'), {
        body: {
            title: 'Update encrypted Print Drive vault',
            head: branch,
            base: config.branch,
            body: `Encrypted-vault-only update based on ${update.baseSha}. Plaintext is not included.`
        }
    });
    return { branch, pullRequestUrl: pull.html_url, direct: false, deployed: false };
}

export function redactSensitive(value, token) {
    let text = String(value || '');
    if (token) text = text.replaceAll(token, '[redacted]');
    return text.replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]');
}

function safeResponseHeaders(headers) {
    const safe = {};
    for (const name of ['x-github-sso', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
        const value = headers?.get?.(name);
        if (value) safe[name] = value;
    }
    return safe;
}

function validateUpdate(update, prefix) {
    if (!/^[0-9a-f]{40}$/.test(update.baseSha || '') || !/^[0-9a-f]{40}$/.test(update.baseTreeSha || '')) {
        throw new Error('Update must be bound to exact 40-hex base commit and tree SHAs.');
    }
    if (!(update.files instanceof Map) || !(update.baseEncryptedPaths instanceof Set)) throw new Error('Update file maps are invalid.');
    if (!update.files.has(`${prefix}/manifest.enc`)) throw new Error('Target update is missing its encrypted manifest.');
    for (const [filePath, bytes] of update.files) {
        if (!isEncryptedPath(filePath, prefix)) throw new Error(`Refusing to modify a path outside encrypted output: ${filePath}`);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > GITHUB_BLOB_LIMIT_BYTES) {
            throw new Error(`GitHub blob-size limit exceeded: ${filePath}`);
        }
    }
    for (const filePath of update.baseEncryptedPaths) {
        if (!isEncryptedPath(filePath, prefix)) throw new Error(`Unsafe stale-object path: ${filePath}`);
    }
}

function validateRepositoryConfig(config) {
    if (!/^[A-Za-z0-9_.-]+$/.test(config.owner || '') || !/^[A-Za-z0-9_.-]+$/.test(config.repo || '')) throw new Error('Repository owner/name is invalid.');
    if (!config.branch || /[\u0000-\u0020~^:?*\[\\]/.test(config.branch)) throw new Error('Target branch is invalid.');
    normalizedOutputPrefix(config.encryptedOutputPath);
}

function normalizedOutputPrefix(value = 'files') {
    const prefix = String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!prefix || prefix.startsWith('/') || prefix.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Encrypted output path is unsafe.');
    return prefix;
}

function isEncryptedPath(filePath, prefix) {
    return filePath === `${prefix}/manifest.enc` || new RegExp(`^${escapeRegex(prefix)}/[0-9a-f]{32}\\.bin$`).test(filePath);
}
function refPath(config) { return repoPath(config, `/git/ref/heads/${encodeURIComponent(config.branch)}`); }
function repoPath(config, suffix) { return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}${suffix}`; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function abortableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('Operation cancelled.'); error.name = 'AbortError'; reject(error);
        }, { once: true });
    });
}
