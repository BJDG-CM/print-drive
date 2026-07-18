import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { main as encryptMain } from '../encrypt_files.mjs';
import { decryptManifestV2, parseEnvelopeText, unlockVaultKey } from '../vault_format.mjs';

const PASSWORD = 'source-policy-test-password-2026';

test('writer accepts edge-case filenames and excludes hidden, incomplete, and symlink sources', async () => {
    const fixture = await createFixture('source-policy-');
    const previous = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_PASSPHRASE = PASSWORD;
    try {
        await writeFile(path.join(fixture.source, '빈 파일'), Buffer.alloc(0));
        await writeFile(path.join(fixture.source, `한글😀-${'가'.repeat(80)}.txt`), 'unicode');
        await writeFile(path.join(fixture.source, 'extensionless'), 'no extension');
        await writeFile(path.join(fixture.source, '.hidden.txt'), 'hidden');
        await writeFile(path.join(fixture.source, 'draft.partial'), 'partial');
        await writeFile(path.join(fixture.source, '~scratch.txt'), 'temporary');
        const symlinkTarget = path.join(fixture.root, 'outside.txt');
        await writeFile(symlinkTarget, 'outside');
        try {
            await symlink(symlinkTarget, path.join(fixture.source, 'linked.txt'), 'file');
        } catch (error) {
            if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
        }

        await runEncrypt(fixture);
        const envelope = parseEnvelopeText(await readFile(path.join(fixture.output, 'manifest.enc'), 'utf8'));
        const { vaultKey } = unlockVaultKey(envelope, PASSWORD);
        const manifest = decryptManifestV2(envelope, vaultKey);
        assert.deepEqual(
            manifest.files.map((file) => file.name).sort(),
            ['extensionless', '빈 파일', `한글😀-${'가'.repeat(80)}.txt`].sort()
        );
        assert.equal(manifest.files.find((file) => file.name === '빈 파일').size, 0);
    } finally {
        restorePassphrase(previous);
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('writer rejects distinct source names that collide after NFC normalization when the filesystem supports both', async (context) => {
    const fixture = await createFixture('source-nfc-');
    const previous = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_PASSPHRASE = PASSWORD;
    try {
        await writeFile(path.join(fixture.source, 'é.txt'), 'nfc');
        await writeFile(path.join(fixture.source, 'e\u0301.txt'), 'nfd');
        const names = await readdir(fixture.source);
        if (names.length !== 2) {
            context.skip('Filesystem normalizes canonically equivalent filenames.');
            return;
        }
        await assert.rejects(() => runEncrypt(fixture), /Duplicate filename after NFC normalization/);
    } finally {
        restorePassphrase(previous);
        await rm(fixture.root, { recursive: true, force: true });
    }
});

async function createFixture(prefix) {
    const tempParent = path.join(process.cwd(), '.tmp');
    await mkdir(tempParent, { recursive: true });
    const root = await mkdtemp(path.join(tempParent, prefix));
    const source = path.join(root, 'private_files');
    const output = path.join(root, 'files');
    await Promise.all([mkdir(source), mkdir(output)]);
    await writeFile(path.join(output, '.gitkeep'), '');
    return { root, source, output, passwordFile: path.join(root, 'fixture-passphrase') };
}

async function runEncrypt(fixture) {
    await encryptMain([
        '--source', fixture.source,
        '--out', fixture.output,
        '--password-file', fixture.passwordFile,
        '--iterations', '200000',
        '--padding-bytes', '0'
    ]);
}

function restorePassphrase(previous) {
    if (previous === undefined) delete process.env.PRINT_DRIVE_PASSPHRASE;
    else process.env.PRINT_DRIVE_PASSPHRASE = previous;
}
