import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFontLibraryView, renderFontLibrary, renderFontLibraryCards, selectFontLibraryPage, FONT_LIBRARY_PAGE_SIZE } from '../qianmu-font-library-view.js';

const entry = (id = 'one', patch = {}) => ({ id, name: `字体 ${id}`, sourceType: 'web', folder: '', tags: [], weights: ['400', '700'], styles: ['normal', 'italic'], ...patch });
const state = (patch = {}) => ({ entries: [entry()], mode: 'separate', previewText: '山海相逢 ABC 123', body: { enabled: false, fontId: '' }, st: { enabled: false, fontId: '' }, shared: { enabled: false, fontId: '' }, ...patch });
const flush = async () => { for (let count = 0; count < 4; count++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(initial = state(), action = () => {}) {
    const handlers = new Map(), samples = [], statuses = [], queries = new Map(), calls = [], visible = [], attributes = new Map();
    let html = '', current = structuredClone(initial);
    function node(selector, fields = {}) {
        const item = { value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {}, style: {}, classList: { toggle() {} }, matches: candidate => candidate === selector, closest: candidate => candidate === '[data-font-action]' && selector === '[data-font-action]' ? item : null, ...fields };
        queries.set(selector, item); return item;
    }
    node('.qm-font-status'); node('[data-font-selection-count]'); node('[data-font-select-page]'); node('[data-font-action="clear-selection"]'); node('.qm-font-bulk');
    const root = {
        get innerHTML() { return html; },
        set innerHTML(value) {
            html = value; samples.length = 0; statuses.length = 0;
            for (const match of value.matchAll(/data-font-sample="([^"]+)"/g)) samples.push(node('[data-font-sample]', { dataset: { fontSample: match[1] } }));
            for (const match of value.matchAll(/data-font-load-state="([^"]+)"/g)) statuses.push(node('[data-font-load-state]', { dataset: { fontLoadState: match[1] } }));
        },
        contains: () => true, setAttribute: (key, value) => attributes.set(key, value),
        querySelector: selector => queries.get(selector) || null,
        querySelectorAll: selector => selector === '[data-font-sample]' ? samples : selector === '[data-font-load-state]' ? statuses : [],
        addEventListener: (event, handler) => handlers.set(event, handler), removeEventListener: event => handlers.delete(event),
    };
    const view = createFontLibraryView({ root, getState: () => current, onAction: async payload => { calls.push(payload); return action(payload); }, onVisibleFonts: ids => visible.push(ids), fontFamily: id => `QianmuFont_${id}`, onBack: () => calls.push({ type: 'back' }) });
    return { root, view, calls, visible, samples, statuses, attributes, handlers, queries, node, setState: value => { current = value; },
        emit: (event, target) => handlers.get(event)?.({ target }),
        click: (action, fields = {}) => handlers.get('click')?.({ target: node('[data-font-action]', { dataset: { fontAction: action, ...fields } }) }) };
}

test('library presents Web import first, local upload alongside it, and previews only inside cards', () => {
    const html = renderFontLibrary(state());
    assert.ok(html.indexOf('Web 引入') < html.indexOf('上传本地字体'));
    assert.match(html, /字体文件链接、字体 CSS 链接、@import 或 @font-face/);
    assert.match(html, /accept="\.woff2,\.woff,\.ttf,\.otf" multiple hidden/);
    assert.match(html, /data-font-preview[^>]+value="山海相逢 ABC 123"/);
    assert.equal((html.match(/data-font-sample=/g) || []).length, 1);
    assert.doesNotMatch(html, /onmouseover|onclick|<style|<link|@font-face\s*\{/);
    assert.match(html, /data-font-assignment="body"/); assert.match(html, /data-font-assignment="st"/);
    assert.match(html, /沿用原生字体/); assert.match(html, /正文与 ST 界面的字号保持各自设置/);
});

test('shared mode exposes one application target without erasing independent settings', () => {
    const input = state({ mode: 'shared', body: { fontId: 'one', enabled: true, weight: '700' }, st: { fontId: '', enabled: false } }), before = structuredClone(input);
    const html = renderFontLibrary(input);
    assert.match(html, /data-font-assignment="shared"/); assert.match(html, /应用共用/);
    assert.doesNotMatch(html, /data-font-assignment="body"|data-font-assignment="st"|用于正文|用于ST/);
    assert.deepEqual(input, before);
});

test('application details start collapsed to prioritize list preview and retain an explicit open state', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /data-font-assignments><summary>应用设置/); assert.match(html, /data-font-preview type="text" maxlength="500"/);
    assert.match(renderFontLibrary(state(), { assignmentsOpen: true }), /data-font-assignments open>/);
    const f = fixture(); f.node('[data-font-assignments]', { open: true }); f.view.render();
    assert.match(f.root.innerHTML, /data-font-assignments open>/); f.view.destroy();
});

test('local files without parsed variants are explicitly labeled as file default style', () => {
    const html = renderFontLibraryCards(state({ entries: [entry('local', { sourceType: 'local', variantKnown: false })] }));
    assert.match(html, /文件默认字形/);
    assert.doesNotMatch(renderFontLibraryCards(state({ entries: [entry('web', { variantKnown: false })] })), /文件默认字形/);
    const full = renderFontLibrary(state({ entries: [entry('local', { sourceType: 'local', variantKnown: false })] }));
    assert.match(full, /文件默认字形/);
    assert.match(full, /Web 字体需来源可访问；本地原件仅存当前浏览器，清站点数据或换设备前请导出字库。/);
});

test('all user supplied metadata and preview strings are escaped, never source styles', () => {
    const evil = '"><img src=x onerror=alert(1)><script>bad</script>';
    const html = renderFontLibrary(state({ entries: [entry(evil, { name: evil, folder: evil, tags: [evil], weights: [evil], styles: [evil], status: evil, sourceType: 'local' })], previewText: evil }), { query: evil, selected: [evil] });
    assert.doesNotMatch(html, /<img|<script|style="/); assert.match(html, /&lt;script&gt;/);
    assert.match(html, />本机</); assert.match(html, /option value="400" selected/); assert.match(html, /option value="normal" selected/);
});

test('pagination limits previews to six and preserves the full filtered count', () => {
    const input = state({ entries: Array.from({ length: 19 }, (_, index) => entry(`font-${index}`)) });
    assert.equal(FONT_LIBRARY_PAGE_SIZE, 6);
    const first = selectFontLibraryPage(input), second = selectFontLibraryPage(input, { page: 1 }), last = selectFontLibraryPage(input, { page: 500 });
    assert.equal(first.entries.length, 6); assert.equal(first.total, 19); assert.equal(first.pages, 4);
    assert.equal(second.entries[0].id, 'font-6'); assert.equal(last.entries.length, 1); assert.equal(last.page, 3);
    assert.equal((renderFontLibraryCards(input).match(/data-font-sample=/g) || []).length, 6);
});

test('folder, tag and search filters compose without mutating the catalogue', () => {
    const input = state({ entries: [entry('one', { folder: '正文', tags: ['阅读'] }), entry('two', { folder: '界面', tags: ['阅读', '轻快'] }), entry('three')] }), before = structuredClone(input);
    assert.deepEqual(selectFontLibraryPage(input, { folder: '正文', tag: '阅读', query: 'one' }).entries.map(value => value.id), ['one']);
    assert.deepEqual(selectFontLibraryPage(input, { folder: '__none__' }).entries.map(value => value.id), ['three']);
    assert.equal(selectFontLibraryPage(input, { query: '轻快' }).entries[0].id, 'two');
    assert.deepEqual(input, before);
});

test('available face ranges become usable weights and style options rather than arbitrary synthetic controls', () => {
    const html = renderFontLibraryCards(state({ entries: [entry('one', { weights: ['100 900'], styles: ['normal'] })] }));
    for (const value of ['100', '400', '700', '900']) assert.match(html, new RegExp(`option value="${value}"`));
    assert.doesNotMatch(html, /option value="italic"/);
});

test('weight choices follow the actual selected style rather than a synthetic Cartesian combination', () => {
    const input = state({ entries: [entry('one', { faces: [{ weight: '400', style: 'normal' }, { weight: '700', style: 'italic' }] })] });
    const normal = renderFontLibraryCards(input), italic = renderFontLibraryCards(input, { variants: { one: { style: 'italic', weight: '700' } } });
    assert.match(normal, /option value="400" selected/); assert.doesNotMatch(normal, /option value="700"/);
    assert.match(italic, /option value="700" selected/); assert.doesNotMatch(italic, /option value="400"/);
});

test('mount requests only visible font registrations and never applies a host assignment', () => {
    const f = fixture(state({ entries: Array.from({ length: 14 }, (_, index) => entry(String(index))) }));
    assert.deepEqual(f.visible, [['0', '1', '2', '3', '4', '5']]); assert.equal(f.calls.length, 0);
    assert.equal(f.samples[0].style.fontFamily, 'QianmuFont_0'); assert.equal(f.samples[0].style.fontWeight, '400');
    f.view.destroy();
});

test('editable common preview stays in the list; input does not rerender or apply host styles', async () => {
    const f = fixture(), before = f.root.innerHTML, control = f.node('[data-font-preview]', { value: '新的预览 ABC' });
    f.emit('input', control); assert.equal(f.samples[0].textContent, '新的预览 ABC'); assert.equal(f.root.innerHTML, before); assert.equal(f.calls.length, 0);
    await f.emit('change', control); assert.deepEqual(f.calls, [{ type: 'set-preview', text: '新的预览 ABC' }]); assert.equal(f.root.innerHTML, before);
    f.view.destroy();
});

test('card variant changes affect the sample only until an explicit apply action', async () => {
    const f = fixture(), control = f.node('[data-font-variant]', { value: '700', dataset: { fontCard: 'one', fontVariant: 'weight' } });
    await f.emit('change', control); assert.equal(f.samples[0].style.fontWeight, '700'); assert.equal(f.calls.length, 0);
    await f.click('apply', { fontId: 'one', fontTarget: 'body' });
    assert.deepEqual(f.calls, [{ type: 'set-assignment', target: 'body', fontId: 'one', enabled: true, weight: '700', style: 'normal' }]);
    f.view.destroy();
});

test('saving preview text on blur does not consume the following explicit apply click', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; });
    const f = fixture(state(), payload => payload.type === 'set-preview' ? pending : undefined);
    const control = f.node('[data-font-preview]', { value: '预览后应用' }); f.emit('input', control);
    const saving = f.emit('change', control);
    await f.click('apply', { fontId: 'one', fontTarget: 'body' });
    assert.deepEqual(f.calls.map(value => value.type), ['set-preview', 'set-assignment']);
    resolve(); await saving; f.view.destroy();
});

