// Real native-dialog owners and renderers; only read-only fixture services run.
// No real files, restore/delete operations, provider calls or host data are used.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const modules = ['qianmu-appearance-session', 'qianmu-appearance-runtime', 'qianmu-appearance-settings',
    'qianmu-appearance-portals', 'qianmu-appearance-actions', 'qianmu-theme-surfaces', 'qianmu-theme-palette',
    'qianmu-classic-palettes', 'qianmu-storyboard-bundle-view', 'qianmu-storyboard-mapping-view',
    'qianmu-storyboard-link-review-view', 'qianmu-storyboard-restore-storage-view', 'qianmu-user-alias-view'];
const owners = ['bundle', 'mapping', 'link', 'restore', 'alias'];
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const deadline = setTimeout(() => { console.error('Native dialog checks exceeded 120 seconds.'); void browser.close(); }, 120000);
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
let external = 0;
const screenshots = process.env.QIANMU_NATIVE_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = route.request().url();
    if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
    const name = url.replace('https://qianmu.test/', '').replace(/\.js$/, '');
    if (modules.includes(name)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`../${name}.js`, import.meta.url), 'utf8') });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
    const skin = await page.addStyleTag({ content: await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8') });
    await page.evaluate(async () => {
        Object.assign(window, await import('./qianmu-appearance-session.js'), await import('./qianmu-appearance-settings.js'),
            await import('./qianmu-appearance-actions.js'), await import('./qianmu-storyboard-bundle-view.js'),
            await import('./qianmu-storyboard-mapping-view.js'), await import('./qianmu-storyboard-link-review-view.js'),
            await import('./qianmu-storyboard-restore-storage-view.js'), await import('./qianmu-user-alias-view.js'));
        window.framesSettled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.waitClosed = async () => {
            let timer;
            try { await Promise.race([owner.finished, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Dialog did not close: ${dialog.className}`)), 1500); })]); }
            finally { clearTimeout(timer); }
        };
        window.setup = async ({ family, mode = 'light', classic = 'light' }) => {
            window.owner?.close(); window.appearance?.reset();
            document.body.innerHTML = `<div id="story-director-modal" class="open sd-theme-${classic}"><button id="opener">打开检查</button></div><dialog id="host-dialog">其他插件</dialog>`;
            window.root = document.getElementById('story-director-modal');
            window.settings = { theme: classic };
            if (family) settings.appearance = updateAppearancePreferences(settings, { family, mode });
            window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
            appearance.mount(root); await appearance.sync();
            window.calls = []; window.workerClosed = 0; window.signals = []; window.hold = null;
        };
        window.openOwner = (kind, state = 'ready') => {
            document.getElementById('opener').focus();
            const rows = Array.from({ length: state === 'empty' ? 0 : 24 }, (_, index) => index);
            const read = async (action, options = {}) => {
                calls.push(action); if (options.signal) signals.push(options.signal);
                if (!['inspect', 'mapping-list', 'user-alias-preview', 'preview'].includes(action)) throw Error(`Forbidden mutation: ${action}`);
                if (state === 'pending') await new Promise(resolve => { window.hold = resolve; });
                if (state === 'error') throw Error('隔离测试：读取失败，可关闭后重新核对');
                if (action === 'inspect') return { count: rows.length, bytes: rows.length * 800, items: rows.map(index => ({ kind: 'configuration', phase: 'prepared', bytes: 800, chatHash: 'fixture', fileHash: `${index}`.padStart(64, 'a'), updatedAt: 1700000000000 })) };
                if (action === 'mapping-list') return { offset: 0, total: rows.length, query: '', kind: 'all', storage: { count: rows.length, bytes: rows.length * 500 }, rows: rows.map(index => ({ kind: 'environment', createdAt: 1700000000000, bytes: 500, sourceDigest: `${index}`.padStart(64, 'a'), digest: `${index}`.padStart(64, 'b'), chatHash: 'fixture-chat', mappings: 2 })) };
                if (action === 'user-alias-preview') return { total: rows.length, offset: 0, groups: rows.length, unresolved: 0, ready: true, digest: 'fixture', rows: rows.map(index => ({ groupId: `g${index}`, candidateId: `c${index}`, archiveName: `隔离档案 ${index}`, archiveId: `a${index}`, scope: 'default', sourceKey: `avatars/person-${index}.png`, targetKey: `person-${index}.png`, present: true, selected: true })) };
                return { ready: true, planDigest: 'fixture', sourceLabelsMatched: true, images: [], summary: { images: 0, vibeFiles: 0, workflows: { count: 0, versions: 0 }, pools: { count: 0 }, characters: { count: rows.length } }, characterSummary: { added: rows.length, replaced: 0, kept: 0 }, conflicts: rows.map(index => ({ kind: 'archive', localName: `原档案 ${index}`, localVersion: 1, incomingName: `备份档案 ${index}`, incomingVersion: 2, choice: '' })) };
            };
            const common = { parent: root, run: read, formatBytes: value => `${value} B` };
            if (kind === 'mapping') window.owner = openMappingRegistry(common);
            if (kind === 'alias') window.owner = openUserAliasReview(common);
            if (kind === 'restore') window.owner = openRestoreStorageManager({ ...common, chatHash: 'fixture' });
            if (kind === 'bundle') window.owner = openStoryboardBundleReview({ parent: root, fileName: '隔离检查.qianmu', connect: async () => ({ preview: () => read('preview'), close: () => workerClosed++ }) });
            if (kind === 'link') window.owner = openStoryboardLinkReview({ parent: root, apply: () => { throw Error('Apply is forbidden'); }, session: {
                floors() { calls.push('floors'); if (state === 'error') throw Error('隔离测试：读取失败，可关闭后重新核对'); return { page: 0, pages: 1, rows: rows.map(index => ({ floor: index, name: '隔离角色', preview: '当前正文片段，只检查展示与选择，不会挂回正文。' })) }; },
                selectFloor() {}, paragraphs: () => ({ page: 0, pages: 1, floor: 0, rows: rows.map(index => ({ index, text: '保留原文语义、位置与正在核对的选择。'.repeat(6) })) }),
                selectParagraph: index => ({ floor: 0, index }),
            } });
            window.dialog = root.querySelector('dialog');
        };
        window.paint = () => {
            const box = dialog.getBoundingClientRect(), main = dialog.querySelector('main'), style = getComputedStyle(dialog);
            const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); canvas.width = canvas.height = 1;
            const luminance = color => {
                context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
                const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
                return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
            };
            const light = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
            const actions = [...dialog.querySelectorAll('.sd-btn:not(:disabled), .sd-mapping-item:not(:disabled) small')];
            const actionContrast = actions.map(node => {
                const text = getComputedStyle(node).color, base = getComputedStyle(node.closest('.sd-btn')).backgroundColor;
                const light = [luminance(text), luminance(base)].sort((a, b) => b - a);
                return (light[0] + .05) / (light[1] + .05);
            });
            const row = dialog.querySelector('.sd-mapping-item');
            return { color: style.color, background: style.backgroundColor, image: style.backgroundImage, border: style.borderColor, radius: style.borderRadius, scheme: style.colorScheme,
                contrast: (light[0] + .05) / (light[1] + .05),
                actionContrast: actionContrast.length ? Math.min(...actionContrast) : null,
                stacked: !row || [...row.children].every((node, index) => !index || node.getBoundingClientRect().top >= row.children[index - 1].getBoundingClientRect().bottom),
                scrollbars: getComputedStyle(main).scrollbarWidth, overflow: Math.max(dialog.scrollWidth - dialog.clientWidth, main.scrollWidth - main.clientWidth),
                contained: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
                footer: dialog.querySelector('footer').getBoundingClientRect().bottom <= box.bottom + 1,
                controls: [...dialog.querySelectorAll('input,select,button')].map(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, disabled: node.disabled })),
            };
        };
        window.hostSnapshot = () => {
            const style = getComputedStyle(document.getElementById('host-dialog'));
            return [style.color, style.backgroundColor, style.borderColor, style.borderRadius, style.colorScheme];
        };
        window.formValues = () => [...dialog.querySelectorAll('input,select')].map(node => [node.value, node.checked, node.disabled]);
        window.remember = kind => {
            if (kind === 'link') { dialog.querySelector('[data-link-floor]')?.click(); dialog.querySelector('[data-link-paragraph]')?.click(); }
            if (kind === 'restore') dialog.querySelector('[data-restore-item]')?.click();
            if (kind === 'bundle') dialog.querySelector('[data-bundle-environment]')?.click();
            if (kind === 'alias') dialog.querySelector('[data-alias-accepted]')?.click();
            const input = dialog.querySelector('[data-mapping-query]');
            if (input) { input.value = '尚未提交的查询'; input.focus(); input.setSelectionRange(1, 4); }
            else dialog.querySelector('input:not(:disabled),select:not(:disabled),button:not(:disabled)')?.focus();
            const main = dialog.querySelector('main'); main.scrollTop = 137;
            window.retained = { dialog, main, focus: document.activeElement, children: [...dialog.querySelectorAll('*')], html: dialog.innerHTML, values: JSON.stringify(formValues()), top: main.scrollTop, count: calls.length, active: document.activeElement, selection: input ? [input.selectionStart, input.selectionEnd] : null };
        };
        window.verifyRetained = () => ({ connected: retained.children.every(node => node.isConnected), same: root.querySelector('dialog') === retained.dialog && dialog.innerHTML === retained.html,
            top: dialog.querySelector('main').scrollTop, before: retained.top, focus: document.activeElement === retained.focus,
            query: dialog.querySelector('[data-mapping-query]')?.value, selection: retained.selection ? [retained.active.selectionStart, retained.active.selectionEnd] : null,
            calls: calls.length, beforeCalls: retained.count, values: JSON.stringify(formValues()) === retained.values, native: dialog.matches(':modal'), mounted: appearance.size,
        });
    });
    // Existing six palettes must be byte-for-byte equivalent in computed snapshots with the skin loaded or absent.
    for (const width of [393, 1280]) for (const classic of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) for (const kind of owners) {
        await page.setViewportSize({ width, height: 900 });
        await skin.evaluate(node => node.sheet.disabled = true);
        await page.evaluate(async ({ classic, kind }) => { await setup({ classic }); openOwner(kind); await framesSettled(); }, { classic, kind });
        const before = await page.evaluate(() => paint());
        await skin.evaluate(node => node.sheet.disabled = false);
        assert.deepEqual(await page.evaluate(() => paint()), before, `${width}/${classic}/${kind}: classic isolation`);
        await page.evaluate(() => owner.close());
        checks.push(`${width}/${classic}/${kind}: classic unchanged`);
    }
    for (const width of [320, 393, 1280]) for (const family of ['editorial', 'glass']) for (const mode of ['light', 'dark']) for (const kind of owners) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
        await page.evaluate(async ({ family, mode, kind }) => { await setup({ family, mode }); openOwner(kind); await framesSettled(); }, { family, mode, kind });
        const label = `${width}/${family}/${mode}/${kind}`, rendered = await page.evaluate(() => paint());
        if (process.env.QIANMU_NATIVE_TRACE) console.error(label);
        assert.equal(rendered.contained, true, `${label}: viewport`); assert.equal(rendered.footer, true, `${label}: footer`);
        assert.ok(rendered.overflow <= 1, `${label}: horizontal overflow ${rendered.overflow}`);
        assert.equal(rendered.scrollbars, 'none', `${label}: hidden scrollbar`);
        assert.equal(rendered.radius, family === 'glass' ? '22px' : '5px', `${label}: material radius`);
        assert.equal(rendered.scheme, mode, `${label}: native control scheme`);
        assert.ok(rendered.contrast >= 4.5, `${label}: body text contrast against opaque base`);
        assert.ok(rendered.actionContrast === null || rendered.actionContrast >= 4.5, `${label}: action and metadata text contrast ${rendered.actionContrast}`);
        assert.equal(rendered.stacked, true, `${label}: migration metadata must not be squeezed into one line`);
        if (screenshots && width === 393 && family === 'glass' && kind === 'mapping') await page.screenshot({ caret: 'initial', path: path.join(screenshots, `glass-${mode}-mapping.png`) });
        const host = await page.evaluate(() => hostSnapshot());
        await page.evaluate(kind => remember(kind), kind);
        const toggled = await page.evaluate(async () => {
            settings.appearance = updateAppearancePreferences(settings, { family: settings.appearance.family === 'glass' ? 'editorial' : 'glass', mode: settings.appearance.mode === 'light' ? 'dark' : 'light' });
            await appearance.sync(); await framesSettled(); return verifyRetained();
        });
        assert.equal(toggled.same && toggled.connected && toggled.focus && toggled.native && toggled.values, true, label);
        assert.equal(toggled.top, toggled.before, `${label}: scroll`); assert.equal(toggled.calls, toggled.beforeCalls, `${label}: no repeated service calls`);
        assert.equal(toggled.mounted, 1, `${label}: inherits actual modal, no duplicate surface mount`);
        assert.deepEqual(await page.evaluate(() => hostSnapshot()), host, `${label}: unrelated host dialog untouched`);
        const flipped = await page.evaluate(() => paint());
        assert.ok(flipped.actionContrast === null || flipped.actionContrast >= 4.5, `${label}: immediate palette flip contrast ${flipped.actionContrast}`);
        if (kind === 'mapping') { assert.equal(toggled.query, '尚未提交的查询'); assert.deepEqual(toggled.selection, [1, 4]); }
        checks.push(`${label}: native dialog fits, theme flip retains nodes/focus/scroll/choices without service calls`);
        // Do not let screenshot-only caret hiding add/remove inline styles in the
        // very editor subtree whose exact DOM continuity this test is asserting.
        if (screenshots && width === 393 && family === 'glass' && mode === 'dark') await page.screenshot({ caret: 'initial', path: path.join(screenshots, `editorial-light-${kind}.png`) });
        const classic = await page.evaluate(async () => {
            selectQianmuClassicTheme({ settings, themeKey: 'summer', session: appearance, save() {}, resolveLogo: () => null }); await framesSettled();
            return { ...verifyRetained(), themed: root.hasAttribute('data-qm-theme') };
        });
        assert.equal(classic.themed, false); assert.equal(classic.same && classic.connected && classic.focus && classic.native && classic.values, true, `${label}: classic return ${JSON.stringify(classic)}`);
        assert.equal(classic.calls, classic.beforeCalls); assert.equal(classic.top, classic.before);
        // Native search consumes Escape to clear its draft first. Move to the close
        // control AFTER draft preservation assertions to test dialog cancellation.
        await page.evaluate(() => dialog.querySelector('header button').focus());
        await page.keyboard.press('Escape');
        const closed = await page.evaluate(async () => { await waitClosed(); return { dialogs: root.querySelectorAll('dialog').length, open: owner.isOpen, focus: document.activeElement.id, closed: workerClosed }; });
        assert.equal(closed.dialogs, 0); assert.equal(closed.open, false); assert.equal(closed.focus, 'opener'); assert.equal(closed.closed, kind === 'bundle' ? 1 : 0);
        checks.push(`${label}: classic return and Escape preserve cancellation/lifecycle`);
    }
    for (const kind of owners) for (const state of ['empty', 'error']) {
        await page.evaluate(async ({ kind, state }) => { await setup({ family: 'glass', mode: 'light' }); openOwner(kind, state); await framesSettled(); }, { kind, state });
        const result = await page.evaluate(() => ({ ...paint(), text: dialog.textContent, modal: dialog.matches(':modal') }));
        assert.equal(result.contained && result.footer && result.modal, true);
        if (state === 'error') assert.match(result.text, /隔离测试：读取失败/);
        await page.keyboard.press('Escape'); await page.evaluate(() => waitClosed());
        checks.push(`${kind}/${state}: actual empty/error and close path usable`);
    }
    for (const kind of owners.filter(kind => kind !== 'link')) {
        await page.evaluate(async kind => { await setup({ family: 'editorial', mode: 'dark' }); openOwner(kind, 'pending'); await framesSettled(); }, kind);
        await page.keyboard.press('Escape');
        const result = await page.evaluate(async () => {
            await waitClosed(); const aborted = signals.every(signal => signal.aborted);
            hold(); await framesSettled(); return { aborted, dialogs: root.querySelectorAll('dialog').length, closed: workerClosed, calls: calls.length };
        });
        assert.equal(result.aborted, true); assert.equal(result.dialogs, 0); assert.equal(result.closed, kind === 'bundle' ? 1 : 0); assert.equal(result.calls, 1);
        checks.push(`${kind}/pending: cancellation prevents late redraw or repeated work`);
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    for (const kind of owners) {
        await page.evaluate(async kind => { await setup({ family: 'glass', mode: 'light' }); openOwner(kind); await framesSettled(); }, kind);
        assert.equal((await page.evaluate(() => paint())).image, 'none');
        await page.evaluate(() => owner.close()); checks.push(`${kind}: reduced transparency uses solid native dialog canvas`);
    }
    await cdp.detach();
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, errors, external, scope: 'five actual native dialog owners, isolated read-only services; no production restore/delete or real-device claim', checks }));
} finally { clearTimeout(deadline); await browser.close(); }
