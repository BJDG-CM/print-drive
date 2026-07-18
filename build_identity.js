export const BUILD_ID_PLACEHOLDER = '__PRINT_DRIVE_BUILD_ID__';
export const BUILD_RELOAD_KEY = 'print-drive-build-reload-v1';
export const OWNED_CACHE_PREFIX = 'print-drive-shell-';

export async function ensureCurrentBuild(options = {}) {
    const environment = options.environment || globalThis;
    const documentObject = options.document || environment.document;
    const locationObject = options.location || environment.location;
    const fetchFunction = options.fetch || environment.fetch?.bind(environment);
    const storage = options.sessionStorage || safeSessionStorage(environment);
    const shellBuildId = readShellBuildId(documentObject);

    if (!shellBuildId || shellBuildId === BUILD_ID_PLACEHOLDER || !fetchFunction || !locationObject) {
        return { status: 'development', shellBuildId: shellBuildId || null };
    }

    const metadataUrl = new URL('build-meta.json', locationObject.href);
    metadataUrl.searchParams.set('t', String(Date.now()));
    const response = await fetchFunction(metadataUrl, {
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
        const error = new Error(`build-meta.json request failed (${response.status})`);
        error.code = 'BUILD_META_UNAVAILABLE';
        error.status = response.status;
        throw error;
    }
    const metadata = await response.json();
    const deployedBuildId = validateBuildMetadata(metadata);
    if (deployedBuildId === shellBuildId) {
        storage?.removeItem?.(BUILD_RELOAD_KEY);
        return { status: 'current', shellBuildId, deployedBuildId };
    }

    await clearStaleShell(environment);
    const transition = `${shellBuildId}->${deployedBuildId}`;
    if (storage?.getItem?.(BUILD_RELOAD_KEY) === transition) {
        return { status: 'stale-after-reload', shellBuildId, deployedBuildId };
    }
    storage?.setItem?.(BUILD_RELOAD_KEY, transition);
    const reloadUrl = new URL(locationObject.href);
    reloadUrl.searchParams.set('pd-build', deployedBuildId);
    if (typeof locationObject.replace === 'function') {
        locationObject.replace(reloadUrl.href);
    } else if (typeof locationObject.reload === 'function') {
        locationObject.reload();
    }
    return { status: 'reloading', shellBuildId, deployedBuildId };
}

export function readShellBuildId(documentObject = globalThis.document) {
    return documentObject?.querySelector?.('meta[name="print-drive-build-id"]')?.content?.trim() || '';
}

export function validateBuildMetadata(value) {
    if (
        !value ||
        value.version !== 1 ||
        typeof value.buildId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.buildId)
    ) {
        const error = new Error('build-meta.json is invalid.');
        error.code = 'BUILD_META_INVALID';
        throw error;
    }
    return value.buildId;
}

export async function clearStaleShell(environment = globalThis) {
    const registrations = await environment.navigator?.serviceWorker?.getRegistrations?.() || [];
    for (const registration of registrations) {
        registration.active?.postMessage?.({ type: 'PRINT_DRIVE_CLEAR_CACHES' });
        await registration.unregister?.();
    }
    const cacheStorage = environment.caches;
    if (cacheStorage?.keys) {
        const keys = await cacheStorage.keys();
        await Promise.all(keys
            .filter((key) => key.startsWith(OWNED_CACHE_PREFIX))
            .map((key) => cacheStorage.delete(key)));
    }
}

function safeSessionStorage(environment) {
    try {
        return environment.sessionStorage;
    } catch {
        return null;
    }
}
