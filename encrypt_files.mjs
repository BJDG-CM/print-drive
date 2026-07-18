#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
    access,
    chmod,
    link,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { displayPath, getConfiguredPaths } from './paths.mjs';
import { assertPublicFilesClean, isEncryptedBinName } from './public_files_guard.mjs';
import { withVaultWriterLock } from './writer_lock.mjs';
import {
    APP_ID,
    DEFAULT_ITERATIONS,
    DEFAULT_PADDING_BYTES,
    FORMAT_VERSION,
    MAX_FILE_BYTES,
    MAX_MANIFEST_FILES,
    WrongPasswordError,
    addRandomPadding,
    base64UrlEncode,
    canonicalFileNameKey,
    compareUnicode,
    createCryptoDescriptor,
    createEncryptedManifest,
    createFileAad,
    createObjectIndex,
    createPasswordKeySlot,
    decryptFileV1,
    decryptFileV2,
    decryptManifestV1,
    decryptManifestV2,
    deriveVaultSubkeys,
    encryptAesGcm,
    parseEnvelopeText,
    randomHex,
    serializeEnvelope,
    sha256Hex,
    unlockVaultKey,
    validateEnvelopeV1,
    validateEnvelopeV2,
    wrapDek
} from './vault_format.mjs';

const DEFAULT_SOURCE_DIR = 'private_files';
const DEFAULT_OUTPUT_DIR = 'files';
const DEFAULT_MANIFEST_NAME = 'manifest.enc';
const DEFAULT_PASSWORD_FILE = '.print-drive-passphrase';

const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IGNORED_PREFIXES = ['.', '~$', '~'];
const IGNORED_SUFFIXES = ['.tmp', '.temp', '.crdownload', '.download', '.part', '.partial', '.swp', '.sync'];

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const { sourceDir, outputDir, passwordFile } = getConfiguredPaths(options);
    const manifestPath = path.join(outputDir, options.manifestName);

    if (options.rotatePassphrase) {
        const { rotatePassword } = await import('./set_password.mjs');
        await rotatePassword({
            outputDir,
            manifestName: options.manifestName,
            passwordFile,
            iterations: options.iterations,
            generatedPassword: true
        });
        return;
    }

    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await assertSeparatedDirectories(sourceDir, outputDir);
    const passphrase = await getPassphrase(options, passwordFile);
    if (Array.from(passphrase).length < 12) {
        console.warn('Warning: short passphrases are weak against offline guessing.');
    }

    return withVaultWriterLock(outputDir, async () => {
        await assertPublicFilesClean(outputDir, {
            manifestName: options.manifestName,
            displayDir: displayPath(outputDir)
        });
        const existing = await loadExistingVault(manifestPath, passphrase, options);
        if (existing?.kind === 'v2') {
            await recoverUnreferencedBlobs(outputDir, existing.envelope.objectIndex);
            await syncV2Vault({ existing, sourceDir, outputDir, manifestPath, options });
        } else if (existing?.kind === 'v1') {
            await migrateV1Vault({ existing, outputDir, manifestPath, passphrase, options });
        } else {
            await assertNoOrphanBlobs(outputDir);
            await createInitialVault({ sourceDir, outputDir, manifestPath, passphrase, options });
        }

        await assertPublicFilesClean(outputDir, {
            manifestName: options.manifestName,
            displayDir: displayPath(outputDir)
        });
    });
}

async function createInitialVault({ sourceDir, outputDir, manifestPath, passphrase, options }) {
    const sourceFiles = await readSourceFiles(sourceDir);
    const vaultId = randomHex(16);
    const vaultKey = randomBytes(32);
    const cryptoDescriptor = createCryptoDescriptor(options.paddingBytes);
    const keySlots = [createPasswordKeySlot(passphrase, vaultKey, vaultId, {
        iterations: options.iterations
    })];
    const now = new Date().toISOString();
    const plans = sourceFiles.map((source) => ({
        kind: 'encrypt',
        source,
        logicalId: randomHex(16)
    }));
    await buildAndPublish({
        outputDir,
        manifestPath,
        vaultId,
        vaultKey,
        keySlots,
        cryptoDescriptor,
        plans,
        createdAt: now,
        revision: 1,
        existingManifest: null
    });
    console.log(`Created v2 vault with ${sourceFiles.length} file(s) in ${displayPath(outputDir)}.`);
}

