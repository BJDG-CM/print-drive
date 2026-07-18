#!/usr/bin/env node
import { webcrypto } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfiguredPaths, PROJECT_ROOT } from '../paths.mjs';
import {
    decryptFileV2,
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey
} from '../vault_format.mjs';
import { inspectPublicFiles } from '../public_files_guard.mjs';
import { buildDist } from './build_dist.mjs';

export async function verifyProductionVault(options = {}) {
    const outputDir = path.resolve(options.outputDir || getConfiguredPaths().outputDir);
    const publicInspection = await inspectPublicFiles(outputDir, {
        allowLegacyV1: false,
        verifyCiphertext: true,
        rejectUnreferenced: true
    });
    const build = await buildDist({ outputDir });
    const passphrase = options.passphrase ?? await readAvailablePassphrase(options.passwordFile);
    const metrics = {
        manifestVersion: publicInspection.envelope.version,
        manifestSchema: publicInspection.envelope.manifest.schema,
        revision: publicInspection.envelope.manifest.revision,
        manifestUnlocked: false,
        filesChecked: publicInspection.objects.length,
        bytesChecked: publicInspection.objects.reduce((sum, object) => sum + object.encryptedSize, 0),
        objectsMissing: 0,
        integrityFailures: 0,
        authenticationFailures: 0,
        plaintextAuthenticationRan: false,
        browserProductionInterop: false,
        buildId: build.buildIdentity.buildId
    };

    if (!passphrase) {
        printMetrics(metrics);
        console.log('production plaintext authentication: not executed (passphrase unavailable)');
        return metrics;
    }

    const envelope = parseEnvelopeText(await readFile(path.join(outputDir, 'manifest.enc'), 'utf8'));
    const unlocked = unlockVaultKey(envelope, passphrase);
    try {
        const manifest = decryptManifestV2(envelope, unlocked.vaultKey);
        metrics.manifestUnlocked = true;
        metrics.filesChecked = 0;
        metrics.bytesChecked = 0;
        for (const file of manifest.files) {
            const encrypted = await readFile(path.join(outputDir, `${file.blobId}.bin`));
            const plaintext = decryptFileV2(file, encrypted, unlocked.vaultKey, envelope.vaultId);
            metrics.filesChecked += 1;
            metrics.bytesChecked += plaintext.byteLength;
            plaintext.fill(0);
        }
        metrics.plaintextAuthenticationRan = true;
        metrics.browserProductionInterop = await verifyBuiltBrowser(build.distDir, passphrase);
    } catch (error) {
        if (/auth|password|decrypt|Unsupported state/i.test(error.message)) {
            metrics.authenticationFailures += 1;
        } else {
            metrics.integrityFailures += 1;
        }
        throw error;
    } finally {
        unlocked.vaultKey.fill(0);
    }
    printMetrics(metrics);
    return metrics;
}

async function verifyBuiltBrowser(distDir, passphrase) {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    const previousLocation = globalThis.location;
    globalThis.location = new URL('https://production.invalid/print-drive/');
    const browserCrypto = await import(`${pathToFileURL(path.join(distDir, 'crypto.js')).href}?verify=${Date.now()}`);
    const envelope = JSON.parse(await readFile(path.join(distDir, 'files', 'manifest.enc'), 'utf8'));
    const context = await browserCrypto.unlockVault(passphrase, envelope);
    const manifest = await browserCrypto.decryptManifest(envelope, context);
    const originalFetch = globalThis.fetch;
    try {
        for (const file of manifest.files) {
            const bytes = await readFile(path.join(distDir, ...file.path.split('/')));
            globalThis.fetch = async () => new Response(bytes, {
                status: 200,
                headers: { 'content-length': String(bytes.byteLength) }
            });
            const decrypted = await browserCrypto.fetchAndDecryptFile(file, context);
            decrypted.bytes.fill(0);
        }
        return true;
    } finally {
        context.rawKeyBytes.fill(0);
        globalThis.fetch = originalFetch;
        if (previousLocation === undefined) delete globalThis.location;
        else globalThis.location = previousLocation;
    }
}

async function readAvailablePassphrase(passwordFile) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) {
        return process.env.PRINT_DRIVE_PASSPHRASE;
    }
    const configured = passwordFile || process.env.PRINT_DRIVE_PASSWORD_FILE || getConfiguredPaths().passwordFile;
    try {
        await access(configured);
        return (await readFile(configured, 'utf8')).trimEnd();
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function printMetrics(metrics) {
    console.log(`manifest: v${metrics.manifestVersion} schema ${metrics.manifestSchema} revision ${metrics.revision}`);
    console.log(`manifest unlocked: ${metrics.manifestUnlocked ? 'yes' : 'no'}`);
    console.log(`files checked: ${metrics.filesChecked}`);
    console.log(`bytes checked: ${metrics.bytesChecked}`);
    console.log(`objects missing: ${metrics.objectsMissing}`);
    console.log(`integrity failures: ${metrics.integrityFailures}`);
    console.log(`authentication failures: ${metrics.authenticationFailures}`);
    console.log(`built browser production interop: ${metrics.browserProductionInterop ? 'passed' : 'not executed'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    verifyProductionVault().catch((error) => {
        console.error(`Production vault verification failed: ${error.message}`);
        process.exit(1);
    });
}
