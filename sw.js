const CACHE_PREFIX = 'print-drive-shell-';
const BUILD_ID = '__PRINT_DRIVE_BUILD_ID__';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const SHELL_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './bootstrap.js',
    './build_identity.js',
    './app.js',
    './theme.js',
    './crypto.js',
    './file_errors.js',
    './folder_browser.js',
    './logical_path.js',
    './capability.js',
    './public_device.js',
    './file_types.js',
    './ui.js',
    './zip.js',
    './qr.js',
    './manifest.json',
    './icon.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
        return;
    }
    const isUploadedFile = url.pathname.includes('/files/');
    const isBuildMetadata = url.pathname.endsWith('/build-meta.json');

    if (isUploadedFile || isBuildMetadata) {
        event.respondWith(fetch(event.request, { cache: 'no-store' }));
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
                    }
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

self.addEventListener('message', (event) => {
    if (event.data?.type !== 'PRINT_DRIVE_CLEAR_CACHES') {
        return;
    }

    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys
                .filter((key) => key.startsWith(CACHE_PREFIX))
                .map((key) => caches.delete(key))
        ))
    );
});
