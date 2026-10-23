import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFontLibraryView, renderFontLibrary, renderFontLibraryCards, selectFontLibraryPage, sortFontLibraryEntries, collectFontLibraryTags, fontLibraryWeightControl, fontLibraryPreviewSize, FONT_LIBRARY_PAGE_SIZE } from '../qianmu-font-library-view.js';
const entry = (id = 'one', patch = {}) => ({ id, name: `字体 ${id}`, sourceType: 'web', folder: '', tags: [], weights: ['400', '700'], styles: ['normal', 'italic'], ...patch });
const state = (patch = {}) => ({ entries: [entry()], mode: 'separate', previewText: '山海相逢 ABC 123', body: { enabled: false, fontId: '' }, st: { enabled: false, fontId: '' }, shared: { enabled: false, fontId: '' }, ...patch });

test('card-header submission prevents disclosure toggling and sends one trusted toast on failure', async () => {
    const f = fixture(state(), () => { throw Object.assign(Error('PRIVATE'), { userMessage: '链接不可为空' }); });
    let prevented = 0; const button = f.node('[data-font-action]', { dataset: { fontAction: 'add-web' } });
    button.closest = selector => selector === '[data-font-action]' ? button : selector === '.qm-font-add>summary' ? {} : null;
    await f.handlers.get('click')({ target: button, preventDefault() { prevented++; } });
    assert.equal(prevented, 1); assert.equal(f.calls.length, 1); assert.deepEqual(f.notices, [{ text: '链接不可为空', level: 'warning' }]);
    f.view.setStatus(''); assert.equal(f.notices.length, 1); f.view.setStatus('字体包已导出'); assert.equal(f.notices.at(-1).level, 'info');
    f.view.destroy(); f.view.setStatus('迟到失败', { error: true }); assert.equal(f.notices.length, 2);
});

function fixture(initial = state(), action = () => {}, initialSession = {}) {
    const handlers = new Map(), samples = [], statuses = [], applyPickers = [], queries = new Map(), allQueries = new Map(), calls = [], notices = [], visible = [], attributes = new Map();
    let html = '', current = structuredClone(initial), reads = 0;
    function node(selector, fields = {}) {
        const item = { value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {}, style: { setProperty(key, value, priority) { this[key] = value; this[key + ':priority'] = priority; } }, classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; }, focus() {}, matches: candidate => candidate === selector, closest: candidate => candidate === selector ? item : null, ...fields };
        queries.set(selector, item); return item;
    }
    node('[data-font-selection-count]'); node('.qm-font-bulk-actions'); node('.sd-body', { scrollTop: 0 });
    const root = { get innerHTML() { return html; }, set innerHTML(value) { html = value; samples.length = 0; statuses.length = 0; applyPickers.length = 0; for (const match of value.matchAll(/data-font-sample="([^"]+)"/g)) samples.push(node('[data-font-sample]', { dataset: { fontSample: match[1] } })); for (const match of value.matchAll(/data-font-load-state="([^"]+)"/g)) statuses.push(node('[data-font-load-state]', { dataset: { fontLoadState: match[1] } })); for (const match of value.matchAll(/data-font-apply="([^"]+)"/g)) applyPickers.push(node('[data-font-apply]', { selectedIndex: 0, value: 'body', dataset: { fontApply: match[1] } })); },
        contains: () => true, setAttribute: (key, value) => attributes.set(key, value), querySelector: selector => queries.get(selector) || null,
        querySelectorAll: selector => allQueries.get(selector) || (selector === '[data-font-sample]' ? samples : selector === '[data-font-load-state]' ? statuses : selector === '[data-font-apply]' ? applyPickers : []), addEventListener: (event, handler) => handlers.set(event, handler), removeEventListener: event => handlers.delete(event) };
    const view = createFontLibraryView({ root, getState: () => { reads++; return current; }, initialSession, notify: (text, level) => notices.push({ text, level }), onAction: async payload => { calls.push(payload); return action(payload); }, onVisibleFonts: (ids, choices) => visible.push({ ids, choices }), fontFamily: id => current.families?.[id] || `QianmuFont_${id}`, onBack: () => calls.push({ type: 'back' }) });
    return { root, view, calls, notices, visible, samples, statuses, applyPickers, attributes, handlers, queries, allQueries, node, get reads() { return reads; }, setState: value => { current = value; }, emit: (event, target) => handlers.get(event)?.({ target }), clickCard: id => handlers.get('click')?.({ target: node('.qm-font-card', { dataset: { fontId: id } }) }), click: (action, fields = {}) => handlers.get('click')?.({ target: node('[data-font-action]', { dataset: { fontAction: action, ...fields } }) }), apply: (target, id = 'one') => handlers.get('change')?.({ target: node('[data-font-apply]', { value: target, dataset: { fontApply: id } }) }) };
}

