#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getConfiguredPaths, displayPath } from './paths.mjs';
import { assertPublicFilesClean, inspectPublicFiles } from './public_files_guard.mjs';

export async function main() {
    const { outputDir } = getConfiguredPaths();
    await access(outputDir);
    await assertPublicFilesClean(outputDir, {
        displayDir: displayPath(outputDir),
        requireManifest: true
    });
    const inspection = await inspectPublicFiles(outputDir, {
        displayDir: displayPath(outputDir),
        allowLegacyV1: true,
        verifyCiphertext: true,
        rejectUnreferenced: true
    });
    if (inspection.legacyV1) {
        console.warn('Public files check passed in legacy v1 mode; manifest-to-blob references cannot be proven until v2 migration.');
    } else {
        console.log(`Public files check passed with ${inspection.objects.length} verified v2 object(s).`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
