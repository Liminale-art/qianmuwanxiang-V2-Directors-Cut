// C-17：1.59.504 反馈——测试预览按 ST 语义、编辑页布局、行内⋯横向展开、工具条卡、管理多选/导入导出、
// 内嵌预设目录、归类同名桥接、原生列表同步。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const { previewRegexScript, parseRegexLiteral, createChatRegex } = await import('../features/chat/qianmu-chat-regex.js');

// 用户附件「（A选一）电报状态栏」的查找/替换（节选关键结构，查找串原样：不带斜杠）。
const TELEGRAM_FIND = ':::newspaper\\s*([^|｜#\\/\\n]+?)\\s*[|｜]\\s*([^|｜#\\/\\n]+?)\\s*[|｜]\\s*([^#\\/\\n]+?)\\s*\\/\\s*([^#\\n]+?)\\s*#\\s*([^#\\n]+?)\\s*#\\s*([^#]+?)\\s*#\\s*([^#✦✧\\n]+?)\\s*[✦✧]\\s*([\\s\\S]*?)\\s*:::';
const TELEGRAM_REPLACE = '<div class="np-weather-log"><b>$5</b><span>$1</span><span>$2</span><span>$3</span><span>$4</span><b>$7</b><b>$8</b><i>“ $6 ”</i>$9</div>';
const SAMPLE = ':::newspaper 1年-1月-1日|星期日|第214年又7个月 / A & B # 晨雾与铁轨的岔路 # 隔夜的茶汤凉透于旧书页，远行者踏碎第一缕晨霜 # 伊斯坦布尔·欧洲岸 ✦ 海雾弥漫的破晓 :::';

test('s1: unslashed findRegex is a raw pattern like ST, so the status-bar sample actually transforms', () => {
  const out = previewRegexScript({ findRegex: TELEGRAM_FIND, replaceString: TELEGRAM_REPLACE, trimStrings: [] }, SAMPLE);
  assert.equal(out.ok, true);
  assert.notEqual(out.output, SAMPLE, '不再原样输出');
  assert.ok(out.output.startsWith('<div class="np-weather-log">'), '替换为状态栏 HTML');
  assert.ok(out.output.includes('<b>晨雾与铁轨的岔路</b>'), '$5 = 标题');
  assert.ok(out.output.includes('<span>1年-1月-1日</span><span>星期日</span><span>第214年又7个月</span><span>A & B</span>'), '$1-$4');
  assert.ok(out.output.includes('<b>伊斯坦布尔·欧洲岸</b><b>海雾弥漫的破晓</b>'), '$7 / $8');
  assert.ok(out.output.includes('“ 隔夜的茶汤凉透于旧书页，远行者踏碎第一缕晨霜 ”'), '$6');
  assert.ok(out.output.endsWith('</i></div>'), '不存在的 $9 替换为空（同 ST）');
});

test('s1: slashed literals keep flags; duplicate/unknown flags fall back like ST regexFromString', () => {
  assert.equal(parseRegexLiteral('/x/gi').flags, 'gi');
  assert.equal(previewRegexScript({ findRegex: '/x/g', replaceString: 'y' }, 'xx').output, 'yy');
  assert.equal(previewRegexScript({ findRegex: 'x', replaceString: 'y' }, 'xx').output, 'yx', '无斜杠无 g：只替换第一处（同 ST）');
  assert.equal(previewRegexScript({ findRegex: 'a+', replaceString: '[$0]' }, 'caaab').output, 'c[aaa]b', '无斜杠的元字符照样生效');
});

test('s2: CSS — whole-panel fullscreen, theme radius, macro/depth columns, one placement per row, test frame', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.sd-floor-panel\.qm-regex-field-full :is\(\.qm-regex-field, \.qm-regex-test\)\.is-full \{[^}]*position: absolute; inset: 0;/, '全屏层以面板为包含块铺满');
  assert.match(css, /\.sd-floor-panel\.qm-regex-field-full \.qm-regex-editor \{ position: static;/, '编辑器让出定位基准');
  assert.match(css, /:is\(\.qm-regex-textarea, \.qm-regex-hl,[^)]*\) \{ border-radius: var\(--qm-button-radius, 8px\); \}/, '文本域圆角随主题');
  assert.match(css, /\.qm-regex-macro-row \{ display: grid; grid-template-columns: minmax\(0, 11em\)/, '查找宏收窄、深度并排');
  assert.ok(css.includes('.qm-regex-testframe'), '美化预览 iframe 样式');
});

