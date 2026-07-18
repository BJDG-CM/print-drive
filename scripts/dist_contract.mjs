import { access, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_STATIC_ASSETS = ['index.html', 'manifest.json', 'icon.svg', 'robots.txt', 'sw.js'];
const OPTIONAL_SECURITY_MODULES = ['bootstrap.js', 'capability.js', 'public_device.js'];
const RESERVED_FIRST_SEGMENTS = new Set(['files', 'private_files', 'dist', '.git', '.tmp', 'scripts', 'tests', 'node_modules']);

export async function collectBrowserAssets(projectRoot) {
    const root = path.resolve(projectRoot);
    const indexSource = await readBrowserText(root, 'index.html');
    if (/<style(?:\s|>)/i.test(indexSource)) {
        throw new Error('index.html must use an external stylesheet; inline <style> blocks are not allowed in dist.');
    }
    if (/<[^>]+\sstyle\s*=/i.test(indexSource)) {
        throw new Error('index.html must not use inline style attributes.');
    }
    if (/<[^>]+\son[a-z][a-z0-9:_-]*\s*=/i.test(indexSource)) {
        throw new Error('index.html must not use inline event-handler attributes.');
    }

    const stylesheetHrefs = [...indexSource.matchAll(/<link\b[^>]*>/gi)]
        .filter((match) => (readHtmlAttribute(match[0], 'rel') || '').split(/\s+/).includes('stylesheet'))
        .map((match) => readHtmlAttribute(match[0], 'href'));
    const scriptSources = [...indexSource.matchAll(/<script\b[^>]*>/gi)]
        .map((match) => readHtmlAttribute(match[0], 'src'));
    if (scriptSources.some((source) => !source)) {
        throw new Error('index.html must use external scripts; inline <script> blocks are not allowed in dist.');
    }
    if (stylesheetHrefs.length === 0 || scriptSources.length === 0) {
        throw new Error('index.html must reference at least one external stylesheet and one external script.');
    }

    const assets = new Set(REQUIRED_STATIC_ASSETS);
    for (const href of stylesheetHrefs) {
        if (!href) {
            throw new Error('Stylesheet links must include a quoted href.');
        }
        const relative = normalizeLocalAsset(href, 'stylesheet');
        assets.add(relative);
        await collectCssDependencies(root, relative, assets);
    }
    for (const source of scriptSources) {
        const relative = normalizeLocalAsset(source, 'script');
        await collectModuleGraph(root, relative, assets);
    }
    for (const optional of OPTIONAL_SECURITY_MODULES) {
        try {
            await access(path.join(root, optional));
            await collectModuleGraph(root, optional, assets);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    for (const relative of assets) {
        validateAssetBoundary(root, relative);
        const assetStat = await lstat(path.join(root, relative));
        if (assetStat.isSymbolicLink()) {
            throw new Error(`Browser asset ${relative} must not be a symbolic link.`);
        }
        if (!assetStat.isFile()) {
            throw new Error(`Browser asset ${relative} must be a regular file.`);
        }
    }
    return new Set([...assets].sort());
}

async function collectModuleGraph(root, relativePath, assets, seen = new Set()) {
    const normalized = normalizeLocalAsset(relativePath, 'module');
    if (seen.has(normalized)) {
        return;
    }
    seen.add(normalized);
    validateAssetBoundary(root, normalized);
    const source = await readBrowserText(root, normalized);
    assets.add(normalized);

    const specifiers = new Set();
    const directImportRegex = /\bimport\s*(?:\(\s*)?["']([^"']+)["']/g;
    const fromImportRegex = /\b(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/g;
    for (const regex of [directImportRegex, fromImportRegex]) {
        let match;
        while ((match = regex.exec(source)) !== null) {
            specifiers.add(match[1]);
        }
    }
    for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) {
            throw new Error(`Browser module ${normalized} uses unsupported external import ${specifier}.`);
        }
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), specifier));
        await collectModuleGraph(root, dependency, assets, seen);
    }
}

function readHtmlAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
    return match ? match[2] : null;
}

async function collectCssDependencies(root, relativePath, assets) {
    const source = await readBrowserText(root, relativePath);
    const urlRegex = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let match;
    while ((match = urlRegex.exec(source)) !== null) {
        const specifier = match[1].trim();
        if (/^(?:data:|https?:|#)/i.test(specifier)) {
            continue;
        }
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
        validateAssetBoundary(root, dependency);
        assets.add(dependency);
    }
}

function normalizeLocalAsset(value, kind) {
    if (!value || /^(?:[a-z]+:|\/\/|\/|\\)/i.test(value) || value.includes('?') || value.includes('#')) {
        throw new Error(`${kind} asset must be one local relative path without query or fragment: ${value}`);
    }
    const normalized = path.posix.normalize(value.replace(/\\/g, '/').replace(/^\.\//, ''));
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        throw new Error(`${kind} asset escapes the project root: ${value}`);
    }
    return normalized;
}

function validateAssetBoundary(root, relative) {
    const normalized = normalizeLocalAsset(relative, 'browser');
    const first = normalized.split('/')[0];
    if (RESERVED_FIRST_SEGMENTS.has(first)) {
        throw new Error(`Browser asset ${relative} is inside reserved path ${first}.`);
    }
    const absolute = path.resolve(root, ...normalized.split('/'));
    const boundary = path.relative(root, absolute);
    if (!boundary || boundary.startsWith('..') || path.isAbsolute(boundary)) {
        if (normalized !== 'index.html') {
            throw new Error(`Browser asset ${relative} is outside the project root.`);
        }
    }
}

async function readBrowserText(root, relative) {
    validateAssetBoundary(root, relative);
    const absolute = path.join(root, ...relative.split('/'));
    const assetStat = await lstat(absolute);
    if (assetStat.isSymbolicLink()) {
        throw new Error(`Browser asset ${relative} must not be a symbolic link.`);
    }
    if (!assetStat.isFile()) {
        throw new Error(`Browser asset ${relative} must be a regular file.`);
    }
    return readFile(absolute, 'utf8');
}
