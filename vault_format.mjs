import {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    pbkdf2Sync,
    randomBytes
} from 'node:crypto';

export const APP_ID = 'print-drive';
export const FORMAT_VERSION = 2;
export const MANIFEST_SCHEMA = 2;
export const OBJECT_INDEX_VERSION = 1;
export const DEFAULT_ITERATIONS = 650000;
export const MIN_ITERATIONS = 200000;
export const MAX_ITERATIONS = 2000000;
export const DEFAULT_PADDING_BYTES = 65536;
export const MAX_MANIFEST_FILES = 5000;
export const MAX_MANIFEST_PLAINTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_CIPHERTEXT_BYTES = MAX_MANIFEST_PLAINTEXT_BYTES + 16;
export const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const HKDF_MANIFEST_INFO = 'print-drive:v2:manifest-key';
export const HKDF_DEK_WRAP_INFO = 'print-drive:v2:dek-wrap-key';
export const V1_MANIFEST_AAD = 'print-drive:manifest:v1';

const HEX_128_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_TEXT_FIELD = 1024;

export class VaultFormatError extends Error {
    constructor(message, code = 'ERR_VAULT_FORMAT') {
        super(message);
        this.name = 'VaultFormatError';
        this.code = code;
    }
}

export class WrongPasswordError extends Error {
    constructor(message = 'The passphrase could not unlock this vault.') {
        super(message);
        this.name = 'WrongPasswordError';
        this.code = 'ERR_WRONG_PASSWORD';
    }
}

export function createCryptoDescriptor(paddingBlockSize = DEFAULT_PADDING_BYTES) {
    validatePaddingBlockSize(paddingBlockSize);
    return {
        hkdf: {
            name: 'HKDF',
            hash: 'SHA-256'
        },
        cipher: {
            name: 'AES-GCM',
            keyLength: 256,
            ivLength: 12,
            tagLength: 128
        },
        padding: {
            blockSize: paddingBlockSize
        }
    };
}

export function canonicalAad(fields) {
    if (!Array.isArray(fields) || fields.some((value) => (
        !['string', 'number'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isSafeInteger(value))
    ))) {
        throw new VaultFormatError('AAD fields must be an array of strings and safe integers.');
    }
    return Buffer.from(JSON.stringify(fields), 'utf8');
}

export function createVaultKeyAad(vaultId, slot) {
    return canonicalAad([
        APP_ID,
        FORMAT_VERSION,
        'vault-key',
        vaultId,
        slot.id,
        slot.kdf.name,
        slot.kdf.hash,
        slot.kdf.iterations,
        slot.kdf.salt
    ]);
}

export function createManifestAad(vaultId, manifest) {
    return canonicalAad([
        APP_ID,
        FORMAT_VERSION,
        'manifest',
        vaultId,
        manifest.id,
        manifest.revision
    ]);
}

export function createDekAad(vaultId, logicalId, blobId) {
    return canonicalAad([
        APP_ID,
        FORMAT_VERSION,
        'dek',
        vaultId,
        logicalId,
        blobId
    ]);
}

export function createFileAad(vaultId, file) {
    return canonicalAad([
        APP_ID,
        FORMAT_VERSION,
        'file',
        vaultId,
        file.logicalId,
        file.blobId,
        file.size,
        file.paddedSize,
        file.sha256
    ]);
}

export function deriveKek(passphrase, kdf) {
    validatePassphrase(passphrase);
    validateKdf(kdf, 'kdf');
    return pbkdf2Sync(
        Buffer.from(passphrase, 'utf8'),
        base64UrlDecodeStrict(kdf.salt, 32, 'kdf.salt'),
        kdf.iterations,
        32,
        'sha256'
    );
}

export function deriveVaultSubkeys(vaultKey, vaultId) {
    const key = asFixedBuffer(vaultKey, 32, 'vault key');
    const salt = hexToBytesStrict(vaultId, 16, 'vaultId');
    return {
        manifestKey: Buffer.from(hkdfSync(
            'sha256',
            key,
            salt,
            Buffer.from(HKDF_MANIFEST_INFO, 'utf8'),
            32
        )),
        dekWrapKey: Buffer.from(hkdfSync(
            'sha256',
            key,
            salt,
            Buffer.from(HKDF_DEK_WRAP_INFO, 'utf8'),
            32
        ))
    };
}

