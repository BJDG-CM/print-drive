import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    VaultWriterLockError,
    acquireVaultWriterLock,
    vaultWriterLockPath
} from '../writer_lock.mjs';

test('vault writers share one exclusive lock and release it by owner token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'print-drive-writer-lock-'));
    const output = path.join(root, 'files');
    await mkdir(output);
    try {
        const release = await acquireVaultWriterLock(output);
        await assert.rejects(
            () => acquireVaultWriterLock(output),
            (error) => error instanceof VaultWriterLockError && error.code === 'VAULT_WRITER_LOCKED'
        );
        await release();

        const releaseAgain = await acquireVaultWriterLock(output);
        await releaseAgain();
        await assert.rejects(() => access(vaultWriterLockPath(output)));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
