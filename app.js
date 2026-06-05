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
    base64ToBytes,
    bytesToBase64,
    decryptManifest,
    deriveKeyBytes,
    fetchAndDecryptFile,
    importAesKey
} from './crypto.js';
import { createZipBlob } from './zip.js';
import { formatSize, setButtonContent } from './ui.js';
import { drawQrCode } from './qr.js';

const MANIFEST_URL = 'files/manifest.enc';
const SESSION_KEY = 'print-drive-session-key-v1';
const ZIP_FILE_NAME = 'Print_Drive_Download_Files.zip';
const ZIP_FOLDER_NAME = 'Print_Drive_Download_Files';
const IDLE_LOCK_MS = 10 * 60 * 1000;

let manifestEnvelope = null;
let decryptKey = null;
let allFiles = [];
let visibleFiles = [];
let selectedIds = new Set();
let isSelectionMode = false;
let isLoading = false;
let deferredInstallPrompt = null;
let idleLockTimer = null;
let activeFilter = 'all';
let lastSelectedId = null;
let isZipRunning = false;
let zipCancelRequested = false;
let previewState = {
    file: null,
    blob: null,
    objectUrl: null
};
let qrState = {
    link: ''
};

const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
const previewTextDecoder = new TextDecoder('utf-8', { fatal: false });

const dom = {
    authView: document.getElementById('auth-view'),
    loadingView: document.getElementById('loading-view'),
    appView: document.getElementById('app-view'),
    passwordForm: document.getElementById('password-form'),
    passwordInput: document.getElementById('password-input'),
    rememberSession: document.getElementById('remember-session'),
    authSubmit: document.getElementById('auth-submit'),
    authError: document.getElementById('auth-error'),
    refreshButton: document.getElementById('btn-refresh'),
    pageQrButton: document.getElementById('btn-page-qr'),
    installButton: document.getElementById('btn-install'),
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

document.addEventListener('DOMContentLoaded', init);

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
    setButtonContent(dom.zipButton, 'download', '선택 ZIP 다운로드');
    setButtonContent(dom.cancelZipButton, 'x', '취소');
    setButtonContent(dom.previewDownloadButton, 'download', '다운로드');
    setButtonContent(dom.previewPrintButton, 'print', '인쇄');
    setButtonContent(dom.previewCloseButton, 'x', '닫기');
    setButtonContent(dom.previewCloseTopButton, 'x', '닫기');
    setButtonContent(dom.qrCopyButton, 'copy', '링크 복사');
    setButtonContent(dom.qrCloseButton, 'x', '닫기');
    setButtonContent(dom.qrCloseTopButton, 'x', '닫기');
    setCompactButtonLabels();
    registerServiceWorker();

    if (!window.crypto?.subtle) {
        showView(dom.authView);
        showAuthError('이 브라우저는 Web Crypto API를 지원하지 않습니다.');
        dom.authSubmit.disabled = true;
        return;
    }

    const storedKey = sessionStorage.getItem(SESSION_KEY);
    if (storedKey) {
        unlockWithStoredKey(storedKey);
        return;
    }

    showView(dom.authView);
    dom.passwordInput.focus();
}

function bindEvents() {
    dom.passwordForm.addEventListener('submit', handlePasswordSubmit);
    dom.refreshButton.addEventListener('click', () => reloadEncryptedManifest({ manual: true }));
    dom.pageQrButton.addEventListener('click', () => showQrModal('현재 페이지 QR', getCurrentPageLink(), '현재 페이지'));
    dom.lockButton.addEventListener('click', () => lockDrive());
    dom.searchInput.addEventListener('input', applyFilters);
    dom.clearSearchButton.addEventListener('click', clearSearch);
    dom.filterChips.addEventListener('click', handleFilterClick);
    dom.sortSelect.addEventListener('change', applyFilters);
    dom.selectionModeButton.addEventListener('click', toggleSelectionMode);
    dom.selectAllButton.addEventListener('click', toggleSelectAll);
    dom.clearSelectionButton.addEventListener('click', clearSelection);
    dom.allZipButton.addEventListener('click', downloadAllAsZip);
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
        }
    });

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        dom.installButton.hidden = false;
    });

    bindIdleLockEvents();
}

