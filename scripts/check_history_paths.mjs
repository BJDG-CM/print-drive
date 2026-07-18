#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbiddenTrackedPaths } from './check_tracked_leaks.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const KNOWN_PLAINTEXT_OUTPUT_COUNT = 11;
const KNOWN_PLAINTEXT_OUTPUT_DIGEST = '68efaaf2045c96fa840580f4e8759cf5de0cc99e264cb1f4c75aaa81d8b90772';
const ENCRYPTED_OUTPUT_PATH_RE = /^files\/(?:[0-9a-f]{32}\.bin|manifest\.enc|\.gitkeep)$/;

function main() {
    const result = spawnSync('git', ['-c', 'core.quotepath=false', 'log', '--all', '--name-only', '--format=', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.error) {
        throw new Error(`Could not launch Git history scan: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`Git history path scan failed: ${(result.stderr || result.stdout || 'unknown Git error').trim()}`);
    }
    const paths = [...new Set(result.stdout
        .split('\0')
        .map((value) => value.replace(/^[\r\n]+|[\r\n]+$/g, ''))
        .filter(Boolean))];
    const violations = findForbiddenTrackedPaths(paths);
    if (violations.length > 0) {
        throw new Error(
            `Git history path scan found ${violations.length} prohibited private/passphrase/environment path(s). `
            + 'No history was rewritten; follow docs/RECOVERY.md after making a backup.'
        );
    }
    const plaintextOutputPaths = paths
        .filter((value) => value.startsWith('files/') && !ENCRYPTED_OUTPUT_PATH_RE.test(value))
        .sort();
    const findingDigest = createHash('sha256')
        .update(JSON.stringify(plaintextOutputPaths))
        .digest('hex');
    if (
        plaintextOutputPaths.length !== KNOWN_PLAINTEXT_OUTPUT_COUNT ||
        findingDigest !== KNOWN_PLAINTEXT_OUTPUT_DIGEST
    ) {
        throw new Error(
            `Git history plaintext-output finding changed (count=${plaintextOutputPaths.length}, digest=${findingDigest}). `
            + 'Review the history incident before updating the acknowledged baseline; no history was rewritten.'
        );
    }
    console.warn(
        `Known security finding: Git history contains ${KNOWN_PLAINTEXT_OUTPUT_COUNT} acknowledged plaintext-output path(s) `
        + `(path-set digest ${KNOWN_PLAINTEXT_OUTPUT_DIGEST}). See SECURITY.md and docs/RECOVERY.md.`
    );
    console.log('Git history path baseline passed. This filename audit does not prove that other historical blob contents are plaintext-free.');
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
