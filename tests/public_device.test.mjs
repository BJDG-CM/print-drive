import assert from 'node:assert/strict';
import test from 'node:test';

import { clearAppManagedBrowserData } from '../public_device.js';

function createStorage(values) {
    const data = new Map(Object.entries(values));
    return {
        get length() { return data.size; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        has(key) { return data.has(key); }
    };
}

test('public-device cleanup removes only Print Drive-owned browser state', async () => {
    const sessionStorage = createStorage({
        'print-drive-session-key-v2': 'secret',
        'another-app': 'keep'
    });
    const localStorage = createStorage({
        'print-drive-setting': 'value',
        unrelated: 'keep'
    });
    const cacheKeys = new Set(['print-drive-shell-v3', 'another-app-cache']);
    const registration = {
        active: {
            scriptURL: 'https://example.test/app/sw.js',
            postMessage() {}
        },
        async unregister() {
            this.unregistered = true;
            return true;
        }
    };

    const report = await clearAppManagedBrowserData({
        sessionStorage,
        localStorage,
        location: { href: 'https://example.test/app/' },
        caches: {
            async keys() { return [...cacheKeys]; },
            async delete(key) { cacheKeys.delete(key); return true; }
        },
        indexedDB: null,
        navigator: {
            serviceWorker: {
                async getRegistrations() { return [registration]; }
            }
        }
    });

    assert.equal(sessionStorage.has('print-drive-session-key-v2'), false);
    assert.equal(sessionStorage.has('another-app'), true);
    assert.equal(localStorage.has('print-drive-setting'), false);
    assert.equal(localStorage.has('unrelated'), true);
    assert.deepEqual([...cacheKeys], ['another-app-cache']);
    assert.equal(registration.unregistered, true);
    assert.deepEqual(report.failures, []);
    assert.ok(report.cleared.some((label) => label.includes('세션 저장소')));
    assert.ok(report.remaining.some((label) => label.includes('IndexedDB')));
});

test('public-device cleanup never rejects when browser storage getters are blocked', async () => {
    const environment = {
        get sessionStorage() { throw new DOMException('blocked', 'SecurityError'); },
        get localStorage() { throw new DOMException('blocked', 'SecurityError'); },
        get caches() { throw new DOMException('blocked', 'SecurityError'); },
        get indexedDB() { throw new DOMException('blocked', 'SecurityError'); },
        get navigator() { throw new DOMException('blocked', 'SecurityError'); }
    };

    const report = await clearAppManagedBrowserData(environment);
    assert.ok(report.failures.length >= 5);
    assert.ok(report.remaining.length >= 4);
});

test('public-device cleanup does not claim empty storage was cleared', async () => {
    const report = await clearAppManagedBrowserData({
        sessionStorage: createStorage({}),
        localStorage: createStorage({}),
        caches: { async keys() { return []; }, async delete() { return true; } },
        indexedDB: null,
        navigator: { serviceWorker: { async getRegistrations() { return []; } } },
        location: { href: 'https://example.test/app/' }
    });

    assert.deepEqual(report.cleared, []);
});
