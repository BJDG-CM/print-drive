#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createZipBlob } from '../zip.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts');
const PACKAGE_NAME = 'PrintDrive-Portable-windows-x64';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export async function buildPortable() {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error(`The mandatory portable target must be built natively on Windows x64; current host is ${process.platform}-${process.arch}.`);
    }
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required to build the SEA executable.');
    await mkdir(path.join(ROOT, '.tmp'), { recursive: true });
    await mkdir(ARTIFACT_ROOT, { recursive: true });
    const temporary = await mkdtemp(path.join(ROOT, '.tmp', 'portable-build-'));
    const packageDirectory = path.join(temporary, 'package', 'PrintDrive-Portable');
    const executable = path.join(packageDirectory, 'PrintDriveUpdater.exe');
    try {
        await mkdir(path.join(packageDirectory, 'Workspace'), { recursive: true });
        const bundle = path.join(temporary, 'portable.cjs');
        await build({
            entryPoints: [path.join(ROOT, 'portable', 'main.mjs')],
            outfile: bundle,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node24',
            sourcemap: false,
            legalComments: 'none',
            minify: false,
            banner: {
                js: 'process.env.PRINT_DRIVE_PORTABLE_MODE = "1"; process.env.PRINT_DRIVE_ROOT = process.env.PRINT_DRIVE_PORTABLE_ROOT || require("node:path").dirname(process.execPath);'
            },
            define: {
                'import.meta.url': JSON.stringify('file:///C:/print-drive/portable/main.mjs')
            }
        });
        const seaBlob = path.join(temporary, 'sea-prep.blob');
        const seaConfig = path.join(temporary, 'sea-config.json');
        await writeFile(seaConfig, `${JSON.stringify({
            main: bundle,
            output: seaBlob,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false
        }, null, 2)}\n`);
        run(process.execPath, ['--experimental-sea-config', seaConfig], ROOT);
        await copyFile(process.execPath, executable);
        run(process.execPath, [
            path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
            executable,
            'NODE_SEA_BLOB',
            seaBlob,
            '--sentinel-fuse', FUSE
        ], ROOT);

        await copyFile(
            path.join(ROOT, 'portable', 'print-drive.workspace.example.json'),
            path.join(packageDirectory, 'print-drive.workspace.json')
        );
        await writeFile(path.join(packageDirectory, 'README.txt'), [
            'Print Drive legacy owner-only 업데이터 (Windows 10/11 x64)',
            'BJDG-CM/print-drive의 기존 소유자 호환 도구이며 범용 installer가 아닙니다.',
            '',
            '1. Workspace 폴더에 업데이트할 평문 파일과 폴더를 넣습니다.',
            '2. PrintDriveUpdater.exe를 실행합니다.',
            '3. 로컬 브라우저에서 비밀번호와 GitHub 로그인을 완료하고 계획을 검토합니다.',
            '4. 직접 main 적용이 보호 규칙으로 막히면 업데이트 브랜치와 PR을 선택합니다.',
            '',
            '비밀번호·token·평문은 설정 파일에 저장되지 않습니다. 조직 정책이 실행 파일을 차단할 수 있습니다.'
        ].join('\r\n'));
        run(executable, ['--smoke-test'], packageDirectory, { PATH: '', PRINT_DRIVE_PORTABLE_ROOT: packageDirectory });

        const archivePath = path.join(ARTIFACT_ROOT, `${PACKAGE_NAME}.zip`);
        const entries = [
            { name: 'PrintDrive-Portable/PrintDriveUpdater.exe', bytes: await readFile(executable) },
            { name: 'PrintDrive-Portable/Workspace/.keep', bytes: Buffer.alloc(0) },
            { name: 'PrintDrive-Portable/print-drive.workspace.json', bytes: await readFile(path.join(packageDirectory, 'print-drive.workspace.json')) },
            { name: 'PrintDrive-Portable/README.txt', bytes: await readFile(path.join(packageDirectory, 'README.txt')) }
        ];
        const zip = createZipBlob(entries);
        const archiveBytes = Buffer.from(await zip.arrayBuffer());
        await writeFile(archivePath, archiveBytes);
        const checksum = createHash('sha256').update(archiveBytes).digest('hex');
        await writeFile(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`);
        console.log(`Built ${archivePath} (${archiveBytes.byteLength} bytes).`);
        return { archivePath, executable, size: archiveBytes.byteLength, checksum };
    } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

function run(command, args, cwd, extraEnvironment = {}) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...extraEnvironment }
    });
    if (result.error || result.status !== 0) {
        throw new Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
    }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    buildPortable().catch((error) => { console.error(error.message); process.exit(1); });
}
