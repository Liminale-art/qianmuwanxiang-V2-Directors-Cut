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
    const view = createFontLibraryView({ root, getState: () => current, initialSession, onAction: async payload => { calls.push(payload); return action(payload); }, onVisibleFonts: (ids, choices) => visible.push({ ids, choices }), fontFamily: id => current.families?.[id] || `QianmuFont_${id}`, onBack: () => calls.push({ type: 'back' }) });
    return { root, view, calls, visible, samples, statuses, attributes, handlers, queries, node, setState: value => { current = value; }, emit: (event, target) => handlers.get(event)?.({ target }), click: (action, fields = {}) => handlers.get('click')?.({ target: node('[data-font-action]', { dataset: { fontAction: action, ...fields } }) }), apply: (target, id = 'one') => handlers.get('change')?.({ target: node('[data-font-apply]', { value: target, dataset: { fontApply: id } }) }) };
}

test('main panel shell uses real inline theme icons and removes the old mode/settings prose', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /^<header class="sd-header qm-font-header">/); assert.match(html, /<h2>字体库管理<\/h2>/); assert.match(html, /<main class="sd-body">/);
    assert.match(html, /<h2>字体库管理<\/h2>[\s\S]*?data-font-action="back"[^>]*aria-label="返回正文排版"/); assert.doesNotMatch(html, /data-font-action="close"/); assert.match(html, /class="qm-glyph-svg"/); assert.match(html, /data-qm-icon-variant="bold"/);
    assert.doesNotMatch(html, /qm-font-mode|qm-font-application|data-font-assignment|qm-font-note|qm-font-storage-note|文件默认字形|字体在下方列表预览/);
    assert.match(html, /class="sd-card qm-font-card"/);
});
test('one collapsible add card combines Web fields, tags and the three plain-text upload actions', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /<details class="sd-card qm-font-add"><summary><b>添加字体<\/b><\/summary>/); assert.match(html, /<span>字体链接<\/span><div>[\s\S]*?data-font-action="add-web"/);
    assert.match(html, /data-font-file="local"[^>]*multiple>/); assert.match(html, /data-font-file="import"/); assert.doesNotMatch(html, /data-font-file="(?:local|import)"[^>]*hidden/);
    const uploads = html.match(/<div class="qm-font-imports">[\s\S]*?<\/div>/)?.[0]; assert.doesNotMatch(uploads, /<svg/); assert.match(uploads, />上传本地<input/); assert.match(uploads, />导入<input/); assert.match(uploads, />导出<\/button>/);
    assert.ok(html.indexOf('data-font-web-source') < html.indexOf('data-font-web-tags')); assert.ok(html.indexOf('data-font-file="local"') < html.indexOf('</details>')); assert.match(html, /data-font-web-tags type="text" maxlength="2623"/);
    assert.match(renderFontLibrary(state({ entries: [] })), /<details class="sd-card qm-font-add" open>/); assert.match(renderFontLibrary(state(), { addOpen: true }), /<details class="sd-card qm-font-add" open>/);
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
    assert.match(plain, /<option value="" selected>应用/); assert.match(plain, /qm-font-apply-pick" data-applied="false"/); assert.match(shared, /qm-font-apply-pick" data-applied="true"/); assert.doesNotMatch(plain.match(/<div class="qm-font-card-foot">[\s\S]*?<\/div>/)?.[0] || '', /data-font-apply/);
});
test('source tags and default-style explanations are gone; only varying styles have a menu', () => {
    const html = renderFontLibraryCards(state({ entries: [entry('local', { sourceType: 'local', variantKnown: false, styles: ['normal'], weights: ['400'] })] }));
    assert.doesNotMatch(html, /qm-font-source|文件默认字形|>本机<|>Web<|data-font-style=|data-font-action="weight"|固定字重/);
    const expanded = renderFontLibraryCards(state(), { expandedId: 'one' }); assert.match(expanded, /data-font-style="one"/); assert.match(expanded, /<label class="sd-icon-btn qm-font-style-pick qm-font-icon"/); assert.doesNotMatch(expanded, /data-font-apply=/);
});
test('untrusted metadata remains escaped and never becomes executable HTML or styles', () => {
    const evil = '"><img src=x onerror=alert(1)><script>bad</script>';
    const html = renderFontLibrary(state({ entries: [entry(evil, { name: evil, folder: evil, tags: [evil], weights: [evil], styles: [evil], status: evil })], previewText: evil }), { query: evil });
    assert.doesNotMatch(html, /<img|<script|<style|onclick=/); assert.match(html, /&lt;script&gt;/);
});
test('ten visible previews and bounded paging replace the prior six-item page', () => {
    const input = state({ entries: Array.from({ length: 21 }, (_, index) => entry(String(index))) });
    assert.equal(FONT_LIBRARY_PAGE_SIZE, 10); assert.equal(selectFontLibraryPage(input).entries.length, 10); assert.equal(selectFontLibraryPage(input, { page: 500 }).page, 2); assert.equal(selectFontLibraryPage(input, { page: 500 }).entries.length, 1);
    assert.equal((renderFontLibraryCards(input).match(/data-font-sample=/g) || []).length, 10);
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
test('master enable is the first card, add collapses as a unit and search precedes folder/multi-select', () => {
    const html = renderFontLibrary(state()); assert.ok(html.indexOf('data-font-enabled') < html.indexOf('qm-font-web-label'));
    assert.match(html, /data-font-enabled aria-label="启用字体库" checked/); assert.doesNotMatch(renderFontLibrary(state({ enabled: false })), /data-font-enabled[^>]*checked/);
    assert.match(html, /<details class="sd-card qm-font-add"><summary>/); assert.doesNotMatch(html, /Web 引入|字体链接或样式/); assert.match(html, />字体链接<\/span>/);
    assert.ok(html.indexOf('data-font-search') < html.indexOf('data-font-action="filter"')); assert.ok(html.indexOf('data-font-action="filter"') < html.indexOf('data-font-action="manage"'));
    assert.match(html, /class="sd-card qm-font-preview-editor"/); assert.match(html, /data-font-preview-size/);
    assert.match(renderFontLibraryCards(state({ previewText: '' })), /一蝶振翅，万象入幕。/);
});
test('fixed fonts expose edit/delete directly while variable fonts keep them inside more', async () => {
    const fixed = id => entry(id, { weights: ['400'], styles: ['normal'] }), f = fixture(state({ entries: [fixed('one'), fixed('two')] })), html = f.root.innerHTML;
    assert.equal((html.match(/data-font-action="delete-one"/g) || []).length, 2); assert.doesNotMatch(html, /data-font-action="more"/);
    const collapsed = renderFontLibraryCards(state()); assert.match(collapsed, /data-font-action="more"/); assert.doesNotMatch(collapsed, /data-font-action="edit"|data-font-action="delete-one"/);
    await f.click('delete-one', { fontId: 'two' }); await f.click('delete-one', { fontId: 'missing' }); assert.deepEqual(f.calls, [{ type: 'delete-fonts', ids: ['two'] }]); f.view.destroy();
});
test('preview size preserves a non-preset body size and only accepts the five explicit sample sizes', () => {
    assert.deepEqual(fontLibraryPreviewSize({ defaultPreviewSize: 64 }), { values: [12, 14, 16, 18, 20], value: 64 }); assert.equal(fontLibraryPreviewSize().value, 18);
    assert.match(renderFontLibrary(state({ defaultPreviewSize: 19 })), /<option value="19" selected disabled>当前 19px/);
    const f = fixture(state({ defaultPreviewSize: 19 })); assert.equal(f.samples[0].style['font-size'], '19px'); f.setState(state({ defaultPreviewSize: 21 })); f.view.render(); assert.equal(f.samples[0].style['font-size'], '21px');
    const picker = f.node('[data-font-preview-size]', { value: '31' }); f.emit('input', picker); assert.equal(f.samples[0].style['font-size'], '21px'); picker.value = '20'; f.emit('input', picker); assert.equal(f.samples[0].style['font-size'], '20px'); assert.equal(f.samples[0].style['font-size:priority'], 'important'); assert.equal(f.calls.length, 0); assert.equal(f.visible.length, 2);
    const session = f.view.captureSession(); assert.equal(session.previewSizeOverride, 20); f.view.destroy(); const reopened = fixture(state({ defaultPreviewSize: 22 }), () => {}, session); assert.equal(reopened.samples[0].style['font-size'], '20px'); reopened.view.destroy();
});
test('master emits one explicit action, is disabled during save and restores checked state on failure', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), () => pending), toggle = f.node('[data-font-enabled]', { checked: false });
    const saving = f.emit('change', toggle); assert.deepEqual(f.calls, [{ type: 'set-enabled', enabled: false }]); assert.equal(toggle.disabled, true); resolve(); await saving; assert.equal(toggle.disabled, false); f.view.destroy();
    const failed = fixture(state(), () => { throw Error('failed'); }), control = failed.node('[data-font-enabled]', { checked: false }); await failed.emit('change', control); assert.equal(control.checked, true); assert.equal(control.disabled, false); failed.view.destroy();
});
test('sample-only inline important beats theme font without host assignment or theme mutation', () => {
    const f = fixture(state({ entries: Array.from({ length: 9 }, (_, index) => entry(String(index))) }));
    assert.deepEqual(f.visible[0].ids, ['0', '1', '2', '3', '4', '5', '6', '7', '8']); assert.equal(f.calls.length, 0);
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
    f.node('[data-font-web-tags]', { value: '阅读， 中文, 阅读' }); const before = f.root.innerHTML; await f.click('add-web'); assert.deepEqual(f.calls[0], { type: 'add-web', name: '我的字体', source: '@import url(https://example.test/fonts.css);', tags: ['阅读', '中文'] });
    assert.equal(f.root.innerHTML, before); assert.equal(f.queries.get('.qm-font-status').textContent, '未找到可用的字体声明。'); f.view.render(); assert.match(f.root.innerHTML, /value="我的字体"/); assert.equal(f.view.captureSession().webTags, '阅读， 中文, 阅读'); f.view.destroy();
});
test('completed Web request clears only its exact draft and preserves newer input', () => {
    const f = fixture(), name = f.node('[data-font-web-name]', { value: '旧稿' }), source = f.node('[data-font-web-source]', { value: 'https://example.test/old.woff' });
    assert.equal(f.view.clearWebDraft({ name: '旧稿', source: 'https://example.test/old.woff' }), true); assert.equal(name.value, ''); assert.equal(source.value, '');
    name.value = '新稿'; source.value = 'https://example.test/new.woff'; assert.equal(f.view.clearWebDraft({ name: '旧稿', source: 'https://example.test/old.woff' }), false); assert.equal(name.value, '新稿'); assert.equal(source.value, 'https://example.test/new.woff'); f.view.destroy();
});