// —— 视图测试用的最小 DOM ——
function fakeST({ global = [], preset = [], presetName = '预设A', presets = null } = {}) {
  const log = { saves: 0, presetWrites: [], reloads: 0 };
  let presetList = structuredClone(preset);
  const manager = { apiId: 'openai', getSelectedPresetName: () => presetName,
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? presetList : null),
    writePresetExtensionField: async ({ path, value }) => { log.presetWrites.push({ path, value }); presetList = value; } };
  if (presets) manager.getAllPresets = () => presets;
  const ctx = { extensionSettings: { regex: structuredClone(global) }, getPresetManager: () => manager,
    getCurrentChatId: () => 'chat-1', reloadCurrentChat: async () => { log.reloads += 1; },
    saveSettingsDebounced: () => { log.saves += 1; } };
  return { ctx, log, preset: () => presetList };
}
const manualTimers = () => {
  const queue = new Map(); let next = 1;
  return { set(fn, ms) { const id = next++; queue.set(id, { fn, ms }); return id; }, clear(id) { queue.delete(id); },
    flush() { const all = [...queue.values()]; queue.clear(); all.forEach(t => t.fn()); } };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };
function fakeDom() {
  const docListeners = {};
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', type: '', placeholder: '', scrollTop: 0, hidden: false,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(...cs) { cs.forEach(c => this.set.delete(c)); }, contains(c) { return this.set.has(c); },
        toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); return this.set.has(c); } },
      style: { setProperty() {}, removeProperty() {} },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type) { delete this.listeners[type]; },
      contains(other) { return walkAll(this).includes(other); },
      querySelector() { return null; },
      querySelectorAll(sel) { const cls = String(sel).replace(/^\./, ''); return walkAll(this).filter(n => n !== this && n.classList?.contains(cls)); },
      closest() { return null; }, getBoundingClientRect() { return { height: 400, top: 0, bottom: 30, left: 0, right: 100 }; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const host = make('div');
  host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }), defaultView: {},
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter(f => f !== fn); } };
  host.docListeners = docListeners;
  return host;
}
const byKey = (host, key) => walkAll(host).find(n => n.dataset?.key === key);
async function openEditor(data) {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const st = fakeST({ global: [{ id: 'g1', scriptName: data.scriptName || 'A' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const stub = { ...ctrl.actions, readScript: () => structuredClone(data), closeEditor: () => {}, preview: (s, i) => previewRegexScript(s, i) };
  const view = mountChatRegexView({ root: host, actions: stub });
  view.render(Object.freeze({ ...ctrl.state(), editing: { isNew: false, source: 'global', id: 'g1', name: data.scriptName || 'A' } }));
  return { host, view };
}

test('s2: test section — expand icon right after the 测试 title, no inner 测试 label, whole section goes fullscreen', async () => {
  const { host, view } = await openEditor({ scriptName: 'A', findRegex: '/a/g', replaceString: 'b' });
  const lead = walkAll(host).find(n => n.classList?.contains('qm-regex-test-lead'));
  assert.ok(lead, '标题组');
  assert.equal(lead.children[0].textContent, '测试');
  assert.ok(lead.children[1].classList.contains('qm-regex-expand'), '全屏图标紧跟标题');
  const section = walkAll(host).find(n => n.classList?.contains('qm-regex-test'));
  const labels = walkAll(section).filter(n => n.classList?.contains('qm-regex-field-label'));
  assert.equal(labels.length, 0, '测试区内不再有多余的「测试」小标题');
  lead.children[1].listeners.click();
  assert.ok(section.classList.contains('is-full'), '全屏的是整个测试区');
  lead.children[1].listeners.click();
  assert.ok(!section.classList.contains('is-full'));
  view.dispose();
});

test('s2: 作用范围 one option per row; 深度 controls sit under their label', async () => {
  const { host, view } = await openEditor({ scriptName: 'A', placement: [1, 2] });
  const grids = walkAll(host).filter(n => n.classList?.contains('qm-regex-optgrid'));
  assert.equal(grids.length, 2);
  assert.ok(grids.every(g => g.classList.contains('qm-regex-optgrid-col')), '作用范围与其他选项都一项一行');
  const depths = walkAll(host).find(n => n.classList?.contains('qm-regex-depths'));
  assert.equal(depths.children[0].textContent, '深度');
  assert.ok(depths.children[1].classList.contains('qm-regex-depth-pair'), '最小/最大在标题下方');
  view.dispose();
});

async function mountList(state = {}, extra = {}) {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const calls = [];
  const stub = { ...ctrl.actions, pickMove: a => calls.push(['pick', a]), openEditor: a => calls.push(['edit', a]), ...extra };
  const view = mountChatRegexView({ root: host, actions: stub });
  view.render(Object.freeze({ ...ctrl.state(), ...state }));
  return { host, view, calls, ctrl };
}

test('s3: non-manage row = [move grip][name][strip][⋯][switch]; grip picks the row', async () => {
  const { host, view, calls } = await mountList();
  const rowNode = walkAll(host).find(n => n.classList?.contains('qm-regex-row') && n.dataset.id === 'g1');
  assert.ok(rowNode.children[0].classList.contains('qm-regex-rowgrip'), '移动图标在行首');
  assert.equal(rowNode.children[0].dataset.key, 'pick:global:g1');
  const tail = rowNode.children[2];
  assert.ok(tail.classList.contains('qm-regex-rowtail'));
  assert.deepEqual(tail.children.map(n => [...n.classList.set].find(c => /rowstrip|rowmenu|qm-regex-switch/.test(c))), ['qm-regex-rowstrip', 'qm-regex-rowmenu', 'qm-regex-switch'], '⋯ 在拨杆之前');
  rowNode.children[0].listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['pick', { source: 'global', items: [{ source: 'global', id: 'g1', name: 'A' }] }]);
  view.dispose();
});

test('s3: ⋯ opens an icon-only horizontal strip; outside pointerdown closes it and removes the listener', async () => {
  const { host, view, calls } = await mountList();
  const menu = byKey(host, 'rowmenu:global:g1');
  const strip = walkAll(host).find(n => n.classList?.contains('qm-regex-rowstrip'));
  assert.equal(walkAll(strip).filter(n => n.classList?.contains('qm-regex-rowpop-text')).length, 0, '无文字');
  assert.ok(walkAll(strip).filter(n => n.tagName === 'button').every(b => b.attrs['aria-label']), '图标按钮有无障碍名');
  menu.listeners.click();
  assert.ok(strip.classList.contains('is-open'));
  assert.equal(menu.attrs['aria-expanded'], 'true');
  assert.equal(host.docListeners.pointerdown.length, 1);
  host.docListeners.pointerdown[0]({ target: strip.children[0] });
  assert.ok(strip.classList.contains('is-open'), '点条内不收起');
  host.docListeners.pointerdown[0]({ target: host });
  assert.ok(!strip.classList.contains('is-open'), '点其他处收起');
  assert.equal(host.docListeners.pointerdown.length, 0, '监听已清理');
  menu.listeners.click();
  byKey(host, 'rowedit:global:g1').listeners.click(); await settle();
  assert.ok(!strip.classList.contains('is-open'), '点操作后收起');
  assert.deepEqual(calls.at(-1), ['edit', { source: 'global', id: 'g1', name: 'A' }]);
  menu.listeners.click();
  view.dispose();
  assert.equal(host.docListeners.pointerdown.length, 0, 'dispose 清理');
});

test('s3: manage row puts the move grip first, before the checkbox', async () => {
  const { host, view } = await mountList({ managing: true });
  const rowNode = walkAll(host).find(n => n.classList?.contains('qm-regex-row') && n.dataset.id === 'g1');
  assert.ok(rowNode.classList.contains('is-managing'));
  assert.equal(rowNode.children[0].dataset.key, 'pick:global:g1');
  assert.equal(rowNode.children[1].dataset.key, 'sel:global:g1');
  assert.ok(!walkAll(rowNode.children[3]).some(n => n.dataset?.key === 'pick:global:g1'), '行尾不再重复移动图标');
  view.dispose();
});

test('s3: CSS — leading grip column, horizontal strip, drop line without breathing', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.qm-regex-row\.is-writable \{ grid-template-columns: 24px minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.qm-regex-row\.is-managing \{ grid-template-columns: 24px 22px minmax\(0, 1fr\) auto;/);
  assert.ok(!/qm-regex-drop[^{]*\{[^}]*animation:/.test(css), '落点线无动画');
  assert.ok(!css.includes('qm-regex-rowpop {'), '旧竖向浮层已移除');
});

test('s4: tools row wrapped in qm-regex-card-tools, keeps space-between', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.qm-regex-tools \{ display: flex; align-items: center; justify-content: space-between;/, 'space-between');
  const { host, view } = await mountList();
  const card = host.children[0];
  assert.ok(card.classList.contains('qm-regex-card-tools'));
  assert.ok(card.children[0].classList.contains('qm-regex-tools'));
  view.dispose();
});

test('s4: selbar wrapped in qm-regex-seldock (sticky frosted square); selbar no longer sticky', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.qm-regex-seldock \{ position: sticky; top: 0; z-index: 3;/, 'dock sticky');
  assert.match(css, /backdrop-filter: blur\(8px\)/, 'backdrop');
  assert.match(css, /\.qm-regex-seldock.*border-radius: 0;/, 'square');
  assert.ok(!css.match(/\.qm-regex-selbar \{.*position: sticky/), 'selbar itself no longer sticky');
  const { host, view } = await mountList({ managing: true });
  const dock = walkAll(host).find(n => n.classList?.contains('qm-regex-seldock'));
  assert.ok(dock);
  assert.ok(dock.children[0].classList.contains('qm-regex-selbar'));
  view.dispose();
});

test('s5: managing mode shows groupCheck button in card head', async () => {
  const { host, view } = await mountList({ managing: true });
  const cards = walkAll(host).filter(n => n.classList?.contains('qm-regex-card') && !n.classList?.contains('qm-regex-card-tools') && n.dataset?.key !== 'recycle');
  assert.ok(cards.length > 0, 'at least one card');
  const gc = walkAll(cards[0]).find(n => n.classList?.contains('qm-regex-groupcheck'));
  assert.ok(gc, 'groupCheck exists');
  assert.strictEqual(gc.getAttribute('role'), 'checkbox');
  view.dispose();
});

test('s5: groupCheck has all/some/none states', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.qm-regex-groupcheck-all/, 'all state class');
  assert.match(css, /\.qm-regex-groupcheck-some/, 'some state class');
  const { host, view } = await mountList({ managing: true });
  const gc = walkAll(host).find(n => n.classList?.contains('qm-regex-groupcheck'));
  assert.ok(gc);
  const state = gc.classList.contains('qm-regex-groupcheck-all') ? 'all' : gc.classList.contains('qm-regex-groupcheck-some') ? 'some' : 'none';
  assert.ok(['all', 'some', 'none'].includes(state), `has valid state: ${state}`);
  view.dispose();
});

test('s5: selbar exports the selection; import sits in each card head and targets that source', async () => {
  const calls = [];
  const { host, view } = await mountList({ managing: true, selected: ['global:g1'] },
    { importMany: a => calls.push(['import', a]), exportMany: a => calls.push(['export', a]) });
  const dock = walkAll(host).find(n => n.classList?.contains('qm-regex-seldock'));
  assert.ok(dock);
  const bar = dock.children[0];
  assert.ok(bar.classList.contains('qm-regex-selbar'));
  assert.ok(!byKey(host, 'sel-act:import'), '导入不在多选栏（没选中时也要能用）');
  byKey(host, 'sel-act:export').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['export', { items: [{ source: 'global', id: 'g1', name: 'A' }] }]);
  const importBtn = byKey(host, 'import:global');
  assert.ok(importBtn && !importBtn.disabled, '卡头导入按钮');
  importBtn.listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['import', { source: 'global' }]);
  view.dispose();
});

