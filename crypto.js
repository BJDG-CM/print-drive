export const MANIFEST_AAD = 'print-drive:manifest:v1';
export const FORMAT_VERSION = 2;
export const MANIFEST_SCHEMA = 2;
export const HKDF_MANIFEST_INFO = 'print-drive:v2:manifest-key';
export const HKDF_DEK_WRAP_INFO = 'print-drive:v2:dek-wrap-key';

const MIN_KDF_ITERATIONS = 200_000;
const MAX_KDF_ITERATIONS = 2_000_000;
const MAX_MANIFEST_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 16;
const MAX_MANIFEST_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const MAX_FILE_COUNT = 5_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PADDING_BLOCK = 1024 * 1024;
const V2_PATH_RE = /^files\/([0-9a-f]{32})\.bin$/;
const V1_PATH_RE = /^files\/([0-9a-f]{32})\.bin$/;
const HEX_32_RE = /^[0-9a-f]{32}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const cryptoTextEncoder = new TextEncoder();
const cryptoTextDecoder = new TextDecoder('utf-8', { fatal: true });

export class PrintDriveCryptoError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'PrintDriveCryptoError';
        this.code = code;
    }
}

export async function unlockVault(password, envelope) {
    validateManifestEnvelope(envelope);
    if (envelope.version === 1) {
        const rawKeyBytes = new Uint8Array(await deriveKeyBytes(password, envelope.crypto.kdf));
        return createVaultContextFromRaw(1, rawKeyBytes, envelope);
    }

    for (const slot of envelope.keySlots) {
        try {
            const kekBytes = await deriveKeyBytes(password, slot.kdf, { base64Url: true });
            const kek = await importAesKey(kekBytes, ['decrypt']);
            const rawVaultKey = await crypto.subtle.decrypt(
                aesGcmParams(slot.wrappedVaultKey.iv, createVaultKeyAad(envelope.vaultId, slot), true),
                kek,
                base64UrlDecodeStrict(slot.wrappedVaultKey.data)
            );
            return createVaultContextFromRaw(2, new Uint8Array(rawVaultKey), envelope);
        } catch (error) {
            if (error instanceof PrintDriveCryptoError && error.code === 'SCHEMA_INVALID') {
                throw error;
            }
        }
    }

    throw new PrintDriveCryptoError('INVALID_PASSWORD', '비밀번호가 맞지 않거나 vault key slot을 열 수 없습니다.');
}

export async function createVaultContextFromRaw(version, rawKeyBytes, envelope) {
    const bytes = toBytes(rawKeyBytes);
    if (bytes.byteLength !== 32) {
        throw schemaError('vault key는 32바이트여야 합니다.');
    }

    if (version === 1) {
        return {
            version: 1,
            rawKeyBytes: new Uint8Array(bytes),
            key: await importAesKey(bytes)
        };
    }
    if (version !== 2 || envelope?.version !== 2) {
        throw schemaError('저장된 세션 key의 포맷 버전이 올바르지 않습니다.');
    }

    const subkeys = await deriveVaultSubkeys(bytes, envelope.vaultId);
    return {
        version: 2,
        vaultId: envelope.vaultId,
        rawKeyBytes: new Uint8Array(bytes),
        manifestKey: subkeys.manifestKey,
        dekWrapKey: subkeys.dekWrapKey
    };
}

export async function deriveKeyBytes(password, kdf, options = {}) {
    if (typeof password !== 'string') {
        throw schemaError('비밀번호 입력 형식이 올바르지 않습니다.');
    }
    validateKdf(kdf, options.base64Url);
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
            salt: options.base64Url ? base64UrlDecodeStrict(kdf.salt) : base64ToBytes(kdf.salt),
            iterations: kdf.iterations
        },
        baseKey,
        256
    );
}

export async function deriveVaultSubkeys(rawVaultKey, vaultId) {
    assertHex(vaultId, 32, 'vaultId');
    const keyMaterial = await crypto.subtle.importKey('raw', toBytes(rawVaultKey), 'HKDF', false, ['deriveKey']);
    const salt = hexToBytes(vaultId);
    const derive = (info, usages) => crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
            info: cryptoTextEncoder.encode(info)
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        usages
    );

    const [manifestKey, dekWrapKey] = await Promise.all([
        derive(HKDF_MANIFEST_INFO, ['encrypt', 'decrypt']),
        derive(HKDF_DEK_WRAP_INFO, ['encrypt', 'decrypt'])
    ]);
    return { manifestKey, dekWrapKey };
}

export async function importAesKey(keyBytes, usages = ['decrypt', 'encrypt'], extractable = false) {
    return crypto.subtle.importKey('raw', toBytes(keyBytes), 'AES-GCM', extractable, usages);
}

