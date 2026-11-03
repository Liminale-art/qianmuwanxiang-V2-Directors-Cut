// Shared by the Chrome check and Ego rounds. Real render/bind/CSS, synthetic notes.
// No production origin, note storage, account or provider is accessed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { storyboardFunctionSource as section } from '../tests/helpers/storyboard-form-fixture.mjs';

export async function mountNotesGeometryFixture(page, { legacy = false } = {}) {
    let css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    if (legacy) css = css.replace('max-height: calc(100dvh - 36px);', 'max-height: 100%;');
    const skin = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
    const controller = (await readFile(new URL('../qianmu-prose-assistant-window.js', import.meta.url), 'utf8')).replace('export function', 'function');
    const functions = ['noteExcerpt', 'noteUpdatedLabel', 'renderNotesPanel', 'clampNotesPanelSize', 'stopNotesPanelResizeTracking', 'syncNotesPanelSizeToViewport', 'bindNotesPanelResize'].map(section).join('\n');
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>便笺几何回归 · 合成数据</title>'));
    await page.evaluate(({ css, skin, controller, functions }) => {
        const style = document.createElement('style');
        style.textContent = css + '\n' + skin + '\nhtml {transform:translateZ(0)} body {position:fixed;margin:0;width:100vw;height:100dvh}';
        document.head.append(style);
        Object.assign(window, {
            notesRuntime: Array.from({ length: 6 }, (_, i) => ({ id: String(i), body: `合成便笺 ${i + 1}`, updatedAt: 0 })), notesSearch: '', notesActiveId: '',
            notesPanelWindowDispose: null, NOTES_PANEL_LAYER_ID: 'qianmu-notes-panel-layer', NOTES_EDITOR_FONT_SIZES: [13, 16],
            notesFind: id => notesRuntime.find(note => note.id === id), htmlEscape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
            fixtureSettings: { panelSize: { width: 430, height: 420 }, editorFontSize: 13 }, notesFeatureSettings: () => fixtureSettings,
            persistNotesDevice: () => { window.fixtureSaved = structuredClone(fixtureSettings.panelSize); },
        });
        new Function(controller + '\n' + functions + ';Object.assign(window,{renderNotesPanel,bindNotesPanelResize,stopNotesPanelResizeTracking});')();
        const layer = document.createElement('div'); layer.id = NOTES_PANEL_LAYER_ID;
        document.body.append(layer);
        window.resetNotesGeometry = ({ width, height, editor = false, theme = 'glass', transformed = true } = {}) => {
            stopNotesPanelResizeTracking();
            if (width) fixtureSettings.panelSize = { width, height };
            document.documentElement.style.transform = transformed ? 'translateZ(0)' : 'none';
            if (theme === 'classic') layer.removeAttribute('data-qm-theme'); else layer.setAttribute('data-qm-theme', theme);
            notesActiveId = editor ? '0' : '';
            layer.innerHTML = renderNotesPanel();
            bindNotesPanelResize(layer);
        };
        window.notesGeometry = () => {
            const p = layer.querySelector('.sd-notes-panel'), r = p.getBoundingClientRect(), s = getComputedStyle(p);
            const point = selector => { const b = p.querySelector(selector).getBoundingClientRect(); return { x: b.x + Math.min(8, b.width / 2), y: b.y + Math.min(8, b.height / 2) }; };
            return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom,
                writtenWidth: parseFloat(p.style.width), writtenHeight: parseFloat(p.style.height), maxHeight: s.maxHeight,
                viewportBottom: (visualViewport?.offsetTop || 0) + (visualViewport?.height || innerHeight),
                grip: point('[data-notes-resize]'), header: point('header b'), saved: window.fixtureSaved };
        };
    }, { css, skin, controller, functions });
}

export async function checkNotesGeometry(page, { width, height, editor = false, theme = 'glass', transformed = true, label = `${width}x${height}/${theme}/${editor ? 'editor' : 'list'}` }) {
    const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1, `${label}: ${message}: ${a} vs ${b}`);
    const inspect = () => page.evaluate(() => notesGeometry());
    const drag = async (point, dx, dy) => { await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + dx, point.y + dy); await page.mouse.up(); };
    await page.evaluate(options => resetNotesGeometry(options), { width: Math.min(430, width - 72), height: Math.min(420, height * .5), editor, theme, transformed });
    const before = await inspect();
    near(before.height, before.writtenHeight, 'initial displayed height matches controller');
    await drag(before.grip, 20, 60);
    const expanded = await inspect();
    near(expanded.height, before.height + 60, 'vertical growth');
    near(expanded.width, before.width + 20, 'horizontal growth');
    near(expanded.y, before.y, 'resizing keeps top anchored');
    near(expanded.height, expanded.writtenHeight, 'expanded displayed height matches controller');
    await drag(expanded.header, 0, expanded.viewportBottom - 4 - expanded.header.y);
    const bottom = await inspect();
    near(bottom.bottom, bottom.viewportBottom - 18, 'drag reaches actual viewport bottom');
    await drag(bottom.grip, 0, 12);
    const bounded = await inspect();
    near(bounded.y, bottom.y, 'resize at bottom does not shift up');
    near(bounded.height, bottom.height, 'resize at bottom stays bounded');
    await drag(bounded.grip, -10, -80);
    const shrunk = await inspect();
    near(shrunk.height, expanded.height - 80, 'vertical shrink');
    near(shrunk.saved.height, Math.round(shrunk.height), 'saved size matches rendered size');
    await drag(shrunk.header, 0, shrunk.viewportBottom - 4 - shrunk.header.y);
    const movedAgain = await inspect();
    near(movedAgain.bottom, movedAgain.viewportBottom - 18, 'bottom boundary stays consistent after shrink');
    await page.evaluate(({ editor, theme, transformed }) => resetNotesGeometry({ editor, theme, transformed }), { editor, theme, transformed });
    const reopened = await inspect();
    near(reopened.height, shrunk.height, 'reopen retains actual height');
    return { label, heights: [before.height, expanded.height, shrunk.height, reopened.height], bottomGaps: [bottom.viewportBottom - bottom.bottom, movedAgain.viewportBottom - movedAgain.bottom] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
    const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
    let requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { requests++; return route.abort(); });
    try {
        await page.setViewportSize({ width: 1260, height: 1460 });
        await mountNotesGeometryFixture(page, { legacy: true });
        await assert.rejects(checkNotesGeometry(page, { width: 1260, height: 1460 }), /initial displayed height matches controller/);
        await mountNotesGeometryFixture(page);
        for (const [width, height] of [[393, 850], [1025, 886], [1260, 1460], [807, 859], [1280, 900]]) {
            await page.setViewportSize({ width, height });
            for (const editor of [false, true]) checks.push(await checkNotesGeometry(page, { width, height, editor }));
        }
        for (const theme of ['classic', 'editorial']) checks.push(await checkNotesGeometry(page, { width: 1280, height: 900, theme }));
        checks.push(await checkNotesGeometry(page, { width: 1280, height: 900, transformed: false, label: 'ordinary-root' }));
        assert.deepEqual(errors, []); assert.equal(requests, 0);
        console.log(JSON.stringify({ passed: checks.length, legacyRejected: true, checks, errors, requests, scope: 'synthetic render/bind/CSS under transformed root; no production data or backend' }));
    } finally { await context.close(); await browser.close(); }
}
