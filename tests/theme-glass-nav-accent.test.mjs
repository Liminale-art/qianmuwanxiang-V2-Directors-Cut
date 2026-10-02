import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createThemePalette } from '../qianmu-theme-palette.js';

const skins = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const selector = '#story-director-modal[data-qm-theme="glass"] .sd-storyboard-nav button.active';
const activeRule = skins.slice(skins.indexOf(`${selector} {`)).split('}')[0];

function propertyToken(property) {
    const match = activeRule.match(new RegExp(`\\n\\s*${property}: var\\((--[\\w-]+)\\);`));
    assert.ok(match, `${property} uses the live opaque palette token`);
    return match[1];
}

function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels.reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
}

test('only the glass storyboard selection uses the live accent and its matched foreground', () => {
    assert.ok(activeRule.startsWith(`${selector} {`));
    assert.equal(propertyToken('background'), '--qm-accent');
    assert.equal(propertyToken('color'), '--qm-on-accent');
    assert.match(activeRule, /width: var\(--qm-nav-open\);/);
    assert.doesNotMatch(activeRule, /#[\da-f]{3,8}\b|color-mix|opacity:|background-image:/i);
    assert.match(skins, /\[data-qm-theme="editorial"\] \.sd-storyboard-nav button\.active \{ color: var\(--qm-action-ink\); \}/);
});

test('selected navigation text and inherited icons remain readable across both glass modes and a 729-color grid', () => {
    const background = propertyToken('background'), foreground = propertyToken('color');
    const levels = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    for (const mode of ['light', 'dark']) for (const r of levels) for (const g of levels) for (const b of levels) {
        const accent = `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
        const { css } = createThemePalette({ theme: 'glass', mode, accent });
        const [low, high] = [luminance(css[background]), luminance(css[foreground])].sort((a, b) => a - b);
        assert.ok((high + 0.05) / (low + 0.05) >= 4.5, `${mode}/${accent}: selected navigation contrast`);
    }
});

test('the selected fill changes with accent and day/night rather than remaining neutral ink', () => {
    const background = propertyToken('background');
    for (const mode of ['light', 'dark']) {
        const red = createThemePalette({ theme: 'glass', mode, accent: '#b84d61' });
        const green = createThemePalette({ theme: 'glass', mode, accent: '#54877e' });
        const blue = createThemePalette({ theme: 'glass', mode, accent: '#487ac1' });
        assert.equal(new Set([red, green, blue].map(palette => palette.css[background])).size, 3);
        for (const palette of [red, green, blue]) assert.notEqual(palette.css[background], palette.css['--qm-ink']);
    }
    const options = { theme: 'glass', accent: '#54877e' };
    assert.notEqual(createThemePalette({ ...options, mode: 'light' }).css[background], createThemePalette({ ...options, mode: 'dark' }).css[background]);
});
