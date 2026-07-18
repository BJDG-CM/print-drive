import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { main as encryptMain, readSourceFiles } from '../encrypt_files.mjs';
import {
    createEncryptedManifest,
    createObjectIndex,
    decryptManifestV2,
    parseEnvelopeText,
    serializeEnvelope,
    unlockVaultKey
} from '../vault_format.mjs';
import { GITHUB_BLOB_LIMIT_BYTES } from './remote_updater.mjs';

export async function buildWorkspaceUpdate({ snapshot, workspaceDirectory, passphrase, mode = 'add-replace', removePaths = [], confirmEmptyMirror = false }) {
    if (!['add-replace', 'remove-selected', 'mirror'].includes(mode)) throw new Error(`Unsupported portable update mode: ${mode}`);
    if (!snapshot || !(snapshot.files instanceof Map)) throw new Error('An exact remote snapshot is required.');
    const sourceFiles = await readSourceFiles(workspaceDirectory, { fullScan: true });
    for (const file of sourceFiles) {
        if (file.size + 1024 * 1024 + 16 > GITHUB_BLOB_LIMIT_BYTES) {
            throw new Error(`GitHub blob-size limit would be exceeded: ${file.relativePath}`);
        }
    }
    if (mode === 'mirror' && sourceFiles.length === 0 && !confirmEmptyMirror) {
        throw new Error('An empty workspace requires a second explicit mirror confirmation.');
    }

    const temporaryBase = path.join(process.env.PRINT_DRIVE_ROOT || process.cwd(), '.print-drive-tmp');
    await mkdir(temporaryBase, { recursive: true });
    const root = await mkdtemp(path.join(temporaryBase, 'update-'));
    const outputDirectory = path.join(root, 'files');
    const passwordFile = path.join(root, 'passphrase');
    await mkdir(outputDirectory);
    try {
        for (const [remotePath, bytes] of snapshot.files) {
            const name = path.posix.basename(remotePath);
            await writeFile(path.join(outputDirectory, name), bytes);
        }
        await writeFile(passwordFile, `${passphrase}\n`, { mode: 0o600 });
        const original = await unlockOutput(outputDirectory, passphrase);
        const originalFiles = original.manifest.files;
        original.vaultKey.fill(0);

        if (removePaths.length > 0) {
            const sourcePaths = new Set(sourceFiles.map((file) => file.relativePath));
            const conflicts = removePaths.filter((value) => sourcePaths.has(value));
            if (conflicts.length) throw new Error(`Selected removal conflicts with workspace files: ${conflicts.join(', ')}`);
            await removeSelected(outputDirectory, passphrase, new Set(removePaths));
        }

        const previousPassphrase = process.env.PRINT_DRIVE_PASSPHRASE;
        process.env.PRINT_DRIVE_PASSPHRASE = passphrase;
        try {
            const encryptionArgs = [
                '--source', workspaceDirectory,
                '--out', outputDirectory,
                '--password-file', passwordFile
            ];
            if (mode !== 'mirror') encryptionArgs.push('--preserve-remote');
            await encryptMain(encryptionArgs);
        } finally {
            if (previousPassphrase === undefined) delete process.env.PRINT_DRIVE_PASSPHRASE;
            else process.env.PRINT_DRIVE_PASSPHRASE = previousPassphrase;
        }

        const target = await unlockOutput(outputDirectory, passphrase);
        const targetFiles = target.manifest.files;
        const plan = createLogicalPlan(originalFiles, targetFiles);
        target.vaultKey.fill(0);
        const files = new Map();
        for (const name of await readdir(outputDirectory)) {
            if (name === 'manifest.enc' || /^[0-9a-f]{32}\.bin$/.test(name)) {
                const bytes = await readFile(path.join(outputDirectory, name));
                if (bytes.byteLength > GITHUB_BLOB_LIMIT_BYTES) throw new Error(`GitHub blob-size limit exceeded after encryption: ${name}`);
                files.set(`${snapshot.prefix}/${name}`, bytes);
            }
        }
        const manifestBytes = files.get(`${snapshot.prefix}/manifest.enc`);
        const targetObjectPath = [...files.keys()].find((filePath) => filePath !== `${snapshot.prefix}/manifest.enc`) || null;
        return {
            baseSha: snapshot.baseSha,
            baseTreeSha: snapshot.baseTreeSha,
            baseEncryptedPaths: new Set(snapshot.files.keys()),
            files,
            plan,
            changeCount: plan.additions.length + plan.replacements.length + plan.removals.length + plan.moves.length,
            uploadBytes: [...files.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
            manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
            targetObjectPath,
            message: 'Update encrypted Print Drive vault'
        };
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function removeSelected(outputDirectory, passphrase, selectedPaths) {
    const current = await unlockOutput(outputDirectory, passphrase);
    try {
        const known = new Set(current.manifest.files.map(logicalPath));
        for (const selected of selectedPaths) {
            if (!known.has(selected)) throw new Error(`Selected remote removal does not exist: ${selected}`);
        }
        const files = current.manifest.files.filter((file) => !selectedPaths.has(logicalPath(file)));
        const revision = current.manifest.revision + 1;
        const encrypted = createEncryptedManifest({
            ...current.manifest,
            id: current.manifest.id,
            revision,
            updatedAt: new Date().toISOString(),
            files
        }, current.vaultKey, current.envelope.vaultId, { id: current.manifest.id, revision });
        const envelope = {
            ...current.envelope,
            objectIndex: createObjectIndex(files),
            manifest: encrypted.descriptor
        };
        await writeFile(path.join(outputDirectory, 'manifest.enc'), serializeEnvelope(envelope));
        const keep = new Set(files.map((file) => `${file.blobId}.bin`));
        for (const name of await readdir(outputDirectory)) {
            if (/^[0-9a-f]{32}\.bin$/.test(name) && !keep.has(name)) await rm(path.join(outputDirectory, name), { force: true });
        }
    } finally {
        current.vaultKey.fill(0);
    }
}

async function unlockOutput(outputDirectory, passphrase) {
    const envelope = parseEnvelopeText(await readFile(path.join(outputDirectory, 'manifest.enc'), 'utf8'));
    const { vaultKey } = unlockVaultKey(envelope, passphrase);
    return { envelope, vaultKey, manifest: decryptManifestV2(envelope, vaultKey) };
}

function createLogicalPlan(beforeFiles, afterFiles) {
    const beforeByPath = new Map(beforeFiles.map((file) => [logicalPath(file), file]));
    const afterByPath = new Map(afterFiles.map((file) => [logicalPath(file), file]));
    const additions = [];
    const replacements = [];
    const removals = [];
    const moves = [];
    const unchanged = [];
    const unmatchedBefore = [];
    const unmatchedAfter = [];
    for (const [filePath, file] of afterByPath) {
        const before = beforeByPath.get(filePath);
        if (!before) unmatchedAfter.push(file);
        else if (before.sha256 !== file.sha256 || before.size !== file.size) replacements.push(filePath);
        else unchanged.push(filePath);
    }
    for (const [filePath, file] of beforeByPath) if (!afterByPath.has(filePath)) unmatchedBefore.push(file);
    for (const after of unmatchedAfter) {
        const candidates = unmatchedBefore.filter((before) => before.size === after.size && before.sha256 === after.sha256);
        if (candidates.length === 1) {
            moves.push({ from: logicalPath(candidates[0]), to: logicalPath(after) });
            unmatchedBefore.splice(unmatchedBefore.indexOf(candidates[0]), 1);
        } else additions.push(logicalPath(after));
    }
    removals.push(...unmatchedBefore.map(logicalPath));
    return { additions, replacements, removals, moves, unchanged };
}

function logicalPath(file) { return file.relativePath || file.name; }
