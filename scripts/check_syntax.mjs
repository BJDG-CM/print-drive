#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRECTORIES = new Set(['.git', '.tmp', 'dist', 'files', 'private_files', 'node_modules']);

async function main() {
    const files = await discoverJavaScript(ROOT);
    let failed = false;
    for (const file of files) {
        const result = spawnSync(process.execPath, ['--check', file], {
            cwd: ROOT,
            stdio: 'inherit',
            windowsHide: true
        });
        if (result.status !== 0) {
            failed = true;
        }
    }
    if (failed) {
        process.exit(1);
    }
    console.log(`node --check passed for ${files.length} JavaScript file(s), including capability/public-device modules and tests.`);
}

async function discoverJavaScript(directory, prefix = '') {
    const result = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name)) {
                result.push(...await discoverJavaScript(path.join(directory, entry.name), path.join(prefix, entry.name)));
            }
        } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
            result.push(path.join(prefix, entry.name));
        }
    }
    return result.sort();
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
