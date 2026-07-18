#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, validateConfigObject } from '../config.mjs';
import {
    fileRelativePath,
    main as encryptMain,
    readSourceFiles,
    writeSourceState
} from '../encrypt_files.mjs';
import { getConfiguredPaths, getProjectConfig, PROJECT_ROOT } from '../paths.mjs';
import {
    decryptManifestV2,
    parseEnvelopeText,
    unlockVaultKey,
    validateEnvelopeV2
} from '../vault_format.mjs';

export async function relinkSource(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const configured = getProjectConfig();
    const runtime = getConfiguredPaths({
        source: options.source,
        output: options.output,
        passwordFile: options.passwordFile,
        requireDirectories: true
    });
    await ensureCurrentRemoteBase({ ...configured.config, projectRoot: PROJECT_ROOT });

    const passphrase = await readPassphrase(runtime.passwordFile);
    const envelope = parseEnvelopeText(await readFile(path.join(runtime.outputDir, 'manifest.enc'), 'utf8'));
    validateEnvelopeV2(envelope);
    if (options.expectedVaultId && envelope.vaultId !== options.expectedVaultId) {
        throw new Error(`Vault ID mismatch: expected ${options.expectedVaultId}, found ${envelope.vaultId}.`);
    }
    const unlocked = unlockVaultKey(envelope, passphrase);
    let manifest;
    let sourceFiles;
    try {
        manifest = decryptManifestV2(envelope, unlocked.vaultKey);
        sourceFiles = await readSourceFiles(runtime.sourceDir, { fullScan: true });
    } finally {
        unlocked.vaultKey.fill(0);
    }
    const plan = classifyRelink(sourceFiles, manifest.files);
    printPlan(plan);

    if (!options.mode) {
        console.log('Dry run only. Choose --adopt, --add-replace, or --mirror to apply a reviewed plan.');
        return { applied: false, plan, envelope, manifest };
    }
    const hasDifferences = plan.localOnly.length || plan.remoteOnly.length || plan.changed.length || plan.moved.length;
    if (options.mode === 'adopt' && hasDifferences) {
        throw new Error('--adopt requires an exact source/vault match; no state or vault files were changed.');
    }
    if (options.mode === 'mirror' && plan.remoteOnly.length > 0) {
        await confirmMirror(plan, options.confirmMirror);
    }

    if (!hasDifferences) {
        const statePath = path.join(path.dirname(runtime.outputDir), '.print-drive-state.json');
        await writeSourceState(statePath, runtime.sourceDir, sourceFiles, envelope, manifest, { fullAudit: true });
        await updateLocalConfig(configured, runtime.sourceDir);
        console.log('Exact match: rebuilt local source state without changing manifest or blobs.');
        return { applied: true, exact: true, plan, envelope, manifest };
    }

    const encryptionArgs = [
        '--source', runtime.sourceDir,
        '--out', runtime.outputDir,
        '--password-file', runtime.passwordFile
    ];
    if (options.mode === 'add-replace') encryptionArgs.push('--preserve-remote');
    await encryptMain(encryptionArgs);
    await updateLocalConfig(configured, runtime.sourceDir);
    console.log(`Relink applied in ${options.mode} mode. Review encrypted output before committing or pushing.`);
    return { applied: true, exact: false, plan };
}

export function classifyRelink(sourceFiles, remoteFiles) {
    const localByPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    const remoteByPath = new Map(remoteFiles.map((file) => [fileRelativePath(file), file]));
    const exact = [];
    const changed = [];
    const unmatchedLocal = [];
    const unmatchedRemote = [];
    for (const local of sourceFiles) {
        const remote = remoteByPath.get(local.relativePath);
        if (!remote) unmatchedLocal.push(local);
        else if (sameContent(local, remote)) exact.push({ local, remote });
        else changed.push({ local, remote });
    }
    for (const remote of remoteFiles) {
        if (!localByPath.has(fileRelativePath(remote))) unmatchedRemote.push(remote);
    }
    const localGroups = groupBy(unmatchedLocal, fingerprint);
    const remoteGroups = groupBy(unmatchedRemote, fingerprint);
    const moved = [];
    const movedLocal = new Set();
    const movedRemote = new Set();
    for (const [key, locals] of localGroups) {
        const remotes = remoteGroups.get(key) || [];
        if (locals.length === 1 && remotes.length === 1) {
            moved.push({ local: locals[0], remote: remotes[0] });
            movedLocal.add(locals[0]);
            movedRemote.add(remotes[0]);
        }
    }
    return {
        exact,
        localOnly: unmatchedLocal.filter((file) => !movedLocal.has(file)),
        remoteOnly: unmatchedRemote.filter((file) => !movedRemote.has(file)),
        changed,
        moved
    };
}

