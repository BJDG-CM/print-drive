#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, displayPath } from '../paths.mjs';
import { inspectPublicFiles } from '../public_files_guard.mjs';
import { collectBrowserAssets, GENERATED_BROWSER_ASSETS } from './dist_contract.mjs';

const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

export async function assertDistClean(distDir = DIST_DIR, options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const browserAssets = options.expectedBrowserAssets || await collectBrowserAssets(projectRoot);
    const expectedFiles = new Set([...browserAssets, ...GENERATED_BROWSER_ASSETS]);
    const expectedDirectories = new Set(['files']);
    for (const expectedFile of expectedFiles) {
        let directory = path.posix.dirname(expectedFile);
        while (directory && directory !== '.') {
            expectedDirectories.add(directory);
            directory = path.posix.dirname(directory);
        }
    }
    const actualEntries = await walkDist(distDir);
    const violations = [];

    for (const entry of actualEntries) {
        if (entry.kind === 'directory' && expectedDirectories.has(entry.relative)) {
            continue;
        }
        if (entry.kind !== 'file') {
            violations.push(`${entry.relative} must be a regular file or required directory`);
            continue;
        }
        if (!entry.relative.startsWith('files/') && !expectedFiles.has(entry.relative)) {
            violations.push(`${entry.relative} is not an expected browser asset`);
        }
    }
    for (const required of expectedFiles) {
        if (!actualEntries.some((entry) => entry.kind === 'file' && entry.relative === required)) {
            violations.push(`${required} is missing`);
        }
    }
    if (!actualEntries.some((entry) => entry.kind === 'directory' && entry.relative === 'files')) {
        violations.push('files directory is missing');
    }
    if (violations.length > 0) {
        throw new Error(`dist structure check failed:\n${violations.map((value) => `- ${value}`).join('\n')}`);
    }

    await assertBuildIdentity(distDir);
    return inspectPublicFiles(path.join(distDir, 'files'), {
        displayDir: displayFor(projectRoot, path.join(distDir, 'files')),
        allowLegacyV1: options.allowLegacyV1 !== false,
        verifyCiphertext: true,
        rejectUnreferenced: true
    });
}

async function assertBuildIdentity(distDir) {
    const metadata = JSON.parse(await readFile(path.join(distDir, 'build-meta.json'), 'utf8'));
    if (metadata.version !== 1 || !/^[0-9a-f]{64}$/.test(metadata.buildId || '')) {
        throw new Error('dist build-meta.json is invalid.');
    }
    const [indexSource, serviceWorkerSource] = await Promise.all([
        readFile(path.join(distDir, 'index.html'), 'utf8'),
        readFile(path.join(distDir, 'sw.js'), 'utf8')
    ]);
    if (!indexSource.includes(`content="${metadata.buildId}"`) || !serviceWorkerSource.includes(`const BUILD_ID = '${metadata.buildId}'`)) {
        throw new Error('dist shell and Service Worker build IDs do not match build-meta.json.');
    }
}

async function walkDist(root) {
    const result = [];
    async function walk(directory, prefix = '') {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) {
                result.push({ relative, kind: 'symlink' });
            } else if (entry.isDirectory()) {
                result.push({ relative, kind: 'directory' });
                await walk(path.join(directory, entry.name), relative);
            } else if (entry.isFile()) {
                result.push({ relative, kind: 'file' });
            } else {
                result.push({ relative, kind: 'other' });
            }
        }
    }
    await walk(root);
    return result;
}

function displayFor(root, filePath) {
    if (root === PROJECT_ROOT) {
        return displayPath(filePath);
    }
    const relative = path.relative(root, filePath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    assertDistClean()
        .then((inspection) => {
            const mode = inspection.legacyV1 ? 'legacy v1' : `v2 (${inspection.objects.length} objects)`;
            console.log(`dist check passed in ${mode} mode: ${displayPath(DIST_DIR)}`);
        })
        .catch((error) => {
            console.error(error.message);
            process.exit(1);
        });
}
