import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE_NAME = 'print-drive.config.json';
export const CONFIG_SCHEMA_FILE_NAME = 'print-drive.config.schema.json';

export const DEFAULT_CONFIG = Object.freeze({
    sourceDirectory: 'private_files',
    encryptedOutputDirectory: 'files',
    autoSync: true,
    allowedBranch: 'main',
    remote: 'origin'
});

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const SENSITIVE_KEY_RE = /(pass(word|phrase)?|secret|token|credential|private.?key|github.?pat)/i;
const SAFE_GIT_NAME_RE = /^(?!-)(?!.*(?:\.\.|@\{|[\x00-\x20~^:?*\[\\]))[^/]+(?:\/[^/]+)*$/;

export class ConfigError extends Error {
    constructor(message, details = []) {
        super([message, ...details.map((detail) => `- ${detail}`)].join('\n'));
        this.name = 'ConfigError';
        this.details = details;
    }
}

export function parseConfigText(text, displayName = CONFIG_FILE_NAME) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new ConfigError(`${displayName} is not valid JSON: ${error.message}`);
    }
    return validateConfigObject(parsed, displayName);
}

export function validateConfigObject(value, displayName = CONFIG_FILE_NAME) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigError(`${displayName} must contain one JSON object.`);
    }

    for (const key of Object.keys(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            errors.push(`${key} is forbidden; passwords, tokens, and secrets must never be stored in config`);
        } else if (!ALLOWED_KEYS.has(key)) {
            errors.push(`${key} is not a supported setting`);
        }
    }

    for (const key of ['sourceDirectory', 'encryptedOutputDirectory', 'allowedBranch', 'remote']) {
        if (typeof value[key] !== 'string' || !value[key].trim()) {
            errors.push(`${key} must be a non-empty string`);
        } else if (/\x00|[\r\n]/.test(value[key])) {
            errors.push(`${key} must not contain NUL or newline characters`);
        }
    }

    if (typeof value.autoSync !== 'boolean') {
        errors.push('autoSync must be a boolean');
    }

    if (typeof value.allowedBranch === 'string' && !SAFE_GIT_NAME_RE.test(value.allowedBranch)) {
        errors.push('allowedBranch is not a safe Git branch name');
    }
    if (typeof value.remote === 'string' && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.remote)) {
        errors.push('remote must contain only letters, numbers, dot, underscore, or hyphen');
    }

    if (errors.length > 0) {
        throw new ConfigError(`${displayName} failed validation.`, errors);
    }

    return Object.freeze({
        sourceDirectory: value.sourceDirectory.trim(),
        encryptedOutputDirectory: value.encryptedOutputDirectory.trim(),
        autoSync: value.autoSync,
        allowedBranch: value.allowedBranch.trim(),
        remote: value.remote.trim()
    });
}

export function loadProjectConfig(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    const configPath = path.resolve(options.configPath || path.join(projectRoot, CONFIG_FILE_NAME));

    if (!existsSync(configPath)) {
        if (options.requireConfig) {
            throw new ConfigError(`${configPath} does not exist. Run the config setup command first.`);
        }
        return { config: DEFAULT_CONFIG, configPath, fromFile: false };
    }

    const config = parseConfigText(readFileSync(configPath, 'utf8'), configPath);
    return { config, configPath, fromFile: true };
}

export function resolveRuntimeConfig(options = {}) {
    const projectRoot = canonicalizePath(options.projectRoot || process.cwd(), { mustExist: true });
    const loaded = options.config
        ? { config: validateConfigObject(options.config), configPath: options.configPath || null, fromFile: false }
        : loadProjectConfig({
            projectRoot,
            configPath: options.configPath,
            requireConfig: options.requireConfig
        });
    const config = loaded.config;
    const sourceRaw = options.sourceDirectory || config.sourceDirectory;
    const outputRaw = options.encryptedOutputDirectory || config.encryptedOutputDirectory;
    const sourceDirectory = canonicalizePath(resolveFrom(projectRoot, sourceRaw), {
        mustExist: options.requireDirectories === true,
        mustBeDirectory: options.requireDirectories === true
    });
    const encryptedOutputDirectory = canonicalizePath(resolveFrom(projectRoot, outputRaw), {
        mustExist: options.requireDirectories === true,
        mustBeDirectory: options.requireDirectories === true
    });

    validatePathPolicy({ projectRoot, sourceDirectory, encryptedOutputDirectory });

    return Object.freeze({
        projectRoot,
        configPath: loaded.configPath,
        fromFile: loaded.fromFile,
        sourceDirectory,
        encryptedOutputDirectory,
        autoSync: config.autoSync,
        allowedBranch: config.allowedBranch,
        remote: config.remote
    });
}

export function validatePathPolicy({ projectRoot, sourceDirectory, encryptedOutputDirectory }) {
    const errors = [];
    const root = canonicalizePath(projectRoot, { mustExist: true });
    const source = canonicalizePath(sourceDirectory);
    const output = canonicalizePath(encryptedOutputDirectory);

    if (samePath(root, output)) {
        errors.push('encryptedOutputDirectory must not be the repository root');
    } else if (!isInside(root, output)) {
        errors.push('encryptedOutputDirectory must stay inside the repository');
    }

    const relativeOutput = path.relative(root, output);
    const firstOutputSegment = relativeOutput.split(path.sep)[0].toLowerCase();
    if (['.git', 'dist', 'node_modules'].includes(firstOutputSegment)) {
        errors.push(`encryptedOutputDirectory must not be inside reserved path ${firstOutputSegment}`);
    }

    if (samePath(source, output)) {
        errors.push('sourceDirectory and encryptedOutputDirectory must be different');
    } else if (isInside(source, output) || isInside(output, source)) {
        errors.push('sourceDirectory and encryptedOutputDirectory must not overlap');
    }

    const ignoredSourceRoots = [
        canonicalizePath(path.join(root, DEFAULT_CONFIG.sourceDirectory)),
        canonicalizePath(path.join(root, '.tmp'))
    ];
    const sourceIsIgnored = ignoredSourceRoots.some((ignoredRoot) =>
        samePath(source, ignoredRoot) || isInside(ignoredRoot, source));
    if (isInside(root, source) && !sourceIsIgnored) {
        errors.push('sourceDirectory inside the repository must stay under ignored private_files or .tmp; use a path outside the repository for any other source');
    }

    if (errors.length > 0) {
        throw new ConfigError('Configured paths failed safety validation.', errors);
    }
}

export function canonicalizePath(value, options = {}) {
    const absolute = path.resolve(value);
    if (existsSync(absolute)) {
        if (options.mustBeDirectory && !lstatSync(absolute).isDirectory()) {
            throw new ConfigError(`${absolute} must be a directory.`);
        }
        return path.normalize(realpathSync.native(absolute));
    }

    if (options.mustExist) {
        throw new ConfigError(`${absolute} does not exist.`);
    }

    const missing = [];
    let cursor = absolute;
    while (!existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            throw new ConfigError(`Could not resolve an existing parent for ${absolute}.`);
        }
        missing.unshift(path.basename(cursor));
        cursor = parent;
    }

    const canonicalParent = realpathSync.native(cursor);
    return path.normalize(path.join(canonicalParent, ...missing));
}

export function isInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function samePath(first, second) {
    const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalizeCase(path.normalize(first)) === normalizeCase(path.normalize(second));
}

function resolveFrom(projectRoot, value) {
    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}
