import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_IMAGE_ACCENT_PIXELS, selectImageAccent } from '../qianmu-image-accent.js';
import { createThemePalette } from '../qianmu-theme-palette.js';

function pixels(...groups) {
    return groups.flatMap(([count, color]) => Array.from({ length: count }, () => color).flat());
}

function hueOf(hex) {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    const high = Math.max(r, g, b), span = high - Math.min(r, g, b);
    const raw = high === r ? (g - b) / span : high === g ? (b - r) / span + 2 : (r - g) / span + 4;
    return (raw * 60 + 360) % 360;
}

test('empty and colourless samples use a validated, normalized fallback', () => {
    assert.deepEqual(selectImageAccent({ pixels: [], fallback: '#AbC' }), {
        accent: '#aabbcc', source: 'fallback', mode: 'dominant', dominant: null,
        sampledPixels: 0, eligiblePixels: 0, reason: 'empty',
    });
    for (const color of [[127, 127, 127, 255], [255, 255, 255, 255], [0, 0, 0, 255], [255, 0, 0, 0], [20, 0, 0, 255], [255, 230, 230, 255]]) {
        const result = selectImageAccent({ pixels: color });
        assert.equal(result.source, 'fallback');
        assert.equal(result.accent, '#8b584a');
        assert.equal(result.reason, 'no-usable-color');
    }
});

test('unsigned byte arrays and integer arrays select the same source colour', () => {
    const input = pixels([12, [70, 130, 155, 255]], [3, [180, 65, 60, 255]]);
    const expected = selectImageAccent({ pixels: input });
    assert.equal(expected.dominant, '#46829b');
    assert.equal(expected.source, 'image');
    assert.equal(expected.eligiblePixels, 15);
    assert.deepEqual(selectImageAccent({ pixels: new Uint8Array(input) }), expected);
    assert.deepEqual(selectImageAccent({ pixels: new Uint8ClampedArray(input) }), expected);
});

test('large muted areas outrank small saturated details', () => {
    const result = selectImageAccent({ pixels: pixels([90, [75, 110, 120, 255]], [10, [255, 0, 0, 255]]) });
    assert.equal(result.dominant, '#4b6e78');
});

test('white borders, shadow fields and transparent colour do not dominate the subject', () => {
    const result = selectImageAccent({ pixels: pixels([100, [255, 255, 255, 255]], [100, [0, 0, 0, 255]], [100, [0, 255, 0, 0]], [12, [160, 80, 55, 255]]) });
    assert.equal(result.sampledPixels, 312);
    assert.equal(result.eligiblePixels, 12);
    assert.equal(result.dominant, '#a05037');
});

test('partially transparent pixels are weighted by alpha', () => {
    const result = selectImageAccent({ pixels: pixels([12, [255, 0, 0, 32]], [10, [0, 0, 255, 255]]) });
    assert.equal(result.dominant, '#0000ff');
});

test('red hue wrap and exact ties are invariant to sample ordering', () => {
    const colors = [[200, 20, 28, 255], [200, 28, 20, 255], [20, 200, 20, 255]];
    const input = pixels([8, colors[0]], [8, colors[1]], [10, colors[2]]);
    const expected = selectImageAccent({ pixels: input });
    assert.equal(expected.dominant, '#c81818');
    const reversed = Array.from({ length: input.length / 4 }, (_, index) => input.slice(index * 4, index * 4 + 4)).reverse().flat();
    assert.deepEqual(selectImageAccent({ pixels: reversed }), expected);
    const tied = pixels([20, [200, 20, 20, 255]], [20, [20, 200, 20, 255]]);
    assert.equal(selectImageAccent({ pixels: tied }).dominant, '#c81414');
    assert.deepEqual(selectImageAccent({ pixels: [...tied.slice(80), ...tied.slice(0, 80)] }), selectImageAccent({ pixels: tied }));
});

