import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyExactMatch } from '../scripts/restore_source.mjs';

function local(relativePath, size, sha256) {
    return { relativePath, size, sha256 };
}

function remote(relativePath, size, sha256) {
    return { relativePath, name: relativePath.split('/').at(-1), size, sha256 };
}

test('restored files must exactly match the manifest', () => {
    assert.doesNotThrow(() => verifyExactMatch([
        local('문서/과제.pdf', 10, 'a'.repeat(64)),
        local('사진.png', 20, 'b'.repeat(64))
    ], [
        remote('문서/과제.pdf', 10, 'a'.repeat(64)),
        remote('사진.png', 20, 'b'.repeat(64))
    ]));
});

test('restore verification rejects missing files', () => {
    assert.throws(() => verifyExactMatch([], [
        remote('문서/과제.pdf', 10, 'a'.repeat(64))
    ]), /file count mismatch/);
});

test('restore verification rejects changed file contents', () => {
    assert.throws(() => verifyExactMatch([
        local('문서/과제.pdf', 10, 'b'.repeat(64))
    ], [
        remote('문서/과제.pdf', 10, 'a'.repeat(64))
    ]), /verification failed/);
});