export function createPasswordKeySlot(passphrase, vaultKey, vaultId, options = {}) {
    validateId(vaultId, 'vaultId');
    const slot = {
        id: options.id || randomHex(16),
        kdf: {
            name: 'PBKDF2',
            hash: 'SHA-256',
            iterations: options.iterations ?? DEFAULT_ITERATIONS,
            salt: base64UrlEncode(options.salt || randomBytes(32))
        },
        wrappedVaultKey: {
            name: 'AES-GCM',
            iv: base64UrlEncode(options.iv || randomBytes(12)),
            data: ''
        }
    };
    validateId(slot.id, 'key slot id');
    validateKdf(slot.kdf, 'key slot kdf');
    const kek = deriveKek(passphrase, slot.kdf);
    const wrapped = encryptAesGcm(
        kek,
        base64UrlDecodeStrict(slot.wrappedVaultKey.iv, 12, 'wrappedVaultKey.iv'),
        asFixedBuffer(vaultKey, 32, 'vault key'),
        createVaultKeyAad(vaultId, slot)
    );
    slot.wrappedVaultKey.data = base64UrlEncode(wrapped);
    validateKeySlot(slot, 'keySlots[0]');
    return slot;
}

export function unlockVaultKey(envelope, passphrase) {
    validateEnvelopeV2(envelope);
    validatePassphrase(passphrase);
    for (const slot of envelope.keySlots) {
        try {
            const kek = deriveKek(passphrase, slot.kdf);
            const vaultKey = decryptAesGcm(
                kek,
                base64UrlDecodeStrict(slot.wrappedVaultKey.iv, 12, 'wrappedVaultKey.iv'),
                base64UrlDecodeStrict(slot.wrappedVaultKey.data, 48, 'wrappedVaultKey.data'),
                createVaultKeyAad(envelope.vaultId, slot)
            );
            if (vaultKey.byteLength === 32) {
                return { vaultKey, slotId: slot.id };
            }
        } catch (error) {
            if (error instanceof VaultFormatError) {
                throw error;
            }
        }
    }
    throw new WrongPasswordError();
}

export function createEncryptedManifest(manifest, vaultKey, vaultId, options = {}) {
    const descriptor = {
        schema: MANIFEST_SCHEMA,
        id: options.id || manifest.id || randomHex(16),
        revision: options.revision ?? manifest.revision,
        iv: base64UrlEncode(options.iv || randomBytes(12)),
        data: ''
    };
    validateId(vaultId, 'vaultId');
    validateId(descriptor.id, 'manifest.id');
    validateRevision(descriptor.revision, 'manifest.revision');
    const payload = {
        ...manifest,
        version: FORMAT_VERSION,
        vaultId,
        id: descriptor.id,
        revision: descriptor.revision
    };
    const { manifestKey } = deriveVaultSubkeys(vaultKey, vaultId);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    if (plaintext.byteLength > MAX_MANIFEST_PLAINTEXT_BYTES) {
        throw new VaultFormatError('Manifest plaintext exceeds the supported size.');
    }
    descriptor.data = base64UrlEncode(encryptAesGcm(
        manifestKey,
        base64UrlDecodeStrict(descriptor.iv, 12, 'manifest.iv'),
        plaintext,
        createManifestAad(vaultId, descriptor)
    ));
    return { descriptor, payload };
}

