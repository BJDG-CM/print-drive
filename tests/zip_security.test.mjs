import assert from 'node:assert/strict';
import test from 'node:test';

import { createZipBlob, validateZipEntries } from '../zip.js';

test('ZIP entry validation accepts normalized relative file paths', () => {
    const entries = validateZipEntries([
        { name: 'Print_Drive/한글 파일.txt', bytes: new Uint8Array([1, 2, 3]) }
    ]);

    assert.equal(entries[0].name, 'Print_Drive/한글 파일.txt');
    assert.equal(createZipBlob(entries).type, 'application/zip');
});

for (const unsafeName of [
    '../secret.txt',
    'folder/../../secret.txt',
    '/absolute.txt',
    'C:\\absolute.txt',
    '\\\\server\\share.txt',
    'folder//file.txt',
    'folder/./file.txt',
    'bad\u0000name.txt'
]) {
    test(`ZIP entry validation rejects unsafe path: ${JSON.stringify(unsafeName)}`, () => {
        assert.throws(
            () => validateZipEntries([{ name: unsafeName, bytes: new Uint8Array() }]),
            /안전하지 않은 ZIP 파일 이름/
        );
    });
}

test('ZIP entry validation rejects Unicode-normalized and case-insensitive duplicates', () => {
    assert.throws(
        () => validateZipEntries([
            { name: 'folder/e\u0301.txt', bytes: new Uint8Array() },
            { name: 'folder/É.TXT', bytes: new Uint8Array() }
        ]),
        /중복된 ZIP 파일 이름/
    );
});