test('choosing original font explicitly disables just that assignment', async () => {
    const f = fixture(), control = f.node('[data-font-assignment]', { value: '', dataset: { fontAssignment: 'st' } });
    await f.emit('change', control);
    assert.deepEqual(f.calls, [{ type: 'set-assignment', target: 'st', fontId: '', enabled: false, weight: '400', style: 'normal' }]); f.view.destroy();
});

test('changing an applied style selects a supported weight from that style', async () => {
    const f = fixture(state({ entries: [entry('one', { faces: [{ weight: '400', style: 'normal' }, { weight: '700', style: 'italic' }] })], body: { enabled: true, fontId: 'one', weight: '400', style: 'normal' } }));
    await f.emit('change', f.node('[data-font-variant]', { value: 'italic', dataset: { fontTarget: 'body', fontVariant: 'style' } }));
    assert.deepEqual(f.calls[0], { type: 'set-assignment', target: 'body', enabled: true, fontId: 'one', weight: '700', style: 'italic' }); f.view.destroy();
});

test('web source drafts are passed as data and a rejected addition preserves the form', async () => {
    const f = fixture(state(), () => { throw Object.assign(Error('PRIVATE RAW'), { userMessage: '未找到可用的字体声明。' }); });
    f.node('[data-font-web-name]', { value: '我的字体' }); f.node('[data-font-web-source]', { value: '@import url(https://example.test/fonts.css);' });
    const before = f.root.innerHTML; await f.click('add-web');
    assert.deepEqual(f.calls[0], { type: 'add-web', name: '我的字体', source: '@import url(https://example.test/fonts.css);' });
    assert.equal(f.root.innerHTML, before); assert.equal(f.queries.get('.qm-font-status').textContent, '未找到可用的字体声明。'); f.view.destroy();
});

