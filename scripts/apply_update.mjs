import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfiguredPaths } from '../paths.mjs';
import { inspectPublicFiles } from '../public_files_guard.mjs';
import {
    decryptFileV2,
    decryptManifestV2,
    parseEnvelopeText,
    sha256Hex,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';
import { withVaultWriterLock } from '../writer_lock.mjs';

const UPDATE_NAME = 'print-drive-update.json';
const MANIFEST_ENTRY = 'files/manifest.enc';
const MAX_PACKAGE_BYTES = 640 * 1024 * 1024;
const MAX_ENTRIES = 5002;
const BLOB_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const configured = getConfiguredPaths({
        output: options.output,
        passwordFile: options.passwordFile
    });
    const request = {
        zipPath: path.resolve(options.zipPath),
        outputDir: configured.outputDir,
        passwordFile: configured.passwordFile
    };
    const result = options.mode === 'apply'
        ? await applyUpdate(request)
        : await dryRunUpdate(request);
    printPlan(result, options.mode);
}

export async function dryRunUpdate(options) {
    const packageData = await readUpdatePackage(options.zipPath);
    return validateUpdate(packageData, options);
}

export async function applyUpdate(options) {
    return withVaultWriterLock(options.outputDir, async () => {
        const packageData = await readUpdatePackage(options.zipPath);
        const plan = await validateUpdate(packageData, options);
        await publishUpdate(plan, options.outputDir);
        return plan;
    });
}

export async function readUpdatePackage(zipPath) {
    const packageStat = await stat(zipPath);
    if (!packageStat.isFile() || packageStat.size <= 0 || packageStat.size > MAX_PACKAGE_BYTES) {
        throw new Error(`Update package must be a regular ZIP no larger than ${MAX_PACKAGE_BYTES} bytes.`);
    }
    const zipBytes = await readFile(zipPath);
    const entries = parseStoredZip(zipBytes);
    const metadataBytes = entries.get(UPDATE_NAME);
    const manifestBytes = entries.get(MANIFEST_ENTRY);
    if (!metadataBytes || !manifestBytes) {
        throw new Error(`Update package must contain ${UPDATE_NAME} and ${MANIFEST_ENTRY}.`);
    }
    if (metadataBytes.byteLength > 1024 * 1024) {
        throw new Error('Update metadata exceeds 1 MiB.');
    }
    let metadata;
    try {
        metadata = JSON.parse(textDecoder.decode(metadataBytes));
    } catch (error) {
        throw new Error(`Update metadata is not valid UTF-8 JSON: ${error.message}`);
    }
    validateMetadata(metadata);
    const allowed = new Set([UPDATE_NAME, MANIFEST_ENTRY, ...metadata.addObjects.map((object) => object.path)]);
    for (const name of entries.keys()) {
        if (!allowed.has(name)) throw new Error(`Unknown ZIP entry: ${name}`);
    }
    if (entries.size !== allowed.size || [...allowed].some((name) => !entries.has(name))) {
        throw new Error('ZIP entries do not exactly match update metadata.');
    }
    return { zipPath, zipBytes, entries, metadata, manifestBytes };
}