test('Web draft completion matches normalized tags and preserves a newer tag draft', () => {
    const f = fixture(), name = f.node('[data-font-web-name]', { value: '正文' }), source = f.node('[data-font-web-source]', { value: 'https://example.test/one.woff2' }), tags = f.node('[data-font-web-tags]', { value: '阅读，中文, 阅读' });
    assert.equal(f.view.clearWebDraft({ name: name.value, source: source.value, tags: ['标题'] }), false); assert.equal(tags.value, '阅读，中文, 阅读');
    assert.equal(f.view.clearWebDraft({ name: name.value, source: source.value, tags: ['阅读', '中文'] }), true); assert.equal(tags.value, ''); f.view.destroy();
});

test('collapsed add state survives return while opening Web edit explicitly expands it', async () => {
    const f = fixture(), details = f.node('.qm-font-add', { open: true }); assert.equal(f.view.captureSession().addOpen, true); details.open = false;
    const reopened = fixture(state({ entries: [] }), () => {}, f.view.captureSession()); assert.match(reopened.root.innerHTML, /<details class="sd-card qm-font-add">/); reopened.view.destroy();
    await f.click('edit', { fontId: 'one' }); assert.equal(details.open, true); assert.equal(f.view.captureSession().addOpen, true); f.view.destroy();
});
test('Web edit fills the shared source card, preserves failures and cancel does not write', async () => {
    const f = fixture(state({ entries: [entry('one', { tags: ['阅读', '中文'], editableSource: '@font-face{font-family:one;src:url(https://example.test/one.woff)}' })] }), () => { throw Object.assign(Error('bad'), { userMessage: '字体来源暂不可用。' }); });
    const name = f.node('[data-font-web-name]'), source = f.node('[data-font-web-source]'), tagField = f.node('[data-font-web-tags]'); await f.click('edit', { fontId: 'one' });
    assert.equal(name.value, '字体 one'); assert.match(source.value, /@font-face/); assert.equal(f.view.captureSession().editWebId, 'one'); assert.match(f.root.innerHTML, /data-font-action="cancel-web"/); assert.match(f.root.innerHTML, /aria-label="保存字体修改"/);
    assert.equal(tagField.value, '阅读, 中文'); assert.equal(f.view.captureSession().addOpen, true); assert.match(f.root.innerHTML, /qm-font-add" open/);
    name.value = '修改名称'; source.value = 'https://example.test/retry.woff'; tagField.value = '标题，圆润'; await f.click('add-web'); assert.deepEqual(f.calls[0], { type: 'edit-web', id: 'one', name: '修改名称', source: 'https://example.test/retry.woff', tags: ['标题', '圆润'] });
    assert.equal(f.view.captureSession().editWebId, 'one'); assert.equal(source.value, 'https://example.test/retry.woff');
    const restored = fixture(state(), () => {}, f.view.captureSession()); assert.match(restored.root.innerHTML, /value="修改名称"/); assert.match(restored.root.innerHTML, /aria-label="保存字体修改"/); assert.match(restored.root.innerHTML, /value="标题，圆润"/); restored.view.destroy();
    await f.click('cancel-web'); assert.equal(f.calls.length, 1); assert.equal(f.view.captureSession().editWebId, ''); assert.equal(source.value, ''); assert.equal(tagField.value, ''); f.view.destroy();
});
test('successful Web edit exits only its matching edit session', async () => {
    const f = fixture(state({ entries: [entry('one', { editableSource: 'https://example.test/one.woff' })] }), () => ({ editedFontId: 'one' }));
    f.node('[data-font-web-name]'); f.node('[data-font-web-source]'); await f.click('edit', { fontId: 'one' });
    assert.equal(f.view.clearWebDraft({ id: 'other', name: '字体 one', source: 'https://example.test/one.woff' }), false); await f.click('add-web'); assert.equal(f.view.captureSession().editWebId, ''); assert.doesNotMatch(f.root.innerHTML, /data-font-action="cancel-web"/); f.view.destroy();
});
test('local edit preserves name drafts across return and rename only writes the selected name', async () => {
    const f = fixture(state({ entries: [entry('one', { sourceType: 'local' })] })); await f.click('edit', { fontId: 'one' });
    assert.equal(f.view.captureSession().renameId, 'one'); f.emit('input', f.node('[data-font-rename]', { value: '本地新名称', dataset: { fontRename: 'one' } }));
    const restored = fixture(state(), () => {}, f.view.captureSession()); assert.match(restored.root.innerHTML, /value="本地新名称"/); restored.view.destroy();
    await f.click('rename-save', { fontId: 'one' }); assert.deepEqual(f.calls, [{ type: 'update-fonts', ids: ['one'], name: '本地新名称' }]); assert.equal(f.view.captureSession().renameId, '');
    await f.click('edit', { fontId: 'one' }); await f.click('rename-cancel', { fontId: 'one' }); assert.equal(f.calls.length, 1); assert.equal(f.view.captureSession().renameId, ''); f.view.destroy();
});
test('reveal clears blocking filters, selects the new ten-item page and cannot reopen a closed view', () => {
    const initial = state({ entries: Array.from({ length: 11 }, (_, index) => entry(String(index), { folder: index ? '' : '筛选', tags: index ? [] : ['选中'] })) });
    const f = fixture(initial, () => {}, { query: '0', folder: '筛选', tags: ['选中'] }); assert.deepEqual(f.visible[0].ids, ['0']); assert.equal(f.view.revealFont('10'), true);
    assert.deepEqual(f.visible.at(-1).ids, ['10']); const session = f.view.captureSession(); assert.equal(session.page, 1); assert.equal(session.query, ''); assert.equal(session.folder, ''); assert.deepEqual(session.tags, []); assert.equal(f.calls.length, 0); assert.equal(f.view.revealFont('missing'), false);
    f.view.destroy(); assert.equal(f.view.revealFont('0'), false);
});
test('successful add result reveals its own font after commit without another settings write', async () => {
    const before = state({ entries: Array.from({ length: 10 }, (_, index) => entry(String(index))) }); let f;
    f = fixture(before, () => { f.setState({ ...before, entries: [...before.entries, entry('new')] }); return { revealFontId: 'new' }; }); await f.click('add-web'); assert.deepEqual(f.visible.at(-1).ids, ['new']); assert.equal(f.view.captureSession().page, 1); assert.equal(f.calls.length, 1); f.view.destroy();
});
test('runtime readiness updates just the matching sample family without recursion or changing its variant', () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] })), count = f.visible.length, weight = f.samples[0].style['font-weight'], size = f.samples[0].style['font-size'];
    f.setState(state({ entries: [entry('one'), entry('two')], families: { one: 'QianmuFont_one_new' } })); f.view.setFontStatus('one', ''); assert.equal(f.samples[0].style['font-family'], 'QianmuFont_one_new'); assert.equal(f.samples[1].style['font-family'], 'QianmuFont_two'); assert.equal(f.samples[0].style['font-weight'], weight); assert.equal(f.samples[0].style['font-size'], size); assert.equal(f.visible.length, count); f.view.destroy();
});
test('local multi-upload confirms all names and tags once before dispatch; package import stays separate', async () => {
    const f = fixture(), files = [{ name: 'one.woff2' }, { name: 'two.otf' }];
    const local = f.node('[data-font-file]', { value: 'fake-path', files, dataset: { fontFile: 'local' } }); await f.emit('change', local); assert.equal(f.calls.length, 0); assert.equal(local.value, '');
    assert.match(f.root.innerHTML, /data-font-local-dialog role="dialog" aria-modal="true"/); assert.match(f.root.innerHTML, /class="sd-body" inert/); assert.match(f.root.innerHTML, /data-font-local-name="0" value="one" maxlength="160"/); assert.match(f.root.innerHTML, /data-font-local-name="1" value="two"/);
    f.emit('input', f.node('[data-font-local-name]', { value: '正文字体', dataset: { fontLocalName: '0' } })); f.emit('input', f.node('[data-font-local-tags]', { value: '阅读，中文, 阅读', dataset: { fontLocalTags: '0' } }));
    await f.click('local-confirm'); assert.deepEqual(f.calls[0], { type: 'add-local', files, metadata: [{ name: '正文字体', tags: ['阅读', '中文'] }, { name: 'two', tags: [] }] }); assert.doesNotMatch(f.root.innerHTML, /data-font-local-dialog/);
    await f.emit('change', f.node('[data-font-file]', { files: [{ name: 'fonts.json' }], dataset: { fontFile: 'import' } })); assert.deepEqual(f.calls[1], { type: 'import', file: { name: 'fonts.json' } }); f.view.destroy();
});

