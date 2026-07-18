import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BUILD_RELOAD_KEY,
    ensureCurrentBuild
} from '../build_identity.js';

const SHELL_ID = '1'.repeat(64);
const DEPLOYED_ID = '2'.repeat(64);

test('matching shell and deployment build IDs continue without cache mutation', async () => {
    const fixture = createFixture(SHELL_ID);
    const result = await ensureCurrentBuild(fixture.options);
    assert.equal(result.status, 'current');
    assert.equal(fixture.deletedCaches.length, 0);
    assert.equal(fixture.replacedUrls.length, 0);
});

test('stale shell clears owned caches and reloads exactly once', async () => {
    const fixture = createFixture(DEPLOYED_ID);
    const first = await ensureCurrentBuild(fixture.options);
    assert.equal(first.status, 'reloading');
    assert.deepEqual(fixture.deletedCaches, ['print-drive-shell-old']);
    assert.equal(fixture.unregisterCount(), 1);
    assert.equal(fixture.replacedUrls.length, 1);
    assert.match(fixture.replacedUrls[0], new RegExp(`pd-build=${DEPLOYED_ID}`));

    const second = await ensureCurrentBuild(fixture.options);
    assert.equal(second.status, 'stale-after-reload');
    assert.equal(fixture.replacedUrls.length, 1, 'the same stale transition must not create a reload loop');
    assert.equal(fixture.storage.getItem(BUILD_RELOAD_KEY), `${SHELL_ID}->${DEPLOYED_ID}`);
});

function createFixture(deployedBuildId) {
    const values = new Map();
    const storage = {
        getItem: (key) => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key)
    };
    const deletedCaches = [];
    const replacedUrls = [];
    let unregisters = 0;
    const environment = {
        navigator: {
            serviceWorker: {
                getRegistrations: async () => [{
                    active: { postMessage() {} },
                    unregister: async () => { unregisters += 1; }
                }]
            }
        },
        caches: {
            keys: async () => ['unrelated-cache', 'print-drive-shell-old'],
            delete: async (key) => { deletedCaches.push(key); }
        }
    };
    return {
        storage,
        deletedCaches,
        replacedUrls,
        unregisterCount: () => unregisters,
        options: {
            environment,
            document: { querySelector: () => ({ content: SHELL_ID }) },
            location: {
                href: 'https://example.test/print-drive/',
                replace: (value) => replacedUrls.push(value)
            },
            sessionStorage: storage,
            fetch: async () => new Response(JSON.stringify({ version: 1, buildId: deployedBuildId }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        }
    };
}
