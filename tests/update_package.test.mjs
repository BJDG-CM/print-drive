import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyUpdate, dryRunUpdate } from '../scripts/apply_update.mjs';
import { createZipBlob } from '../zip.js';
import { main as encryptMain } from '../encrypt_files.mjs';
import { parseEnvelopeText } from '../vault_format.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASSWORD = 'update-package-fixture-password-2026';

test('update packages validate strictly and apply with rollback and recovery', async (t) => {
    await withFixture(async (fixture) => {
        const valid = await buildValidPackage(fixture);

        await t.test('valid dry run and apply remove stale objects and preserve unrelated files', async () => {
            const outputDir = await cloneBaseline(fixture, 'valid');
            const unrelated = path.join(fixture.root, 'unrelated.txt');
            await writeFile(unrelated, 'keep me\n');
            const plan = await dryRunUpdate(request(fixture, outputDir, valid.path));
            assert.equal(plan.additions.length, 2);
            assert.equal(plan.removals.length, 2);
            assert.equal(plan.authentication, 'passphrase-authenticated');
            await applyUpdate(request(fixture, outputDir, valid.path));
            assert.deepEqual(await publicSnapshot(outputDir), await publicSnapshot(fixture.targetDir));
            assert.equal(await readFile(unrelated, 'utf8'), 'keep me\n');
        });

        for (const [name, mutate, pattern] of [
            ['wrong vault ID', (value) => { value.vaultId = 'f'.repeat(32); }, /vaultId/i],
            ['wrong base revision', (value) => { value.baseRevision += 1; value.targetRevision += 1; }, /revision/i],
            ['skipped revision', (value) => { value.targetRevision += 1; }, /exactly baseRevision \+ 1/i],
            ['malformed metadata', (value) => { value.unexpected = true; }, /missing or unknown/i],
            ['blob size mismatch', (value) => { value.addObjects[0].encryptedSize += 1; }, /size mismatch|target object index/i],
            ['blob hash mismatch', (value) => { value.addObjects[0].ciphertextSha256 = '0'.repeat(64); }, /SHA-256 mismatch|target object index/i],
            ['add mismatch', (value) => { value.addObjects.pop(); }, /Unknown ZIP entry|entries do not exactly|addObjects/i],
            ['remove mismatch', (value) => { value.removeObjects.pop(); }, /removeObjects/i]
        ]) {
            await t.test(`rejects ${name}`, async () => {
                const metadata = structuredClone(valid.metadata);
                mutate(metadata);
                const zipPath = await writePackage(fixture, `bad-${name}.zip`, metadata, valid.manifestBytes, valid.objectEntries);
                await assert.rejects(dryRunUpdate(request(fixture, fixture.currentDir, zipPath)), pattern);
            });
        }

        await t.test('rejects unknown and unsafe ZIP entries', async () => {
            const unknownPath = await writePackage(
                fixture,
                'unknown.zip',
                valid.metadata,
                valid.manifestBytes,
                valid.objectEntries,
                [{ name: 'unexpected.txt', bytes: Buffer.from('no') }]
            );
            await assert.rejects(dryRunUpdate(request(fixture, fixture.currentDir, unknownPath)), /Unknown ZIP entry/);

            const traversalPath = path.join(fixture.root, 'traversal.zip');
            await writeFile(traversalPath, rawStoredZip([{ name: '../escape', bytes: Buffer.from('no') }]));
            await assert.rejects(dryRunUpdate(request(fixture, fixture.currentDir, traversalPath)), /Unsafe ZIP entry/);

            const duplicatePath = path.join(fixture.root, 'duplicate.zip');
            await writeFile(duplicatePath, rawStoredZip([
                { name: 'same.txt', bytes: Buffer.from('one') },
                { name: 'same.txt', bytes: Buffer.from('two') }
            ]));
            await assert.rejects(dryRunUpdate(request(fixture, fixture.currentDir, duplicatePath)), /Duplicate ZIP entry/);

            const symlinkPath = path.join(fixture.root, 'symlink.zip');
            await writeFile(symlinkPath, rawStoredZip([
                { name: 'print-drive-update.json', bytes: Buffer.from(JSON.stringify(valid.metadata)), externalAttributes: 0xa0000000 },
                { name: 'files/manifest.enc', bytes: valid.manifestBytes },
                ...valid.objectEntries
            ]));
            await assert.rejects(dryRunUpdate(request(fixture, fixture.currentDir, symlinkPath)), /symlinks are not allowed/i);
        });

        await t.test('rejects a target object-index mismatch', async () => {
            const envelope = JSON.parse(valid.manifestBytes.toString('utf8'));
            envelope.objectIndex.objects = envelope.objectIndex.objects.slice(1);
            const zipPath = await writePackage(
                fixture,
                'target-index-mismatch.zip',
                valid.metadata,
                Buffer.from(`${JSON.stringify(envelope)}\n`),
                valid.objectEntries
            );
            await assert.rejects(dryRunUpdate(request(fixture, fixture.currentDir, zipPath)), /addObjects|removeObjects|object descriptor/i);
        });

        await t.test('rejects immutable object collisions with different bytes', async () => {
            const outputDir = await cloneBaseline(fixture, 'collision');
            const object = valid.metadata.addObjects[0];
            await writeFile(path.join(outputDir, `${object.blobId}.bin`), Buffer.alloc(object.encryptedSize));
            await assert.rejects(applyUpdate(request(fixture, outputDir, valid.path)), /collision/i);
        });

        await t.test('rolls back before commit and resumes cleanup after commit', async () => {
            const beforeDir = await cloneBaseline(fixture, 'before');
            const before = await publicSnapshot(beforeDir);
            process.env.PRINT_DRIVE_UPDATE_FAILPOINT = 'before-manifest-commit';
            await assert.rejects(applyUpdate(request(fixture, beforeDir, valid.path)), /before-manifest-commit/);
            delete process.env.PRINT_DRIVE_UPDATE_FAILPOINT;
            assert.deepEqual(await publicSnapshot(beforeDir), before);

            const afterDir = await cloneBaseline(fixture, 'after');
            process.env.PRINT_DRIVE_UPDATE_FAILPOINT = 'after-manifest-commit';
            await assert.rejects(applyUpdate(request(fixture, afterDir, valid.path)), /after-manifest-commit/);
            delete process.env.PRINT_DRIVE_UPDATE_FAILPOINT;
            const committed = parseEnvelopeText(await readFile(path.join(afterDir, 'manifest.enc'), 'utf8'));
            assert.equal(committed.manifest.revision, valid.metadata.targetRevision);
            const recovery = await applyUpdate(request(fixture, afterDir, valid.path));
            assert.equal(recovery.recovery, true);
            assert.deepEqual(await publicSnapshot(afterDir), await publicSnapshot(fixture.targetDir));
        });
    });
});

