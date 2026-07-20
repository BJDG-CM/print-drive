// Theme preference controller.
//
// The theme mode is the only value Print Drive persists in localStorage. It is a
// non-sensitive display setting: never the session key, vault key, or password.
// The stored value is one of THEME_VALUES; anything else falls back to 'system'.
//
// The early paint is handled inline in bootstrap.js (before app.js loads) so this
// module and that inline block must agree on the storage key, the accepted values,
// and the resolved theme colors.

export const THEME_STORAGE_KEY = 'print-drive-theme';
export const THEME_VALUES = Object.freeze(['system', 'light', 'dark']);
const THEME_COLORS = Object.freeze({ light: '#ffffff', dark: '#111827' });

const changeListeners = new Set();
let systemWatchStarted = false;

export function normalizeTheme(value) {
    return THEME_VALUES.includes(value) ? value : 'system';
}

export function readStoredTheme() {
    try {
        return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
        return 'system';
    }
}

function systemPrefersDark() {
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
        return false;
    }
}

export function resolveTheme(theme) {
    const normalized = normalizeTheme(theme);
    return normalized === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : normalized;
}

function updateThemeColorMeta(resolved) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute('content', THEME_COLORS[resolved] || THEME_COLORS.light);
    }
}

export function applyTheme(theme) {
    const normalized = normalizeTheme(theme);
    const resolved = resolveTheme(normalized);
    document.documentElement.setAttribute('data-theme', normalized);
    updateThemeColorMeta(resolved);
    return { theme: normalized, resolved };
}

function notify(state) {
    changeListeners.forEach((listener) => {
        try {
            listener(state.theme, state.resolved);
        } catch {
            // A misbehaving listener must not break theme application.
        }
    });
}

function watchSystemTheme() {
    if (systemWatchStarted) {
        return;
    }
    systemWatchStarted = true;
    try {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        media.addEventListener('change', () => {
            // Only a stored 'system' preference tracks the OS. Manual light/dark stays put.
            if (readStoredTheme() !== 'system') {
                return;
            }
            notify(applyTheme('system'));
        });
    } catch {
        // Without matchMedia the CSS default still renders; nothing else to wire.
    }
}

// Persist and apply an explicit choice made by the user.
export function setTheme(value) {
    const theme = normalizeTheme(value);
    try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
        // In-memory application still succeeds when storage is blocked.
    }
    notify(applyTheme(theme));
    return theme;
}

// Restore the stored preference, keep the OS in sync for 'system', and register an
// optional callback that receives (theme, resolved) now and on every later change.
export function initTheme(onChange) {
    const theme = readStoredTheme();
    const state = applyTheme(theme);
    if (typeof onChange === 'function') {
        changeListeners.add(onChange);
        onChange(state.theme, state.resolved);
    }
    watchSystemTheme();
    return theme;
}
