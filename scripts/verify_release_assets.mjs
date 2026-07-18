#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RELEASE_ASSETS = Object.freeze([
    'PrintDrive-Portable-windows-x64.zip',
    'PrintDrive-Portable-windows-x64.zip.sha256'
]);

export function validateReleaseMetadata(release, expectedTag = null) {
    if (!release || release.draft || release.prerelease) throw new Error('Release must be published, non-draft, and non-prerelease.');
    if (expectedTag && release.tag_name !== expectedTag) throw new Error(`Release tag mismatch: expected ${expectedTag}, found ${release.tag_name}.`);
    const names = (release.assets || []).map((asset) => asset.name).sort();
    const expected = [...RELEASE_ASSETS].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Release must contain exactly: ${expected.join(', ')}.`);
    for (const asset of release.assets) {
        if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`Release asset is empty: ${asset.name}.`);
        if (!/^https:\/\//.test(asset.browser_download_url || '')) throw new Error(`Release asset URL is invalid: ${asset.name}.`);
    }
    return new Map(release.assets.map((asset) => [asset.name, asset]));
}

export function parseChecksumSidecar(text) {
    const match = String(text).trim().match(/^([0-9a-f]{64})\s+\*?PrintDrive-Portable-windows-x64\.zip$/);
    if (!match) throw new Error('Checksum sidecar has an invalid filename or SHA-256 format.');
    return match[1];
}

export async function verifyPublishedRelease(options = {}) {
    const fetchFunction = options.fetchFunction || globalThis.fetch;
    const repository = options.repository || 'BJDG-CM/print-drive';
    const expectedTag = options.tag || null;
    const apiBase = options.apiBase || 'https://api.github.com';
    const delay = options.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const attempts = options.attempts ?? 8;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const endpoint = expectedTag ? `/repos/${repository}/releases/tags/${encodeURIComponent(expectedTag)}` : `/repos/${repository}/releases/latest`;
            const release = await fetchJson(new URL(endpoint, apiBase), fetchFunction);
            const assets = validateReleaseMetadata(release, expectedTag);
            const archive = await fetchBytes(assets.get(RELEASE_ASSETS[0]).browser_download_url, fetchFunction);
            const sidecar = await fetchBytes(assets.get(RELEASE_ASSETS[1]).browser_download_url, fetchFunction);
            const expected = parseChecksumSidecar(Buffer.from(sidecar).toString('utf8'));
            const actual = createHash('sha256').update(archive).digest('hex');
            if (actual !== expected) throw new Error(`Published ZIP checksum mismatch: expected ${expected}, found ${actual}.`);
            return {
                releaseUrl: release.html_url,
                tag: release.tag_name,
                archiveUrl: assets.get(RELEASE_ASSETS[0]).browser_download_url,
                checksumUrl: assets.get(RELEASE_ASSETS[1]).browser_download_url,
                size: archive.byteLength,
                sha256: actual
            };
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await delay(Math.min(30000, 2000 * attempt));
        }
    }
    throw new Error(`Published release verification failed after ${attempts} attempt(s): ${lastError?.message || 'unknown error'}`);
}

async function fetchJson(url, fetchFunction) {
    const response = await fetchFunction(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Print-Drive-release-verifier' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`GitHub release API HTTP ${response.status}.`);
    return response.json();
}

async function fetchBytes(url, fetchFunction) {
    const response = await fetchFunction(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Print-Drive-release-verifier' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`Release download HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
}

function parseArgs(args) {
    const result = {};
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--tag' && args[index + 1]) result.tag = args[++index];
        else if (args[index] === '--repository' && args[index + 1]) result.repository = args[++index];
        else throw new Error(`Unknown or incomplete option: ${args[index]}`);
    }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    verifyPublishedRelease(parseArgs(process.argv.slice(2)))
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => { console.error(error.message); process.exit(1); });
}