export async function decryptManifest(envelope, keyOrContext) {
    validateManifestEnvelope(envelope);
    try {
        let plaintext;
        if (envelope.version === 1) {
            const key = keyOrContext?.version === 1 ? keyOrContext.key : keyOrContext;
            plaintext = await crypto.subtle.decrypt(
                aesGcmParams(envelope.manifest.iv, MANIFEST_AAD),
                key,
                base64ToBytes(envelope.manifest.data)
            );
        } else {
            assertV2Context(keyOrContext, envelope.vaultId);
            plaintext = await crypto.subtle.decrypt(
                aesGcmParams(
                    envelope.manifest.iv,
                    createManifestAad(envelope.vaultId, envelope.manifest),
                    true
                ),
                keyOrContext.manifestKey,
                base64UrlDecodeStrict(envelope.manifest.data)
            );
        }

        if (plaintext.byteLength > MAX_MANIFEST_PLAINTEXT_BYTES) {
            throw schemaError('복호화된 manifest가 허용 크기를 초과했습니다.');
        }
        const manifest = JSON.parse(cryptoTextDecoder.decode(plaintext));
        return envelope.version === 1
            ? validateManifestV1(manifest)
            : validateManifestV2(manifest, envelope);
    } catch (error) {
        if (error instanceof PrintDriveCryptoError) {
            throw error;
        }
        if (error instanceof SyntaxError || error?.name === 'EncodingError') {
            throw schemaError('복호화된 manifest JSON이 올바르지 않습니다.', error);
        }
        throw new PrintDriveCryptoError('AUTHENTICATION_FAILED', 'manifest 인증 또는 복호화에 실패했습니다.', { cause: error });
    }
}

export async function fetchAndDecryptFile(file, vaultContext, options = {}) {
    const entry = file.manifestEntry || file;
    validateFileEntry(entry, vaultContext?.version || 1, vaultContext?.vaultId);
    const encrypted = await fetchEncryptedFile(entry, options.signal);

    try {
        let paddedPlaintext;
        if (vaultContext?.version === 2) {
            const ciphertextHash = await sha256Hex(encrypted);
            if (!timingSafeTextEqual(ciphertextHash, entry.ciphertextSha256)) {
                throw new PrintDriveCryptoError('INTEGRITY_FAILED', '암호문 SHA-256 검증에 실패했습니다.');
            }
            const dataKeyBytes = await unwrapFileDataKey(entry, vaultContext);
            const dataKey = await importAesKey(dataKeyBytes, ['decrypt']);
            paddedPlaintext = await crypto.subtle.decrypt(
                aesGcmParams(entry.dataIv, createFileV2Aad(vaultContext.vaultId, entry), true),
                dataKey,
                encrypted
            );
            dataKeyBytes.fill(0);
        } else {
            const key = vaultContext?.version === 1 ? vaultContext.key : vaultContext;
            paddedPlaintext = await crypto.subtle.decrypt(
                aesGcmParams(entry.iv, createFileAad(entry.id)),
                key,
                encrypted
            );
        }

        const bytes = new Uint8Array(paddedPlaintext).slice(0, entry.size);
        await verifySha256(bytes, entry.sha256);
        return { file, bytes };
    } catch (error) {
        if (error instanceof PrintDriveCryptoError) {
            throw error;
        }
        throw new PrintDriveCryptoError('AUTHENTICATION_FAILED', `${file.name} 인증 또는 복호화에 실패했습니다.`, { cause: error });
    }
}

export async function decryptSharedFile(payload, dataKeyBytes, options = {}) {
    validateSharedFileEntry(payload);
    const encrypted = await fetchEncryptedFile(payload, options.signal);
    const ciphertextHash = payload.ciphertextSha256
        ? await sha256Hex(encrypted)
        : null;
    if (ciphertextHash && !timingSafeTextEqual(ciphertextHash, payload.ciphertextSha256)) {
        throw new PrintDriveCryptoError('INTEGRITY_FAILED', '공유 파일 암호문 검증에 실패했습니다.');
    }

    try {
        const key = await importAesKey(dataKeyBytes, ['decrypt']);
        const plaintext = await crypto.subtle.decrypt(
            aesGcmParams(payload.dataIv, createFileV2Aad(payload.vaultId, payload), true),
            key,
            encrypted
        );
        const bytes = new Uint8Array(plaintext).slice(0, payload.size);
        await verifySha256(bytes, payload.sha256);
        return { file: payload, bytes };
    } catch (error) {
        if (error instanceof PrintDriveCryptoError) {
            throw error;
        }
        throw new PrintDriveCryptoError('AUTHENTICATION_FAILED', '공유 파일 인증 또는 복호화에 실패했습니다.', { cause: error });
    }
}