test('s5: managing group head carries its own tri-state checkbox that selects just that group', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const st = fakeST({ global: [{ id: 'a', scriptName: '群聊-外框' }, { id: 'b', scriptName: '群聊-正文' }, { id: 'c', scriptName: '独立' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const picked = [];
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, setSelected: (keys, on) => picked.push([keys, on]) } });
  view.render(Object.freeze({ ...ctrl.state(), managing: true, selected: ['global:a'] }));
  const check = byKey(host, 'groupcheck:global:群聊');
  assert.ok(check, '组头有全选框');
  assert.equal(check.attrs['aria-checked'], 'mixed', '选了一半 = 半选');
  check.listeners.click({ stopPropagation() {} });
  assert.deepEqual(picked.at(-1), [['global:a', 'global:b'], true], '只选本组');
  assert.equal(byKey(host, 'groupcheck:global').attrs['aria-checked'], 'mixed', '卡头全选框管整个来源');
  view.dispose();
});

test('s5: import appends parsed scripts through the normal write path; export hands a native-format file', async () => {
  const { parseRegexImport, buildRegexExport } = await import('../features/chat/qianmu-chat-regex.js');
  const parsed = parseRegexImport(['{"id":"g1","scriptName":"新","findRegex":"a"}', '[{"scriptName":"二","findRegex":"/b/g","disabled":true}, 3]', 'not json'], { taken: ['g1'], makeId: () => 'fresh' });
  assert.deepEqual(parsed.scripts.map(s => s.scriptName), ['新', '二']);
  assert.equal(parsed.scripts[0].id, 'fresh', '与已有 id 撞车时换新 id，不覆盖已有条目');
  assert.deepEqual(parsed.scripts[1].placement, [2], '缺省字段补齐');
  assert.equal(parsed.scripts[1].disabled, true);
  assert.equal(parsed.skipped, 2);
  assert.equal(buildRegexExport([]), null);
  assert.deepEqual(JSON.parse(buildRegexExport([{ id: 'x', scriptName: 'a/b' }]).json), { id: 'x', scriptName: 'a/b' }, '单条 = 脚本对象（ST 原生格式）');
  assert.equal(buildRegexExport([{ scriptName: 'a/b' }]).name, 'regex-a_b.json');
  assert.equal(JSON.parse(buildRegexExport([{ id: 'x' }, { id: 'y' }]).json).length, 2, '多条 = 数组');

  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', findRegex: 'a' }, { id: 'g2', scriptName: 'B', findRegex: 'b' }] });
  const notes = [], files = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, t) => notes.push([m, t]),
    pickFiles: async () => ['{"id":"g1","scriptName":"导入的","findRegex":"x"}'], saveFile: file => files.push(file) });
  assert.equal(await ctrl.actions.importMany({ source: 'global' }), 1);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.scriptName), ['A', 'B', '导入的'], '追加到末尾');
  assert.notEqual(st.ctx.extensionSettings.regex[2].id, 'g1');
  assert.equal(st.log.saves, 1, '一次保存');
  assert.equal(notes.at(-1)[1], 'success');
  assert.equal(await ctrl.actions.exportMany({ items: [{ source: 'global', id: 'g2', name: 'B' }] }), 1);
  assert.equal(JSON.parse(files[0].json).scriptName, 'B');
  // 取消选文件 = 什么都不做；文件里没有正则 = 提示、不写盘。
  const idle = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, t) => notes.push([m, t]), pickFiles: async () => [] });
  assert.equal(await idle.actions.importMany({ source: 'global' }), 0);
  const junk = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, t) => notes.push([m, t]), pickFiles: async () => ['{}'] });
  assert.equal(await junk.actions.importMany({ source: 'global' }), 0);
  assert.equal(notes.at(-1)[1], 'warning');
  assert.equal(st.log.saves, 1, '无效文件不写盘');
});

