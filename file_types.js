export const MIME_TYPES = new Map([
    ['pdf', 'application/pdf'],
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
    ['svg', 'image/svg+xml'],
    ['txt', 'text/plain'],
    ['csv', 'text/csv'],
    ['md', 'text/markdown'],
    ['html', 'text/html'],
    ['htm', 'text/html'],
    ['xml', 'application/xml'],
    ['doc', 'application/msword'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['ppt', 'application/vnd.ms-powerpoint'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['xls', 'application/vnd.ms-excel'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['hwp', 'application/x-hwp'],
    ['hwpx', 'application/x-hwpx'],
    ['zip', 'application/zip'],
    ['7z', 'application/x-7z-compressed'],
    ['rar', 'application/vnd.rar'],
    ['tar', 'application/x-tar'],
    ['gz', 'application/gzip']
]);

export const FILE_TYPES = {
    pdf: new Set(['pdf']),
    image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic']),
    document: new Set(['doc', 'docx', 'hwp', 'hwpx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'csv', 'md', 'html', 'htm', 'xml']),
    archive: new Set(['zip', '7z', 'rar', 'tar', 'gz'])
};

export const PREVIEWABLE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'csv', 'md']);
export const TEXT_PREVIEW_EXTENSIONS = new Set(['txt', 'csv', 'md']);

export const FILE_TYPE_LABELS = {
    pdf: 'PDF',
    image: '이미지',
    document: '문서',
    archive: '압축파일',
    other: '기타'
};

export const FILE_TYPE_ICONS = {
    pdf: 'PDF',
    image: 'IMG',
    document: 'DOC',
    archive: 'ZIP',
    other: 'FILE'
};

export function getExtension(name) {
    const lastDot = name.lastIndexOf('.');
    return lastDot > -1 ? name.slice(lastDot + 1).toLowerCase() : '';
}

export function getFileType(extension) {
    if (FILE_TYPES.pdf.has(extension)) {
        return 'pdf';
    }

    if (FILE_TYPES.image.has(extension)) {
        return 'image';
    }

    if (FILE_TYPES.document.has(extension)) {
        return 'document';
    }

    if (FILE_TYPES.archive.has(extension)) {
        return 'archive';
    }

    return 'other';
}

export function getMimeType(extension) {
    return MIME_TYPES.get(extension) || 'application/octet-stream';
}

export function isPreviewableFile(file) {
    return PREVIEWABLE_EXTENSIONS.has((file.extension || '').toLowerCase());
}

export function isTextPreviewableFile(file) {
    return TEXT_PREVIEW_EXTENSIONS.has((file.extension || '').toLowerCase());
}
