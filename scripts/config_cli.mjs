#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    CONFIG_FILE_NAME,
    ConfigError,
    DEFAULT_CONFIG,
    resolveRuntimeConfig,
    validateConfigObject
} from '../config.mjs';
import { PROJECT_ROOT, displayPath } from '../paths.mjs';

const COMMANDS = new Set(['setup', 'check', 'dry-run', 'resolve']);

export async function main(args = process.argv.slice(2)) {
    const parsed = parseArgs(args);
    if (parsed.help) {
        printHelp();
        return;
    }

    if (parsed.command === 'setup') {
        await setupConfig(parsed);
        return;
    }

    const runtime = resolveRuntimeConfig({
        projectRoot: parsed.projectRoot,
        configPath: parsed.configPath,
        sourceDirectory: process.env.PRINT_DRIVE_SOURCE_DIR,
        encryptedOutputDirectory: process.env.PRINT_DRIVE_OUTPUT_DIR,
        requireConfig: parsed.command === 'check',
        requireDirectories: parsed.command === 'check' || parsed.requireDirectories
    });

    if (parsed.command === 'resolve') {
        printResolved(runtime, parsed.json);
        return;
    }

    const git = inspectGit(runtime);
    if (parsed.command === 'check') {
        printCheck(runtime, git);
        return;
    }
    printDryRun(runtime, git);
}

function parseArgs(args) {
    const command = args[0] || 'check';
    if (['--help', '-h'].includes(command)) {
        return { command: 'check', help: true };
    }
    if (!COMMANDS.has(command)) {
        throw new ConfigError(`Unknown config command: ${command}`);
    }

    const options = {
        command,
        projectRoot: PROJECT_ROOT,
        configPath: process.env.PRINT_DRIVE_CONFIG || null,
        sourceDirectory: null,
        encryptedOutputDirectory: null,
        allowedBranch: null,
        remote: null,
        autoSync: null,
        force: false,
        json: false,
        requireDirectories: false,
        help: false
    };

    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--config') {
            options.configPath = requireValue(args, ++index, arg);
        } else if (arg === '--project-root') {
            options.projectRoot = path.resolve(requireValue(args, ++index, arg));
        } else if (arg === '--source') {
            options.sourceDirectory = requireValue(args, ++index, arg);
        } else if (arg === '--output') {
            options.encryptedOutputDirectory = requireValue(args, ++index, arg);
        } else if (arg === '--branch') {
            options.allowedBranch = requireValue(args, ++index, arg);
        } else if (arg === '--remote') {
            options.remote = requireValue(args, ++index, arg);
        } else if (arg === '--no-auto-sync') {
            options.autoSync = false;
        } else if (arg === '--auto-sync') {
            options.autoSync = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--require-directories') {
            options.requireDirectories = true;
        } else if (['--help', '-h'].includes(arg)) {
            options.help = true;
        } else {
            throw new ConfigError(`Unknown option: ${arg}`);
        }
    }

    options.configPath = path.resolve(options.configPath || path.join(options.projectRoot, CONFIG_FILE_NAME));
    return options;
}

async function setupConfig(options) {
    if (existsSync(options.configPath) && !options.force) {
        throw new ConfigError(`${options.configPath} already exists. Use --force to replace it.`);
    }

    const config = validateConfigObject({
        sourceDirectory: options.sourceDirectory || DEFAULT_CONFIG.sourceDirectory,
        encryptedOutputDirectory: options.encryptedOutputDirectory || DEFAULT_CONFIG.encryptedOutputDirectory,
        autoSync: options.autoSync ?? DEFAULT_CONFIG.autoSync,
        allowedBranch: options.allowedBranch || DEFAULT_CONFIG.allowedBranch,
        remote: options.remote || DEFAULT_CONFIG.remote
    });
    const runtime = resolveRuntimeConfig({
        projectRoot: options.projectRoot,
        configPath: options.configPath,
        config
    });

    await mkdir(runtime.sourceDirectory, { recursive: true });
    await mkdir(runtime.encryptedOutputDirectory, { recursive: true });
    await writeFile(options.configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        flag: options.force ? 'w' : 'wx'
    });

    console.log(`Created ${displayFor(runtime.projectRoot, options.configPath)}.`);
    console.log(`Source directory: ${displayFor(runtime.projectRoot, runtime.sourceDirectory)}`);
    console.log(`Encrypted output: ${displayFor(runtime.projectRoot, runtime.encryptedOutputDirectory)}`);
    console.log('No password, passphrase, token, or credential was written to config.');
}