async function validateUpdate(packageData, options) {
    const { metadata, entries, manifestBytes } = packageData;
    const targetEnvelope = parseEnvelopeText(textDecoder.decode(manifestBytes));
    validateEnvelopeV2(targetEnvelope);
    if (targetEnvelope.vaultId !== metadata.vaultId) throw new Error('Target manifest vaultId does not match update metadata.');
    if (targetEnvelope.manifest.revision !== metadata.targetRevision) throw new Error('Target manifest revision does not match update metadata.');

    const current = await inspectPublicFiles(options.outputDir, {
        allowLegacyV1: false,
        rejectUnreferenced: false,
        verifyCiphertext: true
    });
    if (current.version !== 2) throw new Error('The current public vault must use v2.');
    if (current.envelope.vaultId !== metadata.vaultId) throw new Error('Update package vaultId does not match the current vault.');

    const currentManifestBytes = await readFile(path.join(options.outputDir, 'manifest.enc'));
    const targetDigest = sha256Hex(manifestBytes);
    const recovery = current.envelope.manifest.revision === metadata.targetRevision
        && sha256Hex(currentManifestBytes) === targetDigest;
    if (!recovery && current.envelope.manifest.revision !== metadata.baseRevision) {
        throw new Error(`Base revision mismatch: current ${current.envelope.manifest.revision}, package ${metadata.baseRevision}.`);
    }

    const currentById = new Map(current.objects.map((object) => [object.blobId, object]));
    const targetObjects = targetEnvelope.objectIndex.objects;
    const targetById = new Map(targetObjects.map((object) => [object.blobId, object]));
    const additions = metadata.addObjects;
    const removals = metadata.removeObjects;
    if (!recovery) {
        const expectedAdds = targetObjects.filter((object) => !currentById.has(object.blobId));
        const expectedRemoves = current.objects.filter((object) => !targetById.has(object.blobId)).map((object) => object.blobId);
        assertJsonEqual(additions, expectedAdds, 'addObjects does not exactly match the target object index');
        assertJsonEqual(removals, expectedRemoves, 'removeObjects does not exactly match the target object index');
        for (const object of targetObjects) {
            const existing = currentById.get(object.blobId);
            if (existing) assertJsonEqual(object, existing, `Immutable object descriptor changed: ${object.blobId}`);
        }
    } else {
        for (const object of additions) {
            assertJsonEqual(object, targetById.get(object.blobId), `Recovery addObject is absent from target: ${object.blobId}`);
        }
        for (const blobId of removals) {
            if (targetById.has(blobId)) throw new Error(`Recovery removeObject remains referenced: ${blobId}`);
        }
    }

    for (const object of additions) {
        const bytes = entries.get(object.path);
        if (bytes.byteLength !== object.encryptedSize) throw new Error(`Object size mismatch: ${object.path}`);
        if (sha256Hex(bytes) !== object.ciphertextSha256) throw new Error(`Object SHA-256 mismatch: ${object.path}`);
    }
    await rejectUnexpectedPublicBlobs(options.outputDir, current.referencedNames, new Set([
        ...additions.map((object) => `${object.blobId}.bin`),
        ...removals.map((blobId) => `${blobId}.bin`)
    ]));

    const passphrase = await readOptionalPassphrase(options.passwordFile);
    let authentication = 'public-integrity-only';
    if (passphrase !== null) {
        const { vaultKey: currentKey } = unlockVaultKey(current.envelope, passphrase);
        decryptManifestV2(current.envelope, currentKey);
        const { vaultKey } = unlockVaultKey(targetEnvelope, passphrase);
        const targetManifest = decryptManifestV2(targetEnvelope, vaultKey);
        for (const object of additions) {
            const file = targetManifest.files.find((candidate) => candidate.blobId === object.blobId);
            if (!file) throw new Error(`Authenticated target manifest is missing ${object.blobId}.`);
            const plaintext = decryptFileV2(file, entries.get(object.path), vaultKey, targetEnvelope.vaultId);
            plaintext.fill(0);
        }
        authentication = 'passphrase-authenticated';
    }
    return {
        ...packageData,
        currentEnvelope: current.envelope,
        targetEnvelope,
        targetDigest,
        additions,
        removals,
        recovery,
        authentication
    };
}