test('complementary selection preserves source identity and rotates a softened accent', () => {
    const input = [220, 70, 40, 255];
    const base = selectImageAccent({ pixels: input });
    const complement = selectImageAccent({ pixels: input, mode: 'complementary' });
    assert.equal(base.dominant, complement.dominant);
    assert.ok(Math.abs(((hueOf(complement.accent) - hueOf(base.accent) + 360) % 360) - 180) < 1.5);
    assert.match(complement.accent, /^#[0-9a-f]{6}$/);
    assert.notEqual(complement.accent, '#00ffff');
});

test('options, modes, fallback and unbounded or malformed input fail explicitly', () => {
    for (const value of [null, undefined, [], '', 2]) assert.throws(() => selectImageAccent(value), TypeError);
    for (const mode of ['', 'auto', null, true]) assert.throws(() => selectImageAccent({ pixels: [], mode }), TypeError);
    for (const fallback of ['', 'red', '#1234', '#12345678', ' #123456', '#123456\n', null, 123]) {
        assert.throws(() => selectImageAccent({ pixels: [], fallback }), TypeError);
    }
    for (const input of [null, 'abcd', new Float32Array(4), new Int8Array(4), new Uint16Array(4), { length: 4 }, new DataView(new ArrayBuffer(4))]) {
        assert.throws(() => selectImageAccent({ pixels: input }), TypeError);
    }
    for (const channel of [undefined, NaN, Infinity, -1, 256, 0.5, '1']) {
        assert.throws(() => selectImageAccent({ pixels: [channel, 0, 0, 0] }), TypeError);
    }
    assert.throws(() => selectImageAccent({ pixels: Array(4) }), TypeError);
    for (const input of [[1], [1, 2, 3], new Uint8Array(MAX_IMAGE_ACCENT_PIXELS * 4 + 4)]) {
        assert.throws(() => selectImageAccent({ pixels: input }), RangeError);
    }
});

test('the accepted size limit is processed, output is frozen and input remains untouched', () => {
    const input = new Uint8ClampedArray(pixels([MAX_IMAGE_ACCENT_PIXELS, [80, 110, 165, 255]]));
    const copy = input.slice();
    const result = selectImageAccent({ pixels: input });
    assert.equal(result.sampledPixels, MAX_IMAGE_ACCENT_PIXELS);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(input, copy);
    assert.equal(result.dominant, '#506ea5');
});

test('image accent changes do not alter downstream semantic danger colours', () => {
    for (const theme of ['glass', 'editorial']) for (const mode of ['light', 'dark']) {
        const defaults = createThemePalette({ theme, mode });
        for (const input of [[240, 20, 25, 255], [0, 190, 60, 255], [30, 70, 190, 255]]) {
            const { accent } = selectImageAccent({ pixels: input });
            const palette = createThemePalette({ theme, mode, accent });
            assert.equal(palette.css['--qm-danger'], defaults.css['--qm-danger']);
            assert.equal(palette.css['--qm-on-danger'], defaults.css['--qm-on-danger']);
            assert.ok(palette.contrast.text >= 4.5);
            assert.ok(palette.contrast.action >= 4.5);
        }
    }
});

test('a bounded representative RGB sweep yields finite hex colours in both selection modes', () => {
    for (const r of [0, 32, 64, 128, 192, 224, 255]) for (const g of [0, 32, 64, 128, 192, 224, 255]) for (const b of [0, 32, 64, 128, 192, 224, 255]) {
        for (const mode of ['dominant', 'complementary']) {
            const result = selectImageAccent({ pixels: [r, g, b, 255], mode });
            assert.match(result.accent, /^#[0-9a-f]{6}$/);
            if (result.dominant) assert.match(result.dominant, /^#[0-9a-f]{6}$/);
        }
    }
});

test('selection module has no browser, storage, randomness, networking or palette mutation hooks', async () => {
    const source = await readFile(new URL('../qianmu-image-accent.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:document|window|localStorage|indexedDB|fetch|XMLHttpRequest)\b|Math\.random|Date\.now|--qm-danger|import\s/);
});
