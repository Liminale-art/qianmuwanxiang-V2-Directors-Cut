import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createThemePalette } from '../qianmu-theme-palette.js';

const CSS_KEYS = [
    '--qm-bg', '--qm-surface', '--qm-raised', '--qm-ink', '--qm-muted', '--qm-line',
    '--qm-accent', '--qm-on-accent', '--qm-accent-soft', '--qm-glow-1', '--qm-glow-2',
    '--qm-danger', '--qm-on-danger',
];
const COMBINATIONS = ['editorial', 'glass'].flatMap((theme) => ['light', 'dark'].map((mode) => ({ theme, mode })));
const REPRESENTATIVE_COLORS = [
    '#ff0000', '#ffff00', '#0000ff', '#8000ff', '#000000', '#ffffff', '#777777',
    '#00ff00', '#00ffff', '#ff00ff', '#8b584a', '#005f73', '#dec39e', '#18181b',
];

// Independent sRGB calculation based only on the returned, quantized hex.
function relativeLuminance(hex) {
    const integer = Number.parseInt(hex.slice(1), 16);
    const channels = [(integer >>> 16) & 255, (integer >>> 8) & 255, integer & 255];
    const linear = channels.map((value) => {
        const fraction = value / 255;
        return fraction <= 0.04045 ? fraction / 12.92 : Math.pow((fraction + 0.055) / 1.055, 2.4);
    });
    return linear.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function ratio(a, b) {
    const [low, high] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => x - y);
    return (high + 0.05) / (low + 0.05);
}

