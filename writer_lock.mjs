import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const LOCK_NAME = '.print-drive-vault.lock';

export class VaultWriterLockError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VaultWriterLockError';
        this.code = 'VAULT_WRITER_LOCKED';
    }
}

export function vaultWriterLockPath(outputDirectory) {
    return path.join(path.dirname(path.resolve(outputDirectory)), LOCK_NAME);
}

export async function acquireVaultWriterLock(outputDirectory) {
    const lockPath = vaultWriterLockPath(outputDirectory);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const token = randomBytes(16).toString('hex');

    let handle;
    try {
        handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw new VaultWriterLockError(
                `Another Print Drive writer may be active (${lockPath}). Wait for it to finish; remove the lock only after confirming every writer process has stopped.`
            );
        }
        throw error;
    }

    try {
        await handle.writeFile(`${JSON.stringify({
            version: 1,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token
        })}\n`, 'utf8');
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
    }

    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        try {
            const owner = JSON.parse(await readFile(lockPath, 'utf8'));
            if (owner?.token === token) await rm(lockPath, { force: true });
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    };
}

export async function withVaultWriterLock(outputDirectory, operation) {
    const release = await acquireVaultWriterLock(outputDirectory);
    try {
        return await operation();
    } finally {
        await release();
    }
}
