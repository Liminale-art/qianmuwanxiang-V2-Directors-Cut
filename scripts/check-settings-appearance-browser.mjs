// Real settings, diagnostics and storage renderers; all snapshots are synthetic.
// No provider request, database scan, backup, cleanup or host configuration write.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
import {QIANMU_HIVE_COMMANDS,upgradeProseHiveCommands} from '../qianmu-hive-commands.js';
import {isQianmuOwnedDockDescriptor} from '../qianmu-hive-ownership.js';
import {titleGradientProbe} from './helpers/title-gradient-probe.mjs';

const titleControlsOnly = process.argv.includes('--title-controls');
function widgetStyleProbe(node) {
    const style = getComputedStyle(node), text = getComputedStyle(node.querySelector('span') || node);
    return {
        geometry: { ...Object.fromEntries(['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderRadius'].map(key => [key, style[key]])), fontSize: text.fontSize, fontWeight: text.fontWeight },
        background: style.backgroundColor, color: text.color, border: style.borderColor,
    };
}

const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const declarations = ['VERSION', 'FLOAT_SIZE_MIN', 'FLOAT_SIZE_MAX', 'LOG_LIMIT', 'QUICK_HIVE_SAFETY_LIMIT', 'LOG_STATUS_LABELS', 'LOG_KIND_LABELS'].map(name => {
    const found = index.match(new RegExp('^const ' + name + ' = .+;', 'm')); assert.ok(found, name); return found[0];
});
declarations.push(`const QUICK_COMMANDS = ${JSON.stringify(QIANMU_HIVE_COMMANDS)};`,upgradeProseHiveCommands.toString(),isQianmuOwnedDockDescriptor.toString(), 'const QUICK_COMMAND_IDS = QUICK_COMMANDS.map(item => item.id);');
declarations.push('let feedbackOpenScope = null;');
const names = ['renderActiveTab', 'renderPlugTab', 'renderQuickWheelSettings', 'normalizeQuickWheelSettings', 'bindWidgetSettings',
    'storyboardVideoBudgetPolicy',
    'renderLogEntry', 'renderStorageServiceStatus', 'formatStorageBytes', 'optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'renderStorageManagementCard'];
const source = declarations.join('\n') + '\n' + names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const deadline = setTimeout(() => { void browser.close(); }, 120000), checks = [], errors = [];
let external = 0;
const ok = (name, value) => { assert.ok(value, name); checks.push(name.replace(/: (\{|\[).*$/, '')); };
const qa = new URL('../dist/local-qa/settings-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({
        contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>`,
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({
        contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.css$/.test(url.pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    if (url.origin === 'https://qianmu.test' && url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, storageView, { createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-storage-backup-view.js'), import('/qianmu-appearance-session.js'),
            import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        for (const name of ['htmlEscape', 'uniqueClean', 'infoTag', 'estimateTokens', 'isPlainObject']) window[name] = utils[name];
        Object.assign(window,storageView);
        window.renderModelDiagnostics = (await import('/qianmu-director-live.js')).renderModelDiagnostics;
        Object.assign(window, {
            settings: { theme: 'dark' }, activeTab: 'plug', editorView: null, calls: 0,
            getFloatSize: () => 48, notesFeatureEnabled: () => true, applyQianmuIcons,
            storyboardVideoCredentialKnown: () => fixtureMode !== 'error', storyboardVideoGatewayKnown: () => optionalServiceState.status === 'ready',
            runtimeHealthSnapshot: () => healthFixture, blobStore: { classifyStoragePressure: () => ({ level: 'normal' }) },
        });
        const forbidden = () => { calls++; throw Error('Real provider, storage and configuration operations are forbidden'); };
        window.saveSettings = window.collectStorageInventory = window.stageTheaterScene = window.storyboardEnsureVideoCoordinator = forbidden;
        (0, eval)(source);
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(document.querySelector('#story-director-modal'));
        window.setAppearance = async (family, mode) => {
            settings.theme = mode;
            const root = document.querySelector('#story-director-modal'); root.classList.remove('sd-theme-dark', 'sd-theme-light'); root.classList.add(`sd-theme-${mode}`);
            settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
        };
        window.renderSettingsFixture = (state = 'ready') => {
            window.fixtureMode = state;
            Object.assign(settings, {
                providerMode: state === 'host' ? 'sillytavern' : 'external', apiProfiles: [{ id: 'fixture', name: '隔离API预设' }],
                apiUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture-model', availableModels: ['fixture-model', 'other-fixture'],
                temperature: 0.8, maxOutputTokens: 32000, contextBudget: 1000000, structuredOutputMode: 'json_schema', streamEnabled: true,
                videoH3: { region: 'global', budgetPolicy: { totalDailyLimitUnits: 4, automatic: { enabled: true, maxPerTaskUnits: 1 } } },
                floatingButton: true, quickWheelEnabled: true, quickDockEnabled: false, quickWheelCustomExpanded: true,
                quickWheelCustomOrder: [], quickWheelCustomEnabled: ['dashboard', 'tts', 'notes'], quickWheelDockedPlugins: [],
                logHistory: ['success', 'error', 'cancelled', 'loading', 'none'].map((status, i) => ({ id: 'log' + i, status, kind: i % 2 ? 'theater' : 'director', time: '06:08', duration: '2s',
                    request: '<img src=x>\n' + '原请求的只读显示\n'.repeat(70), response: '原回复的只读显示\n'.repeat(70), error: status === 'error' ? '错误占位 <img src=x> ' + 'e'.repeat(120) : '' })),
                logOpenState: {},
            });
            window.optionalServiceState = { status: state === 'error' ? 'error' : state === 'loading' ? 'checking' : 'ready', version: 'fixture', services: ['minimax-h3', 'doubao-tts'], message: '仅隔离诊断-' + 'm'.repeat(130) };
            window.performanceRuntime = { initMs: 7, readyMs: 10, modalRenderLastMs: 2, modalRenderMaxMs: 5, slowModalRenderCount: 0, lastNodeCount: 100, modalRenderCount: 1, modalOpenCount: 1 };
            window.healthFixture = { warnings: [], renderAverageMs: 3, settingsBytes: 1024, chatBytes: 2000, migrationFailures: [], productionPackets: 2,
                observers: ['隔离观察器'], timers: ['隔离计时器'], lazyFeatures: [{ label: '内置目录', status: 'ready' }, { label: '读取模块', status: 'error' }] };
            if (state === 'partial') {
                healthFixture.migrationFailures = ['隔离回退原因-' + 'r'.repeat(130)];
                healthFixture.observers = ['隔离观察器-' + 'o'.repeat(130)];
            }
            const MB = 1024 * 1024;
            const data = { sampledAt: 1, origin: { available: true, usage: 500 * MB, quota: 2000 * MB, pressure: { level: state === 'partial' ? 'critical' : 'normal', ratio: .95, freeBytes: 20 * MB } },
                trackedBytes: 400 * MB, manageableBytes: 400 * MB, categories: [{ category: 'images', bytes: 240 * MB }, { category: 'audio', bytes: 120 * MB }, { category: 'reader', bytes: 40 * MB }],
                idb: { chatScopes: ['fixture'] }, vibeStorage: { status: 'ready', assets: { count: 1, bytes: 1 }, previews: { bytes: 1 }, records: { count: 1, bytes: 1, archivedCount: 0, pendingCount: 0, reviewCount: 0 }, metadata: { bytes: 1 } },
                restoreStorage: { status: 'ready', count: 1, bytes: 1 }, mappingStorage: { status: 'ready', count: 1, bytes: 1 }, carrierStorage: { status: 'ready', count: 1, originalCount: 1, bytes: 1 },
                characterStorage: { status: 'ready', documents: { count: 1, bytes: 1 }, bindings: { count: 1, bytes: 1 }, indexes: { bytes: 1 } },
                comfyStorage: { status: 'ready', errors: [] }, focusLibrary: { status: 'ready', count: 1, bytes: 1 } };
            if (state === 'partial') data.characterStorage = { status: 'unavailable', error: '未读取不按零计算-' + 'c'.repeat(120) };
            if (state === 'empty') { settings.logHistory = []; data.origin.usage = 0; data.trackedBytes = data.manageableBytes = 0; data.categories = []; data.idb.chatScopes = []; }
            window.storageInventoryState = { status: ['error', 'loading'].includes(state) ? state : 'ready', data: ['error', 'loading'].includes(state) ? null : data, error: '不可读 <img src=x> ' + 'a'.repeat(130) };
            calls = 0;
            const body = document.querySelector('.sd-body'); body.innerHTML = renderActiveTab(); applyQianmuIcons(body); body.scrollTop = 0;
        };
        window.contrast = node => {
            const cv = document.createElement('canvas'); cv.width = cv.height = 1; const ctx = cv.getContext('2d');
            ctx.fillStyle = getComputedStyle(document.querySelector('.sd-window')).getPropertyValue('--qm-bg') || (settings.theme === 'dark' ? '#181818' : '#ffffff'); ctx.fillRect(0, 0, 1, 1);
            const parents = []; for (let el = node; el; el = el.parentElement) parents.unshift(el);
            for (const el of parents) { ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
            const bg = [...ctx.getImageData(0, 0, 1, 1).data]; ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1);
            const fg = [...ctx.getImageData(0, 0, 1, 1).data], luminance = c => c.slice(0, 3).reduce((sum, v, i) => { v /= 255; return sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); }, 0);
            return (Math.max(luminance(bg), luminance(fg)) + .05) / (Math.min(luminance(bg), luminance(fg)) + .05);
        };
    }, source);
    for (const [family, mode] of [['classic', 'light'], ['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) for (const state of titleControlsOnly ? ['ready'] : ['ready', 'host', 'error', 'partial']) {
            const label = `${family}/${mode}/${width}/${state}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ({ family, mode, state }) => { await setAppearance(family, mode); renderSettingsFixture(state); }, { family, mode, state });
            if (titleControlsOnly) {
                for (const selector of ['.sd-model-config > h3', '.sd-widget-card > h3']) {
                    const title = await page.locator(selector).evaluate(titleGradientProbe);
                    ok(`${label} ${selector} paints gradient across actual text: ${JSON.stringify(title)}`, title.gradient && title.textSized);
                }
                await page.evaluate(() => {
                    window.widgetEventCounts = { save: 0, refresh: 0, render: 0 };
                    window.saveSettings = () => widgetEventCounts.save++;
                    window.refreshWidgetRuntime = () => widgetEventCounts.refresh++;
                    window.closeQuickWheel = () => {};
                    window.renderModal = () => {
                        widgetEventCounts.render++;
                        const body = document.querySelector('.sd-body'); body.innerHTML = renderActiveTab(); applyQianmuIcons(body); bindWidgetSettings(body);
                    };
                    bindWidgetSettings(document.querySelector('.sd-body'));
                });
                const expected = await page.locator('.sd-save-api').evaluate(widgetStyleProbe);
                for (const name of ['floating', 'wheel']) {
                    const control = page.locator(`[data-widget-toggle="${name}"]`);
                    const states = [];
                    for (const [key, active] of [['Enter', false], ['Space', true]]) {
                        const before = await page.evaluate(() => ({ ...widgetEventCounts }));
                        await control.focus(); await page.keyboard.press(key);
                        const action = await page.evaluate(({ name, active, before }) => {
                            const field = name === 'floating' ? 'floatingButton' : 'quickWheelEnabled';
                            return settings[field] === active && document.querySelector(`[data-widget-toggle="${name}"]`).getAttribute('aria-pressed') === String(active)
                                && widgetEventCounts.refresh === before.refresh + 1 && widgetEventCounts.render === before.render + 1 && widgetEventCounts.save > before.save;
                        }, { name, active, before });
                        ok(`${label} ${name} ${key} invokes actual toggle binding and renders ${active}`, action);
                        await page.mouse.move(0, 0); await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
                        const actual = await control.evaluate(widgetStyleProbe); states.push(actual);
                        ok(`${label} ${name} ${active} matches save API type and border: ${JSON.stringify({ expected: expected.geometry, actual: actual.geometry })}`, JSON.stringify(actual.geometry) === JSON.stringify(expected.geometry));
                        if (!active) ok(`${label} ${name} off state matches save API colors: ${JSON.stringify({ expected, actual })}`, actual.background === expected.background && actual.color === expected.color && actual.border === expected.border);
                        await control.hover(); await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
                        const hovered = await control.evaluate(node => ({ ratio: contrast(node), color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
                        ok(`${label} ${name} ${active ? 'selected' : 'off'} hover stays readable: ${JSON.stringify(hovered)}`, hovered.ratio >= 4.5);
                    }
                    ok(`${label} ${name} selected and off states remain distinct: ${JSON.stringify(states)}`, states[0].background !== states[1].background || states[0].border !== states[1].border || states[0].color !== states[1].color);
                }
                const stable = await page.evaluate(async ({ family, mode }) => {
                    const button = document.querySelector('[data-widget-toggle="wheel"]'); button.focus();
                    const before = [button, button.getAttribute('aria-pressed'), JSON.stringify(settings)];
                    await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
                    return button.isConnected && document.activeElement === before[0] && button.getAttribute('aria-pressed') === before[1] && JSON.stringify(settings) === before[2] && calls === 0;
                }, { family, mode });
                ok(`${label} theme switch retains keyboard focus and toggle state`, stable);
                const hiveSummary = page.locator('.sd-wheel-custom-details > summary');
                const hiveShape = await hiveSummary.evaluate(node => {
                    const style = getComputedStyle(node), before = getComputedStyle(node, '::before'), after = getComputedStyle(node, '::after');
                    const rect = node.getBoundingClientRect(), center = rect.top + rect.height / 2;
                    return {
                        noArrow: style.listStyleType === 'none' && (before.content === 'none' || before.display === 'none')
                            && (after.content === 'none' || after.content === 'normal' || after.display === 'none') && !node.querySelector('i, svg'),
                        paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom), minHeight: parseFloat(style.minHeight), height: rect.height,
                        centered: [...node.children].every(child => { const r = child.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - center) <= 1; }),
                    };
                });
                ok(`${label} hive fold has no arrow or marker: ${JSON.stringify(hiveShape)}`, hiveShape.noArrow);
                ok(`${label} hive fold is compact with centered title and count: ${JSON.stringify(hiveShape)}`, hiveShape.paddingTop === 2 && hiveShape.paddingBottom === 2 && hiveShape.minHeight === 28 && hiveShape.height <= 29 && hiveShape.centered);
                const hiveBefore = await page.evaluate(() => {
                    window.hiveCommandsBefore = [...document.querySelectorAll('.sd-wheel-command-toggle')];
                    return { order: settings.quickWheelCustomOrder.join('|'), selected: settings.quickWheelCustomEnabled.join('|'), count: hiveCommandsBefore.length };
                });
                await hiveSummary.focus(); await page.keyboard.press('Enter');
                await page.waitForFunction(() => !settings.quickWheelCustomExpanded);
                await page.keyboard.press('Tab');
                ok(`${label} hive Enter folds, saves and skips hidden commands in keyboard navigation`, await page.locator('.sd-wheel-custom-details').evaluate(node => !node.open && !document.activeElement?.closest('.sd-wheel-custom-list')));
                const foldedCenter = await hiveSummary.evaluate(node => {
                    const frame = node.closest('.sd-wheel-settings'), style = getComputedStyle(frame), rect = frame.getBoundingClientRect();
                    const center = rect.top + rect.height / 2;
                    return { paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom), height: rect.height,
                        centered: [...node.children].every(child => { const r = child.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - center) <= 1; }) };
                });
                ok(`${label} folded hive title and count center inside compact outer frame: ${JSON.stringify(foldedCenter)}`, foldedCenter.centered && foldedCenter.paddingTop === 8 && foldedCenter.paddingBottom === 8 && foldedCenter.height <= 46);
                await hiveSummary.focus(); await page.keyboard.press('Space');
                await page.waitForFunction(() => settings.quickWheelCustomExpanded);
                ok(`${label} hive Space reopens original command elements without altering enabled entries`, await page.evaluate(before => {
                    const details = document.querySelector('.sd-wheel-custom-details');
                    return details.open && settings.quickWheelCustomOrder.join('|') === before.order && settings.quickWheelCustomEnabled.join('|') === before.selected
                        && before.count === 16 && hiveCommandsBefore.every(node => node.isConnected && node.getClientRects().length > 0);
                }, hiveBefore));
                const hiveCommand = page.locator('.sd-wheel-command-toggle').first();
                const originalPressed = await hiveCommand.getAttribute('aria-pressed');
                await hiveCommand.focus(); await page.keyboard.press('Space');
                ok(`${label} hive inner command retains actual keyboard toggle and live count`, await hiveCommand.evaluate((node, previous) => {
                    const selected = node.getAttribute('aria-pressed') === 'true';
                    return node.getAttribute('aria-pressed') !== previous && settings.quickWheelCustomEnabled.includes(node.dataset.command) === selected
                        && document.querySelector('.sd-wheel-custom-details > summary > b').textContent === `${settings.quickWheelCustomEnabled.length} 项`;
                }, originalPressed));
                await page.keyboard.press('Enter');
                ok(`${label} hive inner command can restore its original selection`, await hiveCommand.getAttribute('aria-pressed') === originalPressed);
                if (family === 'glass' && mode === 'light' && width === 393) {
                    await hiveSummary.focus(); await page.keyboard.press('Enter');
                    await page.waitForFunction(() => !settings.quickWheelCustomExpanded);
                    await page.evaluate(() => document.activeElement?.blur());
                    await page.locator('.sd-widget-card').screenshot({ path: fileURLToPath(new URL('glass-light-hive-compact-fold-393.png', qa)), animations: 'disabled' });
                    await hiveSummary.focus(); await page.keyboard.press('Space');
                    await page.waitForFunction(() => settings.quickWheelCustomExpanded);
                }
                if (width === 393) {
                    await page.evaluate(() => document.activeElement?.blur());
                    await page.locator('.sd-model-config').screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-model-title-393.png`, qa)), animations: 'disabled' });
                    await page.locator('.sd-widget-card').scrollIntoViewIfNeeded();
                    await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-title-controls-393.png`, qa)), animations: 'disabled' });
                }
                continue;
            }
            ok(label + ' active settings remain without retired dynamic-channel cards', await page.evaluate(() =>
                document.querySelectorAll('.sd-save-api,.sd-test-api,.sd-fetch-models,.sd-storage-service-refresh,.sd-storage-refresh').length === 5
                && !document.querySelector('.sd-video-channel-card,.sd-video-budget-card,.sd-video-h3-check,.sd-video-budget-save')
                && !document.querySelector('.sd-runtime-health-card') && document.querySelector('.sd-storage-card > :last-child').classList.contains('sd-storage-service')
                && document.querySelectorAll('[data-widget-toggle]').length === 2 && document.querySelectorAll('.sd-wheel-command-toggle').length === 16 && document.querySelectorAll('.sd-log-entry').length === 5));
            ok(label + ' paid automation remains locked behind its existing policy', await page.evaluate(() => {
                const policy = storyboardVideoBudgetPolicy(); return policy.automatic.enabled === false && policy.manual.requireCostConfirmation && policy.highResolution.requireExplicitConfirmation;
            }));
            ok(label + ' model source and storage failure/partial meanings are preserved', await page.evaluate(state => {
                if (state === 'host') return document.querySelector('.sd-api-external-fields').hidden && document.querySelector('.sd-provider-select').value === 'sillytavern'
                    && !document.querySelector('.sd-save-api').getClientRects().length && document.querySelector('.sd-stream-toggle').getClientRects().length;
                if (state === 'error') return document.querySelector('.sd-storage-card').textContent.includes('盘点失败') && !document.querySelector('.sd-storage-hero');
                if (state === 'partial') return document.querySelector('.sd-storage-card').textContent.includes('部分数据暂不可读取') && !!document.querySelector('.is-critical') && document.querySelector('.sd-storage-legend').textContent.includes('未盘点站点数据');
                return document.querySelector('.sd-storage-hero b').textContent === '400 MB';
            }, state));
            await page.evaluate(() => document.querySelectorAll('details').forEach(node => { node.open = true; }));
            if (state !== 'host') await page.locator('.sd-api-url').fill('https://unsubmitted.invalid/v1');
            const stable = await page.evaluate(async ({ family, mode, state }) => {
                const body = document.querySelector('.sd-body'), edit = body.querySelector(state === 'host' ? '.sd-provider-select' : '.sd-api-url'); edit.focus();
                if (state !== 'host') edit.setSelectionRange(8, 19);
                body.querySelector('.sd-wheel-command-toggle').checked = false; body.scrollTop = 70;
                body.querySelectorAll('.sd-term').forEach(node => { node.scrollTop = 40; });
                const html = body.innerHTML, nodes = [...body.querySelectorAll('*')], data = JSON.stringify([settings, storageInventoryState, healthFixture, optionalServiceState]);
                const controls = [...body.querySelectorAll('input,select')].map(node => [node, node.value, node.checked]);
                const positions = [body, ...body.querySelectorAll('.sd-term')].map(node => [node, node.scrollTop]);
                await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
                return { dom: html === body.innerHTML && nodes.every(node => node.isConnected), focus: document.activeElement === edit, selection: state === 'host' || edit.selectionStart === 8 && edit.selectionEnd === 19,
                    controls: controls.every(([node, value, checked]) => node.value === value && node.checked === checked),
                    scroll: positions[0][1] > 0 && positions.slice(1).filter(([, top]) => top > 0).length >= 10 && positions.every(([node, top]) => Math.abs(top - node.scrollTop) < 1),
                    reads: calls === 0, state: data === JSON.stringify([settings, storageInventoryState, healthFixture, optionalServiceState]) };
            }, { family, mode, state });
            ok(label + ' hot swap does not reset draft/folds/scroll or mutate snapshots: ' + JSON.stringify(stable), Object.values(stable).every(Boolean));
            ok(label + ' diagnostics and logs cannot insert untrusted images', await page.locator('.sd-body img').count() === 0);
            if (family !== 'classic') {
                const over = await page.locator('.sd-storage-card,.sd-storage-service,.sd-storage-service-status,.sd-storage-pressure,.sd-storage-card p[role=status]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ className: node.className, width: node.clientWidth, scroll: node.scrollWidth })).filter(node => node.scroll > node.width + 1));
                ok(label + ' diagnostic text fits narrow cards: ' + JSON.stringify(over.slice(0, 2)), over.length === 0);
                const ratios = await page.locator('.sd-structured-output-toggle.active,.sd-widget-toggle.active').evaluateAll(nodes => nodes.map(contrast));
                ok(label + ' log/status and selected widget labels stay readable: ' + JSON.stringify(ratios), ratios.every(value => value >= 4.5));
                ok(label + ' log folds use theme corners', await page.locator('.sd-log-entry').first().evaluate((node, family) => getComputedStyle(node).borderTopLeftRadius === (family === 'glass' ? '22px' : '0px'), family));
                ok(label + ' log text retains scrolling without visible bars', await page.locator('.sd-term').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).scrollbarWidth === 'none')));
                ok(label + ' selected widgets remain distinct and terminal keeps its own canvas', await page.evaluate(() =>
                    getComputedStyle(document.querySelector('.sd-widget-toggle.active')).backgroundColor !== getComputedStyle(document.querySelector('.sd-widget-toggle:not(.active)')).backgroundColor
                    && [...document.querySelectorAll('.sd-term')].every(node => getComputedStyle(node).backgroundColor === 'rgb(20, 22, 26)' && contrast(node) >= 4.5)));
            }
            if (width === 393 && state === 'ready' && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                for (const [view, selector] of [['widgets', '.sd-widget-card'], ['storage', '.sd-storage-card']]) {
                    await page.locator(selector).scrollIntoViewIfNeeded();
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    await page.screenshot({ caret: 'initial', animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-${view}-393.png`, qa)) });
                }
            }
        }
        if (titleControlsOnly) continue;
        await page.evaluate(() => renderSettingsFixture('loading'));
        ok(`${family}/${mode} storage loading is not mistaken for zero usage`, await page.locator('.sd-storage-card').textContent().then(text => text.includes('准备扫描')) && await page.locator('.sd-storage-hero').count() === 0);
        await page.evaluate(() => renderSettingsFixture('empty'));
        ok(`${family}/${mode} empty inventory cannot enable cleanup`, await page.locator('.sd-storage-clean').isDisabled() && await page.locator('.sd-storage-chat-clean').isDisabled() && await page.locator('.sd-log-entry').count() === 0);
    }
    await page.evaluate(() => appearance.reset()); assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, scope: titleControlsOnly ? 'actual settings renderers and widget click binding; in-memory save/refresh/render fixtures, no real host persistence' : 'actual settings/health/storage renderers; synthetic snapshots and native state, no host business handlers' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
