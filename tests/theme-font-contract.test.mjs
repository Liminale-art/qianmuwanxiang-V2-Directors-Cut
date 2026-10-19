import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skins = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const rules = source => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('classic panel follows the verified interface family without a forced serif heading', () => {
    const rule = rules(base).find(({ selector, body }) => selector.includes('#story-director-floor-nav .qm-font-window') && body.includes('font-family: var(--qm-interface-font'));
    assert.ok(rule); assert.match(rule.body, /var\(--qm-interface-font, var\(--sd-font, var\(--mainFontFamily/);
    assert.match(rule.body, /font-size: 14\.5px !important/);
    const heading = rules(base).find(({ selector }) => selector.includes('#story-director-modal:not([data-qm-theme]) .sd-header h2'));
    assert.match(heading.body, /font-family: inherit !important/); assert.doesNotMatch(heading.body, /Georgia|Times New Roman/);
});

test('paper typography is owned-root only and preserves samples, icon and technical fonts', () => {
    const paper = rules(skins).filter(({ body }) => body.includes('font-family: var(--qm-editorial-font)'));
    assert.equal(paper.length, 3); assert.ok(paper.every(({ selector }) => selector.includes('[data-qm-theme="editorial"]')));
    const descendants = paper.find(({ selector }) => selector.includes(':not(:is('));
    for (const protectedText of ['[data-font-sample]', '[data-font-sample] *', 'svg *', 'code *', '.sd-term *', '.sd-npc-index', '.fa']) assert.ok(descendants.selector.includes(protectedText), protectedText);
    assert.match(skins, /--qm-editorial-font: "KingHwaOldSong", "Songti SC", "STSong", "Noto Serif CJK SC", "SimSun", serif/);
    assert.ok(paper.every(({ body }) => !/font-size\s*:/.test(body)), 'family selection does not create a second size scale');
    assert.doesNotMatch(skins, /font-size\s*:/, 'optional themes do not shrink mobile type');
});

test('heading gradients are minimal-only while classic and paper keep plain ink', () => {
    const gradients = rules(base).filter(({ body }) => /background(?:-image)?:[^;]*(?:var\(--qm-card-title-gradient|var\(--sd-title-grad|var\(--sd-subtitle-grad)/.test(body));
    assert.equal(gradients.length, 5);
    assert.ok(gradients.every(({ selector }) => selector.split(',\n#').every(part => part.includes('[data-qm-theme="glass"]'))));
    const heading = rules(base).find(({ selector, body }) => selector.includes('.sd-header h2') && body.includes('background: none !important'));
    assert.match(heading.body, /background-clip: border-box !important/); assert.match(heading.body, /-webkit-text-fill-color: currentColor !important/);
});
