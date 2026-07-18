import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSea } from 'node:sea';
import { decryptAesGcm, encryptAesGcm, parseEnvelopeText } from '../vault_format.mjs';
import {
    applyAtomicEncryptedUpdate,
    fetchExactVaultSnapshot,
    GitHubApi,
    MemoryToken,
    pollDeviceFlow,
    publishFallbackBranch,
    redactSensitive,
    startDeviceFlow,
    validateAuthentication
} from './remote_updater.mjs';
import { pollPagesDeployment } from './deployment.mjs';
import { inspectSourceDirectory, openSourceDirectory, selectSourceDirectory } from './source_directory.mjs';
import { renderPortableUi } from './ui.mjs';
import { buildWorkspaceUpdate } from './workspace_update.mjs';

const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function startPortableUpdater(args = process.argv.slice(2)) {
    if (args.includes('--smoke-test')) return runSmokeTest();
    const portableRoot = process.env.PRINT_DRIVE_PORTABLE_ROOT || (isSea() ? path.dirname(process.execPath) : SOURCE_ROOT);
    const config = validateWorkspaceConfig(JSON.parse(await readFile(path.join(portableRoot, 'print-drive.workspace.json'), 'utf8')));
    const workspace = path.join(portableRoot, 'Workspace');
    let sourceDirectory = workspace;
    const sessionToken = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const token = new MemoryToken();
    let pendingUpdate = null;
    let pendingFallbackCommit = null;
    let deviceFlow = null;
    let deviceAbort = null;

    const server = http.createServer(async (request, response) => {
        try {
            assertLocalRequest(request, sessionToken);
            if (request.method === 'GET' && request.url.startsWith('/?')) {
                const nonce = randomBytes(18).toString('base64url');
                return sendHtml(response, renderPortableUi(nonce), nonce);
            }
            if (request.method === 'GET' && route(request) === '/api/session') {
                return sendJson(response, 200, {
                    csrf, workspace, source: await inspectSourceDirectory(sourceDirectory), owner: config.owner, repo: config.repo, branch: config.branch,
                    deviceFlowConfigured: Boolean(config.oauthClientId), authenticated: Boolean(token.get()), pagesUrl: config.pagesUrl || null
                });
            }
            assertCsrf(request, csrf);
            const body = await readJsonBody(request);
            if (request.method === 'POST' && route(request) === '/api/source/select') {
                const selected = await selectSourceDirectory(sourceDirectory);
                if (selected) sourceDirectory = (await inspectSourceDirectory(selected)).path;
                pendingUpdate = null; pendingFallbackCommit = null;
                return sendJson(response, 200, { source: await inspectSourceDirectory(sourceDirectory), cancelled: !selected });
            }
            if (request.method === 'POST' && route(request) === '/api/source/open') {
                openSourceDirectory(sourceDirectory);
                return sendJson(response, 200, { opened: true });
            }
            if (request.method === 'POST' && route(request) === '/api/source/refresh') {
                pendingUpdate = null; pendingFallbackCommit = null;
                return sendJson(response, 200, { source: await inspectSourceDirectory(sourceDirectory) });
            }
            if (request.method === 'POST' && route(request) === '/api/auth/pat') {
                try {
                    token.set(body.token);
                    body.token = '';
                    await validateAuthentication(new GitHubApi({ token: token.get() }), config);
                    return sendJson(response, 200, { authenticated: true, method: 'pat' });
                } catch (error) {
                    token.clear();
                    throw error;
                }
            }
            if (request.method === 'POST' && route(request) === '/api/auth/status') {
                return sendJson(response, 200, { authenticated: Boolean(token.get()) });
            }
            if (request.method === 'POST' && route(request) === '/api/device/start') {
                if (!config.oauthClientId) throw Object.assign(new Error('이 패키지에는 기기 로그인이 설정되지 않았습니다. Fine-grained token을 사용하세요.'), { code: 'DEVICE_FLOW_NOT_CONFIGURED' });
                deviceFlow = await startDeviceFlow({ clientId: config.oauthClientId });
                return sendJson(response, 200, { userCode: deviceFlow.userCode, verificationUri: deviceFlow.verificationUri });
            }
            if (request.method === 'POST' && route(request) === '/api/device/poll') {
                if (!deviceFlow) throw new Error('기기 로그인을 먼저 시작하세요.');
                deviceAbort = new AbortController();
                token.set(await pollDeviceFlow({
                    clientId: config.oauthClientId,
                    deviceCode: deviceFlow.deviceCode,
                    interval: deviceFlow.interval,
                    signal: deviceAbort.signal
                }));
                await validateAuthentication(new GitHubApi({ token: token.get() }), config);
                deviceFlow = null;
                return sendJson(response, 200, { authenticated: true });
            }
            if (request.method === 'POST' && route(request) === '/api/preview') {
                if (!token.get()) throw Object.assign(new Error('GitHub 인증을 먼저 완료하세요.'), { code: 'AUTHENTICATION_REQUIRED' });
                const api = new GitHubApi({ token: token.get() });
                const snapshot = await fetchExactVaultSnapshot(api, config);
                const envelope = parseEnvelopeText(snapshot.files.get(`${snapshot.prefix}/manifest.enc`).toString('utf8'));
                if (config.expectedVaultId && envelope.vaultId !== config.expectedVaultId) throw new Error('원격 vault ID가 휴대형 설정과 일치하지 않습니다.');
                try {
                    pendingUpdate = await buildWorkspaceUpdate({
                        snapshot, workspaceDirectory: sourceDirectory, passphrase: body.passphrase,
                        mode: body.mode, removePaths: body.removePaths || [], confirmEmptyMirror: body.confirmEmptyMirror === true
                    });
                } finally {
                    body.passphrase = '';
                }
                pendingFallbackCommit = null;
                return sendJson(response, 200, {
                    baseSha: pendingUpdate.baseSha, plan: pendingUpdate.plan,
                    changeCount: pendingUpdate.changeCount, uploadBytes: pendingUpdate.uploadBytes,
                    manifestSha256: pendingUpdate.manifestSha256
                });
            }
            if (request.method === 'POST' && route(request) === '/api/apply') {
                if (!pendingUpdate) throw new Error('먼저 변경 계획을 미리보세요.');
                if (body.confirm !== true) throw new Error('변경 수와 암호화 업로드 크기를 확인한 뒤 적용 확인에 체크하세요.');
                const api = new GitHubApi({ token: token.get() });
                try {
                    const result = await applyAtomicEncryptedUpdate(api, config, pendingUpdate);
                    const deployment = await pollPagesDeployment({
                        pagesUrl: config.pagesUrl,
                        manifestSha256: pendingUpdate.manifestSha256,
                        objectPath: pendingUpdate.targetObjectPath
                    });
                    pendingUpdate = null; token.clear();
                    return sendJson(response, 200, { ...result, pagesUrl: config.pagesUrl || null, deployment });
                } catch (error) {
                    if (error.code === 'BRANCH_PROTECTION_BLOCKED') {
                        pendingFallbackCommit = error.pendingCommitSha;
                        return sendJson(response, 409, { error: '브랜치 보호로 직접 적용되지 않았습니다. 별도 브랜치와 PR을 만들 수 있습니다.', canFallback: true });
                    }
                    throw error;
                }
            }
            if (request.method === 'POST' && route(request) === '/api/fallback') {
                if (!pendingUpdate || !pendingFallbackCommit) throw new Error('PR fallback으로 게시할 대기 커밋이 없습니다.');
                const result = await publishFallbackBranch(new GitHubApi({ token: token.get() }), config, pendingUpdate, pendingFallbackCommit);
                pendingUpdate = null; pendingFallbackCommit = null; token.clear();
                return sendJson(response, 200, result);
            }
            if (request.method === 'POST' && route(request) === '/api/cancel') {
                deviceAbort?.abort(); deviceFlow = null; token.clear(); pendingUpdate = null; pendingFallbackCommit = null;
                return sendJson(response, 200, { cancelled: true });
            }
            return sendJson(response, 404, { error: '찾을 수 없는 로컬 경로입니다.' });
        } catch (error) {
            const safe = localizeError(error, token.get());
            return sendJson(response, error.status && error.status >= 400 ? error.status : 400, { error: safe, code: error.code || 'LOCAL_REQUEST_FAILED' });
        }
    });
    server.on('connection', (socket) => {
        if (socket.remoteAddress !== '127.0.0.1' && socket.remoteAddress !== '::ffff:127.0.0.1') socket.destroy();
    });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/?session=${sessionToken}`;
    console.log(`Print Drive portable updater: ${url}`);
    if (!args.includes('--no-open')) openBrowser(url);
    const shutdown = () => {
        deviceAbort?.abort(); token.clear(); pendingUpdate = null; pendingFallbackCommit = null;
        server.close();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); process.once('exit', () => token.clear());
    return { server, url, shutdown };
}

export function validateWorkspaceConfig(value) {
    const allowed = ['version', 'owner', 'repo', 'branch', 'encryptedOutputPath', 'applicationId', 'expectedVaultId', 'pagesUrl', 'oauthClientId'];
    if (!value || value.version !== 1 || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('휴대형 workspace 설정 형식이 올바르지 않습니다.');
    if (Object.keys(value).some((key) => /(pass|secret|token|private.?key)/i.test(key))) throw new Error('휴대형 설정에는 secret을 넣을 수 없습니다.');
    if (!value.owner || !value.repo || !value.branch || value.encryptedOutputPath !== 'files') throw new Error('휴대형 저장소 설정이 불완전합니다.');
    if (value.expectedVaultId && !/^[0-9a-f]{32}$/.test(value.expectedVaultId)) throw new Error('expectedVaultId가 올바르지 않습니다.');
    return Object.freeze({ ...value });
}

async function runSmokeTest() {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = Buffer.from('Print Drive portable synthetic cycle', 'utf8');
    const encrypted = encryptAesGcm(key, iv, plaintext, 'print-drive:portable:smoke');
    const decrypted = decryptAesGcm(key, iv, encrypted, 'print-drive:portable:smoke');
    const cryptoCycle = decrypted.equals(plaintext) && /^[0-9a-f]{64}$/.test(createHash('sha256').update(decrypted).digest('hex'));
    key.fill(0); iv.fill(0); plaintext.fill(0); encrypted.fill(0); decrypted.fill(0);
    const bundledAssets = renderPortableUi('smoke-nonce').includes('Print Drive 휴대형 업데이터');
    const result = { started: true, bundledAssets, cryptoCycle, systemNodeRequired: false, systemGitRequired: false, pythonRequired: false };
    console.log(JSON.stringify(result));
    return result;
}

function assertLocalRequest(request, sessionToken) {
    const host = request.headers.host || '';
    const url = new URL(request.url, `http://${host}`);
    if (!/^127\.0\.0\.1:\d+$/.test(host) || url.searchParams.get('session') !== sessionToken) {
        const error = new Error('유효하지 않은 로컬 세션입니다.'); error.status = 403; throw error;
    }
}
function assertCsrf(request, csrf) { if (request.headers['x-print-drive-csrf'] !== csrf) { const error = new Error('CSRF 검증에 실패했습니다.'); error.status = 403; throw error; } }
function route(request) { return new URL(request.url, `http://${request.headers.host}`).pathname; }
function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        request.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) { request.destroy(); reject(new Error('로컬 요청이 너무 큽니다.')); } else chunks.push(chunk); });
        request.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('로컬 JSON 요청이 올바르지 않습니다.')); } });
        request.on('error', reject);
    });
}
function sendJson(response, status, value) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); }
function sendHtml(response, value, nonce) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, 'x-content-type-options': 'nosniff' }); response.end(value); }
function openBrowser(url) { if (process.platform === 'win32') spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }

