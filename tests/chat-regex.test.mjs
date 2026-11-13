import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  stripOrdinal, regexGroupKey, groupRegexScripts, summarizeRegexScript, readRegexSources, createChatRegex, UNGROUPED_LABEL,
  locateRegexScript, writeRegexToggle, REGEX_RELOAD_DELAY,
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

// A fake ST: global list on extensionSettings, preset list behind a preset manager that copies on write.
function fakeST({ global = [], preset = [], writePreset = true, save = true } = {}) {
  const log = { saves: 0, presetWrites: [], reloads: 0 };
  let presetList = structuredClone(preset);
  const manager = { apiId: 'openai', getSelectedPresetName: () => '预设A',
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? presetList : null) };
  if (writePreset) manager.writePresetExtensionField = async ({ path, value }) => { log.presetWrites.push({ path, value }); presetList = value; };
  const ctx = { extensionSettings: { regex: structuredClone(global) }, getPresetManager: () => manager,
    getCurrentChatId: () => 'chat-1', reloadCurrentChat: async () => { log.reloads += 1; } };
  if (save) ctx.saveSettingsDebounced = () => { log.saves += 1; };
  return { ctx, log, preset: () => presetList };
}
const manualTimers = () => {
  const queue = new Map(); let next = 1;
  return { set(fn, ms) { const id = next++; queue.set(id, { fn, ms }); return id; }, clear(id) { queue.delete(id); },
    get size() { return queue.size; }, get last() { return [...queue.values()].at(-1); },
    flush() { const all = [...queue.values()]; queue.clear(); all.forEach(t => t.fn()); } };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

test('readRegexSources marks a source writable only when ST exposes its save path', () => {
  assert.equal(readRegexSources(fakeST().ctx).global.writable, true);
  assert.equal(readRegexSources(fakeST().ctx).preset.writable, true);
  assert.equal(readRegexSources(fakeST({ save: false }).ctx).global.writable, false, '没有 saveSettingsDebounced → 全局只读');
  assert.equal(readRegexSources(fakeST({ writePreset: false }).ctx).preset.writable, false, '没有 writePresetExtensionField → 预设只读');
  assert.equal(readRegexSources({ extensionSettings: {} }).global.writable, false);
});

test('locateRegexScript matches by id, and a synthetic #index only while that slot keeps its name', () => {
  const list = [{ id: 'a', scriptName: 'A' }, { scriptName: '无ID' }, { id: 'c', scriptName: 'C' }];
  assert.equal(locateRegexScript(list, { id: 'c', name: 'C' }), 2);
  assert.equal(locateRegexScript(list, { id: '#1', name: '无ID' }), 1);
  assert.equal(locateRegexScript(list, { id: '#1', name: '别的' }), -1, '同位但名字变了 → 拒绝');
  assert.equal(locateRegexScript(list, { id: '#0', name: 'A' }), -1, '该位已有真实 id → 不按序号');
  assert.equal(locateRegexScript(list, { id: 'gone', name: 'x' }), -1);
  assert.equal(locateRegexScript(null, { id: 'a' }), -1);
});

test('global toggle flips disabled in ST extension settings and saves like ST does', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: '美化', disabled: false, findRegex: '/x/' }, { id: 'g2', scriptName: '其它' }] });
  assert.equal(await writeRegexToggle(st.ctx, { source: 'global', id: 'g1', name: '美化', enabled: false }), false);
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, true);
  assert.equal(st.ctx.extensionSettings.regex[0].findRegex, '/x/', '其它字段原样保留');
  assert.equal(st.ctx.extensionSettings.regex[1].disabled, undefined, '只动目标那一条');
  assert.equal(st.log.saves, 1);
  assert.equal(await writeRegexToggle(st.ctx, { source: 'global', id: 'g1', name: '美化', enabled: true }), true);
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, false);
});