function validateSharedFileEntry(file) {
    if (!isPlainObject(file)) {
        throw schemaError('공유 파일 항목 형식이 올바르지 않습니다.');
    }
    validateFileName(file.name);
    assertHex(file.vaultId, 32, 'vaultId');
    assertHex(file.logicalId, 32, 'logicalId');
    assertHex(file.blobId, 32, 'blobId');
    if (file.path !== `files/${file.blobId}.bin`) {
        throw schemaError('공유 파일 path가 올바르지 않습니다.');
    }
    assertIntegerRange(file.size, 0, MAX_FILE_BYTES, 'size');
    assertIntegerRange(file.paddedSize, file.size, MAX_FILE_BYTES + MAX_PADDING_BLOCK, 'paddedSize');
    assertIntegerRange(file.encryptedSize, 16, MAX_FILE_BYTES + MAX_PADDING_BLOCK + 16, 'encryptedSize');
    if (file.encryptedSize !== file.paddedSize + 16) {
        throw schemaError('공유 파일 encryptedSize가 올바르지 않습니다.');
    }
    assertHex(file.sha256, 64, 'sha256');
    assertHex(file.ciphertextSha256, 64, 'ciphertextSha256');
    if (base64UrlDecodeStrict(file.dataIv).byteLength !== 12) {
        throw schemaError('공유 파일 dataIv가 올바르지 않습니다.');
    }
}

export async function unwrapFileDataKey(file, vaultContext) {
    assertV2Context(vaultContext, file.vaultId || vaultContext.vaultId);
    try {
        const raw = await crypto.subtle.decrypt(
            aesGcmParams(file.wrappedDek.iv, createDekAad(vaultContext.vaultId, file), true),
            vaultContext.dekWrapKey,
            base64UrlDecodeStrict(file.wrappedDek.data)
        );
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength !== 32) {
            throw schemaError('복호화된 DEK 길이가 올바르지 않습니다.');
        }
        return bytes;
    } catch (error) {
        if (error instanceof PrintDriveCryptoError) {
            throw error;
        }
        throw new PrintDriveCryptoError('AUTHENTICATION_FAILED', '파일 DEK 인증에 실패했습니다.', { cause: error });
    }
}

export async function encryptBrowserFileV2(descriptor, paddedBytes, vaultContext) {
    assertV2Context(vaultContext, descriptor.vaultId);
    validateFileDescriptorForEncryption(descriptor, paddedBytes.byteLength);
    const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const dataKey = await importAesKey(dataKeyBytes, ['encrypt']);
    const dataIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedDekIv = crypto.getRandomValues(new Uint8Array(12));

    try {
        const encryptedBytes = await encryptBytes(
            paddedBytes,
            dataKey,
            dataIv,
            createFileV2Aad(vaultContext.vaultId, descriptor)
        );
        const wrappedDek = await encryptBytes(
            dataKeyBytes,
            vaultContext.dekWrapKey,
            wrappedDekIv,
            createDekAad(vaultContext.vaultId, descriptor)
        );
        return {
            encryptedBytes,
            dataIv: base64UrlEncode(dataIv),
            ciphertextSha256: await sha256Hex(encryptedBytes),
            wrappedDek: {
                name: 'AES-GCM',
                iv: base64UrlEncode(wrappedDekIv),
                data: base64UrlEncode(wrappedDek)
            }
        };
    } finally {
        dataKeyBytes.fill(0);
    }
}

export async function encryptManifestV2(envelope, manifest, vaultContext) {
    const objectIndex = createObjectIndex(manifest.files);
    const candidateEnvelope = {
        ...envelope,
        objectIndex,
        manifest: {
            schema: 2,
            id: manifest.id,
            revision: manifest.revision,
            iv: base64UrlEncode(crypto.getRandomValues(new Uint8Array(12))),
            data: ''
        }
    };
    validateManifestV2(manifest, { ...candidateEnvelope, manifest: { ...candidateEnvelope.manifest, data: base64UrlEncode(new Uint8Array(16)) } }, { skipCiphertext: true });
    const ciphertext = await encryptBytes(
        cryptoTextEncoder.encode(JSON.stringify(manifest)),
        vaultContext.manifestKey,
        base64UrlDecodeStrict(candidateEnvelope.manifest.iv),
        createManifestAad(candidateEnvelope.vaultId, candidateEnvelope.manifest)
    );
    candidateEnvelope.manifest.data = base64UrlEncode(ciphertext);
    validateManifestEnvelope(candidateEnvelope);
    return candidateEnvelope;
}

