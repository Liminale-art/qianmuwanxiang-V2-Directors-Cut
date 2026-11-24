// C-17：1.59.504 反馈——测试预览按 ST 语义、编辑页布局、行内⋯横向展开、工具条卡、管理多选/导入导出、
// 内嵌预设目录、归类同名桥接、原生列表同步。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const { previewRegexScript, parseRegexLiteral, createChatRegex } = await import('../features/chat/qianmu-chat-regex.js');

// 合成样例（结构仿常见「信息栏」类正则：查找串不带斜杠、多捕获组、替换里引用不存在的 $n）。
const CARD_FIND = ':::card\\s*([^|｜\\n]+?)\\s*[|｜]\\s*([^|｜\\n]+?)\\s*[|｜]\\s*([^#\\n]+?)\\s*#\\s*([^#\\n]+?)\\s*:::';
const CARD_REPLACE = '<div class="qm-sample-card"><b>$4</b><span>$1</span><span>$2</span><span>$3</span>$5</div>';
const SAMPLE = ':::card 第一项 | 第二项 | 第三项 A & B # 卡片标题 :::';

test('s1: unslashed findRegex is a raw pattern like ST, so a card-style sample actually transforms', () => {
  const out = previewRegexScript({ findRegex: CARD_FIND, replaceString: CARD_REPLACE, trimStrings: [] }, SAMPLE);
  assert.equal(out.ok, true);
  assert.notEqual(out.output, SAMPLE, '不再原样输出');
  assert.ok(out.output.startsWith('<div class="qm-sample-card">'), '替换为卡片 HTML');
  assert.ok(out.output.includes('<b>卡片标题</b>'), '$4 = 标题');
  assert.ok(out.output.includes('<span>第一项</span><span>第二项</span><span>第三项 A & B</span>'), '$1-$3');
  assert.ok(out.output.endsWith('</span></div>'), '不存在的 $5 替换为空（同 ST）');
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
  assert.match(css, /\.qm-regex-macro-row \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, '查找宏与深度并排、撑满页宽（C-18）');
  assert.match(css, /\.is-full \{[^}]*border-radius: var\(--qm-regex-full-radius, 22px\)/, '全屏层圆角跟随面板（C-18）');
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
  const st = fakeST({ global: [{ id: 'a', scriptName: '会话-外框' }, { id: 'b', scriptName: '会话-正文' }, { id: 'c', scriptName: '独立' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const picked = [];
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, setSelected: (keys, on) => picked.push([keys, on]) } });
  view.render(Object.freeze({ ...ctrl.state(), managing: true, selected: ['global:a'] }));
  const check = byKey(host, 'groupcheck:global:会话');
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
  assert.match(css, /\.qm-regex-preset-group-head\[aria-expanded="true"\] \.qm-regex-preset-group-caret \{ transform: rotate\(90deg\); \}/, 'right rotation on expand');
  assert.ok(!css.includes('.qm-regex-preset-caret'), 'C-18：预设目录标题前不再有箭头');
  assert.ok(!/\.qm-regex-preset-group-body \{[^}]*border-left/.test(css), 'C-18：组内列表左侧无竖线');
});

test('s8: a group interrupted by 1-2 foreign rows is bridged back into one run (user case: 会话 / 不发送消息 / 会话-功能)', async () => {
  const { groupAdjacentRegex } = await import('../features/chat/qianmu-chat-regex.js');
  const list = ['会话-外框（日间）', '会话-外框（夜间）', '会话-正文（样式一）', '（10）不发送消息', '会话-功能（系统）', '会话-功能（内部）', '(A选一)报头信息栏', '(A选一)站台信息栏']
    .map((name, i) => ({ id: `r${i}`, name }));
  const runs = groupAdjacentRegex(list);
  assert.deepEqual(runs.map(r => [r.label, r.items.length]), [['会话', 6], ['信息栏', 2]], '会话不再被拆成两段');
  assert.deepEqual(runs.flatMap(r => r.items), list, '不重排、不丢不重');
  const tagged = groupAdjacentRegex(['会话-甲', '会话-乙', '【其他】丙', '会话-丁', '会话-戊'].map((name, i) => ({ id: `t${i}`, name })));
  assert.deepEqual(tagged.map(r => r.items.length), [2, 1, 2], '手动【标签】的条目不被吞并');
  const paired = groupAdjacentRegex(['会话-甲', '会话-乙', '信息栏-a', '信息栏-b', '会话-丁', '会话-戊'].map((name, i) => ({ id: `p${i}`, name })));
  assert.deepEqual(paired.map(r => r.label), ['会话', '信息栏', '会话'], '夹着的两条自成一类时不吞并');
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

// —— 快切·预设目录的批量删除 ——
// 仿 ST 原生 PresetManager.deletePreset：先从名单里摘掉（不查是否存在，-1 会摘掉最后一个），删的是正在用的就切到剩下的第一个，再告诉服务器。
function fakeDeleteST({ names = ['甲', '乙 v1', '乙 v2', '丙'], current = '甲', refuse = [] } = {}) {
  const log = { deleted: [], events: [], saves: 0 };
  const list = [...names]; let selected = current;
  const manager = { apiId: 'openai', getAllPresets: () => [...list], getSelectedPresetName: () => selected,
    findPreset: name => (list.includes(name) ? name : undefined), selectPreset: async value => { selected = value; },
    readPresetExtensionField: () => null,
    async deletePreset(name) { const target = name || selected; list.splice(list.indexOf(target), 1); if (selected === target && list.length) selected = list[0]; log.deleted.push(target); return !refuse.includes(target); } };
  const ctx = { extensionSettings: { regex: [] }, getPresetManager: () => manager, saveSettingsDebounced: () => { log.saves += 1; },
    eventSource: { emit: async (type, data) => { log.events.push([type, data.apiId, data.name]); } }, eventTypes: { PRESET_DELETED: 'preset_deleted' } };
  return { ctx, log, list: () => [...list], selected: () => selected };
}

test('presets are deleted through the native manager, the one in use last, unknown names never touched', async () => {
  const { deletePresets, dropPresetKeys } = await import('../features/chat/qianmu-chat-regex.js');
  const st = fakeDeleteST();
  const result = await deletePresets(st.ctx, ['甲', '丙', '不存在', '丙', '']);
  assert.deepEqual(st.log.deleted, ['丙', '甲'], '正在用的放最后删；不存在的不碰（原生会误删最后一个）');
  assert.deepEqual([...result.deleted], ['丙', '甲']); assert.deepEqual([...result.failed], []);
  assert.deepEqual(st.list(), ['乙 v1', '乙 v2']); assert.equal(st.selected(), '乙 v1', '删到正在用的：按 ST 原生切到剩下的第一个');
  assert.deepEqual(st.log.events, [['preset_deleted', 'openai', '丙'], ['preset_deleted', 'openai', '甲']], '和原生一样逐个发删除事件');
  assert.equal(st.log.saves, 1, '最后存一次设置');
  // 服务器没删成：算没删掉。
  const refused = fakeDeleteST({ refuse: ['丙'] });
  const partial = await deletePresets(refused.ctx, ['乙 v1', '丙']);
  assert.deepEqual([...partial.deleted], ['乙 v1']); assert.deepEqual([...partial.failed], ['丙']);
  await assert.rejects(deletePresets({ getPresetManager: () => ({ getAllPresets: () => [], getSelectedPresetName: () => '', findPreset() {}, selectPreset() {} }) }, ['甲']), /不支持/);
  const map = { 'preset:甲:p1': 1, 'preset:甲乙:p2': 2, 'global:g1': 3 };
  assert.deepEqual(dropPresetKeys(map, ['甲']), { 'preset:甲乙:p2': 2, 'global:g1': 3 }, '只去掉这个预设名下的');
  assert.equal(dropPresetKeys(map, ['丙']), map, '没变化时原样返回');
});

test('deleting presets clears their binding records: global defaults, this chat now, other chats when entered', async () => {
  const st = fakeDeleteST();
  let chat = 'chat-1', defaults = { 'preset:甲:p1': { enabled: true }, 'preset:丙:p9': { enabled: false }, 'global:g1': { enabled: true } };
  const bindings = { 'chat-1': { enabled: true, preset: '甲', overrides: { 'preset:甲:p1': { enabled: false }, 'global:g1': { enabled: false } } },
    'chat-2': { enabled: true, preset: '丙', overrides: { 'preset:丙:p9': { enabled: true }, 'global:g1': { enabled: true } } },
    'chat-3': { enabled: true, preset: '没删过', overrides: {} } };
  st.ctx.getCurrentChatId = () => chat;
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (message, type) => notes.push([message, type]),
    readBinding: () => bindings[chat], writeBinding: value => { bindings[chat] = value; }, readDefaults: () => defaults, writeDefaults: value => { defaults = value; } });
  assert.equal(await ctrl.actions.deletePresets(['甲', '丙']), 2);
  assert.deepEqual(defaults, { 'global:g1': { enabled: true } }, '全局默认里这两个预设名下的记录清掉');
  assert.deepEqual(bindings['chat-1'], { enabled: true, overrides: { 'global:g1': { enabled: false } } }, '当前聊天：绑定的预设与它名下的开关清掉，其余留着');
  assert.deepEqual(notes.at(-1), ['已删除 2 个预设', 'success']);
  assert.equal(ctrl.state().presets.busy, false);
  // 进到别的聊天：绑的是刚删掉的预设，顺手清掉、不提示；绑的是别处没了的预设，照旧提示一次。
  chat = 'chat-2'; ctrl.events.chatChanged(); await settle(); await settle();
  assert.deepEqual(bindings['chat-2'], { enabled: true, overrides: { 'global:g1': { enabled: true } } });
  assert.ok(!notes.some(([message]) => message.includes('「丙」无法切换')));
  chat = 'chat-3'; ctrl.events.chatChanged(); await settle(); await settle();
  assert.ok(notes.some(([message]) => message.includes('「没删过」无法切换')));
  assert.equal(bindings['chat-3'].preset, '没删过', '不是在这里删的就不动它的记录');
});

test('the preset directory offers multi-select delete: tick presets or a whole version group, then tap delete twice', async () => {
  const deleted = [];
  const presetState = { presets: { available: true, names: ['甲', '乙 v1', '乙 v2', '丙'], current: '甲', busy: false } };
  const { host, view } = await mountList(presetState, { selectPreset: () => assert.fail('多选时点预设不切换'), deletePresets: async names => { deleted.push(names); return names.length; } });
  const find = key => walkAll(host).find(n => n.dataset?.key === key);
  assert.ok(find('preset-manage'), '标题行有多选删除的开关');
  assert.equal(find('preset-manage').getAttribute('aria-label'), '多选删除');
  find('preset-manage').listeners.click();
  assert.ok(walkAll(host).find(n => n.classList?.contains('qm-regex-preset-box')).classList.contains('is-picking'));
  find('preset-pick:丙').listeners.click();
  assert.equal(find('preset-pick:丙').getAttribute('aria-checked'), 'true');
  // 整组勾选：一下勾上这一组的全部版本。
  find('preset-group-pick:乙').listeners.click();
  assert.equal(find('preset-group-pick:乙').getAttribute('aria-checked'), 'true');
  assert.equal(walkAll(host).find(n => n.classList?.contains('qm-regex-selbar-count')).textContent, '已选 3 个');
  // 删除点两下：第一下只是待确认。
  find('preset-del').listeners.click();
  assert.equal(deleted.length, 0); assert.equal(find('preset-del').getAttribute('data-armed'), 'true'); assert.equal(find('preset-del').title, '再点一次确认');
  find('preset-del').listeners.click(); await settle();
  assert.deepEqual(deleted, [['丙', '乙 v2', '乙 v1']]);
  assert.ok(!find('preset-del'), '删完退出多选');
  // 取消：清掉勾选、回到单选。
  find('preset-manage').listeners.click(); find('preset-pick:甲').listeners.click(); find('preset-pick-cancel').listeners.click();
  assert.ok(!find('preset-pick:甲') && !find('preset-del'));
  view.dispose();
});
