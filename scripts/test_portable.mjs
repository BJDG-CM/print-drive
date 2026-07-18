#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARCHIVE = path.join(ROOT, 'artifacts', 'PrintDrive-Portable-windows-x64.zip');

export async function testPortable() {
    const archive = await readFile(ARCHIVE);
    const archiveStat = await stat(ARCHIVE);
    if (archiveStat.size < 1024 * 1024) throw new Error('Portable archive is unexpectedly small.');
    const text = archive.toString('latin1');
    for (const forbidden of ['github_pat_example', 'ghp_example', 'portable-test-password']) {
        if (text.includes(forbidden)) throw new Error(`Portable archive contains forbidden fixture material: ${forbidden}`);
    }
    const temporaryExecutable = path.join(ROOT, '.tmp', 'portable-native-smoke.exe');
    const executable = extractStoredZipEntry(archive, 'PrintDrive-Portable/PrintDriveUpdater.exe');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(temporaryExecutable, executable));
    try {
        const result = spawnSync(temporaryExecutable, ['--smoke-test'], {
            cwd: path.dirname(temporaryExecutable),
            encoding: 'utf8',
            windowsHide: true,
            env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: '' }
        });
        if (result.error || result.status !== 0) throw new Error(`Native portable smoke failed: ${result.stderr || result.error?.message}`);
        const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
        if (!value.started || !value.bundledAssets || !value.cryptoCycle || value.systemNodeRequired || value.systemGitRequired || value.pythonRequired) {
            throw new Error('Native portable smoke result is incomplete.');
        }
    } finally {
        await import('node:fs/promises').then(({ rm }) => rm(temporaryExecutable, { force: true }));
    }
    console.log(`Portable native smoke passed (${archiveStat.size} bytes).`);
    return { archive: ARCHIVE, size: archiveStat.size };
}

function extractStoredZipEntry(bytes, expectedName) {
    let offset = 0;
    while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
        const nameLength = bytes.readUInt16LE(offset + 26);
        const extraLength = bytes.readUInt16LE(offset + 28);
        const size = bytes.readUInt32LE(offset + 18);
        const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
        const dataStart = offset + 30 + nameLength + extraLength;
        if (name === expectedName) return bytes.subarray(dataStart, dataStart + size);
        offset = dataStart + size;
    }
    throw new Error(`ZIP entry not found: ${expectedName}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    testPortable().catch((error) => { console.error(error.message); process.exit(1); });
}