test('s6: preset directory is an inline directory control (not a floating overlay)', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(!css.match(/\.qm-regex-preset-menu.*position: absolute/), 'no absolute positioning');
  assert.ok(!/\.qm-regex-preset-dir \{[^}]*position: (absolute|fixed)/.test(css), '目录不是浮层');
  assert.match(css, /\.qm-regex-preset-box\.is-open > \.qm-regex-preset-dir \{ display: flex; \}/, '顶行展开整个目录');
  assert.match(css, /\.qm-regex-preset-group\.is-open > \.qm-regex-preset-group-body \{ display: flex; \}/, '组可单独展开');
  const presetState = { presets: { available: true, names: ['preset-a', 'preset-b'], current: 'preset-a' } };
  const presetActions = { selectPreset: () => {} };
  const { host, view } = await mountList(presetState, presetActions);
  const box = walkAll(host).find(n => n.classList?.contains('qm-regex-preset-box'));
  assert.ok(box, 'box exists');
  const trigger = walkAll(box).find(n => n.classList?.contains('qm-regex-preset-trigger'));
  const dir = walkAll(box).find(n => n.classList?.contains('qm-regex-preset-dir'));
  assert.ok(trigger, 'trigger exists');
  assert.ok(dir, 'dir exists');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false', 'initially collapsed');
  assert.ok(box.children.includes(dir), '目录是盒子的直接子节点，is-open 选择器才匹配得到');
  view.dispose();
});

