#!/usr/bin/env node
import {
    createCipheriv,
    createHash,
    pbkdf2Sync,
    randomBytes
} from 'node:crypto';
import {
    access,
    chmod,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

const DEFAULT_SOURCE_DIR = 'private_files';
const DEFAULT_OUTPUT_DIR = 'files';
const DEFAULT_MANIFEST_NAME = 'manifest.enc';
const DEFAULT_PASSWORD_FILE = '.print-drive-passphrase';
const DEFAULT_ITERATIONS = 650000;
const DEFAULT_PADDING_BYTES = 65536;
const MANIFEST_AAD = 'print-drive:manifest:v1';

const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IGNORED_PREFIXES = ['.', '~$'];
const IGNORED_SUFFIXES = ['.tmp', '.temp', '.crdownload', '.download', '.part', '.swp'];

const MIME_TYPES = new Map([
    ['pdf', 'application/pdf'],
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
    ['svg', 'image/svg+xml'],
    ['txt', 'text/plain'],
    ['csv', 'text/csv'],
    ['md', 'text/markdown'],
    ['doc', 'application/msword'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['ppt', 'application/vnd.ms-powerpoint'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['xls', 'application/vnd.ms-excel'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['hwp', 'application/x-hwp'],
    ['hwpx', 'application/x-hwpx'],
    ['zip', 'application/zip']
]);

const FILE_TYPES = {
    pdf: new Set(['pdf']),
    image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic']),
    document: new Set(['doc', 'docx', 'hwp', 'hwpx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'csv', 'md']),
    archive: new Set(['zip', '7z', 'rar', 'tar', 'gz'])
};

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const baseDir = process.cwd();
    const sourceDir = path.resolve(baseDir, options.source);
    const outputDir = path.resolve(baseDir, options.output);
    const manifestPath = path.join(outputDir, options.manifestName);

    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const passphrase = await getPassphrase(options);
    if (passphrase.length < 12) {
        console.warn('Warning: short passphrases are convenient but weak against offline guessing.');
    }

    const sourceFiles = await listSourceFiles(sourceDir);
    await cleanEncryptedOutput(outputDir, options.manifestName);

    const salt = randomBytes(32);
    const key = pbkdf2Sync(passphrase, salt, options.iterations, 32, 'sha256');

    const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        files: []
    };

    for (const sourceFile of sourceFiles) {
        const fileBuffer = await readFile(sourceFile.absolutePath);
        const id = randomBytes(16).toString('hex');
        const iv = randomBytes(12);
        const padded = addPadding(fileBuffer, options.paddingBytes);
        const encrypted = encryptBuffer(key, iv, padded, Buffer.from(createFileAad(id), 'utf8'));
        const outputName = `${id}.bin`;
        const outputPath = path.join(outputDir, outputName);

        await writeFile(outputPath, encrypted);

        const extension = getExtension(sourceFile.name);
        manifest.files.push({
            id,
            name: sourceFile.name,
            size: fileBuffer.byteLength,
            encryptedSize: encrypted.byteLength,
            extension,
            type: getFileType(extension),
            mime: getMimeType(extension),
            path: `files/${outputName}`,
            iv: iv.toString('base64'),
            sha256: createHash('sha256').update(fileBuffer).digest('hex')
        });
    }

    const manifestIv = randomBytes(12);
    const encryptedManifest = encryptBuffer(
        key,
        manifestIv,
        Buffer.from(JSON.stringify(manifest), 'utf8'),
        Buffer.from(MANIFEST_AAD, 'utf8')
    );

    const envelope = {
        version: 1,
        app: 'print-drive',
        crypto: {
            kdf: {
                name: 'PBKDF2',
                hash: 'SHA-256',
                iterations: options.iterations,
                salt: salt.toString('base64')
            },
            cipher: {
                name: 'AES-GCM',
                keyLength: 256,
                ivLength: 12,
                tagLength: 128
            },
            padding: {
                blockSize: options.paddingBytes
            }
        },
        manifest: {
            iv: manifestIv.toString('base64'),
            data: encryptedManifest.toString('base64')
        }
    };

    await writeFile(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    printPlaintextWarnings(outputDir);
    console.log(`Encrypted ${sourceFiles.length} file(s) into ${path.relative(baseDir, outputDir) || '.'}.`);
    console.log(`Wrote ${path.relative(baseDir, manifestPath)}.`);
}

function parseArgs(args) {
    const options = {
        source: DEFAULT_SOURCE_DIR,
        output: DEFAULT_OUTPUT_DIR,
        manifestName: DEFAULT_MANIFEST_NAME,
        passwordFile: DEFAULT_PASSWORD_FILE,
        initPassphrase: false,
        rotatePassphrase: false,
        iterations: DEFAULT_ITERATIONS,
        paddingBytes: DEFAULT_PADDING_BYTES
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--source') {
            options.source = requireValue(args, ++index, arg);
        } else if (arg === '--out') {
            options.output = requireValue(args, ++index, arg);
        } else if (arg === '--manifest') {
            options.manifestName = requireValue(args, ++index, arg);
        } else if (arg === '--password-file') {
            options.passwordFile = requireValue(args, ++index, arg);
        } else if (arg === '--init-passphrase') {
            options.initPassphrase = true;
        } else if (arg === '--rotate-passphrase') {
            options.rotatePassphrase = true;
        } else if (arg === '--iterations') {
            options.iterations = Number(requireValue(args, ++index, arg));
        } else if (arg === '--padding-bytes') {
            options.paddingBytes = Number(requireValue(args, ++index, arg));
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!Number.isInteger(options.iterations) || options.iterations < 200000) {
        throw new Error('--iterations must be an integer >= 200000.');
    }

    if (!Number.isInteger(options.paddingBytes) || options.paddingBytes < 0) {
        throw new Error('--padding-bytes must be an integer >= 0.');
    }

    return options;
}

function requireValue(args, index, optionName) {
    if (!args[index]) {
        throw new Error(`${optionName} requires a value.`);
    }
    return args[index];
}

function printHelp() {
    console.log(`Usage: node encrypt_files.mjs [options]

Options:
  --source <dir>          Source directory for private plaintext files. Default: ${DEFAULT_SOURCE_DIR}
  --out <dir>             Output directory for encrypted files. Default: ${DEFAULT_OUTPUT_DIR}
  --manifest <name>       Encrypted manifest filename. Default: ${DEFAULT_MANIFEST_NAME}
  --password-file <path>  Local ignored passphrase file. Default: ${DEFAULT_PASSWORD_FILE}
  --init-passphrase       Create the password file with a random passphrase if it does not exist.
  --rotate-passphrase     Replace the password file with a new random passphrase.
  --iterations <number>   PBKDF2-SHA256 iteration count. Default: ${DEFAULT_ITERATIONS}
  --padding-bytes <num>   Pad each file to this byte block size. Default: ${DEFAULT_PADDING_BYTES}
`);
}

async function getPassphrase(options) {
    if (process.env.PRINT_DRIVE_PASSPHRASE) {
        return process.env.PRINT_DRIVE_PASSPHRASE;
    }

    const passwordPath = path.resolve(process.cwd(), options.passwordFile);
    if (options.rotatePassphrase) {
        const passphrase = generatePassphrase();
        await writePassphraseFile(passwordPath, passphrase);
        console.log(`Rotated local passphrase file: ${options.passwordFile}`);
        return passphrase;
    }

    if (await exists(passwordPath)) {
        const value = (await readFile(passwordPath, 'utf8')).trim();
        if (!value) {
            throw new Error(`${options.passwordFile} is empty.`);
        }
        return value;
    }

    if (options.initPassphrase) {
        const passphrase = generatePassphrase();
        await writePassphraseFile(passwordPath, passphrase);
        console.log(`Created local passphrase file: ${options.passwordFile}`);
        return passphrase;
    }

    const first = await promptHidden('Encryption passphrase: ');
    const second = await promptHidden('Confirm passphrase: ');
    if (first !== second) {
        throw new Error('Passphrases do not match.');
    }
    return first;
}

function generatePassphrase() {
    return randomBytes(24).toString('base64url');
}

async function writePassphraseFile(passwordPath, passphrase) {
    await writeFile(passwordPath, `${passphrase}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
        await chmod(passwordPath, 0o600);
    } catch {
        // Windows may ignore POSIX file modes.
    }
}

function promptHidden(question) {
    if (!process.stdin.isTTY) {
        throw new Error('No TTY available. Use --password-file or PRINT_DRIVE_PASSPHRASE.');
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

async function listSourceFiles(sourceDir) {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile() || shouldIgnore(entry.name)) {
            continue;
        }

        files.push({
            name: entry.name,
            absolutePath: path.join(sourceDir, entry.name)
        });
    }

    files.sort((a, b) => a.name.localeCompare(b.name, 'ko-KR', { numeric: true, sensitivity: 'base' }));
    return files;
}

function shouldIgnore(name) {
    const lowerName = name.toLowerCase();
    return (
        IGNORED_NAMES.has(name) ||
        IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
        IGNORED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
    );
}

async function cleanEncryptedOutput(outputDir, manifestName) {
    const entries = await readdir(outputDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        if (entry.name === manifestName) {
            continue;
        }

        if (entry.name.endsWith('.bin')) {
            try {
                await rm(path.join(outputDir, entry.name), { force: true });
            } catch (error) {
                console.warn(`Warning: could not remove old encrypted file ${entry.name}: ${error.message}`);
            }
        }
    }
}

function encryptBuffer(key, iv, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function addPadding(buffer, paddingBytes) {
    if (!paddingBytes) {
        return buffer;
    }

    const remainder = buffer.byteLength % paddingBytes;
    if (remainder === 0) {
        return buffer;
    }

    return Buffer.concat([buffer, randomBytes(paddingBytes - remainder)]);
}

function getExtension(name) {
    const lastDot = name.lastIndexOf('.');
    return lastDot > -1 ? name.slice(lastDot + 1).toLowerCase() : '';
}

function getFileType(extension) {
    if (FILE_TYPES.pdf.has(extension)) {
        return 'pdf';
    }
    if (FILE_TYPES.image.has(extension)) {
        return 'image';
    }
    if (FILE_TYPES.document.has(extension)) {
        return 'document';
    }
    if (FILE_TYPES.archive.has(extension)) {
        return 'archive';
    }
    return 'other';
}

function getMimeType(extension) {
    return MIME_TYPES.get(extension) || 'application/octet-stream';
}

function createFileAad(fileId) {
    return `print-drive:file:${fileId}:v1`;
}

async function exists(filePath) {
    try {
        await access(filePath, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function printPlaintextWarnings(outputDir) {
    const entries = await readdir(outputDir, { withFileTypes: true });
    const plaintextNames = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        if (entry.name !== DEFAULT_MANIFEST_NAME && !entry.name.endsWith('.bin')) {
            const entryStat = await stat(path.join(outputDir, entry.name));
            if (entryStat.size > 0) {
                plaintextNames.push(entry.name);
            }
        }
    }

    if (plaintextNames.length > 0) {
        console.warn('Warning: plaintext-looking files remain in the public output directory:');
        plaintextNames.forEach((name) => console.warn(`  - ${name}`));
        console.warn('Move them to private_files/ or remove them before publishing.');
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
