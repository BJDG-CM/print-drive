import assert from 'node:assert/strict';
import test from 'node:test';
import {
    THEME_STORAGE_KEY,
    THEME_VALUES,
    applyTheme,
    initTheme,
    normalizeTheme,
    readStoredTheme,
    resolveTheme,
    setTheme
} from '../theme.js';

// theme.js reads its globals (window, document, localStorage) lazily inside each
// function, so tests install a minimal browser shim, run, then restore the previous
// globals. The suite runs with --test-isolation=none, so leaving no globals behind
// keeps the other test files clean.
function installEnv({ stored, prefersDark = false } = {}) {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        localStorage: globalThis.localStorage
    };
    const store = new Map();
    if (stored !== undefined) {
        store.set(THEME_STORAGE_KEY, stored);
    }
    const rootAttrs = {};
    const metaAttrs = { name: 'theme-color', content: '#unset' };
    const mediaListeners = [];
    const media = {
        matches: Boolean(prefersDark),
        addEventListener: (type, callback) => {
            if (type === 'change') {
                mediaListeners.push(callback);
            }
        }
    };

    globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key)
    };
    globalThis.window = { matchMedia: () => media };
    globalThis.document = {
        documentElement: {
            setAttribute: (key, value) => { rootAttrs[key] = value; },
            getAttribute: (key) => (key in rootAttrs ? rootAttrs[key] : null)
        },
        querySelector: (selector) => (
            selector.includes('theme-color')
                ? {
                    setAttribute: (key, value) => { metaAttrs[key] = value; },
                    getAttribute: (key) => (key in metaAttrs ? metaAttrs[key] : null)
                }
                : null
        )
    };

    const restore = () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete globalThis[key];
            } else {
                globalThis[key] = value;
            }
        }
    };
    return { store, rootAttrs, metaAttrs, media, fireMediaChange: () => mediaListeners.forEach((cb) => cb()), restore };
}

test('theme values and storage key are the expected non-sensitive set', () => {
    assert.deepEqual([...THEME_VALUES], ['system', 'light', 'dark']);
    assert.equal(THEME_STORAGE_KEY, 'print-drive-theme');
});

test('normalizeTheme keeps valid modes and rejects anything else to system', () => {
    for (const value of ['system', 'light', 'dark']) {
        assert.equal(normalizeTheme(value), value);
    }
    for (const value of ['', 'SYSTEM', 'blue', null, undefined, 0, {}]) {
        assert.equal(normalizeTheme(value), 'system');
    }
});

test('readStoredTheme restores each stored mode', () => {
    for (const value of ['light', 'dark', 'system']) {
        const env = installEnv({ stored: value });
        try {
            assert.equal(readStoredTheme(), value);
        } finally {
            env.restore();
        }
    }
});

test('readStoredTheme treats a corrupt stored value as system', () => {
    const env = installEnv({ stored: 'not-a-theme' });
    try {
        assert.equal(readStoredTheme(), 'system');
    } finally {
        env.restore();
    }
});

test('readStoredTheme falls back to system when storage throws', () => {
    const previous = globalThis.localStorage;
    globalThis.localStorage = {
        get length() { throw new Error('blocked'); },
        getItem() { throw new Error('blocked'); }
    };
    try {
        assert.equal(readStoredTheme(), 'system');
    } finally {
        if (previous === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = previous;
        }
    }
});

test('applyTheme sets data-theme and a matching theme-color for each mode', () => {
    const light = installEnv({ prefersDark: false });
    try {
        assert.deepEqual(applyTheme('light'), { theme: 'light', resolved: 'light' });
        assert.equal(light.rootAttrs['data-theme'], 'light');
        assert.equal(light.metaAttrs.content, '#ffffff');

        assert.deepEqual(applyTheme('dark'), { theme: 'dark', resolved: 'dark' });
        assert.equal(light.rootAttrs['data-theme'], 'dark');
        assert.equal(light.metaAttrs.content, '#111827');
    } finally {
        light.restore();
    }
});

test('system mode resolves against the OS preference for color and meta', () => {
    const dark = installEnv({ prefersDark: true });
    try {
        assert.equal(resolveTheme('system'), 'dark');
        assert.deepEqual(applyTheme('system'), { theme: 'system', resolved: 'dark' });
        assert.equal(dark.rootAttrs['data-theme'], 'system');
        assert.equal(dark.metaAttrs.content, '#111827');
    } finally {
        dark.restore();
    }

    const lightSystem = installEnv({ prefersDark: false });
    try {
        assert.equal(resolveTheme('system'), 'light');
        assert.equal(applyTheme('system').resolved, 'light');
        assert.equal(lightSystem.metaAttrs.content, '#ffffff');
    } finally {
        lightSystem.restore();
    }
});

test('setTheme persists the choice and applies it', () => {
    const env = installEnv({ prefersDark: true });
    try {
        assert.equal(setTheme('light'), 'light');
        assert.equal(env.store.get(THEME_STORAGE_KEY), 'light');
        assert.equal(env.rootAttrs['data-theme'], 'light');
        assert.equal(env.metaAttrs.content, '#ffffff');

        assert.equal(setTheme('bogus'), 'system', 'unknown input normalizes to system');
        assert.equal(env.store.get(THEME_STORAGE_KEY), 'system');
    } finally {
        env.restore();
    }
});

// initTheme registers the module-level OS watcher exactly once, so this is the only
// test that calls it; it exercises both the system-follows-OS and manual-ignores-OS
// paths within one environment.
test('initTheme follows the OS in system mode and pins to a manual choice', () => {
    const env = installEnv({ stored: 'system', prefersDark: false });
    const seen = [];
    try {
        const restored = initTheme((theme, resolved) => seen.push([theme, resolved]));
        assert.equal(restored, 'system');
        assert.equal(env.rootAttrs['data-theme'], 'system');
        assert.equal(env.metaAttrs.content, '#ffffff');
        assert.deepEqual(seen.at(-1), ['system', 'light']);

        // OS flips to dark while still in system mode: colors track it.
        env.media.matches = true;
        env.fireMediaChange();
        assert.equal(env.metaAttrs.content, '#111827');
        assert.deepEqual(seen.at(-1), ['system', 'dark']);

        // Switch to a manual light choice, then flip the OS again: the choice holds.
        setTheme('light');
        assert.equal(env.metaAttrs.content, '#ffffff');
        env.media.matches = false;
        env.fireMediaChange();
        assert.equal(env.rootAttrs['data-theme'], 'light');
        assert.equal(env.metaAttrs.content, '#ffffff', 'manual light must ignore the OS change');
    } finally {
        env.restore();
    }
});
