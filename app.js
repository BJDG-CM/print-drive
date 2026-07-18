import {
    FILE_TYPE_ICONS,
    FILE_TYPE_LABELS,
    getExtension,
    getFileType,
    getMimeType,
    isPreviewableFile,
    isTextPreviewableFile
} from './file_types.js';
import {
    PrintDriveCryptoError,
    base64ToBytes,
    bytesToBase64,
    bytesToHex,
    createVaultContextFromRaw,
    decryptSharedFile,
    decryptManifest,
    encryptBrowserFileV2,
    encryptManifestV2,
    fetchAndDecryptFile,
    readResponseBytesBounded,
    sha256Hex,
    unlockVault,
    unwrapFileDataKey,
    validateManifestEnvelope
} from './crypto.js';
import {
    capabilityDataKeyBytes,
    createShareCapability,
    openShareCapability
} from './capability.js';
import { clearAppManagedBrowserData } from './public_device.js';
import { createZipBlob } from './zip.js';
import { formatSize, setButtonContent } from './ui.js';
import { drawQrCode } from './qr.js';

const MANIFEST_URL = 'files/manifest.enc';
const SESSION_KEY = 'print-drive-session-key-v2';
const LEGACY_SESSION_KEY = 'print-drive-session-key-v1';
const ZIP_FILE_NAME = 'Print_Drive_Download_Files.zip';
const ZIP_FOLDER_NAME = 'Print_Drive_Download_Files';
const UPDATE_ZIP_FILE_NAME = 'Print_Drive_Encrypted_Update.zip';
const IDLE_LOCK_MS = 10 * 60 * 1000;
const PUBLIC_IDLE_EXIT_MS = 2 * 60 * 1000;
const PUBLIC_IDLE_WARNING_MS = 30 * 1000;
const MAX_MANIFEST_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_DECRYPT_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES = 150 * 1024 * 1024;

let manifestEnvelope = null;
let decryptKey = null;
let decryptedManifest = null;
let allFiles = [];
let visibleFiles = [];
let selectedIds = new Set();
let isSelectionMode = false;
let isLoading = false;
let deferredInstallPrompt = null;
let idleLockTimer = null;
let publicExitTimer = null;
let publicCapabilityExpiryTimer = null;
let lastTrustedActivityAt = 0;
let lastPublicActivityAt = 0;
let publicIdleWarningAnnounced = false;
let isOpeningPublicShare = false;
let publicOperationEpoch = 0;
let publicAbortController = null;
let publicEndPromise = null;
let trustedOperationEpoch = 0;
const trustedAbortControllers = new Set();
const activePrintFrames = new Map();
const activeDownloadUrls = new Map();
let serviceWorkerRegistrationPromise = null;
let overlayRestoreFocus = null;
let restorePublicExitAfterBfcache = false;
let restoreTrustedLockAfterBfcache = false;
let activeFilter = 'all';
let activeFileView = 'all';
let lastSelectedId = null;
let isZipRunning = false;
let zipCancelRequested = false;
let zipAbortController = null;
let isUploadRunning = false;
let previewState = {
    file: null,
    blob: null,
    objectUrl: null
};
let qrState = {
    link: ''
};
let publicState = {
    capability: null,
    blob: null,
    objectUrl: null
};
let modalState = {
    previewOpener: null,
    qrOpener: null
};

let initialShareFragment = '';
let hasStarted = false;

const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
const previewTextDecoder = new TextDecoder('utf-8', { fatal: false });
const appTextEncoder = new TextEncoder();

const dom = {
    appRoot: document.getElementById('app-root'),
    authView: document.getElementById('auth-view'),
    legacyLinkWarning: document.getElementById('legacy-link-warning'),
    loadingView: document.getElementById('loading-view'),
    loadingDetail: document.getElementById('loading-detail'),
    appView: document.getElementById('app-view'),
    publicShareView: document.getElementById('public-share-view'),
    publicFileName: document.getElementById('public-file-name'),
    publicFileMeta: document.getElementById('public-file-meta'),
    publicIdleNotice: document.getElementById('public-idle-notice'),
    publicStatus: document.getElementById('public-status'),
    publicPreviewBody: document.getElementById('public-preview-body'),
    publicPrintButton: document.getElementById('btn-public-print'),
    publicDownloadButton: document.getElementById('btn-public-download'),
    publicExitButton: document.getElementById('btn-public-exit'),
    publicExitView: document.getElementById('public-exit-view'),
    publicExitCleared: document.getElementById('public-exit-cleared'),
    publicExitRemaining: document.getElementById('public-exit-remaining'),
    publicExitDoneButton: document.getElementById('btn-public-exit-done'),
    passwordForm: document.getElementById('password-form'),
    passwordInput: document.getElementById('password-input'),
    rememberSession: document.getElementById('remember-session'),
    authSubmit: document.getElementById('auth-submit'),
    authError: document.getElementById('auth-error'),
    refreshButton: document.getElementById('btn-refresh'),
    pageQrButton: document.getElementById('btn-page-qr'),
    installButton: document.getElementById('btn-install'),
    managementButton: document.getElementById('btn-management'),
    managementBackButton: document.getElementById('btn-management-back'),
    managementView: document.getElementById('management-view'),
    vaultContent: document.getElementById('vault-content'),
    recentTab: document.getElementById('tab-recent'),
    allTab: document.getElementById('tab-all'),
    lockButton: document.getElementById('btn-lock'),
    searchInput: document.getElementById('search-input'),
    clearSearchButton: document.getElementById('btn-clear-search'),
    filterChips: document.getElementById('filter-chips'),
    sortSelect: document.getElementById('sort-select'),
    fileSummary: document.getElementById('file-summary'),
    resultCount: document.getElementById('result-count'),
    selectedCount: document.getElementById('selected-count'),
    selectionModeButton: document.getElementById('btn-selection-mode'),
    allZipButton: document.getElementById('btn-download-all'),
    dropZone: document.getElementById('drop-zone'),
    uploadInput: document.getElementById('upload-input'),
    uploadPickButton: document.getElementById('btn-upload-pick'),
    uploadStatus: document.getElementById('upload-status'),
    selectAllButton: document.getElementById('btn-select-all'),
    clearSelectionButton: document.getElementById('btn-clear-selection'),
    zipButton: document.getElementById('btn-download-selected'),
    fileList: document.getElementById('file-list'),
    loader: document.getElementById('global-loader'),
    loadingMessage: document.getElementById('loading-message'),
    cancelZipButton: document.getElementById('btn-cancel-zip'),
    toastRoot: document.getElementById('toast-root'),
    previewModal: document.getElementById('preview-modal'),
    previewBackdrop: document.getElementById('preview-backdrop'),
    previewTitle: document.getElementById('preview-title'),
    previewMeta: document.getElementById('preview-meta'),
    previewBody: document.getElementById('preview-body'),
    previewDownloadButton: document.getElementById('btn-preview-download'),
    previewPrintButton: document.getElementById('btn-preview-print'),
    previewCloseButton: document.getElementById('btn-preview-close'),
    previewCloseTopButton: document.getElementById('btn-preview-close-top'),
    qrModal: document.getElementById('qr-modal'),
    qrBackdrop: document.getElementById('qr-backdrop'),
    qrTitle: document.getElementById('qr-title'),
    qrMeta: document.getElementById('qr-meta'),
    qrCanvas: document.getElementById('qr-canvas'),
    qrLink: document.getElementById('qr-link'),
    qrCopyButton: document.getElementById('btn-qr-copy'),
    qrCloseButton: document.getElementById('btn-qr-close'),
    qrCloseTopButton: document.getElementById('btn-qr-close-top')
};

export function startPrintDrive(shareFragment = '') {
    if (hasStarted) {
        return;
    }
    hasStarted = true;
    initialShareFragment = typeof shareFragment === 'string' && shareFragment.startsWith('#share=')
        ? shareFragment
        : '';
    init();
}

function init() {
    bindEvents();
    setButtonContent(dom.refreshButton, 'refresh', '새로고침');
    setButtonContent(dom.pageQrButton, 'qr', 'QR');
    setButtonContent(dom.installButton, 'plus', '설치');
    setButtonContent(dom.lockButton, 'lock', '잠금');
    setButtonContent(dom.clearSearchButton, 'x', '지우기');
    setButtonContent(dom.selectionModeButton, 'check', '선택');
    setButtonContent(dom.selectAllButton, 'check', '전체');
    setButtonContent(dom.clearSelectionButton, 'x', '해제');
    setButtonContent(dom.allZipButton, 'download', '전체 ZIP');
    setButtonContent(dom.uploadPickButton, 'plus', '파일 선택');
    setButtonContent(dom.zipButton, 'download', '선택 ZIP 다운로드');
    setButtonContent(dom.cancelZipButton, 'x', '취소');
    setButtonContent(dom.previewDownloadButton, 'download', '다운로드');
    setButtonContent(dom.previewPrintButton, 'print', '인쇄 창 열기');
    setButtonContent(dom.previewCloseButton, 'x', '닫기');
    setButtonContent(dom.previewCloseTopButton, 'x', '닫기');
    setButtonContent(dom.qrCopyButton, 'copy', '링크 복사');
    setButtonContent(dom.qrCloseButton, 'x', '닫기');
    setButtonContent(dom.qrCloseTopButton, 'x', '닫기');
    setCompactButtonLabels();

    if (initialShareFragment) {
        initializePublicShare(initialShareFragment);
        initialShareFragment = '';
        return;
    }

    if (!window.crypto?.subtle) {
        showVaultUnlock();
        showAuthError('이 브라우저는 Web Crypto API를 지원하지 않습니다.');
        dom.authSubmit.disabled = true;
        return;
    }

    const storedKey = readSessionValue(SESSION_KEY) || readSessionValue(LEGACY_SESSION_KEY);
    if (storedKey) {
        unlockWithStoredKey(storedKey);
        return;
    }

    if (location.hash.startsWith('#file=')) {
        showVaultUnlock({ legacyLink: true });
        return;
    }

    showVaultUnlock();
}

function bindEvents() {
    dom.publicPrintButton.addEventListener('click', printPublicFile);
    dom.publicDownloadButton.addEventListener('click', downloadPublicFile);
    dom.publicExitButton.addEventListener('click', endPublicSession);
    dom.publicExitDoneButton.addEventListener('click', () => showVaultUnlock());
    dom.passwordForm.addEventListener('submit', handlePasswordSubmit);
    dom.refreshButton.addEventListener('click', () => reloadEncryptedManifest({ manual: true }));
    dom.pageQrButton.addEventListener('click', () => showQrModal('현재 페이지 QR', getCurrentPageLink(), '현재 페이지'));
    dom.lockButton.addEventListener('click', () => lockDrive());
    dom.managementButton.addEventListener('click', showManagementView);
    dom.managementBackButton.addEventListener('click', showVaultContent);
    dom.recentTab.addEventListener('click', () => setActiveFileView('recent'));
    dom.allTab.addEventListener('click', () => setActiveFileView('all'));
    [dom.recentTab, dom.allTab].forEach((tab) => tab.addEventListener('keydown', handleViewTabKeydown));
    dom.searchInput.addEventListener('input', applyFilters);
    dom.clearSearchButton.addEventListener('click', clearSearch);
    dom.filterChips.addEventListener('click', handleFilterClick);
    dom.sortSelect.addEventListener('change', applyFilters);
    dom.selectionModeButton.addEventListener('click', toggleSelectionMode);
    dom.selectAllButton.addEventListener('click', toggleSelectAll);
    dom.clearSelectionButton.addEventListener('click', clearSelection);
    dom.allZipButton.addEventListener('click', downloadAllAsZip);
    dom.uploadPickButton.addEventListener('click', () => dom.uploadInput.click());
    dom.uploadInput.addEventListener('change', () => handleUploadFiles(dom.uploadInput.files));
    dom.dropZone.addEventListener('dragenter', handleUploadDrag);
    dom.dropZone.addEventListener('dragover', handleUploadDrag);
    dom.dropZone.addEventListener('dragleave', handleUploadDragLeave);
    dom.dropZone.addEventListener('drop', handleUploadDrop);
    dom.zipButton.addEventListener('click', downloadSelectedAsZip);
    dom.cancelZipButton.addEventListener('click', cancelZipDownload);
    dom.installButton.addEventListener('click', promptInstall);
    dom.previewBackdrop.addEventListener('click', closePreviewModal);
    dom.previewCloseButton.addEventListener('click', closePreviewModal);
    dom.previewCloseTopButton.addEventListener('click', closePreviewModal);
    dom.previewDownloadButton.addEventListener('click', downloadPreviewFile);
    dom.previewPrintButton.addEventListener('click', printPreviewFile);
    dom.qrBackdrop.addEventListener('click', closeQrModal);
    dom.qrCloseButton.addEventListener('click', closeQrModal);
    dom.qrCloseTopButton.addEventListener('click', closeQrModal);
    dom.qrCopyButton.addEventListener('click', copyQrLink);

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !dom.previewModal.hidden) {
            closePreviewModal();
        } else if (event.key === 'Escape' && !dom.qrModal.hidden) {
            closeQrModal();
        } else if (event.key === 'Tab' && !dom.previewModal.hidden) {
            trapModalFocus(event, dom.previewModal);
        } else if (event.key === 'Tab' && !dom.qrModal.hidden) {
            trapModalFocus(event, dom.qrModal);
        } else if (event.key === 'Tab' && !dom.loader.hidden) {
            event.preventDefault();
            (dom.cancelZipButton.hidden ? dom.loader : dom.cancelZipButton).focus();
        }
    });

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        dom.installButton.hidden = false;
    });
    window.addEventListener('hashchange', handleLocationHashChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    bindIdleLockEvents();
}

