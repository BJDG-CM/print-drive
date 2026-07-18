#!/usr/bin/env node
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP_ROOT = path.join(PROJECT_ROOT, '.tmp');
const FIXTURE_ROOT = path.join(TMP_ROOT, 'design-fixture');
const SOURCE_ROOT = path.join(TMP_ROOT, 'design-fixture-source');
const FIXTURE_PASSPHRASE = 'print-drive-design-preview';
const BROWSER_ASSETS = [
    'index.html',
    'styles.css',
    'bootstrap.js',
    'app.js',
    'crypto.js',
    'capability.js',
    'public_device.js',
    'file_types.js',
    'ui.js',
    'zip.js',
    'qr.js',
    'sw.js',
    'manifest.json',
    'icon.svg',
    'robots.txt'
];

async function main() {
    assertTemporaryTarget(FIXTURE_ROOT);
    assertTemporaryTarget(SOURCE_ROOT);

    await rm(FIXTURE_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(SOURCE_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await mkdir(FIXTURE_ROOT, { recursive: true });
    await mkdir(SOURCE_ROOT, { recursive: true });

    try {
        await Promise.all(BROWSER_ASSETS.map((name) => (
            copyFile(path.join(PROJECT_ROOT, name), path.join(FIXTURE_ROOT, name))
        )));
        await writeSyntheticFiles();
        await encryptSyntheticFiles();
    } finally {
        await rm(SOURCE_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }

    console.log(`Design fixture ready in ${path.relative(PROJECT_ROOT, FIXTURE_ROOT)}.`);
    console.log('It contains synthetic data only and is ignored by Git.');
}

function assertTemporaryTarget(target) {
    const relative = path.relative(TMP_ROOT, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Refusing to modify a path outside .tmp: ${target}`);
    }
}

async function writeSyntheticFiles() {
    const pngPixel = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
        'base64'
    );
    const files = new Map([
        ['2026-07-17_수업자료.pdf', '%PDF-1.4\n% Synthetic design fixture\n'],
        ['과제_안내.txt', 'Print Drive 디자인 검토용 합성 텍스트입니다.\n실제 사용자 파일이 아닙니다.\n'],
        ['성적_계산.csv', 'name,score\n가상 학생,95\n'],
        ['발표_초안.md', '# 합성 발표 초안\n\n디자인 상태 검토에만 사용합니다.\n'],
        ['포스터_이미지.png', pngPixel],
        ['편집이_필요한_문서.docx', 'Synthetic DOCX placeholder for download-only state.\n'],
        ['아주_긴_파일명_모바일에서_두_줄_말줄임과_작업버튼_배치를_확인하기_위한_합성파일.txt', 'Long filename fixture.\n'],
        ['빈_파일', Buffer.alloc(0)]
    ]);

    await Promise.all([...files].map(([name, content]) => (
        writeFile(path.join(SOURCE_ROOT, name), content)
    )));
}

async function encryptSyntheticFiles() {
    const previousRoot = process.env.PRINT_DRIVE_ROOT;
    const previousPassphrase = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_ROOT = FIXTURE_ROOT;
    process.env.PRINT_DRIVE_PASSPHRASE = FIXTURE_PASSPHRASE;

    try {
        const moduleUrl = new URL(`../encrypt_files.mjs?design-fixture=${Date.now()}`, import.meta.url);
        const { main: encryptMain } = await import(moduleUrl.href);
        await encryptMain([
            '--source', SOURCE_ROOT,
            '--out', 'files',
            '--padding-bytes', '0'
        ]);
    } finally {
        restoreEnv('PRINT_DRIVE_ROOT', previousRoot);
        restoreEnv('PRINT_DRIVE_PASSPHRASE', previousPassphrase);
    }
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
