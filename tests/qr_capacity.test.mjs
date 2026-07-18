import assert from 'node:assert/strict';
import test from 'node:test';

import { drawQrCode } from '../qr.js';

function createCanvas() {
    const context = {
        fillStyle: '',
        fillRect() {}
    };
    return {
        width: 0,
        height: 0,
        style: {},
        getContext() { return context; }
    };
}

test('QR v30-L encoder accepts a typical encrypted capability URL', () => {
    const canvas = createCanvas();
    const url = `https://example.test/print-drive/#share=v1.${'A'.repeat(900)}`;
    assert.doesNotThrow(() => drawQrCode(canvas, url));
    assert.equal(canvas.width, 290);
    assert.equal(canvas.height, 290);
});

test('QR encoder rejects values beyond its byte capacity with a copy-link fallback error', () => {
    assert.throws(
        () => drawQrCode(createCanvas(), 'A'.repeat(1733)),
        /링크가 너무 깁니다/
    );
});
