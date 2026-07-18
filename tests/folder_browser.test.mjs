import assert from 'node:assert/strict';
import test from 'node:test';

import {
    breadcrumbFolders,
    describeFolderEntries,
    filesInFolder,
    normalizeManifestFile,
    zipEntryPath
} from '../folder_browser.js';

const files = [
    { relativePath: '계약/2026/서명본.pdf', size: 30 },
    { relativePath: '계약/초안.docx', size: 20 },
    { relativePath: '사진/행사.jpg', size: 10 },
    { relativePath: '안내.txt', size: 5 }
];

test('folder browser derives direct children and recursive contents from logical paths', () => {
    assert.deepEqual(describeFolderEntries(files, '').map(({ name, fileCount, totalSize }) => ({ name, fileCount, totalSize })), [
        { name: '계약', fileCount: 2, totalSize: 50 },
        { name: '사진', fileCount: 1, totalSize: 10 }
    ]);
    assert.deepEqual(filesInFolder(files, '').map((file) => file.relativePath), ['안내.txt']);
    assert.deepEqual(filesInFolder(files, '계약', true).map((file) => file.relativePath), ['계약/2026/서명본.pdf', '계약/초안.docx']);
    assert.deepEqual(breadcrumbFolders('계약/2026'), [
        { name: '계약', path: '계약' },
        { name: '2026', path: '계약/2026' }
    ]);
});

test('schema 2 root names remain compatible and schema 3 ZIP paths preserve hierarchy', () => {
    assert.deepEqual(normalizeManifestFile({ name: 'legacy.pdf' }), {
        relativePath: 'legacy.pdf', name: 'legacy.pdf', parentPath: ''
    });
    const nested = normalizeManifestFile({ name: '서명본.pdf', relativePath: '계약/2026/서명본.pdf' });
    assert.deepEqual(nested, { relativePath: '계약/2026/서명본.pdf', name: '서명본.pdf', parentPath: '계약/2026' });
    assert.equal(zipEntryPath(nested, 'Print_Drive_Download_Files'), 'Print_Drive_Download_Files/계약/2026/서명본.pdf');
});

test('folder browser rejects unsafe manifest and ZIP paths', () => {
    assert.throws(() => normalizeManifestFile({ relativePath: '../secret.txt' }), /Unsafe logical relative path/);
    assert.throws(() => zipEntryPath({ relativePath: 'folder\\file.txt' }, 'Print_Drive'), /Unsafe logical relative path/);
});