test('local multi-upload and package import are separate explicit file actions', async () => {
    const f = fixture(), files = [{ name: 'one.woff2' }, { name: 'two.otf' }];
    const local = f.node('[data-font-file]', { value: 'fake-path', files, dataset: { fontFile: 'local' } });
    await f.emit('change', local); assert.deepEqual(f.calls[0], { type: 'add-local', files }); assert.equal(local.value, '');
    const imported = f.node('[data-font-file]', { value: 'fake-path', files: [{ name: 'fonts.json' }], dataset: { fontFile: 'import' } });
    await f.emit('change', imported); assert.deepEqual(f.calls[1], { type: 'import', file: { name: 'fonts.json' } }); f.view.destroy();
});

test('multiselect supports move, tags, export and remove with exact ids', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] }));
    await f.emit('change', f.node('[data-font-select]', { checked: true, dataset: { fontSelect: 'two' } }));
    f.node('[data-font-bulk-folder]', { value: ' 阅读 ' }); await f.click('folder');
    f.node('[data-font-bulk-tags]', { value: '清楚，中文, 阅读 ' }); await f.click('tags');
    await f.click('export-selected'); await f.click('delete');
    assert.deepEqual(f.calls, [{ type: 'update-fonts', ids: ['two'], folder: '阅读' }, { type: 'update-fonts', ids: ['two'], tags: ['清楚', '中文', '阅读'] }, { type: 'export', ids: ['two'] }, { type: 'delete-fonts', ids: ['two'] }]);
    f.view.destroy();
});

