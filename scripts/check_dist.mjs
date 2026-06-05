#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, displayPath } from '../paths.mjs';
import { assertPublicFilesClean } from '../public_files_guard.mjs';

const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const ALLOWED_DIST_ENTRIES = new Set([
    'index.html',
    'manifest.json',
    'icon.svg',
    'robots.txt',
    'sw.js',
    'files'
]);

export async function assertDistClean(distDir = DIST_DIR) {
    const entries = await readdir(distDir, { withFileTypes: true });
    const violations = [];

    for (const entry of entries) {
        if (!ALLOWED_DIST_ENTRIES.has(entry.name)) {
            violations.push(entry.name);
            continue;
        }

        if (entry.name === 'files' && !entry.isDirectory()) {
            violations.push('files must be a directory');
        } else if (entry.name !== 'files' && !entry.isFile()) {
            violations.push(`${entry.name} must be a file`);
        }
    }

    for (const required of ALLOWED_DIST_ENTRIES) {
        if (!entries.some((entry) => entry.name === required)) {
            violations.push(`${required} is missing`);
        }
    }

    if (violations.length > 0) {
        throw new Error(`dist structure check failed:\n${violations.map((name) => `- ${name}`).join('\n')}`);
    }

    await assertPublicFilesClean(path.join(distDir, 'files'), {
        displayDir: displayPath(path.join(distDir, 'files'))
    });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    assertDistClean()
        .then(() => {
            console.log(`dist check passed: ${displayPath(DIST_DIR)}`);
        })
        .catch((error) => {
            console.error(error.message);
            process.exit(1);
        });
}
