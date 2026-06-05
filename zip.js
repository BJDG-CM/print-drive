const zipTextEncoder = new TextEncoder();

export function createZipBlob(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
    const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    entries.forEach((entry) => {
        const nameBytes = zipTextEncoder.encode(entry.name.replace(/\\/g, '/'));
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
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, endHeader], { type: 'application/zip' });
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
