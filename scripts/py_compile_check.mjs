#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function main() {
    const pycacheRoot = await mkdtemp(path.join(os.tmpdir(), 'print-drive-pycache-'));
    try {
        const result = spawnSync('python', ['-m', 'py_compile', 'auto_sync.py'], {
            cwd: ROOT,
            env: {
                ...process.env,
                PYTHONPYCACHEPREFIX: pycacheRoot
            },
            stdio: 'inherit'
        });

        if (result.error) {
            throw result.error;
        }

        if (result.status !== 0) {
            process.exit(result.status || 1);
        }

        console.log('python -m py_compile passed for auto_sync.py.');
    } finally {
        await rm(pycacheRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
