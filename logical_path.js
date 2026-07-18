const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_CHARACTER_RE = /[\u0000-\u001f\u007f\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function normalizeLogicalPath(value) {
    if (typeof value !== 'string' || !value || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
        throw pathError('relative path must not be empty or absolute');
    }
    if (value.includes('\\')) {
        throw pathError('backslashes are not allowed');
    }
    const segments = value.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw pathError('relative path contains an empty, dot, or traversal segment');
    }
    const result = segments.map((segment) => normalizeLogicalSegment(segment)).join('/');
    if (Array.from(result).length > 4096) {
        throw pathError('relative path exceeds 4096 Unicode characters');
    }
    return result;
}

export function normalizeLogicalSegment(value) {
    const normalized = typeof value === 'string' ? value.normalize('NFC') : '';
    if (
        !normalized ||
        Array.from(normalized).length > 255 ||
        FORBIDDEN_CHARACTER_RE.test(normalized) ||
        /[ .]$/.test(normalized) ||
        WINDOWS_DEVICE_RE.test(normalized)
    ) {
        throw pathError(`unsafe path component: ${String(value)}`);
    }
    return normalized;
}

export function logicalPathKey(value) {
    return normalizeLogicalPath(value).toLocaleLowerCase('en-US');
}

export function logicalBasename(value) {
    const normalized = normalizeLogicalPath(value);
    return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function logicalParent(value) {
    const normalized = normalizeLogicalPath(value);
    const index = normalized.lastIndexOf('/');
    return index < 0 ? '' : normalized.slice(0, index);
}

function pathError(detail) {
    const error = new Error(`Unsafe logical relative path: ${detail}.`);
    error.code = 'UNSAFE_LOGICAL_PATH';
    return error;
}
