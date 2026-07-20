const STORAGE_PREFIX = 'print-drive-';
const CACHE_PREFIX = 'print-drive-';
const KNOWN_DATABASES = ['print-drive-vault-v2', 'print-drive-preview-v1'];
// Non-sensitive display settings survive public-device cleanup: the theme mode is a
// preference, never session/vault data, so wiping it would needlessly reset the UI.
const PRESERVED_STORAGE_KEYS = new Set(['print-drive-theme']);

export async function clearAppManagedBrowserData(environment = globalThis) {
    const report = { cleared: [], failures: [], remaining: [] };

    try {
        clearStorage(
            safeProperty(environment, 'sessionStorage', '현재 탭 세션 저장소', report),
            '현재 탭 세션 저장소',
            report
        );
        clearStorage(
            safeProperty(environment, 'localStorage', 'Print Drive 로컬 저장소', report),
            'Print Drive 로컬 저장소',
            report
        );

        await clearCaches(environment, report);
        await clearIndexedDb(environment, report);
        await clearServiceWorkers(environment, report);
    } catch (error) {
        // Cleanup is a best-effort boundary: callers must always receive an honest report.
        report.failures.push(`예상하지 못한 정리 오류: ${safeMessage(error)}`);
    }

    return report;
}

function safeProperty(object, property, label, report) {
    try {
        return object?.[property] ?? null;
    } catch (error) {
        report.failures.push(`${label} 접근 실패: ${safeMessage(error)}`);
        return null;
    }
}

function clearStorage(storage, label, report) {
    if (!storage) {
        report.remaining.push(`${label} API를 사용할 수 없어 앱 저장값이 없는지 확인하지 못함`);
        return;
    }
    try {
        const owned = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key?.startsWith(STORAGE_PREFIX) && !PRESERVED_STORAGE_KEYS.has(key)) {
                owned.push(key);
            }
        }
        owned.forEach((key) => storage.removeItem(key));
        if (owned.length > 0) {
            report.cleared.push(`${label} (${owned.length}개 앱 항목)`);
        }
    } catch (error) {
        report.failures.push(`${label}: ${safeMessage(error)}`);
    }
}

async function clearCaches(environment, report) {
    const cacheStorage = safeProperty(environment, 'caches', 'Cache Storage', report);
    if (!cacheStorage?.keys || !cacheStorage?.delete) {
        report.remaining.push('Cache Storage API를 사용할 수 없어 Print Drive 캐시 유무를 확인하지 못함');
        return;
    }
    try {
        const keys = await cacheStorage.keys();
        const owned = keys.filter((key) => key.startsWith(CACHE_PREFIX));
        const results = await Promise.all(owned.map((key) => cacheStorage.delete(key)));
        const removed = results.filter(Boolean).length;
        if (removed > 0) {
            report.cleared.push(`Print Drive 캐시 (${removed}개)`);
        }
        if (removed !== owned.length) {
            report.failures.push(`Print Drive 캐시: ${owned.length - removed}개 삭제 결과를 확인하지 못함`);
        }
    } catch (error) {
        report.failures.push(`Print Drive 캐시: ${safeMessage(error)}`);
    }
}

async function clearIndexedDb(environment, report) {
    const indexedDb = safeProperty(environment, 'indexedDB', 'IndexedDB', report);
    if (!indexedDb?.deleteDatabase) {
        report.remaining.push('IndexedDB API를 사용할 수 없어 Print Drive 데이터베이스 유무를 확인하지 못함');
        return;
    }

    try {
        let names;
        if (typeof indexedDb.databases === 'function') {
            const databases = await indexedDb.databases();
            names = [...new Set(databases
                .map((database) => database?.name)
                .filter((name) => typeof name === 'string' && name.startsWith(STORAGE_PREFIX)))];
        } else {
            names = [...KNOWN_DATABASES];
            report.remaining.push('브라우저가 IndexedDB 목록 조회를 지원하지 않아 알려진 DB만 삭제 요청함');
        }

        await Promise.all(names.map((name) => deleteDatabase(indexedDb, name)));
        if (names.length > 0) {
            const label = typeof indexedDb.databases === 'function'
                ? `Print Drive IndexedDB (${names.length}개)`
                : `알려진 Print Drive IndexedDB 삭제 요청 (${names.length}개)`;
            report.cleared.push(label);
        }
    } catch (error) {
        report.failures.push(`Print Drive IndexedDB: ${safeMessage(error)}`);
    }
}

async function clearServiceWorkers(environment, report) {
    const navigatorObject = safeProperty(environment, 'navigator', '서비스 워커', report);
    const serviceWorker = safeProperty(navigatorObject, 'serviceWorker', '서비스 워커', report);
    if (!serviceWorker?.getRegistrations) {
        report.remaining.push('서비스 워커 API를 사용할 수 없어 Print Drive 등록 유무를 확인하지 못함');
        return;
    }

    try {
        const locationObject = safeProperty(environment, 'location', '현재 주소', report);
        const expectedScript = locationObject
            ? new URL('./sw.js', locationObject.href).href
            : null;
        const registrations = await serviceWorker.getRegistrations();
        const owned = registrations.filter((registration) => isOwnedServiceWorker(registration, expectedScript));
        owned.forEach((registration) => {
            registration.active?.postMessage?.({ type: 'PRINT_DRIVE_CLEAR_CACHES' });
        });
        const results = await Promise.all(owned.map((registration) => registration.unregister()));
        const removed = results.filter(Boolean).length;
        if (removed > 0) {
            report.cleared.push(`Print Drive 서비스 워커 등록 (${removed}개)`);
        }
        if (removed !== owned.length) {
            report.failures.push(`Print Drive 서비스 워커: ${owned.length - removed}개 등록 해제 결과를 확인하지 못함`);
        }

        const controllerUrl = serviceWorker.controller?.scriptURL || '';
        if (controllerUrl && (expectedScript ? controllerUrl === expectedScript : /\/sw\.js(?:$|\?)/.test(controllerUrl))) {
            report.remaining.push('현재 페이지를 제어하던 Print Drive 서비스 워커는 등록 해제 후에도 이 페이지를 벗어날 때까지 제어할 수 있음');
        }
    } catch (error) {
        report.failures.push(`Print Drive 서비스 워커: ${safeMessage(error)}`);
    }
}

function isOwnedServiceWorker(registration, expectedScript) {
    const scriptUrl = registration.active?.scriptURL
        || registration.waiting?.scriptURL
        || registration.installing?.scriptURL;
    return expectedScript ? scriptUrl === expectedScript : /\/sw\.js(?:$|\?)/.test(scriptUrl || '');
}

function deleteDatabase(indexedDb, name) {
    return new Promise((resolve, reject) => {
        const request = indexedDb.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error(`Could not delete ${name}`));
        request.onblocked = () => reject(new Error(`${name} deletion was blocked`));
    });
}

function safeMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
