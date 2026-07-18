#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { main as encryptMain } from '../encrypt_files.mjs';
import { rotatePassword } from '../set_password.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_PASSWORD = 'benchmark-old-password-2026-strong';
const NEW_PASSWORD = 'benchmark-new-password-2026-strong';
const FULL = process.argv.includes('--full');

await mkdir(path.join(REPO_ROOT, '.tmp'), { recursive: true });
const benchmarkRoot = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'benchmark-v2-'));
const previousPassphrase = process.env.PRINT_DRIVE_PASSPHRASE;
const results = [];

try {
    process.env.PRINT_DRIVE_PASSPHRASE = OLD_PASSWORD;
    const fixture = await createFixture(path.join(benchmarkRoot, 'incremental'));
    for (let index = 0; index < 100; index += 1) {
        await writeFile(path.join(fixture.sourceDir, `file-${String(index).padStart(3, '0')}.txt`),
            Buffer.alloc(4096 + index, index));
    }

    await measure('initial-100', fixture, () => runEncrypt(fixture, true));
    await measure('no-op-100', fixture, () => runEncrypt(fixture));
    await writeFile(path.join(fixture.sourceDir, 'file-042.txt'), Buffer.alloc(8192, 0x42));
    await measure('modify-1-of-100', fixture, () => runEncrypt(fixture));
    await writeFile(path.join(fixture.sourceDir, 'file-100.txt'), Buffer.alloc(5000, 0x64));
    await measure('add-1', fixture, () => runEncrypt(fixture));
    await rm(path.join(fixture.sourceDir, 'file-007.txt'));
    await measure('delete-1', fixture, () => runEncrypt(fixture));
    await rename(path.join(fixture.sourceDir, 'file-008.txt'), path.join(fixture.sourceDir, 'renamed-008.txt'));
    await measure('rename-1', fixture, () => runEncrypt(fixture));
    await measure('password-rotation', fixture, async () => {
        await rotatePassword({
            outputDir: fixture.outputDir,
            passwordFile: fixture.passwordFile,
            currentPassword: OLD_PASSWORD,
            newPassword: NEW_PASSWORD,
            iterations: 200_000
        });
        process.env.PRINT_DRIVE_PASSPHRASE = NEW_PASSWORD;
    });

    if (FULL) {
        process.env.PRINT_DRIVE_PASSPHRASE = OLD_PASSWORD;
        const largeFixture = await createFixture(path.join(benchmarkRoot, 'large'));
        await writeSizedFile(path.join(largeFixture.sourceDir, 'large-101MiB.bin'), 101 * 1024 * 1024, 0xa5);
        await measure('initial-101MiB', largeFixture, () => runEncrypt(largeFixture, true));
        await measure('no-op-101MiB', largeFixture, () => runEncrypt(largeFixture));
    }

    printResults(results, FULL);
} finally {
    if (previousPassphrase === undefined) {
        delete process.env.PRINT_DRIVE_PASSPHRASE;
    } else {
        process.env.PRINT_DRIVE_PASSPHRASE = previousPassphrase;
    }
    await rm(benchmarkRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function createFixture(root) {
    const fixture = {
        root,
        sourceDir: path.join(root, 'private_files'),
        outputDir: path.join(root, 'files'),
        passwordFile: path.join(root, 'fixture-passphrase')
    };
    await mkdir(fixture.sourceDir, { recursive: true });
    await mkdir(fixture.outputDir, { recursive: true });
    await writeFile(path.join(fixture.outputDir, '.gitkeep'), '');
    return fixture;
}

async function writeSizedFile(filePath, size, fillByte) {
    const handle = await open(filePath, 'w');
    const chunk = Buffer.alloc(Math.min(size, 1024 * 1024), fillByte);
    let remaining = size;
    try {
        while (remaining > 0) {
            const length = Math.min(remaining, chunk.byteLength);
            await handle.write(chunk, 0, length);
            remaining -= length;
        }
        await handle.sync();
    } finally {
        chunk.fill(0);
        await handle.close();
    }
}

async function runEncrypt(fixture, initial = false) {
    const args = [
        '--source', fixture.sourceDir,
        '--out', fixture.outputDir,
        '--password-file', fixture.passwordFile
    ];
    if (initial) {
        args.push('--iterations', '200000', '--padding-bytes', '0');
    }
    await encryptMain(args);
}

async function measure(name, fixture, operation) {
    const before = await snapshot(fixture.outputDir);
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();
    await operation();
    const elapsedMs = performance.now() - startedAt;
    const rssAfter = process.memoryUsage().rss;
    const after = await snapshot(fixture.outputDir);
    const changed = diffSnapshots(before, after);
    results.push({
        name,
        elapsedMs: Math.round(elapsedMs * 10) / 10,
        changedBlobs: changed.changedBlobs,
        removedBlobs: changed.removedBlobs,
        envelopeChanged: changed.envelopeChanged,
        gitChangeBytesProxy: changed.transferBytes,
        expectedUploadBytes: changed.transferBytes,
        rssBefore,
        rssAfter,
        processHighWaterRssKiB: process.resourceUsage().maxRSS,
        outputBytes: after.totalBytes
    });
}

async function snapshot(outputDir) {
    const files = await readdir(outputDir);
    const blobs = new Map();
    let totalBytes = 0;
    for (const name of files) {
        const fullPath = path.join(outputDir, name);
        const info = await stat(fullPath);
        if (!info.isFile()) continue;
        totalBytes += info.size;
        if (/^[0-9a-f]{32}\.bin$/.test(name)) {
            blobs.set(name, { size: info.size, hash: await sha256(fullPath) });
        }
    }
    const manifestPath = path.join(outputDir, 'manifest.enc');
    let manifest = null;
    try {
        const bytes = await readFile(manifestPath);
        manifest = { size: bytes.byteLength, hash: createHash('sha256').update(bytes).digest('hex') };
    } catch {
        // Initial snapshot has no manifest.
    }
    return { blobs, manifest, totalBytes };
}

function diffSnapshots(before, after) {
    let changedBlobs = 0;
    let removedBlobs = 0;
    let transferBytes = 0;
    for (const [name, value] of after.blobs) {
        const old = before.blobs.get(name);
        if (!old || old.hash !== value.hash) {
            changedBlobs += 1;
            transferBytes += value.size;
        }
    }
    for (const name of before.blobs.keys()) {
        if (!after.blobs.has(name)) removedBlobs += 1;
    }
    const envelopeChanged = before.manifest?.hash !== after.manifest?.hash;
    if (envelopeChanged && after.manifest) transferBytes += after.manifest.size;
    return { changedBlobs, removedBlobs, envelopeChanged, transferBytes };
}

async function sha256(filePath) {
    const handle = await open(filePath, 'r');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    try {
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
            if (bytesRead === 0) break;
            hash.update(chunk.subarray(0, bytesRead));
        }
        return hash.digest('hex');
    } finally {
        chunk.fill(0);
        await handle.close();
    }
}

function printResults(rows, full) {
    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        mode: full ? 'full' : 'quick',
        note: 'gitChangeBytesProxy/expectedUploadBytes count changed manifest.enc envelope plus new/changed immutable blobs; Git pack compression is not modeled. processHighWaterRssKiB is cumulative for the process, so use the maximum as the run peak rather than treating each row as an isolated peak.',
        rows
    }, null, 2));
    console.log('\n| scenario | ms | new/changed blobs | removed blobs | manifest.enc | transfer proxy | RSS after |');
    console.log('|---|---:|---:|---:|---|---:|---:|');
    rows.forEach((row) => {
        console.log(`| ${row.name} | ${row.elapsedMs} | ${row.changedBlobs} | ${row.removedBlobs} | ${row.envelopeChanged ? 'changed' : 'same'} | ${row.expectedUploadBytes} | ${row.rssAfter} |`);
    });
}
