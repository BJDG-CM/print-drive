#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

async function main() {
    const names = (await readdir(WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name));
    const violations = [];
    for (const name of names) {
        const source = await readFile(path.join(WORKFLOW_DIR, name), 'utf8');
        for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)) {
            const reference = match[1];
            const separator = reference.lastIndexOf('@');
            const revision = separator >= 0 ? reference.slice(separator + 1) : '';
            if (!FULL_SHA_RE.test(revision)) {
                violations.push(`${name}: action ${reference} is not pinned to a 40-character commit SHA`);
            }
        }
        if (/actions\/checkout@/.test(source) && !/persist-credentials:\s*false/.test(source)) {
            violations.push(`${name}: checkout must set persist-credentials: false`);
        }
    }
    if (violations.length > 0) {
        throw new Error(`Workflow hardening check failed:\n${violations.map((value) => `- ${value}`).join('\n')}`);
    }
    console.log(`Workflow hardening check passed for ${names.length} workflow(s); every action is SHA-pinned.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
