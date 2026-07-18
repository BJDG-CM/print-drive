const zipTextEncoder = new TextEncoder();
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_NAME_BYTES = 1024;

export function createZipBlob(entries) {
    const safeEntries = validateZipEntries(entries);
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
    const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    safeEntries.forEach((entry) => {
        const nameBytes = zipTextEncoder.encode(entry.name);
        const data = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
        if (data.byteLength > 0xffffffff || offset > 0xffffffff) {
            throw new Error('ZIP64가 필요한 큰 파일은 지원하지 않습니다.');
        }

        const crc = crc32(data);
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(localHeader.buffer);
        writeZipHeader(localView, {
            signature: 0x04034b50,
            version: 20,
            flags: 0x0800,
            method: 0,
            dosTime,
            dosDate,
            crc,
            compressedSize: data.byteLength,
            uncompressedSize: data.byteLength,
            nameLength: nameBytes.length,
            extraLength: 0
        });
        localHeader.set(nameBytes, 30);
        localParts.push(localHeader, data);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(centralHeader.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0x0800, true);
        centralView.setUint16(10, 0, true);
        centralView.setUint16(12, dosTime, true);
        centralView.setUint16(14, dosDate, true);
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, data.byteLength, true);
        centralView.setUint32(24, data.byteLength, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint16(30, 0, true);
        centralView.setUint16(32, 0, true);
        centralView.setUint16(34, 0, true);
        centralView.setUint16(36, 0, true);
        centralView.setUint32(38, 0, true);
        centralView.setUint32(42, offset, true);
        centralHeader.set(nameBytes, 46);
        centralParts.push(centralHeader);

        offset += localHeader.byteLength + data.byteLength;
    });

    const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
    const centralOffset = offset;
    const endHeader = new Uint8Array(22);
    const endView = new DataView(endHeader.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, safeEntries.length, true);
    endView.setUint16(10, safeEntries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, endHeader], { type: 'application/zip' });
}

export function validateZipEntries(entries) {
    if (!Array.isArray(entries)) {
        throw new TypeError('ZIP 항목 목록이 올바르지 않습니다.');
    }
    if (entries.length > MAX_ZIP_ENTRIES) {
        throw new Error(`ZIP에는 최대 ${MAX_ZIP_ENTRIES}개 파일만 포함할 수 있습니다.`);
    }

    const seen = new Set();
    let totalBytes = 0;

    return entries.map((entry) => {
        if (!entry || typeof entry.name !== 'string') {
            throw new TypeError('ZIP 파일 이름이 올바르지 않습니다.');
        }

        const name = entry.name.normalize('NFC').replace(/\\/g, '/');
        const nameBytes = zipTextEncoder.encode(name);
        const segments = name.split('/');
        const hasUnsafeSegment = segments.some((segment) => (
            segment === '' || segment === '.' || segment === '..'
        ));

        if (
            !name ||
            name.startsWith('/') ||
            /^[A-Za-z]:/.test(name) ||
            hasUnsafeSegment ||
            /[\u0000-\u001f\u007f]/.test(name) ||
            nameBytes.byteLength > MAX_ZIP_NAME_BYTES
        ) {
            throw new Error(`안전하지 않은 ZIP 파일 이름입니다: ${entry.name}`);
        }

        const duplicateKey = name.toLocaleLowerCase('en-US');
        if (seen.has(duplicateKey)) {
            throw new Error(`중복된 ZIP 파일 이름입니다: ${name}`);
        }
        seen.add(duplicateKey);

        const data = entry.bytes instanceof Uint8Array
            ? entry.bytes
            : new Uint8Array(entry.bytes);
        totalBytes += data.byteLength;
        if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
            throw new Error('ZIP의 전체 평문 크기는 512MB를 넘을 수 없습니다.');
        }

        return { ...entry, name, bytes: data };
    });
}

function writeZipHeader(view, header) {
    view.setUint32(0, header.signature, true);
    view.setUint16(4, header.version, true);
    view.setUint16(6, header.flags, true);
    view.setUint16(8, header.method, true);
    view.setUint16(10, header.dosTime, true);
    view.setUint16(12, header.dosDate, true);
    view.setUint32(14, header.crc, true);
    view.setUint32(18, header.compressedSize, true);
    view.setUint32(22, header.uncompressedSize, true);
    view.setUint16(26, header.nameLength, true);
    view.setUint16(28, header.extraLength, true);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
        crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