async function syncV2Vault({ existing, sourceDir, outputDir, manifestPath, options }) {
    const { envelope, manifest, vaultKey } = existing;
    const configuredPadding = envelope.crypto.padding.blockSize;
    if (options.paddingExplicit && options.paddingBytes !== configuredPadding) {
        throw new Error('Changing padding for an existing v2 vault is not supported because it would invalidate immutable blobs.');
    }
    if (options.iterationsExplicit) {
        throw new Error('Use set_password.mjs to change KDF parameters without re-encrypting blobs.');
    }

    const sourceFiles = await readSourceFiles(sourceDir);
    const plans = planIncrementalUpdate(sourceFiles, manifest.files);
    const candidatePreview = plans
        .map((plan) => plan.kind === 'reuse' ? plan.file : null)
        .filter(Boolean);
    const changed = plans.some((plan) => plan.kind !== 'reuse' || plan.metadataChanged) ||
        candidatePreview.length !== manifest.files.length;

    if (!changed) {
        await verifyAllObjects(envelope, manifest, vaultKey, outputDir, null);
        await assertExactBlobSet(outputDir, envelope.objectIndex);
        console.log(`No content changes detected; reused all ${manifest.files.length} immutable blob(s).`);
        return;
    }

    await buildAndPublish({
        outputDir,
        manifestPath,
        vaultId: envelope.vaultId,
        vaultKey,
        keySlots: envelope.keySlots,
        cryptoDescriptor: envelope.crypto,
        plans,
        createdAt: manifest.createdAt,
        revision: manifest.revision + 1,
        existingManifest: manifest
    });
    const newBlobCount = plans.filter((plan) => plan.kind === 'encrypt').length;
    console.log(`Updated v2 vault: ${newBlobCount} new blob(s), ${plans.length - newBlobCount} reused.`);
}

async function migrateV1Vault({ existing, outputDir, manifestPath, passphrase, options }) {
    if (!options.migrateV1) {
        throw new Error('A v1 vault was found. Re-run with --migrate-v1 to perform a verified transactional migration.');
    }
    const { envelope: v1Envelope } = existing;
    const { manifest: v1Manifest, key: v1Key } = decryptManifestV1(v1Envelope, passphrase);
    const seenNames = new Set();
    const plans = [];
    for (const file of v1Manifest.files) {
        const name = file.name.normalize('NFC');
        const nameKey = canonicalFileNameKey(name);
        if (seenNames.has(nameKey)) {
            throw new Error(`v1 migration found duplicate NFC filename: ${name}`);
        }
        seenNames.add(nameKey);
        const encrypted = await readFile(path.join(outputDir, `${file.id}.bin`));
        const bytes = decryptFileV1(file, encrypted, v1Key);
        plans.push({
            kind: 'encrypt',
            source: {
                name,
                originalName: file.name,
                absolutePath: null,
                bytes,
                size: bytes.byteLength,
                sha256: sha256Hex(bytes),
                modifiedAt: canonicalDateOrNow(file.modifiedAt || v1Manifest.createdAt)
            },
            logicalId: randomHex(16)
        });
    }
    plans.sort((left, right) => compareUnicode(left.source.name, right.source.name));

    const vaultId = randomHex(16);
    const vaultKey = randomBytes(32);
    const cryptoDescriptor = createCryptoDescriptor(options.paddingBytes);
    const keySlots = [createPasswordKeySlot(passphrase, vaultKey, vaultId, {
        iterations: options.iterations
    })];
    await buildAndPublish({
        outputDir,
        manifestPath,
        vaultId,
        vaultKey,
        keySlots,
        cryptoDescriptor,
        plans,
        createdAt: canonicalDateOrNow(v1Manifest.createdAt),
        revision: 1,
        existingManifest: null
    });
    console.log(`Migrated ${plans.length} file(s) from v1 to v2 transactionally.`);
}

