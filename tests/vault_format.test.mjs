import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
    APP_ID,
    FORMAT_VERSION,
    HKDF_DEK_WRAP_INFO,
    HKDF_MANIFEST_INFO,
    WrongPasswordError,
    base64UrlDecodeStrict,
    base64UrlEncode,
    canonicalAad,
    createCryptoDescriptor,
    createDekAad,
    createEncryptedManifest,
    createFileAad,
    createManifestAad,
    createObjectIndex,
    createPasswordKeySlot,
    createVaultKeyAad,
    decryptFileV2,
    decryptManifestV2,
    deriveVaultSubkeys,
    encryptAesGcm,
    sha256Hex,
    unlockVaultKey,
    validateEnvelopeV2,
    validateManifestV2,
    wrapDek
} from '../vault_format.mjs';

const PASSWORD = 'fixture-password-2026';
const VAULT_ID = '00112233445566778899aabbccddeeff';
const LOGICAL_ID = '11112222333344445555666677778888';
const BLOB_ID = '22223333444455556666777788889999';
const MANIFEST_ID = '3333444455556666777788889999aaaa';
const SLOT_ID = '444455556666777788889999aaaabbbb';
const NOW = '2026-07-18T00:00:00.000Z';

test('v2 deterministic contract round-trips and exports browser contract values', () => {
    const vector = makeVector();
    validateEnvelopeV2(vector.envelope);
    assert.deepEqual(unlockVaultKey(vector.envelope, PASSWORD).vaultKey, vector.vaultKey);
    assert.deepEqual(decryptManifestV2(vector.envelope, vector.vaultKey), vector.manifest);
    assert.deepEqual(
        decryptFileV2(vector.file, vector.encrypted, vector.vaultKey, VAULT_ID),
        vector.plaintext
    );

    assert.equal(HKDF_MANIFEST_INFO, 'print-drive:v2:manifest-key');
    assert.equal(HKDF_DEK_WRAP_INFO, 'print-drive:v2:dek-wrap-key');
    assert.equal(
        createVaultKeyAad(VAULT_ID, vector.envelope.keySlots[0]).toString('utf8'),
        JSON.stringify([
            APP_ID, FORMAT_VERSION, 'vault-key', VAULT_ID, SLOT_ID,
            'PBKDF2', 'SHA-256', 200000, base64UrlEncode(Buffer.alloc(32, 2))
        ])
    );
    assert.equal(
        createManifestAad(VAULT_ID, vector.envelope.manifest).toString('utf8'),
        JSON.stringify([APP_ID, FORMAT_VERSION, 'manifest', VAULT_ID, MANIFEST_ID, 1])
    );
    assert.equal(
        createDekAad(VAULT_ID, LOGICAL_ID, BLOB_ID).toString('utf8'),
        JSON.stringify([APP_ID, FORMAT_VERSION, 'dek', VAULT_ID, LOGICAL_ID, BLOB_ID])
    );
    assert.equal(
        createFileAad(VAULT_ID, vector.file).toString('utf8'),
        JSON.stringify([
            APP_ID, FORMAT_VERSION, 'file', VAULT_ID, LOGICAL_ID, BLOB_ID,
            vector.file.size, vector.file.paddedSize, vector.file.sha256
        ])
    );
    assert.equal(
        canonicalAad(['a', 2, 'b']).toString('utf8'),
        '["a",2,"b"]'
    );
});

test('wrong password and manifest ciphertext/tag tampering fail authentication', () => {
    const vector = makeVector();
    assert.throws(
        () => unlockVaultKey(vector.envelope, 'wrong-fixture-password'),
        WrongPasswordError
    );

    const tamperedBytes = base64UrlDecodeStrict(vector.envelope.manifest.data);
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    const tamperedEnvelope = {
        ...vector.envelope,
        manifest: {
            ...vector.envelope.manifest,
            data: base64UrlEncode(tamperedBytes)
        }
    };
    assert.throws(() => decryptManifestV2(tamperedEnvelope, vector.vaultKey));
});

test('file ciphertext, tag, AAD, and plaintext hash tampering are rejected', () => {
    const vector = makeVector();
    const changedCiphertext = Buffer.from(vector.encrypted);
    changedCiphertext[0] ^= 1;
    assert.throws(
        () => decryptFileV2(vector.file, changedCiphertext, vector.vaultKey, VAULT_ID),
        /Ciphertext hash mismatch/
    );

    const changedTag = Buffer.from(vector.encrypted);
    changedTag[changedTag.length - 1] ^= 1;
    const tagEntry = {
        ...vector.file,
        ciphertextSha256: sha256Hex(changedTag)
    };
    assert.throws(() => decryptFileV2(tagEntry, changedTag, vector.vaultKey, VAULT_ID));

    const aadEntry = {
        ...vector.file,
        size: vector.file.size - 1
    };
    assert.throws(() => decryptFileV2(aadEntry, vector.encrypted, vector.vaultKey, VAULT_ID));

    const wrongHashEntry = {
        ...vector.file,
        sha256: 'f'.repeat(64)
    };
    const wrongHashCiphertext = encryptAesGcm(
        vector.dek,
        base64UrlDecodeStrict(wrongHashEntry.dataIv),
        vector.plaintext,
        createFileAad(VAULT_ID, wrongHashEntry)
    );
    wrongHashEntry.ciphertextSha256 = sha256Hex(wrongHashCiphertext);
    assert.throws(
        () => decryptFileV2(wrongHashEntry, wrongHashCiphertext, vector.vaultKey, VAULT_ID),
        /Plaintext hash mismatch/
    );
});