test('preset toggle writes a fresh array through writePresetExtensionField', async () => {
  const st = fakeST({ preset: [{ id: 'p1', scriptName: '预设-1' }, { scriptName: '无ID', disabled: true }] });
  const before = st.preset();
  assert.equal(await writeRegexToggle(st.ctx, { source: 'preset', id: '#1', name: '无ID', enabled: true }), true);
  assert.equal(st.log.presetWrites.length, 1);
  assert.equal(st.log.presetWrites[0].path, 'regex_scripts');
  assert.notEqual(st.log.presetWrites[0].value, before, '写入新数组，不就地改 ST 设置对象');
  assert.equal(before[1].disabled, true, '原数组未被改动');
  assert.equal(st.preset()[1].disabled, false);
  assert.equal(st.preset()[0], before[0], '未改的条目保持原引用');
  assert.equal(st.log.saves, 0, '预设走 writePresetExtensionField 自己的保存');
});

test('writeRegexToggle refuses missing capabilities, stale rows and unknown sources', async () => {
  await assert.rejects(writeRegexToggle(fakeST({ save: false, global: [{ id: 'g' }] }).ctx, { source: 'global', id: 'g', enabled: false }), /不支持/);
  await assert.rejects(writeRegexToggle(fakeST({ writePreset: false, preset: [{ id: 'p' }] }).ctx, { source: 'preset', id: 'p', enabled: false }), /不支持/);
  await assert.rejects(writeRegexToggle(fakeST({ global: [{ id: 'g' }] }).ctx, { source: 'global', id: 'gone', enabled: false }), /已在别处被修改/);
  await assert.rejects(writeRegexToggle(fakeST().ctx, { source: 'character', id: 'x' }), /未知/);
});

test('controller toggle marks the row busy, refreshes, and reloads the chat once after a quiet window', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  const timers = manualTimers(), renders = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers,
    loadView: async () => ({ mountChatRegexView: () => ({ render: s => renders.push(s), dispose() {} }) }) });
  await ctrl.mount({ isConnected: true });
  const first = ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  assert.deepEqual([...renders.at(-1).pending], ['global:g1'], '写回期间该行忙碌');
  assert.equal(await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false }), null, '同一行重复点按被忽略');
  assert.equal(await first, false);
  assert.deepEqual([...renders.at(-1).pending], []);
  assert.equal(renders.at(-1).sources.global.items[0].enabled, false, '刷新后显示新状态');
  await ctrl.actions.toggle({ source: 'global', id: 'g2', name: 'B', enabled: false });
  assert.equal(timers.size, 1, '连续切换只排一次重载');
  assert.equal(timers.last.ms, REGEX_RELOAD_DELAY);
  assert.equal(st.log.reloads, 0);
  timers.flush(); await settle();
  assert.equal(st.log.reloads, 1);
  ctrl.dispose();
});

test('controller waits for an idle host before reloading and flushes a pending reload on close', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const timers = manualTimers();
  let idle = false;
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, canReload: () => idle,
    loadView: async () => ({ mountChatRegexView: () => ({ render() {}, dispose() {} }) }) });
  await ctrl.mount({ isConnected: true });
  await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  timers.flush(); await settle();
  assert.equal(st.log.reloads, 0, '生成中不重载');
  assert.equal(timers.size, 1, '顺延再试');
  idle = true;
  ctrl.unmount(); await settle();
  assert.equal(st.log.reloads, 1, '关闭工具包立即补上重载');
  assert.equal(timers.size, 0);
  ctrl.dispose();
});

test('controller reports write failures and never reloads for them', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const timers = manualTimers(), notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, notify: (m, k) => notes.push([m, k]),
    loadView: async () => ({ mountChatRegexView: () => ({ render() {}, dispose() {} }) }) });
  await ctrl.mount({ isConnected: true });
  assert.equal(await ctrl.actions.toggle({ source: 'global', id: 'missing', name: 'x', enabled: false }), null);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][1], 'warning');
  assert.equal(timers.size, 0);
  const noChat = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] }); noChat.ctx.getCurrentChatId = () => undefined;
  const c2 = createChatRegex({ getContext: () => noChat.ctx, timers, loadView: async () => ({ mountChatRegexView: () => ({ render() {}, dispose() {} }) }) });
  await c2.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  timers.flush(); await settle();
  assert.equal(noChat.log.reloads, 0, '没有打开的聊天就不重载');
  ctrl.dispose(); c2.dispose();
});