export function decryptManifestV2(envelope, vaultKey) {
    validateEnvelopeV2(envelope);
    const { manifestKey } = deriveVaultSubkeys(vaultKey, envelope.vaultId);
    const plaintext = decryptAesGcm(
        manifestKey,
        base64UrlDecodeStrict(envelope.manifest.iv, 12, 'manifest.iv'),
        base64UrlDecodeStrict(envelope.manifest.data, null, 'manifest.data'),
        createManifestAad(envelope.vaultId, envelope.manifest)
    );
    if (plaintext.byteLength > MAX_MANIFEST_PLAINTEXT_BYTES) {
        throw new VaultFormatError('Decrypted manifest exceeds the supported size.');
    }
    let manifest;
    try {
        manifest = JSON.parse(plaintext.toString('utf8'));
    } catch {
        throw new VaultFormatError('Decrypted manifest is not valid JSON.');
    }
    validateManifestV2(manifest, envelope);
    return manifest;
}

export function wrapDek(dek, dekWrapKey, vaultId, logicalId, blobId, options = {}) {
    const iv = options.iv || randomBytes(12);
    return {
        name: 'AES-GCM',
        iv: base64UrlEncode(iv),
        data: base64UrlEncode(encryptAesGcm(
            asFixedBuffer(dekWrapKey, 32, 'DEK wrap key'),
            asFixedBuffer(iv, 12, 'DEK wrap IV'),
            asFixedBuffer(dek, 32, 'DEK'),
            createDekAad(vaultId, logicalId, blobId)
        ))
    };
}

export function unwrapDek(wrappedDek, dekWrapKey, vaultId, logicalId, blobId) {
    validateWrappedKey(wrappedDek, 'wrappedDek');
    const dek = decryptAesGcm(
        asFixedBuffer(dekWrapKey, 32, 'DEK wrap key'),
        base64UrlDecodeStrict(wrappedDek.iv, 12, 'wrappedDek.iv'),
        base64UrlDecodeStrict(wrappedDek.data, 48, 'wrappedDek.data'),
        createDekAad(vaultId, logicalId, blobId)
    );
    return asFixedBuffer(dek, 32, 'unwrapped DEK');
}

export function encryptAesGcm(key, iv, plaintext, aad) {
    const cipher = createCipheriv(
        'aes-256-gcm',
        asFixedBuffer(key, 32, 'AES key'),
        asFixedBuffer(iv, 12, 'AES-GCM IV')
    );
    cipher.setAAD(Buffer.from(aad));
    const plaintextBytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
    const ciphertext = cipher.update(plaintextBytes);
    const finalBytes = cipher.final();
    return Buffer.concat(finalBytes.byteLength > 0
        ? [ciphertext, finalBytes, cipher.getAuthTag()]
        : [ciphertext, cipher.getAuthTag()]);
}