test('strict validation rejects unknown schema fields, bounds, noncanonical base64url, and duplicate nonces', () => {
    const vector = makeVector();
    assert.throws(
        () => validateEnvelopeV2({ ...vector.envelope, unknown: true }),
        /missing or unknown fields/
    );
    const excessiveKdf = structuredClone(vector.envelope);
    excessiveKdf.keySlots[0].kdf.iterations = 2000001;
    assert.throws(() => validateEnvelopeV2(excessiveKdf), /outside the supported range/);
    assert.throws(() => base64UrlDecodeStrict('YWJj='), /canonical base64url/);

    const duplicate = {
        ...vector.file,
        logicalId: '55556666777788889999aaaabbbbcccc',
        blobId: '6666777788889999aaaabbbbccccdddd',
        path: 'files/6666777788889999aaaabbbbccccdddd.bin',
        name: 'second.txt',
        dataIv: base64UrlEncode(Buffer.alloc(12, 9))
    };
    const files = [vector.file, duplicate];
    const manifest = { ...vector.manifest, files };
    const envelope = { ...vector.envelope, objectIndex: createObjectIndex(files) };
    assert.throws(
        () => validateManifestV2(manifest, envelope),
        /Duplicate file identity, name, path, or nonce/
    );

    const caseCollision = {
        ...duplicate,
        name: 'FIXTURE.TXT',
        wrappedDek: {
            ...duplicate.wrappedDek,
            iv: base64UrlEncode(Buffer.alloc(12, 10))
        }
    };
    const caseFiles = [vector.file, caseCollision];
    const caseManifest = { ...vector.manifest, files: caseFiles };
    const caseEnvelope = { ...vector.envelope, objectIndex: createObjectIndex(caseFiles) };
    assert.throws(
        () => validateManifestV2(caseManifest, caseEnvelope),
        /Duplicate file identity, name, path, or nonce/
    );
});

function makeVector() {
    const vaultKey = Buffer.alloc(32, 1);
    const dek = Buffer.alloc(32, 5);
    const plaintext = Buffer.from('deterministic fixture\n', 'utf8');
    const slot = createPasswordKeySlot(PASSWORD, vaultKey, VAULT_ID, {
        id: SLOT_ID,
        iterations: 200000,
        salt: Buffer.alloc(32, 2),
        iv: Buffer.alloc(12, 3)
    });
    const { dekWrapKey } = deriveVaultSubkeys(vaultKey, VAULT_ID);
    const file = {
        logicalId: LOGICAL_ID,
        blobId: BLOB_ID,
        path: `files/${BLOB_ID}.bin`,
        name: 'fixture.txt',
        size: plaintext.byteLength,
        paddedSize: plaintext.byteLength,
        encryptedSize: plaintext.byteLength + 16,
        sha256: sha256Hex(plaintext),
        ciphertextSha256: '0'.repeat(64),
        modifiedAt: NOW,
        dataIv: base64UrlEncode(Buffer.alloc(12, 6)),
        wrappedDek: wrapDek(dek, dekWrapKey, VAULT_ID, LOGICAL_ID, BLOB_ID, {
            iv: Buffer.alloc(12, 7)
        })
    };
    const encrypted = encryptAesGcm(
        dek,
        base64UrlDecodeStrict(file.dataIv),
        plaintext,
        createFileAad(VAULT_ID, file)
    );
    file.ciphertextSha256 = sha256Hex(encrypted);
    const manifestBase = {
        version: FORMAT_VERSION,
        vaultId: VAULT_ID,
        id: MANIFEST_ID,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        files: [file]
    };
    const { descriptor, payload: manifest } = createEncryptedManifest(
        manifestBase,
        vaultKey,
        VAULT_ID,
        { id: MANIFEST_ID, revision: 1, iv: Buffer.alloc(12, 8) }
    );
    const envelope = {
        version: FORMAT_VERSION,
        app: APP_ID,
        vaultId: VAULT_ID,
        keySlots: [slot],
        crypto: createCryptoDescriptor(0),
        objectIndex: createObjectIndex([file]),
        manifest: descriptor
    };
    return { vaultKey, dek, plaintext, file, encrypted, manifest, envelope };
}