function bindIdleLockEvents() {
    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach((eventName) => {
        window.addEventListener(eventName, () => {
            if (!document.hidden) {
                resetIdleLockTimer();
                resetPublicExitTimer();
            }
        }, { passive: true, capture: true });
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            enforceActivityDeadlines();
        }
    });
}

function handlePageHide(event) {
    const publicActive = Boolean(publicState.capability)
        || isOpeningPublicShare
        || !dom.publicShareView.hidden;
    if (publicActive) {
        restorePublicExitAfterBfcache = Boolean(event.persisted);
        teardownPublicSessionMemory();
        void clearAppManagedBrowserData();
        return;
    }

    if (event.persisted && decryptKey) {
        restoreTrustedLockAfterBfcache = true;
        clearIdleLockTimer();
        invalidateTrustedOperations();
        closePreviewModal({ silent: true });
        closeQrModal({ silent: true });
        clearVaultMemory();
        removeStoredSessions();
    }
}

function handlePageShow(event) {
    if (!event.persisted) {
        return;
    }
    if (restorePublicExitAfterBfcache) {
        restorePublicExitAfterBfcache = false;
        populateTextList(dom.publicExitCleared, [
            'BFCache 복귀 전에 메모리 키 참조, 미리보기, 임시 object URL, 공유 fragment'
        ]);
        populateTextList(dom.publicExitRemaining, [
            '내려받은 파일과 브라우저 다운로드·방문 기록',
            '클립보드의 공유 링크, 스크린샷, 운영체제 최근 파일·공유 기록',
            '프린터·인쇄 대기열 기록'
        ]);
        showView(dom.publicExitView);
        focusViewHeading(dom.publicExitView);
        return;
    }
    if (restoreTrustedLockAfterBfcache) {
        restoreTrustedLockAfterBfcache = false;
        showVaultUnlock();
        showAuthError('뒤로/앞으로 이동으로 페이지가 복원되어 보관함을 다시 잠갔습니다.');
    }
}

function showVaultUnlock(options = {}) {
    hideAuthError();
    dom.legacyLinkWarning.hidden = !options.legacyLink;
    showView(dom.authView);
    dom.passwordInput.focus();
}

function showManagementView() {
    if (!decryptKey) {
        showVaultUnlock();
        return;
    }
    dom.managementButton.closest('details')?.removeAttribute('open');
    dom.vaultContent.hidden = true;
    dom.managementView.hidden = false;
    focusViewHeading(dom.managementView);
}

function showVaultContent() {
    dom.managementView.hidden = true;
    dom.vaultContent.hidden = false;
    dom.managementButton.focus({ preventScroll: true });
}

function handleViewTabKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
    }
    event.preventDefault();
    const nextView = event.key === 'ArrowLeft' || event.key === 'Home' ? 'recent' : 'all';
    setActiveFileView(nextView, { focus: true });
}

function setActiveFileView(view, options = {}) {
    activeFileView = view === 'recent' ? 'recent' : 'all';
    [[dom.recentTab, 'recent'], [dom.allTab, 'all']].forEach(([tab, value]) => {
        const selected = value === activeFileView;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && options.focus) {
            tab.focus();
        }
    });
    applyFilters();
}

function parseStoredSession(value) {
    try {
        const parsed = JSON.parse(value);
        if ((parsed?.version === 1 || parsed?.version === 2) && typeof parsed.key === 'string') {
            return parsed;
        }
    } catch {
        // v1 stored only the base64 key bytes.
    }
    return { version: 1, key: value };
}