test('s6: carets rotate right when expanded (not down)', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.qm-regex-preset-trigger\[aria-expanded="true"\] \.qm-regex-preset-caret,[^{]*\.qm-regex-preset-group-caret \{ transform: rotate\(90deg\); \}/, 'right rotation on expand');
});

test('s8: a group interrupted by 1-2 foreign rows is bridged back into one run (user case: 群聊 / 不发送群聊 / 群聊-功能)', async () => {
  const { groupAdjacentRegex } = await import('../features/chat/qianmu-chat-regex.js');
  const list = ['群聊-外框（日间）', '群聊-外框（夜间）', '群聊-正文（简约头像）', '（10）不发送群聊', '群聊-功能（系统）', '群聊-功能（内部）', '(A选一)电报状态栏', '(A选一)月台状态栏']
    .map((name, i) => ({ id: `r${i}`, name }));
  const runs = groupAdjacentRegex(list);
  assert.deepEqual(runs.map(r => [r.label, r.items.length]), [['群聊', 6], ['状态栏', 2]], '群聊不再被拆成两段');
  assert.deepEqual(runs.flatMap(r => r.items), list, '不重排、不丢不重');
  const tagged = groupAdjacentRegex(['群聊-甲', '群聊-乙', '【其他】丙', '群聊-丁', '群聊-戊'].map((name, i) => ({ id: `t${i}`, name })));
  assert.deepEqual(tagged.map(r => r.items.length), [2, 1, 2], '手动【标签】的条目不被吞并');
  const paired = groupAdjacentRegex(['群聊-甲', '群聊-乙', '状态栏-a', '状态栏-b', '群聊-丁', '群聊-戊'].map((name, i) => ({ id: `p${i}`, name })));
  assert.deepEqual(paired.map(r => r.label), ['群聊', '状态栏', '群聊'], '夹着的两条自成一类时不吞并');
});

