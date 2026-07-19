import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDist } from '../scripts/build_dist.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXPECTED_VAULT_ID = '30b516ab734603477370e8446a18e893';

const [html, app, readme, boundary, portableGuide] = await Promise.all([
    readFile(path.join(ROOT, 'index.html'), 'utf8'),
    readFile(path.join(ROOT, 'app.js'), 'utf8'),
    readFile(path.join(ROOT, 'README.md'), 'utf8'),
    readFile(path.join(ROOT, 'docs', 'PRODUCT_BOUNDARY.md'), 'utf8'),
    readFile(path.join(ROOT, 'docs', 'PORTABLE_UPDATER.md'), 'utf8')
]);

test('visitor flow requires only the Print Drive password and retains read actions', () => {
    const auth = html.slice(html.indexOf('id="auth-view"'), html.indexOf('id="loading-view"'));
    const credentialInputs = [...auth.matchAll(/<input\b[^>]*>/g)]
        .filter((match) => !/type="checkbox"/.test(match[0]));
    assert.equal(credentialInputs.length, 1);
    assert.match(credentialInputs[0][0], /id="password-input"[^>]*type="password"|type="password"[^>]*id="password-input"/);
    assert.match(auth, /전체 파일을 열려면 비밀번호를 입력하세요/);
    assert.match(html, /id="btn-preview-download"[^>]*>다운로드<\/button>/);
    assert.match(html, /id="btn-preview-print"[^>]*>인쇄 창 열기<\/button>/);
    assert.match(app, /openFile\(/);
    assert.match(app, /downloadSingleFile\(/);
    assert.match(app, /printPreviewFile\(/);
});

test('GitHub authentication and administrator controls are absent from the visitor flow', () => {
    assert.doesNotMatch(`${html}\n${app}`, /GitHub|OAuth|Device Flow|github_pat_|ghp_/i);
    assert.match(html, /id="btn-management"[^>]*hidden/);
    assert.match(html, /id="management-view"[^>]*hidden/);
});

test('repository-specific management is legacy owner-only, not a universal installer', () => {
    assert.match(html, /관리 프로그램은 별도 프로젝트로 제공될 예정입니다/);
    assert.doesNotMatch(html, /releases\/latest|최신 휴대형 패키지|Workspace 설정 예시/);
    assert.match(portableGuide, /Legacy owner-only/);
    assert.match(portableGuide, /범용 Print Drive installer나 권장 Manager가 아니며/);
});

test('documentation fixes the personal-instance boundary and future repository split', () => {
    for (const document of [readme, boundary]) {
        assert.match(document, /BJDG-CM\/print-drive is a deployed personal Print Drive instance\./);
        assert.match(document, /BJDG-CM\/print-drive-template/);
        assert.match(document, /BJDG-CM\/print-drive-manager/);
    }
    assert.match(boundary, /template will contain no personal encrypted manifest/i);
    assert.match(boundary, /Future Manager development must not occur in `BJDG-CM\/print-drive`/);
    assert.match(boundary, /keep it usable throughout the transition/i);
});

test('production vault ID remains pinned to the deployed identity', async () => {
    const envelope = JSON.parse(await readFile(path.join(ROOT, 'files', 'manifest.enc'), 'utf8'));
    assert.equal(envelope.vaultId, EXPECTED_VAULT_ID);
});

test('a build-only operation leaves current encrypted output byte-for-byte unchanged', async () => {
    const before = await encryptedOutputHashes();
    await buildDist({ projectRoot: ROOT, outputDir: path.join(ROOT, 'files') });
    const after = await encryptedOutputHashes();
    assert.deepEqual(after, before);
});

async function encryptedOutputHashes() {
    const filesDirectory = path.join(ROOT, 'files');
    const names = (await readdir(filesDirectory))
        .filter((name) => name === 'manifest.enc' || /^[0-9a-f]{32}\.bin$/.test(name))
        .sort();
    const entries = await Promise.all(names.map(async (name) => {
        const bytes = await readFile(path.join(filesDirectory, name));
        return [name, createHash('sha256').update(bytes).digest('hex')];
    }));
    return Object.fromEntries(entries);
}
