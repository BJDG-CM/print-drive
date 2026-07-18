#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, displayPath, getRuntimeConfig } from '../paths.mjs';
import { inspectPublicFiles } from '../public_files_guard.mjs';
import { assertDistClean } from './check_dist.mjs';
import { collectBrowserAssets } from './dist_contract.mjs';

export async function buildDist(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const runtime = options.outputDir ? null : getRuntimeConfig({ projectRoot });
    const sourceFilesDir = path.resolve(options.outputDir || runtime.encryptedOutputDirectory);
    const distDir = path.resolve(options.distDir || path.join(projectRoot, 'dist'));
    assertManagedDistPath(projectRoot, distDir);

    const inspection = await inspectPublicFiles(sourceFilesDir, {
        displayDir: displayFor(projectRoot, sourceFilesDir),
        allowLegacyV1: options.allowLegacyV1 !== false,
        verifyCiphertext: true,
        rejectUnreferenced: true
    });
    const browserAssets = await collectBrowserAssets(projectRoot);
    const tempBase = path.join(projectRoot, '.tmp');
    await mkdir(tempBase, { recursive: true });
    const workDir = await mkdtemp(path.join(tempBase, 'dist-build-'));
    const stageDir = path.join(workDir, 'stage');
    const backupDir = path.join(workDir, 'previous-dist');

    try {
        await mkdir(path.join(stageDir, 'files'), { recursive: true });
        for (const relative of browserAssets) {
            const target = path.join(stageDir, ...relative.split('/'));
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(path.join(projectRoot, ...relative.split('/')), target);
        }

        await copyFile(path.join(sourceFilesDir, 'manifest.enc'), path.join(stageDir, 'files', 'manifest.enc'));
        for (const name of inspection.referencedNames) {
            await copyFile(path.join(sourceFilesDir, name), path.join(stageDir, 'files', name));
        }

        await assertDistClean(stageDir, {
            projectRoot,
            expectedBrowserAssets: browserAssets,
            allowLegacyV1: options.allowLegacyV1 !== false
        });
        await replaceDistAtomically(distDir, stageDir, backupDir);
    } finally {
        await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }

    if (inspection.legacyV1) {
        console.warn('Built legacy v1 artifact. Target stale files were removed, but v1 cannot prove manifest-to-blob references.');
    }
    console.log(`Built verified GitHub Pages artifact in ${displayFor(projectRoot, distDir)}.`);
    return { distDir, inspection, browserAssets };
}

async function replaceDistAtomically(distDir, stageDir, backupDir) {
    let hadPrevious = false;
    try {
        const current = await lstat(distDir);
        if (current.isSymbolicLink()) {
            throw new Error('Refusing to replace dist because it is a symbolic link.');
        }
        hadPrevious = true;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    if (hadPrevious) {
        await rename(distDir, backupDir);
    }
    try {
        await rename(stageDir, distDir);
    } catch (error) {
        if (hadPrevious) {
            await rename(backupDir, distDir);
        }
        throw error;
    }
    if (hadPrevious) {
        await rm(backupDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

function assertManagedDistPath(projectRoot, distDir) {
    const relative = path.relative(projectRoot, distDir);
    if (relative !== 'dist') {
        throw new Error(`Refusing to build into unmanaged dist path ${distDir}.`);
    }
}

function displayFor(root, filePath) {
    if (root === PROJECT_ROOT) {
        return displayPath(filePath);
    }
    const relative = path.relative(root, filePath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    buildDist().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
