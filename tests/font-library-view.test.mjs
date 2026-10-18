import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFontLibraryView, renderFontLibrary, renderFontLibraryCards, selectFontLibraryPage, fontLibraryWeightControl, fontLibraryPreviewSize, FONT_LIBRARY_PAGE_SIZE } from '../qianmu-font-library-view.js';
const entry = (id = 'one', patch = {}) => ({ id, name: `字体 ${id}`, sourceType: 'web', folder: '', tags: [], weights: ['400', '700'], styles: ['normal', 'italic'], ...patch });
const state = (patch = {}) => ({ entries: [entry()], mode: 'separate', previewText: '山海相逢 ABC 123', body: { enabled: false, fontId: '' }, st: { enabled: false, fontId: '' }, shared: { enabled: false, fontId: '' }, ...patch });

function fixture(initial = state(), action = () => {}, initialSession = {}) {
    const handlers = new Map(), samples = [], statuses = [], queries = new Map(), calls = [], visible = [], attributes = new Map();
    let html = '', current = structuredClone(initial);
    function node(selector, fields = {}) {
        const item = { value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {}, style: { setProperty(key, value, priority) { this[key] = value; this[key + ':priority'] = priority; } }, classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; }, focus() {}, matches: candidate => candidate === selector, closest: candidate => candidate === selector ? item : null, ...fields };
        queries.set(selector, item); return item;
    }
    node('.qm-font-status'); node('[data-font-selection-count]'); node('.qm-font-bulk-actions'); node('.sd-body', { scrollTop: 0 });
    const root = { get innerHTML() { return html; }, set innerHTML(value) { html = value; samples.length = 0; statuses.length = 0; for (const match of value.matchAll(/data-font-sample="([^"]+)"/g)) samples.push(node('[data-font-sample]', { dataset: { fontSample: match[1] } })); for (const match of value.matchAll(/data-font-load-state="([^"]+)"/g)) statuses.push(node('[data-font-load-state]', { dataset: { fontLoadState: match[1] } })); },
        contains: () => true, setAttribute: (key, value) => attributes.set(key, value), querySelector: selector => queries.get(selector) || null,
        querySelectorAll: selector => selector === '[data-font-sample]' ? samples : selector === '[data-font-load-state]' ? statuses : [], addEventListener: (event, handler) => handlers.set(event, handler), removeEventListener: event => handlers.delete(event) };
    const view = createFontLibraryView({ root, getState: () => current, initialSession, onAction: async payload => { calls.push(payload); return action(payload); }, onVisibleFonts: (ids, choices) => visible.push({ ids, choices }), fontFamily: id => `QianmuFont_${id}`, onBack: () => calls.push({ type: 'back' }), onClose: () => calls.push({ type: 'close' }) });
    return { root, view, calls, visible, samples, statuses, attributes, handlers, queries, node, setState: value => { current = value; }, emit: (event, target) => handlers.get(event)?.({ target }), click: (action, fields = {}) => handlers.get('click')?.({ target: node('[data-font-action]', { dataset: { fontAction: action, ...fields } }) }), apply: (target, id = 'one') => handlers.get('change')?.({ target: node('[data-font-apply]', { value: target, dataset: { fontApply: id } }) }) };
}

