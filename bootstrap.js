(() => {
    let pendingShareFragment = '';
    const captureShareFragment = () => {
        if (location.hash.startsWith('#share=')) {
            pendingShareFragment = location.hash;
            history.replaceState(null, '', `${location.pathname}${location.search}`);
        }
    };
    captureShareFragment();
    window.addEventListener('hashchange', captureShareFragment);

    const releaseEarlyCapture = () => {
        window.removeEventListener('hashchange', captureShareFragment);
    };

    const domReady = document.readyState === 'loading'
        ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
        : Promise.resolve();

    Promise.all([import('./build_identity.js'), domReady])
        .then(async ([{ ensureCurrentBuild }]) => {
            const identity = await ensureCurrentBuild();
            if (identity.status === 'reloading') {
                return null;
            }
            if (identity.status === 'stale-after-reload') {
                const error = new Error('최신 앱 셸을 불러오지 못했습니다. 브라우저 탭을 닫고 다시 열어 주세요.');
                error.code = 'STALE_BUILD_UNRECOVERED';
                throw error;
            }
            return import('./app.js');
        })
        .then((appModule) => {
            if (!appModule) {
                return;
            }
            const { startPrintDrive } = appModule;
            captureShareFragment();
            startPrintDrive(pendingShareFragment);
            pendingShareFragment = '';
            releaseEarlyCapture();
        })
        .catch(async (error) => {
            await domReady;
            releaseEarlyCapture();
            console.error('Print Drive를 시작하지 못했습니다.', error);
            const wasPublicShare = Boolean(pendingShareFragment);
            pendingShareFragment = '';
            if (wasPublicShare) {
                clearOwnedStorage(globalThis, 'sessionStorage');
                clearOwnedStorage(globalThis, 'localStorage');
                const publicView = document.getElementById('public-share-view');
                const publicName = document.getElementById('public-file-name');
                const publicMeta = document.getElementById('public-file-meta');
                const publicBody = document.getElementById('public-preview-body');
                document.querySelectorAll('#app-root > section').forEach((section) => {
                    section.hidden = section !== publicView;
                });
                if (publicName) {
                    publicName.textContent = '공유 파일 앱을 불러오지 못했습니다';
                }
                if (publicMeta) {
                    publicMeta.textContent = '공유 fragment는 주소창에서 제거했습니다. 전체 보관함 비밀번호를 입력하지 마세요.';
                }
                if (publicBody) {
                    publicBody.textContent = '네트워크 또는 배포 파일을 확인한 뒤 원본 공유 링크를 다시 여세요.';
                }
                return;
            }
            const errorView = document.getElementById('auth-error');
            const authView = document.getElementById('auth-view');
            const modeView = document.getElementById('mode-select-view');
            if (modeView) {
                modeView.hidden = true;
            }
            if (authView) {
                authView.hidden = false;
            }
            if (errorView) {
                errorView.textContent = '앱 모듈을 불러오지 못했습니다. 네트워크와 배포 파일을 확인해 주세요.';
                errorView.hidden = false;
            }
        });

    function clearOwnedStorage(environment, property) {
        try {
            const storage = environment[property];
            const owned = [];
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index);
                if (key?.startsWith('print-drive-')) {
                    owned.push(key);
                }
            }
            owned.forEach((key) => storage.removeItem(key));
        } catch {
            // The public error view never claims that browser storage cleanup succeeded.
        }
    }
})();
