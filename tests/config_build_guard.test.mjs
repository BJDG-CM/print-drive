import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    ConfigError,
    resolveRuntimeConfig,
    validateConfigObject
} from '../config.mjs';
import {
    inspectPublicFiles,
    validateManifestName,
    validateObjectIndex
} from '../public_files_guard.mjs';
import { buildDist } from '../scripts/build_dist.mjs';
import { assertDistClean } from '../scripts/check_dist.mjs';
import { collectBrowserAssets } from '../scripts/dist_contract.mjs';
import { getConfiguredPaths } from '../paths.mjs';

test('strict config rejects unknown and secret-bearing fields', () => {
    assert.throws(() => validateConfigObject({
        sourceDirectory: 'inbox',
        encryptedOutputDirectory: 'files',
        autoSync: true,
        allowedBranch: 'main',
        remote: 'origin',
        password: 'must-not-be-stored'
    }), ConfigError);
    assert.throws(() => validateConfigObject({
        sourceDirectory: 'inbox',
        encryptedOutputDirectory: 'files',
        autoSync: true,
        allowedBranch: 'main',
        remote: 'origin',
        surprise: true
    }), ConfigError);
});

test('path policy supports an external source and rejects unsafe output/overlap', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-config-'));
    try {
        const root = path.join(temp, 'repo');
        const externalSource = path.join(temp, 'external-inbox');
        await mkdir(root);
        await mkdir(externalSource);
        const valid = resolveRuntimeConfig({
            projectRoot: root,
            config: validConfig(externalSource, './files')
        });
        assert.equal(valid.sourceDirectory, externalSource);
        assert.equal(valid.encryptedOutputDirectory, path.join(root, 'files'));

        assert.throws(() => resolveRuntimeConfig({
            projectRoot: root,
            config: validConfig(externalSource, root)
        }), /repository root/);
        assert.throws(() => resolveRuntimeConfig({
            projectRoot: root,
            config: validConfig(externalSource, path.join(temp, 'outside-output'))
        }), /inside the repository/);
        assert.throws(() => resolveRuntimeConfig({
            projectRoot: root,
            config: validConfig(path.join(root, 'inbox'), path.join(root, 'inbox', 'encrypted'))
        }), /must not overlap/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('output symlink/junction escape is rejected when the platform permits creating it', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-symlink-'));
    try {
        const root = path.join(temp, 'repo');
        const source = path.join(temp, 'source');
        const outside = path.join(temp, 'outside');
        await Promise.all([mkdir(root), mkdir(source), mkdir(outside)]);
        try {
            await symlink(outside, path.join(root, 'files-link'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                return;
            }
            throw error;
        }
        assert.throws(() => resolveRuntimeConfig({
            projectRoot: root,
            config: validConfig(source, './files-link')
        }), /inside the repository/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('password files cannot overlap data directories or use an unsafe repository path', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-password-path-'));
    try {
        const root = path.join(temp, 'repo');
        const source = path.join(temp, 'source');
        const output = path.join(root, 'files');
        await Promise.all([mkdir(source), mkdir(output, { recursive: true })]);
        assert.throws(() => getConfiguredPaths({
            projectRoot: root,
            source,
            output,
            passwordFile: path.join(root, 'unsafe-password')
        }), /outside the repository/);
        assert.throws(() => getConfiguredPaths({
            projectRoot: root,
            source,
            output,
            passwordFile: path.join(source, 'password')
        }), /must not be inside sourceDirectory/);
        const safe = getConfiguredPaths({
            projectRoot: root,
            source,
            output,
            passwordFile: path.join(temp, 'local-password')
        });
        assert.equal(safe.passwordFile, path.join(temp, 'local-password'));
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('manifest basename and v2 objectIndex contract are strict', () => {
    assert.throws(() => validateManifestName('../manifest.enc'), /basename/);
    const bytes = Buffer.alloc(32, 7);
    const object = objectMetadata('a'.repeat(32), bytes);
    assert.deepEqual(validateObjectIndex({ version: 1, objects: [object] }), [object]);
    assert.throws(() => validateObjectIndex({
        version: 1,
        objects: [{ ...object, path: '../escape.bin' }]
    }), /must exactly match/);
    assert.throws(() => validateObjectIndex({
        version: 1,
        objects: [object, { ...object }]
    }), /duplicated/);
    const later = objectMetadata('b'.repeat(32), bytes);
    assert.throws(() => validateObjectIndex({
        version: 1,
        objects: [later, object]
    }), /strictly sorted/);
    assert.throws(() => validateObjectIndex({
        version: 1,
        objects: [{ ...object, extra: true }]
    }), /not allowed/);
});

test('v2 public guard verifies references, sizes, hashes, and rejects orphan blobs', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-guard-'));
    try {
        const filesDir = path.join(temp, 'files');
        await mkdir(filesDir);
        const liveBytes = Buffer.alloc(48, 3);
        const live = objectMetadata('b'.repeat(32), liveBytes);
        await writeFile(path.join(filesDir, `${live.blobId}.bin`), liveBytes);
        await writeEnvelope(filesDir, [live]);
        const inspected = await inspectPublicFiles(filesDir);
        assert.equal(inspected.legacyV1, false);
        assert.deepEqual([...inspected.referencedNames], [`${live.blobId}.bin`]);

        const malformed = createV2Envelope([live]);
        malformed.unexpected = true;
        await writeFile(path.join(filesDir, 'manifest.enc'), `${JSON.stringify(malformed)}\n`);
        await assert.rejects(() => inspectPublicFiles(filesDir), /envelope schema is invalid/);
        await writeEnvelope(filesDir, [live]);

        await writeFile(path.join(filesDir, `${'c'.repeat(32)}.bin`), Buffer.alloc(16));
        await assert.rejects(() => inspectPublicFiles(filesDir), /not referenced/);
        await rm(path.join(filesDir, `${'c'.repeat(32)}.bin`));
        await writeFile(path.join(filesDir, `${live.blobId}.bin`), Buffer.alloc(47, 3));
        await assert.rejects(() => inspectPublicFiles(filesDir), /size .* does not match/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('build replaces dist, keeps external assets, and removes stale v2 objects', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-build-'));
    try {
        const root = path.join(temp, 'repo');
        const filesDir = path.join(root, 'files');
        await createMinimalBrowserProject(root);
        await mkdir(filesDir);
        const firstBytes = Buffer.alloc(32, 1);
        const secondBytes = Buffer.alloc(64, 2);
        const first = objectMetadata('d'.repeat(32), firstBytes);
        const second = objectMetadata('e'.repeat(32), secondBytes);
        await writeFile(path.join(filesDir, `${first.blobId}.bin`), firstBytes);
        await writeFile(path.join(filesDir, `${second.blobId}.bin`), secondBytes);
        await writeEnvelope(filesDir, [first, second]);
        await buildDist({ projectRoot: root, outputDir: filesDir });

        const firstDistNames = await readdir(path.join(root, 'dist', 'files'));
        assert(firstDistNames.includes(`${second.blobId}.bin`));
        assert.equal(await readFile(path.join(root, 'dist', 'index.html'), 'utf8'), await readFile(path.join(root, 'index.html'), 'utf8'));
        assert.equal(await readFile(path.join(root, 'dist', 'styles.css'), 'utf8'), 'body { color: #111; }\n');
        assert.equal(await readFile(path.join(root, 'dist', 'capability.js'), 'utf8'), 'export const capability = true;\n');

        await rm(path.join(filesDir, `${second.blobId}.bin`));
        await writeEnvelope(filesDir, [first]);
        await buildDist({ projectRoot: root, outputDir: filesDir });
        const secondDistNames = await readdir(path.join(root, 'dist', 'files'));
        assert(!secondDistNames.includes(`${second.blobId}.bin`));
        assert.deepEqual(secondDistNames.sort(), [`${first.blobId}.bin`, 'manifest.enc'].sort());
        await assertDistClean(path.join(root, 'dist'), { projectRoot: root });
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('legacy v1 build is explicit compatibility mode and target stale files are removed', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-v1-build-'));
    try {
        const root = path.join(temp, 'repo');
        const filesDir = path.join(root, 'files');
        await createMinimalBrowserProject(root);
        await mkdir(filesDir);
        const name = `${'f'.repeat(32)}.bin`;
        await writeFile(path.join(filesDir, name), Buffer.alloc(16, 9));
        await writeFile(path.join(filesDir, 'manifest.enc'), JSON.stringify(createV1Envelope()));
        const built = await buildDist({ projectRoot: root, outputDir: filesDir, allowLegacyV1: true });
        assert.equal(built.inspection.legacyV1, true);
        await assert.rejects(
            () => inspectPublicFiles(filesDir, { allowLegacyV1: false }),
            /migrate to v2/
        );
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('browser artifact discovery refuses symbolic-link assets', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-asset-link-'));
    try {
        const root = path.join(temp, 'repo');
        const outside = path.join(temp, 'outside.css');
        await createMinimalBrowserProject(root);
        await writeFile(outside, '/* must not be copied */\n');
        await rm(path.join(root, 'styles.css'));
        try {
            await symlink(outside, path.join(root, 'styles.css'), 'file');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                return;
            }
            throw error;
        }
        await assert.rejects(() => collectBrowserAssets(root), /symbolic link/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

test('browser artifact discovery rejects inline executable HTML attributes', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'print-drive-inline-html-'));
    try {
        const root = path.join(temp, 'repo');
        await createMinimalBrowserProject(root);
        await writeFile(
            path.join(root, 'index.html'),
            '<!doctype html><link rel="stylesheet" href="styles.css"><button style="color:red">Unsafe</button><script defer src="bootstrap.js"></script>\n'
        );
        await assert.rejects(() => collectBrowserAssets(root), /inline style attributes/);
        await writeFile(
            path.join(root, 'index.html'),
            '<!doctype html><link rel="stylesheet" href="styles.css"><button onclick="unsafe()">Unsafe</button><script defer src="bootstrap.js"></script>\n'
        );
        await assert.rejects(() => collectBrowserAssets(root), /event-handler attributes/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});

function validConfig(sourceDirectory, encryptedOutputDirectory) {
    return {
        sourceDirectory,
        encryptedOutputDirectory,
        autoSync: true,
        allowedBranch: 'main',
        remote: 'origin'
    };
}

function objectMetadata(blobId, bytes) {
    return {
        blobId,
        path: `files/${blobId}.bin`,
        encryptedSize: bytes.byteLength,
        ciphertextSha256: createHash('sha256').update(bytes).digest('hex')
    };
}

async function writeEnvelope(filesDir, objects) {
    await writeFile(path.join(filesDir, 'manifest.enc'), `${JSON.stringify(createV2Envelope(objects))}\n`);
}

function createV2Envelope(objects) {
    return {
        version: 2,
        app: 'print-drive',
        vaultId: '1'.repeat(32),
        keySlots: [{
            id: '2'.repeat(32),
            kdf: {
                name: 'PBKDF2',
                hash: 'SHA-256',
                iterations: 200_000,
                salt: Buffer.alloc(32, 3).toString('base64url')
            },
            wrappedVaultKey: {
                name: 'AES-GCM',
                iv: Buffer.alloc(12, 4).toString('base64url'),
                data: Buffer.alloc(48, 5).toString('base64url')
            }
        }],
        crypto: {
            hkdf: { name: 'HKDF', hash: 'SHA-256' },
            cipher: { name: 'AES-GCM', keyLength: 256, ivLength: 12, tagLength: 128 },
            padding: { blockSize: 0 }
        },
        objectIndex: { version: 1, objects },
        manifest: {
            schema: 2,
            id: '6'.repeat(32),
            revision: 1,
            iv: Buffer.alloc(12, 7).toString('base64url'),
            data: Buffer.alloc(16, 8).toString('base64url')
        }
    };
}

function createV1Envelope() {
    return {
        version: 1,
        app: 'print-drive',
        crypto: {
            kdf: {
                name: 'PBKDF2',
                hash: 'SHA-256',
                iterations: 200_000,
                salt: Buffer.alloc(32, 9).toString('base64')
            },
            cipher: { name: 'AES-GCM' }
        },
        manifest: {
            iv: Buffer.alloc(12, 10).toString('base64'),
            data: Buffer.alloc(16, 11).toString('base64')
        }
    };
}

async function createMinimalBrowserProject(root) {
    await mkdir(root, { recursive: true });
    const files = new Map([
        ['index.html', '<!doctype html><link rel="stylesheet" href="styles.css"><script defer src="bootstrap.js"></script>\n'],
        ['styles.css', 'body { color: #111; }\n'],
        ['bootstrap.js', "import('./app.js');\n"],
        ['app.js', "import { capability } from './capability.js';\nconsole.log(capability);\n"],
        ['capability.js', 'export const capability = true;\n'],
        ['public_device.js', 'export const publicDevice = true;\n'],
        ['manifest.json', '{}\n'],
        ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n'],
        ['robots.txt', 'User-agent: *\nDisallow: /\n'],
        ['sw.js', 'self.addEventListener("fetch", () => {});\n']
    ]);
    await Promise.all([...files].map(([name, value]) => writeFile(path.join(root, name), value)));
}
