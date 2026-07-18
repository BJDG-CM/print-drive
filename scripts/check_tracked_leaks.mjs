#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FORBIDDEN_PATH_RE = /(?:^|\/)(?:private_files)(?:\/|$)|(?:^|\/)\.print-drive-passphrase$|(?:^|\/)\.env(?:\.|$)/i;

export function findForbiddenTrackedPaths(paths) {
    return paths.filter((filePath) => FORBIDDEN_PATH_RE.test(filePath.replace(/\\/g, '/')));
}

export function listTrackedPaths() {
    const result = spawnSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.error) {
        throw new Error(`Could not launch git ls-files: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`git ls-files failed: ${(result.stderr || result.stdout || 'unknown Git error').trim()}`);
    }
    return result.stdout.split('\0').filter(Boolean);
}

function main() {
    const violations = findForbiddenTrackedPaths(listTrackedPaths());
    if (violations.length > 0) {
        throw new Error(
            `Tracked plaintext leak guard found ${violations.length} prohibited private/passphrase/environment path(s). `
            + 'Names are intentionally omitted from CI output.'
        );
    }
    console.log('Tracked plaintext leak guard passed (private directories, passphrase files, and .env paths are not tracked).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
