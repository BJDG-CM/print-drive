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