export function decryptAesGcm(key, iv, encrypted, aad) {
    const payload = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    if (payload.byteLength < 16) {
        throw new VaultFormatError('AES-GCM payload is shorter than its authentication tag.');
    }
    const decipher = createDecipheriv(
        'aes-256-gcm',
        asFixedBuffer(key, 32, 'AES key'),
        asFixedBuffer(iv, 12, 'AES-GCM IV')
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(payload.subarray(payload.byteLength - 16));
    const plaintext = decipher.update(payload.subarray(0, payload.byteLength - 16));
    const finalBytes = decipher.final();
    return finalBytes.byteLength > 0 ? Buffer.concat([plaintext, finalBytes]) : plaintext;
}

export function decryptFileV2(file, encrypted, vaultKey, vaultId) {
    const ciphertext = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    if (ciphertext.byteLength !== file.encryptedSize) {
        throw new VaultFormatError(`Encrypted size mismatch for ${file.path}.`);
    }
    if (sha256Hex(ciphertext) !== file.ciphertextSha256) {
        throw new VaultFormatError(`Ciphertext hash mismatch for ${file.path}.`);
    }
    const { dekWrapKey } = deriveVaultSubkeys(vaultKey, vaultId);
    const dek = unwrapDek(file.wrappedDek, dekWrapKey, vaultId, file.logicalId, file.blobId);
    const padded = decryptAesGcm(
        dek,
        base64UrlDecodeStrict(file.dataIv, 12, 'file.dataIv'),
        ciphertext,
        createFileAad(vaultId, file)
    );
    if (padded.byteLength !== file.paddedSize) {
        throw new VaultFormatError(`Padded size mismatch for ${file.path}.`);
    }
    const plaintext = padded.subarray(0, file.size);
    if (sha256Hex(plaintext) !== file.sha256) {
        throw new VaultFormatError(`Plaintext hash mismatch for ${file.path}.`);
    }
    return plaintext;
}

export function createObjectIndex(files) {
    return {
        version: OBJECT_INDEX_VERSION,
        objects: files
            .map((file) => ({
                blobId: file.blobId,
                path: file.path,
                encryptedSize: file.encryptedSize,
                ciphertextSha256: file.ciphertextSha256
            }))
            .sort((left, right) => compareUnicode(left.path, right.path))
    };
}

export function validateEnvelopeV2(envelope) {
    assertPlainObject(envelope, 'envelope');
    assertExactKeys(
        envelope,
        ['version', 'app', 'vaultId', 'keySlots', 'crypto', 'objectIndex', 'manifest'],
        'envelope'
    );
    if (envelope.version !== FORMAT_VERSION || envelope.app !== APP_ID) {
        throw new VaultFormatError('Unsupported vault envelope version or application.');
    }
    validateId(envelope.vaultId, 'vaultId');
    if (!Array.isArray(envelope.keySlots) || envelope.keySlots.length < 1 || envelope.keySlots.length > 2) {
        throw new VaultFormatError('keySlots must contain one or two password slots.');
    }
    const slotIds = new Set();
    const salts = new Set();
    envelope.keySlots.forEach((slot, index) => {
        validateKeySlot(slot, `keySlots[${index}]`);
        if (slotIds.has(slot.id) || salts.has(slot.kdf.salt)) {
            throw new VaultFormatError('Duplicate key slot id or KDF salt.');
        }
        slotIds.add(slot.id);
        salts.add(slot.kdf.salt);
    });
    validateCryptoDescriptor(envelope.crypto);
    validateObjectIndex(envelope.objectIndex);
    validateManifestDescriptor(envelope.manifest);
    return envelope;
}

export function validateManifestV2(manifest, envelope) {
    assertPlainObject(manifest, 'manifest plaintext');
    assertExactKeys(
        manifest,
        ['version', 'vaultId', 'id', 'revision', 'createdAt', 'updatedAt', 'files'],
        'manifest plaintext'
    );
    if (manifest.version !== FORMAT_VERSION) {
        throw new VaultFormatError('Unsupported decrypted manifest version.');
    }
    validateId(manifest.vaultId, 'manifest.vaultId');
    validateId(manifest.id, 'manifest.id');
    validateRevision(manifest.revision, 'manifest.revision');
    validateIsoDate(manifest.createdAt, 'manifest.createdAt');
    validateIsoDate(manifest.updatedAt, 'manifest.updatedAt');
    if (manifest.updatedAt < manifest.createdAt) {
        throw new VaultFormatError('manifest.updatedAt precedes manifest.createdAt.');
    }
    if (envelope) {
        if (
            manifest.vaultId !== envelope.vaultId ||
            manifest.id !== envelope.manifest.id ||
            manifest.revision !== envelope.manifest.revision
        ) {
            throw new VaultFormatError('Manifest identity does not match its authenticated envelope metadata.');
        }
    }
    if (!Array.isArray(manifest.files) || manifest.files.length > MAX_MANIFEST_FILES) {
        throw new VaultFormatError(`manifest.files must contain at most ${MAX_MANIFEST_FILES} files.`);
    }
    const logicalIds = new Set();
    const blobIds = new Set();
    const paths = new Set();
    const names = new Set();
    const dataIvs = new Set();
    const wrapIvs = new Set();
    let previousName = null;
    manifest.files.forEach((file, index) => {
        validateManifestFile(file, envelope?.crypto?.padding?.blockSize ?? DEFAULT_PADDING_BYTES, index);
        const normalizedName = canonicalFileNameKey(file.name);
        if (
            logicalIds.has(file.logicalId) ||
            blobIds.has(file.blobId) ||
            paths.has(file.path) ||
            names.has(normalizedName) ||
            dataIvs.has(file.dataIv) ||
            wrapIvs.has(file.wrappedDek.iv)
        ) {
            throw new VaultFormatError('Duplicate file identity, name, path, or nonce in manifest.');
        }
        if (previousName !== null && compareUnicode(previousName, file.name) > 0) {
            throw new VaultFormatError('manifest.files is not canonically sorted by name.');
        }
        previousName = file.name;
        logicalIds.add(file.logicalId);
        blobIds.add(file.blobId);
        paths.add(file.path);
        names.add(normalizedName);
        dataIvs.add(file.dataIv);
        wrapIvs.add(file.wrappedDek.iv);
    });
    if (envelope) {
        const expectedIndex = createObjectIndex(manifest.files);
        if (JSON.stringify(expectedIndex) !== JSON.stringify(envelope.objectIndex)) {
            throw new VaultFormatError('Public objectIndex does not match the authenticated manifest.');
        }
    }
    return manifest;
}

export function parseEnvelopeText(value) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes === 0 || bytes > MAX_ENVELOPE_BYTES) {
        throw new VaultFormatError('Vault envelope is empty or exceeds the supported size.');
    }
    let envelope;
    try {
        envelope = JSON.parse(value);
    } catch {
        throw new VaultFormatError('Vault envelope is not valid JSON.');
    }
    return envelope;
}

