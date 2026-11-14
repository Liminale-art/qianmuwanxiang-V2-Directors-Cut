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