function bindIdleLockEvents() {
    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach((eventName) => {
        window.addEventListener(eventName, resetIdleLockTimer, { passive: true, capture: true });
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            resetIdleLockTimer();
        }
    });
}

async function unlockWithStoredKey(rawKeyBase64) {
    showView(dom.loadingView);
    try {
        const key = await importAesKey(base64ToBytes(rawKeyBase64));
        await unlockWithKey(key);
    } catch (error) {
        console.warn('Stored session key could not unlock the manifest.', error);
        sessionStorage.removeItem(SESSION_KEY);
        decryptKey = null;
        showView(dom.authView);
        dom.passwordInput.focus();
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

    try {
        showOverlay('비밀번호로 복호화 키를 만드는 중입니다...');
        const envelope = await loadManifestEnvelope();
        const keyBytes = await deriveKeyBytes(password, envelope.crypto.kdf);
        const key = await importAesKey(keyBytes);
        await unlockWithKey(key);

        if (dom.rememberSession.checked) {
            sessionStorage.setItem(SESSION_KEY, bytesToBase64(new Uint8Array(keyBytes)));
        } else {
            sessionStorage.removeItem(SESSION_KEY);
        }

        dom.passwordInput.value = '';
    } catch (error) {
        console.error(error);
        sessionStorage.removeItem(SESSION_KEY);
        showView(dom.authView);
        showAuthError('비밀번호가 맞지 않거나 암호화 목록을 열 수 없습니다.');
    } finally {
        dom.authSubmit.disabled = false;
        hideOverlay();
    }
}

async function unlockWithKey(key) {
    decryptKey = key;
    await reloadEncryptedManifest({ throwOnError: true });
    showView(dom.appView);
    resetIdleLockTimer();
    handleRequestedFile();
}

async function reloadEncryptedManifest(options = {}) {
    setLoading(true, options.manual ? '암호화된 목록을 새로고침하는 중입니다...' : '암호화된 목록을 여는 중입니다...');

    try {
        const envelope = await loadManifestEnvelope(true);
        const manifest = await decryptManifest(envelope, decryptKey);
        allFiles = manifest.files.map((file, index) => normalizeFile(file, index, manifest.createdAt));
        selectedIds = new Set([...selectedIds].filter((id) => allFiles.some((file) => file.id === id)));
        applyFilters();

        if (options.manual) {
            showToast('암호화된 파일 목록을 새로고침했습니다.', 'success');
        }
    } catch (error) {
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
        setLoading(false);
    }
}

async function loadManifestEnvelope(force = false) {
    if (manifestEnvelope && !force) {
        return manifestEnvelope;
    }

    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        const error = new Error(`암호화 목록을 찾을 수 없습니다. (${response.status})`);
        error.status = response.status;
        throw error;
    }

    manifestEnvelope = await response.json();
    validateManifestEnvelope(manifestEnvelope);
    return manifestEnvelope;
}

function shouldAskForFreshPassword(error) {
    return error?.name === 'OperationError';
}

function promptForFreshPassword() {
    console.info('Current session key could not unlock the latest manifest.');
    clearIdleLockTimer();
    sessionStorage.removeItem(SESSION_KEY);
    decryptKey = null;
    selectedIds.clear();
    lastSelectedId = null;
    isSelectionMode = false;
    dom.appView.classList.remove('selection-mode');
    dom.passwordInput.value = '';
    showView(dom.authView);
    showAuthError('파일 목록이 새로 바뀌었습니다. 비밀번호를 다시 입력해 주세요.');
    dom.passwordInput.focus();
}

function validateManifestEnvelope(envelope) {
    if (
        envelope?.version !== 1 ||
        envelope?.crypto?.kdf?.name !== 'PBKDF2' ||
        envelope?.crypto?.kdf?.hash !== 'SHA-256' ||
        !Number.isInteger(envelope.crypto.kdf.iterations) ||
        !envelope.crypto.kdf.salt ||
        !envelope?.manifest?.iv ||
        !envelope?.manifest?.data
    ) {
        throw new Error('암호화 목록 형식이 올바르지 않습니다.');
    }
}




