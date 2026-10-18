// Isolated production FontFace/controller proof. Every font URL is intercepted;
// only local Arial/Times originals are used, never a real ST account or network.
// Default: current implementation, no historical Git dependency.
// --compare-v471: additionally read the exact v471 source and prove its rejection.
// --compat-only: skip reveal/toast flow checks, for the v472 compatibility base.
// --expect-delayed-reveal: reproduce the old v472 wait; not a passing v473 mode.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const compareV471 = process.argv.includes('--compare-v471'), compatOnly = process.argv.includes('--compat-only'), delayedExpected = process.argv.includes('--expect-delayed-reveal');
if (compatOnly && delayedExpected) throw new Error('--compat-only skips flow checks and cannot be combined with --expect-delayed-reveal');
const bytes = await readFile(process.env.QIANMU_FONT_FIXTURE || 'C:/Windows/Fonts/arial.ttf');
const secondBytes = await readFile(process.env.QIANMU_SECOND_FONT_FIXTURE || 'C:/Windows/Fonts/times.ttf');
assert.ok(!bytes.equals(secondBytes));
const fragments = Array.from({ length: 672 }, (_, index) => ({
    urls: [{ url: `https://fonts.test/fragments/${index}.ttf`, format: 'truetype' }], weight: '200 900', style: 'normal',
    unicodeRange: index === 0 ? 'U+0041-004D' : index === 1 ? 'U+004E-005A' : `U+${(0xe000 + index).toString(16)}`,
}));
const declaration = face => `@font-face{font-family:"Fixture 672";src:url("${face.urls[0].url}") format("truetype");font-weight:${face.weight};font-style:normal;unicode-range:${face.unicodeRange}}`;
const css = fragments.map(declaration).join('\n');
const checks = [], evidence = { historicalGitComparison: compareV471 };
if (compareV471) {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const baseline = execFileSync('git', ['-c', `safe.directory=${repo.replaceAll('\\', '/').replace(/\/$/, '')}`, 'show', '2b3c7ae199bfea8b2ab05687a0d5d81a0c0665c4:qianmu-font-sources.js'], { cwd: repo, encoding: 'utf8' });
    const oldSources = await import(`data:text/javascript;base64,${Buffer.from(baseline).toString('base64')}`);
    assert.equal(oldSources.FONT_SOURCE_LIMITS.faces, 512);
    assert.throws(() => oldSources.parseFontStylesheet(css), /分片/);
    assert.throws(() => oldSources.validateFontRecord({ name: 'Fixture 672', source: { kind: 'web', input: 'https://fonts.test/672.css' }, faces: fragments }), /分片/);
    checks.push('The exact v471 Git snapshot rejects 672 CSS declarations and 672-face records; it is not a compatible rollback target for newly accepted data');
    Object.assign(evidence, { baselineCommit: '2b3c7ae199bfea8b2ab05687a0d5d81a0c0665c4', baselineFaceLimit: 512 });
}
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 850 }, serviceWorkers: 'block' });
const errors = [], unexpected = [], requests = [], holds = new Map();
const qa = new URL('../dist/local-qa/font-library/', import.meta.url); await mkdir(qa, { recursive: true });
const deadline = setTimeout(() => { void browser.close(); }, 90000);
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
await context.route('**/*', async route => {
    const url = new URL(route.request().url()), cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>' });
    if (url.origin === 'https://qianmu.test' && /^(?:\/style\.css|\/qianmu-[a-z0-9-]+\.(?:js|css))$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    if (url.origin === 'https://fonts.test') {
        requests.push(url.pathname);
        const gate = holds.get(url.pathname); if (gate) { gate.entered = true; await gate.promise; }
        if (url.pathname === '/672.css') return route.fulfill({ headers: cors, contentType: 'text/css', body: css + '\n' + fragments.slice(0, 8).map(declaration).join('\n') });
        if (url.pathname === '/failed.css') return route.fulfill({ status: 503, headers: cors, contentType: 'text/css', body: '' });
        if (url.pathname === '/notice-failed.ttf') return route.fulfill({ status: 404, headers: cors, contentType: 'font/ttf', body: '' });
        if (url.pathname.endsWith('.ttf')) return route.fulfill({ headers: cors, contentType: 'font/ttf', body: url.pathname === '/fragments/1.ttf' ? secondBytes : bytes });
    }
    unexpected.push(route.request().url()); return route.abort();
});
function hold(path) { let release; const gate = { entered: false, promise: new Promise(resolve => { release = resolve; }) }; gate.release = () => { release(); holds.delete(path); }; holds.set(path, gate); return gate; }
async function mount(page, records = []) {
    await page.goto('https://qianmu.test/');
    for (const file of ['style.css', 'qianmu-font-library.css']) await page.addStyleTag({ content: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    await page.addStyleTag({ content: 'body{margin:0;font:18px Georgia,serif}#story-director-floor-nav{inset:0;width:100vw;height:100dvh}#host-button,#host-prose{font-family:Georgia,serif!important}' });
    await page.evaluate(async records => {
        const { createFontLibrary } = await import('./qianmu-font-library.js');
        const { createFontLibraryView } = await import('./qianmu-font-library-view.js');
        const { normalizeFontLibrary } = await import('./qianmu-font-library-state.js');
        document.body.innerHTML = '<button id="host-button">AMNZ</button><div id="chat"><div class="mes"><div class="mes_text"><p id="host-prose">AMNZ</p></div></div></div><div id="story-director-floor-nav" class="sd-theme-light"><div class="sd-floor-shell"><section class="sd-floor-panel"><button data-font-library>字体库</button><small data-font-library-summary></small></section></div></div>';
        window.events = []; window.localBytes = new Map(); window.downloads = []; window.notices = []; window.saves = 0; window.failSave = false;
        window.owner = { fontLibrary: normalizeFontLibrary({ version: 1, previewText: 'AMNZ', fonts: records }) };
        window.note = (type, extra = {}) => events.push({ type, at: performance.now(), ...extra });
        window.createLibrary = () => createFontLibrary({ getOwner: () => owner, resolveNamespace: async () => 'st-user:synthetic-fragment-browser', isCurrent: () => true,
            document, save: () => { if (failSave) throw new Error('Synthetic save rejected'); saves++; note('save', { ids: owner.fontLibrary.fonts.map(font => font.id) }); },
            localStoreFactory: () => ({ get: async id => localBytes.get(id), put: async (id, data, type) => { localBytes.set(id, new Blob([data], { type })); }, delete: async ids => { ids.forEach(id => localBytes.delete(id)); }, dispose() {} }),
            download: async (blob, name) => downloads.push({ text: await blob.text(), name }), confirm: async () => true,
            notify: (message, level) => notices.push({ message, level, at: performance.now(), families: ['host-prose', 'host-button'].map(id => getComputedStyle(document.getElementById(id)).fontFamily) }),
            viewFactory: options => {
                const wrapped = { ...options, onAction: async action => { note('action-start', { action: action.type }); try { const result = await options.onAction(action); note('action-resolved', { action: action.type }); return result; } catch (error) { note('action-rejected', { action: action.type }); throw error; } },
                    onVisibleFonts: (ids, choices) => { note('visible', { ids }); return options.onVisibleFonts(ids, choices); } };
                const view = createFontLibraryView(wrapped);
                const watcher = new MutationObserver(records => { for (const record of records) {
                    if (record.type === 'attributes' && record.attributeName === 'data-font-revealed') note('reveal', { id: record.target.dataset.fontId });
                    if (record.type === 'childList' && record.target === options.root) note('full-render');
                } });
                watcher.observe(options.root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-font-revealed'] });
                const destroy = view.destroy; view.destroy = () => { watcher.disconnect(); destroy(); };
                return view;
            } });
        window.library = createLibrary(); library.attach(document.getElementById('story-director-floor-nav'));
    }, records);
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-preview]').waitFor();
}
const settle = page => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
const openAdd = async page => { if (!await page.locator('.qm-font-add').evaluate(node => node.open)) await page.locator('.qm-font-add>summary').click(); };
const addWeb = async (page, name, source) => { await openAdd(page); await page.locator('[data-font-web-name]').fill(name); await page.locator('[data-font-web-source]').fill(source); await page.locator('[data-font-action="add-web"]').click(); };
const metadata = record => { const { id, ...rest } = record; return rest; };
let page;
try {
    page = await context.newPage(); await mount(page);
    await page.locator('[data-font-file="local"]').setInputFiles({ name: 'Retained Original.ttf', mimeType: 'font/ttf', buffer: bytes });
    await page.locator('[data-font-local-name="0"]').fill('已有本地原件'); await page.locator('[data-font-local-tags="0"]').fill('保全');
    await page.locator('[data-font-action="local-confirm"]').click(); await settle(page);
    const localId = await page.evaluate(() => owner.fontLibrary.fonts[0].id);
    await page.locator(`[data-font-apply="${localId}"]`).selectOption('body'); await settle(page);
    await page.evaluate(async id => { await library.action('set-font-pinned', { id, pinned: true }); await library.action('set-sort-order', { order: 'desc' }); }, localId);
    const existing = await page.evaluate(() => owner.fontLibrary);
    await addWeb(page, '672 分片样本', 'https://fonts.test/672.css'); await settle(page);
    const state = await page.evaluate(() => owner.fontLibrary), segmented = state.fonts.find(font => font.name === '672 分片样本'), segmentedId = segmented.id;
    assert.deepEqual(segmented.faces, fragments, 'All 672 unicode/weight/source descriptors remain exact, including the final fragment; repeated declarations are deduplicated');
    assert.deepEqual(state.fonts.find(font => font.id === localId), existing.fonts[0]);
    for (const key of ['enabled', 'mode', 'body', 'st', 'shared', 'pinnedIds', 'sortOrder']) assert.deepEqual(state[key], existing[key], `${key} remains unchanged on adding a multi-fragment font`);
    checks.push('672 distinct 200–900 faces plus eight duplicate declarations resolve without truncation, while existing local data and application/management choices remain intact');
    const sample = page.locator(`[data-font-sample="${segmentedId}"]`);
    await page.waitForFunction(id => { const node = document.querySelector(`[data-font-sample="${id}"]`), family = getComputedStyle(node).fontFamily.split(',')[0]; return document.fonts.check(`400 24px ${family}`, 'AMNZ') && [...document.fonts].filter(face => face.family === family.replaceAll('"', '') && face.status === 'loaded').length === 2; }, segmentedId);
    const fontProof = await sample.evaluate(async node => {
        const family = getComputedStyle(node).fontFamily.split(',')[0].replaceAll('"', ''), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        const measure = (font, value) => { context.font = `400 48px "${font}"`; return context.measureText(value).width; };
        const refs = [new FontFace('FixtureReferenceArial', 'url("https://fonts.test/fragments/0.ttf")'), new FontFace('FixtureReferenceTimes', 'url("https://fonts.test/fragments/1.ttf")')];
        await Promise.all(refs.map(face => face.load())); refs.forEach(face => document.fonts.add(face));
        const measured = { family, registered: [...document.fonts].filter(face => face.family === family).length, loaded: [...document.fonts].filter(face => face.family === family && face.status === 'loaded').map(face => face.unicodeRange),
            ai: measure(family, 'AI'), aiArial: measure('FixtureReferenceArial', 'AI'), aiTimes: measure('FixtureReferenceTimes', 'AI'), rs: measure(family, 'RS'), rsArial: measure('FixtureReferenceArial', 'RS'), rsTimes: measure('FixtureReferenceTimes', 'RS') };
        refs.forEach(face => document.fonts.delete(face)); return measured;
    });
    assert.equal(fontProof.registered, 672); assert.equal(fontProof.loaded.length, 2);
    assert.equal(fontProof.ai, fontProof.aiArial); assert.notEqual(fontProof.ai, fontProof.aiTimes);
    assert.equal(fontProof.rs, fontProof.rsTimes); assert.notEqual(fontProof.rs, fontProof.rsArial);
    evidence.fontProof = fontProof;
    checks.push('Real FontFace selection registers 672 faces but loads only two used character domains, with independent Arial/Times glyph metrics proving both domains render correctly');
    const beforeTargets = await page.evaluate(() => ({ bodySize: getComputedStyle(document.getElementById('host-prose')).fontSize, stSize: getComputedStyle(document.getElementById('host-button')).fontSize }));
    for (const target of ['body', 'st', 'shared']) {
        await page.locator(`[data-font-apply="${segmentedId}"]`).selectOption(target); await settle(page);
        await page.waitForFunction(({ target, family }) => (target === 'st' ? ['host-button'] : target === 'body' ? ['host-prose'] : ['host-prose', 'host-button']).every(id => getComputedStyle(document.getElementById(id)).fontFamily.includes(family)), { target, family: fontProof.family });
    }
    for (const weight of ['200', '900']) {
        await page.locator(`[data-font-action="more"][data-font-id="${segmentedId}"]`).click();
        await page.locator(`[data-font-action="weight"][data-font-id="${segmentedId}"]`).click();
        await page.locator(`[data-font-weight="${segmentedId}"]`).fill(weight);
        await page.locator(`[data-font-weight="${segmentedId}"]`).dispatchEvent('change');
        assert.equal(await sample.evaluate(node => getComputedStyle(node).fontWeight), weight);
        await page.locator(`[data-font-action="more"][data-font-id="${segmentedId}"]`).click();
        await page.locator(`[data-font-apply="${segmentedId}"]`).selectOption('shared'); await settle(page);
        await page.waitForFunction(weight => ['host-prose', 'host-button'].every(id => getComputedStyle(document.getElementById(id)).fontWeight === weight), weight);
    }
    assert.deepEqual(await page.evaluate(() => ({ bodySize: getComputedStyle(document.getElementById('host-prose')).fontSize, stSize: getComputedStyle(document.getElementById('host-button')).fontSize })), beforeTargets);
    assert.deepEqual([...new Set(requests.filter(path => path.startsWith('/fragments/')))].sort(), ['/fragments/0.ttf', '/fragments/1.ttf']);
    evidence.requestedFragmentUrls = [...new Set(requests.filter(path => path.startsWith('/fragments/')))];
    evidence.variableInterpolationTested = false;
    checks.push('Preview/body/ST/shared use the segmented font at range endpoints 200 and 900 without changing sizes or fetching the other 670 domains; static fixture bytes do not claim variable interpolation');
    const beforePack = await page.evaluate(() => owner.fontLibrary);
    await page.evaluate(async () => library.action('export', { ids: owner.fontLibrary.fonts.map(font => font.id) }));
    await page.waitForFunction(() => downloads.length > 0);
    const packed = await page.evaluate(() => downloads.at(-1).text), parsed = JSON.parse(packed);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforePack, 'Export does not rewrite active choices or metadata');
    assert.equal(parsed.fonts.find(font => font.source.kind === 'web').faces.length, 672);
    const originalLocalBytes = await page.evaluate(async id => [...new Uint8Array(await localBytes.get(id).arrayBuffer())], localId);
    assert.deepEqual(Buffer.from(originalLocalBytes), bytes);
    await page.evaluate(async packed => library.action('import', { file: new File([packed], 'same-library.json', { type: 'application/json' }) }), packed);
    assert.deepEqual(await page.evaluate(() => owner.fontLibrary), beforePack, 'Importing the same multi-fragment/local package cannot disturb existing pins, sort or active assignments');
    await page.evaluate(async () => { library.dispose(); localBytes = new Map(); owner = { fontLibrary: { version: 1, fonts: [], previewText: 'Receiving draft', pinnedIds: [], sortOrder: 'asc' } }; library = createLibrary(); library.attach(document.getElementById('story-director-floor-nav')); });
    await page.locator('[data-font-library]').click(); await page.locator('[data-font-file="import"]').setInputFiles({ name: '672-roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(packed) }); await settle(page);
    const afterImport = await page.evaluate(() => owner.fontLibrary);
    assert.deepEqual(afterImport.fonts.map(metadata).sort((a, b) => a.name.localeCompare(b.name)), beforePack.fonts.map(metadata).sort((a, b) => a.name.localeCompare(b.name)));
    const importedLocal = afterImport.fonts.find(font => font.source.kind === 'local');
    assert.deepEqual(Buffer.from(await page.evaluate(async id => [...new Uint8Array(await localBytes.get(id).arrayBuffer())], importedLocal.id)), bytes);
    assert.deepEqual(afterImport.pinnedIds, []); assert.equal(afterImport.sortOrder, 'asc');
    assert.equal(afterImport.body.enabled, false); assert.equal(afterImport.st.enabled, false); assert.equal(afterImport.shared.enabled, false);
    checks.push('A 672-face Web record and a local original round-trip through one real package without losing any descriptor or original byte, importing no active choices or management preferences');
    await page.screenshot({ path: fileURLToPath(new URL('segmented-672.png', qa)) });
    await page.close();
    if (!compatOnly) {
        const heldPath = '/old-page-held.ttf', gate = hold(heldPath);
        const longRecords = Array.from({ length: 100 }, (_, index) => ({ id: `old_${index}`, name: `Old ${String(index).padStart(3, '0')}`, tags: ['existing'], source: { kind: 'web', input: `https://fonts.test${heldPath}` }, faces: [{ urls: [{ url: `https://fonts.test${heldPath}` }], weight: '400', style: 'normal' }] }));
        page = await context.newPage(); const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await mount(page, longRecords); await page.waitForFunction(() => document.querySelectorAll('.qm-font-card').length === 10);
        assert.equal(gate.entered, true, 'The old page actually has a deferred font response, rather than a simulated delayed UI promise');
        const initial = await page.evaluate(() => owner.fontLibrary);
        await page.evaluate(() => { events.length = 0; });
        await addWeb(page, 'ZZZ Saved target', 'https://fonts.test/new-reveal.ttf');
        await page.waitForFunction(() => owner.fontLibrary.fonts.some(font => font.name === 'ZZZ Saved target'));
        const newId = await page.evaluate(() => owner.fontLibrary.fonts.find(font => font.name === 'ZZZ Saved target').id);
        if (delayedExpected) {
            await page.waitForTimeout(350);
            assert.equal(await page.locator(`[data-font-id="${newId}"][data-font-revealed="true"]`).count(), 0);
            assert.equal(await page.locator('[aria-busy="true"]').count(), 1);
            gate.release(); await settle(page);
        } else {
            await page.locator(`[data-font-id="${newId}"][data-font-revealed="true"]`).waitFor({ timeout: 2500 });
            assert.equal(holds.has(heldPath), true, 'Saved entry is revealed while the old page response is still deliberately blocked');
            await settle(page); gate.release();
        }
        await page.locator(`[data-font-id="${newId}"][data-font-revealed="true"]`).waitFor();
        const log = await page.evaluate(() => events), saved = log.find(event => event.type === 'save'), reveal = log.find(event => event.type === 'reveal' && event.id === newId);
        assert.ok(saved && reveal && reveal.at >= saved.at);
        evidence.revealFlow = { oldPageResponseBlocked: true, deliberatelyDelayedBaseline: delayedExpected, cpuThrottle: 4, recordsBeforeAdd: 100, savedToRevealMs: Math.round(reveal.at - saved.at), fullRendersAfterSave: log.filter(event => event.type === 'full-render' && event.at >= saved.at).length, visibleCallbacksAfterSave: log.filter(event => event.type === 'visible' && event.at >= saved.at).length };
        if (!delayedExpected) assert.ok(evidence.revealFlow.fullRendersAfterSave <= 1, 'A saved addition rebuilds the window once, not once before synchronization and again on reveal');
        assert.deepEqual(await page.evaluate(() => owner.fontLibrary.fonts.filter(font => font.name !== 'ZZZ Saved target')), initial.fonts);
        const visibleBeforeFailure = await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId));
        await addWeb(page, 'Failed addition', 'https://fonts.test/failed.css'); await settle(page);
        assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), visibleBeforeFailure);
        await page.evaluate(() => { failSave = true; });
        await addWeb(page, 'Save rejected', 'https://fonts.test/rejected.ttf'); await settle(page);
        assert.equal(await page.evaluate(() => owner.fontLibrary.fonts.some(font => font.name === 'Save rejected')), false);
        assert.deepEqual(await page.locator('.qm-font-card').evaluateAll(nodes => nodes.map(node => node.dataset.fontId)), visibleBeforeFailure);
        checks.push(delayedExpected ? 'The compatibility-only old flow reproduces saved-then-blocked reveal until the old page font response is released' : 'On a 100-record library with 4x CPU throttling, save reveals the new sorted page before a blocked old-page font finishes, with one rebuild and no jump on parse/save failure');
        await page.evaluate(() => { failSave = false; });
        const leaveGate = hold('/leaving.ttf'); await addWeb(page, 'ZZZ Leaving', 'https://fonts.test/leaving.ttf');
        await page.waitForFunction(() => owner.fontLibrary.fonts.some(font => font.name === 'ZZZ Leaving'));
        await page.locator('[data-font-action="back"]').click();
        assert.equal(await page.locator('.qm-font-window').count(), 0); leaveGate.release(); await page.waitForTimeout(100);
        assert.equal(await page.locator('.qm-font-window').count(), 0, 'Late font completion cannot reopen a departed library or scroll the floor tools');
        checks.push('Leaving during loading never recreates the font window after the late response');
        await cdp.detach();
        await page.close();
        if (!delayedExpected) {
            for (const scenario of ['reentrant', 'leave', 'account', 'failed']) {
                page = await context.newPage(); await mount(page);
                const path = `/notice-${scenario}.ttf`, noticeGate = scenario === 'failed' ? null : hold(path);
                await addWeb(page, `Notice ${scenario}`, `https://fonts.test${path}`); await settle(page);
                const id = await page.evaluate(() => owner.fontLibrary.fonts[0].id);
                await page.locator(`[data-font-apply="${id}"]`).selectOption('shared'); await settle(page);
                assert.equal(await page.evaluate(() => notices.filter(notice => notice.level === 'success').length), 0, `${scenario}: committing an assignment is not font-application success`);
                if (scenario === 'reentrant') {
                    await page.evaluate(() => { void library.sync(); void library.sync(); });
                    noticeGate.release();
                    await page.waitForFunction(() => notices.filter(notice => notice.level === 'success').length === 1);
                    const success = await page.evaluate(() => notices.filter(notice => notice.level === 'success'));
                    assert.equal(success[0].message, '字体已应用于全部');
                    assert.ok(success[0].families.every(family => family.includes('QianmuFont_')));
                    assert.equal(success[0].families[0], success[0].families[1], 'Both scopes are painted before the shared success notice');
                    await page.evaluate(async () => { await library.sync(); await library.sync(); });
                    assert.equal(await page.evaluate(() => notices.filter(notice => notice.level === 'success').length), 1, 'Earlier and later sync completions cannot duplicate the one application notice');
                } else {
                    if (scenario === 'leave') await page.locator('[data-font-action="back"]').click();
                    if (scenario === 'account') await page.evaluate(async () => { owner = { fontLibrary: { version: 1, fonts: [] } }; await library.sync(); });
                    noticeGate?.release(); await page.evaluate(async () => library.sync());
                    assert.equal(await page.evaluate(() => notices.filter(notice => notice.level === 'success').length), 0, `${scenario}: a failed, departed or previous-account application never reports late success`);
                    if (scenario === 'failed') assert.deepEqual(await page.evaluate(() => notices.map(({ message, level }) => ({ message, level }))), [{ message: '字体应用未完成，请检查来源或字重', level: 'warning' }], 'A current failed application reports one concise warning, never success or repeated preview notices');
                    if (scenario !== 'failed') assert.equal(await page.locator('.qm-font-window').count(), 0);
                }
                await page.close();
            }
            checks.push('Real deferred FontFace application reports one shared success only after both scopes paint; failed loads, departure, account changes and obsolete/repeated syncs never produce premature or duplicate success');
        }
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: checks.length, checks, evidence, errors, unexpected, actualFontFace: true, realST: false, externalFontRequests: false }));
} catch (error) {
    await page?.screenshot({ path: fileURLToPath(new URL('fragments-failure.png', qa)) }).catch(() => {}); throw error;
} finally { clearTimeout(deadline); for (const gate of holds.values()) gate.release(); await browser.close(); }
