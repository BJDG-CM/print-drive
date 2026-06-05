import {
    FILE_TYPE_ICONS,
    FILE_TYPE_LABELS,
    getExtension,
    getFileType,
    getMimeType,
    isPreviewableFile
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

const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });

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
    installButton: document.getElementById('btn-install'),
    lockButton: document.getElementById('btn-lock'),
    searchInput: document.getElementById('search-input'),
    typeFilter: document.getElementById('type-filter'),
    sortSelect: document.getElementById('sort-select'),
    resultCount: document.getElementById('result-count'),
    selectedCount: document.getElementById('selected-count'),
    selectionModeButton: document.getElementById('btn-selection-mode'),
    selectAllButton: document.getElementById('btn-select-all'),
    clearSelectionButton: document.getElementById('btn-clear-selection'),
    zipButton: document.getElementById('btn-download-selected'),
    fileList: document.getElementById('file-list'),
    loader: document.getElementById('global-loader'),
    loadingMessage: document.getElementById('loading-message'),
    toastRoot: document.getElementById('toast-root')
};

document.addEventListener('DOMContentLoaded', init);

function init() {
    bindEvents();
    setButtonContent(dom.refreshButton, 'refresh', '새로고침');
    setButtonContent(dom.installButton, 'plus', '설치');
    setButtonContent(dom.lockButton, 'lock', '잠금');
    setButtonContent(dom.selectionModeButton, 'check', '선택');
    setButtonContent(dom.selectAllButton, 'check', '전체');
    setButtonContent(dom.clearSelectionButton, 'x', '해제');
    setButtonContent(dom.zipButton, 'download', 'ZIP');
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
    dom.lockButton.addEventListener('click', () => lockDrive());
    dom.searchInput.addEventListener('input', applyFilters);
    dom.typeFilter.addEventListener('change', applyFilters);
    dom.sortSelect.addEventListener('change', applyFilters);
    dom.selectionModeButton.addEventListener('click', toggleSelectionMode);
    dom.selectAllButton.addEventListener('click', toggleSelectAll);
    dom.clearSelectionButton.addEventListener('click', clearSelection);
    dom.zipButton.addEventListener('click', downloadSelectedAsZip);
    dom.installButton.addEventListener('click', promptInstall);

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
        allFiles = manifest.files.map(normalizeFile);
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




function normalizeFile(file, index) {
    const extension = file.extension || getExtension(file.name);
    const type = file.type || getFileType(extension);

    return {
        id: file.id,
        name: file.name,
        size: Number(file.size || 0),
        encryptedSize: Number(file.encryptedSize || 0),
        extension,
        type,
        mime: file.mime || getMimeType(extension),
        path: file.path,
        iv: file.iv,
        sha256: file.sha256,
        apiIndex: index
    };
}

function applyFilters() {
    const query = dom.searchInput.value.trim().toLocaleLowerCase('ko-KR');
    const filterType = dom.typeFilter.value;
    const sortBy = dom.sortSelect.value;

    visibleFiles = allFiles.filter((file) => {
        const matchesQuery = !query || file.name.toLocaleLowerCase('ko-KR').includes(query);
        const matchesType = filterType === 'all' || file.type === filterType || (filterType === 'other' && file.type === 'archive');
        return matchesQuery && matchesType;
    });

    visibleFiles.sort((a, b) => {
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

function renderFiles() {
    dom.fileList.replaceChildren();

    if (allFiles.length === 0) {
        dom.fileList.appendChild(createStateItem('📂', '현재 업로드된 파일이 없습니다.', 'private_files/에 파일을 넣고 암호화 스크립트를 실행해 주세요.'));
        updateResultCount();
        return;
    }

    if (visibleFiles.length === 0) {
        dom.fileList.appendChild(createStateItem('🔎', '검색 결과가 없습니다.', '검색어나 파일 타입 필터를 조정해 주세요.'));
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
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
        setFileSelection(file.id, checkbox.checked);
    });

    const info = document.createElement('div');
    info.className = 'file-info';

    const nameLine = document.createElement('div');
    nameLine.className = 'file-name-line';

    const icon = document.createElement('span');
    icon.className = 'file-type-icon';
    icon.textContent = FILE_TYPE_ICONS[file.type] || FILE_TYPE_ICONS.other;
    icon.setAttribute('aria-hidden', 'true');

    const link = document.createElement(isPreviewableFile(file) ? 'a' : 'span');
    link.className = 'file-name-link';
    link.textContent = file.name;
    link.title = file.name;
    if (isPreviewableFile(file)) {
        link.href = createFileAppLink(file);
        link.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await openFile(file.id);
        });
    }

    nameLine.append(icon, link);

    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = `${FILE_TYPE_LABELS[file.type] || FILE_TYPE_LABELS.other} · ${formatSize(file.size)}`;

    info.append(nameLine, meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.title = '다운로드';
    setButtonContent(downloadButton, 'download', '다운로드');
    downloadButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        await downloadSingleFile(file.id);
    });

    actions.append(downloadButton);

    if (isPreviewableFile(file)) {
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'secondary';
        openButton.title = '열기';
        setButtonContent(openButton, 'open', '열기');
        openButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            await openFile(file.id);
        });
        actions.append(openButton);
    }

    item.addEventListener('click', () => {
        if (isSelectionMode) {
            setFileSelection(file.id, !selectedIds.has(file.id));
        }
    });

    item.append(checkbox, info, actions);
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