test('main panel shell uses real inline theme icons and removes the old mode/settings prose', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /^<header class="sd-header qm-font-header">/); assert.match(html, /<h2>字体库管理<\/h2>/); assert.match(html, /<main class="sd-body">/);
    assert.match(html, /data-font-action="back"[^>]*aria-label="返回正文排版"/); assert.match(html, /data-font-action="close"/); assert.match(html, /class="qm-glyph-svg"/); assert.match(html, /data-qm-icon-variant="bold"/);
    assert.doesNotMatch(html, /qm-font-mode|qm-font-application|data-font-assignment|qm-font-note|qm-font-storage-note|文件默认字形|字体在下方列表预览/);
    assert.match(html, /class="sd-card qm-font-card"/);
});
test('Web add button follows the name field and native upload inputs remain directly clickable', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /qm-font-web-name"><input[^>]*data-font-web-name[^>]*>[\s\S]*?data-font-action="add-web"[\s\S]*?<\/div><\/label>/);
    assert.match(html, /data-font-file="local"[^>]*multiple>/); assert.match(html, /data-font-file="import"/); assert.doesNotMatch(html, /data-font-file="(?:local|import)"[^>]*hidden/);
    assert.match(html, /data-qm-icon="qm-regular-file-arrow-down"/); assert.match(html, /data-qm-icon="qm-regular-file-arrow-up"/);
    assert.match(html, /data-font-preview type="text" maxlength="500"/);
});
test('normal list hides checks and uses the real bookshelf search, filter menu and tag chips', () => {
    const html = renderFontLibrary(state({ entries: [entry('one', { tags: ['阅读'], folder: '中文' })] }));
    assert.match(html, /class="sd-reader-search"/); assert.match(html, /sd-reader-sort-menu qm-font-folder-menu/); assert.match(html, /class="sd-reader-tags"/); assert.match(html, /data-font-tag="阅读"/);
    assert.match(html, /data-font-select="one"[^>]*hidden/); assert.match(html, /qm-font-bulk-actions" hidden/); assert.match(html, /data-font-action="manage"[^>]*aria-expanded="false"/);
    const managing = renderFontLibrary(state(), { managing: true, selected: ['one'] }); assert.match(managing, /data-font-select="one"[^>]*checked>/); assert.doesNotMatch(managing, /qm-font-bulk-actions" hidden/);
});
test('per-card dropdown always offers body, ST and shared; restore choices appear only for active targets', () => {
    const plain = renderFontLibraryCards(state());
    for (const target of ['body', 'st', 'shared']) assert.match(plain, new RegExp(`option value="${target}"`)); assert.doesNotMatch(plain, /value="restore-/);
    const used = renderFontLibraryCards(state({ body: { enabled: true, fontId: 'one', weight: '700', style: 'normal' } }));
    assert.match(used, /<option value="" selected>正文/); assert.doesNotMatch(used, /value="restore-body"|value="restore-st"|应用于/);
    const shared = renderFontLibraryCards(state({ mode: 'shared', shared: { enabled: true, fontId: 'one' } }));
    assert.match(shared, /value="restore-shared">取消全部/); assert.match(shared, /<option value="" selected>全部/); assert.doesNotMatch(shared, /value="restore-body"/);
    const ui = renderFontLibraryCards(state({ st: { enabled: true, fontId: 'one' } })); assert.match(ui, /<option value="" selected>ST界面/); assert.match(ui, /value="restore-st">恢复界面/);
    assert.match(plain, /<option value="" selected>应用/); assert.match(plain, /qm-font-card-tools[\s\S]*?data-font-apply="one"[\s\S]*?<\/div><\/div><p/); assert.doesNotMatch(plain.match(/<div class="qm-font-card-foot">[\s\S]*?<\/div>/)?.[0] || '', /data-font-apply/);
});
test('source tags and default-style explanations are gone; only varying styles have a menu', () => {
    const html = renderFontLibraryCards(state({ entries: [entry('local', { sourceType: 'local', variantKnown: false, styles: ['normal'], weights: ['400'] })] }));
    assert.doesNotMatch(html, /qm-font-source|文件默认字形|>本机<|>Web<|data-font-style=|data-font-action="weight"|固定字重/);
    assert.match(renderFontLibraryCards(state()), /data-font-style="one"/); assert.match(renderFontLibraryCards(state()), /<label class="sd-icon-btn qm-font-style-pick qm-font-icon"/);
});
test('untrusted metadata remains escaped and never becomes executable HTML or styles', () => {
    const evil = '"><img src=x onerror=alert(1)><script>bad</script>';
    const html = renderFontLibrary(state({ entries: [entry(evil, { name: evil, folder: evil, tags: [evil], weights: [evil], styles: [evil], status: evil })], previewText: evil }), { query: evil });
    assert.doesNotMatch(html, /<img|<script|<style|onclick=/); assert.match(html, /&lt;script&gt;/);
});
test('six visible previews and bounded paging are unchanged', () => {
    const input = state({ entries: Array.from({ length: 19 }, (_, index) => entry(String(index))) });
    assert.equal(FONT_LIBRARY_PAGE_SIZE, 6); assert.equal(selectFontLibraryPage(input).entries.length, 6); assert.equal(selectFontLibraryPage(input, { page: 500 }).page, 3); assert.equal(selectFontLibraryPage(input, { page: 500 }).entries.length, 1);
    assert.equal((renderFontLibraryCards(input).match(/data-font-sample=/g) || []).length, 6);
});
test('folder, multiple tag chips and search compose without catalogue writes', () => {
    const input = state({ entries: [entry('one', { folder: '正文', tags: ['阅读', '中文'] }), entry('two', { folder: '正文', tags: ['阅读'] }), entry('three')] }), before = structuredClone(input);
    assert.deepEqual(selectFontLibraryPage(input, { folder: '正文', tags: ['阅读', '中文'], query: 'one' }).entries.map(value => value.id), ['one']); assert.equal(selectFontLibraryPage(input, { folder: '__none__' }).entries[0].id, 'three'); assert.deepEqual(input, before);
});
test('weight slider preserves continuous variable axes and exact discrete face steps', () => {
    const variable = fontLibraryWeightControl(entry('variable', { weights: ['100 900'] }), { weight: '563' });
    assert.deepEqual([variable.min, variable.max, variable.step, variable.value, variable.weight, variable.continuous], [100, 900, 1, 563, '563', true]);
    const discrete = fontLibraryWeightControl(entry(), { weight: '700' }); assert.deepEqual(discrete.values, [400, 700]); assert.deepEqual([discrete.min, discrete.max, discrete.value, discrete.continuous], [0, 1, 1, false]);
    assert.equal(fontLibraryWeightControl(entry('fixed', { weights: ['400'] })).disabled, true);
});
test('weight choices respect the selected style, not synthetic Cartesian combinations', () => {
    const font = entry('one', { faces: [{ weight: '400', style: 'normal' }, { weight: '700', style: 'italic' }] });
    assert.deepEqual(fontLibraryWeightControl(font, { style: 'normal' }).values, [400]); assert.deepEqual(fontLibraryWeightControl(font, { style: 'italic' }).values, [700]);
});
test('master enable is the first card, Web stays directly open and search precedes folder/multi-select', () => {
    const html = renderFontLibrary(state()); assert.ok(html.indexOf('data-font-enabled') < html.indexOf('qm-font-web-label'));
    assert.match(html, /data-font-enabled aria-label="启用字体库" checked/); assert.doesNotMatch(renderFontLibrary(state({ enabled: false })), /data-font-enabled[^>]*checked/);
    assert.doesNotMatch(html, /<details|<summary|Web 引入|字体链接或样式/); assert.match(html, />字体链接<textarea/);
    assert.ok(html.indexOf('data-font-search') < html.indexOf('data-font-action="filter"')); assert.ok(html.indexOf('data-font-action="filter"') < html.indexOf('data-font-action="manage"'));
    assert.match(html, /class="sd-card qm-font-preview-editor"/); assert.match(html, /data-font-preview-size/);
    assert.match(renderFontLibraryCards(state({ previewText: '' })), /一蝶振翅，万象入幕。/);
});
test('each font has an independent delete action outside the name tools and only sends its own id', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] })), html = f.root.innerHTML;
    assert.equal((html.match(/data-font-action="delete-one"/g) || []).length, 2); assert.match(html, /qm-font-card-foot[\s\S]*?data-font-action="delete-one"[\s\S]*?data-font-id="one"/);
    await f.click('delete-one', { fontId: 'two' }); await f.click('delete-one', { fontId: 'missing' }); assert.deepEqual(f.calls, [{ type: 'delete-fonts', ids: ['two'] }]); f.view.destroy();
});
test('preview size follows body until adjusted, includes out-of-range body sizes and never writes settings', () => {
    assert.deepEqual(fontLibraryPreviewSize({ defaultPreviewSize: 64 }), { min: 12, max: 64, value: 64 }); assert.deepEqual(fontLibraryPreviewSize({ defaultPreviewSize: 10 }), { min: 10, max: 48, value: 10 }); assert.equal(fontLibraryPreviewSize().value, 18);
    const f = fixture(state({ defaultPreviewSize: 19 })); assert.equal(f.samples[0].style['font-size'], '19px'); f.setState(state({ defaultPreviewSize: 21 })); f.view.render(); assert.equal(f.samples[0].style['font-size'], '21px');
    const slider = f.node('[data-font-preview-size]', { value: '31' }); f.emit('input', slider); assert.equal(f.samples[0].style['font-size'], '31px'); assert.equal(f.samples[0].style['font-size:priority'], 'important'); assert.equal(f.calls.length, 0); assert.equal(f.visible.length, 2);
    const session = f.view.captureSession(); assert.equal(session.previewSizeOverride, 31); f.view.destroy(); const reopened = fixture(state({ defaultPreviewSize: 22 }), () => {}, session); assert.equal(reopened.samples[0].style['font-size'], '31px'); reopened.view.destroy();
});
test('master emits one explicit action, is disabled during save and restores checked state on failure', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), () => pending), toggle = f.node('[data-font-enabled]', { checked: false });
    const saving = f.emit('change', toggle); assert.deepEqual(f.calls, [{ type: 'set-enabled', enabled: false }]); assert.equal(toggle.disabled, true); resolve(); await saving; assert.equal(toggle.disabled, false); f.view.destroy();
    const failed = fixture(state(), () => { throw Error('failed'); }), control = failed.node('[data-font-enabled]', { checked: false }); await failed.emit('change', control); assert.equal(control.checked, true); assert.equal(control.disabled, false); failed.view.destroy();
});
test('sample-only inline important beats theme font without host assignment or theme mutation', () => {
    const f = fixture(state({ entries: Array.from({ length: 9 }, (_, index) => entry(String(index))) }));
    assert.deepEqual(f.visible[0].ids, ['0', '1', '2', '3', '4', '5']); assert.equal(f.calls.length, 0);
    assert.equal(f.samples[0].style['font-family'], 'QianmuFont_0'); assert.equal(f.samples[0].style['font-family:priority'], 'important'); assert.equal(f.samples[0].style['font-weight:priority'], 'important'); assert.equal(f.samples[0].style['font-style:priority'], 'important'); f.view.destroy();
});
test('common preview typing retains its node and only changes list text until blur saves the sample', async () => {
    const f = fixture(), before = f.root.innerHTML, control = f.node('[data-font-preview]', { value: '新的预览 ABC' });
    f.emit('input', control); assert.equal(f.samples[0].textContent, '新的预览 ABC'); assert.equal(f.root.innerHTML, before); assert.equal(f.calls.length, 0);
    await f.emit('change', control); assert.deepEqual(f.calls, [{ type: 'set-preview', text: '新的预览 ABC' }]); assert.equal(f.root.innerHTML, before); f.view.destroy();
});
test('preview blur save does not swallow the following explicit application', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), payload => payload.type === 'set-preview' ? pending : undefined);
    const saving = f.emit('change', f.node('[data-font-preview]', { value: '预览后应用' })); await f.apply('body');
    assert.deepEqual(f.calls.map(value => value.type), ['set-preview', 'apply-font']); resolve(); await saving; f.view.destroy();
});
test('dragging weight and selecting style only update sample until dropdown application', async () => {
    const f = fixture(state({ entries: [entry('one', { weights: ['100 900'] })] })), slider = f.node('[data-font-weight]', { value: '687', dataset: { fontWeight: 'one' } });
    f.emit('input', slider); assert.equal(f.samples[0].style['font-weight'], '687'); assert.equal(f.calls.length, 0); assert.equal(f.visible.length, 1, 'drag does not repeatedly request preview sources');
    await f.emit('change', slider); await f.emit('change', f.node('[data-font-style]', { value: 'italic', dataset: { fontStyle: 'one' } })); assert.equal(f.samples[0].style['font-style'], 'italic'); assert.equal(f.calls.length, 0);
    await f.apply('body'); assert.deepEqual(f.calls, [{ type: 'apply-font', target: 'body', fontId: 'one', weight: '687', style: 'italic' }]); f.view.destroy();
});
test('dropdown restore sends its exact font and target without mutating other choices locally', async () => {
    const f = fixture(); await f.apply('restore-st'); assert.deepEqual(f.calls, [{ type: 'restore-font', fontId: 'one', target: 'st' }]); f.view.destroy();
});
test('web source drafts survive rejected and unrelated updates with precise trusted errors', async () => {
    const f = fixture(state(), () => { throw Object.assign(Error('PRIVATE RAW'), { userMessage: '未找到可用的字体声明。' }); });
    f.node('[data-font-web-name]', { value: '我的字体' }); f.node('[data-font-web-source]', { value: '@import url(https://example.test/fonts.css);' });
    const before = f.root.innerHTML; await f.click('add-web'); assert.deepEqual(f.calls[0], { type: 'add-web', name: '我的字体', source: '@import url(https://example.test/fonts.css);' });
    assert.equal(f.root.innerHTML, before); assert.equal(f.queries.get('.qm-font-status').textContent, '未找到可用的字体声明。'); f.view.render(); assert.match(f.root.innerHTML, /value="我的字体"/); f.view.destroy();
});
test('completed Web request clears only its exact draft and preserves newer input', () => {
    const f = fixture(), name = f.node('[data-font-web-name]', { value: '旧稿' }), source = f.node('[data-font-web-source]', { value: 'https://example.test/old.woff' });
    assert.equal(f.view.clearWebDraft({ name: '旧稿', source: 'https://example.test/old.woff' }), true); assert.equal(name.value, ''); assert.equal(source.value, '');
    name.value = '新稿'; source.value = 'https://example.test/new.woff'; assert.equal(f.view.clearWebDraft({ name: '旧稿', source: 'https://example.test/old.woff' }), false); assert.equal(name.value, '新稿'); assert.equal(source.value, 'https://example.test/new.woff'); f.view.destroy();
});
test('local multi-upload and font package import remain distinct file actions', async () => {
    const f = fixture(), files = [{ name: 'one.woff2' }, { name: 'two.otf' }];
    const local = f.node('[data-font-file]', { value: 'fake-path', files, dataset: { fontFile: 'local' } }); await f.emit('change', local); assert.deepEqual(f.calls[0], { type: 'add-local', files }); assert.equal(local.value, '');
    await f.emit('change', f.node('[data-font-file]', { files: [{ name: 'fonts.json' }], dataset: { fontFile: 'import' } })); assert.deepEqual(f.calls[1], { type: 'import', file: { name: 'fonts.json' } }); f.view.destroy();
});
test('management mode gates selection, exits clear it, and bulk folder/tags preserve exact ids', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] })), selected = f.node('[data-font-select]', { checked: true, dataset: { fontSelect: 'two' } });
    await f.emit('change', selected); await f.click('delete'); assert.equal(f.calls.length, 0);
    await f.click('manage'); await f.emit('change', selected); f.node('[data-font-bulk-value]');
    await f.click('bulk-folder'); f.queries.get('[data-font-bulk-value]').value = ' 阅读 '; await f.click('bulk-save');
    await f.click('bulk-tags'); f.queries.get('[data-font-bulk-value]').value = '清楚，中文, 阅读 '; await f.click('bulk-save');
    await f.click('export-selected'); await f.click('delete');
    assert.deepEqual(f.calls, [{ type: 'update-fonts', ids: ['two'], folder: '阅读' }, { type: 'update-fonts', ids: ['two'], tags: ['清楚', '中文', '阅读'] }, { type: 'export', ids: ['two'] }, { type: 'delete-fonts', ids: ['two'] }]);
    await f.click('manage'); await f.click('delete'); assert.equal(f.calls.length, 4); f.view.destroy();
});
test('page select is bounded to six and management collapse clears all selections', async () => {
    const f = fixture(state({ entries: Array.from({ length: 9 }, (_, index) => entry(String(index))) })); await f.click('manage'); await f.click('select-page'); await f.click('export-selected');
    assert.deepEqual(f.calls[0], { type: 'export', ids: ['0', '1', '2', '3', '4', '5'] }); await f.click('manage'); await f.click('delete'); assert.equal(f.calls.length, 1); f.view.destroy();
});
test('in-flight mutation is not sent twice and closed views discard late redraw', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), () => pending), first = f.apply('body'); await f.apply('st'); assert.equal(f.calls.length, 1); assert.equal(f.attributes.get('aria-busy'), 'true');
    f.view.destroy(); assert.equal(f.handlers.size, 0); resolve(); await first; assert.equal(f.visible.length, 1);
});
test('back and close are explicit independent callbacks', async () => { const f = fixture(); await f.click('back'); await f.click('close'); assert.deepEqual(f.calls, [{ type: 'back' }, { type: 'close' }]); f.view.destroy(); });
test('pending Web import does not block back or close and no late redraw reaches a closed view', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), () => pending), saving = f.click('add-web');
    await f.click('back'); await f.click('close'); assert.deepEqual(f.calls.map(call => call.type), ['add-web', 'back', 'close']);
    f.view.destroy(); resolve(); await saving; assert.equal(f.visible.length, 1);
});
test('same-account session restores browsing, sample choices and scroll but never transient selection', async () => {
    const input = state({ entries: Array.from({ length: 7 }, (_, index) => entry(String(index), { folder: '中文', tags: ['阅读'], weights: ['100 900'] })) });
    const session = { page: 1, query: '字体', folder: '中文', tags: ['阅读'], variants: { '6': { weight: '623', style: 'italic' } }, previewDraft: '未失去的样字', webName: '待加入', webSource: 'https://example.test/font.woff2', webOpen: true, scrollTop: 170, managing: true, selected: ['6'] };
    const f = fixture(input, () => {}, session); assert.deepEqual(f.visible[0].ids, ['6']); assert.deepEqual(f.visible[0].choices['6'], { weight: '623', style: 'italic' });
    assert.match(f.root.innerHTML, /value="字体"/); assert.match(f.root.innerHTML, /value="未失去的样字"/); assert.match(f.root.innerHTML, /value="待加入"/); assert.match(f.root.innerHTML, /qm-font-bulk-actions" hidden/);
    assert.equal(f.queries.get('.sd-body').scrollTop, 170); const captured = f.view.captureSession(); assert.equal(captured.page, 1); assert.equal(captured.scrollTop, 170); assert.deepEqual(captured.tags, ['阅读']); assert.equal(captured.managing, undefined); assert.equal(captured.selected, undefined);
    captured.variants['6'].weight = '100'; assert.equal(f.view.captureSession().variants['6'].weight, '623'); f.view.destroy();
});
test('field keyboard and focus events stop at the library without changing non-field behavior', () => {
    const f = fixture(), target = f.node('input,textarea,select'), stopped = [];
    for (const name of ['keydown', 'keyup', 'keypress', 'focusin']) f.handlers.get(name)({ target, key: 'x', stopPropagation: () => stopped.push(name) });
    assert.deepEqual(stopped, ['keydown', 'keyup', 'keypress', 'focusin']); f.handlers.get('keydown')({ target: f.node('button'), key: 'x', stopPropagation: () => stopped.push('bad') }); assert.equal(stopped.length, 4); f.view.destroy();
});
test('removing the final matching category cannot strand the list behind an invisible filter', () => {
    const f = fixture(state({ entries: [entry('one', { folder: '旧目录', tags: ['旧标签'] }), entry('two')] }), () => {}, { folder: '旧目录', tags: ['旧标签'] });
    assert.deepEqual(f.visible[0].ids, ['one']); f.setState(state({ entries: [entry('two')] })); f.view.render(); assert.deepEqual(f.visible.at(-1).ids, ['two']); assert.equal(f.view.captureSession().folder, ''); assert.deepEqual(f.view.captureSession().tags, []); f.view.destroy();
});
test('status errors target only matching samples and unknown raw errors remain private', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] }), () => { throw Error('SECRET URL AND TOKEN'); }); f.view.setFontStatus('two', '来源暂不可访问'); assert.equal(f.statuses[0].textContent, ''); assert.equal(f.statuses[1].textContent, '来源暂不可访问');
    await f.click('export-all'); assert.doesNotMatch(f.queries.get('.qm-font-status').textContent, /SECRET/); f.view.destroy();
});
test('CSS adds layout and sample controls without rewriting theme fonts or old floor shell', async () => {
    const css = await readFile(new URL('../qianmu-font-library.css', import.meta.url), 'utf8');
    assert.match(css, /\.qm-font-window \.qm-font-header/); assert.match(css, /\.qm-font-weight-pop/); assert.match(css, /\.qm-font-sample \{[^}]*font-size:18px/); assert.match(css, /@media\(max-width:440px\)/);
    assert.doesNotMatch(css, /font-family\s*:|\.mes_text|body\s*\{|html\s*\{/); assert.match(css, /\.qm-font-file-pick>input\[type="file"\]/);
    assert.match(css, /#story-director-floor-nav\.qm-font-library-open \.sd-floor-panel \{ display:none !important; \}/); assert.match(css, /grid-template-columns:minmax\(0,1fr\) auto/);
    assert.match(css, /\.qm-font-library :where\(input:not/); assert.match(css, /select\.qm-font-apply \{[^}]*width:7em/); assert.match(css, /\.qm-font-card-foot \{[^}]*flex-wrap:wrap/);
    assert.match(css, /\.qm-font-entry>small \{[^}]*white-space:nowrap;[^}]*text-overflow:ellipsis/); assert.match(css, /font-size:var\(--qm-type-feature-title,17px\) !important/);
    assert.match(css, /data-qm-theme="glass"\] \.qm-font-window \.qm-font-header \.qm-font-icon \{ border-radius:50% !important/); assert.match(css, /data-qm-theme="editorial"\][^\n]*border-radius:0 !important/);
    assert.match(css, /#story-director-floor-nav\.qm-font-library-open \.qm-font-window \.qm-font-card-foot>\.qm-font-icon \{ margin-left:auto !important; \}/);
});