async function buildAndPublish({
    outputDir,
    manifestPath,
    vaultId,
    vaultKey,
    keySlots,
    cryptoDescriptor,
    plans,
    createdAt,
    revision,
    existingManifest
}) {
    const stageRoot = await mkdtemp(path.join(path.dirname(outputDir), '.print-drive-txn-'));
    const stageFilesDir = path.join(stageRoot, 'files');
    const stageManifestPath = path.join(stageRoot, 'manifest.enc');
    await mkdir(stageFilesDir, { recursive: true });
    const publishedBlobNames = [];
    let manifestCommitted = false;

    try {
        const usedBlobIds = new Set(plans
            .filter((plan) => plan.kind === 'reuse')
            .map((plan) => plan.file.blobId));
        const usedDataIvs = new Set(plans
            .filter((plan) => plan.kind === 'reuse')
            .map((plan) => plan.file.dataIv));
        const usedWrapIvs = new Set(plans
            .filter((plan) => plan.kind === 'reuse')
            .map((plan) => plan.file.wrappedDek.iv));
        const files = [];

        for (const plan of plans) {
            if (plan.kind === 'reuse') {
                files.push(plan.file);
                continue;
            }
            const { source, disposable } = await materializeSource(plan.source);
            try {
                const { file, encrypted } = createEncryptedFile({
                    source,
                    logicalId: plan.logicalId,
                    vaultId,
                    vaultKey,
                    blockSize: cryptoDescriptor.padding.blockSize,
                    usedBlobIds,
                    usedDataIvs,
                    usedWrapIvs
                });
                await writeDurableExclusive(path.join(stageFilesDir, `${file.blobId}.bin`), encrypted);
                encrypted.fill(0);
                files.push(file);
            } finally {
                if (disposable) source.bytes.fill(0);
            }
        }
        files.sort((left, right) => compareUnicode(left.name, right.name));

        const now = new Date().toISOString();
        const manifestBase = {
            version: FORMAT_VERSION,
            vaultId,
            id: randomHex(16),
            revision,
            createdAt,
            updatedAt: now < createdAt ? createdAt : now,
            files
        };
        const objectIndex = createObjectIndex(files);
        const { descriptor, payload } = createEncryptedManifest(manifestBase, vaultKey, vaultId, {
            id: manifestBase.id,
            revision
        });
        const envelope = {
            version: FORMAT_VERSION,
            app: APP_ID,
            vaultId,
            keySlots,
            crypto: cryptoDescriptor,
            objectIndex,
            manifest: descriptor
        };
        validateEnvelopeV2(envelope);
        await writeDurableExclusive(stageManifestPath, serializeEnvelope(envelope));
        await verifyAllObjects(envelope, payload, vaultKey, outputDir, stageFilesDir);

        triggerFailpoint('before-blob-publish');
        for (const object of objectIndex.objects) {
            const stagedPath = path.join(stageFilesDir, `${object.blobId}.bin`);
            if (!await exists(stagedPath)) {
                continue;
            }
            const targetPath = path.join(outputDir, `${object.blobId}.bin`);
            if (await exists(targetPath)) {
                const current = await readFile(targetPath);
                if (sha256Hex(current) !== object.ciphertextSha256) {
                    throw new Error(`Immutable blob id collision: ${object.blobId}`);
                }
                await rm(stagedPath, { force: true });
                continue;
            }
            await link(stagedPath, targetPath);
            await syncFile(targetPath);
            publishedBlobNames.push(`${object.blobId}.bin`);
            await rm(stagedPath, { force: true });
        }
        await syncDirectoryBestEffort(outputDir);
        triggerFailpoint('after-blob-publish');
        triggerFailpoint('before-manifest-commit');

        await rename(stageManifestPath, manifestPath);
        await syncDirectoryBestEffort(outputDir);
        manifestCommitted = true;
        triggerFailpoint('after-manifest-commit');

        await garbageCollectBlobs(outputDir, objectIndex);
        triggerFailpoint('after-gc');
        await verifyAllObjects(envelope, payload, vaultKey, outputDir, null);
        await assertExactBlobSet(outputDir, objectIndex);
    } catch (error) {
        if (!manifestCommitted) {
            for (const name of publishedBlobNames) {
                await rm(path.join(outputDir, name), { force: true });
            }
            await syncDirectoryBestEffort(outputDir);
        }
        throw error;
    } finally {
        await rm(stageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

function createEncryptedFile({
    source,
    logicalId,
    vaultId,
    vaultKey,
    blockSize,
    usedBlobIds,
    usedDataIvs,
    usedWrapIvs
}) {
    const blobId = uniqueRandomHex(usedBlobIds, 16);
    const dataIv = uniqueRandomBase64Url(usedDataIvs, 12);
    const wrapIv = uniqueRandomBytes(usedWrapIvs, 12);
    const dek = randomBytes(32);
    const padded = addRandomPadding(source.bytes, blockSize);
    const file = {
        logicalId,
        blobId,
        path: `files/${blobId}.bin`,
        name: source.name,
        size: source.size,
        paddedSize: padded.byteLength,
        encryptedSize: padded.byteLength + 16,
        sha256: source.sha256,
        ciphertextSha256: '0'.repeat(64),
        modifiedAt: source.modifiedAt,
        dataIv,
        wrappedDek: null
    };
    const { dekWrapKey } = deriveVaultSubkeys(vaultKey, vaultId);
    file.wrappedDek = wrapDek(dek, dekWrapKey, vaultId, logicalId, blobId, { iv: wrapIv });
    const encrypted = encryptAesGcm(
        dek,
        Buffer.from(dataIv, 'base64url'),
        padded,
        createFileAad(vaultId, file)
    );
    file.ciphertextSha256 = sha256Hex(encrypted);
    return { file, encrypted };
}

function planIncrementalUpdate(sourceFiles, oldFiles) {
    const oldByName = new Map(oldFiles.map((file) => [file.name, file]));
    const matchedOldIds = new Set();
    const plans = [];
    const unmatchedSources = [];

    for (const source of sourceFiles) {
        const old = oldByName.get(source.name);
        if (!old) {
            unmatchedSources.push(source);
            continue;
        }
        matchedOldIds.add(old.logicalId);
        if (old.size === source.size && old.sha256 === source.sha256) {
            plans.push({ kind: 'reuse', file: old, metadataChanged: false });
        } else {
            plans.push({ kind: 'encrypt', source, logicalId: old.logicalId });
        }
    }

    const unmatchedOld = oldFiles.filter((file) => !matchedOldIds.has(file.logicalId));
    const oldByFingerprint = groupBy(unmatchedOld, fileFingerprint);
    const sourceByFingerprint = groupBy(unmatchedSources, fileFingerprint);
    for (const source of unmatchedSources) {
        const fingerprint = fileFingerprint(source);
        const oldCandidates = oldByFingerprint.get(fingerprint) || [];
        const sourceCandidates = sourceByFingerprint.get(fingerprint) || [];
        if (oldCandidates.length === 1 && sourceCandidates.length === 1) {
            const old = oldCandidates[0];
            plans.push({
                kind: 'reuse',
                metadataChanged: true,
                file: {
                    ...old,
                    name: source.name,
                    modifiedAt: source.modifiedAt
                }
            });
            matchedOldIds.add(old.logicalId);
        } else {
            plans.push({ kind: 'encrypt', source, logicalId: randomHex(16) });
        }
    }
    plans.sort((left, right) => compareUnicode(
        left.kind === 'reuse' ? left.file.name : left.source.name,
        right.kind === 'reuse' ? right.file.name : right.source.name
    ));
    return plans;
}

async function readSourceFiles(sourceDir) {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    const files = [];
    const canonicalNames = new Set();
    for (const entry of entries) {
        if (!entry.isFile() || shouldIgnore(entry.name)) {
            continue;
        }
        const name = entry.name.normalize('NFC');
        const nameKey = canonicalFileNameKey(name);
        if (canonicalNames.has(nameKey)) {
            throw new Error(`Duplicate filename after NFC normalization: ${name}`);
        }
        canonicalNames.add(nameKey);
        const absolutePath = path.join(sourceDir, entry.name);
        const before = await stat(absolutePath);
        if (before.size > MAX_FILE_BYTES) {
            throw new Error(`Source file exceeds the 512 MiB v2 limit: ${entry.name}`);
        }
        const { after, sha256 } = await hashStableSourceFile(absolutePath, before, entry.name);
        files.push({
            name,
            originalName: entry.name,
            absolutePath,
            size: after.size,
            sha256,
            mtimeMs: after.mtimeMs,
            modifiedAt: after.mtime.toISOString()
        });
    }
    files.sort((left, right) => compareUnicode(left.name, right.name));
    if (files.length > MAX_MANIFEST_FILES) {
        throw new Error(`Source contains more than ${MAX_MANIFEST_FILES} supported files.`);
    }
    return files;
}

async function hashStableSourceFile(absolutePath, before, displayName) {
    const handle = await open(absolutePath, 'r');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let totalBytes = 0;
    try {
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
            if (bytesRead === 0) break;
            hash.update(chunk.subarray(0, bytesRead));
            totalBytes += bytesRead;
        }
    } finally {
        chunk.fill(0);
        await handle.close();
    }
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || totalBytes !== after.size) {
        throw new Error(`Source file changed while it was being hashed: ${displayName}`);
    }
    return { after, sha256: hash.digest('hex') };
}

async function materializeSource(source) {
    if (source.bytes) return { source, disposable: false };
    const before = await stat(source.absolutePath);
    if (before.size !== source.size || before.mtimeMs !== source.mtimeMs) {
        throw new Error(`Source file changed before encryption: ${source.originalName}`);
    }
    const bytes = await readFile(source.absolutePath);
    const after = await stat(source.absolutePath);
    if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        bytes.byteLength !== source.size ||
        sha256Hex(bytes) !== source.sha256
    ) {
        bytes.fill(0);
        throw new Error(`Source file changed while it was being encrypted: ${source.originalName}`);
    }
    return { source: { ...source, bytes }, disposable: true };
}