function readSessionValue(key) {
    try {
        return sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeSessionValue(key, value) {
    try {
        sessionStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function removeSessionValue(key) {
    try {
        sessionStorage.removeItem(key);
    } catch {
        // A blocked storage API does not prevent in-memory locking.
    }
}

function removeStoredSessions() {
    removeSessionValue(SESSION_KEY);
    removeSessionValue(LEGACY_SESSION_KEY);
}

function getUnlockErrorMessage(error) {
    if (error?.code === 'INVALID_PASSWORD' || error?.code === 'AUTHENTICATION_FAILED') {
        return '비밀번호가 맞지 않거나 암호화 목록 인증에 실패했습니다.';
    }
    if (error?.code === 'SCHEMA_INVALID') {
        return '암호화 목록 형식이 손상되었거나 지원 범위를 벗어났습니다. 관리자에게 확인해 주세요.';
    }
    if (error?.code === 'NETWORK_FAILED' || error instanceof TypeError) {
        return '네트워크에서 암호화 목록을 가져오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.';
    }
    return '암호화 목록을 열 수 없습니다. 잠시 후 다시 시도해 주세요.';
}

async function initializePublicShare(fragment) {
    invalidateTrustedOperations();
    publicAbortController?.abort();
    const epoch = ++publicOperationEpoch;
    publicAbortController = new AbortController();
    publicEndPromise = null;
    isOpeningPublicShare = true;
    clearIdleLockTimer();
    clearPublicExitTimer();
    closePreviewModal({ silent: true });
    closeQrModal({ silent: true });
    if (publicState.objectUrl) {
        URL.revokeObjectURL(publicState.objectUrl);
    }
    publicState = { capability: null, blob: null, objectUrl: null };
    clearVaultMemory();
    dom.fileList.replaceChildren();
    showView(dom.publicShareView);
    dom.publicFileName.textContent = '공유 파일을 확인하는 중입니다';
    dom.publicFileMeta.textContent = '공유 주소는 주소창에서 제거했습니다.';
    announcePublicStatus('공유 주소를 제거하고 파일 정보를 확인하고 있습니다.');
    dom.publicPreviewBody.replaceChildren(createStatusMessage('공유 파일 정보를 확인하고 있습니다.'));
    dom.publicPrintButton.disabled = true;
    dom.publicDownloadButton.disabled = true;
    dom.publicExitButton.disabled = false;

    // Remove state left by a previous trusted-device session before using a public-device link.
    try {
        await settleServiceWorkerRegistration();
        assertPublicOperationCurrent(epoch);
        await clearAppManagedBrowserData();
        assertPublicOperationCurrent(epoch);
        if (!window.crypto?.subtle) {
            const error = new Error('Web Crypto API is unavailable.');
            error.code = 'WEB_CRYPTO_UNAVAILABLE';
            throw error;
        }
        const capability = await openShareCapability(fragment);
        assertPublicOperationCurrent(epoch);
        const dataKeyBytes = capabilityDataKeyBytes(capability);
        const { dataKey: _discardedDataKey, ...capabilityMetadata } = capability;
        const extension = getExtension(capabilityMetadata.name);
        const file = {
            ...capabilityMetadata,
            extension,
            type: getFileType(extension),
            mime: getMimeType(extension),
            displayName: createDisplayName(capabilityMetadata.name, extension),
            modifiedAt: new Date(capabilityMetadata.modifiedAt)
        };
        publicState.capability = file;
        scheduleCapabilityExpiry(file.expiresAt);
        resetPublicExitTimer();
        dom.publicFileName.textContent = file.name;
        dom.publicFileMeta.textContent = `${FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other} · ${formatSize(file.size)} · 표시상 만료 ${formatDateTime(new Date(capability.expiresAt))}`;
        dom.publicPreviewBody.replaceChildren(createStatusMessage('공유 파일을 확인하는 중입니다.'));

        let decrypted = null;
        try {
            if (!canDecryptInBrowser(file)) {
                throw new PrintDriveCryptoError('BROWSER_SIZE_LIMIT', '이 파일은 공용 브라우저 복호화 상한 256MB를 초과합니다.');
            }
            decrypted = await decryptSharedFile(file, dataKeyBytes, { signal: publicAbortController.signal });
            assertPublicOperationCurrent(epoch);
            const blob = new Blob([decrypted.bytes], { type: file.mime });
            const objectUrl = URL.createObjectURL(blob);
            if (epoch !== publicOperationEpoch) {
                URL.revokeObjectURL(objectUrl);
                throw publicOperationCancelled();
            }
            publicState = { capability: file, blob, objectUrl };
            renderPublicPreview(file, objectUrl, decrypted.bytes);
            dom.publicDownloadButton.disabled = false;
            dom.publicPrintButton.disabled = !canPreviewInBrowser(file);
            announcePublicStatus(`${file.name} 공유 파일이 준비되었습니다.`);
        } finally {
            decrypted?.bytes?.fill?.(0);
            dataKeyBytes.fill(0);
        }
        (dom.publicPrintButton.disabled ? dom.publicDownloadButton : dom.publicPrintButton).focus();
    } catch (error) {
        if (epoch !== publicOperationEpoch || error?.code === 'PUBLIC_OPERATION_CANCELLED' || error?.name === 'AbortError') {
            return;
        }
        console.error(error);
        const expired = error?.code === 'SHARE_EXPIRED';
        const tooLarge = error?.code === 'BROWSER_SIZE_LIMIT';
        const unsupportedCrypto = error?.code === 'WEB_CRYPTO_UNAVAILABLE';
        dom.publicFileName.textContent = expired
            ? '표시상 유효 시간이 지난 링크입니다'
            : tooLarge ? '이 공용 브라우저에서 처리하기에는 파일이 너무 큽니다'
                : unsupportedCrypto ? '이 브라우저는 공유 파일 복호화를 지원하지 않습니다' : '공유 파일을 열 수 없습니다';
        dom.publicFileMeta.textContent = expired
            ? '표시된 유효 시간은 이 브라우저에서 확인합니다. 보낸 사람에게 새 링크를 요청하세요.'
            : tooLarge ? '브라우저 복호화 상한은 256MB입니다. 신뢰 기기의 로컬 도구를 사용하세요.'
                : unsupportedCrypto ? 'Web Crypto API가 있는 최신 보안 브라우저에서 링크를 다시 여세요.' : '링크가 손상되었거나 파일이 변경·삭제되었을 수 있습니다.';
        dom.publicPreviewBody.replaceChildren(createStatusMessage(
            expired
                ? '신뢰 기기에서 새 제한 공유 링크를 만드세요.'
                : tooLarge ? '이 기기에서는 파일 bytes를 다운로드하거나 미리보지 않았습니다.'
                    : unsupportedCrypto ? '전체 보관함 비밀번호를 입력하지 마세요.' : '보낸 사람에게 새 링크를 요청하세요.',
            'error'
        ));
        announcePublicStatus(dom.publicFileName.textContent);
    } finally {
        if (epoch === publicOperationEpoch) {
            isOpeningPublicShare = false;
            publicAbortController = null;
        }
    }
}

function assertPublicOperationCurrent(epoch) {
    if (epoch !== publicOperationEpoch) {
        throw publicOperationCancelled();
    }
}

function publicOperationCancelled() {
    const error = new Error('Public share operation was cancelled.');
    error.code = 'PUBLIC_OPERATION_CANCELLED';
    return error;
}

function beginTrustedOperation() {
    const operation = {
        epoch: trustedOperationEpoch,
        controller: new AbortController()
    };
    trustedAbortControllers.add(operation.controller);
    return operation;
}

function finishTrustedOperation(operation) {
    trustedAbortControllers.delete(operation.controller);
}

function assertTrustedOperationCurrent(operation, options = {}) {
    if (
        operation.epoch !== trustedOperationEpoch ||
        operation.controller.signal.aborted ||
        (!options.allowLocked && !decryptKey)
    ) {
        throw trustedOperationCancelled();
    }
}

function trustedOperationCancelled() {
    const error = new Error('Trusted-device operation was cancelled.');
    error.code = 'TRUSTED_OPERATION_CANCELLED';
    return error;
}

function isTrustedOperationCancelled(error, operation) {
    return error?.code === 'TRUSTED_OPERATION_CANCELLED'
        || error?.name === 'AbortError'
        || operation?.epoch !== trustedOperationEpoch;
}

function invalidateTrustedOperations() {
    trustedOperationEpoch += 1;
    trustedAbortControllers.forEach((controller) => controller.abort());
    trustedAbortControllers.clear();
    zipCancelRequested = true;
    clearActivePrintFrames();
    clearActiveDownloadUrls();
    hideOverlay();
}

async function handleLocationHashChange() {
    if (location.hash.startsWith('#share=')) {
        const fragment = location.hash;
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        initializePublicShare(fragment);
        return;
    }
    if (location.hash.startsWith('#file=')) {
        const requestedHash = location.hash;
        if (publicState.capability || isOpeningPublicShare || !dom.publicShareView.hidden) {
            const cleanup = await cleanupPublicSessionData();
            if (cleanup.epoch !== publicOperationEpoch || location.hash.startsWith('#share=')) {
                return;
            }
            history.replaceState(null, '', `${location.pathname}${location.search}${requestedHash}`);
        }
        if (decryptKey) {
            handleRequestedFile();
        } else {
            showVaultUnlock({ legacyLink: true });
        }
    }
}

function renderPublicPreview(file, objectUrl, bytes) {
    dom.publicPreviewBody.replaceChildren();
    if (!canPreviewInBrowser(file)) {
        dom.publicPreviewBody.append(createStatusMessage('이 파일은 형식 또는 크기 제한 때문에 자동 미리보기를 만들지 않습니다. 검증된 파일은 다운로드할 수 있습니다.'));
    } else if (file.extension === 'pdf') {
        const frame = document.createElement('iframe');
        frame.className = 'preview-frame';
        frame.title = `${file.name} 미리보기`;
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.src = objectUrl;
        bindPublicPreviewFrameActivity(frame);
        dom.publicPreviewBody.append(frame);
    } else if (file.type === 'image' && file.extension !== 'svg') {
        const image = document.createElement('img');
        image.className = 'preview-image';
        image.alt = file.name;
        image.src = objectUrl;
        dom.publicPreviewBody.append(image);
    } else if (isTextPreviewableFile(file)) {
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.textContent = previewTextDecoder.decode(bytes);
        dom.publicPreviewBody.append(pre);
    } else {
        dom.publicPreviewBody.append(createStatusMessage('이 형식은 안전한 브라우저 미리보기를 지원하지 않습니다. 검증된 파일은 다운로드할 수 있습니다.'));
    }
}

function bindPublicPreviewFrameActivity(frame) {
    const markActivity = () => {
        if (frame.isConnected && publicState.capability) resetPublicExitTimer();
    };
    frame.addEventListener('focus', markActivity);
    frame.addEventListener('pointerenter', markActivity, { passive: true });
    frame.addEventListener('load', () => {
        markActivity();
        try {
            ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach((eventName) => {
                frame.contentWindow?.addEventListener(eventName, markActivity, { passive: true, capture: true });
            });
        } catch {
            // A browser-native PDF viewer may be isolated; iframe focus/pointer entry still renews the timer.
        }
    }, { once: true });
}

function announcePublicStatus(message) {
    dom.publicStatus.textContent = message;
}

function createStatusMessage(message, kind = 'info') {
    const element = document.createElement('p');
    element.className = `inline-status ${kind}`;
    element.textContent = message;
    return element;
}

function downloadPublicFile() {
    if (!publicState.blob || !publicState.capability) {
        return;
    }
    if (!isPublicCapabilityWithinDisplayTime()) {
        expirePublicCapability();
        return;
    }
    downloadBlob(publicState.blob, publicState.capability.name);
    showToast('다운로드를 요청했습니다. 내려받은 파일과 다운로드 기록은 사용자가 직접 정리해야 합니다.', 'success');
}

function printPublicFile() {
    if (!publicState.objectUrl) {
        return;
    }
    if (!isPublicCapabilityWithinDisplayTime()) {
        expirePublicCapability();
        return;
    }
    openPrintDialog(publicState.objectUrl);
}

async function endPublicSession(options = {}) {
    if (publicEndPromise) {
        return publicEndPromise;
    }
    dom.publicExitButton.disabled = true;
    dom.publicPrintButton.disabled = true;
    dom.publicDownloadButton.disabled = true;
    dom.publicPreviewBody.replaceChildren(createStatusMessage('Print Drive가 관리하는 세션 데이터를 정리하는 중입니다.'));

    const promise = finishPublicSession(options);
    publicEndPromise = promise;
    try {
        return await promise;
    } finally {
        if (publicEndPromise === promise) {
            publicEndPromise = null;
        }
    }
}

async function finishPublicSession(options) {
    const cleanup = await cleanupPublicSessionData();
    if (cleanup.epoch !== publicOperationEpoch) {
        return;
    }
    const { report } = cleanup;
    const cleared = [
        'Print Drive가 보유한 메모리 키 참조와 파일 정보',
        '열려 있던 미리보기와 임시 object URL',
        'URL의 공유 비밀 fragment',
        ...(cleanup.printFramesRemoved > 0 ? [`앱이 만든 임시 인쇄 frame (${cleanup.printFramesRemoved}개)`] : []),
        ...(cleanup.downloadUrlsRemoved > 0 ? [`앱이 만든 임시 다운로드 URL (${cleanup.downloadUrlsRemoved}개)`] : []),
        ...report.cleared
    ];
    const remaining = [
        '내려받은 파일과 브라우저 다운로드 기록',
        '브라우저 방문 기록과 주소창 추천',
        '운영체제 최근 파일과 프린터·인쇄 대기열 기록',
        '클립보드에 남은 공유 링크 — 다른 값으로 덮어쓰거나 직접 정리',
        '스크린샷과 운영체제 공유 기록',
        ...report.remaining,
        ...report.failures.map((failure) => `정리 실패 — ${failure}`)
    ];
    populateTextList(dom.publicExitCleared, cleared);
    populateTextList(dom.publicExitRemaining, remaining);
    showView(dom.publicExitView);
    dom.publicExitDoneButton.focus();
    showToast(options.idle ? '공용 기기에서 2분 동안 활동이 없어 사용을 종료했습니다.' : 'Print Drive가 관리하는 세션 데이터를 정리했습니다.', 'success');
}

async function cleanupPublicSessionData() {
    const memoryCleanup = teardownPublicSessionMemory();
    await settleServiceWorkerRegistration();
    const report = await clearAppManagedBrowserData();
    return { ...memoryCleanup, report };
}

function teardownPublicSessionMemory() {
    const epoch = ++publicOperationEpoch;
    publicAbortController?.abort();
    publicAbortController = null;
    isOpeningPublicShare = false;
    clearPublicExitTimer();
    clearCapabilityExpiryTimer();
    const printFramesRemoved = clearActivePrintFrames();
    const downloadUrlsRemoved = clearActiveDownloadUrls();
    if (publicState.objectUrl) {
        URL.revokeObjectURL(publicState.objectUrl);
    }
    publicState = { capability: null, blob: null, objectUrl: null };
    dom.publicPreviewBody.replaceChildren();
    try {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch {
        // Navigation teardown can make History unavailable; memory cleanup still proceeds.
    }

    clearVaultMemory();
    hideOverlay();
    lastPublicActivityAt = 0;
    return { epoch, printFramesRemoved, downloadUrlsRemoved };
}

function scheduleCapabilityExpiry(expiresAt) {
    clearCapabilityExpiryTimer();
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) {
        expirePublicCapability();
        return;
    }
    publicCapabilityExpiryTimer = window.setTimeout(expirePublicCapability, Math.min(remaining, 2_147_483_647));
}

function clearCapabilityExpiryTimer() {
    if (publicCapabilityExpiryTimer !== null) {
        window.clearTimeout(publicCapabilityExpiryTimer);
        publicCapabilityExpiryTimer = null;
    }
}

function isPublicCapabilityWithinDisplayTime() {
    return Boolean(publicState.capability) && Date.parse(publicState.capability.expiresAt) > Date.now();
}

async function expirePublicCapability() {
    if (publicEndPromise) {
        return;
    }
    const cleanup = await cleanupPublicSessionData();
    if (cleanup.epoch !== publicOperationEpoch) {
        return;
    }
    showView(dom.publicShareView);
    dom.publicFileName.textContent = '표시상 유효 시간이 지난 링크입니다';
    dom.publicFileMeta.textContent = '표시된 유효 시간이 지나 파일을 닫고 이 앱의 임시 데이터를 정리했습니다.';
    dom.publicPreviewBody.replaceChildren(createStatusMessage('신뢰 기기에서 새 제한 공유 링크를 만드세요.', 'error'));
    dom.publicPrintButton.disabled = true;
    dom.publicDownloadButton.disabled = true;
    focusViewHeading(dom.publicShareView);
}

function populateTextList(list, values) {
    list.replaceChildren(...values.map((value) => {
        const item = document.createElement('li');
        item.textContent = value;
        return item;
    }));
}

function resetPublicExitTimer() {
    if (!publicState.capability) {
        return;
    }
    lastPublicActivityAt = Date.now();
    publicIdleWarningAnnounced = false;
    schedulePublicExitTimer();
}

function schedulePublicExitTimer() {
    clearPublicExitTimer();
    const remaining = Math.max(0, PUBLIC_IDLE_EXIT_MS - (Date.now() - lastPublicActivityAt));
    updatePublicIdleNotice(remaining);
    const nextDelay = remaining > PUBLIC_IDLE_WARNING_MS
        ? remaining - PUBLIC_IDLE_WARNING_MS
        : remaining;
    publicExitTimer = window.setTimeout(() => {
        if (Date.now() - lastPublicActivityAt >= PUBLIC_IDLE_EXIT_MS) {
            endPublicSession({ idle: true });
        } else {
            const nextRemaining = PUBLIC_IDLE_EXIT_MS - (Date.now() - lastPublicActivityAt);
            if (nextRemaining <= PUBLIC_IDLE_WARNING_MS && !publicIdleWarningAnnounced) {
                publicIdleWarningAnnounced = true;
                announcePublicStatus('활동이 없으면 30초 안에 공유 파일을 닫습니다. 화면에서 활동하면 시간이 연장됩니다.');
            }
            schedulePublicExitTimer();
        }
    }, nextDelay);
}

function updatePublicIdleNotice(remaining) {
    if (remaining <= PUBLIC_IDLE_WARNING_MS) {
        dom.publicIdleNotice.textContent = `활동이 없으면 약 ${Math.max(1, Math.ceil(remaining / 1000))}초 뒤 공유 파일을 닫고 세션 데이터를 정리합니다.`;
        return;
    }
    dom.publicIdleNotice.textContent = '활동이 2분 동안 없으면 공유 파일을 닫고 앱이 관리하는 세션 데이터를 정리합니다.';
}

function clearPublicExitTimer() {
    if (publicExitTimer !== null) {
        window.clearTimeout(publicExitTimer);
        publicExitTimer = null;
    }
}

async function unlockWithStoredKey(rawKeyBase64) {
    const operation = beginTrustedOperation();
    let key = null;
    showView(dom.loadingView);
    dom.loadingDetail.textContent = '이 탭에 보관된 세션 키로 암호화 목록을 확인하는 중입니다...';
    focusViewHeading(dom.loadingView);
    try {
        const envelope = await loadManifestEnvelope(false, { signal: operation.controller.signal });
        assertTrustedOperationCurrent(operation, { allowLocked: true });
        const stored = parseStoredSession(rawKeyBase64);
        key = await createVaultContextFromRaw(stored.version, base64ToBytes(stored.key), envelope);
        assertTrustedOperationCurrent(operation, { allowLocked: true });
        await unlockWithKey(key, operation);
    } catch (error) {
        if (isTrustedOperationCancelled(error, operation)) {
            key?.rawKeyBytes?.fill?.(0);
            return;
        }
        console.warn('Stored session key could not unlock the manifest.', error);
        removeStoredSessions();
        if (decryptKey === key) {
            clearVaultMemory();
        } else {
            key?.rawKeyBytes?.fill?.(0);
        }
        showVaultUnlock();
    } finally {
        finishTrustedOperation(operation);
    }
}

async function handlePasswordSubmit(event) {
    event.preventDefault();
    const password = dom.passwordInput.value;
    if (!password) {
        showAuthError('비밀번호를 입력해 주세요.');
        return;
    }

    dom.authSubmit.disabled = true;
    hideAuthError();

    const operation = beginTrustedOperation();
    let key = null;
    try {
        showView(dom.loadingView);
        dom.loadingDetail.textContent = '비밀번호로 복호화 키를 만드는 중입니다...';
        focusViewHeading(dom.loadingView);
        const envelope = await loadManifestEnvelope(false, { signal: operation.controller.signal });
        assertTrustedOperationCurrent(operation, { allowLocked: true });
        key = await unlockVault(password, envelope);
        assertTrustedOperationCurrent(operation, { allowLocked: true });
        await unlockWithKey(key, operation);
        assertTrustedOperationCurrent(operation);

        if (dom.rememberSession.checked) {
            const stored = writeSessionValue(SESSION_KEY, JSON.stringify({
                version: key.version,
                key: bytesToBase64(key.rawKeyBytes)
            }));
            if (!stored) {
                showToast('이 브라우저가 탭 세션 저장을 차단해 새로고침 유지 옵션을 적용하지 못했습니다.', 'warning');
            }
        } else {
            removeSessionValue(SESSION_KEY);
        }
        removeSessionValue(LEGACY_SESSION_KEY);

        dom.passwordInput.value = '';
    } catch (error) {
        if (isTrustedOperationCancelled(error, operation)) {
            key?.rawKeyBytes?.fill?.(0);
            return;
        }
        console.error(error);
        removeStoredSessions();
        if (decryptKey === key) {
            clearVaultMemory();
        } else {
            key?.rawKeyBytes?.fill?.(0);
        }
        showView(dom.authView);
        showAuthError(getUnlockErrorMessage(error));
    } finally {
        finishTrustedOperation(operation);
        dom.authSubmit.disabled = false;
        hideOverlay();
    }
}

async function unlockWithKey(key, operation) {
    assertTrustedOperationCurrent(operation, { allowLocked: true });
    decryptKey = key;
    await reloadEncryptedManifest({ throwOnError: true });
    assertTrustedOperationCurrent(operation);
    dom.managementView.hidden = true;
    dom.vaultContent.hidden = false;
    showView(dom.appView);
    registerServiceWorker(operation.epoch);
    resetIdleLockTimer();
    if (!handleRequestedFile()) focusViewHeading(dom.appView);
}

async function reloadEncryptedManifest(options = {}) {
    const operation = beginTrustedOperation();
    const vaultContext = decryptKey;
    setLoading(true, options.manual ? '암호화된 목록을 새로고침하는 중입니다...' : '암호화된 목록을 여는 중입니다...');

    try {
        assertTrustedOperationCurrent(operation);
        const envelope = await loadManifestEnvelope(true, { signal: operation.controller.signal });
        assertTrustedOperationCurrent(operation);
        const manifest = await decryptManifest(envelope, vaultContext);
        assertTrustedOperationCurrent(operation);
        decryptedManifest = manifest;
        allFiles = manifest.files.map((file, index) => normalizeFile(file, index, manifest.createdAt));
        selectedIds = new Set([...selectedIds].filter((id) => allFiles.some((file) => file.id === id)));
        applyFilters();

        if (options.manual) {
            showToast('암호화된 파일 목록을 새로고침했습니다.', 'success');
        }
    } catch (error) {
        if (isTrustedOperationCancelled(error, operation)) {
            if (options.throwOnError) {
                throw trustedOperationCancelled();
            }
            return;
        }
        if (options.throwOnError) {
            throw error;
        }

        if (shouldAskForFreshPassword(error)) {
            promptForFreshPassword();
            return;
        }

        console.error(error);
        renderErrorState(error);
        showToast('파일 목록을 열지 못했습니다.', 'error');
    } finally {
        finishTrustedOperation(operation);
        if (operation.epoch === trustedOperationEpoch) {
            setLoading(false);
        } else {
            hideOverlay();
        }
    }
}

async function loadManifestEnvelope(force = false, options = {}) {
    if (manifestEnvelope && !force) {
        return manifestEnvelope;
    }

    const url = new URL(MANIFEST_URL, location.href);
    url.searchParams.set('t', String(Date.now()));
    const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: options.signal,
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        const error = new Error(`암호화 목록을 찾을 수 없습니다. (${response.status})`);
        error.status = response.status;
        throw error;
    }

    const bytes = await readResponseBytesBounded(response, MAX_MANIFEST_RESPONSE_BYTES, {
        signal: options.signal,
        errorCode: 'SCHEMA_INVALID',
        errorMessage: '암호화 목록이 허용 크기를 초과했습니다.'
    });
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
        throw new PrintDriveCryptoError('SCHEMA_INVALID', '암호화 목록의 UTF-8 encoding이 올바르지 않습니다.', { cause: error });
    }
    try {
        manifestEnvelope = JSON.parse(text);
    } catch (error) {
        throw new PrintDriveCryptoError('SCHEMA_INVALID', '암호화 목록 JSON이 올바르지 않습니다.', { cause: error });
    }
    validateManifestEnvelope(manifestEnvelope);
    return manifestEnvelope;
}

function shouldAskForFreshPassword(error) {
    return ['AUTHENTICATION_FAILED', 'KEY_CONTEXT_INVALID'].includes(error?.code);
}

function promptForFreshPassword() {
    console.info('Current session key could not unlock the latest manifest.');
    clearIdleLockTimer();
    invalidateTrustedOperations();
    removeStoredSessions();
    closePreviewModal({ silent: true });
    closeQrModal({ silent: true });
    clearVaultMemory();
    dom.appView.classList.remove('selection-mode');
    dom.passwordInput.value = '';
    showView(dom.authView);
    showAuthError('파일 목록이 새로 바뀌었습니다. 비밀번호를 다시 입력해 주세요.');
    dom.passwordInput.focus();
}

function normalizeFile(file, index, fallbackModifiedAt) {
    const extension = file.extension || getExtension(file.name);
    const type = file.type || getFileType(extension);
    const modifiedAt = parseDateValue(file.modifiedAt || fallbackModifiedAt);
    const displayName = createDisplayName(file.name, extension);

    return {
        manifestEntry: file,
        id: file.id || file.logicalId,
        logicalId: file.logicalId,
        blobId: file.blobId,
        vaultId: manifestEnvelope?.vaultId,
        name: file.name,
        displayName,
        size: Number(file.size || 0),
        encryptedSize: Number(file.encryptedSize || 0),
        extension,
        type,
        mime: getMimeType(extension),
        path: file.path,
        iv: file.iv,
        dataIv: file.dataIv,
        paddedSize: file.paddedSize,
        wrappedDek: file.wrappedDek,
        ciphertextSha256: file.ciphertextSha256,
        sha256: file.sha256,
        modifiedAt,
        apiIndex: index
    };
}

function applyFilters() {
    const query = dom.searchInput.value.trim().toLocaleLowerCase('ko-KR');
    const sortBy = dom.sortSelect.value;
    dom.clearSearchButton.hidden = query.length === 0;

    const matchingFiles = allFiles.filter((file) => {
        const originalName = file.name.toLocaleLowerCase('ko-KR');
        const displayName = file.displayName.toLocaleLowerCase('ko-KR');
        const matchesQuery = !query || originalName.includes(query) || displayName.includes(query);
        const matchesType = activeFilter === 'all' || file.type === activeFilter || (activeFilter === 'other' && file.type === 'archive');
        return matchesQuery && matchesType;
    });

    if (!query && activeFileView === 'recent') {
        matchingFiles.sort(compareFilesBy('recent'));
        visibleFiles = matchingFiles.slice(0, 10);
    } else {
        visibleFiles = matchingFiles.sort(compareFilesBy(sortBy));
    }

    renderFiles();
    updateSelection();
}

function compareFilesBy(sortBy) {
    return (a, b) => {
        if (sortBy === 'recent') {
            return b.modifiedAt.getTime() - a.modifiedAt.getTime() || collator.compare(a.name, b.name);
        }
        if (sortBy === 'size') {
            return b.size - a.size || collator.compare(a.name, b.name);
        }
        if (sortBy === 'extension') {
            return collator.compare(a.extension, b.extension) || collator.compare(a.name, b.name);
        }
        if (sortBy === 'api') {
            return a.apiIndex - b.apiIndex;
        }
        return collator.compare(a.name, b.name);
    };
}

function parseDateValue(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function handleFilterClick(event) {
    const button = event.target.closest('[data-filter]');
    if (!button) {
        return;
    }

    activeFilter = button.dataset.filter;
    updateFilterChips();
    applyFilters();
}

function updateFilterChips() {
    dom.filterChips.querySelectorAll('[data-filter]').forEach((button) => {
        const active = button.dataset.filter === activeFilter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function clearSearch() {
    dom.searchInput.value = '';
    applyFilters();
    dom.searchInput.focus();
}

function resetFilters() {
    activeFilter = 'all';
    dom.searchInput.value = '';
    dom.sortSelect.value = 'recent';
    updateFilterChips();
    applyFilters();
    dom.searchInput.focus();
}

function renderFiles() {
    dom.fileList.replaceChildren();

    if (allFiles.length === 0) {
        dom.fileList.appendChild(createStateItem('FILE', '현재 파일이 없습니다.', '아직 다운로드할 수 있는 파일이 없습니다.'));
        updateResultCount();
        return;
    }

    if (visibleFiles.length === 0) {
        const hasQuery = dom.searchInput.value.trim().length > 0;
        const item = createStateItem(
            hasQuery ? '검색' : 'FILE',
            hasQuery ? '검색 결과가 없습니다.' : '이 보기에 표시할 파일이 없습니다.',
            hasQuery ? '검색어 또는 파일 타입 필터를 조정해 주세요.' : '파일 타입 필터를 조정하거나 전체 파일 보기를 선택해 주세요.'
        );
        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'secondary';
        setButtonContent(resetButton, 'refresh', '필터 초기화');
        resetButton.addEventListener('click', resetFilters);
        item.appendChild(resetButton);
        dom.fileList.appendChild(item);
        updateResultCount();
        return;
    }

    visibleFiles.forEach((file) => {
        dom.fileList.appendChild(createFileItem(file));
    });

    updateResultCount();
}

function createFileItem(file) {
    const item = document.createElement('li');
    item.className = 'file-item';
    item.dataset.fileId = file.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'file-checkbox';
    checkbox.checked = selectedIds.has(file.id);
    checkbox.setAttribute('aria-label', `${file.name} 선택`);
    checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
        handleSelectionClick(file.id, event.shiftKey, checkbox.checked);
    });

    const badge = document.createElement('span');
    badge.className = 'file-type-badge';
    badge.textContent = FILE_TYPE_ICONS[file.type] || FILE_TYPE_ICONS.other;
    badge.setAttribute('aria-label', FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other);

    const info = document.createElement('div');
    info.className = 'file-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'file-name-row';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.title = file.name;
    renderHighlightedName(name, file.displayName, dom.searchInput.value.trim());

    const freshness = getFreshnessBadge(file);
    if (freshness) {
        const freshnessBadge = document.createElement('span');
        freshnessBadge.className = `freshness-badge ${freshness.kind}`;
        freshnessBadge.textContent = freshness.label;
        nameRow.append(name, freshnessBadge);
    } else {
        nameRow.append(name);
    }

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = `${getExtensionLabel(file)} · ${FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other} · ${formatSize(file.size)} · 업데이트 ${formatDateTime(file.modifiedAt)}`;

    info.append(nameRow, meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const previewable = canPreviewInBrowser(file);
    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = previewable ? 'preview-action' : 'secondary preview-action';
    previewButton.title = previewable ? '미리보기·인쇄' : '이 형식 또는 파일 크기는 자동 미리보기를 지원하지 않습니다.';
    previewButton.disabled = !previewable;
    setButtonContent(previewButton, 'print', previewable ? '미리보기·인쇄' : '미리보기 불가');
    previewButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        await openFile(file.id);
    });

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = previewable ? 'secondary download-action' : 'download-action';
    downloadButton.disabled = !canDecryptInBrowser(file);
    downloadButton.title = '다운로드';
    setButtonContent(downloadButton, 'download', '다운로드');
    downloadButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        await downloadSingleFile(file.id);
    });

    const moreMenu = document.createElement('details');
    moreMenu.className = 'more-menu';
    moreMenu.addEventListener('click', (event) => event.stopPropagation());

    const moreSummary = document.createElement('summary');
    moreSummary.title = '더보기';
    moreSummary.setAttribute('aria-label', `${file.name} 더보기`);
    setButtonContent(moreSummary, 'more', '더보기');

    const moreList = document.createElement('div');
    moreList.className = 'more-menu-list';

    const qrButton = document.createElement('button');
    qrButton.type = 'button';
    qrButton.className = 'ghost';
    setButtonContent(qrButton, 'qr', decryptKey?.version === 2 ? '제한 공유 링크' : '위치 QR 보기');
    qrButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        moreMenu.open = false;
        try {
            await showFileShareModal(file, moreSummary);
        } catch (error) {
            if (error?.code === 'TRUSTED_OPERATION_CANCELLED' || error?.name === 'AbortError') {
                return;
            }
            console.error(error);
            showToast('제한 공유 링크를 만들지 못했습니다.', 'error');
        }
    });

    moreList.append(qrButton);
    moreMenu.append(moreSummary, moreList);
    actions.append(previewButton, downloadButton, moreMenu);

    item.addEventListener('click', async (event) => {
        if (event.target.closest('button, input, summary, details, a')) {
            return;
        }

        if (isSelectionMode) {
            handleSelectionClick(file.id, event.shiftKey, !selectedIds.has(file.id));
            return;
        }

        await runPrimaryFileAction(file);
    });

    item.append(checkbox, badge, info, actions);
    return item;
}

