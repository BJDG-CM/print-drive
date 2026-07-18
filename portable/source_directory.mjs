import { spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function inspectSourceDirectory(directory) {
    const absolute = path.resolve(directory || '');
    await access(absolute);
    let files = 0;
    let bytes = 0;
    async function walk(current) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`심볼릭 링크는 원본 폴더에 사용할 수 없습니다: ${entry.name}`);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                const handle = await stat(full);
                files += 1;
                bytes += handle.size;
            }
        }
    }
    await walk(absolute);
    return { path: absolute, files, bytes };
}

export function selectSourceDirectory(initialDirectory, options = {}) {
    if (process.platform !== 'win32') throw new Error('폴더 선택 창은 Windows에서만 사용할 수 있습니다.');
    const spawnFunction = options.spawnFunction || spawn;
    const initial = String(initialDirectory || '').replaceAll("'", "''");
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dialog.Description = 'Print Drive 원본 폴더 선택'",
        `$dialog.SelectedPath = '${initial}'`,
        '$dialog.ShowNewFolderButton = $false',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }'
    ].join('; ');
    return new Promise((resolve, reject) => {
        const child = spawnFunction('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code) => {
            if (code !== 0) return reject(new Error(`폴더 선택 창을 열지 못했습니다: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`));
            const selected = Buffer.concat(stdout).toString('utf8').trim();
            resolve(selected || null);
        });
    });
}

export function openSourceDirectory(directory, options = {}) {
    if (process.platform !== 'win32') throw new Error('폴더 열기는 Windows에서만 사용할 수 있습니다.');
    const child = (options.spawnFunction || spawn)('explorer.exe', [path.resolve(directory)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    });
    child.unref();
}
