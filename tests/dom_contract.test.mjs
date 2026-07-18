import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [html, app, bootstrap] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../bootstrap.js', import.meta.url), 'utf8')
]);

test('every app.js DOM hook exists exactly once in index.html', () => {
    const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
    assert.deepEqual(duplicates, []);

    const hookIds = [...app.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((match) => match[1]);
    const missing = hookIds.filter((id) => !htmlIds.includes(id));
    assert.deepEqual(missing, []);
});

test('production HTML keeps strict external-asset CSP and no prototype runtime', () => {
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|unpkg|support\.js|React|PROTOTYPE/i);
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
    assert.match(html, /<head>[\s\S]*<script src="bootstrap\.js"><\/script>[\s\S]*<\/head>/);
    assert.match(bootstrap, /import\('\.\/app\.js'\)/);
});

test('modals expose dialog semantics and public-exit copy names unmanaged traces', () => {
    for (const modalId of ['preview-modal', 'qr-modal']) {
        const modalPattern = new RegExp(`<section[^>]*id="${modalId}"[^>]*role="dialog"[^>]*aria-modal="true"`, 's');
        assert.match(html, modalPattern);
    }
    assert.match(html, /내려받은 파일과 브라우저 다운로드 기록/);
    assert.match(html, /운영체제 최근 파일과 프린터·인쇄 대기열 기록|OS 최근 파일, 프린터 기록/);
    assert.doesNotMatch(html, /흔적을 (?:완전히 )?지웠|인쇄 완료/);
});

test('entry routes open unlock directly while share and legacy links keep distinct handling', () => {
    assert.doesNotMatch(html, /mode-select-view|어떻게 파일을 열까요/);
    assert.match(app, /if \(initialShareFragment\) \{[\s\S]*initializePublicShare\(initialShareFragment\)[\s\S]*return;/);
    assert.match(app, /if \(location\.hash\.startsWith\('#file='\)\) \{[\s\S]*showVaultUnlock\(\{ legacyLink: true \}\)/);
    assert.match(app, /showVaultUnlock\(\);\s*\n\}/);
    assert.match(html, /id="legacy-link-warning"[^>]*hidden>이전 형식의 파일 링크/);
    assert.match(html, /공용 기기에서는 전체 파일 비밀번호를 입력하지 마세요/);
    assert.match(bootstrap, /pendingShareFragment = location\.hash/);
    assert.match(bootstrap, /history\.replaceState/);
});

test('recent and all are real accessible views and search bypasses the recent limit', () => {
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tab"[^>]*id="tab-recent"[^>]*aria-selected="false"/);
    assert.match(html, /role="tab"[^>]*id="tab-all"[^>]*aria-selected="true"/);
    assert.match(app, /!query && activeFileView === 'recent'/);
    assert.match(app, /matchingFiles\.slice\(0, 10\)/);
    assert.match(app, /visibleFiles = matchingFiles\.sort\(compareFilesBy\(sortBy\)\)/);
    assert.match(app, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
    assert.match(app, /tab\.setAttribute\('aria-selected', String\(selected\)\)/);
});

test('folder navigation exposes breadcrumbs and preserves logical paths in ZIP entries', () => {
    assert.match(html, /id="folder-breadcrumb"[^>]*aria-label="현재 폴더"/);
    assert.match(html, /id="btn-download-folder"[^>]*>현재 폴더 ZIP<\/button>/);
    assert.match(html, /placeholder="파일 이름 또는 경로 검색"/);
    assert.match(app, /describeFolderEntries\(matchingFiles, currentFolder\)/);
    assert.match(app, /filesInFolder\(allFiles, currentFolder, true\)/);
    assert.match(app, /zipEntryPath\(file, ZIP_FOLDER_NAME\)/);
});

test('management package creation is separated and uses accurate local-apply labels', () => {
    assert.match(html, /id="btn-management">관리<\/button>/);
    assert.match(html, /id="management-view"[^>]*hidden/);
    assert.match(html, /id="btn-management-back">← 파일 목록<\/button>/);
    assert.match(app, /dom\.vaultContent\.hidden = true;[\s\S]*dom\.managementView\.hidden = false/);
    const management = html.slice(html.indexOf('id="management-view"'), html.indexOf('</section>\n        </section>', html.indexOf('id="management-view"')));
    assert.doesNotMatch(management, /업로드|배포/);
    assert.match(management, /npm run update:check/);
    assert.match(management, /npm run update:apply/);
    assert.match(app, /업데이트 패키지 다운로드 요청됨 · 아직 적용되지 않음/);
    assert.match(app, /name: 'print-drive-update\.json'/);
    assert.match(management, /최신 휴대형 패키지/);
    assert.match(management, /웹 보관함은 GitHub token을 요청하거나 저장하지 않습니다/);
    assert.doesNotMatch(html, /capability|master key|key slot|object index|envelope|\bv[12]\b/i);
});
