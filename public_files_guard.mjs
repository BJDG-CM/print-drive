import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateEnvelopeV1, validateEnvelopeV2 } from './vault_format.mjs';

export const DEFAULT_MANIFEST_NAME = 'manifest.enc';
export const MAX_PUBLIC_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_OBJECT_COUNT = 5_000;
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024 + 1024 * 1024 + 16;

const ENCRYPTED_BIN_RE = /^[0-9a-f]{32}\.bin$/;
const BLOB_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OBJECT_INDEX_KEYS = new Set(['version', 'objects']);
const OBJECT_KEYS = new Set(['blobId', 'path', 'encryptedSize', 'ciphertextSha256']);

export function isAllowedPublicFileName(name, manifestName = DEFAULT_MANIFEST_NAME) {
    validateManifestName(manifestName);
    return name === manifestName || name === '.gitkeep' || ENCRYPTED_BIN_RE.test(name);
}

export function isEncryptedBinName(name) {
    return ENCRYPTED_BIN_RE.test(name);
}

export function validateManifestName(manifestName) {
    if (
        typeof manifestName !== 'string'
        || !manifestName
        || manifestName !== path.basename(manifestName)
        || manifestName.includes('/')
        || manifestName.includes('\\')
        || /[\x00\r\n]/.test(manifestName)
    ) {
        throw new Error('Manifest name must be one safe basename without path separators.');
    }
}

export async function findPublicFileViolations(publicDir, options = {}) {
    const manifestName = options.manifestName || DEFAULT_MANIFEST_NAME;
    validateManifestName(manifestName);
    const entries = await readdir(publicDir, { withFileTypes: true });
    const violations = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            violations.push(`${entry.name} is not a regular file`);
            continue;
        }
        if (!isAllowedPublicFileName(entry.name, manifestName)) {
            violations.push(`${entry.name} is not an allowed encrypted output name`);
        }
    }

    const manifestEntry = entries.find((entry) => entry.name === manifestName && entry.isFile());
    if (options.requireManifest && !manifestEntry) {
        violations.push(`${manifestName} is missing`);
    }
    return violations.sort((a, b) => a.localeCompare(b));
}

export async function inspectPublicFiles(publicDir, options = {}) {
    const manifestName = options.manifestName || DEFAULT_MANIFEST_NAME;
    const violations = await findPublicFileViolations(publicDir, {
        ...options,
        manifestName,
        requireManifest: true
    });
    if (violations.length > 0) {
        throw createGuardError(publicDir, violations, options);
    }

    const entries = await readdir(publicDir, { withFileTypes: true });
    const binNames = entries.filter((entry) => entry.isFile() && isEncryptedBinName(entry.name)).map((entry) => entry.name);
    const manifestPath = path.join(publicDir, manifestName);
    const envelope = await readPublicEnvelope(manifestPath);
    const hasObjectIndex = envelope?.objectIndex !== undefined;
    const isV2 = envelope?.version === 2;

    if (!isV2 && envelope?.version !== 1) {
        throw createGuardError(publicDir, ['manifest envelope version must be 1 or 2'], options);
    }
    try {
        if (isV2) {
            validateEnvelopeV2(envelope);
        } else {
            validateEnvelopeV1(envelope);
        }
    } catch (error) {
        throw createGuardError(publicDir, [`manifest envelope schema is invalid: ${error.message}`], options);
    }
    if (isV2 && !hasObjectIndex) {
        throw createGuardError(publicDir, ['v2 manifest envelope is missing objectIndex'], options);
    }
    if (!isV2 && !hasObjectIndex) {
        if (options.allowLegacyV1 === false) {
            throw createGuardError(
                publicDir,
                ['v1 manifest has no public objectIndex; migrate to v2 before strict deployment'],
                options
            );
        }
        return {
            envelope,
            version: 1,
            legacyV1: true,
            referencedNames: new Set(binNames),
            objects: binNames.map((name) => ({
                blobId: name.slice(0, -4),
                path: `files/${name}`,
                encryptedSize: null,
                ciphertextSha256: null
            }))
        };
    }

    const objects = validateObjectIndex(envelope.objectIndex);
    const referencedNames = new Set(objects.map((object) => `${object.blobId}.bin`));
    const referenceViolations = [];
    for (const object of objects) {
        const name = `${object.blobId}.bin`;
        const objectPath = path.join(publicDir, name);
        let objectStat;
        try {
            objectStat = await stat(objectPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                referenceViolations.push(`${object.path} is referenced but missing`);
                continue;
            }
            throw error;
        }
        if (!objectStat.isFile()) {
            referenceViolations.push(`${object.path} is not a regular file`);
            continue;
        }
        if (objectStat.size !== object.encryptedSize) {
            referenceViolations.push(
                `${object.path} size ${objectStat.size} does not match objectIndex ${object.encryptedSize}`
            );
        }
        if (options.verifyCiphertext !== false) {
            const actualHash = await sha256File(objectPath);
            if (actualHash !== object.ciphertextSha256) {
                referenceViolations.push(`${object.path} SHA-256 does not match objectIndex`);
            }
        }
    }

    if (options.rejectUnreferenced !== false) {
        for (const name of binNames) {
            if (!referencedNames.has(name)) {
                referenceViolations.push(`files/${name} is not referenced by objectIndex`);
            }
        }
    }
    if (referenceViolations.length > 0) {
        throw createGuardError(publicDir, referenceViolations, options);
    }

    return {
        envelope,
        version: envelope.version,
        legacyV1: false,
        referencedNames,
        objects
    };
}

