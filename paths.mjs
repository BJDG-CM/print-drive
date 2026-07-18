import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CONFIG_FILE_NAME,
    ConfigError,
    loadProjectConfig,
    resolveRuntimeConfig
} from './config.mjs';

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

export function getProjectConfig(options = {}) {
    return loadProjectConfig({
        projectRoot: options.projectRoot || PROJECT_ROOT,
        configPath: options.configPath || process.env.PRINT_DRIVE_CONFIG,
        requireConfig: options.requireConfig
    });
}

export function getRuntimeConfig(options = {}) {
    return resolveRuntimeConfig({
        projectRoot: options.projectRoot || PROJECT_ROOT,
        configPath: options.configPath || process.env.PRINT_DRIVE_CONFIG,
        sourceDirectory: options.source || process.env.PRINT_DRIVE_SOURCE_DIR,
        encryptedOutputDirectory: options.output || process.env.PRINT_DRIVE_OUTPUT_DIR,
        requireConfig: options.requireConfig,
        requireDirectories: options.requireDirectories
    });
}

// Backwards-compatible API used by encrypt_files.mjs and set_password.mjs.
// Config and legacy environment variables select paths; the password file remains
// local-only and is intentionally not part of print-drive.config.json.
export function getConfiguredPaths(options = {}) {
    const runtime = resolveRuntimeConfig({
        projectRoot: options.projectRoot || PROJECT_ROOT,
        configPath: options.configPath || process.env.PRINT_DRIVE_CONFIG,
        sourceDirectory: options.source || process.env.PRINT_DRIVE_SOURCE_DIR,
        encryptedOutputDirectory: options.output || process.env.PRINT_DRIVE_OUTPUT_DIR,
        requireConfig: options.requireConfig,
        requireDirectories: options.requireDirectories
    });
    const passwordValue = options.passwordFile || process.env.PRINT_DRIVE_PASSWORD_FILE || '.print-drive-passphrase';
    const passwordFile = path.isAbsolute(passwordValue)
        ? path.normalize(passwordValue)
        : path.resolve(runtime.projectRoot, passwordValue);
    validatePasswordFilePath(runtime, passwordFile);
    return {
        sourceDir: runtime.sourceDirectory,
        outputDir: runtime.encryptedOutputDirectory,
        passwordFile
    };
}

function validatePasswordFilePath(runtime, passwordFile) {
    const overlaps = [runtime.sourceDirectory, runtime.encryptedOutputDirectory]
        .some((directory) => {
            const relative = path.relative(directory, passwordFile);
            return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });
    if (overlaps) {
        throw new ConfigError('The local password file must not be inside sourceDirectory or encryptedOutputDirectory.');
    }

    const relative = path.relative(runtime.projectRoot, passwordFile);
    const isInsideProject = !relative.startsWith('..') && !path.isAbsolute(relative);
    if (isInsideProject) {
        const normalized = relative.split(path.sep).join('/');
        if (normalized !== '.print-drive-passphrase' && !normalized.startsWith('.tmp/')) {
            throw new ConfigError(
                'A custom password file inside the repository is unsafe. Keep it outside the repository.'
            );
        }
    }
}

export { CONFIG_FILE_NAME };