test('main panel shell uses real inline theme icons and removes the old mode/settings prose', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /^<header class="sd-header qm-font-header">/); assert.match(html, /<h2>字体库管理<\/h2>/); assert.match(html, /<main class="sd-body">/);
    assert.match(html, /<h2>字体库管理<\/h2>[\s\S]*?data-font-action="back"[^>]*aria-label="返回正文排版"/); assert.doesNotMatch(html, /data-font-action="close"/); assert.match(html, /class="qm-glyph-svg"/); assert.match(html, /data-qm-icon-variant="bold"/);
    assert.doesNotMatch(html, /qm-font-mode|qm-font-application|data-font-assignment|qm-font-note|qm-font-storage-note|文件默认字形|字体在下方列表预览/);
    assert.match(html, /class="sd-card qm-font-card"/);
});
test('one collapsible add card combines Web fields and two plain-text upload actions without export', () => {
    const html = renderFontLibrary(state());
    assert.match(html, /<details class="sd-card qm-font-add"><summary><b>添加字体<\/b><div class="qm-font-add-actions">[\s\S]*?data-font-action="add-web"[\s\S]*?<\/summary>/); assert.doesNotMatch(html, /qm-font-status|data-font-local-status/); assert.ok(html.indexOf('data-font-action="add-web"') < html.indexOf('data-font-web-name'));
    assert.match(html, /data-font-file="local"[^>]*multiple>/); assert.match(html, /data-font-file="import"/); assert.doesNotMatch(html, /data-font-file="(?:local|import)"[^>]*hidden/);
    const uploads = html.match(/<div class="qm-font-imports">[\s\S]*?<\/div>/)?.[0]; assert.doesNotMatch(uploads, /<svg|导出|export/); assert.match(uploads, />上传本地字体<input/); assert.match(uploads, />导入字体包<input/); assert.equal((uploads.match(/class="sd-btn/g) || []).length, 2); assert.doesNotMatch(html, /export-all/);
    assert.ok(html.indexOf('data-font-web-source') < html.indexOf('data-font-web-tags')); assert.ok(html.indexOf('data-font-file="local"') < html.indexOf('</details>')); assert.match(html, /data-font-web-tags type="text" maxlength="2623"/);
    assert.match(renderFontLibrary(state({ entries: [] })), /<details class="sd-card qm-font-add" open>/); assert.match(renderFontLibrary(state(), { addOpen: true }), /<details class="sd-card qm-font-add" open>/);
    assert.match(html, /data-font-preview type="text" maxlength="500"/);
    assert.match(html, /placeholder="如：宋体,黑体，多个标签用逗号分隔"/);
});
test('normal list has no checks and management makes whole cards accessible selectable targets', () => {
    const html = renderFontLibrary(state({ entries: [entry('one', { tags: ['阅读'], folder: '中文' })] }));
    assert.match(html, /class="sd-reader-search"/); assert.match(html, /placeholder="搜索字体 \/ 标签"/); assert.doesNotMatch(html, /data-font-folder|qm-font-folder|sd-reader-tags|data-font-tag=|bulk-folder|文件夹/); assert.match(html, /<span class="qm-font-tag">阅读<\/span>/); assert.doesNotMatch(html, /#阅读|>中文</);
    assert.doesNotMatch(html, /data-font-select=|sd-reader-book-check/); assert.match(html, /qm-font-bulk-actions" hidden/); assert.match(html, /data-font-action="manage"[^>]*aria-expanded="false"/);
    const managing = renderFontLibrary(state(), { managing: true, selected: ['one'] }); assert.match(managing, /qm-font-card is-selecting is-selected" data-font-id="one" role="button" tabindex="0" aria-label="选择 字体 one" aria-pressed="true"/); assert.match(managing, /qm-font-card-tools" hidden/); assert.doesNotMatch(managing, /data-font-select=|qm-font-bulk-actions" hidden/);
});
test('per-card dropdown has only actual scopes and the relevant ST restore choice, without placeholder or shared cancellation', () => {
    const plain = renderFontLibraryCards(state());
    for (const target of ['body', 'st', 'shared']) assert.match(plain, new RegExp(`option value="${target}"`)); assert.doesNotMatch(plain, /value="restore-/);
    const used = renderFontLibraryCards(state({ body: { enabled: true, fontId: 'one', weight: '700', style: 'normal' } }));
    assert.match(used, /data-applied="true" title="正文"/); assert.doesNotMatch(used, /value="restore-body"|value="restore-st"|应用于/);
    const shared = renderFontLibraryCards(state({ mode: 'shared', shared: { enabled: true, fontId: 'one' } }));
    assert.match(shared, /data-applied="true" title="全部"/); assert.doesNotMatch(shared, /value="restore-body"|restore-shared|取消全部/);
    const ui = renderFontLibraryCards(state({ st: { enabled: true, fontId: 'one' } })); assert.match(ui, /data-applied="true" title="界面"/); assert.match(ui, /value="st">界面/); assert.match(ui, /value="restore-st">恢复界面/); assert.doesNotMatch(ui, /ST界面/);
    assert.doesNotMatch(plain, /<option value=""|>应用<|取消全部/); assert.match(plain, /qm-font-apply-pick" data-applied="false"/); assert.match(shared, /qm-font-apply-pick" data-applied="true"/); assert.doesNotMatch(plain.match(/<div class="qm-font-card-foot">[\s\S]*?<\/div>/)?.[0] || '', /data-font-apply/);
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
test('search matches names and tags only and ignores all legacy session filters without writes', () => {
    const input = state({ entries: [entry('one', { folder: '正文', tags: ['阅读', '中文'] }), entry('two', { folder: '正文', tags: ['阅读'] }), entry('three')] }), before = structuredClone(input);
    assert.deepEqual(selectFontLibraryPage(input, { folder: '不存在', tags: ['不存在'], query: 'one' }).entries.map(value => value.id), ['one']); assert.deepEqual(selectFontLibraryPage(input, { query: '阅读' }).entries.map(value => value.id), ['one', 'two']); assert.equal(selectFontLibraryPage(input, { query: '正文' }).entries.length, 0); assert.equal(selectFontLibraryPage(input, { folder: '__none__', tags: ['不存在'] }).entries.length, 3); assert.deepEqual(input, before);
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

test('hundreds of duplicate fragment weights preserve the exact deduplicated ranges, styles and fixed aliases', () => {
    const unique = [{ weight: '200 900', style: 'normal' }, { weight: 'normal', style: 'normal' }, { weight: 'bold', style: 'normal' }, { weight: '50 100', style: 'normal' }, { weight: '300 500', style: 'italic' }, { weight: '950', style: 'italic' }];
    const repeated = entry('many', { faces: Array.from({ length: 672 }, (_, index) => ({ ...unique[index % unique.length], unicodeRange: `U+${(0x4e00 + index).toString(16)}` })) }), compact = entry('compact', { faces: unique });
    for (const current of [{ weight: '563' }, { weight: '75' }, { weight: '950', style: 'italic' }, { weight: '450', style: 'italic' }]) assert.deepEqual(fontLibraryWeightControl(repeated, current), fontLibraryWeightControl(compact, current));
    const contiguous = entry('672', { faces: Array.from({ length: 672 }, () => ({ weight: '200 900', style: 'normal' })) });
    assert.equal(fontLibraryWeightControl(contiguous).values.length, 701); assert.equal(fontLibraryWeightControl(contiguous, { weight: '563' }).value, 563);
});

test('render, sorted reveal and paging use one fresh state snapshot each, not one normalization per card', async () => {
    const input = state({ entries: Array.from({ length: 12 }, (_, index) => entry(String(index))), pinnedIds: Array.from({ length: 10 }, (_, index) => String(index)) }), f = fixture(input);
    for (let index = 0; index < 10; index++) attachCard(f, String(index));
    f.node('[data-font-cards]'); let before = f.reads; f.view.render(); assert.equal(f.reads - before, 1); assert.equal(f.visible.at(-1).ids.length, 10);
    before = f.reads; assert.equal(f.view.revealFont('11'), true); assert.equal(f.reads - before, 1); assert.equal(f.view.captureSession().page, 1);
    before = f.reads; await f.click('previous'); assert.equal(f.reads - before, 1);
    f.setState({ ...input, previewText: '新样字', entries: input.entries.map(font => ({ ...font, name: `最新 ${font.id}` })) });
    before = f.reads; f.view.render(); assert.equal(f.reads - before, 1); assert.match(f.root.innerHTML, /最新 0/); assert.match(f.root.innerHTML, /新样字/); f.view.destroy();
});
test('master enable is the first card, add collapses as a unit and search directly precedes multi-select', () => {
    const html = renderFontLibrary(state()); assert.ok(html.indexOf('data-font-enabled') < html.indexOf('qm-font-web-label'));
    assert.match(html, /class="sd-card qm-font-enable"[\s\S]*data-font-enabled aria-label="启用字体库" checked[\s\S]*data-font-sync-originals aria-label="同步本地字体原件"/);
    assert.doesNotMatch(html, /仅在开启后上传到当前 ST 账户/); assert.doesNotMatch(renderFontLibrary(state({ enabled: false })), /data-font-enabled[^>]*checked/);
    assert.match(html, /<details class="sd-card qm-font-add"><summary>/); assert.doesNotMatch(html, /Web 引入|字体链接或样式/); assert.match(html, />字体链接<\/span>/);
    assert.ok(html.indexOf('data-font-search') < html.indexOf('data-font-action="manage"')); assert.doesNotMatch(html, /data-font-action="filter"/);
    assert.match(html, /class="sd-card qm-font-preview-editor"/); assert.match(html, /data-font-preview-size/);
    assert.match(renderFontLibraryCards(state({ previewText: '' })), /一蝶振翅，万象入幕。/);
});
test('fixed fonts expose edit/delete directly while variable fonts keep them inside more', async () => {
    const fixed = id => entry(id, { weights: ['400'], styles: ['normal'] }), f = fixture(state({ entries: [fixed('one'), fixed('two')] })), html = f.root.innerHTML;
    assert.equal((html.match(/data-font-action="delete-one"/g) || []).length, 2); assert.doesNotMatch(html, /data-font-action="more"/);
    const collapsed = renderFontLibraryCards(state()); assert.match(collapsed, /data-font-action="more"/); assert.doesNotMatch(collapsed, /data-font-action="edit"|data-font-action="delete-one"/);
    await f.click('delete-one', { fontId: 'two' }); await f.click('delete-one', { fontId: 'missing' }); assert.deepEqual(f.calls, [{ type: 'delete-font', id: 'two' }]); f.view.destroy();
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

test('scope pickers start with no implicit selection and can reapply the same scope after changing a preview', async () => {
    const f = fixture(state({ body: { enabled: true, fontId: 'one', weight: '400', style: 'normal' } })); assert.ok(f.applyPickers.every(picker => picker.selectedIndex === -1)); assert.equal(f.calls.length, 0);
    await f.apply('body'); f.emit('input', f.node('[data-font-weight]', { value: '1', dataset: { fontWeight: 'one' } })); await f.apply('body'); assert.deepEqual(f.calls.map(call => [call.type, call.target, call.weight]), [['apply-font', 'body', '400'], ['apply-font', 'body', '700']]);
    await f.apply(''); await f.apply('restore-shared'); assert.equal(f.calls.length, 2); f.view.destroy();
});
test('web source drafts survive rejected and unrelated updates with precise trusted errors', async () => {
    const f = fixture(state(), () => { throw Object.assign(Error('PRIVATE RAW'), { userMessage: '未找到可用的字体声明。' }); });
    f.node('[data-font-web-name]', { value: '我的字体' }); f.node('[data-font-web-source]', { value: '@import url(https://example.test/fonts.css);' });
    f.node('[data-font-web-tags]', { value: '阅读， 中文, 阅读' }); const before = f.root.innerHTML; await f.click('add-web'); assert.deepEqual(f.calls[0], { type: 'add-web', name: '我的字体', source: '@import url(https://example.test/fonts.css);', tags: ['阅读', '中文'] });
    assert.equal(f.root.innerHTML, before); assert.equal(f.notices.at(-1)?.text, '未找到可用的字体声明。'); f.view.render(); assert.match(f.root.innerHTML, /value="我的字体"/); assert.equal(f.view.captureSession().webTags, '阅读， 中文, 阅读'); f.view.destroy();
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

test('missing historic Web source uses a concise preservation hint that survives return and clears with editing', async () => {
    const f = fixture(state({ entries: [entry('one', { editableSource: '', editableSourceMissing: true })] })); await f.click('edit', { fontId: 'one' }); assert.match(f.root.innerHTML, /placeholder="留空保留当前来源；替换时粘贴新链接"/);
    const captured = f.view.captureSession(); assert.equal(captured.editWebSourceMissing, true); assert.equal(captured.webSource, ''); const reopened = fixture(state(), () => {}, captured); assert.match(reopened.root.innerHTML, /留空保留当前来源/); reopened.view.destroy();
    await f.click('add-web'); assert.deepEqual(f.calls[0], { type: 'edit-web', id: 'one', name: '字体 one', source: '', tags: [] }); assert.equal(f.view.captureSession().editWebSourceMissing, false); assert.doesNotMatch(f.root.innerHTML, /留空保留当前来源/); f.view.destroy();
});
test('local edit preserves name and tag drafts across return and saves only the selected metadata', async () => {
    const f = fixture(state({ entries: [entry('one', { sourceType: 'local', tags: ['原标签'] })] })); await f.click('edit', { fontId: 'one' });
    assert.equal(f.view.captureSession().renameId, 'one'); f.emit('input', f.node('[data-font-rename]', { value: '本地新名称', dataset: { fontRename: 'one' } }));
    f.emit('input', f.node('[data-font-rename-tags]', { value: '衬线， 阅读,衬线', dataset: { fontRenameTags: 'one' } }));
    const restored = fixture(state(), () => {}, f.view.captureSession()); assert.match(restored.root.innerHTML, /value="本地新名称"/); assert.match(restored.root.innerHTML, /value="衬线， 阅读,衬线"/); restored.view.destroy();
    await f.click('rename-save', { fontId: 'one' }); assert.deepEqual(f.calls, [{ type: 'update-fonts', ids: ['one'], name: '本地新名称', tags: ['衬线', '阅读'] }]); assert.equal(f.view.captureSession().renameId, ''); assert.equal(f.view.captureSession().renameTags, '');
    await f.click('edit', { fontId: 'one' }); await f.click('rename-cancel', { fontId: 'one' }); assert.equal(f.calls.length, 1); assert.equal(f.view.captureSession().renameId, ''); f.view.destroy();
});
test('reveal clears blocking filters, selects the new ten-item page and cannot reopen a closed view', () => {
    const initial = state({ entries: Array.from({ length: 11 }, (_, index) => entry(String(index), { folder: index ? '' : '筛选', tags: index ? [] : ['选中'] })) });
    const f = fixture(initial, () => {}, { query: '字体 0', folder: '筛选', tags: ['选中'] }); assert.deepEqual(f.visible[0].ids, ['0']); assert.equal(f.view.revealFont('10'), true);
    assert.deepEqual(f.visible.at(-1).ids, ['10']); const session = f.view.captureSession(); assert.equal(session.page, 1); assert.equal(session.query, ''); assert.equal(session.folder, undefined); assert.equal(session.tags, undefined); assert.equal(f.calls.length, 0); assert.equal(f.view.revealFont('missing'), false);
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
    assert.match(f.root.innerHTML, /data-font-local-tags="0"[^>]*placeholder="如：宋体,黑体，多个标签用逗号分隔"/);
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

test('failed local upload keeps all metadata and shows its trusted error through the shared toast', async () => {
    const f = fixture(state(), () => { throw Object.assign(Error('PRIVATE'), { userMessage: '每个标签最多 80 字。' }); });
    await f.emit('change', f.node('[data-font-file]', { files: [{ name: '<bad>.woff2' }], dataset: { fontFile: 'local' } })); f.emit('input', f.node('[data-font-local-name]', { value: '本地稿', dataset: { fontLocalName: '0' } })); f.emit('input', f.node('[data-font-local-tags]', { value: '长'.repeat(81), dataset: { fontLocalTags: '0' } }));
    await f.click('local-confirm'); assert.deepEqual(f.notices, [{ text: '每个标签最多 80 字。', level: 'warning' }]); assert.equal(f.calls[0].metadata[0].tags[0].length, 81); f.view.render();
    assert.match(f.root.innerHTML, /value="本地稿"/); assert.match(f.root.innerHTML, /&lt;bad&gt;.woff2/); assert.doesNotMatch(f.root.innerHTML, /<bad>/); await f.click('local-cancel'); assert.equal(f.calls.length, 1); f.view.destroy();
});

test('Escape during confirmed local save does not pretend to cancel an in-flight commit', async () => {
    let resolve; const f = fixture(state(), () => new Promise(done => { resolve = done; })), file = f.node('[data-font-file]', { files: [{ name: 'one.woff2' }], dataset: { fontFile: 'local' } }); await f.emit('change', file);
    const saving = f.click('local-confirm'); f.handlers.get('keydown')({ target: file, key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.match(f.root.innerHTML, /data-font-local-dialog/); await f.click('local-cancel'); assert.match(f.root.innerHTML, /data-font-local-dialog/); assert.equal(f.calls.length, 1);
    resolve(); await saving; assert.doesNotMatch(f.root.innerHTML, /data-font-local-dialog/); f.view.destroy();
});
test('management mode gates selection, exits clear it, and bulk tags preserve exact ids', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] }));
    await f.clickCard('two'); await f.click('delete'); assert.equal(f.calls.length, 0);
    await f.click('manage'); await f.clickCard('two'); f.node('[data-font-bulk-value]');
    await f.click('bulk-tags'); f.queries.get('[data-font-bulk-value]').value = '清楚，中文, 阅读 '; await f.click('bulk-save');
    await f.click('export-selected'); await f.click('delete');
    assert.deepEqual(f.calls, [{ type: 'update-fonts', ids: ['two'], tags: ['清楚', '中文', '阅读'] }, { type: 'export', ids: ['two'] }, { type: 'delete-fonts', ids: ['two'] }]);
    await f.click('manage'); await f.click('delete'); assert.equal(f.calls.length, 3); f.view.destroy();
});
test('page select is bounded to ten and management collapse clears all selections', async () => {
    const f = fixture(state({ entries: Array.from({ length: 11 }, (_, index) => entry(String(index))) })); await f.click('manage'); await f.click('select-page'); await f.click('export-selected');
    assert.deepEqual(f.calls[0], { type: 'export', ids: Array.from({ length: 10 }, (_, index) => String(index)) }); await f.click('manage'); await f.click('delete'); assert.equal(f.calls.length, 1); f.view.destroy();
});

test('multiple pages keep checked fonts and export exactly one combined selection', async () => {
    const f = fixture(state({ entries: Array.from({ length: 12 }, (_, index) => entry(String(index))) })); await f.click('manage'); await f.click('select-page'); await f.click('next');
    await f.clickCard('10'); await f.click('export-selected');
    assert.deepEqual(f.calls, [{ type: 'export', ids: Array.from({ length: 11 }, (_, index) => String(index)) }]); assert.equal(f.queries.get('[data-font-selection-count]').textContent, '已选 11');
    await f.click('select-page'); await f.click('select-page'); await f.click('previous'); await f.click('export-selected'); assert.deepEqual(f.calls[1], { type: 'export', ids: Array.from({ length: 10 }, (_, index) => String(index)) });
    await f.click('manage'); await f.click('export-selected'); assert.equal(f.calls.length, 2); f.view.destroy();
});

test('search and reveal clear transient choices, removed fonts are pruned and retired actions are inert', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] })); await f.click('manage'); await f.click('select-page');
    f.setState(state({ entries: [entry('two')] })); f.view.render(); await f.click('export-selected'); assert.deepEqual(f.calls[0], { type: 'export', ids: ['two'] });
    f.emit('input', f.node('[data-font-search]', { value: 'two' })); await f.click('export-selected'); assert.equal(f.calls.length, 1);
    await f.click('select-page'); f.view.revealFont('two'); await f.click('export-selected'); assert.equal(f.calls.length, 1);
    await f.click('export-all'); await f.click('bulk-folder'); await f.click('filter'); assert.equal(f.calls.length, 1); f.view.destroy();
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
    assert.equal(f.queries.get('.sd-body').scrollTop, 170); const captured = f.view.captureSession(); assert.equal(captured.page, 1); assert.equal(captured.scrollTop, 170); assert.equal(captured.tags, undefined); assert.equal(captured.folder, undefined); assert.equal(captured.managing, undefined); assert.equal(captured.selected, undefined);
    captured.variants['10'].weight = '100'; assert.equal(f.view.captureSession().variants['10'].weight, '623'); f.view.destroy();
});
test('field keyboard and focus events stop at the library without changing non-field behavior', () => {
    const f = fixture(), target = f.node('input,textarea,select'), stopped = [];
    for (const name of ['keydown', 'keyup', 'keypress', 'focusin']) f.handlers.get(name)({ target, key: 'x', stopPropagation: () => stopped.push(name) });
    assert.deepEqual(stopped, ['keydown', 'keyup', 'keypress', 'focusin']); f.handlers.get('keydown')({ target: f.node('button'), key: 'x', stopPropagation: () => stopped.push('bad') }); assert.equal(stopped.length, 4); f.view.destroy();
});
test('legacy folder and tag filters cannot strand the list behind an invisible filter', () => {
    const f = fixture(state({ entries: [entry('one', { folder: '旧目录', tags: ['旧标签'] }), entry('two')] }), () => {}, { folder: '旧目录', tags: ['旧标签'] });
    assert.deepEqual(f.visible[0].ids, ['one', 'two']); f.setState(state({ entries: [entry('two')] })); f.view.render(); assert.deepEqual(f.visible.at(-1).ids, ['two']); assert.equal(f.view.captureSession().folder, undefined); assert.equal(f.view.captureSession().tags, undefined); f.view.destroy();
});
test('status errors target only matching samples and unknown raw errors remain private', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] }), () => { throw Error('SECRET URL AND TOKEN'); }); f.view.setFontStatus('two', '来源暂不可访问'); assert.equal(f.statuses[0].textContent, ''); assert.equal(f.statuses[1].textContent, '来源暂不可访问');
    await f.click('manage'); await f.click('select-page'); await f.click('export-selected'); assert.equal(f.calls.length, 1); assert.ok(f.notices.at(-1)?.text); assert.doesNotMatch(f.notices.at(-1)?.text, /SECRET/); f.view.destroy();
});
test('pinned sequence is independent of numeric Chinese name sorting and stable equal-name ties', () => {
    const input = state({ entries: [entry('ten', { name: '字体10' }), entry('two', { name: '字体2' }), entry('equal-a', { name: 'a' }), entry('equal-b', { name: 'A' }), entry('pin-z', { name: 'z' }), entry('pin-a', { name: 'a' })], pinnedIds: ['pin-z', 'missing', 'pin-a', 'pin-z'] }), before = structuredClone(input);
    assert.deepEqual(sortFontLibraryEntries(input).map(value => value.id), ['pin-z', 'pin-a', 'two', 'ten', 'equal-a', 'equal-b']);
    assert.deepEqual(sortFontLibraryEntries({ ...input, sortOrder: 'desc' }).map(value => value.id), ['pin-z', 'pin-a', 'equal-a', 'equal-b', 'ten', 'two']);
    assert.deepEqual(input, before); assert.strictEqual(sortFontLibraryEntries(input)[0], input.entries[4]);
});
test('sort control is beside management and pin status stays recognizable without duplicate visible pins', () => {
    const input = state({ entries: [entry('one'), entry('fixed', { weights: ['400'], styles: ['normal'] })], pinnedIds: ['one', 'fixed'], sortOrder: 'desc' }), html = renderFontLibrary(input);
    assert.ok(html.indexOf('data-font-action="manage"') < html.indexOf('data-font-sort-order')); assert.match(html, /data-font-sort-order aria-label="字体排序"><option value="asc">名称正序<\/option><option value="desc" selected>名称倒序<\/option><option value="added-asc">添加时间正序<\/option><option value="added-desc">添加时间倒序/);
    const collapsed = renderFontLibraryCards(state({ pinnedIds: ['one'] })); assert.match(collapsed, /qm-font-pin-mark" aria-label="已置顶" title="已置顶">/); assert.doesNotMatch(collapsed, /data-font-action="pin"/);
    const expanded = renderFontLibraryCards(state({ pinnedIds: ['one'] }), { expandedId: 'one' }); assert.match(expanded, /qm-font-pin-mark"[^>]* hidden>/); assert.match(expanded, /data-font-action="pin"[^>]*aria-pressed="true"/);
    const fixed = renderFontLibraryCards(state({ entries: [entry('one', { weights: ['400'], styles: ['normal'] })], pinnedIds: ['one'] })); assert.match(fixed, /qm-font-pin-mark"[^>]* hidden>/); assert.match(fixed, /data-font-action="pin"[^>]*aria-pressed="true"/);
});
test('sorted reveal locates its actual page and pin toggles locate the moved font without losing multi-selection', async () => {
    let input = state({ entries: Array.from({ length: 12 }, (_, index) => entry(String(index))), pinnedIds: ['11'], sortOrder: 'desc' }), f;
    f = fixture(input, payload => { if (payload.type === 'set-font-pinned') { input = { ...input, pinnedIds: payload.pinned ? [...input.pinnedIds, payload.id] : input.pinnedIds.filter(id => id !== payload.id) }; f.setState(input); } });
    assert.equal(f.view.revealFont('0'), true); assert.equal(f.view.captureSession().page, 1); assert.deepEqual(f.visible.at(-1).ids, ['1', '0']);
    await f.click('manage'); await f.clickCard('0'); await f.click('pin', { fontId: '0' }); assert.deepEqual(f.calls[0], { type: 'set-font-pinned', id: '0', pinned: true }); assert.equal(f.view.captureSession().page, 0); assert.deepEqual(f.visible.at(-1).ids.slice(0, 2), ['11', '0']);
    await f.click('export-selected'); assert.deepEqual(f.calls[1], { type: 'export', ids: ['0'] }); await f.click('pin', { fontId: '0' }); assert.equal(f.calls[2].pinned, false); assert.equal(f.view.captureSession().page, 1); await f.click('export-selected'); assert.deepEqual(f.calls[3], { type: 'export', ids: ['0'] }); f.view.destroy();
});
test('sort success returns to its first page while keeping cross-page selection and failure restores persisted order', async () => {
    let input = state({ entries: Array.from({ length: 12 }, (_, index) => entry(String(index))), pinnedIds: ['5'] }), f;
    f = fixture(input, payload => { if (payload.type === 'set-sort-order') { input = { ...input, sortOrder: payload.order }; f.setState(input); } });
    await f.click('manage'); await f.clickCard('5'); await f.click('next'); await f.clickCard('11');
    await f.emit('change', f.node('[data-font-sort-order]', { value: 'desc' })); assert.equal(f.view.captureSession().page, 0); assert.deepEqual(f.visible.at(-1).ids.slice(0, 3), ['5', '11', '10']);
    await f.click('export-selected'); assert.deepEqual(f.calls.at(-1), { type: 'export', ids: ['5', '11'] }); f.view.destroy();
    const failed = fixture(state({ sortOrder: 'asc' }), () => { throw Error('failure'); }), picker = failed.node('[data-font-sort-order]', { value: 'desc' }); await failed.emit('change', picker); assert.equal(picker.value, 'asc'); assert.equal(failed.notices.at(-1)?.level, 'warning'); failed.view.destroy();
});

test('addition ordering uses preserved insertion sequence, leaves pins fixed and filters before pagination', () => {
    const input = state({ entries: [entry('first', { name: 'Z', tags: ['阅读'] }), entry('second', { name: 'A', tags: ['阅读'] }), entry('pin-a'), entry('last', { name: 'B', tags: ['阅读'] }), entry('pin-b')], pinnedIds: ['pin-b', 'pin-a'], sortBy: 'added' }), before = structuredClone(input);
    assert.deepEqual(sortFontLibraryEntries(input).map(item => item.id), ['pin-b', 'pin-a', 'first', 'second', 'last']);
    assert.deepEqual(sortFontLibraryEntries({ ...input, sortOrder: 'desc' }).map(item => item.id), ['pin-b', 'pin-a', 'last', 'second', 'first']);
    assert.deepEqual(selectFontLibraryPage({ ...input, sortOrder: 'desc' }, { query: '阅读' }).entries.map(item => item.id), ['last', 'second', 'first']);
    assert.deepEqual(input, before);
    const long = state({ entries: Array.from({ length: 12 }, (_, index) => entry(String(index))), pinnedIds: ['5'], sortBy: 'added', sortOrder: 'asc' });
    const asc = fixture(long); asc.view.revealFont('11'); assert.equal(asc.view.captureSession().page, 1); assert.deepEqual(asc.visible.at(-1).ids, ['10', '11']); asc.view.destroy();
    const desc = fixture({ ...long, sortOrder: 'desc' }); desc.view.revealFont('11'); assert.equal(desc.view.captureSession().page, 0); assert.deepEqual(desc.visible.at(-1).ids.slice(0, 3), ['5', '11', '10']); desc.view.destroy();
});

test('all four sort choices dispatch basis and direction, keep selection and restore full choice after failure', async () => {
    let input = state({ entries: [entry('first', { name: 'Z' }), entry('last', { name: 'A' })] }), f;
    f = fixture(input, payload => { if (payload.type === 'set-sort-order') { input = { ...input, sortBy: payload.by, sortOrder: payload.order }; f.setState(input); } });
    await f.click('manage'); await f.clickCard('first');
    for (const [value, by, order, ids] of [['asc', 'name', 'asc', ['last', 'first']], ['added-asc', 'added', 'asc', ['first', 'last']], ['added-desc', 'added', 'desc', ['last', 'first']], ['desc', 'name', 'desc', ['first', 'last']]]) {
        await f.emit('change', f.node('[data-font-sort-order]', { value }));
        assert.deepEqual(f.calls.at(-1), { type: 'set-sort-order', by, order }); assert.deepEqual(f.visible.at(-1).ids, ids);
        assert.match(f.root.innerHTML, new RegExp(`option value="${value}" selected`));
    }
    await f.click('export-selected'); assert.deepEqual(f.calls.at(-1), { type: 'export', ids: ['first'] });
    const count = f.calls.length; for (const value of ['', 'random', 'constructor']) await f.emit('change', f.node('[data-font-sort-order]', { value })); assert.equal(f.calls.length, count); f.view.destroy();
    const failed = fixture(state({ sortBy: 'added', sortOrder: 'desc' }), () => { throw Error('failure'); }), picker = failed.node('[data-font-sort-order]', { value: 'asc' });
    await failed.emit('change', picker); assert.equal(picker.value, 'added-desc'); assert.equal(failed.notices.at(-1)?.level, 'warning'); failed.view.destroy();
});

function attachCard(f, id) {
    const classes = new Set(), tools = { innerHTML: '', hidden: false, querySelectorAll: () => [] }, rename = { hidden: true }, marker = { hidden: true }, card = f.node('.qm-font-card', { dataset: { fontId: id }, classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } }, removeAttribute(name) { delete this[name]; }, querySelector: selector => selector === '.qm-font-card-tools' ? tools : selector === '[data-font-rename-pop]' ? rename : selector === '.qm-font-pin-mark' ? marker : null });
    f.allQueries.set('.qm-font-card', [...(f.allQueries.get('.qm-font-card') || []), card]);
    const target = (selector, fields = {}, area = '') => { const node = f.node(selector, fields); node.closest = candidate => candidate === selector ? node : candidate === '.qm-font-card' ? card : candidate === area ? tools : null; return node; };
    return { card, tools, rename, marker, classes, target, action: name => target('[data-font-action]', { dataset: { fontAction: name, fontId: id } }, '.qm-font-card-tools') };
}
test('more collapses on same-card text or outside input without rebuilding samples or swallowing another action', async () => {
    const f = fixture(state({ entries: [entry('one'), entry('two')] })), first = attachCard(f, 'one'), second = attachCard(f, 'two'), html = f.root.innerHTML, sample = f.samples[0], visits = f.visible.length;
    await f.emit('click', first.action('more')); assert.match(first.tools.innerHTML, /data-font-action="pin"/);
    const search = f.node('[data-font-search]', { value: '草稿', focus() { throw Error('outside input focus must not be stolen'); } }); await f.emit('click', search);
    assert.doesNotMatch(first.tools.innerHTML, /data-font-action="pin"/); assert.strictEqual(f.samples[0], sample); assert.equal(f.root.innerHTML, html); assert.equal(search.value, '草稿'); assert.equal(f.visible.length, visits);
    await f.emit('click', first.action('more')); await f.emit('click', second.action('more')); assert.doesNotMatch(first.tools.innerHTML, /data-font-action="pin"/); assert.match(second.tools.innerHTML, /data-font-action="pin"/);
    await f.emit('click', second.target('.qm-font-sample')); assert.doesNotMatch(second.tools.innerHTML, /data-font-action="pin"/);
    await f.emit('click', first.action('more')); await f.click('manage'); assert.equal(f.queries.get('.qm-font-bulk-actions').hidden, false); assert.doesNotMatch(first.tools.innerHTML, /data-font-action="pin"/); f.view.destroy();
});
test('local edit popup and weight controls keep more open, while outside and Escape preserve rename drafts', async () => {
    const f = fixture(state({ entries: [entry('one', { sourceType: 'local' })] })), linked = attachCard(f, 'one'); await f.emit('click', linked.action('more')); await f.emit('click', linked.action('edit'));
    const field = linked.target('[data-font-rename]', { value: '尚未提交的名字', dataset: { fontRename: 'one' } }, '[data-font-rename-pop]'); f.emit('input', field); await f.emit('click', field); assert.match(linked.tools.innerHTML, /data-font-action="pin"/);
    await f.emit('click', linked.target('[data-font-weight-pop]')); assert.match(linked.tools.innerHTML, /data-font-action="pin"/);
    await f.emit('click', f.node('[data-font-search]')); assert.equal(linked.rename.hidden, true); assert.equal(f.view.captureSession().renameDraft, '尚未提交的名字');
    await f.emit('click', linked.action('more')); assert.equal(linked.rename.hidden, false); let stopped = 0, prevented = 0; f.handlers.get('keydown')({ target: field, key: 'Escape', stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
    assert.equal(stopped, 1); assert.equal(prevented, 1); assert.equal(linked.rename.hidden, true); assert.equal(f.view.captureSession().renameDraft, '尚未提交的名字'); assert.equal(f.calls.length, 0); f.view.destroy(); assert.equal(f.handlers.size, 0);
});
test('management whole-card keyboard and pointer selection hide actions and restore regular cards on exit', async () => {
    const f = fixture(), linked = attachCard(f, 'one'); await f.click('manage'); assert.equal(linked.card.role, 'button'); assert.equal(linked.card.tabindex, '0'); assert.equal(linked.card['aria-pressed'], 'false'); assert.equal(linked.tools.hidden, true);
    let prevented = 0; f.handlers.get('keydown')({ target: linked.card, key: ' ', preventDefault() { prevented++; } }); assert.equal(linked.card['aria-pressed'], 'true'); assert.ok(linked.classes.has('is-selected'));
    f.handlers.get('keydown')({ target: linked.card, key: 'Enter', preventDefault() { prevented++; } }); assert.equal(linked.card['aria-pressed'], 'false'); assert.equal(prevented, 2);
    await f.emit('click', linked.target('.qm-font-name')); await f.click('export-selected'); assert.deepEqual(f.calls[0], { type: 'export', ids: ['one'] }); await f.click('manage'); assert.equal(linked.card.role, undefined); assert.equal(linked.card['aria-pressed'], undefined); assert.equal(linked.tools.hidden, false); assert.ok(!linked.classes.has('is-selected')); f.view.destroy();
});
test('back-to-top is immediately before next and scrolls only the font body without changing page/query/selection', async () => {
    const html = renderFontLibraryCards(state()); assert.match(html, /qm-font-page-end">[\s\S]*?data-font-action="top"[\s\S]*?data-font-action="next"/);
    const f = fixture(state({ entries: Array.from({ length: 12 }, (_, index) => entry(String(index))) }), () => {}, { page: 1, query: '字体', scrollTop: 180 });
    await f.click('manage'); await f.clickCard('10'); const body = f.queries.get('.sd-body'), calls = []; body.scrollTo = options => { calls.push(options); body.scrollTop = options.top; }; f.root.ownerDocument = { defaultView: { matchMedia: () => ({ matches: true }), scrollTo() { throw Error('host scroll forbidden'); } } };
    await f.click('top'); assert.deepEqual(calls, [{ top: 0, behavior: 'instant' }]); assert.equal(f.view.captureSession().page, 1); assert.equal(f.view.captureSession().query, '字体'); assert.equal(body.scrollTop, 0); await f.click('export-selected'); assert.deepEqual(f.calls[0], { type: 'export', ids: ['10'] });
    f.root.ownerDocument.defaultView.matchMedia = () => ({ matches: false }); await f.click('top'); assert.equal(calls[1].behavior, 'smooth'); f.view.destroy();
});
function attachTagEditor(f, key, value = '') {
    const editor = { dataset: { fontTagEditor: key } }, local = key.startsWith('local-'), rename = key.startsWith('rename-'), index = key.slice(6), renameId = key.slice(7), selector = key === 'web' ? '[data-font-web-tags]' : key === 'bulk' ? '[data-font-bulk-value]' : rename ? `[data-font-rename-tags="${renameId}"]` : `[data-font-local-tags="${index}"]`;
    const input = f.node(selector, { value, dataset: local ? { fontLocalTags: index } : rename ? { fontRenameTags: renameId } : {} }), panel = f.node('[data-font-tag-options]', { dataset: { fontTagOptions: key }, hidden: true, innerHTML: '' });
    if (rename) f.allQueries.set('[data-font-rename-tags]', [...(f.allQueries.get('[data-font-rename-tags]') || []), input]);
    input.matches = candidate => candidate === selector || (local && candidate === '[data-font-local-tags]') || (rename && candidate === '[data-font-rename-tags]');
    const link = node => { node.closest = candidate => candidate === '[data-font-action]' && node.dataset.fontAction ? node : candidate === '[data-font-tag-editor]' ? editor : candidate === '[data-font-local-dialog]' && local ? editor : candidate === '[data-font-rename-pop]' && rename ? editor : candidate === '.qm-font-card' && rename ? { dataset: { fontId: renameId } } : null; return node; };
    link(input); const button = link(f.node('[data-font-action]', { dataset: { fontAction: 'tags', fontTagTarget: key } }));
    f.allQueries.set('[data-font-tag-options]', [...(f.allQueries.get('[data-font-tag-options]') || []), panel]);
    f.allQueries.set('[data-font-action="tags"]', [...(f.allQueries.get('[data-font-action="tags"]') || []), button]);
    const controls = '[data-font-local-dialog] input,[data-font-local-dialog] button,[data-font-tag-editor] input,[data-font-tag-editor] button'; f.allQueries.set(controls, [...(f.allQueries.get(controls) || []), input, button]);
    return { input, panel, button, open: () => f.emit('click', button), toggle: tag => f.emit('click', link(f.node('[data-font-action]', { dataset: { fontAction: 'tag-toggle', fontTagTarget: key, fontTag: tag } }))) };
}
test('existing tag suggestions are account-local deduplicated metadata and render lazily in reusable fields', async () => {
    const input = state({ entries: [entry('one', { tags: ['正文', '标题', '正文'] }), entry('two', { tags: ['标题', '手写'] })], tags: ['not a tag registry'] }), before = structuredClone(input);
    assert.deepEqual(collectFontLibraryTags(input), ['正文', '标题', '手写']); assert.deepEqual(input, before);
    const html = renderFontLibrary(input); assert.match(html, /data-font-tag-editor="web"/); assert.match(html, /data-font-tag-editor="bulk"/); assert.doesNotMatch(html, /data-font-action="tag-toggle"/);
    const addIcon = html.match(/data-font-action="add-web"[\s\S]*?<\/button>/)?.[0]; assert.match(addIcon, /qm-regular-check/); assert.doesNotMatch(addIcon, /qm-regular-plus/);
    const editIcon = renderFontLibrary(input, { editWebId: 'one' }).match(/data-font-action="add-web"[\s\S]*?<\/button>/)?.[0]; assert.match(editIcon, /qm-regular-check/);
    const f = fixture(input), web = attachTagEditor(f, 'web'); await web.open(); assert.equal((web.panel.innerHTML.match(/data-font-action="tag-toggle"/g) || []).length, 3);
    f.setState(state({ entries: [entry('new', { tags: ['另一账户'] })] })); await web.open(); assert.equal(web.panel.innerHTML, ''); await web.open(); assert.match(web.panel.innerHTML, /另一账户/); assert.doesNotMatch(web.panel.innerHTML, /正文|标题|手写/); assert.equal(f.calls.length, 0); f.view.destroy();
});

test('local metadata uses existing tag suggestions only as a draft until explicit save and cancellation writes nothing', async () => {
    const initial = state({ entries: [entry('one', { sourceType: 'local', tags: ['阅读'], weights: ['400'], styles: ['normal'] }), entry('two', { tags: ['衬线'] })] }), f = fixture(initial);
    await f.click('edit', { fontId: 'one' }); const tags = attachTagEditor(f, 'rename-one', '阅读');
    await tags.open(); assert.match(tags.panel.innerHTML, /data-font-tag="衬线"/); await tags.toggle('衬线'); assert.equal(tags.input.value, '阅读, 衬线'); assert.equal(f.view.captureSession().renameTags, '阅读, 衬线'); assert.equal(f.calls.length, 0);
    f.handlers.get('keydown')({ target: tags.input, key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(tags.panel.hidden, true); assert.equal(f.view.captureSession().renameId, 'one');
    await f.click('rename-cancel', { fontId: 'one' }); assert.equal(f.calls.length, 0); assert.equal(f.view.captureSession().renameTags, '');
    await f.click('edit', { fontId: 'one' }); tags.input.value = ''; f.emit('input', tags.input); await f.click('rename-save', { fontId: 'one' });
    assert.deepEqual(f.calls, [{ type: 'update-fonts', ids: ['one'], name: '字体 one', tags: [] }]); assert.deepEqual(initial.entries[0].tags, ['阅读']); f.view.destroy();
});

test('unchanged local legacy comma tags stay intact and a failed metadata save retains exact raw drafts', async () => {
    const initial = state({ entries: [entry('one', { sourceType: 'local', tags: ['中文,西文', '装饰，标题'] })] }), f = fixture(initial);
    await f.click('edit', { fontId: 'one' }); f.emit('input', f.node('[data-font-rename]', { value: '只改名', dataset: { fontRename: 'one' } }));
    await f.click('rename-save', { fontId: 'one' }); assert.deepEqual(f.calls[0], { type: 'update-fonts', ids: ['one'], name: '只改名', tags: ['中文,西文', '装饰，标题'] }); f.view.destroy();
    const rejected = fixture(initial, () => { throw Error('failed save'); }); await rejected.click('edit', { fontId: 'one' });
    const tags = attachTagEditor(rejected, 'rename-one', ' 手写 ，重复,重复  '); rejected.emit('input', tags.input); rejected.emit('input', rejected.node('[data-font-rename]', { value: ' 未保存名称 ', dataset: { fontRename: 'one' } }));
    await tags.open(); assert.match(tags.panel.innerHTML, /data-font-tag-unavailable="true" disabled/); await rejected.click('rename-save', { fontId: 'one' });
    const savedSession = rejected.view.captureSession(); assert.equal(savedSession.renameDraft, ' 未保存名称 '); assert.equal(savedSession.renameTags, ' 手写 ，重复,重复  '); assert.equal(savedSession.renameId, 'one');
    const restored = fixture(initial, () => {}, savedSession); assert.match(restored.root.innerHTML, /value=" 手写 ，重复,重复  "/); assert.equal(rejected.notices.at(-1)?.level, 'warning'); restored.view.destroy(); rejected.view.destroy();
});

test('opening local metadata and tag collection scrolls only the font body enough for the full editor', async () => {
    const f = fixture(state({ entries: [entry('one', { sourceType: 'local', tags: ['阅读'], weights: ['400'], styles: ['normal'] })] })), body = f.queries.get('.sd-body');
    body.getBoundingClientRect = () => ({ top: 100, bottom: 400 }); let rect = { top: 350, bottom: 470, height: 120 }, focused;
    const panel = f.node('[data-font-rename-pop]', { dataset: { fontRenamePop: 'one' }, hidden: false, getBoundingClientRect: () => rect }); f.allQueries.set('[data-font-rename-pop]', [panel]);
    const name = f.node('[data-font-rename]', { dataset: { fontRename: 'one' }, focus: options => { focused = options; } }); f.allQueries.set('[data-font-rename]', [name]);
    f.root.ownerDocument = { defaultView: { scrollTo() { throw Error('host scroll forbidden'); } } };
    await f.click('edit', { fontId: 'one' }); assert.equal(body.scrollTop, 76); assert.deepEqual(focused, { preventScroll: true });
    const tags = attachTagEditor(f, 'rename-one', '阅读'); rect = { top: 200, bottom: 440, height: 240 }; await tags.open(); assert.equal(body.scrollTop, 122); assert.equal(f.calls.length, 0);
    await tags.open(); rect = { top: 100, bottom: 240, height: 140 }; await tags.open(); assert.equal(body.scrollTop, 116); f.view.destroy();
});

test('pending local metadata saves disable both fields and buttons without consuming newer raw drafts', async () => {
    let finish; const f = fixture(state({ entries: [entry('one', { sourceType: 'local', tags: ['阅读'] })] }), () => new Promise(resolve => { finish = resolve; })); await f.click('edit', { fontId: 'one' });
    const name = f.node('[data-font-rename]', { value: '已提交名称', dataset: { fontRename: 'one' }, closest: selector => selector === '[data-font-rename-pop]' ? {} : null }), tags = attachTagEditor(f, 'rename-one', '阅读'); f.emit('input', name);
    const save = f.node('[save]'), cancel = f.node('[cancel]'); f.allQueries.set('[data-font-rename-pop] input,[data-font-rename-pop] button', [name, tags.input, save, cancel]);
    const pending = f.click('rename-save', { fontId: 'one' }); assert.ok([name, tags.input, save, cancel].every(node => node.disabled));
    f.node('[data-font-cards]', { set innerHTML(_html) { for (const node of [name, tags.input, save, cancel]) node.disabled = false; } }); f.emit('input', f.node('[data-font-search]', { value: '字体' }));
    assert.ok([name, tags.input, save, cancel].every(node => node.disabled), 'search redraw reapplies the pending editor disabled state');
    name.value = '不应覆盖'; tags.input.value = '不应覆盖'; f.emit('input', name); f.emit('input', tags.input); assert.equal(f.view.captureSession().renameDraft, '已提交名称'); assert.equal(f.view.captureSession().renameTags, '阅读');
    finish(); await pending; assert.ok([name, tags.input, save, cancel].every(node => !node.disabled)); assert.deepEqual(f.calls[0], { type: 'update-fonts', ids: ['one'], name: '已提交名称', tags: ['阅读'] }); f.view.destroy();
});
test('opening, outside clicks and Escape preserve raw tag text; only explicit chip toggles normalize a draft', async () => {
    const f = fixture(state({ entries: [entry('one', { tags: ['手写', '重复', '新增'] })] })), raw = ' 手写 ，重复,重复  ', web = attachTagEditor(f, 'web', raw), original = web.input;
    await web.open(); assert.equal(web.input.value, raw); assert.match(web.panel.innerHTML, /data-font-tag="手写" aria-pressed="true"/);
    await f.emit('click', f.node('[data-font-web-name]', { value: '首击继续', focus() { throw Error('input focus stolen'); } })); assert.equal(web.panel.hidden, true); assert.equal(web.panel.innerHTML, ''); assert.strictEqual(web.input, original); assert.equal(web.input.value, raw);
    await web.open(); f.handlers.get('keydown')({ target: web.input, key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(web.panel.hidden, true); assert.equal(web.input.value, raw); assert.equal(f.calls.length, 0);
    await web.open(); await web.toggle('新增'); assert.equal(web.input.value, '手写, 重复, 新增'); assert.equal(f.calls.length, 0); await web.toggle('重复'); assert.equal(web.input.value, '手写, 新增');
    web.input.value = '重复，新增,重复'; f.emit('input', web.input); assert.match(web.panel.innerHTML, /data-font-tag="重复" aria-pressed="true"/); assert.match(web.panel.innerHTML, /data-font-tag="手写" aria-pressed="false"/); assert.equal(web.input.value, '重复，新增,重复');
    await f.click('add-web'); assert.deepEqual(f.calls[0], { type: 'add-web', name: '首击继续', source: '', tags: ['重复', '新增'] }); f.view.destroy();
});
test('tag picker escapes long metadata, rejects ambiguous comma tags and the thirty-third tag without truncating', async () => {
    const unsafe = '"><img src=x onerror=alert(1)>', long = '很长'.repeat(40), values = Array.from({ length: 33 }, (_, index) => `标签${index}`), f = fixture(state({ entries: [entry('one', { tags: [...values, unsafe, long, '中，文', 'a,b'] })] })), web = attachTagEditor(f, 'web', values.slice(0, 32).join(', '));
    await web.open(); assert.doesNotMatch(web.panel.innerHTML, /<img|<script/); assert.match(web.panel.innerHTML, /&lt;img/); assert.match(web.panel.innerHTML, /data-font-tag="中，文"[^>]*disabled[^>]*title="标签含逗号/); assert.match(web.panel.innerHTML, /data-font-tag="a,b"[^>]*disabled/);
    const before = web.input.value; await web.toggle('标签32'); await web.toggle('中，文'); assert.equal(web.input.value, before); assert.match(f.notices.at(-1)?.text, /最多 32/);
    await web.toggle('标签0'); await web.toggle('标签32'); assert.equal(web.input.value.split(', ').length, 32); assert.ok(!web.input.value.split(', ').includes('标签0')); assert.ok(web.input.value.endsWith('标签32')); assert.equal(f.calls.length, 0); f.view.destroy();
});
test('local upload pickers isolate files and Escape closes the current picker before canceling the uncommitted upload', async () => {
    const f = fixture(state({ entries: [entry('one', { tags: ['正文', '标题'] })] })), files = [{ name: 'first.woff2' }, { name: 'second.ttf' }]; await f.emit('change', f.node('[data-font-file]', { files, dataset: { fontFile: 'local' } }));
    const first = attachTagEditor(f, 'local-0'), second = attachTagEditor(f, 'local-1'); await first.open(); await first.toggle('正文'); await second.open(); assert.equal(first.panel.hidden, true); assert.equal(first.panel.innerHTML, ''); assert.equal(first.input.value, '正文'); await second.toggle('标题'); assert.equal(second.input.value, '标题');
    f.handlers.get('keydown')({ target: second.input, key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(second.panel.hidden, true); assert.match(f.root.innerHTML, /data-font-local-dialog/); assert.equal(f.calls.length, 0);
    await f.click('local-confirm'); assert.deepEqual(f.calls[0], { type: 'add-local', files, metadata: [{ name: 'first', tags: ['正文'] }, { name: 'second', tags: ['标题'] }] }); f.view.destroy();
    const cancelled = fixture(state({ entries: [entry('one', { tags: ['正文'] })] })); await cancelled.emit('change', cancelled.node('[data-font-file]', { files, dataset: { fontFile: 'local' } })); const tags = attachTagEditor(cancelled, 'local-0'); await tags.open(); await tags.toggle('正文');
    for (let index = 0; index < 2; index++) cancelled.handlers.get('keydown')({ target: tags.input, key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.doesNotMatch(cancelled.root.innerHTML, /data-font-local-dialog/); assert.equal(cancelled.calls.length, 0); cancelled.view.destroy();
});
test('bulk picker edits only the draft until the existing selected-font save, and switching management cancels it', async () => {
    const f = fixture(state({ entries: [entry('one', { tags: ['正文'] }), entry('two', { tags: ['标题'] })] })); await f.click('manage'); await f.clickCard('two'); await f.click('bulk-tags');
    const bulk = attachTagEditor(f, 'bulk'); await bulk.open(); await bulk.toggle('正文'); assert.equal(f.calls.length, 0); assert.equal(bulk.input.value, '正文'); await f.click('bulk-save'); assert.deepEqual(f.calls[0], { type: 'update-fonts', ids: ['two'], tags: ['正文'] });
    await f.click('bulk-tags'); await bulk.open(); await bulk.toggle('标题'); await f.click('manage'); assert.equal(bulk.panel.hidden, true); assert.equal(f.calls.length, 1); f.view.destroy();
});
test('empty suggestions stay concise and busy mutations disable tag drafts without swallowing modal focus boundaries', async () => {
    let resolve; const f = fixture(state(), () => new Promise(done => { resolve = done; })), web = attachTagEditor(f, 'web', '未保存'); await web.open(); assert.match(web.panel.innerHTML, /暂无已有标签/); assert.equal(web.input.value, '未保存');
    f.setState(state({ entries: [entry('one', { tags: ['已有'] })] })); await web.open(); await web.open(); const pending = f.click('add-web'); assert.equal(web.input.disabled, true); assert.equal(web.button.disabled, true); await web.toggle('已有'); assert.equal(web.input.value, '未保存'); resolve(); await pending; assert.equal(web.input.disabled, false); f.view.destroy();
    const local = fixture(); await local.emit('change', local.node('[data-font-file]', { files: [{ name: 'one.ttf' }], dataset: { fontFile: 'local' } })); let focused = '';
    const first = local.node('[first]', { focus() { focused = 'first'; } }), last = local.node('[last]', { focus() { focused = 'last'; } }), hidden = local.node('[hidden-chip]', { closest: selector => selector === '[hidden]' ? {} : null, focus() { throw Error('hidden chip received focus'); } });
    local.allQueries.set('[data-font-local-dialog] input,[data-font-local-dialog] button', [first, last, hidden]); local.handlers.get('keydown')({ target: last, key: 'Tab', preventDefault() {} }); assert.equal(focused, 'first'); local.handlers.get('keydown')({ target: first, key: 'Tab', shiftKey: true, preventDefault() {} }); assert.equal(focused, 'last'); local.view.destroy();
});
test('local metadata editor occupies card layout only while open rather than overlapping sibling cards', async () => {
    const css = await readFile(new URL('../qianmu-font-library.css', import.meta.url), 'utf8');
    const editor = css.match(/\.qm-font-library \.qm-font-rename-pop \{[^}]+\}/)?.[0] || '';
    assert.match(editor, /display:flex; flex-direction:column; gap:8px; width:100%/); assert.doesNotMatch(editor, /position:absolute|z-index|top:|right:/);
    assert.doesNotMatch(css, /\.qm-font-library \.qm-font-card \{[^}]*z-index/);
    assert.doesNotMatch(css, /qm-font-card:has\(>\.qm-font-rename-pop/); assert.match(css, /\.qm-font-library \[hidden\] \{ display:none !important; \}/);
});

test('CSS adds layout and sample controls without rewriting theme fonts or old floor shell', async () => {
    const css = await readFile(new URL('../qianmu-font-library.css', import.meta.url), 'utf8');
    assert.match(css, /\.qm-font-window \.qm-font-header/); assert.match(css, /\.qm-font-weight-pop/); assert.match(css, /\.qm-font-sample \{[^}]*font-size:18px/); assert.match(css, /@media\(max-width:440px\)/);
    assert.doesNotMatch(css, /font-family\s*:|\.mes_text|body\s*\{|html\s*\{/); assert.match(css, /\.qm-font-file-pick>input\[type="file"\]/);
    assert.match(css, /#story-director-floor-nav\.qm-font-library-open \.sd-floor-panel \{ display:none !important; \}/); assert.match(css, /grid-template-columns:minmax\(0,1fr\) auto/);
    assert.match(css, /\.qm-font-library :where\(input:not/); assert.match(css, /qm-font-apply-pick\)>select[^}]*opacity:0/); assert.match(css, /\.qm-font-card-foot \{[^}]*flex-wrap:wrap/);
    assert.match(css, /\.qm-font-entry>small \{[^}]*white-space:nowrap;[^}]*text-overflow:ellipsis/); assert.match(css, /\.qm-font-header h2[^}]*font-size:16px !important/);
    assert.match(css, /data-qm-theme="glass"\] \.qm-font-window \.qm-font-header \.qm-font-icon \{ border-radius:50% !important/); assert.match(css, /data-qm-theme="editorial"\][^\n]*border-radius:0 !important/);
    assert.match(css, /:is\(input\[data-font-enabled\],input\[data-font-sync-originals\]\)[^}]*border-radius:999px !important/); assert.match(css, /qm-font-imports \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/); assert.match(css, /input::placeholder,[\s\S]*?font-size:12px !important/);
    assert.match(css, /\.qm-font-tag \{[^}]*max-width:100%;[^}]*overflow-wrap:anywhere/); assert.doesNotMatch(css, /\.qm-font-folder-menu/);
    assert.match(css, /\.qm-font-preview-editor \.qm-font-field-head \{ justify-content:space-between;/); assert.match(css, /\.qm-font-local-files \{[^}]*overflow:auto/); assert.match(css, /\.qm-font-local-dialog>footer \{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(css, /:is\(input\[data-font-enabled\],input\[data-font-sync-originals\]\)::before \{ content:none !important; display:none !important/); assert.match(css, /:is\(input\[data-font-enabled\],input\[data-font-sync-originals\]\)::after \{[^}]*width:16px !important;[^}]*clip-path:none !important;[^}]*transform:none !important/); assert.match(css, /:is\(input\[data-font-enabled\],input\[data-font-sync-originals\]\):checked::after \{ transform:translateX\(16px\) !important/);
    assert.match(css, /\.qm-font-add>summary::marker \{ content:""; \}/); assert.match(css, /\.qm-font-add>summary::-webkit-details-marker \{ display:none; \}/); assert.match(css, /\.qm-font-name>strong \{[^}]*font-weight:400 !important/); assert.match(css, /:is\(\.qm-font-card-tools,\.qm-font-rename-pop\) \.qm-font-icon \{ background:none !important; border:0 !important; box-shadow:none !important/);
    assert.match(css, /\.qm-font-local-dialog \{[^}]*background:var\(--qm-raised,var\(--sd-sticky-bg,#f7f3eb\)\) !important/);
    assert.doesNotMatch(css, /\.qm-font-local-dialog \{[^}]*background:[^;]*--sd-folder-head/);
    assert.match(css, /\.qm-font-list \{[^}]*gap:6px/); assert.match(css, /\.sd-reader-lib\.qm-font-library \{ gap:6px; \}/); assert.match(css, /\.qm-font-tag-options \{[^}]*max-height:160px;[^}]*overflow:auto/); assert.match(css, /\.qm-font-tag-choice \{[^}]*max-width:100%;[^}]*overflow-wrap:anywhere/); assert.match(css, /\.qm-font-tag-choice\[aria-pressed="true"\]/);
});