test('page selection is bounded and selections survive unrelated re-renders', async () => {
    const f = fixture(state({ entries: Array.from({ length: 9 }, (_, index) => entry(String(index))) }));
    await f.emit('change', f.node('[data-font-select-page]', { checked: true })); f.view.render(); await f.click('export-selected');
    assert.deepEqual(f.calls[0], { type: 'export', ids: ['0', '1', '2', '3', '4', '5'] });
    await f.click('clear-selection'); await f.click('delete'); assert.equal(f.calls.length, 1); f.view.destroy();
});

test('in-flight mutation is not submitted twice and close disposes delegated listeners', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; });
    const f = fixture(state(), () => pending); const first = f.click('mode', { fontMode: 'shared' });
    await f.click('mode', { fontMode: 'shared' }); assert.equal(f.calls.length, 1); assert.equal(f.attributes.get('aria-busy'), 'true');
    f.view.destroy(); assert.equal(f.handlers.size, 0); resolve(); await first; await flush();
    assert.equal(f.visible.length, 1, 'late completed action does not remount a closed library');
});

test('per-font loading errors target only matching samples and raw exceptions are not displayed', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] }), () => { throw Error('SECRET URL AND TOKEN'); });
    f.view.setFontStatus('two', '来源暂不可访问'); assert.equal(f.statuses[0].textContent, ''); assert.equal(f.statuses[1].textContent, '来源暂不可访问');
    await f.click('export-all'); assert.doesNotMatch(f.queries.get('.qm-font-status').textContent, /SECRET/); assert.match(f.queries.get('.qm-font-status').textContent, /操作未完成/);
    f.view.destroy();
});

test('styles use the existing floor hierarchy, scoped font samples, night-safe fields and narrow layouts', async () => {
    const css = await readFile(new URL('../qianmu-font-library.css', import.meta.url), 'utf8');
    assert.match(css, /font-size:var\(--qm-type-body,12px\)/); assert.match(css, /font-size:var\(--qm-type-card-title,13px\)/);
    assert.match(css, /color:var\(--sd-text\)/); assert.match(css, /background:var\(--sd-input-bg\)/); assert.match(css, /@media\(max-width:440px\)/);
    assert.match(css, /min-height:34px/); assert.match(css, /\.qm-font-sample \{[^}]*font-size:22px/);
    assert.doesNotMatch(css, /\.mes_text|body\s*\{|html\s*\{|font-family\s*:/);
    assert.ok(css.split('\n').filter(line => line.startsWith('#')).every(line => /^#story-director-floor-nav(?:\s|\.)/.test(line)));
});