function createStateItem(iconText, title, message) {
    const item = document.createElement('li');
    item.className = 'state-item';

    const icon = document.createElement('span');
    icon.className = 'state-icon';
    icon.textContent = iconText;
    icon.setAttribute('aria-hidden', 'true');

    const titleElement = document.createElement('div');
    titleElement.className = 'state-title';
    titleElement.textContent = title;

    const messageElement = document.createElement('p');
    messageElement.className = 'state-message';
    messageElement.textContent = message;

    item.append(icon, titleElement, messageElement);
    return item;
}

function renderErrorState(error) {
    dom.fileList.replaceChildren();
    const item = createStateItem('⚠️', '파일 목록을 열지 못했습니다.', getFetchErrorMessage(error));
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    setButtonContent(retryButton, 'refresh', '다시 시도');
    retryButton.addEventListener('click', () => reloadEncryptedManifest({ manual: true }));
    item.appendChild(retryButton);
    dom.fileList.appendChild(item);

    visibleFiles = [];
    updateResultCount();
    updateSelection();
}

function getFetchErrorMessage(error) {
    if (error?.status === 404) {
        return '배포된 암호화 목록을 찾을 수 없습니다. 저장소 관리자에게 배포 상태를 확인해 달라고 요청하세요.';
    }

    if (error?.code === 'NETWORK_FAILED' || error instanceof TypeError) {
        return '네트워크 오류가 발생했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.';
    }

    if (error?.code === 'SCHEMA_INVALID' || error?.code === 'INTEGRITY_FAILED') {
        return '암호화 목록의 형식 또는 참조 무결성 검증에 실패했습니다. 기존 정상 배포를 확인해 주세요.';
    }

    if (error?.status) {
        return `${error.message}. 방금 파일을 넣었다면 10~30초 후 다시 시도해 주세요.`;
    }

    return '암호화 목록을 인증하지 못했습니다. 비밀번호 변경 또는 배포 상태를 확인해 주세요.';
}