export function serializeEnvelope(envelope) {
    const value = `${JSON.stringify(envelope, null, 2)}\n`;
    if (Buffer.byteLength(value, 'utf8') > MAX_ENVELOPE_BYTES) {
        throw new VaultFormatError('Serialized vault envelope exceeds the supported size.');
    }
    return value;
}

export function validateEnvelopeV1(envelope) {
    assertPlainObject(envelope, 'v1 envelope');
    if (
        envelope.version !== 1 ||
        envelope.app !== APP_ID ||
        envelope?.crypto?.kdf?.name !== 'PBKDF2' ||
        envelope.crypto.kdf.hash !== 'SHA-256' ||
        !Number.isSafeInteger(envelope.crypto.kdf.iterations) ||
        envelope.crypto.kdf.iterations < MIN_ITERATIONS ||
        envelope.crypto.kdf.iterations > MAX_ITERATIONS ||
        envelope?.crypto?.cipher?.name !== 'AES-GCM'
    ) {
        throw new VaultFormatError('Unsupported or invalid v1 envelope.');
    }
    decodeBase64Strict(envelope.crypto.kdf.salt, 32, 'v1 kdf salt');
    decodeBase64Strict(envelope?.manifest?.iv, 12, 'v1 manifest IV');
    decodeBase64Strict(envelope?.manifest?.data, null, 'v1 manifest data');
    return envelope;
}

export function decryptManifestV1(envelope, passphrase) {
    validateEnvelopeV1(envelope);
    validatePassphrase(passphrase);
    const key = pbkdf2Sync(
        Buffer.from(passphrase, 'utf8'),
        decodeBase64Strict(envelope.crypto.kdf.salt, 32, 'v1 kdf salt'),
        envelope.crypto.kdf.iterations,
        32,
        'sha256'
    );
    let plaintext;
    try {
        plaintext = decryptAesGcm(
            key,
            decodeBase64Strict(envelope.manifest.iv, 12, 'v1 manifest IV'),
            decodeBase64Strict(envelope.manifest.data, null, 'v1 manifest data'),
            Buffer.from(V1_MANIFEST_AAD, 'utf8')
        );
    } catch {
        throw new WrongPasswordError();
    }
    let manifest;
    try {
        manifest = JSON.parse(plaintext.toString('utf8'));
    } catch {
        throw new VaultFormatError('Decrypted v1 manifest is not valid JSON.');
    }
    if (
        !manifest ||
        manifest.version !== 1 ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > MAX_MANIFEST_FILES
    ) {
        throw new VaultFormatError('Invalid v1 manifest.');
    }
    const ids = new Set();
    for (const [index, file] of manifest.files.entries()) {
        validateV1File(file, index);
        if (ids.has(file.id)) {
            throw new VaultFormatError('Duplicate v1 file id.');
        }
        ids.add(file.id);
    }
    return { manifest, key };
}