function inspectGit(runtime) {
    const topLevel = runGit(runtime.projectRoot, ['rev-parse', '--show-toplevel']);
    const actualRoot = path.resolve(topLevel);
    if (!samePath(actualRoot, runtime.projectRoot)) {
        throw new ConfigError(`Git top-level ${actualRoot} does not match configured project root ${runtime.projectRoot}.`);
    }

    const branchResult = runGitResult(runtime.projectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branchResult.status !== 0) {
        throw new ConfigError('Git HEAD is detached. Auto sync is disabled until a branch is checked out.');
    }
    const branch = branchResult.stdout.trim();
    const remoteResult = runGitResult(runtime.projectRoot, ['remote', 'get-url', runtime.remote]);
    const upstreamResult = runGitResult(runtime.projectRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);

    return {
        branch,
        branchAllowed: branch === runtime.allowedBranch,
        remoteExists: remoteResult.status === 0,
        upstream: upstreamResult.status === 0 ? upstreamResult.stdout.trim() : null,
        expectedUpstream: `${runtime.remote}/${runtime.allowedBranch}`
    };
}

function printResolved(runtime, asJson) {
    const value = {
        projectRoot: runtime.projectRoot,
        configPath: runtime.configPath,
        sourceDirectory: runtime.sourceDirectory,
        encryptedOutputDirectory: runtime.encryptedOutputDirectory,
        autoSync: runtime.autoSync,
        allowedBranch: runtime.allowedBranch,
        remote: runtime.remote
    };
    if (asJson) {
        process.stdout.write(`${JSON.stringify(value)}\n`);
        return;
    }
    Object.entries(value).forEach(([key, entry]) => console.log(`${key}: ${entry}`));
}

function printCheck(runtime, git) {
    const failures = [];
    if (!git.branchAllowed) {
        failures.push(`current branch ${git.branch} is not allowedBranch ${runtime.allowedBranch}`);
    }
    if (!git.remoteExists) {
        failures.push(`remote ${runtime.remote} does not exist`);
    }
    if (git.upstream !== git.expectedUpstream) {
        failures.push(`upstream must be ${git.expectedUpstream}, found ${git.upstream || 'none'}`);
    }
    if (failures.length > 0) {
        throw new ConfigError('Config paths are valid, but Git sync checks failed.', failures);
    }

    console.log(`Config check passed: ${displayFor(runtime.projectRoot, runtime.configPath)}`);
    console.log(`Source: ${displayFor(runtime.projectRoot, runtime.sourceDirectory)}`);
    console.log(`Output: ${displayFor(runtime.projectRoot, runtime.encryptedOutputDirectory)}`);
    console.log(`Git target: ${git.expectedUpstream}`);
}

function printDryRun(runtime, git) {
    console.log('Print Drive auto-sync dry run (no files, Git index, commits, or remotes were changed)');
    console.log(`Source watch: ${runtime.sourceDirectory}`);
    console.log(`Encrypted output: ${runtime.encryptedOutputDirectory}`);
    console.log(`Auto sync enabled: ${runtime.autoSync}`);
    console.log(`Current branch: ${git.branch}`);
    console.log(`Allowed target: ${git.expectedUpstream}`);
    console.log(`Branch allowed: ${git.branchAllowed}`);
    console.log(`Remote exists: ${git.remoteExists}`);
    console.log(`Upstream: ${git.upstream || 'not configured'}`);
    console.log('Planned Git scope: add/commit only the encrypted output path, then push pending commits.');
}

function runGit(cwd, args) {
    const result = runGitResult(cwd, args);
    if (result.error) {
        throw new ConfigError(`Could not launch git ${args[0]}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new ConfigError(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || 'unknown Git error').trim()}`);
    }
    return result.stdout.trim();
}

function runGitResult(cwd, args) {
    return spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true
    });
}

function requireValue(args, index, option) {
    const value = args[index];
    if (!value || value.startsWith('--')) {
        throw new ConfigError(`${option} requires a value.`);
    }
    return value;
}

function displayFor(root, value) {
    const relative = path.relative(root, value);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value;
}

function samePath(first, second) {
    const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalizeCase(path.resolve(first)) === normalizeCase(path.resolve(second));
}

function printHelp() {
    console.log(`Usage:
  node scripts/config_cli.mjs setup [--source <dir>] [--output <dir>] [--branch <name>] [--remote <name>] [--force]
  node scripts/config_cli.mjs check [--config <file>]
  node scripts/config_cli.mjs dry-run [--config <file>]

The config schema deliberately forbids password, passphrase, token, and credential fields.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
