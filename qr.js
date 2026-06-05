const QR_VERSION = 10;
const QR_SIZE = QR_VERSION * 4 + 17;
const QR_DATA_CODEWORDS = 274;
const QR_ECC_CODEWORDS = 18;
const QR_BLOCK_SIZES = [68, 68, 69, 69];
const QR_MASK = 0;

export function drawQrCode(canvas, text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > 271) {
        throw new Error('QR로 표시하기에는 링크가 너무 깁니다.');
    }

    const modules = createQrModules(bytes);
    const quiet = 4;
    const scale = Math.max(3, Math.floor(280 / (QR_SIZE + quiet * 2)));
    const pixelSize = (QR_SIZE + quiet * 2) * scale;
    canvas.width = pixelSize;
    canvas.height = pixelSize;

    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, pixelSize, pixelSize);
    context.fillStyle = '#111827';

    for (let y = 0; y < QR_SIZE; y += 1) {
        for (let x = 0; x < QR_SIZE; x += 1) {
            if (modules[y][x]) {
                context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
            }
        }
    }
}

function createQrModules(bytes) {
    const { modules, reserved } = createBaseMatrix();
    const codewords = createCodewords(bytes);
    placeDataBits(modules, reserved, codewords);
    drawFormatBits(modules, QR_MASK);
    return modules;
}

function createBaseMatrix() {
    const modules = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
    const reserved = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));

    drawFinder(modules, reserved, 3, 3);
    drawFinder(modules, reserved, QR_SIZE - 4, 3);
    drawFinder(modules, reserved, 3, QR_SIZE - 4);
    drawAlignments(modules, reserved);
    drawTiming(modules, reserved);
    drawDarkModule(modules, reserved);
    reserveFormatAreas(reserved);
    drawVersionBits(modules, reserved);
    return { modules, reserved };
}

function setModule(modules, reserved, x, y, value) {
    if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) {
        return;
    }
    modules[y][x] = value;
    reserved[y][x] = true;
}

function drawFinder(modules, reserved, centerX, centerY) {
    for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
            const x = centerX + dx;
            const y = centerY + dy;
            if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) {
                continue;
            }

            const distance = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(modules, reserved, x, y, distance !== 4 && distance !== 2);
        }
    }
}

function drawAlignments(modules, reserved) {
    const positions = [6, 28, 50];
    positions.forEach((x) => {
        positions.forEach((y) => {
            if (reserved[y][x]) {
                return;
            }

            for (let dy = -2; dy <= 2; dy += 1) {
                for (let dx = -2; dx <= 2; dx += 1) {
                    const distance = Math.max(Math.abs(dx), Math.abs(dy));
                    setModule(modules, reserved, x + dx, y + dy, distance !== 1);
                }
            }
        });
    });
}

function drawTiming(modules, reserved) {
    for (let i = 8; i < QR_SIZE - 8; i += 1) {
        const value = i % 2 === 0;
        setModule(modules, reserved, i, 6, value);
        setModule(modules, reserved, 6, i, value);
    }
}

function drawDarkModule(modules, reserved) {
    setModule(modules, reserved, 8, QR_VERSION * 4 + 9, true);
}

function reserveFormatAreas(reserved) {
    for (let i = 0; i < 9; i += 1) {
        if (i !== 6) {
            reserved[8][i] = true;
            reserved[i][8] = true;
        }
    }

    for (let i = 0; i < 8; i += 1) {
        reserved[QR_SIZE - 1 - i][8] = true;
        reserved[8][QR_SIZE - 1 - i] = true;
    }
}

function drawVersionBits(modules, reserved) {
    const bits = getVersionBits(QR_VERSION);
    for (let i = 0; i < 18; i += 1) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = QR_SIZE - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setModule(modules, reserved, a, b, bit);
        setModule(modules, reserved, b, a, bit);
    }
}

function getVersionBits(version) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) {
        remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
    }
    return (version << 12) | remainder;
}