export function decryptFileV1(file, encrypted, key) {
    validateV1File(file, 0);
    const padded = decryptAesGcm(
        key,
        decodeBase64Strict(file.iv, 12, 'v1 file IV'),
        Buffer.from(encrypted),
        Buffer.from(`print-drive:file:${file.id}:v1`, 'utf8')
    );
    if (file.size > padded.byteLength) {
        throw new VaultFormatError(`v1 file size exceeds decrypted data for ${file.path}.`);
    }
    const plaintext = padded.subarray(0, file.size);
    if (sha256Hex(plaintext) !== file.sha256) {
        throw new VaultFormatError(`v1 plaintext hash mismatch for ${file.path}.`);
    }
    return Buffer.from(plaintext);
}

export function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

export function base64UrlDecodeStrict(value, expectedLength = null, label = 'base64url value') {
    if (typeof value !== 'string' || !BASE64URL_RE.test(value)) {
        throw new VaultFormatError(`${label} is not canonical base64url.`);
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
        throw new VaultFormatError(`${label} is not canonical base64url.`);
    }
    if (expectedLength !== null && decoded.byteLength !== expectedLength) {
        throw new VaultFormatError(`${label} must decode to ${expectedLength} bytes.`);
    }
    return decoded;
}

export function randomHex(byteLength) {
    return randomBytes(byteLength).toString('hex');
}

export function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function addRandomPadding(value, blockSize) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    validatePaddingBlockSize(blockSize);
    if (!blockSize || bytes.byteLength % blockSize === 0) {
        return bytes;
    }
    return Buffer.concat([
        bytes,
        randomBytes(blockSize - (bytes.byteLength % blockSize))
    ]);
}

export function compareUnicode(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalFileNameKey(value) {
    return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function validateCryptoDescriptor(crypto) {
    assertPlainObject(crypto, 'crypto');
    assertExactKeys(crypto, ['hkdf', 'cipher', 'padding'], 'crypto');
    assertExactObject(crypto.hkdf, { name: 'HKDF', hash: 'SHA-256' }, 'crypto.hkdf');
    assertExactObject(crypto.cipher, {
        name: 'AES-GCM',
        keyLength: 256,
        ivLength: 12,
        tagLength: 128
    }, 'crypto.cipher');
    assertPlainObject(crypto.padding, 'crypto.padding');
    assertExactKeys(crypto.padding, ['blockSize'], 'crypto.padding');
    validatePaddingBlockSize(crypto.padding.blockSize);
}

function validatePaddingBlockSize(value) {
    if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 1024 * 1024 ||
        (value !== 0 && (value < 1024 || (value & (value - 1)) !== 0))
    ) {
        throw new VaultFormatError('Padding block size must be 0 or a power of two from 1024 through 1048576.');
    }
}

function validateKeySlot(slot, label) {
    assertPlainObject(slot, label);
    assertExactKeys(slot, ['id', 'kdf', 'wrappedVaultKey'], label);
    validateId(slot.id, `${label}.id`);
    validateKdf(slot.kdf, `${label}.kdf`);
    validateWrappedKey(slot.wrappedVaultKey, `${label}.wrappedVaultKey`);
}

function validateKdf(kdf, label) {
    assertPlainObject(kdf, label);
    assertExactKeys(kdf, ['name', 'hash', 'iterations', 'salt'], label);
    if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
        throw new VaultFormatError(`${label} uses an unsupported KDF.`);
    }
    if (
        !Number.isSafeInteger(kdf.iterations) ||
        kdf.iterations < MIN_ITERATIONS ||
        kdf.iterations > MAX_ITERATIONS
    ) {
        throw new VaultFormatError(`${label}.iterations is outside the supported range.`);
    }
    base64UrlDecodeStrict(kdf.salt, 32, `${label}.salt`);
}

