import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MANIFEST_NAME = 'manifest.enc';
const ENCRYPTED_BIN_RE = /^[0-9a-f]{32}\.bin$/;

export function isAllowedPublicFileName(name, manifestName = DEFAULT_MANIFEST_NAME) {
    return name === manifestName || name === '.gitkeep' || ENCRYPTED_BIN_RE.test(name);
}

export function isEncryptedBinName(name) {
    return ENCRYPTED_BIN_RE.test(name);
}

export async function findPublicFileViolations(publicDir, options = {}) {
    const manifestName = options.manifestName || DEFAULT_MANIFEST_NAME;
    const entries = await readdir(publicDir, { withFileTypes: true });
    const violations = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            violations.push(`${entry.name} is not an allowed file`);
            continue;
        }

        if (!isAllowedPublicFileName(entry.name, manifestName)) {
            violations.push(entry.name);
        }
    }

    return violations.sort((a, b) => a.localeCompare(b));
}

export async function assertPublicFilesClean(publicDir, options = {}) {
    const violations = await findPublicFileViolations(publicDir, options);
    if (violations.length === 0) {
        return;
    }

    const relativeDir = options.displayDir || publicDir;
    throw new Error(
        [
            `Public files leak guard failed for ${relativeDir}.`,
            'Only manifest.enc, .gitkeep, and 32-character lowercase hex .bin files are allowed.',
            ...violations.map((name) => `- ${path.basename(name)}`)
        ].join('\n')
    );
}