function createDisplayName(name, extension) {
    const suffix = extension ? `.${extension}` : '';
    const baseName = suffix && name.toLowerCase().endsWith(suffix.toLowerCase())
        ? name.slice(0, -suffix.length)
        : name;
    return baseName
        .replace(/[_\uFF3F-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || baseName;
}

function getExtensionLabel(file) {
    return file.extension ? file.extension.toUpperCase() : 'FILE';
}

function getFreshnessBadge(file) {
    const rawAgeMs = Date.now() - file.modifiedAt.getTime();
    if (!Number.isFinite(rawAgeMs)) {
        return null;
    }
    const ageMs = Math.max(0, rawAgeMs);

    if (ageMs <= 24 * 60 * 60 * 1000) {
        return { kind: 'new', label: 'NEW' };
    }

    if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
        return { kind: 'recent', label: '최근' };
    }

    return null;
}

function renderHighlightedName(element, value, query) {
    element.replaceChildren();
    if (!query) {
        element.textContent = value;
        return;
    }

    const lowerValue = value.toLocaleLowerCase('ko-KR');
    const lowerQuery = query.toLocaleLowerCase('ko-KR');
    let cursor = 0;

    while (cursor < value.length) {
        const matchIndex = lowerValue.indexOf(lowerQuery, cursor);
        if (matchIndex === -1) {
            element.append(document.createTextNode(value.slice(cursor)));
            break;
        }

        if (matchIndex > cursor) {
            element.append(document.createTextNode(value.slice(cursor, matchIndex)));
        }

        const mark = document.createElement('mark');
        mark.textContent = value.slice(matchIndex, matchIndex + query.length);
        element.append(mark);
        cursor = matchIndex + query.length;
    }
}

async function runPrimaryFileAction(file) {
    if (canPreviewInBrowser(file)) {
        await openFile(file.id);
    } else if (canDecryptInBrowser(file)) {
        await downloadSingleFile(file.id);
    } else {
        showToast('이 파일은 브라우저 복호화 상한 256MB를 초과합니다.', 'warning');
    }
}

function canDecryptInBrowser(file) {
    return Number.isSafeInteger(file?.encryptedSize) && file.encryptedSize <= MAX_BROWSER_DECRYPT_BYTES + 1024 * 1024 + 16;
}

function canPreviewInBrowser(file) {
    if (!isPreviewableFile(file) || !canDecryptInBrowser(file)) {
        return false;
    }
    if (isTextPreviewableFile(file)) {
        return file.size <= MAX_TEXT_PREVIEW_BYTES;
    }
    if (file.extension === 'pdf') {
        return file.size <= MAX_PDF_PREVIEW_BYTES;
    }
    if (file.type === 'image') {
        return file.size <= MAX_IMAGE_PREVIEW_BYTES;
    }
    return false;
}

function setFileSelection(fileId, shouldSelect) {
    if (shouldSelect) {
        selectedIds.add(fileId);
    } else {
        selectedIds.delete(fileId);
    }

    updateSelection();
}

function handleSelectionClick(fileId, shiftKey, shouldSelect) {
    if (shiftKey && lastSelectedId && selectedIds.has(lastSelectedId)) {
        selectRange(lastSelectedId, fileId);
    } else {
        setFileSelection(fileId, shouldSelect);
    }

    lastSelectedId = fileId;
}

function selectRange(anchorId, targetId) {
    const start = visibleFiles.findIndex((file) => file.id === anchorId);
    const end = visibleFiles.findIndex((file) => file.id === targetId);
    if (start === -1 || end === -1) {
        selectedIds.add(targetId);
        updateSelection();
        return;
    }

    const [from, to] = start < end ? [start, end] : [end, start];
    visibleFiles.slice(from, to + 1).forEach((file) => selectedIds.add(file.id));
    updateSelection();
}

function toggleSelectionMode() {
    setSelectionMode(!isSelectionMode);
}

function setSelectionMode(enabled) {
    isSelectionMode = enabled;
    dom.appView.classList.toggle('selection-mode', isSelectionMode);

    if (!isSelectionMode) {
        selectedIds.clear();
        lastSelectedId = null;
    }

    updateSelection();
}

function updateSelection() {
    const selectedCount = selectedIds.size;
    const selectedSize = allFiles
        .filter((file) => selectedIds.has(file.id))
        .reduce((total, file) => total + file.size, 0);
    const allVisibleSelected = visibleFiles.length > 0 && visibleFiles.every((file) => selectedIds.has(file.id));

    dom.fileList.querySelectorAll('.file-item').forEach((item) => {
        const fileId = item.dataset.fileId;
        const isSelected = selectedIds.has(fileId);
        item.classList.toggle('selected', isSelected);
        const checkbox = item.querySelector('.file-checkbox');
        if (checkbox) {
            checkbox.checked = isSelected;
        }
    });

    dom.selectedCount.textContent = `선택 ${selectedCount}개 · ${formatSize(selectedSize)}`;
    dom.selectedCount.hidden = !isSelectionMode;
    dom.selectionModeButton.disabled = isLoading || visibleFiles.length === 0;
    dom.allZipButton.disabled = isLoading || isZipRunning || isUploadRunning || allFiles.length === 0;
    dom.selectionModeButton.classList.toggle('active', isSelectionMode);
    setButtonContent(dom.selectionModeButton, isSelectionMode ? 'x' : 'check', isSelectionMode ? '완료' : '선택');
    dom.selectAllButton.disabled = isLoading || !isSelectionMode || visibleFiles.length === 0;
    dom.clearSelectionButton.disabled = isLoading || !isSelectionMode || selectedCount === 0;
    dom.zipButton.disabled = isLoading || isZipRunning || isUploadRunning || !isSelectionMode || selectedCount === 0;
    setButtonContent(dom.zipButton, 'download', selectedCount > 0 ? `${selectedCount}개 선택 ZIP` : '선택 ZIP 다운로드');
    setButtonContent(dom.selectAllButton, allVisibleSelected ? 'x' : 'check', allVisibleSelected ? '전체 해제' : '전체');
}

function toggleSelectAll() {
    if (visibleFiles.length === 0) {
        return;
    }

    const allVisibleSelected = visibleFiles.every((file) => selectedIds.has(file.id));
    visibleFiles.forEach((file) => {
        if (allVisibleSelected) {
            selectedIds.delete(file.id);
        } else {
            selectedIds.add(file.id);
        }
    });

    lastSelectedId = visibleFiles.length > 0 ? visibleFiles[visibleFiles.length - 1].id : lastSelectedId;
    updateSelection();
}

function clearSelection() {
    selectedIds.clear();
    lastSelectedId = null;
    updateSelection();
}

async function downloadSingleFile(fileId) {
    const file = findFile(fileId);
    if (!file) {
        showToast('파일 정보를 찾지 못했습니다.', 'error');
        return;
    }
    if (!canDecryptInBrowser(file)) {
        showToast('이 파일은 브라우저 복호화 상한 256MB를 초과합니다.', 'warning');
        return;
    }

    const operation = beginTrustedOperation();
    const vaultContext = decryptKey;
    let decrypted = null;
    showOverlay(`${file.name} 복호화 중입니다...`);
    try {
        assertTrustedOperationCurrent(operation);
        decrypted = await fetchAndDecryptFile(file, vaultContext, { signal: operation.controller.signal });
        assertTrustedOperationCurrent(operation);
        downloadBlob(createDownloadBlob(decrypted.bytes), file.name);
        showToast('다운로드를 요청했습니다. 완료 여부는 브라우저에서 확인해 주세요.', 'success');
    } catch (error) {
        if (isTrustedOperationCancelled(error, operation)) {
            return;
        }
        console.error(error);
        showToast('파일 복호화에 실패했습니다.', 'error');
    } finally {
        decrypted?.bytes?.fill?.(0);
        finishTrustedOperation(operation);
        if (operation.epoch === trustedOperationEpoch) {
            hideOverlay();
        }
    }
}

async function openFile(fileId) {
    const file = findFile(fileId);
    if (!file) {
        showToast('파일 정보를 찾지 못했습니다.', 'error');
        return;
    }

    if (!canPreviewInBrowser(file)) {
        showToast('이 파일 형식 또는 크기는 자동 미리보기를 지원하지 않습니다.', 'info');
        return;
    }

    const operation = beginTrustedOperation();
    const vaultContext = decryptKey;
    let decrypted = null;
    modalState.previewOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    showOverlay(`${file.name} 복호화 중입니다...`);

    try {
        assertTrustedOperationCurrent(operation);
        decrypted = await fetchAndDecryptFile(file, vaultContext, { signal: operation.controller.signal });
        assertTrustedOperationCurrent(operation);
        const blob = new Blob([decrypted.bytes], { type: file.mime });
        await showPreviewModal(file, blob, decrypted.bytes);
        assertTrustedOperationCurrent(operation);
    } catch (error) {
        if (isTrustedOperationCancelled(error, operation)) {
            return;
        }
        console.error(error);
        showPreviewFailure(file, { cause: error });
    } finally {
        decrypted?.bytes?.fill?.(0);
        finishTrustedOperation(operation);
        if (operation.epoch === trustedOperationEpoch) {
            hideOverlay();
        }
    }
}

async function showPreviewModal(file, blob, bytes) {
    closePreviewModal({ silent: true, preserveOpener: true });

    const objectUrl = URL.createObjectURL(blob);
    previewState = { file, blob, objectUrl };

    dom.previewTitle.textContent = file.name;
    dom.previewMeta.textContent = `${FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other} · ${formatSize(file.size)} · 업데이트 ${formatDateTime(file.modifiedAt)}`;
    dom.previewBody.replaceChildren();
    dom.previewPrintButton.disabled = false;

    if (file.extension === 'pdf') {
        const frame = document.createElement('iframe');
        frame.className = 'preview-frame';
        frame.title = `${file.name} 미리보기`;
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.src = objectUrl;
        dom.previewBody.appendChild(frame);
    } else if (file.type === 'image') {
        const image = document.createElement('img');
        image.className = 'preview-image';
        image.alt = file.name;
        image.src = objectUrl;
        dom.previewBody.appendChild(image);
    } else if (isTextPreviewableFile(file)) {
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.textContent = previewTextDecoder.decode(bytes);
        dom.previewBody.appendChild(pre);
    } else {
        showPreviewFailure(file, { keepState: true, cause: { code: 'UNSUPPORTED_PREVIEW' } });
        return;
    }

    openModal(dom.previewModal);
    dom.previewDownloadButton.disabled = false;
    dom.previewCloseButton.focus();
}

function showPreviewFailure(file, options = {}) {
    if (!options.keepState) {
        closePreviewModal({ silent: true, preserveOpener: true });
        previewState = { file, blob: null, objectUrl: null };
    }

    dom.previewTitle.textContent = file.name;
    dom.previewMeta.textContent = `${FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other} · ${formatSize(file.size)}`;
    dom.previewBody.replaceChildren();
    const fallback = document.createElement('div');
    fallback.className = 'preview-fallback';
    const title = document.createElement('h3');
    const errorCode = options.cause?.code;
    title.textContent = errorCode === 'NETWORK_FAILED'
        ? '파일을 가져오지 못했습니다.'
        : errorCode === 'INTEGRITY_FAILED' || errorCode === 'AUTHENTICATION_FAILED'
            ? '파일 무결성을 확인하지 못했습니다.'
            : '이 형식은 안전한 미리보기를 지원하지 않습니다.';
    const message = document.createElement('p');
    message.textContent = errorCode === 'NETWORK_FAILED'
        ? '네트워크 연결을 확인한 뒤 다시 시도해 주세요. 검증되지 않은 파일은 다운로드할 수 없습니다.'
        : errorCode === 'INTEGRITY_FAILED' || errorCode === 'AUTHENTICATION_FAILED'
            ? '암호문 또는 인증 태그가 예상 값과 다릅니다. 검증되지 않은 파일은 다운로드할 수 없습니다.'
            : '파일 bytes는 검증됐지만 브라우저에서 안전하게 표시할 수 없어 다운로드만 제공합니다.';
    fallback.append(title, message);
    dom.previewBody.appendChild(fallback);
    dom.previewPrintButton.disabled = true;
    dom.previewDownloadButton.disabled = !previewState.blob;
    openModal(dom.previewModal);
    (previewState.blob ? dom.previewDownloadButton : dom.previewCloseButton).focus();
}

function closePreviewModal(options = {}) {
    if (previewState.objectUrl) {
        URL.revokeObjectURL(previewState.objectUrl);
    }

    previewState = { file: null, blob: null, objectUrl: null };
    dom.previewBody.replaceChildren();
    closeModal(dom.previewModal);

    const opener = modalState.previewOpener;
    if (!options.preserveOpener) {
        modalState.previewOpener = null;
    }
    if (!options.silent) {
        if (isVisibleFocusable(opener)) {
            opener.focus();
        } else {
            dom.fileList.focus();
        }
    }
}

async function downloadPreviewFile() {
    if (!previewState.file) {
        return;
    }

    if (previewState.blob) {
        downloadBlob(previewState.blob, previewState.file.name);
        showToast('다운로드를 요청했습니다. 완료 여부는 브라우저에서 확인해 주세요.', 'success');
        return;
    }

    await downloadSingleFile(previewState.file.id);
}

function printPreviewFile() {
    if (!previewState.objectUrl) {
        showToast('인쇄할 미리보기 파일이 없습니다.', 'warning');
        return;
    }

    openPrintDialog(previewState.objectUrl);
}

function openPrintDialog(objectUrl) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = document.createElement('iframe');
    frame.className = 'print-frame';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
    frame.src = objectUrl;
    document.body.appendChild(frame);
    const cleanupTimer = window.setTimeout(() => removePrintFrame(frame), 15_000);
    activePrintFrames.set(frame, { cleanupTimer, opener });
    frame.addEventListener('load', () => {
        if (!activePrintFrames.has(frame)) {
            return;
        }
        try {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
            showToast('인쇄 창을 열었습니다. 인쇄 완료 여부와 프린터 기록은 Print Drive가 확인하거나 지울 수 없습니다.', 'success');
        } catch (error) {
            console.error(error);
            showToast('브라우저에서 인쇄 창을 열지 못했습니다.', 'error');
        } finally {
            removePrintFrame(frame);
        }
    }, { once: true });
}

