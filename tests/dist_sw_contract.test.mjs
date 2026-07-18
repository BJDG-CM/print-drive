import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectBrowserAssets } from '../scripts/dist_contract.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('service worker shell exactly covers the offline browser asset graph', async () => {
    const browserAssets = await collectBrowserAssets(PROJECT_ROOT);
    const swSource = await readFile(path.join(PROJECT_ROOT, 'sw.js'), 'utf8');
    const declaration = swSource.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    assert(declaration, 'sw.js must declare a literal SHELL_ASSETS array');

    const values = [...declaration[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    assert.equal(values.length, new Set(values).size, 'SHELL_ASSETS must not contain duplicates');
    assert(values.every((value) => !value.startsWith('./files/')), 'encrypted file objects must never be precached');

    const expected = new Set(['./']);
    for (const asset of browserAssets) {
        if (!['robots.txt', 'sw.js'].includes(asset)) {
            expected.add(`./${asset}`);
        }
    }
    assert.deepEqual([...new Set(values)].sort(), [...expected].sort());
});