export async function encryptBytes(bytes, key, iv, aad) {
    const encrypted = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: toBytes(iv),
            additionalData: cryptoTextEncoder.encode(aad)
        },
        key,
        toBytes(bytes)
    );
    return new Uint8Array(encrypted);
}

export async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', toBytes(bytes));
    return bytesToHex(new Uint8Array(digest));
}

export function validateManifestEnvelope(envelope) {
    if (!isPlainObject(envelope) || envelope.app !== 'print-drive') {
        throw schemaError('암호화 목록 envelope가 올바르지 않습니다.');
    }
    if (envelope.version === 1) {
        validateEnvelopeV1(envelope);
        return envelope;
    }
    if (envelope.version !== 2) {
        throw schemaError('지원하지 않는 암호화 목록 버전입니다.');
    }
    assertExactKeys(envelope, ['version', 'app', 'vaultId', 'keySlots', 'crypto', 'objectIndex', 'manifest'], 'v2 envelope');

    assertHex(envelope.vaultId, 32, 'vaultId');
    if (!Array.isArray(envelope.keySlots) || envelope.keySlots.length < 1 || envelope.keySlots.length > 2) {
        throw schemaError('v2 keySlots 개수가 올바르지 않습니다.');
    }
    const slotIds = new Set();
    const slotSalts = new Set();
    for (const slot of envelope.keySlots) {
        if (!isPlainObject(slot)) {
            throw schemaError('v2 key slot 형식이 올바르지 않습니다.');
        }
        assertExactKeys(slot, ['id', 'kdf', 'wrappedVaultKey'], 'key slot');
        assertHex(slot.id, 32, 'key slot id');
        if (slotIds.has(slot.id) || slotSalts.has(slot.kdf?.salt)) {
            throw schemaError('중복된 key slot id 또는 KDF salt가 있습니다.');
        }
        slotIds.add(slot.id);
        slotSalts.add(slot.kdf?.salt);
        validateKdf(slot.kdf, true);
        validateGcmEnvelope(slot.wrappedVaultKey, 48, true, 'wrappedVaultKey');
    }

    const cryptoConfig = envelope.crypto;
    assertExactKeys(cryptoConfig, ['hkdf', 'cipher', 'padding'], 'crypto');
    assertExactKeys(cryptoConfig?.hkdf, ['name', 'hash'], 'crypto.hkdf');
    assertExactKeys(cryptoConfig?.cipher, ['name', 'keyLength', 'ivLength', 'tagLength'], 'crypto.cipher');
    assertExactKeys(cryptoConfig?.padding, ['blockSize'], 'crypto.padding');
    const blockSize = cryptoConfig?.padding?.blockSize;
    if (
        !isPlainObject(cryptoConfig) ||
        cryptoConfig.hkdf?.name !== 'HKDF' ||
        cryptoConfig.hkdf?.hash !== 'SHA-256' ||
        cryptoConfig.cipher?.name !== 'AES-GCM' ||
        cryptoConfig.cipher?.keyLength !== 256 ||
        cryptoConfig.cipher?.ivLength !== 12 ||
        cryptoConfig.cipher?.tagLength !== 128 ||
        !Number.isSafeInteger(blockSize) ||
        blockSize < 0 ||
        blockSize > MAX_PADDING_BLOCK ||
        (blockSize !== 0 && (blockSize < 1024 || (blockSize & (blockSize - 1)) !== 0))
    ) {
        throw schemaError('v2 crypto 설정이 올바르지 않습니다.');
    }

    if (
        !isPlainObject(envelope.manifest) ||
        envelope.manifest.schema !== 2 ||
        !HEX_32_RE.test(envelope.manifest.id || '') ||
        !Number.isSafeInteger(envelope.manifest.revision) ||
        envelope.manifest.revision < 1
    ) {
        throw schemaError('v2 manifest descriptor가 올바르지 않습니다.');
    }
    assertExactKeys(envelope.manifest, ['schema', 'id', 'revision', 'iv', 'data'], 'manifest descriptor');
    const manifestIv = base64UrlDecodeStrict(envelope.manifest.iv);
    const manifestData = base64UrlDecodeStrict(envelope.manifest.data);
    if (manifestIv.byteLength !== 12 || manifestData.byteLength < 16 || manifestData.byteLength > MAX_MANIFEST_CIPHERTEXT_BYTES) {
        throw schemaError('v2 manifest 암호문 길이가 올바르지 않습니다.');
    }
    validateObjectIndex(envelope.objectIndex);
    return envelope;
}