function normalizeFile(file, index, fallbackModifiedAt) {
    const extension = file.extension || getExtension(file.name);
    const type = file.type || getFileType(extension);
    const modifiedAt = parseDateValue(file.modifiedAt || fallbackModifiedAt);
    const displayName = createDisplayName(file.name, extension);

    return {
        id: file.id,
        name: file.name,
        displayName,
        size: Number(file.size || 0),
        encryptedSize: Number(file.encryptedSize || 0),
        extension,
        type,
        mime: file.mime || getMimeType(extension),
        path: file.path,
        iv: file.iv,
        sha256: file.sha256,
        modifiedAt,
        apiIndex: index
    };
}

function applyFilters() {
    const query = dom.searchInput.value.trim().toLocaleLowerCase('ko-KR');
    const sortBy = dom.sortSelect.value;
    dom.clearSearchButton.hidden = query.length === 0;

    visibleFiles = allFiles.filter((file) => {
        const originalName = file.name.toLocaleLowerCase('ko-KR');
        const displayName = file.displayName.toLocaleLowerCase('ko-KR');
        const matchesQuery = !query || originalName.includes(query) || displayName.includes(query);
        const matchesType = activeFilter === 'all' || file.type === activeFilter || (activeFilter === 'other' && file.type === 'archive');
        return matchesQuery && matchesType;
    });

    visibleFiles.sort((a, b) => {
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
    });

    renderFiles();
    updateSelection();
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
}

function renderFiles() {
    dom.fileList.replaceChildren();

    if (allFiles.length === 0) {
        dom.fileList.appendChild(createStateItem('FILE', '현재 파일이 없습니다.', '아직 다운로드할 수 있는 파일이 없습니다.'));
        updateResultCount();
        return;
    }

    if (visibleFiles.length === 0) {
        const item = createStateItem('검색', '검색 결과가 없습니다.', '검색어 또는 파일 타입 필터를 조정해 주세요.');
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

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = isPreviewableFile(file) ? 'preview-action' : 'secondary preview-action';
    previewButton.title = isPreviewableFile(file) ? '미리보기' : '이 형식은 미리보기를 지원하지 않습니다.';
    previewButton.disabled = !isPreviewableFile(file);
    setButtonContent(previewButton, 'open', isPreviewableFile(file) ? '미리보기' : '미리보기 불가');
    previewButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        await openFile(file.id);
    });

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = isPreviewableFile(file) ? 'secondary download-action' : 'download-action';
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
    setButtonContent(qrButton, 'qr', 'QR 보기');
    qrButton.addEventListener('click', (event) => {
        event.stopPropagation();
        moreMenu.open = false;
        showQrModal(`${file.displayName} QR`, createFileAppLink(file), file.name);
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
        return 'files/manifest.enc가 없습니다. private_files/에 원본을 넣고 암호화 스크립트를 먼저 실행해 주세요.';
    }

    if (error instanceof TypeError) {
        return '네트워크 오류가 발생했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.';
    }

    if (error?.status) {
        return `${error.message}. 방금 파일을 넣었다면 10~30초 후 다시 시도해 주세요.`;
    }

    return '비밀번호가 바뀌었거나 암호화 파일이 갱신 중일 수 있습니다. 잠시 후 다시 시도해 주세요.';
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
    if (isPreviewableFile(file)) {
        await openFile(file.id);
    } else {
        await downloadSingleFile(file.id);
    }
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
    dom.allZipButton.disabled = isLoading || isZipRunning || allFiles.length === 0;
    dom.selectionModeButton.classList.toggle('active', isSelectionMode);
    setButtonContent(dom.selectionModeButton, isSelectionMode ? 'x' : 'check', isSelectionMode ? '완료' : '선택');
    dom.selectAllButton.disabled = isLoading || !isSelectionMode || visibleFiles.length === 0;
    dom.clearSelectionButton.disabled = isLoading || !isSelectionMode || selectedCount === 0;
    dom.zipButton.disabled = isLoading || isZipRunning || !isSelectionMode || selectedCount === 0;
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
    lastSelectedId = null;
    updateSelection();
}