function removePrintFrame(frame) {
    const state = activePrintFrames.get(frame);
    if (state) {
        window.clearTimeout(state.cleanupTimer);
    }
    activePrintFrames.delete(frame);
    frame.remove();
    if (state?.opener && isVisibleFocusable(state.opener)) {
        state.opener.focus({ preventScroll: true });
    }
}

function clearActivePrintFrames() {
    const count = activePrintFrames.size;
    [...activePrintFrames.keys()].forEach((frame) => {
        const state = activePrintFrames.get(frame);
        activePrintFrames.set(frame, { ...state, opener: null });
        removePrintFrame(frame);
    });
    return count;
}

async function downloadSelectedAsZip() {
    const selectedFiles = allFiles.filter((file) => selectedIds.has(file.id));
    if (selectedFiles.length === 0) {
        return;
    }

    await downloadFilesAsZip(selectedFiles, '선택 ZIP');
}

async function downloadAllAsZip() {
    if (allFiles.length === 0) {
        return;
    }

    await downloadFilesAsZip(allFiles, '전체 ZIP');
}

async function downloadFilesAsZip(files, label) {
    if (isZipRunning) {
        return;
    }
    const totalPlaintextBytes = files.reduce((total, file) => total + file.size, 0);
    if (files.some((file) => !canDecryptInBrowser(file))) {
        showToast('ZIP에 브라우저 복호화 상한 256MB를 초과하는 파일이 있습니다.', 'warning');
        return;
    }
    if (files.length > 5000 || totalPlaintextBytes > 512 * 1024 * 1024) {
        showToast('브라우저 ZIP은 최대 5,000개·전체 512MB까지 지원합니다. 파일 수를 줄여 주세요.', 'warning');
        return;
    }

    isZipRunning = true;
    zipCancelRequested = false;
    const operation = beginTrustedOperation();
    const vaultContext = decryptKey;
    zipAbortController = operation.controller;
    dom.cancelZipButton.hidden = false;
    dom.cancelZipButton.disabled = false;
    updateSelection();
    showOverlay(`${label} 준비 중입니다...`);

    const zipEntries = [];
    try {
        assertTrustedOperationCurrent(operation);
        for (let index = 0; index < files.length; index += 1) {
            if (zipCancelRequested) {
                throw new Error('ZIP_CANCELLED');
            }

            const file = files[index];
            dom.loadingMessage.textContent = `${label} 생성 중: ${index + 1} / ${files.length} · ${file.displayName}`;
            const decrypted = await fetchAndDecryptFile(file, vaultContext, { signal: operation.controller.signal });
            assertTrustedOperationCurrent(operation);
            zipEntries.push({
                name: `${ZIP_FOLDER_NAME}/${file.name}`,
                bytes: decrypted.bytes
            });
        }

        dom.loadingMessage.textContent = 'ZIP 파일을 생성하는 중입니다...';
        assertTrustedOperationCurrent(operation);
        const zipBlob = createZipBlob(zipEntries);
        assertTrustedOperationCurrent(operation);
        downloadBlob(zipBlob, ZIP_FILE_NAME);
        if (label === '선택 ZIP') {
            clearSelection();
        }
        showToast(`${label} 다운로드를 요청했습니다. 완료 여부는 브라우저에서 확인해 주세요.`, 'success');
    } catch (error) {
        if (zipCancelRequested || error.message === 'ZIP_CANCELLED') {
            if (operation.epoch === trustedOperationEpoch) {
                showToast('ZIP 생성을 취소했습니다.', 'warning');
            }
            return;
        }
        if (isTrustedOperationCancelled(error, operation)) {
            return;
        }
        if (error.message === 'ZIP_CANCELLED') {
            showToast('ZIP 생성을 취소했습니다.', 'warning');
            return;
        }

        console.error(error);
        showToast('ZIP 생성 중 오류가 발생했습니다.', 'error');
    } finally {
        zipEntries.forEach((entry) => entry.bytes?.fill?.(0));
        finishTrustedOperation(operation);
        isZipRunning = false;
        zipCancelRequested = false;
        zipAbortController = null;
        dom.cancelZipButton.hidden = true;
        dom.cancelZipButton.disabled = false;
        if (operation.epoch === trustedOperationEpoch) {
            hideOverlay();
            updateSelection();
        }
    }
}

function cancelZipDownload() {
    zipCancelRequested = true;
    zipAbortController?.abort();
    dom.cancelZipButton.disabled = true;
    dom.loadingMessage.textContent = 'ZIP 생성을 취소하는 중입니다...';
}

function handleUploadDrag(event) {
    event.preventDefault();
    if (isLoading || isUploadRunning || !decryptKey) {
        return;
    }

    dom.dropZone.classList.add('dragging');
    event.dataTransfer.dropEffect = 'copy';
}

function handleUploadDragLeave(event) {
    if (!dom.dropZone.contains(event.relatedTarget)) {
        dom.dropZone.classList.remove('dragging');
    }
}

async function handleUploadDrop(event) {
    event.preventDefault();
    dom.dropZone.classList.remove('dragging');
    await handleUploadFiles(event.dataTransfer.files);
}

