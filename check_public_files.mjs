#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { getConfiguredPaths, displayPath } from './paths.mjs';
import { assertPublicFilesClean } from './public_files_guard.mjs';

async function main() {
    const { outputDir } = getConfiguredPaths();
    await mkdir(outputDir, { recursive: true });
    await assertPublicFilesClean(outputDir, { displayDir: displayPath(outputDir) });
    console.log(`Public files check passed: ${displayPath(outputDir)}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