function createCodewords(bytes) {
    const bits = [];
    appendBits(bits, 0b0100, 4);
    appendBits(bits, bytes.length, 16);
    bytes.forEach((byte) => appendBits(bits, byte, 8));
    appendBits(bits, 0, Math.min(4, QR_DATA_CODEWORDS * 8 - bits.length));
    while (bits.length % 8 !== 0) {
        bits.push(0);
    }

    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        dataCodewords.push(parseBits(bits.slice(i, i + 8)));
    }

    for (let pad = 0xec; dataCodewords.length < QR_DATA_CODEWORDS; pad ^= 0xfd) {
        dataCodewords.push(pad);
    }

    const blocks = [];
    let offset = 0;
    QR_BLOCK_SIZES.forEach((size) => {
        const data = dataCodewords.slice(offset, offset + size);
        offset += size;
        blocks.push({
            data,
            ecc: reedSolomonRemainder(data, QR_ECC_CODEWORDS)
        });
    });

    const result = [];
    for (let i = 0; i < 69; i += 1) {
        blocks.forEach((block) => {
            if (i < block.data.length) {
                result.push(block.data[i]);
            }
        });
    }
    for (let i = 0; i < QR_ECC_CODEWORDS; i += 1) {
        blocks.forEach((block) => result.push(block.ecc[i]));
    }

    return result;
}

function appendBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
        bits.push((value >>> i) & 1);
    }
}

function parseBits(bits) {
    return bits.reduce((value, bit) => (value << 1) | bit, 0);
}

function reedSolomonRemainder(data, degree) {
    const generator = reedSolomonGenerator(degree);
    const result = Array(degree).fill(0);

    data.forEach((byte) => {
        const factor = byte ^ result.shift();
        result.push(0);
        generator.forEach((coefficient, index) => {
            result[index] ^= gfMultiply(coefficient, factor);
        });
    });

    return result;
}

function reedSolomonGenerator(degree) {
    let result = [1];
    for (let i = 0; i < degree; i += 1) {
        const next = Array(result.length + 1).fill(0);
        result.forEach((coefficient, index) => {
            next[index] ^= gfMultiply(coefficient, 1);
            next[index + 1] ^= gfMultiply(coefficient, gfPow(2, i));
        });
        result = next;
    }
    return result.slice(1);
}

function gfPow(value, power) {
    let result = 1;
    for (let i = 0; i < power; i += 1) {
        result = gfMultiply(result, value);
    }
    return result;
}

function gfMultiply(left, right) {
    let result = 0;
    for (let i = 0; i < 8; i += 1) {
        if ((right & 1) !== 0) {
            result ^= left;
        }
        const carry = (left & 0x80) !== 0;
        left = (left << 1) & 0xff;
        if (carry) {
            left ^= 0x1d;
        }
        right >>>= 1;
    }
    return result;
}

function placeDataBits(modules, reserved, codewords) {
    const bits = [];
    codewords.forEach((codeword) => appendBits(bits, codeword, 8));

    let bitIndex = 0;
    let upward = true;
    for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
        if (right === 6) {
            right -= 1;
        }

        for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
            const y = upward ? QR_SIZE - 1 - vertical : vertical;
            for (let column = 0; column < 2; column += 1) {
                const x = right - column;
                if (reserved[y][x]) {
                    continue;
                }

                const bit = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
                bitIndex += 1;
                modules[y][x] = bit !== maskApplies(QR_MASK, x, y);
            }
        }

        upward = !upward;
    }
}

function maskApplies(mask, x, y) {
    if (mask === 0) {
        return (x + y) % 2 === 0;
    }
    return false;
}

function drawFormatBits(modules, mask) {
    const bits = getFormatBits(mask);
    for (let i = 0; i <= 5; i += 1) {
        modules[i][8] = getBit(bits, i);
    }
    modules[7][8] = getBit(bits, 6);
    modules[8][8] = getBit(bits, 7);
    modules[8][7] = getBit(bits, 8);
    for (let i = 9; i < 15; i += 1) {
        modules[14 - i][8] = getBit(bits, i);
    }

    for (let i = 0; i < 8; i += 1) {
        modules[QR_SIZE - 1 - i][8] = getBit(bits, i);
    }
    for (let i = 8; i < 15; i += 1) {
        modules[8][QR_SIZE - 15 + i] = getBit(bits, i);
    }
}

function getFormatBits(mask) {
    const data = (1 << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) {
        remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
    }
    return ((data << 10) | remainder) ^ 0x5412;
}

function getBit(value, index) {
    return ((value >>> index) & 1) === 1;
}