export function localizeError(error, tokenValue = null) {
    const messages = {
        INVALID_TOKEN: 'Token이 올바르지 않거나 만료되었습니다. 새 fine-grained token을 입력하세요.',
        REPOSITORY_NOT_ACCESSIBLE: '저장소를 찾을 수 없거나 이 token에 BJDG-CM/print-drive 접근 권한이 없습니다.',
        CONTENTS_WRITE_REQUIRED: '이 token에는 대상 저장소의 Contents: Read and write 권한이 필요합니다.',
        SSO_AUTHORIZATION_REQUIRED: '조직 SSO 승인이 필요합니다. GitHub에서 token의 SSO 승인을 완료한 뒤 다시 시도하세요.',
        GITHUB_RATE_LIMITED: 'GitHub API 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
        AUTHENTICATION_REQUIRED: 'GitHub 인증을 먼저 완료하세요.'
    };
    if (messages[error.code]) return messages[error.code];
    if (error.cause?.code && ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(error.cause.code)) return 'GitHub 네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
    return redactSensitive(error.message, tokenValue);
}

if (process.argv[1] && (isSea() || import.meta.url === pathToFileURL(process.argv[1]).href)) {
    startPortableUpdater().catch((error) => { console.error(`Print Drive portable updater failed: ${error.message}`); process.exit(1); });
}