async function withFixture(callback) {
    await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
    const root = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'update-package-'));
    const fixture = {
        root,
        sourceDir: path.join(root, 'source'),
        currentDir: path.join(root, 'current'),
        targetDir: path.join(root, 'target'),
        passwordFile: path.join(root, 'passphrase')
    };
    await mkdir(fixture.sourceDir);
    await mkdir(fixture.currentDir);
    await writeFile(fixture.passwordFile, `${PASSWORD}\n`);
    await writeFile(path.join(fixture.sourceDir, 'alpha.txt'), 'alpha\n');
    await writeFile(path.join(fixture.sourceDir, 'remove.txt'), 'remove\n');
    await runEncrypt(fixture.sourceDir, fixture.currentDir, fixture.passwordFile, true);
    await cp(fixture.currentDir, fixture.targetDir, { recursive: true });
    await writeFile(path.join(fixture.sourceDir, 'alpha.txt'), 'alpha changed\n');
    await unlink(path.join(fixture.sourceDir, 'remove.txt'));
    await writeFile(path.join(fixture.sourceDir, 'added.txt'), 'added\n');
    await runEncrypt(fixture.sourceDir, fixture.targetDir, fixture.passwordFile, false);
    try {
        await callback(fixture);
    } finally {
        delete process.env.PRINT_DRIVE_UPDATE_FAILPOINT;
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function runEncrypt(sourceDir, outputDir, passwordFile, initial) {
    const previous = process.env.PRINT_DRIVE_PASSPHRASE;
    process.env.PRINT_DRIVE_PASSPHRASE = PASSWORD;
    const args = ['--source', sourceDir, '--out', outputDir, '--password-file', passwordFile];
    if (initial) args.push('--iterations', '200000', '--padding-bytes', '0');
    try { await encryptMain(args); } finally {
        if (previous === undefined) delete process.env.PRINT_DRIVE_PASSPHRASE;
        else process.env.PRINT_DRIVE_PASSPHRASE = previous;
    }
}

async function buildValidPackage(fixture) {
    const currentEnvelope = parseEnvelopeText(await readFile(path.join(fixture.currentDir, 'manifest.enc'), 'utf8'));
    const manifestBytes = await readFile(path.join(fixture.targetDir, 'manifest.enc'));
    const targetEnvelope = parseEnvelopeText(manifestBytes.toString('utf8'));
    const currentIds = new Set(currentEnvelope.objectIndex.objects.map((object) => object.blobId));
    const targetIds = new Set(targetEnvelope.objectIndex.objects.map((object) => object.blobId));
    const addObjects = targetEnvelope.objectIndex.objects.filter((object) => !currentIds.has(object.blobId));
    const removeObjects = currentEnvelope.objectIndex.objects
        .filter((object) => !targetIds.has(object.blobId))
        .map((object) => object.blobId);
    const metadata = {
        version: 1,
        app: 'print-drive',
        vaultId: currentEnvelope.vaultId,
        baseRevision: currentEnvelope.manifest.revision,
        targetRevision: targetEnvelope.manifest.revision,
        addObjects,
        removeObjects,
        manifestPath: 'files/manifest.enc'
    };
    const objectEntries = await Promise.all(addObjects.map(async (object) => ({
        name: object.path,
        bytes: await readFile(path.join(fixture.targetDir, `${object.blobId}.bin`))
    })));
    const packagePath = await writePackage(fixture, 'valid.zip', metadata, manifestBytes, objectEntries);
    return { path: packagePath, metadata, manifestBytes, objectEntries };
}

async function writePackage(fixture, name, metadata, manifestBytes, objectEntries, extras = []) {
    const blob = createZipBlob([
        { name: 'print-drive-update.json', bytes: Buffer.from(`${JSON.stringify(metadata)}\n`) },
        { name: 'files/manifest.enc', bytes: manifestBytes },
        ...objectEntries,
        ...extras
    ]);
    const zipPath = path.join(fixture.root, name.replaceAll(' ', '-'));
    await writeFile(zipPath, Buffer.from(await blob.arrayBuffer()));
    return zipPath;
}

async function cloneBaseline(fixture, name) {
    const outputDir = path.join(fixture.root, `scenario-${name}`);
    await cp(fixture.currentDir, outputDir, { recursive: true });
    return outputDir;
}

function request(fixture, outputDir, zipPath) {
    return { outputDir, zipPath, passwordFile: fixture.passwordFile };
}

async function publicSnapshot(outputDir) {
    const result = new Map();
    for (const name of (await readdir(outputDir)).filter((name) => name === 'manifest.enc' || /^[0-9a-f]{32}\.bin$/.test(name)).sort()) {
        result.set(name, Buffer.from(await readFile(path.join(outputDir, name))).toString('hex'));
    }
    return result;
}

function rawStoredZip(entries) {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = Buffer.from(entry.bytes);
        const crc = crc32(data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26); local.set(name, 30);
        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
        central.writeUInt32LE(entry.externalAttributes || 0, 38);
        central.set(name, 46);
        locals.push(local, data); centrals.push(central); offset += local.length + data.length;
    }
    const centralSize = centrals.reduce((sum, value) => sum + value.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