export function validateManifestV2(manifest, envelope, options = {}) {
    if (
        !isPlainObject(manifest) ||
        manifest.version !== 2 ||
        manifest.vaultId !== envelope.vaultId ||
        manifest.id !== envelope.manifest.id ||
        manifest.revision !== envelope.manifest.revision ||
        !isIsoDate(manifest.createdAt) ||
        !isIsoDate(manifest.updatedAt) ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > MAX_FILE_COUNT
    ) {
        throw schemaError('v2 manifest schema가 올바르지 않습니다.');
    }
    assertExactKeys(manifest, ['version', 'vaultId', 'id', 'revision', 'createdAt', 'updatedAt', 'files'], 'manifest');
    if (manifest.updatedAt < manifest.createdAt) {
        throw schemaError('manifest updatedAt이 createdAt보다 빠릅니다.');
    }

    const logicalIds = new Set();
    const blobIds = new Set();
    const paths = new Set();
    const normalizedNames = new Set();
    const dataIvs = new Set();
    const wrapIvs = new Set();
    let previousName = null;
    for (const file of manifest.files) {
        validateFileEntry(file, 2, manifest.vaultId, envelope.crypto.padding.blockSize);
        for (const [set, value, label] of [
            [logicalIds, file.logicalId, 'logicalId'],
            [blobIds, file.blobId, 'blobId'],
            [paths, file.path, 'path'],
            [normalizedNames, file.name.toLocaleLowerCase('en-US'), '파일명']
        ]) {
            if (set.has(value)) {
                throw schemaError(`중복된 ${label}이 있습니다.`);
            }
            set.add(value);
        }
        if (dataIvs.has(file.dataIv) || wrapIvs.has(file.wrappedDek.iv)) {
            throw schemaError('manifest에 중복된 AES-GCM nonce가 있습니다.');
        }
        if (previousName !== null && previousName > file.name) {
            throw schemaError('manifest 파일 목록이 canonical 이름순으로 정렬되지 않았습니다.');
        }
        dataIvs.add(file.dataIv);
        wrapIvs.add(file.wrappedDek.iv);
        previousName = file.name;
    }

    if (!options.skipCiphertext) {
        const expected = createObjectIndex(manifest.files);
        if (JSON.stringify(expected) !== JSON.stringify(envelope.objectIndex)) {
            throw schemaError('manifest 파일 참조와 공개 objectIndex가 일치하지 않습니다.');
        }
    }
    return manifest;
}

export function createObjectIndex(files) {
    const objects = files
        .map((file) => ({
            blobId: file.blobId,
            path: file.path,
            encryptedSize: file.encryptedSize,
            ciphertextSha256: file.ciphertextSha256
        }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { version: 1, objects };
}

export function createVaultKeyAad(vaultId, slot) {
    return canonicalAad([
        'print-drive', 2, 'vault-key', vaultId, slot.id,
        'PBKDF2', 'SHA-256', slot.kdf.iterations, slot.kdf.salt
    ]);
}

export function createManifestAad(vaultId, manifestDescriptor) {
    return canonicalAad([
        'print-drive', 2, 'manifest', vaultId,
        manifestDescriptor.id, manifestDescriptor.revision
    ]);
}

export function createDekAad(vaultId, file) {
    return canonicalAad([
        'print-drive', 2, 'dek', vaultId, file.logicalId, file.blobId
    ]);
}

export function createFileV2Aad(vaultId, file) {
    return canonicalAad([
        'print-drive', 2, 'file', vaultId, file.logicalId, file.blobId,
        file.size, file.paddedSize, file.sha256
    ]);
}

export function canonicalAad(parts) {
    return JSON.stringify(parts);
}

export function createFileAad(fileId) {
    return `print-drive:file:${fileId}:v1`;
}

export function base64ToBytes(value) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw schemaError('base64 값이 올바르지 않습니다.');
    }
    try {
        return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    } catch (error) {
        throw schemaError('base64 값을 해석할 수 없습니다.', error);
    }
}

