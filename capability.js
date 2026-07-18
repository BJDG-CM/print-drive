const SHARE_AAD = 'print-drive:share-capability:v1';
const MAX_CAPABILITY_FRAGMENT_LENGTH = 16 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_DISPLAY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export async function createShareCapability(file, dataKeyBytes, options = {}) {
    const keyBytes = toBytes(dataKeyBytes);
    if (keyBytes.byteLength !== 32) {
        throw new Error('공유할 파일 키 길이가 올바르지 않습니다.');
    }

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const expiresAt = options.expiresAt || new Date(now + 30 * 60 * 1000).toISOString();
    const payload = validateCapabilityPayload({
        version: 1,
        vaultId: file.vaultId,
        logicalId: file.logicalId,
        blobId: file.blobId,
        path: file.path,
        name: file.name,
        size: file.size,
        paddedSize: file.paddedSize,
        encryptedSize: file.encryptedSize,
        sha256: file.sha256,
        ciphertextSha256: file.ciphertextSha256,
        dataIv: file.dataIv,
        modifiedAt: file.modifiedAt,
        dataKey: bytesToBase64Url(keyBytes),
        expiresAt
    }, { now, allowExpired: false });

    const secret = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv,
            additionalData: textEncoder.encode(SHARE_AAD)
        },
        key,
        textEncoder.encode(JSON.stringify(payload))
    );

    const fragment = [
        'share=v1',
        bytesToBase64Url(secret),
        bytesToBase64Url(iv),
        bytesToBase64Url(new Uint8Array(ciphertext))
    ].join('.');
    if (fragment.length > MAX_CAPABILITY_FRAGMENT_LENGTH) {
        throw new Error('공유 capability가 허용된 크기를 초과했습니다.');
    }

    const url = new URL(options.baseUrl || location.href);
    url.hash = fragment;
    return url.toString();
}

export async function openShareCapability(fragment, options = {}) {
    const value = String(fragment || '').replace(/^#/, '');
    if (!value.startsWith('share=') || value.length > MAX_CAPABILITY_FRAGMENT_LENGTH) {
        throw new Error('공유 링크 형식이 올바르지 않습니다.');
    }

    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'share=v1') {
        throw new Error('지원하지 않는 공유 링크 버전입니다.');
    }

    let secret;
    let iv;
    let ciphertext;
    try {
        secret = base64UrlToBytes(parts[1]);
        iv = base64UrlToBytes(parts[2]);
        ciphertext = base64UrlToBytes(parts[3]);
    } catch {
        throw new Error('공유 링크가 손상되었거나 유효하지 않습니다.');
    }
    if (secret.byteLength !== 32 || iv.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > 12 * 1024) {
        throw new Error('공유 링크 암호화 값이 올바르지 않습니다.');
    }

    try {
        const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt']);
        const plaintext = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData: textEncoder.encode(SHARE_AAD)
            },
            key,
            ciphertext
        );
        const payload = JSON.parse(textDecoder.decode(plaintext));
        return validateCapabilityPayload(payload, {
            now: Number.isFinite(options.now) ? options.now : Date.now(),
            allowExpired: Boolean(options.allowExpired)
        });
    } catch (error) {
        if (error?.code === 'SHARE_EXPIRED' || /공유 파일 정보/.test(error?.message || '')) {
            throw error;
        }
        throw new Error('공유 링크가 손상되었거나 유효하지 않습니다.');
    }
}

export function validateCapabilityPayload(payload, options = {}) {
    if (!isPlainObject(payload) || payload.version !== 1) {
        throw new Error('공유 파일 정보 형식이 올바르지 않습니다.');
    }
    const expectedKeys = [
        'version', 'vaultId', 'logicalId', 'blobId', 'path', 'name', 'size', 'paddedSize',
        'encryptedSize', 'sha256', 'ciphertextSha256', 'dataIv', 'modifiedAt', 'dataKey', 'expiresAt'
    ].sort();
    const actualKeys = Object.keys(payload).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error('공유 파일 정보의 필드가 strict schema와 일치하지 않습니다.');
    }

    assertHex(payload.vaultId, 32, 'vaultId');
    assertHex(payload.logicalId, 32, 'logicalId');
    assertHex(payload.blobId, 32, 'blobId');
    if (payload.path !== `files/${payload.blobId}.bin`) {
        throw new Error('공유 파일 정보의 경로가 올바르지 않습니다.');
    }

    if (
        typeof payload.name !== 'string' ||
        payload.name !== payload.name.normalize('NFC') ||
        payload.name.length < 1 ||
        Array.from(payload.name).length > 255 ||
        /[\\/\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(payload.name)
    ) {
        throw new Error('공유 파일 정보의 파일명이 올바르지 않습니다.');
    }

    assertBoundedInteger(payload.size, 0, MAX_FILE_BYTES, 'size');
    assertBoundedInteger(payload.paddedSize, payload.size, MAX_FILE_BYTES + 65536, 'paddedSize');
    assertBoundedInteger(payload.encryptedSize, 16, MAX_FILE_BYTES + 65536 + 16, 'encryptedSize');
    if (payload.encryptedSize !== payload.paddedSize + 16) {
        throw new Error('공유 파일 정보의 암호문 크기가 올바르지 않습니다.');
    }
    assertHex(payload.sha256, 64, 'sha256');
    assertHex(payload.ciphertextSha256, 64, 'ciphertextSha256');
    if (base64UrlOrBase64ToBytes(payload.dataIv).byteLength !== 12) {
        throw new Error('공유 파일 정보의 dataIv가 올바르지 않습니다.');
    }
    if (base64UrlOrBase64ToBytes(payload.dataKey).byteLength !== 32) {
        throw new Error('공유 파일 정보의 dataKey가 올바르지 않습니다.');
    }

    const modifiedAt = Date.parse(payload.modifiedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(modifiedAt) || !Number.isFinite(expiresAt)) {
        throw new Error('공유 파일 정보의 시간이 올바르지 않습니다.');
    }
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (!options.allowExpired && expiresAt <= now) {
        const error = new Error('공유 링크의 표시상 유효 시간이 지났습니다.');
        error.code = 'SHARE_EXPIRED';
        throw error;
    }
    if (!options.allowExpired && expiresAt > now + MAX_DISPLAY_LIFETIME_MS) {
        throw new Error('공유 파일 정보의 표시 유효 시간은 최대 24시간입니다.');
    }

    return Object.freeze({ ...payload });
}

export function capabilityDataKeyBytes(payload) {
    return base64UrlOrBase64ToBytes(payload.dataKey);
}

export function bytesToBase64Url(bytes) {
    let binary = '';
    toBytes(bytes).forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('base64url 값이 올바르지 않습니다.');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (bytesToBase64Url(bytes) !== value) {
        throw new Error('base64url 값이 canonical 형식이 아닙니다.');
    }
    return bytes;
}

function base64UrlOrBase64ToBytes(value) {
    if (typeof value !== 'string' || !value) {
        throw new Error('인코딩 값이 올바르지 않습니다.');
    }
    if (/^[A-Za-z0-9_-]+$/.test(value)) {
        return base64UrlToBytes(value);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('base64 값이 올바르지 않습니다.');
    }
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function assertHex(value, length, field) {
    if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
        throw new Error(`공유 파일 정보의 ${field}가 올바르지 않습니다.`);
    }
}

function assertBoundedInteger(value, min, max, field) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`공유 파일 정보의 ${field}가 올바르지 않습니다.`);
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toBytes(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}