export async function readPublicEnvelope(manifestPath) {
    const manifestStat = await stat(manifestPath);
    if (!manifestStat.isFile()) {
        throw new Error(`${manifestPath} is not a regular file.`);
    }
    if (manifestStat.size <= 0 || manifestStat.size > MAX_PUBLIC_MANIFEST_BYTES) {
        throw new Error(`Public manifest size must be between 1 and ${MAX_PUBLIC_MANIFEST_BYTES} bytes.`);
    }
    let envelope;
    try {
        envelope = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`Public manifest envelope is not valid JSON: ${error.message}`);
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error('Public manifest envelope must be one JSON object.');
    }
    return envelope;
}

export function validateObjectIndex(objectIndex) {
    const errors = [];
    if (!objectIndex || typeof objectIndex !== 'object' || Array.isArray(objectIndex)) {
        throw new Error('objectIndex must be an object.');
    }
    for (const key of Object.keys(objectIndex)) {
        if (!OBJECT_INDEX_KEYS.has(key)) {
            errors.push(`objectIndex.${key} is not allowed`);
        }
    }
    if (objectIndex.version !== 1) {
        errors.push('objectIndex.version must be 1');
    }
    if (!Array.isArray(objectIndex.objects)) {
        errors.push('objectIndex.objects must be an array');
    } else if (objectIndex.objects.length > MAX_OBJECT_COUNT) {
        errors.push(`objectIndex.objects exceeds ${MAX_OBJECT_COUNT} entries`);
    }
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    const seenBlobIds = new Set();
    const seenPaths = new Set();
    let previousPath = '';
    objectIndex.objects.forEach((object, index) => {
        const prefix = `objectIndex.objects[${index}]`;
        if (!object || typeof object !== 'object' || Array.isArray(object)) {
            errors.push(`${prefix} must be an object`);
            return;
        }
        for (const key of Object.keys(object)) {
            if (!OBJECT_KEYS.has(key)) {
                errors.push(`${prefix}.${key} is not allowed`);
            }
        }
        if (!BLOB_ID_RE.test(object.blobId || '')) {
            errors.push(`${prefix}.blobId must be 32 lowercase hex characters`);
        }
        if (object.path !== `files/${object.blobId}.bin`) {
            errors.push(`${prefix}.path must exactly match files/<blobId>.bin`);
        }
        if (!Number.isSafeInteger(object.encryptedSize) || object.encryptedSize < 16 || object.encryptedSize > MAX_OBJECT_BYTES) {
            errors.push(`${prefix}.encryptedSize must be a safe integer between 16 and ${MAX_OBJECT_BYTES}`);
        }
        if (!SHA256_RE.test(object.ciphertextSha256 || '')) {
            errors.push(`${prefix}.ciphertextSha256 must be 64 lowercase hex characters`);
        }
        if (seenBlobIds.has(object.blobId)) {
            errors.push(`${prefix}.blobId is duplicated`);
        }
        if (seenPaths.has(object.path)) {
            errors.push(`${prefix}.path is duplicated`);
        }
        if (previousPath && object.path <= previousPath) {
            errors.push(`${prefix}.path must be strictly sorted by blobId`);
        }
        seenBlobIds.add(object.blobId);
        seenPaths.add(object.path);
        previousPath = object.path;
    });
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }
    return objectIndex.objects.map((object) => ({ ...object }));
}

export async function assertPublicFilesClean(publicDir, options = {}) {
    const violations = await findPublicFileViolations(publicDir, options);
    if (violations.length > 0) {
        throw createGuardError(publicDir, violations, options);
    }
    if (options.validateManifestReferences) {
        await inspectPublicFiles(publicDir, options);
    }
}

function createGuardError(publicDir, violations, options) {
    const relativeDir = options.displayDir || publicDir;
    return new Error([
        `Public files leak/integrity guard failed for ${relativeDir}.`,
        'Only manifest.enc, .gitkeep, and 32-character lowercase hex .bin files are allowed.',
        ...violations.map((violation) => `- ${violation}`)
    ].join('\n'));
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}
