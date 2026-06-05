#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, displayPath } from '../paths.mjs';
import { assertPublicFilesClean, isAllowedPublicFileName } from '../public_files_guard.mjs';
import { assertDistClean } from './check_dist.mjs';

const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const FILES_DIR = path.join(PROJECT_ROOT, 'files');
const DIST_ALLOWED_ENTRIES = new Set(['index.html', 'manifest.json', 'icon.svg', 'robots.txt', 'sw.js', 'files']);

async function main() {
    await assertPublicFilesClean(FILES_DIR, { displayDir: displayPath(FILES_DIR) });

    await mkdir(DIST_DIR, { recursive: true });
    await removeUnexpectedDistEntries();

    await writeFile(path.join(DIST_DIR, 'index.html'), await buildIndexHtml(), 'utf8');

    for (const file of ['manifest.json', 'icon.svg', 'robots.txt', 'sw.js']) {
        await copyFile(path.join(PROJECT_ROOT, file), path.join(DIST_DIR, file));
    }

    await syncFilesDirectory(FILES_DIR, path.join(DIST_DIR, 'files'));
    await assertDistClean(DIST_DIR);
    console.log(`Built GitHub Pages artifact in ${displayPath(DIST_DIR)}.`);
}

async function removeUnexpectedDistEntries() {
    const entries = await readdir(DIST_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (DIST_ALLOWED_ENTRIES.has(entry.name)) {
            continue;
        }
        await rm(path.join(DIST_DIR, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

async function syncFilesDirectory(sourceDir, targetDir) {
    await mkdir(targetDir, { recursive: true });

    const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
    const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
    const targetEntries = await readdir(targetDir, { withFileTypes: true });

    for (const entry of targetEntries) {
        if (!sourceNames.has(entry.name) && !isAllowedPublicFileName(entry.name)) {
            await rm(path.join(targetDir, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
    }

    for (const entry of sourceEntries) {
        if (!entry.isFile()) {
            continue;
        }
        await copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    }
}

async function buildIndexHtml() {
    let html = await readFile(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
    const css = await readFile(path.join(PROJECT_ROOT, 'styles.css'), 'utf8');
    const js = await bundleModule(path.join(PROJECT_ROOT, 'app.js'));

    html = html.replace(
        /<link rel="stylesheet" href="styles\.css">/,
        () => `<style>\n${indent(css.trimEnd(), 8)}\n    </style>`
    );
    html = html.replace(
        /<script type="module" src="app\.js"><\/script>/,
        () => `<script type="module">\n${indent(js.trimEnd(), 8)}\n    </script>`
    );

    return html;
}

async function bundleModule(filePath, seen = new Set()) {
    const normalizedPath = path.normalize(filePath);
    if (seen.has(normalizedPath)) {
        return '';
    }
    seen.add(normalizedPath);

    const source = await readFile(normalizedPath, 'utf8');
    const importRegex = /import\s+[\s\S]*?\s+from\s+['"](.+?)['"];\s*/g;
    const dependencyPaths = [];
    let match;

    while ((match = importRegex.exec(source)) !== null) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) {
            throw new Error(`Unsupported browser import in ${displayPath(normalizedPath)}: ${specifier}`);
        }
        dependencyPaths.push(path.resolve(path.dirname(normalizedPath), specifier));
    }

    const dependencies = [];
    for (const dependencyPath of dependencyPaths) {
        dependencies.push(await bundleModule(dependencyPath, seen));
    }

    const body = source
        .replace(importRegex, '')
        .replace(/^export\s+(async\s+function|function|const|let|var|class)\s+/gm, '$1 ')
        .replace(/^export\s+\{[\s\S]*?\};?\s*$/gm, '');

    return [...dependencies, `// ${displayPath(normalizedPath)}\n${body.trimEnd()}`]
        .filter(Boolean)
        .join('\n\n');
}

function indent(value, spaces) {
    const prefix = ' '.repeat(spaces);
    return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
