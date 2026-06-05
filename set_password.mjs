#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, displayPath, getConfiguredPaths } from './paths.mjs';

const ENCRYPT_SCRIPT = fileURLToPath(new URL('./encrypt_files.mjs', import.meta.url));

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const { passwordFile } = getConfiguredPaths(options);
    const password = options.password ?? await promptHidden('New password: ');

    validatePassword(password, options);

    await mkdir(path.dirname(passwordFile), { recursive: true });
    await writeFile(passwordFile, `${password}\n`, { encoding: 'utf8', mode: 0o600 });

    try {
        await chmod(passwordFile, 0o600);
    } catch {
        // Windows may ignore POSIX file modes.
    }

    console.log(`Updated ${displayPath(passwordFile)}.`);
    await runNodeScript(passwordFile);
    console.log('Password change complete. Commit and push files/ to publish it.');
}

function parseArgs(args) {
    const options = {
        allowWeakPassword: false,
        allowCliPassword: false,
        passwordFile: null,
        password: null
    };
    const positional = [];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--allow-weak-password') {
            options.allowWeakPassword = true;
        } else if (arg === '--allow-cli-password') {
            options.allowCliPassword = true;
        } else if (arg === '--password-file') {
            options.passwordFile = requireValue(args, ++index, arg);
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            positional.push(arg);
        }
    }

    if (positional.length > 0 && !options.allowCliPassword) {
        throw new Error('CLI password input is disabled by default because it can remain in shell history. Use --allow-cli-password only when that risk is acceptable.');
    }

    if (positional.length > 1) {
        throw new Error('Only one password argument is allowed.');
    }

    if (positional.length === 1) {
        options.password = positional[0];
    }

    return options;
}

function requireValue(args, index, optionName) {
    if (!args[index]) {
        throw new Error(`${optionName} requires a value.`);
    }
    return args[index];
}

function validatePassword(password, options) {
    if (!password) {
        throw new Error('Password is required.');
    }

    const numericOnly = /^\d+$/.test(password);
    if (numericOnly && password.length < 8) {
        throw new Error('Numeric-only passwords must be at least 8 digits, even with --allow-weak-password.');
    }

    const weakReasons = [];
    if (password.length < 12) {
        weakReasons.push('passwords shorter than 12 characters are not allowed by default');
    }
    if (numericOnly) {
        weakReasons.push('numeric-only passwords are considered weak');
    }

    if (weakReasons.length > 0 && !options.allowWeakPassword) {
        throw new Error(`Weak password rejected: ${weakReasons.join('; ')}. Re-run with --allow-weak-password only if this is intentional.`);
    }

    if (weakReasons.length > 0) {
        console.warn(`Warning: weak password accepted because --allow-weak-password was provided (${weakReasons.join('; ')}).`);
    }
}

function printHelp() {
    console.log(`Usage: node set_password.mjs [options]

Options:
  --password-file <path>      Local ignored passphrase file. Defaults to PRINT_DRIVE_PASSWORD_FILE or .print-drive-passphrase.
  --allow-cli-password        Allow one positional password argument. Hidden prompt is safer.
  --allow-weak-password       Allow a weak password after explicit acknowledgement.

Environment:
  PRINT_DRIVE_ROOT            Project root override.
  PRINT_DRIVE_SOURCE_DIR      Source directory override.
  PRINT_DRIVE_OUTPUT_DIR      Public encrypted output directory override.
  PRINT_DRIVE_PASSWORD_FILE   Local passphrase file override.
`);
}

function runNodeScript(passwordFile) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENCRYPT_SCRIPT], {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                PRINT_DRIVE_PASSWORD_FILE: passwordFile
            },
            stdio: 'inherit'
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${path.basename(ENCRYPT_SCRIPT)} exited with code ${code}.`));
        });
    });
}

function promptHidden(question) {
    if (!process.stdin.isTTY) {
        throw new Error('No TTY available. Use --allow-cli-password with a positional password only if shell history exposure is acceptable.');
    }

    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        let input = '';

        stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        const onData = (char) => {
            if (char === '\u0003') {
                stdout.write('\n');
                process.exit(1);
            }

            if (char === '\r' || char === '\n') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.off('data', onData);
                stdout.write('\n');
                resolve(input);
                return;
            }

            if (char === '\u0008' || char === '\u007f') {
                input = input.slice(0, -1);
                return;
            }

            input += char;
        };

        stdin.on('data', onData);
    });
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