export function ensureCurrentRemoteBase(config) {
    if (process.env.PRINT_DRIVE_SKIP_GIT_PREFLIGHT_FOR_TESTS === '1') return { skipped: true };
    const root = config.projectRoot || PROJECT_ROOT;
    const branch = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== config.allowedBranch) {
        throw new Error(`Current branch ${branch} is not configured allowedBranch ${config.allowedBranch}.`);
    }
    runGit(root, [
        'fetch', '--quiet', '--no-tags', config.remote,
        `refs/heads/${config.allowedBranch}:refs/remotes/${config.remote}/${config.allowedBranch}`
    ]);
    const dirty = runGit(root, ['status', '--porcelain=v1']);
    if (dirty) throw new Error('Worktree is dirty; refusing source relink remote recovery.');
    const [ahead, behind] = runGit(root, [
        'rev-list', '--left-right', '--count',
        `HEAD...${config.remote}/${config.allowedBranch}`
    ]).split(/\s+/).map(Number);
    if (ahead > 0 && behind > 0) throw new Error('Local and remote branches diverged; no merge or rebase was attempted.');
    if (ahead > 0) throw new Error('Local branch is ahead; review or push local commits before relinking.');
    if (behind > 0) {
        runGit(root, ['merge', '--ff-only', `${config.remote}/${config.allowedBranch}`]);
        return { fastForwarded: behind };
    }
    return { fastForwarded: 0 };
}

async function readPassphrase(passwordFile) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) return process.env.PRINT_DRIVE_PASSPHRASE;
    try {
        await access(passwordFile);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error('No passphrase is available. Configure the local password file or PRINT_DRIVE_PASSPHRASE.');
        throw error;
    }
    const value = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
    if (!value) throw new Error('The configured passphrase file is empty.');
    return value;
}

async function updateLocalConfig(loaded, sourceDirectory) {
    const value = validateConfigObject({
        ...(loaded.fromFile ? loaded.config : DEFAULT_CONFIG),
        sourceDirectory
    });
    const target = loaded.configPath || path.join(PROJECT_ROOT, 'print-drive.config.json');
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function confirmMirror(plan, confirmation) {
    plan.remoteOnly.forEach((file) => console.log(`DELETE ${fileRelativePath(file)}`));
    if (confirmation === 'DELETE_REMOTE_ONLY') return;
    if (!process.stdin.isTTY) {
        throw new Error('--mirror requires --confirm-mirror DELETE_REMOTE_ONLY in non-interactive execution.');
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await prompt.question('Type DELETE_REMOTE_ONLY to confirm the listed deletions: ');
        if (answer !== 'DELETE_REMOTE_ONLY') throw new Error('Mirror deletion was not confirmed.');
    } finally {
        prompt.close();
    }
}

function printPlan(plan) {
    console.log('Source relink plan');
    console.log(`exact match: ${plan.exact.length}`);
    console.log(`local-only: ${plan.localOnly.length}`);
    console.log(`remote-only: ${plan.remoteOnly.length}`);
    console.log(`content changed: ${plan.changed.length}`);
    console.log(`renamed or moved (same content): ${plan.moved.length}`);
    for (const entry of plan.moved) {
        console.log(`MOVE ${fileRelativePath(entry.remote)} -> ${entry.local.relativePath}`);
    }
}

function parseArgs(args) {
    const options = { source: null, output: null, passwordFile: null, expectedVaultId: null, mode: null, confirmMirror: null };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--source') options.source = required(args, ++index, arg);
        else if (arg === '--out') options.output = required(args, ++index, arg);
        else if (arg === '--password-file') options.passwordFile = required(args, ++index, arg);
        else if (arg === '--expected-vault-id') options.expectedVaultId = required(args, ++index, arg);
        else if (['--adopt', '--add-replace', '--mirror'].includes(arg)) {
            if (options.mode) throw new Error('Choose only one relink mode.');
            options.mode = arg.slice(2);
        } else if (arg === '--confirm-mirror') options.confirmMirror = required(args, ++index, arg);
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (!options.source) throw new Error('--source <plaintext-folder> is required.');
    if (options.expectedVaultId && !/^[0-9a-f]{32}$/.test(options.expectedVaultId)) throw new Error('--expected-vault-id must be 32 lowercase hex characters.');
    return options;
}

function required(args, index, option) {
    if (!args[index]) throw new Error(`${option} requires a value.`);
    return args[index];
}

function runGit(root, args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) {
        throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
    }
    return result.stdout.trim();
}

function groupBy(values, keyFunction) {
    const groups = new Map();
    for (const value of values) groups.set(keyFunction(value), [...(groups.get(keyFunction(value)) || []), value]);
    return groups;
}

function fingerprint(file) { return `${file.size}:${file.sha256}`; }
function sameContent(left, right) { return left.size === right.size && left.sha256 === right.sha256; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    relinkSource().catch((error) => {
        console.error(`Source relink failed: ${error.message}`);
        process.exit(1);
    });
}
