#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const JS_FILES = [
    'app.js',
    'crypto.js',
    'file_types.js',
    'ui.js',
    'zip.js',
    'sw.js',
    'encrypt_files.mjs',
    'set_password.mjs',
    'paths.mjs',
    'public_files_guard.mjs',
    'check_public_files.mjs',
    'scripts/build_dist.mjs',
    'scripts/check_dist.mjs',
    'scripts/check_syntax.mjs',
    'scripts/py_compile_check.mjs',
    'scripts/smoke_test.mjs'
];

let failed = false;

for (const file of JS_FILES) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        failed = true;
    }
}

if (failed) {
    process.exit(1);
}

console.log(`node --check passed for ${JS_FILES.length} file(s).`);