async function publishUpdate(plan, outputDir) {
    const stageRoot = await mkdtemp(path.join(path.dirname(outputDir), '.print-drive-update-txn-'));
    const stageObjects = path.join(stageRoot, 'objects');
    const stageManifest = path.join(stageRoot, 'manifest.enc');
    const published = [];
    let manifestCommitted = plan.recovery;
    await mkdir(stageObjects, { recursive: true });
    try {
        for (const object of plan.additions) {
            await writeDurable(path.join(stageObjects, `${object.blobId}.bin`), plan.entries.get(object.path));
        }
        await writeDurable(stageManifest, plan.manifestBytes);
        triggerFailpoint('before-object-publish');
        for (const object of plan.additions) {
            const targetPath = path.join(outputDir, `${object.blobId}.bin`);
            if (await exists(targetPath)) {
                const existing = await readFile(targetPath);
                if (existing.byteLength !== object.encryptedSize || sha256Hex(existing) !== object.ciphertextSha256) {
                    throw new Error(`Immutable object ID collision: ${object.blobId}`);
                }
                continue;
            }
            await link(path.join(stageObjects, `${object.blobId}.bin`), targetPath);
            await syncFile(targetPath);
            published.push(`${object.blobId}.bin`);
        }
        await syncDirectory(outputDir);
        triggerFailpoint('after-object-publish');
        if (!plan.recovery) {
            triggerFailpoint('before-manifest-commit');
            await rename(stageManifest, path.join(outputDir, 'manifest.enc'));
            await syncDirectory(outputDir);
            manifestCommitted = true;
            triggerFailpoint('after-manifest-commit');
        }
        for (const blobId of plan.removals) {
            await rm(path.join(outputDir, `${blobId}.bin`), { force: true });
        }
        await syncDirectory(outputDir);
        triggerFailpoint('after-remove');
        await inspectPublicFiles(outputDir, {
            allowLegacyV1: false,
            rejectUnreferenced: true,
            verifyCiphertext: true
        });
    } catch (error) {
        if (!manifestCommitted) {
            for (const name of published) await rm(path.join(outputDir, name), { force: true });
            await syncDirectory(outputDir);
        }
        throw error;
    } finally {
        await rm(stageRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

export function validateMetadata(metadata) {
    assertPlainObject(metadata, 'update metadata');
    assertExactKeys(metadata, ['version', 'app', 'vaultId', 'baseRevision', 'targetRevision', 'addObjects', 'removeObjects', 'manifestPath'], 'update metadata');
    if (metadata.version !== 1 || metadata.app !== 'print-drive') throw new Error('Unsupported update metadata version or app.');
    if (!BLOB_ID_RE.test(metadata.vaultId || '')) throw new Error('vaultId must be 32 lowercase hex characters.');
    if (!Number.isSafeInteger(metadata.baseRevision) || metadata.baseRevision < 1) throw new Error('baseRevision must be a positive safe integer.');
    if (metadata.targetRevision !== metadata.baseRevision + 1) throw new Error('targetRevision must be exactly baseRevision + 1.');
    if (metadata.manifestPath !== MANIFEST_ENTRY) throw new Error(`manifestPath must be ${MANIFEST_ENTRY}.`);
    if (!Array.isArray(metadata.addObjects) || !Array.isArray(metadata.removeObjects)) throw new Error('addObjects and removeObjects must be arrays.');
    let previousAdd = '';
    const addIds = new Set();
    for (const [index, object] of metadata.addObjects.entries()) {
        assertPlainObject(object, `addObjects[${index}]`);
        assertExactKeys(object, ['blobId', 'path', 'encryptedSize', 'ciphertextSha256'], `addObjects[${index}]`);
        if (!BLOB_ID_RE.test(object.blobId || '') || object.path !== `files/${object.blobId}.bin`) throw new Error(`Invalid addObjects path or blobId at index ${index}.`);
        if (!Number.isSafeInteger(object.encryptedSize) || object.encryptedSize < 16) throw new Error(`Invalid encryptedSize at addObjects[${index}].`);
        if (!SHA256_RE.test(object.ciphertextSha256 || '')) throw new Error(`Invalid ciphertextSha256 at addObjects[${index}].`);
        if (addIds.has(object.blobId) || (previousAdd && object.path <= previousAdd)) throw new Error('addObjects must be unique and canonically sorted.');
        addIds.add(object.blobId);
        previousAdd = object.path;
    }
    let previousRemove = '';
    const removeIds = new Set();
    for (const blobId of metadata.removeObjects) {
        if (!BLOB_ID_RE.test(blobId || '') || removeIds.has(blobId) || addIds.has(blobId) || (previousRemove && blobId <= previousRemove)) {
            throw new Error('removeObjects must contain unique, sorted blob IDs disjoint from addObjects.');
        }
        removeIds.add(blobId);
        previousRemove = blobId;
    }
    return metadata;
}

export function parseStoredZip(bytes) {
    const buffer = Buffer.from(bytes);
    const eocdOffset = findEocd(buffer);
    const entries = new Map();
    const count = buffer.readUInt16LE(eocdOffset + 10);
    const centralSize = buffer.readUInt32LE(eocdOffset + 12);
    const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
    if (buffer.readUInt16LE(eocdOffset + 4) !== 0 || buffer.readUInt16LE(eocdOffset + 6) !== 0) throw new Error('Multi-disk ZIP files are not supported.');
    if (count !== buffer.readUInt16LE(eocdOffset + 8) || count > MAX_ENTRIES) throw new Error('Invalid ZIP entry count.');
    if (centralOffset + centralSize !== eocdOffset) throw new Error('ZIP central directory bounds are invalid.');
    let cursor = centralOffset;
    const localOffsets = new Set();
    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory entry.');
        const flags = buffer.readUInt16LE(cursor + 8);
        const method = buffer.readUInt16LE(cursor + 10);
        const crc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const externalAttributes = buffer.readUInt32LE(cursor + 38);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        if ((flags & 0x0001) || (flags & 0x0008) || !(flags & 0x0800) || method !== 0 || compressedSize !== uncompressedSize) {
            throw new Error('ZIP entries must be unencrypted, UTF-8, stored entries with fixed sizes.');
        }
        if (((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP symlinks are not allowed.');
        const nameStart = cursor + 46;
        const nameEnd = nameStart + nameLength;
        if (nameEnd + extraLength + commentLength > eocdOffset) throw new Error('ZIP central entry exceeds its directory.');
        const name = decodeSafeZipName(buffer.subarray(nameStart, nameEnd));
        const duplicateKey = name.toLocaleLowerCase('en-US');
        if ([...entries.keys()].some((value) => value.toLocaleLowerCase('en-US') === duplicateKey)) throw new Error(`Duplicate ZIP entry: ${name}`);
        if (localOffsets.has(localOffset)) throw new Error('Duplicate ZIP local entry offset.');
        localOffsets.add(localOffset);
        const data = readLocalEntry(buffer, localOffset, { name, flags, method, crc, compressedSize }, centralOffset);
        entries.set(name, data);
        cursor = nameEnd + extraLength + commentLength;
    }
    if (cursor !== eocdOffset) throw new Error('ZIP central directory size does not match its entries.');
    return entries;
}

function readLocalEntry(buffer, offset, expected, centralOffset) {
    if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP local header.');
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const uncompressed = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + size;
    const name = decodeSafeZipName(buffer.subarray(nameStart, nameStart + nameLength));
    if (name !== expected.name || flags !== expected.flags || method !== expected.method || crc !== expected.crc || size !== expected.compressedSize || uncompressed !== size || dataEnd > centralOffset) {
        throw new Error(`ZIP local header mismatch: ${expected.name}`);
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(data) !== crc) throw new Error(`ZIP CRC mismatch: ${expected.name}`);
    return data;
}

function findEocd(buffer) {
    const minimum = Math.max(0, buffer.length - 65557);
    for (let offset = buffer.length - 22; offset >= minimum; offset--) {
        if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
    }
    throw new Error('ZIP end-of-central-directory record was not found.');
}

function decodeSafeZipName(bytes) {
    let name;
    try { name = textDecoder.decode(bytes); } catch { throw new Error('ZIP entry name is not valid UTF-8.'); }
    const segments = name.split('/');
    if (!name || name !== name.normalize('NFC') || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
        || /[\u0000-\u001f\u007f\u2044\u2215\u29f8\uff0f\uff3c]/u.test(name)
        || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Unsafe ZIP entry name: ${name}`);
    }
    return name;
}

async function rejectUnexpectedPublicBlobs(outputDir, referencedNames, allowedExtra) {
    for (const entry of await readdir(outputDir, { withFileTypes: true })) {
        if (entry.isFile() && /^[0-9a-f]{32}\.bin$/.test(entry.name) && !referencedNames.has(entry.name) && !allowedExtra.has(entry.name)) {
            throw new Error(`Unrelated unreferenced object is present: files/${entry.name}`);
        }
    }
}

async function readOptionalPassphrase(passwordFile) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) return process.env.PRINT_DRIVE_PASSPHRASE;
    if (!passwordFile || !await exists(passwordFile)) return null;
    const value = await readFile(passwordFile, 'utf8');
    const stripped = value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
    if (!stripped) throw new Error('Configured passphrase file is empty.');
    return stripped;
}

async function writeDurable(filePath, bytes) {
    const handle = await open(filePath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function syncFile(filePath) {
    const handle = await open(filePath, 'r');
    try { await handle.sync(); } catch (error) { if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; } finally { await handle.close(); }
}

async function syncDirectory(directory) {
    try { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch { /* Windows may not support directory fsync. */ }
}

function triggerFailpoint(name) {
    if (process.env.PRINT_DRIVE_UPDATE_FAILPOINT === name) throw new Error(`Triggered update failpoint: ${name}`);
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be one JSON object.`);
}

function assertExactKeys(value, expected, label) {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has missing or unknown fields.`);
}

function assertJsonEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function exists(filePath) {
    return stat(filePath).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error));
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function parseArgs(args) {
    const options = { mode: null, zipPath: null, output: null, passwordFile: null };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--dry-run' || arg === '--apply') {
            const mode = arg === '--apply' ? 'apply' : 'dry-run';
            if (options.mode && options.mode !== mode) throw new Error('Choose exactly one of --dry-run or --apply.');
            options.mode = mode;
        } else if (arg === '--out') options.output = requireValue(args, ++index, arg);
        else if (arg === '--password-file') options.passwordFile = requireValue(args, ++index, arg);
        else if (arg === '--help') { printHelp(); process.exit(0); }
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        else if (options.zipPath) throw new Error('Only one update ZIP path may be supplied.');
        else options.zipPath = arg;
    }
    if (!options.mode || !options.zipPath) throw new Error('Supply an update ZIP path and exactly one of --dry-run or --apply.');
    return options;
}

function requireValue(args, index, option) {
    if (!args[index] || args[index].startsWith('-')) throw new Error(`${option} requires a value.`);
    return args[index];
}

function printPlan(plan, mode) {
    console.log(`${mode === 'apply' ? 'Applied' : 'Validated'} update ${plan.metadata.baseRevision} -> ${plan.metadata.targetRevision}.`);
    console.log(`Objects to add: ${plan.additions.length}; objects to remove: ${plan.removals.length}.`);
    console.log(plan.authentication === 'passphrase-authenticated'
        ? 'Target manifest and new objects were authenticated with the configured passphrase.'
        : 'No passphrase was available; only public envelope and object integrity were verified.');
    if (plan.recovery) console.log('Completed recovery for a target manifest that was already committed.');
}

function printHelp() {
    console.log('Usage: node scripts/apply_update.mjs <update.zip> --dry-run|--apply [--out <dir>] [--password-file <path>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
