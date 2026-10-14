// Real source/backstage renderers, with isolated read fixtures and native controls.
// No ST context scan, model call, injection, settings save or library mutation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const names = ['renderActiveTab', 'renderContextTab', 'renderTagRules', 'renderPresetSourcePanel',
    'renderSelectedPresetEntries', 'renderWorldBookSourcePanel', 'renderSelectedWorldBookEntries',
    'renderContextEntry', 'getContextItemId', 'getContextSelectionReviewStore', 'contextSourceNeedsSelectionReview',
    'renderContextSelectionReview', 'getTagRules', 'cleanContextText', 'badge',
    'renderDirectorSettingsTab', 'renderInjectSections', 'renderInjectPreview',
    'renderBackstageBlueprintCard', 'renderBlueprintEditorContent', 'templateLibraryCfg',
    'renderLibrarySection', 'renderLibraryListBody', 'renderLibraryRow'];
const source = names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const checks = [], errors = []; let external = 0;
const ok = (name, value) => { assert.ok(value, name); checks.push(name); };
const qa = new URL('../dist/local-qa/context-backstage/', import.meta.url); await mkdir(qa, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({
        contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>`,
    });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) {
        return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    }
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, { createQianmuAppearanceSession }, { updateAppearancePreferences }, { applyQianmuIcons }, sources, identityView, archiveView] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-appearance-session.js'),
            import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'), import('/qianmu-st-context-sources.js'),
            import('/qianmu-reader-identity-view.js'), import('/qianmu-character-archive-view.js'),
        ]);
        for (const name of ['htmlEscape', 'infoTag', 'uniqueClean', 'isNoisePresetName', 'escapeRegExp', 'groupByFolder', 'estimateTokens']) window[name] = utils[name];
        Object.assign(window, {
            renderCoreadIdentityView: identityView.renderCoreadIdentityView, renderCharacterArchive: archiveView.renderCharacterArchive,
            groupPresetNames: sources.groupPresetNames,
            settings: { theme: 'dark' }, editorView: null, calls: { scan: 0, forbidden: 0 },
            maybeAutoScanContext: () => { calls.scan++; }, getCharacterName: () => '旅人', getPersonaName: () => '观星者',
            getChatStore: () => storyStore, currentPlan: () => storyStore.plan, getChatKey: () => 'isolated-qa', getCurrentPresetName: () => presetName,
            listPresetNames: () => contextScanCache.presetNames, getPresetEntries: name => contextScanCache.presets[name] || [],
            detectBoundWorldBookNames: () => contextScanCache.boundWorldBookNames,
            getSelectedPresetNames: () => fixtureEmpty ? [] : [presetName],
            getSelectedWorldBookNames: () => fixtureEmpty ? [] : [worldName], isWorldBookGlobal: name => name === worldName,
            isPresetItemSelected: (_name, id) => String(id) === '0', isWorldItemSelected: (_name, id) => String(id) === '1',
            DEFAULT_BLUEPRINT: '默认聊天剧本', DEFAULT_SYSTEM_PROMPT: '默认剧组之律', JSON_SCHEMA_TEXT: '{"type":"object"}',
            currentDirectorInjectionText: () => '注入仅为隔离只读夹具\n<img src=x onerror=alert(1)>\n' + '原文保持不变\n'.repeat(90),
            applyQianmuIcons,
        });
        const forbidden = () => { calls.forbidden++; throw Error('Production writes are forbidden'); };
        window.saveSettings = window.saveMetadata = window.applyDirectorInjection = window.generate = forbidden;
        (0, eval)(source);
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings,
            loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }), loadFont: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(document.querySelector('#story-director-modal'));
        window.setAppearance = async (family, mode) => {
            settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
        };
        window.renderFixture = (tab, state = 'populated') => {
            window.activeTab = tab; window.fixtureEmpty = state === 'empty';
            window.presetName = fixtureEmpty ? '' : '【照见】Claude-Versatile-5.1.3 5.5';
            window.worldName = '沿海世界书-' + 'w'.repeat(60); window.lastWorldView = '';
            window.templateSearch = state === 'search-empty' ? '不存在的剧本' : '';
            window.templateExportMode = state === 'export'; window.templateExportSelection = new Set(['t0']);
            const entries = Array.from({ length: 32 }, (_, i) => ({ uid: i, name: '条目' + i + '-' + 'x'.repeat(80), content: '<thinking>应被过滤的内部文本</thinking>' + '海风与叙事线索\n'.repeat(220) }));
            if (state === 'legacy-review') { entries[0].enabled = false; entries[1].disable = true; }
            window.contextScanCache = {
                currentPresetName: presetName, presetNames: fixtureEmpty ? [] : [presetName, '【照见】Claude-Versatile-5.0.9（试吃）', '临海预设-' + 'p'.repeat(60)],
                presetScannedAt: fixtureEmpty ? 0 : 1, worldScannedAt: fixtureEmpty ? 0 : 1,
                boundWorldBookNames: fixtureEmpty ? [] : [worldName], worldBookNames: fixtureEmpty ? [] : [worldName, '另一卷'],
                presets: fixtureEmpty ? {} : { [presetName]: entries }, worldBooks: fixtureEmpty ? {} : { [worldName]: entries },
            };
            Object.assign(settings, {
                contextSourceSelectionReviews: { presets: {}, worldBooks: {} },
                contextOptions: { includeChatHistory: true, contextDepth: 12, tagRules: [{ name: 'thinking', action: 'remove' }] },
                autoRefresh: true, autoRefreshEvery: 10, injectEnabled: state !== 'disabled', injectDepth: 2,
                injectSections: { quests: true, nodes: true, npc: false, world: true }, geopoliticsEnabled: true, worldChatterEnabled: true,
                systemPrompt: '保留用户编排\n'.repeat(90), outputSchemaText: '{"unchanged":true}', systemPromptBackup: '', outputSchemaBackup: '',
                templates: fixtureEmpty ? [] : Array.from({ length: 32 }, (_, i) => ({ id: 't' + i, name: '原剧本' + i, folder: i < 3 ? '旅途' : '' })),
            });
            window.storyStore = { blueprint: '当前剧本草稿\n'.repeat(90), blueprintBackup: '', plan: fixtureEmpty ? null : state === 'legacy-world' ? { unchanged: true, world_updates: [{ title: '原有世界涟漪', content: '保留旧资料' }] } : { unchanged: true } };
            calls.scan = calls.forbidden = 0;
            const body = document.querySelector('.sd-body'); body.innerHTML = renderActiveTab(); applyQianmuIcons(body); body.scrollTop = 0;
        };
        window.readContrast = node => {
            const cv = document.createElement('canvas'); cv.width = cv.height = 1; const ctx = cv.getContext('2d');
            ctx.fillStyle = getComputedStyle(document.querySelector('.sd-window')).getPropertyValue('--qm-bg') || '#181818'; ctx.fillRect(0, 0, 1, 1);
            const parents = []; for (let current = node; current; current = current.parentElement) parents.unshift(current);
            for (const current of parents) { ctx.fillStyle = getComputedStyle(current).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
            const bg = [...ctx.getImageData(0, 0, 1, 1).data]; ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1);
            const fg = [...ctx.getImageData(0, 0, 1, 1).data]; const luminance = c => c.slice(0, 3).reduce((sum, v, i) => { v /= 255; return sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); }, 0);
            return (Math.max(luminance(bg), luminance(fg)) + .05) / (Math.min(luminance(bg), luminance(fg)) + .05);
        };
    }, source);
    for (const [family, mode] of [['classic', 'light'], ['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) for (const tab of ['context', 'settings']) {
            const label = `${family}/${mode}/${width}/${tab}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ({ family, mode, tab }) => { await setAppearance(family, mode); renderFixture(tab); }, { family, mode, tab });
            ok(label + ' actual source or backstage controls remain available', await page.evaluate(tab => tab === 'context'
                ? document.querySelectorAll('.sd-context-item').length === 64 && document.querySelectorAll('.sd-refresh-presets,.sd-refresh-worldbooks').length === 0
                : document.querySelectorAll('.sd-save-blueprint,.sd-save-director-settings,.sd-edit-injection,.sd-lib-import').length === 4 && document.querySelectorAll('.sd-lib-row').length === 32, tab));
            await page.evaluate(tab => {
                if (tab === 'context') {
                    document.querySelectorAll('.sd-dropdown').forEach(node => { node.open = true; });
                    document.querySelectorAll('.sd-entry-scroll').forEach(node => { node.scrollTop = 40; });
                } else {
                    document.querySelectorAll('.sd-plain-fold,.sd-lib-folder').forEach(node => { node.open = true; });
                    document.querySelector('.sd-lib-list').scrollTop = 55;
                    document.querySelector('.sd-inject-term').scrollTop = 65;
                }
            }, tab);
            if (tab === 'context') {
                ok(label + ' the currently used preset belongs to its series and the count is digits only', await page.evaluate(() => {
                    const row = document.querySelector('.sd-pick-preset:checked').closest('.sd-source-row');
                    const group = row.closest('.sd-preset-version-group');
                    return !!group && group.querySelector('summary small').textContent.trim() === '2'
                        && row.textContent.includes('当前使用');
                }));
                ok(label + ' source entries are selectable without content previews', await page.evaluate(() =>
                    document.querySelectorAll('.sd-context-item input[type=checkbox]').length === 64
                    && !document.querySelector('.sd-context-item:is(details),.sd-context-item pre,.sd-context-item summary')));
                ok(label + ' world and preset directory names use the same font size', await page.evaluate(() =>
                    getComputedStyle(document.querySelector('.sd-world-name > span')).fontSize
                    === getComputedStyle(document.querySelector('.sd-pick-preset:checked + span')).fontSize));
                ok(label + ' CHAR and USER tags match the actual character archive label styling', await page.evaluate(() => {
                    const card = document.querySelector('.sd-context-identity-card');
                    const tags = [...card.querySelectorAll('.sd-reader-setup-tag')];
                    const reference = document.createElement('div');
                    reference.style.cssText = `position:absolute;left:-10000px;width:${card.clientWidth}px`;
                    reference.innerHTML = renderCharacterArchive({ rows: [], bindings: [], subjects: [
                        { category: 'char', subjectKey: 'char:qa', name: getCharacterName(), avatar: '' },
                        { category: 'user', subjectKey: 'user:qa', name: getPersonaName(), avatar: '' },
                    ], chatKey: 'isolated-qa', search: '', collapsed: {}, shown: {} }, {
                        identity: (role, name, avatar, icon) => renderCoreadIdentityView({ role, name, avatar, icon }, htmlEscape),
                    });
                    card.parentElement.append(reference);
                    try {
                        const archiveTags = [...reference.querySelectorAll('.sd-reader-setup-tag')];
                        const properties = ['fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderRadius', 'padding', 'letterSpacing'];
                        const signature = node => properties.map(key => getComputedStyle(node)[key]).join('|');
                        return tags.length === 2 && archiveTags.length === 2 && tags.every((tag, i) =>
                            tag.querySelector('em').textContent === ['CHAR', 'USER'][i]
                            && ['', 'em', 'b'].every(selector => signature(selector ? tag.querySelector(selector) : tag)
                                === signature(selector ? archiveTags[i].querySelector(selector) : archiveTags[i])));
                    } finally { reference.remove(); }
                }));
                ok(label + ' long identity names stay in two bounded tags with the full name available', await page.evaluate(() => {
                    const card = document.querySelector('.sd-context-identity-card'), names = [...card.querySelectorAll('.sd-reader-setup-tag b')];
                    const saved = names.map(node => node.textContent);
                    try {
                        names.forEach(node => { node.textContent = '很长的当前身份名字'.repeat(8); });
                        return names.every(node => {
                            const tag = node.parentElement, box = tag.getBoundingClientRect(), host = tag.parentElement.getBoundingClientRect();
                            return node.hasAttribute('title') && getComputedStyle(node).textOverflow === 'ellipsis'
                                && box.left >= host.left - 1 && box.right <= host.right + 1 && tag.scrollWidth <= tag.clientWidth + 1;
                        }) && Math.abs(names[0].parentElement.getBoundingClientRect().top - names[1].parentElement.getBoundingClientRect().top) < 1;
                    } finally { names.forEach((node, i) => { node.textContent = saved[i]; }); }
                }));
                if (width === 320 || width === 393) await page.locator('.sd-context-identity-card').screenshot({
                    animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-identity-${width}.png`, qa)),
                });
            } else {
                ok(label + ' refresh and injection rows share a regular-weight action font', await page.evaluate(() => {
                    const labels = [...document.querySelectorAll('.sd-settings-refresh-row :is(.checkbox_label,.sd-floor-refresh)')];
                    return labels.length === 4 && labels.every(node => {
                        const s = getComputedStyle(node); return s.fontSize === '12px' && s.fontWeight === '400';
                    });
                }));
                ok(label + ' current script is one step smaller than the screenwriter heading', await page.evaluate(() =>
                    parseFloat(getComputedStyle(document.querySelector('.sd-backstage-blueprint > summary > b')).fontSize)
                    - parseFloat(getComputedStyle(document.querySelector('.sd-backstage-blueprint-body > .sd-field-head h3')).fontSize) === 1));
            }
            if (tab === 'settings') {
                ok(label + ' current plans omit the retired world scope without hiding the two real sources',
                    await page.locator('.sd-inject-section-toggle[data-key=world]').count() === 0
                    && await page.locator('.sd-inject-section-toggle[data-key=nodes],.sd-inject-section-toggle[data-key=geopolitics]').count() === 2);
                const scopeRow = await page.evaluate(() => {
                    const grid = document.querySelector('.sd-inject-section-grid');
                    const spans = [...grid.querySelectorAll('.sd-option-chip > span')];
                    const bounds = spans.map(node => node.closest('label').getBoundingClientRect());
                    return { labels: spans.map(node => node.textContent).join('/'),
                        fonts: spans.map(node => getComputedStyle(node).fontSize),
                        tops: bounds.map(rect => rect.top), widths: bounds.map(rect => rect.width),
                        scrollWidth: grid.scrollWidth, clientWidth: grid.clientWidth };
                });
                ok(label + ' five compact scope labels stay on one complete row without overflow: ' + JSON.stringify(scopeRow),
                    scopeRow.labels === '预演/涟漪/动向/关系/世界'
                    && scopeRow.fonts.every(size => size === '12px')
                    && scopeRow.tops.every(top => Math.abs(top - scopeRow.tops[0]) < 1)
                    && scopeRow.scrollWidth <= scopeRow.clientWidth + 1);
                ok(label + ' all derivative controls use regular weight', await page.locator('.sd-derivative-options .sd-option-chip > span')
                    .evaluateAll(nodes => nodes.length === 4 && nodes.every(node => getComputedStyle(node).fontWeight === '400')));
                for (const selector of ['.sd-inject-section', '.sd-derivative-options .sd-option-chip']) {
                    const chip = page.locator(selector).first();
                    const readState = () => chip.evaluate(node => {
                        const style = getComputedStyle(node);
                        return { checked: node.querySelector('input').checked, background: style.backgroundColor,
                            color: style.color, border: style.borderColor, contrast: readContrast(node) };
                    });
                    const settle = () => chip.evaluate(node => {
                        getComputedStyle(node).backgroundColor;
                        return Promise.all(node.getAnimations().map(animation => animation.finished));
                    });
                    await chip.evaluate(node => { node.querySelector('input').checked = false; });
                    await settle();
                    const off = await readState();
                    await chip.click();
                    // Inspect the settled style rather than an intermediate transition frame.
                    await settle();
                    const on = await readState();
                    ok(label + selector + ' checked state has visible fill and readable text',
                        !off.checked && on.checked && off.background !== on.background && on.contrast >= 4.5 && off.contrast >= 4.5);
                    await chip.locator('input').focus();
                    ok(label + selector + ' keyboard focus remains visible', await chip.evaluate(node => {
                        const style = getComputedStyle(node); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
                    }));
                    await page.keyboard.press('Space');
                    await settle();
                    const restored = await readState();
                    ok(label + selector + ' keyboard toggle restores unselected appearance: ' + JSON.stringify({ off, restored }),
                        !restored.checked && restored.background === off.background && restored.color === off.color && restored.border === off.border);
                }
            }
            const edit = page.locator(tab === 'context' ? '.sd-tag-rule-name' : '.sd-blueprint');
            await edit.fill('保留尚未保存的用户编辑\n'.repeat(tab === 'context' ? 1 : 60));
            await edit.evaluate(node => { node.focus(); node.setSelectionRange(3, 8); node.scrollTop = 65; });
            const stable = await page.evaluate(async ({ family, mode, tab }) => {
                const body = document.querySelector('.sd-body'), edit = document.activeElement;
                const checkbox = body.querySelector('input[type=checkbox]'); checkbox.checked = !checkbox.checked;
                body.scrollTop = 75;
                const all = [...body.querySelectorAll('*')], html = body.innerHTML, value = edit.value;
                const positions = [body, ...body.querySelectorAll('.sd-scroll,pre,textarea')].map(node => [node, node.scrollTop]);
                const controls = [...body.querySelectorAll('input,select,textarea')].map(node => [node, node.value, node.checked]);
                const saved = JSON.stringify([storyStore, contextScanCache, calls, settings.contextOptions, settings.templates]);
                await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light');
                await setAppearance(family, mode);
                return { dom: body.innerHTML === html && all.every(node => node.isConnected), draft: edit.value === value,
                    selection: edit.selectionStart === 3 && edit.selectionEnd === 8, focus: document.activeElement === edit,
                    controls: controls.every(([node, value, checked]) => node.value === value && node.checked === checked),
                    exercisedNestedScroll: positions.filter(([, top]) => top > 0).length >= (tab === 'context' ? 2 : 3),
                    scroll: positions.every(([node, top]) => Math.abs(node.scrollTop - top) < 1),
                    state: saved === JSON.stringify([storyStore, contextScanCache, calls, settings.contextOptions, settings.templates]), tab: activeTab === tab };
            }, { family, mode, tab });
            ok(label + ' hot swap preserves draft, native state, nested scroll and read owner: ' + JSON.stringify(stable), Object.values(stable).every(Boolean));
            ok(label + ' private entry bodies are not rendered and injected text stays escaped', await page.evaluate(tab => !document.querySelector('.sd-body img') && (tab !== 'context' || !document.querySelector('.sd-body').textContent.includes('应被过滤')), tab));
            if (family !== 'classic') {
                const overflow = await page.locator(tab === 'context' ? '.sd-dropdown-head,.sd-context-entry-label > span' : '.sd-backstage-blueprint-body,.sd-director-law-body').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ className: node.className, scroll: node.scrollWidth, width: node.clientWidth })).filter(node => node.scroll > node.width + 1));
                ok(label + ' inner content fits narrow cards: ' + JSON.stringify(overflow.slice(0, 3)), overflow.length === 0);
                const surface = page.locator(tab === 'context' ? '.sd-context-source-pick .sd-dropdown' : '.sd-backstage-blueprint-library .sd-lib-folder').first();
                ok(label + ' nested source surfaces follow family corners', await surface.evaluate((node, family) => getComputedStyle(node).borderTopLeftRadius === (family === 'glass' ? '22px' : '0px'), family));
                const scrolls = page.locator(tab === 'context' ? '.sd-entry-scroll' : '.sd-lib-list,.sd-inject-term');
                ok(label + ' nested scroll stays available without a visible scrollbar', await scrolls.evaluateAll(nodes => nodes.every(node => getComputedStyle(node).scrollbarWidth === 'none')));
                ok(label + ' source/terminal text remains readable', await page.locator(tab === 'context' ? '.sd-context-entry-label > span' : '.sd-inject-term').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => readContrast(node) >= 4.5)));
                if (tab === 'settings') {
                    ok(label + ' template names and row actions remain visible', await page.locator('.sd-lib-row h4,.sd-lib-row .sd-lib-edit,.sd-lib-row .sd-lib-delete').evaluateAll(nodes => nodes.length === 96 && nodes.every(node => {
                        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
                        return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && Number(style.opacity) > .9 && readContrast(node) >= 3;
                    })));
                }
            }
            if (width === 393 && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                await page.locator(tab === 'context' ? '[data-acc=acc-presets]' : '.sd-backstage-blueprint-card').scrollIntoViewIfNeeded();
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                await page.screenshot({ caret: 'initial', animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-${tab}-393.png`, qa)) });
            }
            if ((width === 320 || width === 393) && tab === 'settings') {
                await page.locator('.sd-injection-card').scrollIntoViewIfNeeded();
                await page.locator('.sd-injection-card').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-injection-${width}.png`, qa)) });
                await page.locator('.sd-derivative-card').screenshot({ animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-derivatives-${width}.png`, qa)) });
            }
            if (tab === 'settings') {
                await page.evaluate(() => { renderFixture('settings', 'legacy-world'); document.querySelector('[data-acc="inject-sections"]').open = true; });
                ok(label + ' old world material retains its sixth independent control on one scrollable row', await page.evaluate(() => {
                    const grid = document.querySelector('.sd-inject-section-grid');
                    const chips = [...grid.querySelectorAll('.sd-option-chip')];
                    const top = chips[0].getBoundingClientRect().top;
                    return chips.length === 6 && !!grid.querySelector('[data-key="world"]')
                        && getComputedStyle(grid).overflowX === 'auto'
                        && chips.every(node => Math.abs(node.getBoundingClientRect().top - top) < 1);
                }));
                if (width === 320) ok(label + ' overflow remains reachable by horizontal scrolling', await page.evaluate(() => {
                    const grid = document.querySelector('.sd-inject-section-grid');
                    grid.scrollLeft = grid.scrollWidth;
                    return grid.scrollWidth > grid.clientWidth && grid.scrollLeft > 0;
                }));
                const legacy = page.locator('.sd-inject-section-toggle[data-key=world]');
                const before = await legacy.isChecked();
                await legacy.focus();
                await page.keyboard.press('Space');
                ok(label + ' old world control remains keyboard toggleable', await legacy.isChecked() !== before);
                await legacy.locator('..').click();
                ok(label + ' old world label remains clickable', await legacy.isChecked() === before);
            }
            if (tab === 'context') {
                await page.evaluate(() => renderFixture('context', 'legacy-review'));
                ok(label + ' legacy selection review stays inside the existing two entry groups', await page.locator('.sd-context-block > .sd-button-row .sd-confirm-context-selection').count() === 2);
                ok(label + ' legacy review actions fit the card without a new popup', await page.locator('.sd-confirm-context-selection').evaluateAll(nodes => nodes.every(node => {
                    const bounds = node.getBoundingClientRect(), card = node.closest('.sd-context-block').getBoundingClientRect();
                    return bounds.width > 0 && bounds.left >= card.left && bounds.right <= card.right + 1;
                })));
            }
            await page.evaluate(tab => renderFixture(tab, 'empty'), tab);
            ok(label + ' confirmed empty state preserves original guidance and disabled recovery', await page.evaluate(tab => tab === 'context'
                ? document.querySelector('.sd-body').textContent.includes('未读取到预设') && document.querySelector('.sd-body').textContent.includes('未读取到世界书')
                : !document.querySelector('[data-acc="inject-preview"]') && !document.querySelector('.sd-lib-empty') && document.querySelector('.sd-restore-blueprint').disabled && document.querySelector('.sd-restore-system').disabled, tab));
            ok(label + ' theme never performs a source scan or write', await page.evaluate(tab => calls.forbidden === 0 && calls.scan === (tab === 'context' ? 1 : 0), tab));
        }
    }
    await page.evaluate(() => renderFixture('settings', 'disabled'));
    ok('disabled injection does not render an empty preview card', await page.locator('.sd-inject-term,[data-acc="inject-preview"]').count() === 0);
    await page.evaluate(() => renderFixture('settings', 'export'));
    ok('original template export selection and controls remain present', await page.locator('.sd-lib-select:checked').count() === 1 && await page.locator('.sd-lib-confirm-export,.sd-lib-cancel-export').count() === 2);
    await page.evaluate(() => renderFixture('settings', 'search-empty'));
    ok('original template search-empty guidance is retained', await page.locator('.sd-lib-list').textContent().then(text => text.includes('没有匹配的条目')));
    await page.evaluate(() => appearance.reset());
    assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, scope: 'actual source/backstage renderers; native state only; scans and ST write handlers excluded' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