async function downloadSingleFile(fileId) {
    const file = findFile(fileId);
    if (!file) {
        showToast('파일 정보를 찾지 못했습니다.', 'error');
        return;
    }

    showOverlay(`${file.name} 복호화 중입니다...`);
    try {
        const decrypted = await fetchAndDecryptFile(file, decryptKey);
        downloadBlob(new Blob([decrypted.bytes], { type: file.mime }), file.name);
        showToast('다운로드를 시작했습니다.', 'success');
    } catch (error) {
        console.error(error);
        showToast('파일 복호화에 실패했습니다.', 'error');
    } finally {
        hideOverlay();
    }
}

async function openFile(fileId) {
    const file = findFile(fileId);
    if (!file) {
        showToast('파일 정보를 찾지 못했습니다.', 'error');
        return;
    }

    if (!isPreviewableFile(file)) {
        showToast('이 파일 형식은 미리보기를 지원하지 않습니다.', 'info');
        return;
    }

    showOverlay(`${file.name} 복호화 중입니다...`);

    try {
        const decrypted = await fetchAndDecryptFile(file, decryptKey);
        const blob = new Blob([decrypted.bytes], { type: file.mime });
        await showPreviewModal(file, blob, decrypted.bytes);
    } catch (error) {
        console.error(error);
        showPreviewFailure(file);
    } finally {
        hideOverlay();
    }
}

async function showPreviewModal(file, blob, bytes) {
    closePreviewModal({ silent: true });

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
        showPreviewFailure(file, { keepState: true });
        return;
    }

    dom.previewModal.hidden = false;
    dom.previewCloseButton.focus();
}

function showPreviewFailure(file, options = {}) {
    if (!options.keepState) {
        closePreviewModal({ silent: true });
        previewState = { file, blob: null, objectUrl: null };
    }

    dom.previewTitle.textContent = file.name;
    dom.previewMeta.textContent = `${FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other} · ${formatSize(file.size)}`;
    dom.previewBody.replaceChildren();
    const fallback = document.createElement('div');
    fallback.className = 'preview-fallback';
    const title = document.createElement('h3');
    title.textContent = '미리보기를 표시할 수 없습니다.';
    const message = document.createElement('p');
    message.textContent = '브라우저에서 이 파일을 안전하게 표시하지 못했습니다. 다운로드해서 확인해 주세요.';
    fallback.append(title, message);
    dom.previewBody.appendChild(fallback);
    dom.previewPrintButton.disabled = true;
    dom.previewModal.hidden = false;
    dom.previewDownloadButton.focus();
}

function closePreviewModal(options = {}) {
    if (previewState.objectUrl) {
        URL.revokeObjectURL(previewState.objectUrl);
    }

    previewState = { file: null, blob: null, objectUrl: null };
    dom.previewBody.replaceChildren();
    dom.previewModal.hidden = true;

    if (!options.silent) {
        dom.fileList.focus();
    }
}

async function downloadPreviewFile() {
    if (!previewState.file) {
        return;
    }

    if (previewState.blob) {
        downloadBlob(previewState.blob, previewState.file.name);
        return;
    }

    await downloadSingleFile(previewState.file.id);
}

function printPreviewFile() {
    if (!previewState.objectUrl) {
        showToast('인쇄할 미리보기 파일이 없습니다.', 'warning');
        return;
    }

    const frame = document.createElement('iframe');
    frame.className = 'print-frame';
    frame.src = previewState.objectUrl;
    document.body.appendChild(frame);
    frame.addEventListener('load', () => {
        try {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
        } catch (error) {
            console.error(error);
            showToast('브라우저에서 인쇄 창을 열지 못했습니다.', 'error');
        } finally {
            window.setTimeout(() => frame.remove(), 1_000);
        }
    }, { once: true });
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

    isZipRunning = true;
    zipCancelRequested = false;
    dom.cancelZipButton.hidden = false;
    dom.cancelZipButton.disabled = false;
    updateSelection();
    showOverlay(`${label} 준비 중입니다...`);

    try {
        const zipEntries = [];
        for (let index = 0; index < files.length; index += 1) {
            if (zipCancelRequested) {
                throw new Error('ZIP_CANCELLED');
            }

            const file = files[index];
            dom.loadingMessage.textContent = `${label} 생성 중: ${index + 1} / ${files.length} · ${file.displayName}`;
            const decrypted = await fetchAndDecryptFile(file, decryptKey);
            zipEntries.push({
                name: `${ZIP_FOLDER_NAME}/${file.name}`,
                bytes: decrypted.bytes
            });
        }

        dom.loadingMessage.textContent = 'ZIP 파일을 생성하는 중입니다...';
        const zipBlob = createZipBlob(zipEntries);
        downloadBlob(zipBlob, ZIP_FILE_NAME);
        if (label === '선택 ZIP') {
            clearSelection();
        }
        showToast(`${label} 다운로드를 시작했습니다.`, 'success');
    } catch (error) {
        if (error.message === 'ZIP_CANCELLED') {
            showToast('ZIP 생성을 취소했습니다.', 'warning');
            return;
        }

        console.error(error);
        showToast('ZIP 생성 중 오류가 발생했습니다.', 'error');
    } finally {
        isZipRunning = false;
        zipCancelRequested = false;
        dom.cancelZipButton.hidden = true;
        dom.cancelZipButton.disabled = false;
        hideOverlay();
        updateSelection();
    }
}

