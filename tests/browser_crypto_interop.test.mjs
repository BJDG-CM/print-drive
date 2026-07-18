import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}
if (!globalThis.location) {
    globalThis.location = new URL('https://example.test/print-drive/');
}

import {
    createObjectIndex as createNodeObjectIndex,
    createCryptoDescriptor,
    createEncryptedManifest as createNodeEncryptedManifest,
    createFileAad as createNodeFileAad,
    createPasswordKeySlot,
    decryptFileV2 as decryptNodeFile,
    decryptManifestV2 as decryptNodeManifest,
    deriveVaultSubkeys as deriveNodeSubkeys,
    encryptAesGcm as encryptNodeAesGcm,
    sha256Hex as nodeSha256Hex,
    wrapDek as wrapNodeDek
} from '../vault_format.mjs';
import {
    decryptManifest as decryptBrowserManifest,
    encryptBrowserFileV2,
    encryptManifestV2 as encryptBrowserManifest,
    fetchAndDecryptFile,
    readResponseBytesBounded,
    unlockVault
} from '../crypto.js';

const PASSWORD = 'browser-node-interop-password';
const VAULT_ID = '10'.repeat(16);
const LOGICAL_ID = '20'.repeat(16);
const BLOB_ID = '30'.repeat(16);
const MANIFEST_ID = '40'.repeat(16);
const PLAINTEXT = Buffer.from('Print Drive v2 browser interoperability\n', 'utf8');
const VAULT_KEY = Buffer.alloc(32, 0x51);
const DEK = Buffer.alloc(32, 0x61);
const DATA_IV = Buffer.alloc(12, 0x71);
const WRAP_IV = Buffer.alloc(12, 0x72);
const MANIFEST_IV = Buffer.alloc(12, 0x73);

function createNodeFixture() {
    const sha256 = nodeSha256Hex(PLAINTEXT);
    const descriptor = {
        logicalId: LOGICAL_ID,
        blobId: BLOB_ID,
        size: PLAINTEXT.byteLength,
        paddedSize: PLAINTEXT.byteLength,
        sha256
    };
    const encrypted = encryptNodeAesGcm(
        DEK,
        DATA_IV,
        PLAINTEXT,
        createNodeFileAad(VAULT_ID, descriptor)
    );
    const { dekWrapKey } = deriveNodeSubkeys(VAULT_KEY, VAULT_ID);
    const file = {
        ...descriptor,
        path: `files/${BLOB_ID}.bin`,
        name: '상호운용.pdf',
        encryptedSize: encrypted.byteLength,
        ciphertextSha256: nodeSha256Hex(encrypted),
        modifiedAt: '2026-07-18T00:00:00.000Z',
        dataIv: DATA_IV.toString('base64url'),
        wrappedDek: wrapNodeDek(DEK, dekWrapKey, VAULT_ID, LOGICAL_ID, BLOB_ID, { iv: WRAP_IV })
    };
    const manifest = {
        version: 2,
        vaultId: VAULT_ID,
        id: MANIFEST_ID,
        revision: 1,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        files: [file]
    };
    const encryptedManifest = createNodeEncryptedManifest(manifest, VAULT_KEY, VAULT_ID, {
        id: MANIFEST_ID,
        revision: 1,
        iv: MANIFEST_IV
    });
    const envelope = {
        version: 2,
        app: 'print-drive',
        vaultId: VAULT_ID,
        keySlots: [createPasswordKeySlot(PASSWORD, VAULT_KEY, VAULT_ID, {
            id: '50'.repeat(16),
            iterations: 200_000,
            salt: Buffer.alloc(32, 0x52),
            iv: Buffer.alloc(12, 0x53)
        })],
        crypto: createCryptoDescriptor(0),
        objectIndex: createNodeObjectIndex([file]),
        manifest: encryptedManifest.descriptor
    };
    return { envelope, manifest, file, encrypted };
}

test('browser unlocks and decrypts a Node-created v2 vault and file', async () => {
    const fixture = createNodeFixture();
    const context = await unlockVault(PASSWORD, fixture.envelope);
    const manifest = await decryptBrowserManifest(fixture.envelope, context);
    assert.deepEqual(manifest, fixture.manifest);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(fixture.encrypted, {
        status: 200,
        headers: { 'content-length': String(fixture.encrypted.byteLength) }
    });
    try {
        const decrypted = await fetchAndDecryptFile(fixture.file, context);
        assert.deepEqual(Buffer.from(decrypted.bytes), PLAINTEXT);
    } finally {
        globalThis.fetch = originalFetch;
        context.rawKeyBytes.fill(0);
    }
});

test('browser rejects a wrong v2 password', async () => {
    const { envelope } = createNodeFixture();
    await assert.rejects(
        () => unlockVault('definitely-wrong-password', envelope),
        (error) => error.code === 'INVALID_PASSWORD'
    );
});

test('browser accepts a valid encrypted response without Content-Length', async () => {
    const fixture = createNodeFixture();
    const context = await unlockVault(PASSWORD, fixture.envelope);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(fixture.encrypted, { status: 200 });
    try {
        const decrypted = await fetchAndDecryptFile(fixture.file, context);
        assert.deepEqual(Buffer.from(decrypted.bytes), PLAINTEXT);
    } finally {
        globalThis.fetch = originalFetch;
        context.rawKeyBytes.fill(0);
    }
});

test('bounded response reader cancels a headerless stream as soon as the limit is exceeded', async () => {
    let cancelled = false;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.enqueue(new Uint8Array(8));
        },
        cancel() {
            cancelled = true;
        }
    });
    const response = new Response(body, { status: 200 });
    await assert.rejects(
        () => readResponseBytesBounded(response, 12, {
            errorCode: 'INTEGRITY_FAILED',
            errorMessage: 'bounded test'
        }),
        (error) => error.code === 'INTEGRITY_FAILED'
    );
    assert.equal(cancelled, true);
});

test('Node decrypts browser-created v2 blob and manifest', async () => {
    const fixture = createNodeFixture();
    const context = await unlockVault(PASSWORD, fixture.envelope);
    const logicalId = '60'.repeat(16);
    const blobId = '70'.repeat(16);
    const descriptor = {
        vaultId: VAULT_ID,
        logicalId,
        blobId,
        name: '브라우저 생성.txt',
        size: PLAINTEXT.byteLength,
        paddedSize: PLAINTEXT.byteLength,
        sha256: nodeSha256Hex(PLAINTEXT)
    };
    const browserFile = await encryptBrowserFileV2(descriptor, PLAINTEXT, context);
    const file = {
        logicalId,
        blobId,
        path: `files/${blobId}.bin`,
        name: descriptor.name,
        size: descriptor.size,
        paddedSize: descriptor.paddedSize,
        encryptedSize: browserFile.encryptedBytes.byteLength,
        sha256: descriptor.sha256,
        ciphertextSha256: browserFile.ciphertextSha256,
        modifiedAt: '2026-07-18T01:00:00.000Z',
        dataIv: browserFile.dataIv,
        wrappedDek: browserFile.wrappedDek
    };
    assert.deepEqual(
        decryptNodeFile(file, browserFile.encryptedBytes, VAULT_KEY, VAULT_ID),
        PLAINTEXT
    );

    const manifest = {
        version: 2,
        vaultId: VAULT_ID,
        id: MANIFEST_ID,
        revision: 2,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T01:00:00.000Z',
        files: [file]
    };
    const envelope = await encryptBrowserManifest(fixture.envelope, manifest, context);
    assert.deepEqual(decryptNodeManifest(envelope, VAULT_KEY), manifest);
    context.rawKeyBytes.fill(0);
});
