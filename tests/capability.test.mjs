import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

import {
    capabilityDataKeyBytes,
    createShareCapability,
    openShareCapability
} from '../capability.js';

const NOW = Date.parse('2026-07-18T00:00:00.000Z');
const FILE = {
    vaultId: '01'.repeat(16),
    logicalId: '02'.repeat(16),
    blobId: '03'.repeat(16),
    path: `files/${'03'.repeat(16)}.bin`,
    name: '인쇄 자료.pdf',
    size: 12,
    paddedSize: 65536,
    encryptedSize: 65552,
    sha256: '04'.repeat(32),
    ciphertextSha256: '05'.repeat(32),
    dataIv: Buffer.alloc(12, 5).toString('base64'),
    modifiedAt: '2026-07-17T23:00:00.000Z'
};

test('limited share capability round-trips one file DEK without a vault key', async () => {
    const dataKey = new Uint8Array(32).fill(6);
    const url = await createShareCapability(FILE, dataKey, {
        baseUrl: 'https://example.test/print-drive/',
        now: NOW,
        expiresAt: new Date(NOW + 60_000).toISOString()
    });
    const fragment = new URL(url).hash;
    const opened = await openShareCapability(fragment, { now: NOW });

    assert.equal(opened.name, FILE.name);
    assert.deepEqual(capabilityDataKeyBytes(opened), dataKey);
    assert.equal('vaultKey' in opened, false);
    assert.equal('wrappedDek' in opened, false);
});

test('limited share capability rejects ciphertext tampering', async () => {
    const url = await createShareCapability(FILE, new Uint8Array(32).fill(7), {
        baseUrl: 'https://example.test/',
        now: NOW,
        expiresAt: new Date(NOW + 60_000).toISOString()
    });
    const fragment = new URL(url).hash;
    const last = fragment.at(-1) === 'A' ? 'B' : 'A';

    await assert.rejects(
        () => openShareCapability(`${fragment.slice(0, -1)}${last}`, { now: NOW }),
        /손상되었거나 유효하지 않습니다/
    );
});

test('limited share capability reports client-side display expiry', async () => {
    const url = await createShareCapability(FILE, new Uint8Array(32).fill(8), {
        baseUrl: 'https://example.test/',
        now: NOW,
        expiresAt: new Date(NOW + 1_000).toISOString()
    });

    await assert.rejects(
        () => openShareCapability(new URL(url).hash, { now: NOW + 2_000 }),
        (error) => error.code === 'SHARE_EXPIRED'
    );
});

test('limited share capability uses Unicode code points for the 255-character filename limit', async () => {
    const emojiFile = { ...FILE, name: `${'😀'.repeat(251)}.pdf` };
    const url = await createShareCapability(emojiFile, new Uint8Array(32).fill(9), {
        baseUrl: 'https://example.test/',
        now: NOW,
        expiresAt: new Date(NOW + 60_000).toISOString()
    });
    const opened = await openShareCapability(new URL(url).hash, { now: NOW });
    assert.equal(opened.name, emojiFile.name);
});

test('limited share capability rejects bidi-control filename spoofing', async () => {
    await assert.rejects(
        () => createShareCapability(
            { ...FILE, name: 'invoice\u202Efdp.exe' },
            new Uint8Array(32).fill(10),
            { baseUrl: 'https://example.test/', now: NOW, expiresAt: new Date(NOW + 60_000).toISOString() }
        ),
        /파일명이 올바르지 않습니다/
    );
});
