import { logicalBasename, logicalParent, normalizeLogicalPath } from './logical_path.js';

export function normalizeManifestRelativePath(file) {
    return normalizeLogicalPath(file?.relativePath || file?.name);
}

export function describeFolderEntries(files, currentFolder = '') {
    const normalizedFolder = currentFolder ? normalizeLogicalPath(currentFolder) : '';
    const prefix = normalizedFolder ? `${normalizedFolder}/` : '';
    const folders = new Map();
    for (const file of files) {
        const relativePath = normalizeLogicalPath(file.relativePath);
        if (!relativePath.startsWith(prefix)) continue;
        const remainder = relativePath.slice(prefix.length);
        const separator = remainder.indexOf('/');
        if (separator < 0) continue;
        const name = remainder.slice(0, separator);
        const folderPath = `${prefix}${name}`;
        const existing = folders.get(folderPath) || { name, path: folderPath, fileCount: 0, totalSize: 0 };
        existing.fileCount += 1;
        existing.totalSize += file.size;
        folders.set(folderPath, existing);
    }
    return [...folders.values()].sort((left, right) => left.name.localeCompare(right.name, 'ko-KR', { numeric: true, sensitivity: 'base' }));
}

export function filesInFolder(files, currentFolder = '', recursive = false) {
    const normalizedFolder = currentFolder ? normalizeLogicalPath(currentFolder) : '';
    if (recursive) {
        const prefix = normalizedFolder ? `${normalizedFolder}/` : '';
        return files.filter((file) => !normalizedFolder || file.relativePath.startsWith(prefix));
    }
    return files.filter((file) => logicalParent(file.relativePath) === normalizedFolder);
}

export function breadcrumbFolders(currentFolder = '') {
    if (!currentFolder) return [];
    const segments = normalizeLogicalPath(currentFolder).split('/');
    return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join('/') }));
}

export function zipEntryPath(file, archiveRoot) {
    const root = normalizeLogicalPath(archiveRoot);
    return `${root}/${normalizeLogicalPath(file.relativePath)}`;
}

export function normalizeManifestFile(file) {
    const relativePath = normalizeManifestRelativePath(file);
    return { relativePath, name: logicalBasename(relativePath), parentPath: logicalParent(relativePath) };
}
