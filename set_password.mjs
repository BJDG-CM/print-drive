#!/usr/bin/env node
import { chmod, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PASSWORD_FILE = '.print-drive-passphrase';

async function main() {
    const password = process.argv[2] ?? await promptHidden('New password: ');
    if (!password) {
        throw new Error('Password is required.');
    }

    if (password.length < 12) {
        console.warn('Warning: short passwords are easy to guess if someone downloads the encrypted files.');
    }

    const passwordPath = path.resolve(process.cwd(), PASSWORD_FILE);
    await writeFile(passwordPath, `${password}\n`, { encoding: 'utf8', mode: 0o600 });

    try {
        await chmod(passwordPath, 0o600);
    } catch {
        // Windows may ignore POSIX file modes.
    }

    console.log(`Updated ${PASSWORD_FILE}.`);
    await runNodeScript('encrypt_files.mjs');
    console.log('Password change complete. Commit and push files/ to publish it.');
}

function runNodeScript(scriptName) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptName], {
            cwd: process.cwd(),
            stdio: 'inherit'
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${scriptName} exited with code ${code}.`));
        });
    });
}

function promptHidden(question) {
    if (!process.stdin.isTTY) {
        throw new Error('No TTY available. Pass the new password as an argument.');
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