function assertPalette(palette) {
    const { css, contrast } = palette;
    assert.deepEqual(Object.keys(css), CSS_KEYS);
    assert.deepEqual(Object.keys(contrast), ['text', 'muted', 'action']);
    for (const value of [palette.accent, ...Object.values(css)]) assert.match(value, /^#[0-9a-f]{6}$/);
    const backgrounds = ['--qm-bg', '--qm-surface', '--qm-raised'].map((key) => css[key]);
    for (const [name, token] of [['text', '--qm-ink'], ['muted', '--qm-muted']]) {
        const actual = backgrounds.map((background) => ratio(css[token], background));
        for (const value of actual) assert.ok(value >= 4.5, `${palette.theme}/${palette.mode}/${palette.accent}: ${name} contrast ${value}`);
        assert.ok(Math.abs(contrast[name] - Math.min(...actual)) < 1e-12, `${name} reports actual worst contrast`);
    }
    const action = ratio(css['--qm-on-accent'], css['--qm-accent']);
    assert.ok(action >= 4.5, `action contrast ${action}`);
    assert.ok(Math.abs(contrast.action - action) < 1e-12);
    assert.ok(ratio(css['--qm-on-danger'], css['--qm-danger']) >= 4.5);
    for (const value of Object.values(contrast)) assert.ok(Number.isFinite(value) && value >= 4.5 && value <= 21);
}

test('default palette and partial options follow the stable API', () => {
    const defaultPalette = createThemePalette();
    assert.deepEqual(Object.keys(defaultPalette), ['theme', 'mode', 'accent', 'css', 'contrast']);
    assert.deepEqual(defaultPalette, createThemePalette({ theme: 'editorial', mode: 'light', accent: '#8b584a' }));
    assert.deepEqual(defaultPalette, createThemePalette({}));
    assert.deepEqual(defaultPalette, createThemePalette({ theme: undefined, mode: undefined, accent: undefined }));
    assert.equal(createThemePalette({ mode: 'dark' }).theme, 'editorial');
    assertPalette(defaultPalette);
});

test('strict hex input accepts shorthand/case but never CSS fragments or whitespace', () => {
    assert.deepEqual(createThemePalette({ accent: '#AbC' }), createThemePalette({ accent: '#aabbcc' }));
    assert.equal(createThemePalette({ accent: '#A1B2C3' }).accent, '#a1b2c3');
    const invalid = [
        null, false, 123, {}, [], new String('#fff'), '', 'red', 'fff', '#12', '#1234', '#12345',
        '#1234567', '#12345678', '#ggg', ' #fff', '#fff ', '#fff\n', '#ffffff\n', '#fff\r',
        '#fff\0', '#fff; color: red', 'rgb(0,0,0)', 'var(--accent)', '#１２３', '#fffffg',
    ];
    for (const accent of invalid) assert.throws(() => createThemePalette({ accent }), TypeError);
});

test('theme and mode enums reject legacy themes, coercion, and prototype keys', () => {
    for (const theme of ['classic', 'editorial ', 'Glass', '', '__proto__', 'constructor', null, 0, {}, ['glass']]) {
        assert.throws(() => createThemePalette({ theme }), TypeError);
    }
    for (const mode of ['auto', 'system', 'LIGHT', 'dark ', '', '__proto__', null, false, {}, ['dark']]) {
        assert.throws(() => createThemePalette({ mode }), TypeError);
    }
    assert.throws(() => createThemePalette(null), TypeError);
});

for (const options of COMBINATIONS) {
    test(`${options.theme}/${options.mode}: representative saturated and neutral colors pass final-hex contrast`, () => {
        for (const accent of REPRESENTATIVE_COLORS) assertPalette(createThemePalette({ ...options, accent }));
    });
}

test('a deterministic 729-color RGB grid passes all four theme/mode combinations', () => {
    const levels = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    for (const red of levels) for (const green of levels) for (const blue of levels) {
        const accent = `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
        for (const options of COMBINATIONS) assertPalette(createThemePalette({ ...options, accent }));
    }
});

test('palettes are deterministic, deeply frozen, input-preserving, and independent between calls', () => {
    const options = Object.freeze({ theme: 'glass', mode: 'dark', accent: '#AbC' });
    const first = createThemePalette(options);
    const second = createThemePalette(options);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.css, second.css);
    assert.notEqual(first.contrast, second.contrast);
    assert.deepEqual(options, { theme: 'glass', mode: 'dark', accent: '#AbC' });
    for (const object of [first, first.css, first.contrast]) assert.ok(Object.isFrozen(object));
    assert.throws(() => { first.mode = 'light'; }, TypeError);
    assert.throws(() => { first.css['--qm-bg'] = '#000000'; }, TypeError);
    assert.throws(() => { first.contrast.text = 0; }, TypeError);
    assert.throws(() => { delete first.css['--qm-muted']; }, TypeError);
    assert.deepEqual(first, createThemePalette(options));
});

test('the selected accent does not recolor base surfaces, typography, borders, or semantic danger', () => {
    const fixedTokens = ['--qm-bg', '--qm-surface', '--qm-raised', '--qm-ink', '--qm-muted', '--qm-line', '--qm-danger', '--qm-on-danger'];
    for (const options of COMBINATIONS) {
        const red = createThemePalette({ ...options, accent: '#ff0000' });
        const blue = createThemePalette({ ...options, accent: '#0000ff' });
        for (const token of fixedTokens) assert.equal(red.css[token], blue.css[token], token);
        for (const token of ['--qm-accent', '--qm-accent-soft', '--qm-glow-1', '--qm-glow-2']) {
            assert.notEqual(red.css[token], blue.css[token], token);
        }
    }
});

test('glass light uses a white canvas, neutral near-white surfaces, and the existing two glow roles', () => {
    for (const accent of REPRESENTATIVE_COLORS) {
        const palette = createThemePalette({ theme: 'glass', mode: 'light', accent });
        assert.equal(palette.css['--qm-bg'], '#ffffff');
        assert.equal(palette.css['--qm-surface'], '#f8f8f8');
        assert.equal(palette.css['--qm-raised'], '#fdfdfd');
        assert.ok(relativeLuminance(palette.css['--qm-surface']) < relativeLuminance(palette.css['--qm-raised']));
        assert.ok(relativeLuminance(palette.css['--qm-raised']) < relativeLuminance(palette.css['--qm-bg']));
        assertPalette(palette);
    }
    const { css } = createThemePalette({ theme: 'glass', mode: 'light', accent: '#005f73' });
    assert.equal(css['--qm-glow-1'], '#a8dbea');
    assert.equal(css['--qm-glow-2'], '#d5ddfa');
});

test('editorial palettes and glass night preserve their existing color tokens', () => {
    const preserved = [
        {
            theme: 'editorial', mode: 'light',
            css: {
                '--qm-bg': '#f5f1e8', '--qm-surface': '#fbf8f1', '--qm-raised': '#fefdfa',
                '--qm-ink': '#24201c', '--qm-muted': '#615b55', '--qm-line': '#cdc8be',
                '--qm-accent': '#005f73', '--qm-on-accent': '#ffffff', '--qm-accent-soft': '#d1eaf1',
                '--qm-glow-1': '#bdd6de', '--qm-glow-2': '#daddea',
                '--qm-danger': '#c13234', '--qm-on-danger': '#ffffff',
            },
        },
        {
            theme: 'editorial', mode: 'dark',
            css: {
                '--qm-bg': '#1a1612', '--qm-surface': '#231e1a', '--qm-raised': '#2e2924',
                '--qm-ink': '#e9e6df', '--qm-muted': '#ada9a0', '--qm-line': '#464039',
                '--qm-accent': '#56a1b7', '--qm-on-accent': '#000000', '--qm-accent-soft': '#24393f',
                '--qm-glow-1': '#41575d', '--qm-glow-2': '#3d3f49',
                '--qm-danger': '#ff7871', '--qm-on-danger': '#000000',
            },
        },
        {
            theme: 'glass', mode: 'dark',
            css: {
                '--qm-bg': '#070f19', '--qm-surface': '#131b26', '--qm-raised': '#1f2834',
                '--qm-ink': '#e8ebf1', '--qm-muted': '#a5adb8', '--qm-line': '#384352',
                '--qm-accent': '#56a1b7', '--qm-on-accent': '#000000', '--qm-accent-soft': '#24393f',
                '--qm-glow-1': '#2a5a68', '--qm-glow-2': '#393e55',
                '--qm-danger': '#ff7871', '--qm-on-danger': '#000000',
            },
        },
    ];
    for (const { theme, mode, css } of preserved) {
        assert.deepEqual(createThemePalette({ theme, mode, accent: '#005f73' }).css, css);
    }
});

test('the themes have distinct bases, low-chroma editorial paper, and ordered surface elevation where the canvas is not white', () => {
    for (const mode of ['light', 'dark']) {
        const editorial = createThemePalette({ theme: 'editorial', mode }).css;
        const glass = createThemePalette({ theme: 'glass', mode }).css;
        for (const token of ['--qm-bg', '--qm-surface', '--qm-raised']) assert.notEqual(editorial[token], glass[token]);
        for (const css of mode === 'light' ? [editorial] : [editorial, glass]) {
            assert.ok(relativeLuminance(css['--qm-bg']) < relativeLuminance(css['--qm-surface']));
            assert.ok(relativeLuminance(css['--qm-surface']) < relativeLuminance(css['--qm-raised']));
        }
    }
    const paper = createThemePalette().css['--qm-bg'];
    const channels = paper.slice(1).match(/../g).map((part) => Number.parseInt(part, 16));
    assert.ok(Math.max(...channels) - Math.min(...channels) < 16, 'paper remains restrained, not accent-tinted');
    assert.ok(channels[0] > channels[2], 'editorial paper retains a gentle warm bias');
});

test('neutral seeds produce neutral accent-derived roles instead of a spurious hue', () => {
    for (const options of COMBINATIONS) for (const accent of ['#000', '#fff', '#777']) {
        const { css } = createThemePalette({ ...options, accent });
        for (const token of ['--qm-accent', '--qm-accent-soft', '--qm-glow-1', '--qm-glow-2']) {
            const channels = css[token].slice(1).match(/../g);
            assert.equal(new Set(channels).size, 1, `${token} should be neutral for ${accent}`);
        }
    }
});

test('the palette module has no imports, browser/host access, I/O, randomness, or time dependence', async () => {
    const source = await readFile(new URL('../qianmu-theme-palette.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\b/m);
    assert.doesNotMatch(source, /\b(?:document|window|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|process|require)\s*[.(\[]/);
    assert.doesNotMatch(source, /Math\.random|Date\s*[.(]|setTimeout|setInterval/);
});
