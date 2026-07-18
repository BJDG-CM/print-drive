const FILE_ERROR_MESSAGES = Object.freeze({
    OBJECT_NOT_FOUND: {
        title: '암호화된 파일을 찾지 못했습니다.',
        message: '암호화된 파일을 서버에서 찾지 못했습니다. (404)'
    },
    NETWORK_FAILED: {
        title: '파일을 가져오지 못했습니다.',
        message: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.'
    },
    CIPHERTEXT_SIZE_MISMATCH: {
        title: '암호문 크기가 일치하지 않습니다.',
        message: '암호문 크기가 파일 목록과 일치하지 않습니다.'
    },
    CIPHERTEXT_HASH_MISMATCH: {
        title: '암호문 무결성 검증에 실패했습니다.',
        message: '암호문 무결성 검증에 실패했습니다.'
    },
    DEK_AUTHENTICATION_FAILED: {
        title: '파일 키 인증에 실패했습니다.',
        message: '파일 키 인증에 실패했습니다. 최신 페이지를 다시 불러오세요.'
    },
    FILE_AUTHENTICATION_FAILED: {
        title: '파일 인증에 실패했습니다.',
        message: '파일 인증에 실패했습니다. 최신 페이지를 다시 불러오세요.'
    },
    PLAINTEXT_HASH_MISMATCH: {
        title: '복호화 결과 검증에 실패했습니다.',
        message: '복호화된 파일의 무결성 검증에 실패했습니다.'
    },
    UNSUPPORTED_PREVIEW: {
        title: '이 형식은 미리보기를 지원하지 않습니다.',
        message: '파일은 검증됐지만 브라우저에서 표시할 수 없어 다운로드만 제공합니다.'
    },
    BROWSER_SIZE_LIMIT: {
        title: '브라우저 처리 한도를 초과했습니다.',
        message: '파일이 브라우저 메모리 또는 크기 한도를 초과했습니다.'
    },
    CANCELLED: {
        title: '작업이 취소되었습니다.',
        message: '파일 작업을 취소했습니다.'
    }
});

export function describeFileError(error) {
    const code = error?.name === 'AbortError' ? 'CANCELLED' : error?.code;
    return {
        code: code || 'UNKNOWN_FILE_ERROR',
        ...(FILE_ERROR_MESSAGES[code] || {
            title: '파일을 열지 못했습니다.',
            message: '파일 처리에 실패했습니다. 최신 페이지에서 다시 시도해 주세요.'
        })
    };
}

export function safeFileDiagnostic(error, file) {
    const presentation = describeFileError(error);
    const diagnostic = {
        code: presentation.code,
        status: Number.isSafeInteger(error?.status) ? error.status : null,
        logicalId: /^[0-9a-f]{32}$/.test(file?.logicalId || '') ? file.logicalId : null,
        blobId: /^[0-9a-f]{32}$/.test(file?.blobId || '') ? file.blobId : null
    };
    return Object.fromEntries(Object.entries(diagnostic).filter(([, value]) => value !== null));
}
