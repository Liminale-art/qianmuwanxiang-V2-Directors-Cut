// Isolated production renderers, real native inputs/pointer capture, synthetic media.
// No user browser, credentials, production storage, providers or paid generation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createStoryboardFormFixture, storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = []; let external = 0;
const modules = ['qianmu-appearance-runtime.js', 'qianmu-appearance-settings.js', 'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js'];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = route.request().url();
    if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
    for (const file of modules) if (url === `https://qianmu.test/${file}`) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    if (url.startsWith('https://qianmu.test/') && /\.(?:png|jpe?g|webp|woff2?)(?:\?|$)/.test(url)) return route.fulfill({ status: 204, body: '' });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-theme-skins.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.evaluate(async () => {
        window.appearanceModule = await import('./qianmu-appearance-runtime.js');
        window.appearanceSettings = await import('./qianmu-appearance-settings.js');
    });
    for (const family of ['novel', 'comfy']) {
        const form = createStoryboardFormFixture({ family });
        await page.evaluate(async ({ content, nav, dragSource }) => {
            window.runtime?.dispose(); if (window.fixture?.audioContext) await fixture.audioContext.close();
            document.body.innerHTML = `<main id="story-director-modal" class="sd-theme-light open"><div class="sd-storyboard-scroll" style="height:240px;overflow:auto">${nav}${content}</div></main><div id="qianmu-notes-panel-layer" class="sd-theme-light"><textarea class="sd-note-body" style="position:fixed;left:250px;top:20px;width:250px;height:100px">便笺草稿</textarea></div><div id="qianmu-notes-float-layer"><button class="sd-detached-notes-entry is-glass-dark" style="left:80px;top:160px;--sd-notes-entry-width:60px;--sd-notes-entry-height:68px;background:rgba(43,44,44,.42)!important">N</button></div><dialog id="fixture-dialog"><input value="独立弹层草稿"></dialog>`;
            const root = document.getElementById('story-director-modal'), notes = document.getElementById('qianmu-notes-panel-layer'), entry = document.querySelector('.sd-detached-notes-entry'), dialog = document.getElementById('fixture-dialog');
            root.querySelectorAll('details').forEach(node => node.open = true);
            const input = [...root.querySelectorAll('textarea')].find(node => node.getClientRects().length && node.offsetHeight && !node.disabled);
            if (!input) throw Error('Missing visible production textarea');
            input.value = '正式表单未保存草稿'; input.focus(); input.setSelectionRange(2, 6, 'backward');
            const scroll = root.querySelector('.sd-storyboard-scroll'); scroll.scrollTop = 80;
            window.fixture = { root, notes, entry, dialog, input, scroll, settings: { theme: 'light' }, coverAccent: '#9c7654', coverCalls: [], saves: 0, noteSettings: { position: { x: 80, y: 160 }, detached: true } };
            const runtime = window.runtime = appearanceModule.createQianmuAppearanceRuntime({ readSettings: () => fixture.settings, readCoverAccent: harmony => { fixture.coverCalls.push(harmony); return fixture.coverAccent; } });
            fixture.offMain = runtime.register(root, { scrollTargets: () => [scroll, input] }); runtime.register(notes); runtime.register(dialog); runtime.register(entry, { role: 'hive-entry', tone: 'dark', edgeIndex: 2 });
            window.changeAppearance = patch => { fixture.settings.appearance = appearanceSettings.updateAppearancePreferences(fixture.settings, patch); runtime.sync(); };
            Object.assign(window, { clampDetachedNotesEntry: value => value, detachedNoteCanReturnHome: () => false, notesFeatureSettings: () => fixture.noteSettings, saveSettings: () => fixture.saves++, renderFloatingNotes: () => { throw Error('Theme rebuilt notes'); }, toast() {}, openNotesPanel() {} });
            new Function(dragSource + ';window.bindFloating=bindFloatingNoteEvents;')(); bindFloating(document.getElementById('qianmu-notes-float-layer'));
            // Silent generated local stream: native playback lifecycle, not provider/video quality validation.
            const audioContext = fixture.audioContext = new AudioContext(), destination = audioContext.createMediaStreamDestination(), oscillator = audioContext.createOscillator();
            oscillator.connect(destination); oscillator.start(); const audio = fixture.audio = document.createElement('audio'); audio.muted = true; audio.srcObject = destination.stream; root.append(audio);
            await audioContext.resume(); await audio.play(); fixture.playbackEvents = [];
            for (const event of ['pause', 'emptied', 'abort']) audio.addEventListener(event, () => fixture.playbackEvents.push(event));
        }, { content: form.content, nav: form.nav, dragSource: storyboardFunctionSource('bindFloatingNoteEvents') });
        for (const width of [393, 1280]) for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
            await page.setViewportSize({ width, height: 900 });
            const result = await page.evaluate(async ({ theme, mode }) => {
                const { root, notes, entry, dialog, input, scroll, audio } = fixture;
                input.focus(); input.setSelectionRange(2, 6, 'backward');
                input.dispatchEvent(new CompositionEvent('compositionstart', { data: '未提交', bubbles: true }));
                let compositionEnds = 0; const end = () => compositionEnds++; input.addEventListener('compositionend', end);
                const before = { scroll: scroll.scrollTop, controls: root.querySelectorAll('input,textarea,button,select').length, classes: root.className, position: [entry.style.left, entry.style.top] };
                changeAppearance({ family: theme, mode });
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const result = { before, scroll: scroll.scrollTop, controls: root.querySelectorAll('input,textarea,button,select').length, classes: root.className, position: [entry.style.left, entry.style.top],
                    identity: root.contains(input), value: input.value, selection: [input.selectionStart, input.selectionEnd, input.selectionDirection], focus: document.activeElement === input, compositionEnds,
                    roots: [root, notes, entry, dialog].map(node => [node.dataset.qmTheme, node.dataset.qmMode]), paused: audio.paused, playbackEvents: [...fixture.playbackEvents], legacy: fixture.settings.theme };
                input.removeEventListener('compositionend', end); input.dispatchEvent(new CompositionEvent('compositionend', { data: '未提交', bubbles: true })); return result;
            }, { theme, mode });
            for (const key of ['scroll', 'controls', 'classes', 'position']) assert.deepEqual(result[key], result.before[key]);
            assert.equal(result.identity, true); assert.equal(result.value, '正式表单未保存草稿'); assert.equal(result.focus, true); assert.deepEqual(result.selection, [2, 6, 'backward']);
            assert.equal(result.compositionEnds, 0); assert.deepEqual(result.roots, Array(4).fill([theme, mode])); assert.equal(result.paused, false); assert.deepEqual(result.playbackEvents, []); assert.equal(result.legacy, 'light');
            checks.push(`${family} ${width} ${theme} ${mode}: actual inputs/selection/scroll/portals/playback retained`);
        }
        const source = await page.evaluate(() => {
            changeAppearance({ source: 'manual', accent: '#568' }); const calls = fixture.coverCalls.length;
            fixture.coverAccent = '#f00'; runtime.sync(); const manual = fixture.root.style.getPropertyValue('--sd-accent');
            changeAppearance({ source: 'cover', harmony: 'complementary' }); const cover = fixture.root.style.getPropertyValue('--sd-accent');
            return { manualCalls: fixture.coverCalls.length - calls, manual, cover, harmony: fixture.coverCalls.at(-1) };
        });
        assert.equal(source.manualCalls, 1); assert.notEqual(source.manual, source.cover); assert.equal(source.harmony, 'complementary'); checks.push(`${family}: current-cover/manual source isolation`);
        const entry = page.locator('.sd-detached-notes-entry'), box = await entry.boundingBox(); assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 20, { steps: 3 });
        await page.evaluate(() => changeAppearance({ family: 'editorial', mode: 'light' }));
        await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 65, { steps: 4 }); await page.mouse.up();
        const dragged = await page.evaluate(() => ({ left: parseFloat(fixture.entry.style.left), top: parseFloat(fixture.entry.style.top), position: fixture.noteSettings.position, saves: fixture.saves }));
        assert.notEqual(dragged.left, 80); assert.equal(dragged.left, dragged.position.x); assert.equal(dragged.top, dragged.position.y); assert.equal(dragged.saves, 1); checks.push(`${family}: actual notes pointer drag survives preference switch`);
        const lifecycle = await page.evaluate(() => {
            // Read a JSON round-trip as a new settings object, not a production persistence claim.
            fixture.settings = JSON.parse(JSON.stringify(fixture.settings)); runtime.sync();
            fixture.root.remove(); runtime.sync(); const pruned = runtime.size;
            const late = document.createElement('dialog'); late.innerHTML = '<input value="稍后打开">'; document.body.append(late); const off = runtime.register(late); late.showModal();
            const field = late.querySelector('input'); field.focus(); field.setSelectionRange(1, 3);
            const inherited = [late.dataset.qmTheme, late.dataset.qmMode]; changeAppearance({ family: 'glass', mode: 'dark' });
            const same = late.querySelector('input') === field, focused = document.activeElement === field;
            changeAppearance({ family: 'classic' });
            const restored = [late, fixture.notes, fixture.entry, fixture.dialog].every(node => !node.hasAttribute('data-qm-theme') && !node.style.getPropertyValue('--sd-text'));
            late.close(); off(); late.remove(); runtime.dispose(); fixture.offMain(); return { pruned, inherited, same, focused, restored, size: runtime.size };
        });
        assert.deepEqual(lifecycle, { pruned: 3, inherited: ['editorial', 'light'], same: true, focused: true, restored: true, size: 0 }); checks.push(`${family}: settings reread / detached cleanup / late portal / reversible classic`);
    }
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false, scope: 'actual renderer fixtures; preferences/runtime not yet wired to production settings UI; synthetic composition event is not physical IME validation' }));
} finally { await context.close(); await browser.close(); }