async function handleUploadFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file.name && file.size >= 0);
    dom.uploadInput.value = '';

    if (files.length === 0) {
        return;
    }

    if (!decryptKey || !manifestEnvelope) {
        showToast('먼저 잠금을 해제해 주세요.', 'warning');
        return;
    }

    if (isUploadRunning || isLoading) {
        showToast('다른 작업이 끝난 뒤 다시 시도해 주세요.', 'warning');
        return;
    }

    isUploadRunning = true;
    const operation = beginTrustedOperation();
    const vaultContext = decryptKey;
    const envelopeSnapshot = manifestEnvelope;
    const manifestSnapshot = decryptedManifest;
    const filesSnapshot = [...allFiles];
    setUploadControls(false);
    updateSelection();
    showOverlay(`암호화 업데이트 준비 중입니다...`);

    try {
        assertTrustedOperationCurrent(operation);
        const uploadFiles = dedupeFilesByName(files);
        const zipEntries = await createEncryptedUpdateEntries(uploadFiles, {
            operation,
            vaultContext,
            envelope: envelopeSnapshot,
            manifest: manifestSnapshot,
            files: filesSnapshot
        });
        assertTrustedOperationCurrent(operation);
        const zipBlob = createZipBlob(zipEntries);
        assertTrustedOperationCurrent(operation);
        downloadBlob(zipBlob, UPDATE_ZIP_FILE_NAME);
        dom.uploadStatus.textContent = `${uploadFiles.length}개 파일의 업데이트 패키지 다운로드 요청됨 · 아직 적용되지 않음`;
        showToast('업데이트 패키지 다운로드를 요청했습니다. 아직 적용되지 않았습니다.', 'success');
    } catch (error) {
        if (isTrustedOperationCancelled(error, operation)) {
            return;
        }
        console.error(error);
        dom.uploadStatus.textContent = '업데이트 패키지를 만들지 못했습니다.';
        showToast('암호화 업데이트 패키지를 만들지 못했습니다.', 'error');
    } finally {
        finishTrustedOperation(operation);
        isUploadRunning = false;
        if (operation.epoch === trustedOperationEpoch) {
            setUploadControls(true);
            hideOverlay();
            updateSelection();
        }
    }
}

async function createEncryptedUpdateEntries(uploadFiles, context) {
    const { operation, vaultContext, envelope, manifest, files } = context;
    if (vaultContext.version !== 2 || envelope.version !== 2) {
        throw new Error('현재 파일 저장소를 업데이트한 뒤 패키지를 만들어 주세요.');
    }
    const replacementNames = new Set(uploadFiles.map((file) => normalizedNameKey(file.name)));
    const existingByName = new Map(files.map((file) => [normalizedNameKey(file.name), file]));
    const manifestFiles = files
        .filter((file) => !replacementNames.has(normalizedNameKey(file.name)))
        .map((file) => toManifestEntry(file, vaultContext.version));
    const zipEntries = [];
    const addObjects = [];
    const paddingBlockSize = getPaddingBlockSize(envelope);
    const sensitiveBuffers = [];

    try {
      for (let index = 0; index < uploadFiles.length; index += 1) {
        assertTrustedOperationCurrent(operation);
        const uploadFile = uploadFiles[index];
        dom.loadingMessage.textContent = `파일 암호화 중: ${index + 1} / ${uploadFiles.length} · ${uploadFile.name}`;

        const normalizedName = normalizeUploadFileName(uploadFile.name);
        if (uploadFile.size > MAX_BROWSER_DECRYPT_BYTES) {
            throw new Error(`${normalizedName}: 브라우저 업데이트 파일은 256MB를 넘을 수 없습니다.`);
        }
        const fileBytes = new Uint8Array(await uploadFile.arrayBuffer());
        sensitiveBuffers.push(fileBytes);
        assertTrustedOperationCurrent(operation);
        const paddedBytes = addRandomPadding(fileBytes, paddingBlockSize);
        if (paddedBytes !== fileBytes) {
            sensitiveBuffers.push(paddedBytes);
        }
        const sha256 = await sha256Hex(fileBytes);
        assertTrustedOperationCurrent(operation);
        const modifiedAt = new Date(uploadFile.lastModified || Date.now()).toISOString();

        const previous = existingByName.get(normalizedNameKey(normalizedName));
        if (previous && previous.size === fileBytes.byteLength && previous.sha256 === sha256) {
            manifestFiles.push(toManifestEntry(previous, 2));
            continue;
        }

        const logicalId = previous?.logicalId || createRandomHex(16);
        const blobId = createRandomHex(16);
        const descriptor = {
            vaultId: vaultContext.vaultId,
            logicalId,
            blobId,
            name: normalizedName,
            size: fileBytes.byteLength,
            paddedSize: paddedBytes.byteLength,
            sha256
        };
        const encrypted = await encryptBrowserFileV2(descriptor, paddedBytes, vaultContext);
        assertTrustedOperationCurrent(operation);
        const path = `files/${blobId}.bin`;
        const object = {
            blobId,
            path,
            encryptedSize: encrypted.encryptedBytes.byteLength,
            ciphertextSha256: encrypted.ciphertextSha256
        };
        addObjects.push(object);
        zipEntries.push({ name: path, bytes: encrypted.encryptedBytes });
        manifestFiles.push({
            logicalId,
            blobId,
            path,
            name: normalizedName,
            size: fileBytes.byteLength,
            paddedSize: paddedBytes.byteLength,
            encryptedSize: encrypted.encryptedBytes.byteLength,
            sha256,
            ciphertextSha256: encrypted.ciphertextSha256,
            modifiedAt,
            dataIv: encrypted.dataIv,
            wrappedDek: encrypted.wrappedDek
        });
      }

    if (addObjects.length === 0) {
        throw new Error('선택한 파일은 현재 파일과 내용이 같습니다.');
    }
    manifestFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const updatedManifest = {
        ...manifest,
        revision: manifest.revision + 1,
        updatedAt: new Date().toISOString(),
        files: manifestFiles
    };
    const updatedEnvelope = await encryptManifestV2(envelope, updatedManifest, vaultContext);
    assertTrustedOperationCurrent(operation);

    addObjects.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const targetBlobIds = new Set(updatedEnvelope.objectIndex.objects.map((object) => object.blobId));
    const removeObjects = envelope.objectIndex.objects
        .map((object) => object.blobId)
        .filter((blobId) => !targetBlobIds.has(blobId))
        .sort();
    const updateMetadata = {
        version: 1,
        app: 'print-drive',
        vaultId: envelope.vaultId,
        baseRevision: manifest.revision,
        targetRevision: updatedManifest.revision,
        addObjects,
        removeObjects,
        manifestPath: MANIFEST_URL
    };

    zipEntries.unshift({
        name: MANIFEST_URL,
        bytes: appTextEncoder.encode(`${JSON.stringify(updatedEnvelope, null, 2)}\n`)
    });
    zipEntries.unshift({
        name: 'print-drive-update.json',
        bytes: appTextEncoder.encode(`${JSON.stringify(updateMetadata, null, 2)}\n`)
    });

    assertTrustedOperationCurrent(operation);
    return zipEntries;
    } finally {
        sensitiveBuffers.forEach((bytes) => bytes.fill(0));
    }
}

function dedupeFilesByName(files) {
    const latestByName = new Map();
    files.forEach((file) => latestByName.set(normalizedNameKey(file.name), file));
    return Array.from(latestByName.values());
}

function toManifestEntry(file, vaultVersion = decryptKey?.version) {
    if (vaultVersion === 2) {
        return {
            logicalId: file.logicalId,
            blobId: file.blobId,
            path: file.path,
            name: file.name,
            size: file.size,
            paddedSize: file.paddedSize,
            encryptedSize: file.encryptedSize,
            sha256: file.sha256,
            ciphertextSha256: file.ciphertextSha256,
            modifiedAt: file.modifiedAt.toISOString(),
            dataIv: file.dataIv,
            wrappedDek: file.wrappedDek
        };
    }
    return {
        id: file.id,
        name: file.name,
        size: file.size,
        encryptedSize: file.encryptedSize,
        extension: file.extension,
        type: file.type,
        mime: file.mime,
        path: file.path,
        modifiedAt: file.modifiedAt.toISOString(),
        iv: file.iv,
        sha256: file.sha256
    };
}

function normalizeUploadFileName(value) {
    const name = String(value).normalize('NFC');
    if (!name || Array.from(name).length > 255 || /[\\/\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) {
        throw new Error('파일명은 경로 구분자나 제어 문자가 없는 255자 이하의 단일 이름이어야 합니다.');
    }
    return name;
}

function normalizedNameKey(value) {
    return String(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function getPaddingBlockSize(envelope = manifestEnvelope) {
    const blockSize = envelope?.crypto?.padding?.blockSize;
    return Number.isInteger(blockSize) && blockSize > 0 ? blockSize : 0;
}

function addRandomPadding(bytes, blockSize) {
    if (!blockSize) {
        return bytes;
    }

    const remainder = bytes.byteLength % blockSize;
    if (remainder === 0) {
        return bytes;
    }

    const padded = new Uint8Array(bytes.byteLength + blockSize - remainder);
    padded.set(bytes);
    crypto.getRandomValues(padded.subarray(bytes.byteLength));
    return padded;
}

function createRandomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

function createRandomHex(length) {
    return bytesToHex(createRandomBytes(length));
}

function setUploadControls(enabled) {
    dom.uploadPickButton.disabled = !enabled;
    dom.dropZone.classList.toggle('busy', !enabled);
}

async function showFileShareModal(file, opener) {
    const operation = beginTrustedOperation();
    const vaultContext = decryptKey;
    modalState.qrOpener = opener instanceof HTMLElement ? opener : document.activeElement;
    try {
        assertTrustedOperationCurrent(operation);
        if (vaultContext?.version !== 2) {
            showQrModal(
                `${file.displayName} 위치 QR`,
                createFileAppLink(file),
                '이전 형식의 파일 위치 링크 · 전체 파일 비밀번호 필요'
            );
            return;
        }

        if (!canDecryptInBrowser(file)) {
            showToast('256MB를 넘는 파일은 현재 공용 브라우저에서 열 수 없어 제한 공유 링크를 만들지 않습니다.', 'warning');
            if (isVisibleFocusable(modalState.qrOpener)) modalState.qrOpener.focus({ preventScroll: true });
            return;
        }

        const dataKeyBytes = await unwrapFileDataKey(file, vaultContext);
        assertTrustedOperationCurrent(operation);
        try {
        const link = await createShareCapability({
            ...file,
            modifiedAt: file.modifiedAt.toISOString()
        }, dataKeyBytes, { baseUrl: getCurrentPageLink() });
        assertTrustedOperationCurrent(operation);
        showQrModal(
            `${file.displayName} 제한 공유`,
            link,
            '이 링크를 가진 사람은 선택한 파일을 열 수 있습니다 · 신뢰 채널로만 전달 · 표시 유효 시간 30분'
        );
        } finally {
            dataKeyBytes.fill(0);
        }
    } finally {
        finishTrustedOperation(operation);
    }
}

function showQrModal(title, link, meta) {
    if (!modalState.qrOpener && document.activeElement instanceof HTMLElement) {
        modalState.qrOpener = document.activeElement;
    }
    qrState = { link };
    dom.qrTitle.textContent = title;
    dom.qrMeta.textContent = meta;
    dom.qrLink.textContent = link;

    try {
        drawQrCode(dom.qrCanvas, link);
        dom.qrCanvas.hidden = false;
    } catch (error) {
        console.error(error);
        dom.qrCanvas.hidden = true;
        dom.qrLink.textContent = `${link}\nQR을 만들 수 없습니다. 링크 복사를 사용해 주세요.`;
    }

    openModal(dom.qrModal);
    dom.qrCopyButton.focus();
}

function closeQrModal(options = {}) {
    const wasOpen = !dom.qrModal.hidden;
    qrState = { link: '' };
    dom.qrLink.textContent = '';
    const context = dom.qrCanvas.getContext('2d');
    context?.clearRect(0, 0, dom.qrCanvas.width, dom.qrCanvas.height);
    closeModal(dom.qrModal);
    const opener = modalState.qrOpener;
    modalState.qrOpener = null;
    if (!options.silent && wasOpen && isVisibleFocusable(opener)) {
        opener.focus();
    } else if (!options.silent && wasOpen) {
        dom.fileList.focus();
    }
}

async function copyQrLink() {
    if (!qrState.link) {
        return;
    }

    try {
        await copyText(qrState.link);
        showToast('링크를 복사했습니다.', 'success');
    } catch (error) {
        console.error(error);
        showToast('링크 복사에 실패했습니다.', 'error');
    }
}

function getCurrentPageLink() {
    const url = new URL(location.href);
    url.hash = '';
    return url.toString();
}

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'clipboard-fallback';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
        throw new Error('Clipboard copy failed.');
    }
}

function createFileAppLink(file) {
    const url = new URL(location.href);
    url.hash = `file=${encodeURIComponent(file.id)}`;
    return url.toString();
}

function handleRequestedFile() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const requestedId = params.get('file');
    if (!requestedId) {
        return false;
    }

    const file = findFile(requestedId);
    if (!file) {
        showToast('링크의 파일을 찾지 못했습니다.', 'warning');
        return false;
    }

    selectedIds.add(file.id);
    setSelectionMode(true);
    updateSelection();
    const item = dom.fileList.querySelector(`[data-file-id="${cssEscape(file.id)}"]`);
    item?.scrollIntoView({ block: 'center' });
    item?.querySelector('.file-checkbox')?.focus({ preventScroll: true });
    showToast('링크의 파일을 선택했습니다.', 'success');
    return true;
}