async function loadExistingVault(manifestPath, passphrase, options) {
    if (!await exists(manifestPath)) {
        return null;
    }
    const envelope = parseEnvelopeText(await readFile(manifestPath, 'utf8'));
    if (envelope.version === FORMAT_VERSION) {
        validateEnvelopeV2(envelope);
        const { vaultKey } = unlockVaultKey(envelope, passphrase);
        const manifest = decryptManifestV2(envelope, vaultKey);
        return { kind: 'v2', envelope, manifest, vaultKey };
    }
    if (envelope.version === 1) {
        validateEnvelopeV1(envelope);
        if (!options.migrateV1) {
            return { kind: 'v1', envelope };
        }
        // Authentication and all v1 blob reads happen in migrateV1Vault before output mutation.
        decryptManifestV1(envelope, passphrase);
        return { kind: 'v1', envelope };
    }
    throw new Error(`Unsupported vault version: ${envelope.version}`);
}

async function verifyAllObjects(envelope, manifest, vaultKey, outputDir, stageFilesDir) {
    validateEnvelopeV2(envelope);
    const decryptedManifest = decryptManifestV2(envelope, vaultKey);
    if (JSON.stringify(decryptedManifest) !== JSON.stringify(manifest)) {
        throw new Error('Candidate manifest self-verification mismatch.');
    }
    for (const file of manifest.files) {
        const name = `${file.blobId}.bin`;
        const staged = stageFilesDir ? path.join(stageFilesDir, name) : null;
        const blobPath = staged && await exists(staged) ? staged : path.join(outputDir, name);
        const encrypted = await readFile(blobPath);
        const plaintext = decryptFileV2(file, encrypted, vaultKey, envelope.vaultId);
        plaintext.fill(0);
        encrypted.fill(0);
    }
}