export function bytesToBase64(bytes) {
    let binary = '';
    toBytes(bytes).forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

export function base64UrlDecodeStrict(value) {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw schemaError('base64url 값이 올바르지 않습니다.');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const bytes = base64ToBytes(padded);
    if (base64UrlEncode(bytes) !== value) {
        throw schemaError('base64url 값이 canonical 형식이 아닙니다.');
    }
    return bytes;
}

export function base64UrlEncode(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function bytesToHex(bytes) {
    return Array.from(toBytes(bytes))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function validateEnvelopeV1(envelope) {
    if (
        envelope.crypto?.kdf?.name !== 'PBKDF2' ||
        envelope.crypto.kdf.hash !== 'SHA-256' ||
        envelope.crypto?.cipher?.name !== 'AES-GCM' ||
        envelope.crypto.cipher.keyLength !== 256 ||
        envelope.crypto.cipher.ivLength !== 12 ||
        envelope.crypto.cipher.tagLength !== 128
    ) {
        throw schemaError('v1 crypto 설정이 올바르지 않습니다.');
    }
    validateKdf(envelope.crypto.kdf, false);
    const blockSize = envelope.crypto.padding?.blockSize;
    if (!Number.isSafeInteger(blockSize) || blockSize < 0 || blockSize > MAX_PADDING_BLOCK) {
        throw schemaError('v1 padding 설정이 올바르지 않습니다.');
    }
    validateGcmEnvelope(envelope.manifest, null, false, 'v1 manifest');
    if (base64ToBytes(envelope.manifest.data).byteLength > MAX_MANIFEST_CIPHERTEXT_BYTES) {
        throw schemaError('v1 manifest 암호문이 허용 크기를 초과했습니다.');
    }
}

function validateManifestV1(manifest) {
    if (
        !isPlainObject(manifest) ||
        manifest.version !== 1 ||
        !isIsoDate(manifest.createdAt) ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > MAX_FILE_COUNT
    ) {
        throw schemaError('v1 manifest schema가 올바르지 않습니다.');
    }
    const ids = new Set();
    const paths = new Set();
    const names = new Set();
    for (const file of manifest.files) {
        validateFileEntry(file, 1);
        const normalizedName = file.name.toLocaleLowerCase('en-US');
        if (ids.has(file.id) || paths.has(file.path) || names.has(normalizedName)) {
            throw schemaError('v1 manifest에 중복된 ID, path 또는 파일명이 있습니다.');
        }
        ids.add(file.id);
        paths.add(file.path);
        names.add(normalizedName);
    }
    return manifest;
}

function validateFileEntry(file, version, vaultId, blockSize = 0) {
    if (!isPlainObject(file)) {
        throw schemaError('manifest 파일 항목 형식이 올바르지 않습니다.');
    }
    validateFileName(file.name);
    assertIntegerRange(file.size, 0, MAX_FILE_BYTES, 'file size');
    assertHex(file.sha256, 64, 'file sha256');
    if (!isIsoDate(file.modifiedAt)) {
        throw schemaError('파일 수정 시간이 올바르지 않습니다.');
    }

    if (version === 1) {
        assertHex(file.id, 32, 'v1 file id');
        if (!V1_PATH_RE.test(file.path) || file.path !== `files/${file.id}.bin`) {
            throw schemaError('v1 file path가 올바르지 않습니다.');
        }
        assertIntegerRange(file.encryptedSize, 16, MAX_FILE_BYTES + MAX_PADDING_BLOCK + 16, 'encryptedSize');
        if (base64ToBytes(file.iv).byteLength !== 12) {
            throw schemaError('v1 file IV 길이가 올바르지 않습니다.');
        }
        return;
    }

    if (file.vaultId !== undefined && file.vaultId !== vaultId) {
        throw schemaError('파일 vaultId가 현재 vault와 일치하지 않습니다.');
    }
    assertExactKeys(file, [
        'logicalId', 'blobId', 'path', 'name', 'size', 'paddedSize', 'encryptedSize',
        'sha256', 'ciphertextSha256', 'modifiedAt', 'dataIv', 'wrappedDek'
    ], 'v2 manifest file');
    assertHex(file.logicalId, 32, 'logicalId');
    assertHex(file.blobId, 32, 'blobId');
    if (!V2_PATH_RE.test(file.path) || file.path !== `files/${file.blobId}.bin`) {
        throw schemaError('v2 file path가 올바르지 않습니다.');
    }
    assertIntegerRange(file.paddedSize, file.size, MAX_FILE_BYTES + MAX_PADDING_BLOCK, 'paddedSize');
    assertIntegerRange(file.encryptedSize, 16, MAX_FILE_BYTES + MAX_PADDING_BLOCK + 16, 'encryptedSize');
    if (file.encryptedSize !== file.paddedSize + 16) {
        throw schemaError('v2 encryptedSize와 paddedSize가 일치하지 않습니다.');
    }
    if (blockSize && file.paddedSize % blockSize !== 0) {
        throw schemaError('v2 paddedSize가 padding block에 정렬되지 않았습니다.');
    }
    assertHex(file.ciphertextSha256, 64, 'ciphertextSha256');
    if (base64UrlDecodeStrict(file.dataIv).byteLength !== 12) {
        throw schemaError('v2 dataIv 길이가 올바르지 않습니다.');
    }
    validateGcmEnvelope(file.wrappedDek, 48, true, 'wrappedDek');
}

function validateFileDescriptorForEncryption(file, paddedSize) {
    validateFileName(file.name);
    assertHex(file.vaultId, 32, 'vaultId');
    assertHex(file.logicalId, 32, 'logicalId');
    assertHex(file.blobId, 32, 'blobId');
    assertIntegerRange(file.size, 0, MAX_FILE_BYTES, 'size');
    assertIntegerRange(file.paddedSize, file.size, MAX_FILE_BYTES + MAX_PADDING_BLOCK, 'paddedSize');
    if (file.paddedSize !== paddedSize) {
        throw schemaError('암호화할 padding 길이가 descriptor와 일치하지 않습니다.');
    }
    assertHex(file.sha256, 64, 'sha256');
}

function validateObjectIndex(index) {
    if (!isPlainObject(index) || index.version !== 1 || !Array.isArray(index.objects) || index.objects.length > MAX_FILE_COUNT) {
        throw schemaError('objectIndex 형식이 올바르지 않습니다.');
    }
    assertExactKeys(index, ['version', 'objects'], 'objectIndex');
    let previousBlobId = '';
    const seen = new Set();
    for (const object of index.objects) {
        if (!isPlainObject(object)) {
            throw schemaError('objectIndex 항목 형식이 올바르지 않습니다.');
        }
        assertExactKeys(object, ['blobId', 'path', 'encryptedSize', 'ciphertextSha256'], 'objectIndex object');
        assertHex(object.blobId, 32, 'object blobId');
        if (object.path !== `files/${object.blobId}.bin`) {
            throw schemaError('objectIndex path가 올바르지 않습니다.');
        }
        assertIntegerRange(object.encryptedSize, 16, MAX_FILE_BYTES + MAX_PADDING_BLOCK + 16, 'object encryptedSize');
        assertHex(object.ciphertextSha256, 64, 'object ciphertextSha256');
        if (seen.has(object.blobId) || (previousBlobId && object.path <= `files/${previousBlobId}.bin`)) {
            throw schemaError('objectIndex가 중복됐거나 정렬되지 않았습니다.');
        }
        seen.add(object.blobId);
        previousBlobId = object.blobId;
    }
}

async function fetchEncryptedFile(file, signal) {
    const expectedPath = file.path;
    if (!V2_PATH_RE.test(expectedPath) && !V1_PATH_RE.test(expectedPath)) {
        throw schemaError('허용되지 않은 암호문 경로입니다.');
    }
    const url = new URL(expectedPath, location.href);
    if (url.origin !== location.origin || !url.pathname.endsWith(`/${expectedPath}`)) {
        throw schemaError('외부 origin의 암호문 경로는 허용되지 않습니다.');
    }
    url.searchParams.set('t', String(Date.now()));
    let response;
    try {
        response = await fetch(url, {
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal,
            headers: { Accept: 'application/octet-stream' }
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw error;
        }
        throw new PrintDriveCryptoError('NETWORK_FAILED', `${file.name} 암호문 네트워크 요청에 실패했습니다.`, { cause: error });
    }
    if (!response.ok) {
        throw new PrintDriveCryptoError('NETWORK_FAILED', `${file.name} 암호문 다운로드 실패 (${response.status})`);
    }
    const encrypted = await readResponseBytesBounded(response, file.encryptedSize, {
        signal,
        errorCode: 'INTEGRITY_FAILED',
        errorMessage: `${file.name} 암호문 크기가 manifest와 다릅니다.`
    });
    if (encrypted.byteLength !== file.encryptedSize) {
        throw new PrintDriveCryptoError('INTEGRITY_FAILED', `${file.name} 암호문 크기 검증에 실패했습니다.`);
    }
    return encrypted;
}

export async function readResponseBytesBounded(response, maxBytes, options = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new TypeError('maxBytes must be a non-negative safe integer.');
    }
    const fail = () => new PrintDriveCryptoError(
        options.errorCode || 'BROWSER_SIZE_LIMIT',
        options.errorMessage || '네트워크 응답이 허용 크기를 초과했습니다.'
    );
    const contentLengthHeader = response.headers?.get?.('content-length');
    if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
            throw fail();
        }
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
        throw new PrintDriveCryptoError(
            options.errorCode || 'NETWORK_FAILED',
            '이 브라우저는 bounded response streaming을 지원하지 않습니다.'
        );
    }

    const chunks = [];
    let totalBytes = 0;
    try {
        while (true) {
            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error
                    ? options.signal.reason
                    : new DOMException('The operation was aborted.', 'AbortError');
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array) || totalBytes + value.byteLength > maxBytes) {
                try {
                    await reader.cancel('Print Drive response size limit exceeded.');
                } catch {
                    // The size failure remains authoritative even if cancellation also fails.
                }
                throw fail();
            }
            chunks.push(value);
            totalBytes += value.byteLength;
        }
    } finally {
        reader.releaseLock?.();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function verifySha256(bytes, expectedHash) {
    const actualHash = await sha256Hex(bytes);
    if (!timingSafeTextEqual(actualHash, expectedHash)) {
        throw new PrintDriveCryptoError('INTEGRITY_FAILED', '복호화된 파일 SHA-256 검증에 실패했습니다.');
    }
}

function validateKdf(kdf, base64Url) {
    assertExactKeys(kdf, ['name', 'hash', 'iterations', 'salt'], 'PBKDF2');
    if (
        !isPlainObject(kdf) ||
        kdf.name !== 'PBKDF2' ||
        kdf.hash !== 'SHA-256' ||
        !Number.isSafeInteger(kdf.iterations) ||
        kdf.iterations < MIN_KDF_ITERATIONS ||
        kdf.iterations > MAX_KDF_ITERATIONS
    ) {
        throw schemaError('PBKDF2 설정이 허용 범위를 벗어났습니다.');
    }
    const salt = base64Url ? base64UrlDecodeStrict(kdf.salt) : base64ToBytes(kdf.salt);
    if (salt.byteLength < 16 || salt.byteLength > 64) {
        throw schemaError('PBKDF2 salt 길이가 허용 범위를 벗어났습니다.');
    }
}

function validateGcmEnvelope(value, exactDataLength, base64Url, label) {
    if (!isPlainObject(value) || (value.name !== undefined && value.name !== 'AES-GCM')) {
        throw schemaError(`${label} AES-GCM 형식이 올바르지 않습니다.`);
    }
    assertExactKeys(value, value.name === undefined ? ['iv', 'data'] : ['name', 'iv', 'data'], label);
    const decode = base64Url ? base64UrlDecodeStrict : base64ToBytes;
    const iv = decode(value.iv);
    const data = decode(value.data);
    if (iv.byteLength !== 12 || data.byteLength < 16 || (exactDataLength !== null && data.byteLength !== exactDataLength)) {
        throw schemaError(`${label} AES-GCM 길이가 올바르지 않습니다.`);
    }
}

function aesGcmParams(ivValue, aad, base64Url = false) {
    const iv = typeof ivValue === 'string'
        ? (base64Url ? base64UrlDecodeStrict(ivValue) : base64ToBytes(ivValue))
        : toBytes(ivValue);
    if (iv.byteLength !== 12) {
        throw schemaError('AES-GCM IV는 12바이트여야 합니다.');
    }
    return {
        name: 'AES-GCM',
        iv,
        additionalData: cryptoTextEncoder.encode(aad),
        tagLength: 128
    };
}

function validateFileName(name) {
    if (
        typeof name !== 'string' ||
        name.length < 1 ||
        Array.from(name).length > 255 ||
        name === '.' ||
        name === '..' ||
        name !== name.normalize('NFC') ||
        /[\\/\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)
    ) {
        throw schemaError('파일명이 Unicode NFC 단일 파일명 정책을 위반합니다.');
    }
}

function assertV2Context(context, vaultId) {
    if (
        !context || context.version !== 2 || context.vaultId !== vaultId ||
        !context.manifestKey || !context.dekWrapKey
    ) {
        throw new PrintDriveCryptoError('KEY_CONTEXT_INVALID', '현재 vault key context가 v2 파일과 일치하지 않습니다.');
    }
}

function assertHex(value, length, field) {
    const pattern = length === 32 ? HEX_32_RE : length === 64 ? HEX_64_RE : new RegExp(`^[0-9a-f]{${length}}$`);
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw schemaError(`${field} 형식이 올바르지 않습니다.`);
    }
}

function assertIntegerRange(value, min, max, field) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw schemaError(`${field} 값이 허용 범위를 벗어났습니다.`);
    }
}

function hexToBytes(value) {
    assertHex(value, value.length, 'hex');
    return Uint8Array.from(value.match(/.{2}/g), (part) => Number.parseInt(part, 16));
}

function timingSafeTextEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
}

function isIsoDate(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function schemaError(message, cause) {
    return new PrintDriveCryptoError('SCHEMA_INVALID', message, cause ? { cause } : undefined);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
    if (!isPlainObject(value)) {
        throw schemaError(`${label} 형식이 객체가 아닙니다.`);
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw schemaError(`${label} 필드가 strict schema와 일치하지 않습니다.`);
    }
}

function toBytes(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}
