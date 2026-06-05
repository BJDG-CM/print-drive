import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = process.env.PRINT_DRIVE_ROOT
    ? path.resolve(process.env.PRINT_DRIVE_ROOT)
    : SCRIPT_DIR;

export function resolveProjectPath(value, fallback) {
    const rawValue = value || fallback;
    if (!rawValue) {
        throw new Error('A path value is required.');
    }

    return path.isAbsolute(rawValue)
        ? path.normalize(rawValue)
        : path.resolve(PROJECT_ROOT, rawValue);
}

export function displayPath(filePath) {
    const relative = path.relative(PROJECT_ROOT, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative;
    }
    return filePath;
}

export function getConfiguredPaths(options = {}) {
    return {
        sourceDir: resolveProjectPath(
            options.source,
            process.env.PRINT_DRIVE_SOURCE_DIR || 'private_files'
        ),
        outputDir: resolveProjectPath(
            options.output,
            process.env.PRINT_DRIVE_OUTPUT_DIR || 'files'
        ),
        passwordFile: resolveProjectPath(
            options.passwordFile,
            process.env.PRINT_DRIVE_PASSWORD_FILE || '.print-drive-passphrase'
        )
    };
}