async function recoverUnreferencedBlobs(outputDir, objectIndex) {
    await garbageCollectBlobs(outputDir, objectIndex);
    await assertExactBlobSet(outputDir, objectIndex);
}

async function garbageCollectBlobs(outputDir, objectIndex) {
    const referenced = new Set(objectIndex.objects.map((object) => `${object.blobId}.bin`));
    const entries = await readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isFile() && isEncryptedBinName(entry.name) && !referenced.has(entry.name)) {
            await rm(path.join(outputDir, entry.name), { force: true });
        }
    }
    await syncDirectoryBestEffort(outputDir);
}

async function assertExactBlobSet(outputDir, objectIndex) {
    const expected = objectIndex.objects.map((object) => `${object.blobId}.bin`).sort();
    const actual = (await readdir(outputDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && isEncryptedBinName(entry.name))
        .map((entry) => entry.name)
        .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Encrypted blob reference mismatch. Expected ${expected.length}, found ${actual.length}.`);
    }
}

async function assertNoOrphanBlobs(outputDir) {
    const blobs = (await readdir(outputDir)).filter(isEncryptedBinName);
    if (blobs.length > 0) {
        throw new Error('Encrypted blobs exist without a manifest; refusing to overwrite or guess ownership.');
    }
}

async function assertSeparatedDirectories(sourceDir, outputDir) {
    const [sourceReal, outputReal] = await Promise.all([realpath(sourceDir), realpath(outputDir)]);
    if (containsPath(sourceReal, outputReal) || containsPath(outputReal, sourceReal)) {
        throw new Error('Source and encrypted output directories must not overlap.');
    }
}

function containsPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function writeDurableExclusive(filePath, data, mode = 0o644) {
    const handle = await open(filePath, 'wx', mode);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function writePassphraseFileAtomic(passwordPath, passphrase) {
    await mkdir(path.dirname(passwordPath), { recursive: true });
    const secretStageDir = path.join(path.dirname(passwordPath), '.tmp');
    await mkdir(secretStageDir, { recursive: true });
    const temporaryPath = path.join(
        secretStageDir,
        `${path.basename(passwordPath)}.${randomHex(8)}.tmp`
    );
    try {
        await writeDurableExclusive(temporaryPath, `${passphrase}\n`, 0o600);
        await rename(temporaryPath, passwordPath);
        try {
            await chmod(passwordPath, 0o600);
        } catch {
            // Windows can ignore POSIX modes; the file remains local and Git-ignored by default.
        }
        await syncDirectoryBestEffort(path.dirname(passwordPath));
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function syncFile(filePath) {
    try {
        const handle = await open(filePath, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) {
            throw error;
        }
        // The staged inode was already fsynced before linking. Some Windows/OneDrive
        // filesystems reject fsync on the public hard-link path.
    }
}

async function syncDirectoryBestEffort(directory) {
    try {
        const handle = await open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Directory fsync is not supported consistently on Windows.
    }
}

function uniqueRandomHex(used, byteLength) {
    for (;;) {
        const value = randomHex(byteLength);
        if (!used.has(value)) {
            used.add(value);
            return value;
        }
    }
}

function uniqueRandomBase64Url(used, byteLength) {
    for (;;) {
        const value = base64UrlEncode(randomBytes(byteLength));
        if (!used.has(value)) {
            used.add(value);
            return value;
        }
    }
}

function uniqueRandomBytes(used, byteLength) {
    for (;;) {
        const bytes = randomBytes(byteLength);
        const value = base64UrlEncode(bytes);
        if (!used.has(value)) {
            used.add(value);
            return bytes;
        }
    }
}

function groupBy(values, keyFunction) {
    const grouped = new Map();
    for (const value of values) {
        const key = keyFunction(value);
        const group = grouped.get(key) || [];
        group.push(value);
        grouped.set(key, group);
    }
    return grouped;
}

function fileFingerprint(file) {
    return `${file.size}:${file.sha256}`;
}

function shouldIgnore(name) {
    const lowerName = name.toLowerCase();
    return (
        IGNORED_NAMES.has(name) ||
        IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
        IGNORED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
    );
}

function canonicalDateOrNow(value) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
        const date = new Date(value);
        if (date.toISOString() === value) {
            return value;
        }
    }
    return new Date().toISOString();
}

function triggerFailpoint(name) {
    const configured = (process.env.PRINT_DRIVE_FAILPOINT || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (configured.includes(name)) {
        const error = new Error(`Injected Print Drive failure at ${name}.`);
        error.code = 'ERR_PRINT_DRIVE_FAILPOINT';
        error.failpoint = name;
        throw error;
    }
}

function parseArgs(args) {
    const options = {
        source: null,
        output: null,
        manifestName: DEFAULT_MANIFEST_NAME,
        passwordFile: null,
        initPassphrase: false,
        rotatePassphrase: false,
        migrateV1: false,
        iterations: DEFAULT_ITERATIONS,
        iterationsExplicit: false,
        paddingBytes: DEFAULT_PADDING_BYTES,
        paddingExplicit: false
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--source') {
            options.source = requireValue(args, ++index, arg);
        } else if (arg === '--out') {
            options.output = requireValue(args, ++index, arg);
        } else if (arg === '--manifest') {
            options.manifestName = requireValue(args, ++index, arg);
        } else if (arg === '--password-file') {
            options.passwordFile = requireValue(args, ++index, arg);
        } else if (arg === '--init-passphrase') {
            options.initPassphrase = true;
        } else if (arg === '--rotate-passphrase') {
            options.rotatePassphrase = true;
        } else if (arg === '--migrate-v1') {
            options.migrateV1 = true;
        } else if (arg === '--iterations') {
            options.iterations = Number(requireValue(args, ++index, arg));
            options.iterationsExplicit = true;
        } else if (arg === '--padding-bytes') {
            options.paddingBytes = Number(requireValue(args, ++index, arg));
            options.paddingExplicit = true;
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!Number.isInteger(options.iterations) || options.iterations < 200000 || options.iterations > 2000000) {
        throw new Error('--iterations must be an integer from 200000 through 2000000.');
    }
    if (
        !Number.isInteger(options.paddingBytes) ||
        options.paddingBytes < 0 ||
        options.paddingBytes > 1024 * 1024 ||
        (options.paddingBytes !== 0 && (
            options.paddingBytes < 1024 ||
            (options.paddingBytes & (options.paddingBytes - 1)) !== 0
        ))
    ) {
        throw new Error('--padding-bytes must be 0 or a power of two from 1024 through 1048576.');
    }
    if (
        !options.manifestName ||
        path.basename(options.manifestName) !== options.manifestName ||
        /[\u0000-\u001f\u007f]/.test(options.manifestName)
    ) {
        throw new Error('--manifest must be a safe filename, not a path.');
    }
    if (options.rotatePassphrase && options.migrateV1) {
        throw new Error('--rotate-passphrase and --migrate-v1 cannot be combined.');
    }
    return options;
}

function requireValue(args, index, optionName) {
    if (!args[index]) {
        throw new Error(`${optionName} requires a value.`);
    }
    return args[index];
}

function printHelp() {
    console.log(`Usage: node encrypt_files.mjs [options]

Options:
  --source <dir>          Source directory for private plaintext files. Default: ${DEFAULT_SOURCE_DIR}
  --out <dir>             Output directory for encrypted files. Default: ${DEFAULT_OUTPUT_DIR}
  --manifest <name>       Encrypted manifest filename. Default: ${DEFAULT_MANIFEST_NAME}
  --password-file <path>  Local ignored passphrase file. Default: ${DEFAULT_PASSWORD_FILE}
  --init-passphrase       Create a random passphrase file when none exists.
  --rotate-passphrase     Safely rotate only the wrapped vault key; blobs are unchanged.
  --migrate-v1            Explicitly migrate a verified v1 vault to v2.
  --iterations <number>   PBKDF2-SHA256 count for a new vault or migration. Default: ${DEFAULT_ITERATIONS}
  --padding-bytes <num>   0 or a power-of-two padding block. Default: ${DEFAULT_PADDING_BYTES}

Failpoint testing:
  PRINT_DRIVE_FAILPOINT=before-blob-publish|after-blob-publish|before-manifest-commit|after-manifest-commit|after-gc
`);
}

async function getPassphrase(options, passwordFile) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) {
        return process.env.PRINT_DRIVE_PASSPHRASE;
    }
    if (await exists(passwordFile)) {
        const value = stripOneLineEnding(await readFile(passwordFile, 'utf8'));
        if (!value) {
            throw new Error(`${displayPath(passwordFile)} is empty.`);
        }
        return value;
    }
    if (options.initPassphrase) {
        const passphrase = randomBytes(24).toString('base64url');
        await writePassphraseFileAtomic(passwordFile, passphrase);
        console.log(`Created local passphrase file: ${displayPath(passwordFile)}`);
        return passphrase;
    }
    const first = await promptHidden('Encryption passphrase: ');
    const second = await promptHidden('Confirm passphrase: ');
    if (first !== second) {
        throw new Error('Passphrases do not match.');
    }
    return first;
}

function stripOneLineEnding(value) {
    return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

function promptHidden(question) {
    if (!process.stdin.isTTY) {
        throw new Error('No TTY available. Use --password-file or PRINT_DRIVE_PASSPHRASE.');
    }
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        let input = '';
        stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const onData = (char) => {
            if (char === '\u0003') {
                stdout.write('\n');
                process.exit(1);
            }
            if (char === '\r' || char === '\n') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.off('data', onData);
                stdout.write('\n');
                resolve(input);
                return;
            }
            if (char === '\u0008' || char === '\u007f') {
                input = input.slice(0, -1);
                return;
            }
            input += char;
        };
        stdin.on('data', onData);
    });
}

async function exists(filePath) {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const prefix = error instanceof WrongPasswordError ? 'Authentication failed: ' : '';
        console.error(`${prefix}${error.message}`);
        process.exit(1);
    });
}
