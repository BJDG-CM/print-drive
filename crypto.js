export const MANIFEST_AAD = 'print-drive:manifest:v1';

const cryptoTextEncoder = new TextEncoder();
const cryptoTextDecoder = new TextDecoder();

export async function deriveKeyBytes(password, kdf) {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        cryptoTextEncoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );

    return crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: base64ToBytes(kdf.salt),
            iterations: kdf.iterations
        },
        baseKey,
        256
    );
}

export async function importAesKey(keyBytes) {
    return crypto.subtle.importKey(
        'raw',
        keyBytes,
        'AES-GCM',
        false,
        ['decrypt']
    );
}

export async function decryptManifest(envelope, key) {
    const plaintext = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: base64ToBytes(envelope.manifest.iv),
            additionalData: cryptoTextEncoder.encode(MANIFEST_AAD)
        },
        key,
        base64ToBytes(envelope.manifest.data)
    );

    const manifest = JSON.parse(cryptoTextDecoder.decode(plaintext));
    if (!Array.isArray(manifest.files)) {
        throw new Error('암호화 목록 안에 파일 목록이 없습니다.');
    }

    return manifest;
}

export async function fetchAndDecryptFile(file, decryptKey) {
    const response = await fetch(`${file.path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`${file.name} 암호문 다운로드 실패 (${response.status})`);
    }

    const encrypted = await response.arrayBuffer();
    const paddedPlaintext = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: base64ToBytes(file.iv),
            additionalData: cryptoTextEncoder.encode(createFileAad(file.id))
        },
        decryptKey,
        encrypted
    );

    const bytes = new Uint8Array(paddedPlaintext).slice(0, file.size);
    await verifySha256(bytes, file.sha256);
    return { file, bytes };
}

async function verifySha256(bytes, expectedHash) {
    if (!expectedHash) {
        return;
    }

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actualHash = bytesToHex(new Uint8Array(digest));
    if (actualHash !== expectedHash) {
        throw new Error('복호화된 파일 무결성 검증 실패');
    }
}

export function base64ToBytes(value) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

export function bytesToHex(bytes) {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function createFileAad(fileId) {
    return `print-drive:file:${fileId}:v1`;
}