test('cancel, backdrop and Escape discard uncommitted local uploads without writes or session files', async () => {
    const f = fixture(), files = [{ name: 'one.woff2' }], local = f.node('[data-font-file]', { files, dataset: { fontFile: 'local' } });
    await f.emit('change', local); assert.equal(JSON.stringify(f.view.captureSession()).includes('one.woff2'), false); assert.equal(f.view.captureSession().localUploads, undefined);
    await f.click('local-cancel'); assert.equal(f.calls.length, 0); assert.doesNotMatch(f.root.innerHTML, /data-font-local-dialog/);
    await f.emit('change', local); await f.emit('click', f.node('[data-font-local-layer]')); assert.equal(f.calls.length, 0); assert.doesNotMatch(f.root.innerHTML, /data-font-local-dialog/);
    await f.emit('change', local); let stopped = false; f.handlers.get('keydown')({ target: local, key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } }); assert.equal(stopped, true); assert.equal(f.calls.length, 0); assert.doesNotMatch(f.root.innerHTML, /data-font-local-dialog/);
    await f.emit('change', local); const session = f.view.captureSession(); f.view.destroy(); const reopened = fixture(state(), () => {}, session); assert.doesNotMatch(reopened.root.innerHTML, /data-font-local-dialog/); reopened.view.destroy();
});