test('dispose cancels a pending reload', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const timers = manualTimers();
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers });
  await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  ctrl.dispose();
  assert.equal(timers.size, 0);
  await settle();
  assert.equal(st.log.reloads, 0);
});

test('regex view never writes to ST directly: only the controller owns the write path', async () => {
  const view = await readFile(new URL('features/chat/qianmu-chat-regex-view.js', root), 'utf8');
  assert.ok(!/saveSettings|writePresetExtensionField|extensionSettings|reloadCurrentChat|(?:script|item|\])\.disabled\s*=[^=]/.test(view), '视图只调 actions.toggle');
  assert.ok(view.includes('actions.toggle({ source, id: item.id, name: item.name, enabled: !item.enabled })'));
  const index = await readFile(new URL('index.js', root), 'utf8');
  assert.match(index, /createChatRegex\(\{getContext:ctx,notify:toast,canReload:\(\)=>\{const host=directorHostRuntime\(\)/, '重载前查询宿主是否空闲');
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
  assert.equal(all.filter(n => n.classList.contains('qm-regex-switch')).length, 0, '不可写时只显示状态圆点');
  assert.equal(all.filter(n => n.classList.contains('qm-regex-meta')).length, 0, '条目只显示正则名，不再显示作用位置摘要');
  assert.ok(!text.includes('未设作用位置') && !text.includes('AI 输出') && !text.includes('用户输入'));
  assert.equal(host.children[0].className, 'qm-regex-tools', '图标控件并为页顶一排');
  const toggles = all.filter(n => n.classList.contains('qm-regex-view-toggle'));
  assert.equal(toggles.length, 1, '列表视图只有一个切换按钮');
  assert.equal(all.filter(n => n.attrs.role === 'radio').length, 0, '不再是两段单选');
  assert.equal(toggles[0].attrs['aria-pressed'], 'true');
  assert.ok(walk(toggles[0]).some(n => n.textContent === '自动分组'));
  toggles[0].listeners.click();
  assert.equal(picked, 'order', '自动分组 → 点按切到原始顺序');
  view.render(Object.freeze({ ...ctrl.state(), view: 'order' }));
  const back = walk(host).find(n => n.classList.contains('qm-regex-view-toggle'));
  assert.equal(back.attrs['aria-pressed'], 'false');
  back.listeners.click();
  assert.equal(picked, 'group', '原始顺序 → 点按切到自动分组');
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

test('chat toolkit pages share one spacing scale and inner scrollers never reserve a one-sided gutter', async () => {
  const root = new URL('../', import.meta.url);
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.match(css, /\.sd-floor-panel \{[^}]*--qm-floor-pad: 14px;[^}]*--qm-floor-gap: 8px;[^}]*--qm-floor-card-pad: 10px;[^}]*padding: var\(--qm-floor-pad\);/, '面板/页内/卡片间距统一为一组变量');
  assert.ok(css.includes('.sd-floor-view { display: flex; flex-direction: column; gap: var(--qm-floor-gap); }'), '所有页的卡片竖向间距相同');
  for (const rule of ['.qm-regex-card {', '.qm-ring-card {']) {
    const body = css.slice(css.indexOf(rule)).split('}')[0];
    assert.match(body, /padding: var\(--qm-floor-card-pad\)/, `${rule} 使用统一卡片内边距`);
  }
  // ST 全局 ::-webkit-scrollbar 宽 0.7rem，只挤右侧 → 页内滚动区一律不占槽位，且不再额外右侧留白
  assert.ok(css.includes('#story-director-floor-nav .sd-floor-panel * { scrollbar-width: none; }'));
  assert.ok(css.includes('#story-director-floor-nav .sd-floor-panel *::-webkit-scrollbar { width: 0; height: 0; }'));
  assert.doesNotMatch(css.slice(css.indexOf('.qm-recovery-list {')).split('}')[0], /padding-right/);
  assert.doesNotMatch(css.slice(css.indexOf('.qm-regex-row {')).split('}')[0], /padding: 0 2px/);
  // 单聊天备份数上限：更矮、标签加粗
  assert.match(css, /\.qm-recovery-native-policy \{[^}]*gap: 4px;[^}]*padding: 6px 10px;/);
  assert.match(css, /\.qm-recovery-native-policy-field \{[^}]*font-weight: 600;/);
  assert.match(css, /@media \(max-width: 520px\) \{[^@]*\.sd-floor-panel \{ --qm-floor-pad: 12px;/, '窄屏收一档但同样对称');
});

test('writable sources render accessible switches that call actions.toggle and show busy rows', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false,
      classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { this.listeners[type] = fn; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const walk = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walk(k, out)); return out; };
  const host = make('div'); host.ownerDocument = { createElement: make };
  const calls = [];
  const st = fakeST({ global: [{ id: 'g1', scriptName: '开着' }, { id: 'g2', scriptName: '关着', disabled: true }], preset: [{ id: 'p1', scriptName: '预设' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, toggle: args => { calls.push(args); return null; } } });
  view.render(Object.freeze({ ...ctrl.state(), pending: ['global:g2'] }));
  const switches = walk(host).filter(n => n.classList.contains('qm-regex-switch'));
  assert.equal(switches.length, 3, '全局 2 + 预设 1');
  const [on, off, preset] = switches;
  assert.equal(on.attrs.role, 'switch');
  assert.equal(on.attrs['aria-checked'], 'true');
  assert.equal(off.attrs['aria-checked'], 'false');
  assert.equal(off.disabled, true, '写回中的行禁用');
  assert.equal(off.attrs['aria-busy'], 'true');
  on.listeners.click(); preset.listeners.click(); off.listeners.click();
  await settle();
  assert.deepEqual(calls, [{ source: 'global', id: 'g1', name: '开着', enabled: false }, { source: 'preset', id: 'p1', name: '预设', enabled: false }]);
  const hint = walk(host).find(n => n.classList.contains('qm-regex-hint'));
  assert.match(hint.textContent, /即时写回 ST/);
  view.dispose();
});

test('switch styling: rounded line with a sliding dot, focus ring and reduced-motion', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('#story-director-floor-nav .qm-regex-row.is-writable { grid-template-columns: minmax(0, 1fr) auto; }'));
  assert.match(css, /#story-director-floor-nav \.qm-regex-switch \{[^}]*border: 0;[^}]*background: transparent;/, '不再是胶囊底');
  assert.match(css, /#story-director-floor-nav \.qm-regex-switch::before \{[^}]*height: 2px;[^}]*border-radius: 999px;/, '圆弧横线');
  assert.ok(css.includes('#story-director-floor-nav .qm-regex-switch.is-on::before { background: color-mix(in srgb, var(--sd-primary) 62%, transparent); }'));
  assert.match(css, /#story-director-floor-nav \.qm-regex-switch\.is-on \.qm-regex-knob \{ transform: translateX\(14px\); background: var\(--sd-primary\);/, '圆点滑到右端并染状态色');
  assert.doesNotMatch(css, /\.qm-regex-(?:views|meta)\b/, '旧两段切换与摘要样式已清除');
  assert.ok(css.includes('#story-director-floor-nav .qm-regex-switch:focus-visible {'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { #story-director-floor-nav :is(.qm-regex-switch, .qm-regex-knob) { transition: none; } }'));
});