function setFileSelection(fileId, shouldSelect) {
    if (shouldSelect) {
        selectedIds.add(fileId);
    } else {
        selectedIds.delete(fileId);
    }

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
    }

    updateSelection();
}

function updateSelection() {
    const selectedCount = selectedIds.size;
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

    dom.selectedCount.textContent = `선택 ${selectedCount}개`;
    dom.selectedCount.hidden = !isSelectionMode;
    dom.selectionModeButton.disabled = isLoading || visibleFiles.length === 0;
    dom.selectionModeButton.classList.toggle('active', isSelectionMode);
    setButtonContent(dom.selectionModeButton, isSelectionMode ? 'x' : 'check', isSelectionMode ? '완료' : '선택');
    dom.selectAllButton.disabled = isLoading || !isSelectionMode || visibleFiles.length === 0;
    dom.clearSelectionButton.disabled = isLoading || !isSelectionMode || selectedCount === 0;
    dom.zipButton.disabled = isLoading || !isSelectionMode || selectedCount === 0;
    setButtonContent(dom.zipButton, 'download', selectedCount > 0 ? `${selectedCount}개 ZIP` : 'ZIP');
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

    updateSelection();
}

function clearSelection() {
    selectedIds.clear();
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
        await downloadSingleFile(file.id);
        showToast('이 파일 형식은 새 탭 미리보기를 제한하고 다운로드만 허용합니다.', 'info');
        return;
    }

    const previewWindow = window.open('', '_blank', 'noopener');
    showOverlay(`${file.name} 복호화 중입니다...`);

    try {
        const decrypted = await fetchAndDecryptFile(file, decryptKey);
        const blob = new Blob([decrypted.bytes], { type: file.mime });
        const url = URL.createObjectURL(blob);

        if (previewWindow) {
            previewWindow.location.href = url;
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } else {
            downloadBlob(blob, file.name);
            window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        }

        showToast('복호화된 파일을 열었습니다.', 'success');
    } catch (error) {
        console.error(error);
        if (previewWindow) {
            previewWindow.close();
        }
        showToast('파일을 열지 못했습니다.', 'error');
    } finally {
        hideOverlay();
    }
}

async function downloadSelectedAsZip() {
    const selectedFiles = allFiles.filter((file) => selectedIds.has(file.id));
    if (selectedFiles.length === 0) {
        return;
    }

    showOverlay(`선택한 ${selectedFiles.length}개 파일을 복호화하는 중입니다...`);

    try {
        const zipEntries = [];
        for (let index = 0; index < selectedFiles.length; index += 1) {
            const file = selectedFiles[index];
            dom.loadingMessage.textContent = `[${index + 1} / ${selectedFiles.length}] ${file.name} 복호화 중입니다...`;
            const decrypted = await fetchAndDecryptFile(file, decryptKey);
            zipEntries.push({
                name: `${ZIP_FOLDER_NAME}/${file.name}`,
                bytes: decrypted.bytes
            });
        }

        dom.loadingMessage.textContent = 'ZIP 파일을 생성하는 중입니다...';
        const zipBlob = createZipBlob(zipEntries);
        downloadBlob(zipBlob, ZIP_FILE_NAME);
        clearSelection();
        showToast('ZIP 생성이 완료되었습니다.', 'success');
    } catch (error) {
        console.error(error);
        showToast('ZIP 생성 중 오류가 발생했습니다.', 'error');
    } finally {
        hideOverlay();
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
    dom.typeFilter.disabled = loading;
    dom.sortSelect.disabled = loading;
    dom.selectionModeButton.disabled = loading || visibleFiles.length === 0;
    dom.selectAllButton.disabled = loading || !isSelectionMode || visibleFiles.length === 0;
    dom.clearSelectionButton.disabled = loading || !isSelectionMode || selectedIds.size === 0;
    dom.zipButton.disabled = loading || !isSelectionMode || selectedIds.size === 0;

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
