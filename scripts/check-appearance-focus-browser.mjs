// Actual focus render/bind, native voice menu, dialogue/autosave and drawer owners.
// Account saves are an isolated in-memory fixture; no TTS, audio, user data or network services.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { focusDefaults } from '../tests/helpers/focus-lock-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const deadline = setTimeout(() => { console.error('Focus appearance checks exceeded 120 seconds'); void browser.close(); }, 120000);
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
let external = 0;
const screenshots = process.env.QIANMU_FOCUS_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
        if (/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
    }
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
    const skin = await page.addStyleTag({ content: await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8') });
    // Same isolated host bounds used by the existing focus business checks.
    await page.addStyleTag({ content: 'body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal>main{height:100%;overflow:auto;padding:12px;box-sizing:border-box}' });
    await page.evaluate(async defaults => {
        for (const file of ['qianmu-appearance-session', 'qianmu-appearance-settings', 'qianmu-appearance-actions', 'qianmu-focus-view', 'qianmu-focus-events', 'qianmu-focus-dialogue', 'qianmu-focus-dialogue-ui', 'qianmu-focus-drawer', 'qianmu-icon-renderer']) Object.assign(window, await import(`./${file}.js`));
        window.escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        window.framesSettled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.forbidden = () => { throw Error('Media/provider/deletion action is outside this check'); };
        window.render = () => {
            counts.render++;
            const data = { f, remaining: 900000, total: 1500000, phase: { label: '专注' }, strongLocked: false, today: [],
                week: { days: Array.from({ length: 7 }, () => ({ minutes: 0 })), history: [], minutes: 0, count: 0, readingMinutes: 0 },
                books: [], weekStart: new Date(2026, 8, 14), voiceContext, voiceCharacters: [], voiceDrawerCount: 24, providerLabel: voiceContext.providerId,
                FOCUS_CLOCK_PHASES: { focus: { label: '专注', icon: 'fa-clock' }, shortBreak: { label: '小憩', icon: 'fa-mug-hot' }, longBreak: { label: '长休', icon: 'fa-couch' } },
                FOCUS_CLOCK_RELATIONS: { neutral: { label: '中性' } }, FOCUS_CLOCK_VOICE_FREQUENCIES: { low: { label: '低', chance: .3 }, mid: { label: '中', chance: .5 }, high: { label: '高', chance: .75 } }, FOCUS_CLOCK_SOUND_PRESETS: {} };
            root.querySelector('main').innerHTML = renderFocusClockView(data, escapeText);
            root.querySelector('.sd-focus-settings').open = true;
            bindFocusClockPage(root.querySelector('main'), { state: () => f, stateOwner: () => f, enabled: () => true,
                ui: { save: () => counts.save++, render }, voice: { context: () => voiceContext, bind(key, character, provider) { counts.bind.push([key, character, provider]); voiceContext.selected = key; }, openDrawer() {} },
                sound: { sync() {}, play: forbidden }, clock: {} });
            applyQianmuIcons(root.querySelector('main'));
        };
        window.setup = async ({ family, mode = 'light', classic = 'light' }) => {
            window.dialogue?.close(); window.drawer?.close(); window.appearance?.reset();
            document.body.innerHTML = `<div id="story-director-modal" class="open sd-theme-${classic}"><main class="sd-body"></main></div>`;
            window.root = document.getElementById('story-director-modal'); window.f = structuredClone(defaults);
            Object.assign(f, { voiceSetupTipSeen: true, voiceMode: 'custom', status: 'idle' });
            f.dialogueLibrary = { schema: 1, revision: 1, rows: Array.from({ length: 24 }, (_, index) => ({ id: `row${index}`, characterKey: 'character:A.png', speaker: '隔离角色', text: `第 ${index + 1} 句 · 已有的台词内容`, moments: ['focus:complete'] })) };
            window.account = { focusClock: f }; window.counts = { render: 0, save: 0, bind: [] };
            window.voiceContext = { hasCharacter: true, characterKey: 'character:A.png', characterName: '隔离角色', providerId: 'MiniMax', voice: { voiceId: 'v0' }, options: Array.from({ length: 40 }, (_, index) => ({ key: `v${index}`, label: `音色 ${index} · 清晰且较长的显示名称` })), selected: 'v0', relation: 'neutral', enabled: true };
            window.settings = { theme: classic }; if (family) settings.appearance = updateAppearancePreferences(settings, { family, mode });
            render();
            window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
            appearance.mount(root); await appearance.sync();
            window.library = createFocusDialogueLibrary({ owner: () => account, legacy: async () => [], save: () => counts.save++ });
            window.drawer = createFocusVoiceDrawer({ document, getModal: () => root, rowsForView: () => f.dialogueLibrary.rows.map(row => ({ ...row, task: '隔离专注', sourceTime: 1700000000000 })),
                format: { escape: escapeText, date: () => '隔离时间', icons: applyQianmuIcons }, voice: { play: forbidden, regenerate: forbidden, blob: forbidden },
                favorites: { sync() {}, toggle: forbidden }, download: { save: forbidden }, notify: forbidden, now: () => 1700000000000 });
        };
        window.openDialogue = async () => {
            window.dialogue = await openFocusDialogue({ document, host: root, library, guard: async () => {}, choices: () => [{ avatar: 'A.png', name: '隔离角色' }], binding: () => ({ characterKey: 'character:A.png' }), escape: escapeText, icons: applyQianmuIcons, confirm: forbidden });
        };
        window.surface = kind => kind === 'voice' ? root.querySelector('.sd-focus-voice-menu') : kind === 'drawer' ? root.querySelector('.sd-focus-voice-drawer') : root.querySelector('.sd-focus-library');
        window.scroller = kind => kind === 'voice' ? surface(kind) : surface(kind).querySelector(kind === 'drawer' ? '.sd-focus-voice-drawer-list' : '.sd-focus-library-body');
        window.snapshot = kind => {
            const node = surface(kind), scroll = scroller(kind), box = node.getBoundingClientRect(), style = getComputedStyle(node);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d');
            const light = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }); return values[0] * .2126 + values[1] * .7152 + values[2] * .0722; };
            const contrast = (ink, base) => { const values = [light(ink), light(base)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
            const accents = [...node.querySelectorAll('.sd-focus-voice-provider,.sd-focus-dialogue-moments > [aria-pressed="true"]')];
            const accentContrast = accents.map(node => { const style = getComputedStyle(node); return contrast(style.color, style.backgroundColor); });
            return { radius: style.borderRadius, bg: style.backgroundColor, image: style.backgroundImage, color: style.color, filter: style.backdropFilter,
                contrast: contrast(style.color, style.backgroundColor), accentContrast: accentContrast.length ? Math.min(...accentContrast) : null,
                scrollbar: getComputedStyle(scroll).scrollbarWidth, overflow: Math.max(node.scrollWidth - node.clientWidth, scroll.scrollWidth - scroll.clientWidth),
                fits: box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 };
        };
        window.remember = kind => {
            const node = surface(kind), scroll = scroller(kind);
            if (kind === 'voice') node.querySelector('[data-focus-voice-key="v12"]').focus({ preventScroll: true });
            if (kind === 'list') { node.querySelector('[data-select="row2"]').click(); node.querySelector('[data-select="row2"]').focus({ preventScroll: true }); }
            if (kind === 'drawer') { node.querySelector('.sd-focus-cue-more').click(); node.querySelector('.sd-focus-cue-more').focus({ preventScroll: true }); }
            scroll.scrollTop = kind === 'editor' ? 0 : 173;
            window.kept = { node, children: [...node.querySelectorAll('*')], html: node.innerHTML, focus: document.activeElement, top: scroll.scrollTop, count: JSON.stringify(counts),
                values: JSON.stringify([...node.querySelectorAll('input,textarea,button[data-moment]')].map(el => [el.value, el.checked, el.getAttribute('aria-pressed')])),
                selection: kind === 'editor' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null };
        };
        window.flip = async kind => {
            settings.appearance = updateAppearancePreferences(settings, { family: settings.appearance.family === 'glass' ? 'editorial' : 'glass', mode: settings.appearance.mode === 'light' ? 'dark' : 'light' });
            await appearance.sync(); await framesSettled();
            const node = surface(kind);
            return { nodes: node === kept.node && kept.children.every(el => el.isConnected) && node.innerHTML === kept.html, focus: document.activeElement === kept.focus,
                scroll: scroller(kind).scrollTop === kept.top, count: JSON.stringify(counts) === kept.count,
                values: JSON.stringify([...node.querySelectorAll('input,textarea,button[data-moment]')].map(el => [el.value, el.checked, el.getAttribute('aria-pressed')])) === kept.values,
                selection: kind === 'editor' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null, ...snapshot(kind) };
        };
    }, focusDefaults);
    for (const width of [320, 393, 1280]) for (const family of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
        const label = `${width}/${family}/${mode}`;
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
        await page.evaluate(async options => { await setup(options); }, { family, mode });
        // Native voice picker: actual click binding, keyboard navigation, saved key.
        await page.locator('.sd-focus-voice-speaker').click();
        for (const kind of ['voice', 'list', 'editor', 'drawer']) {
            if (kind === 'list') await page.evaluate(() => openDialogue());
            if (kind === 'editor') {
                await page.locator('[data-action="edit"]').first().click();
                await page.evaluate(() => {
                    const editor = root.querySelector('textarea'); editor.value = '仍在输入的台词草稿'; editor.focus(); editor.setSelectionRange(2, 5);
                    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                    editor.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
                });
            }
            if (kind === 'drawer') await page.evaluate(() => drawer.open());
            const before = await page.evaluate(kind => snapshot(kind), kind);
            assert.equal(before.fits, true, `${label}/${kind}: bounds`); assert.ok(before.overflow <= 1, `${label}/${kind}: horizontal overflow`);
            assert.equal(before.scrollbar, 'none', `${label}/${kind}: hidden scrollbar`);
            assert.ok(before.contrast >= 4.5 && (before.accentContrast === null || before.accentContrast >= 4.5), `${label}/${kind}: text/channel/stage contrast ${JSON.stringify(before)}`);
            await page.evaluate(kind => remember(kind), kind);
            const result = await page.evaluate(kind => flip(kind), kind);
            assert.equal(result.nodes && result.focus && result.scroll && result.count && result.values, true, `${label}/${kind}: continuity ${JSON.stringify(result)}`);
            assert.equal(result.fits, true); assert.equal(result.radius, await page.evaluate(() => settings.appearance.family === 'glass' ? '22px' : '5px'));
            if (kind === 'editor') assert.deepEqual(result.selection, [2, 5]);
            if (screenshots && width === 393 && family === 'glass') {
                const appearanceName = await page.evaluate(() => `${settings.appearance.family}-${settings.appearance.mode}`);
                await page.screenshot({ caret: 'initial', path: path.join(screenshots, `${appearanceName}-${kind}.png`) });
            }
            checks.push(`${label}/${kind}: actual owner, nodes/draft/selection/scroll retained without extra render/save/provider calls`);
            if (kind === 'voice') {
                await page.keyboard.press('End'); await page.keyboard.press('Enter');
                assert.equal(await page.locator('.sd-focus-voice-menu').isVisible(), false);
                assert.equal(await page.locator('.sd-focus-voice-speaker').innerText(), '音色 39 · 清晰且较长的显示名称');
                assert.deepEqual(await page.evaluate(() => counts.bind), [['v39', 'character:A.png', 'MiniMax']]);
                assert.equal(await page.locator('.sd-focus-voice-provider').first().isVisible(), false);
            }
            if (kind === 'editor') {
                const classic = await page.evaluate(async () => {
                    const requested = settings.appearance;
                    selectQianmuClassicTheme({ settings, themeKey: 'summer', session: appearance, save() {}, resolveLogo: () => null }); await framesSettled();
                    const result = { nodes: kept.children.every(el => el.isConnected) && kept.node.innerHTML === kept.html, focus: document.activeElement === kept.focus, saves: counts.save, draft: kept.focus.value, selection: [kept.focus.selectionStart, kept.focus.selectionEnd], classic: !root.hasAttribute('data-qm-theme') };
                    settings.appearance = requested; await appearance.sync(); await framesSettled(); return result;
                });
                assert.deepEqual(classic, { nodes: true, focus: true, saves: 0, draft: '仍在输入的台词草稿', selection: [2, 5], classic: true });
                await page.evaluate(() => root.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
                await page.waitForFunction(() => f.dialogueLibrary.rows[0].text === '仍在输入的台词草稿');
                assert.equal(await page.evaluate(() => counts.save), 1);
                await page.locator('.sd-focus-dialogue [data-action="close"]').click(); await page.locator('.sd-focus-dialogue').waitFor({ state: 'detached' });
                assert.equal(await page.locator('main').evaluate(node => node.inert), false);
                checks.push(`${label}/editor: classic round-trip keeps composing draft, composition end saves exactly once`);
            }
            if (kind === 'drawer') {
                assert.equal(await page.locator('.sd-focus-cue-tools').first().isVisible(), true);
                await page.locator('.sd-focus-voice-drawer-close').click();
            }
        }
        // Real focus renderer retains running/paused control gates under both themes.
        for (const status of ['running', 'paused']) {
            await page.evaluate(status => { f.status = status; render(); }, status);
            assert.equal(await page.locator('.sd-focus-voice-speaker').isDisabled(), true);
            assert.equal(await page.locator('.sd-focus-phase').first().isDisabled(), true);
            assert.equal(await page.locator('.sd-focus-voice-enabled').isDisabled(), false);
            checks.push(`${label}/${status}: existing timer/voice-off gates preserved`);
        }
    }
    // Loading the optional sheet must leave every classic focus dialog unchanged.
    for (const classic of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) {
        await page.evaluate(async classic => { await setup({ classic }); }, classic);
        for (const kind of ['voice', 'list', 'drawer']) {
            await skin.evaluate(node => node.sheet.disabled = true);
            if (kind === 'voice') await page.locator('.sd-focus-voice-speaker').click();
            if (kind === 'list') await page.evaluate(() => openDialogue());
            if (kind === 'drawer') await page.evaluate(() => drawer.open());
            const before = await page.evaluate(kind => snapshot(kind), kind);
            await skin.evaluate(node => node.sheet.disabled = false);
            assert.deepEqual(await page.evaluate(kind => snapshot(kind), kind), before, `${classic}/${kind}: classic style isolation`);
            await page.evaluate(kind => { if (kind === 'voice') surface(kind).close(); else if (kind === 'drawer') drawer.close(); else dialogue.close(); }, kind);
            checks.push(`${classic}/${kind}: classic computed appearance unchanged`);
        }
    }
    for (const invalidation of ['owner', 'provider', 'running']) {
        await page.evaluate(async () => { await setup({ family: 'glass', mode: 'light' }); }, null);
        await page.locator('.sd-focus-voice-speaker').click();
        await page.evaluate(async invalidation => {
            remember('voice'); await flip('voice');
            if (invalidation === 'owner') window.f = { ...f };
            if (invalidation === 'provider') window.voiceContext = { ...voiceContext, providerId: '豆包' };
            if (invalidation === 'running') f.status = 'running';
        }, invalidation);
        await page.locator('[data-focus-voice-key="v12"]').click();
        assert.deepEqual(await page.evaluate(() => counts.bind), []);
        assert.equal(await page.locator('.sd-focus-voice-menu').isVisible(), false);
        checks.push(`${invalidation}: theme flip does not bypass stale voice-choice guard`);
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await page.evaluate(async () => { await setup({ family: 'glass', mode: 'light' }); });
    for (const kind of ['voice', 'list', 'drawer']) {
        if (kind === 'voice') await page.locator('.sd-focus-voice-speaker').click();
        if (kind === 'list') await page.evaluate(() => openDialogue());
        if (kind === 'drawer') await page.evaluate(() => drawer.open());
        const result = await page.evaluate(kind => snapshot(kind), kind);
        assert.equal(result.image, 'none'); assert.equal(result.filter, 'none');
        await page.evaluate(kind => { if (kind === 'voice') surface(kind).close(); else if (kind === 'drawer') drawer.close(); else dialogue.close(); }, kind);
        checks.push(`${kind}: reduced-transparency choice uses an opaque, unblurred canvas`);
    }
    await cdp.detach();
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, errors, external, checks, scope: 'actual focus/voice/dialogue/autosave/drawer owners, isolated account; synthetic composition events are not a real IME or device test' }));
} finally { clearTimeout(deadline); await browser.close(); }
