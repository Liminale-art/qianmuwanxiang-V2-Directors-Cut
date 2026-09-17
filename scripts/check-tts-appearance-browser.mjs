// Real TTS renderers and provider capability declarations; no synthesis or ST writes.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const names = ['renderActiveTab', 'renderTtsTab', 'renderTtsVoiceMapRows', 'renderTtsVoiceEntryRows',
    'renderTtsVoiceLibRows', 'renderTtsNpcRows', 'renderTtsTagRows', 'renderTtsPronDictRows',
    'ttsSchemeLibraryCfg', 'renderTtsFavoritesPlaceholder', 'renderTtsProviderOptions',
    'renderTtsProviderConnection', 'renderTtsProviderParams', 'renderTtsMinimaxExtras',
    'ttsDoubaoVoiceModel', 'ttsDoubaoVoiceModelLabel', 'renderLibrarySection', 'renderLibraryListBody', 'renderLibraryRow'];
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const guide = index.match(/^const DOUBAO_APIKEY_GUIDE_URL = .+;/m); assert.ok(guide);
const source = guide[0] + '\n' + names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const deadline = setTimeout(() => { void browser.close(); }, 120000), checks = [], errors = [];
let external = 0;
const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
const qa = new URL('../dist/local-qa/tts-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({
        contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>`,
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({
        contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, providers, { createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-tts-providers.js'), import('/qianmu-appearance-session.js'),
            import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        for (const name of ['htmlEscape', 'groupByFolder']) window[name] = utils[name];
        for (const name of ['getTtsProvider', 'listTtsProviders', 'ttsProviderSupports', 'createTtsProviderDefaults']) window[name] = providers[name];
        Object.assign(window, {
            settings: { theme: 'dark', apiProfiles: [{ id: 'fixture', name: '隔离提取模型' }] }, editorView: null, activeTab: 'tts', calls: 0,
            ttsProviderId: () => settings.tts.provider, ttsProviderConfig: () => settings.tts.providers[settings.tts.provider],
            ttsActiveVoiceMap: () => voiceMap, ttsExtractScheme: () => 'provider', ttsGuidanceSchemeForValue: () => null,
            ttsResolvedExtractPrompt: () => '保留原台词提取约束\n'.repeat(80),
            ttsSchemeSearch: '', ttsSchemeExportMode: false, ttsSchemeExportSelection: new Set(), applyQianmuIcons,
        });
        const forbidden = () => { calls++; throw Error('Synthesis, ST persistence and library changes are forbidden'); };
        window.synthesizeTts = window.saveSettings = window.saveMetadata = window.ttsStartChat = window.ttsStopChat = forbidden;
        (0, eval)(source);
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(document.querySelector('#story-director-modal'));
        window.setAppearance = async (family, mode) => { settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync(); };
        window.renderVoices = (id, state = 'populated') => {
            const p = createTtsProviderDefaults(id), empty = state === 'empty';
            p.apiKey = ''; // Never read real credentials, even for a masked input.
            if (id === 'elevenlabs') p.model = state === 'legacy-model' ? 'eleven_multilingual_v2' : 'eleven_v3';
            if (id === 'doubao') p.authMode = state === 'legacy-auth' ? 'legacy' : 'apiKey';
            p.voiceLibrary = empty ? [] : Array.from({ length: 30 }, (_, i) => ({ id: 'voice' + i, voiceId: 'fixture-voice-' + i,
                name: i === 0 ? '音色 <img src=x> 只作文本' : '旅人音色 ' + i, folder: i < 5 ? '主角' : '', model: ['auto', 'seed-tts-2.0', 'seed-icl-2.0', 'seed-icl-1.0'][i % 4] }));
            p.npcArchetypes = empty ? [] : Array.from({ length: 25 }, (_, i) => ({ id: 'npc' + i, voiceId: 'fixture-npc-' + i, label: '路人原型 ' + i, folder: i < 4 ? '街头' : '', model: 'auto' }));
            p.pronunciationDict = [{ from: '处理', to: 'chu3li3' }];
            window.voiceMap = empty ? [] : [{ name: '旅人', voiceId: 'fixture-voice-1', voiceLibraryId: 'voice1' }, { name: '自定义角色', voiceId: 'unlisted-fixture' }];
            if (state === 'manual') { p.voiceLibrary = []; voiceMap = [{ name: '手动角色', voiceId: 'manual-fixture' }]; }
            settings.tts = { provider: id, providers: { [id]: p }, enabled: state !== 'disabled', npcEnabled: true, stripHtml: true,
                testText: '不执行合成的试听台词', tagRules: [{ name: 'thinking', action: 'remove' }], cacheLimit: 200,
                guidanceSchemes: empty ? [] : [{ id: 'scheme0', name: '原台词指导方案', folder: '原方案' }], extractPromptBackups: {} };
            calls = 0;
            const body = document.querySelector('.sd-body'); body.innerHTML = renderActiveTab(); applyQianmuIcons(body); body.scrollTop = 0;
        };
        window.contrast = node => {
            const cv = document.createElement('canvas'); cv.width = cv.height = 1; const ctx = cv.getContext('2d');
            ctx.fillStyle = getComputedStyle(document.querySelector('.sd-window')).getPropertyValue('--qm-bg') || '#181818'; ctx.fillRect(0, 0, 1, 1);
            const parents = []; for (let el = node; el; el = el.parentElement) parents.unshift(el);
            for (const el of parents) { ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
            const bg = [...ctx.getImageData(0, 0, 1, 1).data]; ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1);
            const fg = [...ctx.getImageData(0, 0, 1, 1).data], luminance = c => c.slice(0, 3).reduce((sum, v, i) => { v /= 255; return sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); }, 0);
            return (Math.max(luminance(bg), luminance(fg)) + .05) / (Math.min(luminance(bg), luminance(fg)) + .05);
        };
    }, source);
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) for (const provider of ['minimax', 'doubao', 'elevenlabs']) {
            const label = `${family}/${mode}/${width}/${provider}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ({ family, mode, provider }) => { await setAppearance(family, mode); renderVoices(provider); }, { family, mode, provider });
            ok(label + ' actual provider form and all original library controls are present', await page.evaluate(() =>
                document.querySelectorAll('.sd-tts-provider option').length === 3 && document.querySelectorAll('.sd-tts-lib-test').length === 30
                && document.querySelectorAll('.sd-tts-narch-test').length === 25 && document.querySelectorAll('.sd-tts-fav-refresh,.sd-tts-save-prompt,.sd-tts-save-scheme').length === 3
                && document.querySelectorAll('.sd-tts-cache-limit').length === 1 && document.querySelectorAll('.sd-tts-cache-export,.sd-tts-cache-import,.sd-tts-cache-clear').length === 0));
            ok(label + ' provider-specific parameter gates are unchanged', await page.evaluate(provider => provider === 'minimax'
                ? !!document.querySelector('.sd-tts-langboost') && !!document.querySelector('.sd-tts-prondict-from')
                : provider === 'doubao' ? !!document.querySelector('.sd-tts-auth-mode') && !!document.querySelector('.sd-tts-sample-rate') && !document.querySelector('.sd-tts-langboost')
                    : !!document.querySelector('.sd-tts-stability') && !document.querySelector('.sd-tts-speed,.sd-tts-similarity,.sd-tts-speaker-boost'), provider));
            ok(label + ' selected library identity and unlisted custom voice survive rendering', await page.locator('.sd-tts-vid-sel').evaluateAll(nodes => nodes[0].selectedOptions[0].dataset.libId === 'voice1' && nodes[1].value === 'unlisted-fixture'));
            await page.evaluate(() => { document.querySelectorAll('.sd-plain-fold,.sd-lib-folder').forEach(node => { node.open = true; }); });
            await page.locator('.sd-tts-extract-prompt').fill('未保存台词提取草稿\n'.repeat(80));
            const stable = await page.evaluate(async ({ family, mode }) => {
                const body = document.querySelector('.sd-body'), edit = body.querySelector('.sd-tts-extract-prompt');
                edit.focus(); edit.setSelectionRange(4, 11); edit.scrollTop = 60; body.scrollTop = 45;
                body.querySelector('.sd-tts-npc-enabled').checked = false;
                body.querySelector('.sd-tts-voice-list input').value = '未保存的角色名';
                body.querySelectorAll('.sd-scroll').forEach(node => { node.scrollTop = 65; });
                const nodes = [...body.querySelectorAll('*')], html = body.innerHTML, data = JSON.stringify([settings.tts, voiceMap]);
                const controls = [...body.querySelectorAll('input,select,textarea')].map(node => [node, node.value, node.checked]);
                const positions = [body, edit, ...body.querySelectorAll('.sd-scroll')].map(node => [node, node.scrollTop]);
                await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
                return { dom: html === body.innerHTML && nodes.every(node => node.isConnected), focus: document.activeElement === edit,
                    selection: edit.selectionStart === 4 && edit.selectionEnd === 11, controls: controls.every(([node, value, checked]) => node.value === value && node.checked === checked),
                    nestedScroll: positions.filter(([, top]) => top > 0).length >= 4 && positions.every(([node, top]) => Math.abs(top - node.scrollTop) < 1),
                    state: data === JSON.stringify([settings.tts, voiceMap]) && calls === 0 };
            }, { family, mode });
            ok(label + ' hot palette changes preserve local edits, selection, scroll and provider state: ' + JSON.stringify(stable), Object.values(stable).every(Boolean));
            ok(label + ' labels cannot inject markup', await page.locator('.sd-body img').count() === 0);
            if (family !== 'classic') {
                ok(label + ' voice lists follow family corners', await page.locator('.sd-tts-lib-list .sd-lib-folder,.sd-tts-npc-list .sd-lib-row').evaluateAll((nodes, family) => nodes.every(node => getComputedStyle(node).borderTopLeftRadius === (family === 'glass' ? '22px' : '0px')), family));
                ok(label + ' scrollbars are hidden without disabling scrolling', await page.locator('.sd-tts-lib-list,.sd-tts-npc-list').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).scrollbarWidth === 'none' && node.scrollTop > 0)));
                ok(label + ' provider and mapping fields fit the narrow panel', await page.locator('.sd-tts-model-row,.sd-tts-voice-row,.sd-tts-tag-row,.sd-tts-prondict-row').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)));
                const enabled = await page.locator('.sd-tts-enabled').evaluate(node => ({ color: getComputedStyle(node).color, contrast: contrast(node) }));
                const normal = await page.locator('.sd-tts-add-voice').evaluate(node => getComputedStyle(node).color);
                ok(label + ' enabled status is readable and distinct from ordinary actions', enabled.contrast >= 4.5 && enabled.color !== normal);
                if (provider === 'doubao') {
                    const ratios = await page.locator('.sd-tts-resource-badge').evaluateAll(nodes => nodes.map(contrast));
                    ok(label + ' all resource-type labels are readable: ' + JSON.stringify(ratios.slice(0, 5)), ratios.every(value => value >= 4.5));
                }
            }
            if (width === 393 && provider === 'doubao' && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                await page.locator('.sd-tts-lib-list').scrollIntoViewIfNeeded();
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                await page.screenshot({ caret: 'initial', animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-library-393.png`, qa)) });
            }
            await page.evaluate(provider => renderVoices(provider, 'empty'), provider);
            ok(label + ' original empty guidance, lazy favorites and disabled restore remain', await page.evaluate(() =>
                document.querySelector('.sd-tts-voice-list').textContent.includes('尚未配置角色') && document.querySelector('.sd-tts-lib-list').textContent.includes('音色库为空')
                && document.querySelector('.sd-tts-npc-list').textContent.includes('尚未配置原型') && document.querySelector('.sd-tts-fav-list').textContent.includes('刷新收藏')
                && document.querySelector('.sd-tts-restore-prompt').disabled && calls === 0));
        }
        await page.evaluate(() => renderVoices('doubao', 'legacy-auth'));
        ok(`${family}/${mode} original legacy authentication fields remain isolated`, await page.locator('.sd-tts-app-id,.sd-tts-access-key').count() === 2 && await page.locator('.sd-tts-key').count() === 0);
        await page.evaluate(() => renderVoices('elevenlabs', 'legacy-model'));
        ok(`${family}/${mode} non-v3 Eleven capabilities remain`, await page.locator('.sd-tts-speed,.sd-tts-similarity,.sd-tts-style,.sd-tts-speaker-boost').count() === 4);
        await page.evaluate(() => renderVoices('minimax', 'manual'));
        ok(`${family}/${mode} empty library keeps manual voice IDs`, await page.locator('.sd-tts-vid').inputValue() === 'manual-fixture');
        await page.evaluate(() => renderVoices('minimax', 'disabled'));
        ok(`${family}/${mode} disabled model state remains visible without changing data`, await page.locator('.sd-tts-enabled').getAttribute('aria-pressed') === 'false' && await page.locator('.sd-disabled-card').count() > 5 && await page.evaluate(() => calls === 0));
    }
    await page.evaluate(() => appearance.reset()); assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, scope: 'actual TTS renderers and provider capabilities; no playback, credential access, synthesis or ST business handlers' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
