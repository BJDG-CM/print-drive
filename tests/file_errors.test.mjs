import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFileError, safeFileDiagnostic } from '../file_errors.js';

test('file error categories remain distinct and user-facing', () => {
    const cases = new Map([
        ['OBJECT_NOT_FOUND', '404'],
        ['NETWORK_FAILED', '네트워크'],
        ['CIPHERTEXT_SIZE_MISMATCH', '크기'],
        ['CIPHERTEXT_HASH_MISMATCH', '암호문 무결성'],
        ['DEK_AUTHENTICATION_FAILED', '파일 키 인증'],
        ['FILE_AUTHENTICATION_FAILED', '파일 인증'],
        ['PLAINTEXT_HASH_MISMATCH', '복호화된 파일'],
        ['UNSUPPORTED_PREVIEW', '다운로드'],
        ['BROWSER_SIZE_LIMIT', '한도'],
        ['CANCELLED', '취소']
    ]);
    for (const [code, expected] of cases) {
        const result = describeFileError({ code });
        assert.equal(result.code, code);
        assert.match(`${result.title} ${result.message}`, new RegExp(expected));
        assert.notEqual(result.message, '파일 복호화에 실패했습니다.');
    }
    assert.equal(describeFileError({ name: 'AbortError' }).code, 'CANCELLED');
});

test('diagnostics contain only safe identifiers and status', () => {
    const result = safeFileDiagnostic(
        { code: 'OBJECT_NOT_FOUND', status: 404, passphrase: 'never-log-this' },
        { logicalId: 'a'.repeat(32), blobId: 'b'.repeat(32), name: 'secret-name.pdf' }
    );
    assert.deepEqual(result, {
        code: 'OBJECT_NOT_FOUND',
        status: 404,
        logicalId: 'a'.repeat(32),
        blobId: 'b'.repeat(32)
    });
});