test('failed local upload keeps all metadata and shows its trusted error inside the dialog', async () => {
    const f = fixture(state(), () => { throw Object.assign(Error('PRIVATE'), { userMessage: '每个标签最多 80 字。' }); }), status = f.node('[data-font-local-status]');
    await f.emit('change', f.node('[data-font-file]', { files: [{ name: '<bad>.woff2' }], dataset: { fontFile: 'local' } })); f.emit('input', f.node('[data-font-local-name]', { value: '本地稿', dataset: { fontLocalName: '0' } })); f.emit('input', f.node('[data-font-local-tags]', { value: '长'.repeat(81), dataset: { fontLocalTags: '0' } }));
    await f.click('local-confirm'); assert.equal(status.textContent, '每个标签最多 80 字。'); assert.equal(status.hidden, false); assert.equal(f.calls[0].metadata[0].tags[0].length, 81); f.view.render();
    assert.match(f.root.innerHTML, /value="本地稿"/); assert.match(f.root.innerHTML, /&lt;bad&gt;.woff2/); assert.doesNotMatch(f.root.innerHTML, /<bad>/); await f.click('local-cancel'); assert.equal(f.calls.length, 1); f.view.destroy();
});

test('Escape during confirmed local save does not pretend to cancel an in-flight commit', async () => {
    let resolve; const f = fixture(state(), () => new Promise(done => { resolve = done; })), file = f.node('[data-font-file]', { files: [{ name: 'one.woff2' }], dataset: { fontFile: 'local' } }); await f.emit('change', file);
    const saving = f.click('local-confirm'); f.handlers.get('keydown')({ target: file, key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.match(f.root.innerHTML, /data-font-local-dialog/); await f.click('local-cancel'); assert.match(f.root.innerHTML, /data-font-local-dialog/); assert.equal(f.calls.length, 1);
    resolve(); await saving; assert.doesNotMatch(f.root.innerHTML, /data-font-local-dialog/); f.view.destroy();
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
test('page select is bounded to ten and management collapse clears all selections', async () => {
    const f = fixture(state({ entries: Array.from({ length: 11 }, (_, index) => entry(String(index))) })); await f.click('manage'); await f.click('select-page'); await f.click('export-selected');
    assert.deepEqual(f.calls[0], { type: 'export', ids: Array.from({ length: 10 }, (_, index) => String(index)) }); await f.click('manage'); await f.click('delete'); assert.equal(f.calls.length, 1); f.view.destroy();
});
test('in-flight mutation is not sent twice and closed views discard late redraw', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), () => pending), first = f.apply('body'); await f.apply('st'); assert.equal(f.calls.length, 1); assert.equal(f.attributes.get('aria-busy'), 'true');
    f.view.destroy(); assert.equal(f.handlers.size, 0); resolve(); await first; assert.equal(f.visible.length, 1);
});
test('the sole header back action returns to typography', async () => { const f = fixture(); await f.click('back'); assert.deepEqual(f.calls, [{ type: 'back' }]); f.view.destroy(); });
test('pending Web import does not block back and no late redraw reaches a closed view', async () => {
    let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture(state(), () => pending), saving = f.click('add-web');
    await f.click('back'); assert.deepEqual(f.calls.map(call => call.type), ['add-web', 'back']);
    f.view.destroy(); resolve(); await saving; assert.equal(f.visible.length, 1);
});
test('same-account session restores browsing, sample choices and scroll but never transient selection', async () => {
    const input = state({ entries: Array.from({ length: 11 }, (_, index) => entry(String(index), { folder: '中文', tags: ['阅读'], weights: ['100 900'] })) });
    const session = { page: 1, query: '字体', folder: '中文', tags: ['阅读'], variants: { '10': { weight: '623', style: 'italic' } }, previewDraft: '未失去的样字', webName: '待加入', webSource: 'https://example.test/font.woff2', scrollTop: 170, managing: true, selected: ['10'] };
    const f = fixture(input, () => {}, session); assert.deepEqual(f.visible[0].ids, ['10']); assert.deepEqual(f.visible[0].choices['10'], { weight: '623', style: 'italic' });
    assert.match(f.root.innerHTML, /value="字体"/); assert.match(f.root.innerHTML, /value="未失去的样字"/); assert.match(f.root.innerHTML, /value="待加入"/); assert.match(f.root.innerHTML, /qm-font-bulk-actions" hidden/);
    assert.equal(f.queries.get('.sd-body').scrollTop, 170); const captured = f.view.captureSession(); assert.equal(captured.page, 1); assert.equal(captured.scrollTop, 170); assert.deepEqual(captured.tags, ['阅读']); assert.equal(captured.managing, undefined); assert.equal(captured.selected, undefined);
    captured.variants['10'].weight = '100'; assert.equal(f.view.captureSession().variants['10'].weight, '623'); f.view.destroy();
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
    assert.match(css, /\.qm-font-library :where\(input:not/); assert.match(css, /qm-font-apply-pick\)>select[^}]*opacity:0/); assert.match(css, /\.qm-font-card-foot \{[^}]*flex-wrap:wrap/);
    assert.match(css, /\.qm-font-entry>small \{[^}]*white-space:nowrap;[^}]*text-overflow:ellipsis/); assert.match(css, /\.qm-font-header h2[^}]*font-size:14px !important/);
    assert.match(css, /data-qm-theme="glass"\] \.qm-font-window \.qm-font-header \.qm-font-icon \{ border-radius:50% !important/); assert.match(css, /data-qm-theme="editorial"\][^\n]*border-radius:0 !important/);
    assert.match(css, /input\[data-font-enabled\][^}]*border-radius:999px !important/); assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/); assert.match(css, /input::placeholder,[\s\S]*?font-size:12px !important/);
    assert.match(css, /\.qm-font-preview-editor \.qm-font-field-head \{ justify-content:flex-start;/); assert.match(css, /\.qm-font-local-files \{[^}]*overflow:auto/); assert.match(css, /\.qm-font-local-dialog>footer \{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(css, /\.qm-font-local-dialog \{[^}]*background:var\(--qm-raised,var\(--sd-sticky-bg,#f7f3eb\)\) !important/);
    assert.doesNotMatch(css, /\.qm-font-local-dialog \{[^}]*background:[^;]*--sd-folder-head/);
});