function validateWrappedKey(wrapped, label) {
    assertPlainObject(wrapped, label);
    assertExactKeys(wrapped, ['name', 'iv', 'data'], label);
    if (wrapped.name !== 'AES-GCM') {
        throw new VaultFormatError(`${label} uses an unsupported cipher.`);
    }
    base64UrlDecodeStrict(wrapped.iv, 12, `${label}.iv`);
    base64UrlDecodeStrict(wrapped.data, 48, `${label}.data`);
}

function validateObjectIndex(index) {
    assertPlainObject(index, 'objectIndex');
    assertExactKeys(index, ['version', 'objects'], 'objectIndex');
    if (index.version !== OBJECT_INDEX_VERSION || !Array.isArray(index.objects)) {
        throw new VaultFormatError('Unsupported objectIndex.');
    }
    if (index.objects.length > MAX_MANIFEST_FILES) {
        throw new VaultFormatError('objectIndex contains too many objects.');
    }
    const ids = new Set();
    let previousPath = null;
    for (const [indexNumber, object] of index.objects.entries()) {
        const label = `objectIndex.objects[${indexNumber}]`;
        assertPlainObject(object, label);
        assertExactKeys(object, ['blobId', 'path', 'encryptedSize', 'ciphertextSha256'], label);
        validateId(object.blobId, `${label}.blobId`);
        if (object.path !== `files/${object.blobId}.bin`) {
            throw new VaultFormatError(`${label}.path is not derived from blobId.`);
        }
        validateSize(object.encryptedSize, `${label}.encryptedSize`, 16);
        validateSha256(object.ciphertextSha256, `${label}.ciphertextSha256`);
        if (ids.has(object.blobId)) {
            throw new VaultFormatError('Duplicate blob in objectIndex.');
        }
        if (previousPath !== null && compareUnicode(previousPath, object.path) >= 0) {
            throw new VaultFormatError('objectIndex is not uniquely sorted by path.');
        }
        ids.add(object.blobId);
        previousPath = object.path;
    }
}

function validateManifestDescriptor(manifest) {
    assertPlainObject(manifest, 'manifest');
    assertExactKeys(manifest, ['schema', 'id', 'revision', 'iv', 'data'], 'manifest');
    if (manifest.schema !== MANIFEST_SCHEMA) {
        throw new VaultFormatError('Unsupported manifest schema.');
    }
    validateId(manifest.id, 'manifest.id');
    validateRevision(manifest.revision, 'manifest.revision');
    base64UrlDecodeStrict(manifest.iv, 12, 'manifest.iv');
    const encrypted = base64UrlDecodeStrict(manifest.data, null, 'manifest.data');
    if (encrypted.byteLength < 16 || encrypted.byteLength > MAX_MANIFEST_CIPHERTEXT_BYTES) {
        throw new VaultFormatError('manifest.data has an invalid size.');
    }
}

function validateManifestFile(file, blockSize, index) {
    const label = `manifest.files[${index}]`;
    assertPlainObject(file, label);
    assertExactKeys(file, [
        'logicalId',
        'blobId',
        'path',
        'name',
        'size',
        'paddedSize',
        'encryptedSize',
        'sha256',
        'ciphertextSha256',
        'modifiedAt',
        'dataIv',
        'wrappedDek'
    ], label);
    validateId(file.logicalId, `${label}.logicalId`);
    validateId(file.blobId, `${label}.blobId`);
    if (file.path !== `files/${file.blobId}.bin`) {
        throw new VaultFormatError(`${label}.path is not derived from blobId.`);
    }
    validateFileName(file.name, `${label}.name`);
    validateSize(file.size, `${label}.size`, 0);
    validateSize(file.paddedSize, `${label}.paddedSize`, 0);
    validateSize(file.encryptedSize, `${label}.encryptedSize`, 16);
    if (file.paddedSize < file.size || file.encryptedSize !== file.paddedSize + 16) {
        throw new VaultFormatError(`${label} has inconsistent sizes.`);
    }
    if (blockSize && file.paddedSize % blockSize !== 0) {
        throw new VaultFormatError(`${label}.paddedSize is not aligned to the configured block size.`);
    }
    validateSha256(file.sha256, `${label}.sha256`);
    validateSha256(file.ciphertextSha256, `${label}.ciphertextSha256`);
    validateIsoDate(file.modifiedAt, `${label}.modifiedAt`);
    base64UrlDecodeStrict(file.dataIv, 12, `${label}.dataIv`);
    validateWrappedKey(file.wrappedDek, `${label}.wrappedDek`);
}

