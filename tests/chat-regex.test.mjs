import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  stripOrdinal, regexGroupKey, groupRegexScripts, summarizeRegexScript, readRegexSources, createChatRegex, UNGROUPED_LABEL,
} from '../features/chat/qianmu-chat-regex.js';

const root = new URL('../', import.meta.url);
const names = list => list.map(item => item.name);
const items = (...list) => list.map(name => ({ name }));

test('stripOrdinal drops only trailing sibling numbers', () => {
  assert.equal(stripOrdinal('美化-1'), '美化');
  assert.equal(stripOrdinal('美化_2'), '美化');
  assert.equal(stripOrdinal('美化（3）'), '美化');
  assert.equal(stripOrdinal('美化(3)'), '美化');
  assert.equal(stripOrdinal('美化#4'), '美化');
  assert.equal(stripOrdinal('美化 5'), '美化');
  assert.equal(stripOrdinal('v2版'), 'v2版', '中间的数字不动');
  assert.equal(stripOrdinal('  '), '');
});

test('regexGroupKey clusters by bracket tag, first separator, or ordinal-stripped name', () => {
  assert.equal(regexGroupKey('状态栏-隐藏'), '状态栏');
  assert.equal(regexGroupKey('状态栏_美化'), '状态栏');
  assert.equal(regexGroupKey('【小剧场】折叠'), '小剧场');
  assert.equal(regexGroupKey('思维链-去除思考'), '思维链');
  assert.equal(regexGroupKey('xxx-1'), 'xxx');
  assert.equal(regexGroupKey('xxx-2'), 'xxx');
  assert.equal(regexGroupKey('单独一条'), '单独一条');
});

test('groupRegexScripts needs two members per group and keeps the rest under 未分组 in original order', () => {
  const list = items('xxx-1', '独立A', '状态栏-隐藏', 'xxx-2', '独立B', '状态栏-美化', 'xxx-去除yyy');
  const groups = groupRegexScripts(list);
  assert.deepEqual(groups.map(g => g.label), ['xxx', '状态栏', UNGROUPED_LABEL]);
  assert.deepEqual(names(groups[0].items), ['xxx-1', 'xxx-2', 'xxx-去除yyy']);
  assert.deepEqual(names(groups[1].items), ['状态栏-隐藏', '状态栏-美化']);
  assert.deepEqual(names(groups[2].items), ['独立A', '独立B']);
  assert.deepEqual(groupRegexScripts([]), []);
  assert.deepEqual(groupRegexScripts(null), []);
  // Grouping never loses or duplicates a script.
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), list.length);
});

test('summarizeRegexScript reads ST script fields without trusting their shape', () => {
  const s = summarizeRegexScript({ id: 'a', scriptName: ' 美化 ', disabled: true, placement: [1, 2, 99], markdownOnly: true });
  assert.deepEqual({ ...s, placement: [...s.placement] }, { id: 'a', name: '美化', enabled: false, placement: ['用户输入', 'AI 输出'], scope: '仅显示' });
  const blank = summarizeRegexScript(null, 3);
  assert.equal(blank.id, '#3');
  assert.equal(blank.name, '（未命名）');
  assert.equal(blank.enabled, true);
});

test('readRegexSources reads global + current preset and marks a preset that is not allowed', () => {
  const manager = { apiId: 'openai', getSelectedPresetName: () => '我的预设', readPresetExtensionField: ({ path }) => path === 'regex_scripts' ? [{ id: 'p1', scriptName: '预设-1' }] : null };
  const ctx = { extensionSettings: { regex: [{ id: 'g1', scriptName: '全局' }], preset_allowed_regex: { openai: [] } }, getPresetManager: () => manager };
  const read = readRegexSources(ctx);
  assert.equal(read.global.available, true);
  assert.deepEqual(names(read.global.items), ['全局']);
  assert.equal(read.preset.available, true);
  assert.equal(read.preset.name, '我的预设');
  assert.equal(read.preset.allowed, false);
  assert.deepEqual(names(read.preset.items), ['预设-1']);
  ctx.extensionSettings.preset_allowed_regex.openai = ['我的预设'];
  assert.equal(readRegexSources(ctx).preset.allowed, true);
});