function findFile(fileId) {
    return allFiles.find((file) => file.id === fileId);
}

function lockDrive(options = {}) {
    clearIdleLockTimer();
    invalidateTrustedOperations();
    clearVaultMemory();
    activeFilter = 'all';
    activeFileView = 'all';
    updateFilterChips();
    setActiveFileView('all');
    closePreviewModal({ silent: true });
    closeQrModal({ silent: true });
    dom.appView.classList.remove('selection-mode');
    removeStoredSessions();
    dom.searchInput.value = '';
    dom.fileList.replaceChildren();
    dom.uploadStatus.textContent = '파일을 선택하면 암호화 업데이트 패키지를 준비합니다.';
    dom.dropZone.classList.remove('dragging', 'busy');
    dom.managementView.hidden = true;
    dom.vaultContent.hidden = false;
    dom.passwordInput.value = '';
    dom.legacyLinkWarning.hidden = true;
    if (location.hash) {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    showView(dom.authView);
    dom.passwordInput.focus();
    showToast(options.idle ? '10분 동안 사용하지 않아 자동 잠금되었습니다.' : '잠금 상태로 전환했습니다.', 'success');
}

function clearVaultMemory() {
    decryptKey?.rawKeyBytes?.fill?.(0);
    decryptKey = null;
    decryptedManifest = null;
    manifestEnvelope = null;
    allFiles = [];
    visibleFiles = [];
    selectedIds.clear();
    isSelectionMode = false;
    lastSelectedId = null;
    lastTrustedActivityAt = 0;
    scrubSensitiveDom();
}

function scrubSensitiveDom() {
    dom.passwordInput.value = '';
    dom.searchInput.value = '';
    dom.fileList.replaceChildren();
    dom.publicFileName.textContent = '공유 파일 정보가 정리되었습니다';
    dom.publicFileMeta.textContent = 'Print Drive가 관리하던 파일 metadata를 제거했습니다.';
    dom.publicPreviewBody.replaceChildren();
    dom.previewTitle.textContent = '파일 미리보기';
    dom.previewMeta.textContent = '미리보기';
    dom.previewBody.replaceChildren();
    dom.qrTitle.textContent = '링크 QR';
    dom.qrMeta.textContent = '링크 정보가 정리되었습니다.';
    dom.qrLink.textContent = '';
    dom.loadingMessage.textContent = '처리 중입니다...';
    dom.uploadStatus.textContent = '파일을 선택하면 암호화 업데이트 패키지를 준비합니다.';
    dom.fileSummary.textContent = '0개 파일 · 0 B · 최근 업데이트 없음';
    dom.resultCount.textContent = '0 / 0개 표시';
    dom.selectedCount.textContent = '선택 0개';
    dom.toastRoot.replaceChildren();
}

function resetIdleLockTimer() {
    if (!decryptKey) {
        return;
    }

    lastTrustedActivityAt = Date.now();
    scheduleIdleLockTimer();
}

function scheduleIdleLockTimer() {
    clearIdleLockTimer();
    const remaining = Math.max(0, IDLE_LOCK_MS - (Date.now() - lastTrustedActivityAt));
    idleLockTimer = window.setTimeout(() => {
        if (Date.now() - lastTrustedActivityAt >= IDLE_LOCK_MS) {
            lockDrive({ idle: true });
        } else {
            scheduleIdleLockTimer();
        }
    }, remaining);
}

function enforceActivityDeadlines() {
    if (publicState.capability) {
        if (!isPublicCapabilityWithinDisplayTime()) {
            expirePublicCapability();
        } else if (Date.now() - lastPublicActivityAt >= PUBLIC_IDLE_EXIT_MS) {
            endPublicSession({ idle: true });
        } else {
            schedulePublicExitTimer();
        }
    }
    if (decryptKey) {
        if (Date.now() - lastTrustedActivityAt >= IDLE_LOCK_MS) {
            lockDrive({ idle: true });
        } else {
            scheduleIdleLockTimer();
        }
    }
}

function clearIdleLockTimer() {
    if (idleLockTimer !== null) {
        window.clearTimeout(idleLockTimer);
        idleLockTimer = null;
    }
}

function setLoading(loading, message) {
    isLoading = loading;
    dom.refreshButton.disabled = loading;
    dom.lockButton.disabled = loading;
    dom.searchInput.disabled = loading;
    dom.clearSearchButton.disabled = loading;
    dom.filterChips.querySelectorAll('button').forEach((button) => {
        button.disabled = loading;
    });
    dom.sortSelect.disabled = loading;
    dom.recentTab.disabled = loading;
    dom.allTab.disabled = loading;
    dom.selectionModeButton.disabled = loading || visibleFiles.length === 0;
    dom.allZipButton.disabled = loading || isZipRunning || isUploadRunning || allFiles.length === 0;
    dom.uploadPickButton.disabled = loading || isUploadRunning;
    dom.dropZone.classList.toggle('busy', loading || isUploadRunning);
    dom.selectAllButton.disabled = loading || !isSelectionMode || visibleFiles.length === 0;
    dom.clearSelectionButton.disabled = loading || !isSelectionMode || selectedIds.size === 0;
    dom.zipButton.disabled = loading || isZipRunning || isUploadRunning || !isSelectionMode || selectedIds.size === 0;

    if (loading && dom.appView.hidden) {
        dom.loadingDetail.textContent = message;
        showView(dom.loadingView);
        focusViewHeading(dom.loadingView);
    } else if (loading) {
        showOverlay(message);
    } else {
        hideOverlay();
    }
}

function showOverlay(message) {
    if (dom.loader.hidden) {
        overlayRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    dom.loadingMessage.textContent = message;
    dom.loader.hidden = false;
    dom.appView.setAttribute('aria-busy', 'true');
    [...dom.appView.children].forEach((child) => {
        if (child !== dom.loader) {
            child.inert = true;
            child.setAttribute('aria-hidden', 'true');
        }
    });
    (dom.cancelZipButton.hidden ? dom.loader : dom.cancelZipButton).focus({ preventScroll: true });
}

function hideOverlay() {
    dom.loader.hidden = true;
    dom.appView.removeAttribute('aria-busy');
    [...dom.appView.children].forEach((child) => {
        if (child !== dom.loader) {
            child.inert = false;
            child.removeAttribute('aria-hidden');
        }
    });
    const restoreTarget = overlayRestoreFocus;
    overlayRestoreFocus = null;
    if (
        dom.appView.hidden === false &&
        dom.previewModal.hidden &&
        dom.qrModal.hidden &&
        isVisibleFocusable(restoreTarget)
    ) {
        restoreTarget.focus({ preventScroll: true });
    }
}

function showView(view) {
    [
        dom.authView,
        dom.loadingView,
        dom.appView,
        dom.publicShareView,
        dom.publicExitView
    ].forEach((section) => {
        section.hidden = section !== view;
    });
}

function focusViewHeading(view) {
    const heading = view.querySelector('h1, h2');
    if (heading instanceof HTMLElement) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
    }
}

function isVisibleFocusable(element) {
    return element instanceof HTMLElement
        && element.isConnected
        && !element.hidden
        && !element.closest('[hidden], [inert]')
        && element.getClientRects().length > 0;
}

function openModal(modal) {
    modal.hidden = false;
    dom.appRoot.inert = true;
    dom.appRoot.setAttribute('aria-hidden', 'true');
}

function closeModal(modal) {
    modal.hidden = true;
    if (dom.previewModal.hidden && dom.qrModal.hidden) {
        dom.appRoot.inert = false;
        dom.appRoot.removeAttribute('aria-hidden');
    }
}

function trapModalFocus(event, modal) {
    const focusable = [...modal.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (focusable.length === 0) {
        event.preventDefault();
        return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function showAuthError(message) {
    dom.authError.textContent = message;
    dom.authError.hidden = false;
    dom.passwordInput.setAttribute('aria-invalid', 'true');
    dom.passwordInput.select();
}

function hideAuthError() {
    dom.authError.textContent = '';
    dom.authError.hidden = true;
    dom.passwordInput.removeAttribute('aria-invalid');
}

function updateResultCount() {
    dom.resultCount.textContent = `${visibleFiles.length} / ${allFiles.length}개 표시`;
    const totalSize = allFiles.reduce((total, file) => total + file.size, 0);
    const latest = allFiles.reduce((latestDate, file) => (
        file.modifiedAt > latestDate ? file.modifiedAt : latestDate
    ), new Date(0));
    const latestText = latest.getTime() > 0 ? formatDateTime(latest) : '최근 업데이트 없음';
    dom.fileSummary.textContent = `${allFiles.length}개 파일 · ${formatSize(totalSize)} · ${latestText}`;
}

function formatDateTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime()) || date.getTime() === 0) {
        return '알 수 없음';
    }

    return new Intl.DateTimeFormat('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastRoot.appendChild(toast);

    window.setTimeout(() => {
        toast.remove();
    }, 3200);
}








function downloadBlob(blob, filename) {
    const safeBlob = blob.type === 'application/octet-stream'
        ? blob
        : blob.slice(0, blob.size, 'application/octet-stream');
    const url = URL.createObjectURL(safeBlob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    const timer = window.setTimeout(() => revokeDownloadUrl(url), 1_000);
    activeDownloadUrls.set(url, timer);
}

function revokeDownloadUrl(url) {
    const timer = activeDownloadUrls.get(url);
    if (timer !== undefined) {
        window.clearTimeout(timer);
    }
    activeDownloadUrls.delete(url);
    URL.revokeObjectURL(url);
}

function clearActiveDownloadUrls() {
    const count = activeDownloadUrls.size;
    [...activeDownloadUrls.keys()].forEach(revokeDownloadUrl);
    return count;
}

function createDownloadBlob(bytes) {
    return new Blob([bytes], { type: 'application/octet-stream' });
}

function cssEscape(value) {
    if (window.CSS?.escape) {
        return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
}



function setCompactButtonLabels() {
            [
                [dom.pageQrButton, '현재 페이지 QR'],
                [dom.refreshButton, '새로고침'],
                [dom.lockButton, '잠금'],
                [dom.installButton, '앱으로 설치']
    ].forEach(([button, label]) => {
        button.title = label;
        button.setAttribute('aria-label', label);
    });
}

async function registerServiceWorker(epoch) {
    if (!('serviceWorker' in navigator)) {
        return;
    }
    const registrationTask = (async () => {
        try {
            const registration = await navigator.serviceWorker.register('./sw.js');
            const stale = epoch !== trustedOperationEpoch
                || !decryptKey
                || isOpeningPublicShare
                || !dom.publicShareView.hidden;
            if (stale) {
                registration.active?.postMessage?.({ type: 'PRINT_DRIVE_CLEAR_CACHES' });
                await registration.unregister();
                await clearOwnedCachesOnly();
            }
        } catch (error) {
            console.info('Service worker registration skipped:', error);
        }
    })();
    serviceWorkerRegistrationPromise = registrationTask;
    try {
        await registrationTask;
    } finally {
        if (serviceWorkerRegistrationPromise === registrationTask) {
            serviceWorkerRegistrationPromise = null;
        }
    }
}

async function settleServiceWorkerRegistration() {
    if (serviceWorkerRegistrationPromise) {
        await serviceWorkerRegistrationPromise;
    }
}

async function clearOwnedCachesOnly() {
    if (!globalThis.caches?.keys) {
        return;
    }
    const keys = await caches.keys();
    await Promise.all(keys
        .filter((key) => key.startsWith('print-drive-'))
        .map((key) => caches.delete(key)));
}

async function promptInstall() {
    if (!deferredInstallPrompt) {
        return;
    }

    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    dom.installButton.hidden = true;
}