test('s9: writes are mirrored onto ST\'s already-rendered native regex list (checkbox, removal, order) without events', async () => {
  const { syncNativeRegexList } = await import('../features/chat/qianmu-chat-regex.js');
  const nativeRow = id => { const check = { checked: false }; const node = { id, check, getAttribute: k => (k === 'id' ? id : null), querySelector: sel => (sel === '.disable_regex' ? check : null), remove() { box.children = box.children.filter(n => n !== node); } }; return node; };
  const box = { children: [], appendChild(node) { this.children = this.children.filter(n => n !== node); this.children.push(node); } };
  box.children = [nativeRow('g1'), nativeRow('g2'), nativeRow('gone')];
  const doc = { getElementById: id => (id === 'saved_regex_scripts' ? box : null) };
  const st = fakeST({ global: [{ id: 'g2', scriptName: 'B', disabled: true }, { id: 'g1', scriptName: 'A' }, { id: 'new', scriptName: 'N' }] });
  assert.equal(syncNativeRegexList(st.ctx, { root: doc }), 2);
  assert.deepEqual(box.children.map(n => n.id), ['g2', 'g1'], '已删条目移除、顺序对齐；新条目留给 ST 自己重画');
  assert.deepEqual(box.children.map(n => n.check.checked), [true, false], '勾选态 = disabled');
  // 认不出的列表（没有任何 id 对得上）一律不动。
  const alien = { children: [nativeRow('zzz')], appendChild() { throw new Error('不应改动'); } };
  assert.equal(syncNativeRegexList(st.ctx, { root: { getElementById: () => alien } }), 0);
  assert.equal(alien.children.length, 1);
  assert.equal(syncNativeRegexList(st.ctx, { root: { getElementById: () => null } }), 0, '原生面板不在：跳过');
});