function cancelZipDownload() {
    zipCancelRequested = true;
    dom.cancelZipButton.disabled = true;
    dom.loadingMessage.textContent = 'ZIP 생성을 취소하는 중입니다...';
}







function showQrModal(title, link, meta) {
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

    dom.qrModal.hidden = false;
    dom.qrCopyButton.focus();
}

function closeQrModal() {
    qrState = { link: '' };
    dom.qrModal.hidden = true;
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
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
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
        return;
    }

    const file = findFile(requestedId);
    if (!file) {
        showToast('링크의 파일을 찾지 못했습니다.', 'warning');
        return;
    }

    selectedIds.add(file.id);
    updateSelection();
    const item = dom.fileList.querySelector(`[data-file-id="${cssEscape(file.id)}"]`);
    item?.scrollIntoView({ block: 'center' });
    showToast('링크의 파일을 선택했습니다.', 'success');
}

function findFile(fileId) {
    return allFiles.find((file) => file.id === fileId);
}

function lockDrive(options = {}) {
    clearIdleLockTimer();
    decryptKey = null;
    allFiles = [];
    visibleFiles = [];
    selectedIds.clear();
    isSelectionMode = false;
    activeFilter = 'all';
    updateFilterChips();
    closePreviewModal({ silent: true });
    closeQrModal();
    dom.appView.classList.remove('selection-mode');
    sessionStorage.removeItem(SESSION_KEY);
    dom.searchInput.value = '';
    dom.passwordInput.value = '';
    showView(dom.authView);
    dom.passwordInput.focus();
    showToast(options.idle ? '10분 동안 사용하지 않아 자동 잠금되었습니다.' : '잠금 상태로 전환했습니다.', 'success');
}

function resetIdleLockTimer() {
    if (!decryptKey) {
        return;
    }

    clearIdleLockTimer();
    idleLockTimer = window.setTimeout(() => {
        lockDrive({ idle: true });
    }, IDLE_LOCK_MS);
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
    dom.selectionModeButton.disabled = loading || visibleFiles.length === 0;
    dom.allZipButton.disabled = loading || isZipRunning || allFiles.length === 0;
    dom.selectAllButton.disabled = loading || !isSelectionMode || visibleFiles.length === 0;
    dom.clearSelectionButton.disabled = loading || !isSelectionMode || selectedIds.size === 0;
    dom.zipButton.disabled = loading || isZipRunning || !isSelectionMode || selectedIds.size === 0;

    if (loading && dom.appView.hidden) {
        showView(dom.loadingView);
    } else if (loading) {
        showOverlay(message);
    } else {
        hideOverlay();
    }
}

function showOverlay(message) {
    dom.loadingMessage.textContent = message;
    dom.loader.hidden = false;
}

function hideOverlay() {
    dom.loader.hidden = true;
}

function showView(view) {
    [dom.authView, dom.loadingView, dom.appView].forEach((section) => {
        section.hidden = section !== view;
    });
}

function showAuthError(message) {
    dom.authError.textContent = message;
    dom.authError.hidden = false;
    dom.passwordInput.select();
}

function hideAuthError() {
    dom.authError.textContent = '';
    dom.authError.hidden = true;
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
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
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

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        return;
    }

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((error) => {
            console.info('Service worker registration skipped:', error);
        });
    });
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