test('readRegexSources degrades when ST lacks preset regex or throws', () => {
  const old = readRegexSources({ extensionSettings: { regex: [] } });
  assert.equal(old.preset.available, false, '没有 getPresetManager → 标为不支持');
  assert.equal(old.global.available, true);
  const broken = readRegexSources({ get extensionSettings() { throw new Error('boom'); }, getPresetManager: () => ({ readPresetExtensionField() { throw new Error('x'); } }) });
  assert.equal(broken.global.available, false);
  assert.equal(broken.preset.available, true);
  assert.deepEqual([...broken.preset.items], []);
  assert.equal(readRegexSources(undefined).global.available, false);
});

test('regex module is read-only: never writes to ST settings or calls save', async () => {
  const src = await readFile(new URL('features/chat/qianmu-chat-regex.js', root), 'utf8');
  const view = await readFile(new URL('features/chat/qianmu-chat-regex-view.js', root), 'utf8');
  for (const code of [src, view]) {
    assert.ok(!/saveSettings|writePresetExtensionField|\.disabled\s*=[^=]/.test(code), '本片只读，不写回');
  }
});

test('createChatRegex lazily mounts the view, refreshes on view switch, and tears down', async () => {
  const renders = [];
  let loads = 0, disposed = 0;
  const ctrl = createChatRegex({
    getContext: () => ({ extensionSettings: { regex: [{ scriptName: 'a-1' }, { scriptName: 'a-2' }] } }),
    loadView: async () => { loads += 1; return { mountChatRegexView: () => ({ render: s => renders.push(s), dispose: () => { disposed += 1; } }) }; },
  });
  assert.equal(loads, 0, '打开工具包前不加载视图');
  const host = { isConnected: true };
  await ctrl.mount(host);
  assert.equal(loads, 1);
  assert.equal(renders.at(-1).view, 'order');
  assert.equal(renders.at(-1).sources.global.items.length, 2);
  ctrl.actions.setView('group');
  assert.equal(renders.at(-1).view, 'group');
  ctrl.actions.setView('bogus');
  assert.equal(renders.at(-1).view, 'order');
  await ctrl.mount(host);
  assert.equal(loads, 1, '同一宿主再挂载只刷新');
  ctrl.unmount();
  assert.equal(disposed, 1);
  ctrl.dispose();
  await ctrl.mount({ isConnected: false });
  assert.equal(disposed, 1);
});

test('view renders both sections, grouped headers and a not-supported notice', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { this.listeners[type] = fn; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const walk = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walk(k, out)); return out; };
  const host = make('div'); host.ownerDocument = { createElement: make };
  let picked = null;
  const ctrl = createChatRegex({ getContext: () => ({ extensionSettings: { regex: [{ scriptName: 'a-1' }, { scriptName: 'a-2', disabled: true }, { scriptName: '独立' }] } }) });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, setView: v => { picked = v; } } });
  view.render(Object.freeze({ ...ctrl.state(), view: 'group' }));
  const all = walk(host);
  const text = all.map(n => n.textContent).join('|');
  assert.ok(text.includes('全局正则') && text.includes('预设正则'));
  assert.ok(text.includes('a（2）') && text.includes(`${UNGROUPED_LABEL}（1）`), '分组头带数量');
  assert.ok(text.includes('当前 ST 版本不支持预设正则'), '无预设能力时降级提示');
  const rows = all.filter(n => n.classList.contains('qm-regex-row'));
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(n => n.classList.contains('is-off')).length, 1, '停用的条目变灰');
  const order = all.find(n => n.tagName === 'button' && n.textContent === '原始顺序');
  order.listeners.click();
  assert.equal(picked, 'order');
  view.dispose();
  assert.deepEqual(host.children, []);
});

test('chat toolkit has a lazily mounted 5th 正则 tab', async () => {
  const index = await readFile(new URL('index.js', root), 'utf8');
  assert.ok(index.includes('data-floor-tab="regex">正则</button>') && index.includes('data-floor-view="regex"></section>'));
  assert.equal(index.split("['layout', 'recovery', 'ring', 'regex'].includes(").length - 1, 2, '初始视图与 setView 都认 regex');
  assert.ok(index.includes(`if (floorNavigatorView === 'regex') void chatRegex.mount(`), '切到正则才挂载');
  assert.ok(index.includes('chatRegex.unmount();') && index.includes('chatRegex.dispose();'), '关闭工具包卸载，运行时销毁');
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('.sd-floor-tabs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));'), '五个页签等分');
});