function validateV1File(file, index) {
    const label = `v1 manifest.files[${index}]`;
    assertPlainObject(file, label);
    validateId(file.id, `${label}.id`);
    validateFileName(file.name, `${label}.name`, false);
    validateSize(file.size, `${label}.size`, 0);
    if (file.path !== `files/${file.id}.bin`) {
        throw new VaultFormatError(`${label}.path is invalid.`);
    }
    decodeBase64Strict(file.iv, 12, `${label}.iv`);
    validateSha256(file.sha256, `${label}.sha256`);
    if (file.modifiedAt !== undefined) {
        validateIsoDate(file.modifiedAt, `${label}.modifiedAt`);
    }
}

function validateFileName(value, label, requireNfc = true) {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        Array.from(value).length > 255 ||
        value === '.' ||
        value === '..' ||
        /[\u0000-\u001f\u007f/\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value) ||
        (requireNfc && value.normalize('NFC') !== value)
    ) {
        throw new VaultFormatError(`${label} is not a safe canonical filename.`);
    }
}

function validateId(value, label) {
    if (typeof value !== 'string' || !HEX_128_RE.test(value)) {
        throw new VaultFormatError(`${label} must be 16 bytes encoded as lowercase hex.`);
    }
}

function validateSha256(value, label) {
    if (typeof value !== 'string' || !SHA256_RE.test(value)) {
        throw new VaultFormatError(`${label} must be a lowercase SHA-256 hex digest.`);
    }
}

function validateRevision(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new VaultFormatError(`${label} must be a positive safe integer.`);
    }
}

function validateSize(value, label, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > MAX_FILE_BYTES + 1024 * 1024 + 16) {
        throw new VaultFormatError(`${label} is outside the supported range.`);
    }
}

function validateIsoDate(value, label) {
    if (
        typeof value !== 'string' ||
        value.length > 32 ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value
    ) {
        throw new VaultFormatError(`${label} must be a canonical ISO-8601 timestamp.`);
    }
}

function validatePassphrase(value) {
    if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > MAX_TEXT_FIELD) {
        throw new VaultFormatError('Passphrase must contain between 1 and 1024 Unicode characters.');
    }
}

function asFixedBuffer(value, expectedLength, label) {
    const buffer = Buffer.from(value);
    if (buffer.byteLength !== expectedLength) {
        throw new VaultFormatError(`${label} must contain ${expectedLength} bytes.`);
    }
    return buffer;
}

function hexToBytesStrict(value, expectedLength, label) {
    if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || value.length !== expectedLength * 2) {
        throw new VaultFormatError(`${label} is not canonical lowercase hex.`);
    }
    return Buffer.from(value, 'hex');
}

function decodeBase64Strict(value, expectedLength, label) {
    if (typeof value !== 'string' || !BASE64_RE.test(value)) {
        throw new VaultFormatError(`${label} is not canonical base64.`);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) {
        throw new VaultFormatError(`${label} is not canonical base64.`);
    }
    if (expectedLength !== null && decoded.byteLength !== expectedLength) {
        throw new VaultFormatError(`${label} must decode to ${expectedLength} bytes.`);
    }
    return decoded;
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new VaultFormatError(`${label} must be a plain object.`);
    }
}

function assertExactKeys(value, expectedKeys, label) {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new VaultFormatError(`${label} contains missing or unknown fields.`);
    }
}

function assertExactObject(value, expected, label) {
    assertPlainObject(value, label);
    assertExactKeys(value, Object.keys(expected), label);
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (value[key] !== expectedValue) {
            throw new VaultFormatError(`${label}.${key} is unsupported.`);
        }
    }
}
