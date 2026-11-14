import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  stripOrdinal, regexGroupKey, groupRegexScripts, summarizeRegexScript, readRegexSources, createChatRegex, UNGROUPED_LABEL,
  locateRegexScript, writeRegexToggle, writeRegexStates, REGEX_RELOAD_DELAY,
  regexBindingKey, resolveRegexTarget,
  blankRegexScript, removeRegexEntries, restoreRegexEntries, cloneRegexScript, copyRegexEntries, moveRegexEntries,
  assignRegexGroup, editRegexList, parseRegexLiteral, previewRegexScript, regexFamilyKey, groupAdjacentRegex, tagRegexName,
  readPresetChoices, resolvePresetTarget, switchPreset, presetDisplaySignature,
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

// C-15 s9：用户举的例子写死。
test('regexFamilyKey strips exclusive marks, bracket tags and ordinals', () => {
  assert.deepEqual({ ...regexFamilyKey('(A选一)角色状态栏') }, { tag: '', core: '角色状态栏', head: '', seq: false });
  assert.equal(regexFamilyKey('（B选一）简洁状态栏').core, '简洁状态栏');
  assert.equal(regexFamilyKey('A选一-状态栏').core, '状态栏', '无括号互斥标记也剥掉');
  assert.equal(regexFamilyKey('状态栏(二选一)').core, '状态栏', '尾部互斥标记');
  assert.equal(regexFamilyKey('去自检注释①').core, '去自检注释');
  assert.equal(regexFamilyKey('去自检注释 ②').core, '去自检注释');
  assert.equal(regexFamilyKey('美化-3').core, '美化');
  assert.deepEqual({ ...regexFamilyKey('【小剧场】折叠') }, { tag: '小剧场', core: '折叠', head: '', seq: false });
  assert.equal(regexFamilyKey('状态栏-隐藏').head, '状态栏');
  assert.equal(regexFamilyKey('A选一').core, 'A选一', '只剩标记时保留原名');
});

// C-16 s4：剥掉开头序号 (N)/（N）/N. ——让「(1)群聊」「(2)群聊」按核心词「群聊」归类。
test('regexFamilyKey strips leading ordinal prefixes', () => {
  assert.equal(regexFamilyKey('(1)群聊').core, '群聊');
  assert.equal(regexFamilyKey('（2）群聊').core, '群聊');
  assert.equal(regexFamilyKey('3.群聊').core, '群聊');
  assert.equal(regexFamilyKey('4、群聊').core, '群聊');
  assert.equal(regexFamilyKey('(10) 群聊').core, '群聊', '多位数 + 空格');
  assert.equal(regexFamilyKey('(1)').core, '(1)', '只剩序号时保留原名');
});

test('groupAdjacentRegex folds adjacent same-family runs without reordering', () => {
  const list = items('不发送剧场', '不发送片尾', '不发送剧情走向', '去自检注释①', '去自检注释②',
    '(A选一)角色状态栏', '(A选一)简洁状态栏', '(B选一)详细状态栏', '独立', '美化', '不发送日志');
  const runs = groupAdjacentRegex(list);
  assert.deepEqual(runs.map(r => r.label), ['不发送', '去自检注释', '状态栏', '']);
  assert.deepEqual(names(runs[0].items), ['不发送剧场', '不发送片尾', '不发送剧情走向']);
  assert.deepEqual(names(runs[1].items), ['去自检注释①', '去自检注释②']);
  assert.deepEqual(names(runs[2].items), ['(A选一)角色状态栏', '(A选一)简洁状态栏', '(B选一)详细状态栏'], 'A选一/B选一 不单独成类');
  assert.deepEqual(names(runs[3].items), ['独立', '美化', '不发送日志'], '不相邻的同类不并入前面的组');
  assert.deepEqual(runs.flatMap(r => r.items), list, '拼回恰为原列表（不重排、不丢不重）');
  assert.deepEqual(groupAdjacentRegex([]), []);
  assert.deepEqual(groupAdjacentRegex(null), []);
});

test('groupAdjacentRegex: explicit 【tag】 wins, separators and repeats', () => {
  const runs = groupAdjacentRegex(items('【排版】标题', '【排版】段落', '【美化】标题', '状态栏-隐藏', '状态栏-美化', 'xxx-1', 'xxx-2', 'yy', 'xxx-3', 'xxx-4'));
  assert.deepEqual(runs.map(r => [r.label, r.mode, r.items.length]),
    [['排版', 'tag', 2], ['', '', 1], ['状态栏', 'prefix', 2], ['xxx', 'prefix', 2], ['', '', 1], ['xxx', 'prefix', 2]]);
  assert.deepEqual(runs.map(r => r.key), ['排版', '', '状态栏', 'xxx', '', 'xxx#2'], '同名段 key 带序号区分折叠');
  // 共同前缀需 ≥2 字：单字「去」不成组；拉丁词不在词中截断。
  assert.deepEqual(groupAdjacentRegex(items('去括号', '去空行')).map(r => r.label), ['']);
  assert.deepEqual(groupAdjacentRegex(items('Status bar', 'Statistics')).map(r => r.label), ['']);
  assert.deepEqual(groupAdjacentRegex(items('think-hide', 'think-fold')).map(r => r.label), ['think']);
  // 手动标签与自动规则不混：有标签的不与无标签的成段。
  assert.deepEqual(groupAdjacentRegex(items('【组】状态栏', '状态栏-美化')).map(r => r.label), ['']);
});

// C-16 s4：同核心的分片被中间 1~2 条异类打断时，桥接回一个连续组（用户举例：(1)群聊…中间夹几条…(4)群聊）。
test('groupAdjacentRegex bridges a same-core run interrupted by 1-2 foreign entries', () => {
  // (1)群聊 (2)群聊 [夹一条] (3)群聊 (4)群聊 → 全部并入「群聊」，中间异类也被纳入这一连续段
  const runs = groupAdjacentRegex(items('(1)群聊', '(2)群聊', '世界书注入', '(3)群聊', '(4)群聊'));
  assert.deepEqual(runs.map(r => r.label), ['群聊']);
  assert.deepEqual(names(runs[0].items), ['(1)群聊', '(2)群聊', '世界书注入', '(3)群聊', '(4)群聊'], '中间条目被桥接纳入，顺序不变');

  // 夹两条也桥接
  const two = groupAdjacentRegex(items('(1)群聊', '杂项A', '杂项B', '(2)群聊'));
  assert.deepEqual(two.map(r => r.label), ['群聊']);
  assert.equal(two[0].items.length, 4);

  // 夹三条则不桥接（间隔过大，各自回到散条/后段）
  const three = groupAdjacentRegex(items('(1)群聊', 'x1', 'x2', 'x3', '(2)群聊'));
  assert.notDeepEqual(three.map(r => r.label), ['群聊']);

  // 桥接后仍能继续扩展，不丢不重
  const list = items('(1)群聊', '分隔', '(2)群聊', '(3)群聊');
  assert.deepEqual(groupAdjacentRegex(list).flatMap(r => r.items), list, '拼回恰为原列表');
});

test('tagRegexName writes, replaces or clears the leading 【tag】', () => {
  assert.equal(tagRegexName('不发送剧场', '屏蔽'), '【屏蔽】不发送剧场');
  assert.equal(tagRegexName('【旧】甲', '新'), '【新】甲');
  assert.equal(tagRegexName('[旧] 甲', ''), '甲');
  assert.equal(tagRegexName('甲', ' 【乙】 '), '【乙】甲', '组名里的括号被剥掉');
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

test('writeRegexStates writes a whole batch in one save and refuses it entirely when any row went stale', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B', disabled: true }, { id: 'g3', scriptName: 'C' }],
    preset: [{ id: 'p1', scriptName: 'P', disabled: true }, { scriptName: '无ID', disabled: true }] });
  const off = [{ id: 'g1', name: 'A', enabled: false }, { id: 'g2', name: 'B', enabled: false }, { id: 'g3', name: 'C', enabled: false }];
  assert.equal(await writeRegexStates(st.ctx, { source: 'global', changes: off }), 2, '已是目标状态的条目不计');
  assert.deepEqual(st.ctx.extensionSettings.regex.map(r => r.disabled), [true, true, true]);
  assert.equal(st.log.saves, 1, '整批只保存一次');
  assert.equal(await writeRegexStates(st.ctx, { source: 'global', changes: off }), 0);
  assert.equal(st.log.saves, 1, '无变化不保存');
  await assert.rejects(writeRegexStates(st.ctx, { source: 'global', changes: [{ id: 'g1', name: 'A', enabled: true }, { id: 'gone', name: 'x', enabled: true }] }), /已在别处被修改/);
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, true, '有一条失效则整批不写');
  assert.equal(await writeRegexStates(st.ctx, { source: 'preset', changes: [{ id: 'p1', name: 'P', enabled: true }, { id: '#1', name: '无ID', enabled: true }] }), 2);
  assert.equal(st.log.presetWrites.length, 1, '预设整批一次写入');
  assert.deepEqual(st.preset().map(r => r.disabled), [false, false]);
});

test('controller toggleMany marks every row busy, skips no-op rows and reloads once', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B', disabled: true }, { id: 'g3', scriptName: 'C' }] });
  const timers = manualTimers(), renders = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers,
    loadView: async () => ({ mountChatRegexView: () => ({ render: s => renders.push(s), dispose() {} }) }) });
  await ctrl.mount({ isConnected: true });
  const items = renders.at(-1).sources.global.items;
  const run = ctrl.actions.toggleMany({ source: 'global', items, enabled: false });
  assert.deepEqual([...renders.at(-1).pending], ['global:g1', 'global:g3'], '只有要变的行忙碌');
  assert.equal(await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false }), null, '批量写回中单条点按被忽略');
  assert.equal(await run, 2);
  assert.deepEqual([...renders.at(-1).pending], []);
  assert.ok(renders.at(-1).sources.global.items.every(item => !item.enabled));
  assert.equal(st.log.saves, 1);
  assert.equal(await ctrl.actions.toggleMany({ source: 'global', items: renders.at(-1).sources.global.items, enabled: false }), 0, '全部已关时什么都不做');
  assert.equal(timers.size, 1, '只排一次重载');
  timers.flush(); await settle();
  assert.equal(st.log.reloads, 1);
  ctrl.dispose();
});

test('view offers one pill switch per writable section and group (all on → off, else → on)', async () => {
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
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'a-1' }, { id: 'g2', scriptName: 'a-2' }, { id: 'g3', scriptName: '独立', disabled: true }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, toggleMany: args => { calls.push(args); return 0; } } });
  view.render(Object.freeze({ ...ctrl.state(), view: 'order' }));
  let pills = walk(host).filter(n => n.classList.contains('qm-regex-pill'));
  assert.equal(pills.length, 2, 'C-15 s9 单一模式：全局分区 + 相邻折叠的 a 组（预设无条目）');
  pills = pills.filter(n => n.attrs['aria-label'].startsWith('全局正则'));
  assert.equal(walk(host).filter(n => n.classList.contains('qm-regex-batch-button')).length, 0, '不再是两个批量按钮');
  assert.equal(pills[0].attrs.role, 'switch');
  assert.equal(pills[0].attrs['aria-checked'], 'false');
  assert.ok(pills[0].classList.contains('is-mixed'), '部分开着 → 半态');
  assert.match(pills[0].attrs['aria-label'], /^全局正则：部分启用，点按全部启用/);
  pills[0].listeners.click(); await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].source, 'global'); assert.equal(calls[0].enabled, true); assert.equal(calls[0].items.length, 3);
  view.render(Object.freeze({ ...ctrl.state(), view: 'group' }));
  pills = walk(host).filter(n => n.classList.contains('qm-regex-pill'));
  assert.equal(pills.length, 2, '分区 + a 组；散条不加组头也无组开关');
  const groupA = pills.find(n => n.attrs['aria-label'].startsWith('a：'));
  assert.equal(groupA.attrs['aria-checked'], 'true', 'a 组全开 → 开');
  groupA.listeners.click(); await settle();
  assert.equal(calls.at(-1).enabled, false, '全开时点按 → 全部停用');
  assert.equal(calls.at(-1).items.length, 2);
  view.render(Object.freeze({ ...ctrl.state(), view: 'group', pending: ['global:g1'] }));
  assert.equal(walk(host).find(n => n.classList.contains('qm-regex-pill') && n.attrs['aria-label'].startsWith('a：')).disabled, true, '组内有行写回中时总开关不可点');
  const readOnly = createChatRegex({ getContext: () => fakeST({ save: false, global: [{ id: 'g1', scriptName: 'x' }] }).ctx });
  view.render(Object.freeze({ ...readOnly.state(), view: 'group' }));
  assert.equal(walk(host).filter(n => n.classList.contains('qm-regex-pill')).length, 0, '只读来源不给总开关');
  view.dispose();
});

test('cards and groups fold through the controller and stay folded across renders; preset card drops the preset name', async () => {
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
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'a-1' }, { id: 'g2', scriptName: 'a-2' }, { id: 'g3', scriptName: '独立' }], preset: [{ id: 'p1', scriptName: 'P' }] });
  const renders = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(),
    loadView: async () => ({ mountChatRegexView: ({ root, actions }) => { const v = mountChatRegexView({ root, actions }); return { render: s => { renders.push(s); v.render(s); }, dispose: v.dispose }; } }) });
  await ctrl.mount(Object.assign(host, { isConnected: true }));
  ctrl.actions.setView('group');
  const rows = () => walk(host).filter(n => n.classList.contains('qm-regex-row')).length;
  assert.equal(rows(), 4);
  const fold = key => walk(host).find(n => n.dataset.key === `fold:${key}`);
  assert.equal(fold('card:global').attrs['aria-expanded'], 'true');
  fold('group:global:a').listeners.click();
  assert.equal(rows(), 2, '折叠 a 组只剩其它行');
  assert.equal(fold('group:global:a').attrs['aria-expanded'], 'false');
  fold('card:preset').listeners.click();
  assert.equal(rows(), 1, '预设卡折叠');
  assert.ok(walk(host).find(n => n.classList.contains('qm-regex-card') && n.classList.contains('is-folded')));
  assert.deepEqual([...renders.at(-1).folded].sort(), ['card:preset', 'group:global:a']);
  ctrl.actions.reload();
  assert.equal(rows(), 1, '重绘后折叠态保持');
  fold('card:global').listeners.click();
  assert.equal(rows(), 0);
  fold('card:global').listeners.click(); fold('group:global:a').listeners.click(); fold('card:preset').listeners.click();
  assert.equal(rows(), 4, '全部展开');
  const notes = walk(host).filter(n => n.classList.contains('qm-regex-note')).map(n => n.textContent);
  assert.ok(notes.every(t => !t.includes('预设A')), '预设卡不再显示预设名');
  ctrl.dispose();
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
  assert.ok(text.includes('a（2）') && !text.includes(UNGROUPED_LABEL), '分组头带数量；散条不再归入「未分组」头');
  assert.ok(text.includes('当前 ST 版本不支持预设正则'), '无预设能力时降级提示');
  const rows = all.filter(n => n.classList.contains('qm-regex-row'));
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(n => n.classList.contains('is-off')).length, 1, '停用的条目变灰');
  assert.equal(all.filter(n => n.classList.contains('qm-regex-switch')).length, 0, '不可写时只显示状态圆点');
  assert.equal(all.filter(n => n.classList.contains('qm-regex-meta')).length, 0, '条目只显示正则名，不再显示作用位置摘要');
  assert.ok(!text.includes('未设作用位置') && !text.includes('AI 输出') && !text.includes('用户输入'));
  assert.ok(host.children[0].classList.contains('qm-regex-card-tools'), 'C-17 s4：工具行卡片');
  assert.equal(all.filter(n => n.classList.contains('qm-regex-view-toggle')).length, 0, 'C-15 s9：单一模式，不再有视图切换按钮');
  assert.equal(all.filter(n => n.attrs.role === 'radio').length, 0, '不再是两段单选');
  assert.equal(picked, null);
  view.render(Object.freeze({ ...ctrl.state(), view: 'order' }));
  assert.ok(walk(host).map(n => n.textContent).join('|').includes('a（2）'), '旧 view 值不影响：照样相邻折叠');
  view.dispose();
  assert.deepEqual(host.children, []);
});

test('chat toolkit has a lazily mounted 5th 快切 tab', async () => {
  const index = await readFile(new URL('index.js', root), 'utf8');
  assert.ok(index.includes('data-floor-tab="regex">快切</button>') && index.includes('data-floor-view="regex"></section>'));
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
  assert.equal(walk(host).find(n => n.classList.contains('qm-regex-hint')), undefined, '底部提示已移除');
  view.dispose();
});

test('switch styling: rounded line with a sliding dot, focus ring and reduced-motion', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('#story-director-floor-nav .qm-regex-row.is-writable { grid-template-columns: 24px minmax(0, 1fr) auto; gap: 6px; }'), 'C-17 s3：行首移动图标列');
  assert.match(css, /#story-director-floor-nav \.qm-regex-switch \{[^}]*border: 0;[^}]*background: transparent;/, '不再是胶囊底');
  assert.match(css, /#story-director-floor-nav \.qm-regex-switch::before \{[^}]*height: 2px;[^}]*border-radius: 999px;/, '圆弧横线');
  assert.ok(css.includes('#story-director-floor-nav .qm-regex-switch.is-on::before { background: color-mix(in srgb, var(--sd-primary) 62%, transparent); }'));
  assert.match(css, /#story-director-floor-nav \.qm-regex-switch\.is-on \.qm-regex-knob \{ transform: translateX\(14px\); background: var\(--sd-primary\);/, '圆点滑到右端并染状态色');
  assert.doesNotMatch(css, /\.qm-regex-(?:views|meta)\b/, '旧两段切换与摘要样式已清除');
  assert.ok(css.includes('#story-director-floor-nav .qm-regex-switch:focus-visible {'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { #story-director-floor-nav :is(.qm-regex-switch, .qm-regex-knob) { transition: none; } }'));
});

test('regexBindingKey namespaces global by id and preset by name+id', () => {
  assert.equal(regexBindingKey('global', '', 'abc'), 'global:abc');
  assert.equal(regexBindingKey('preset', '少前', 'p1'), 'preset:少前:p1');
  assert.equal(regexBindingKey('other', 'x', 'y'), '');
});

test('resolveRegexTarget: overrides beat defaults, no-op rows and absent keys are skipped', () => {
  const sources = {
    global: { writable: true, items: [
      { id: 'g1', name: '显A', enabled: false, scope: '' },
      { id: 'g2', name: '显B', enabled: true, scope: '' },
      { id: '#0', name: '无ID', enabled: true, scope: '' },
    ] },
    preset: { writable: true, name: '少前', items: [
      { id: 'p1', name: '提示P', enabled: false, scope: '仅提示词' },
    ] },
  };
  const defaults = { 'global:g1': { enabled: true }, 'global:g2': { enabled: true } };
  const overrides = { 'global:g2': { enabled: false }, 'preset:少前:p1': { enabled: true } };
  const r = resolveRegexTarget({ defaults, overrides, sources });
  // g1: default on (live off) → change; g2: override off (live on) → change; #0 unbindable; p1 override on.
  assert.deepEqual(r.changes.global.map(c => [c.id, c.enabled]), [['g1', true], ['g2', false]]);
  assert.deepEqual(r.changes.preset.map(c => [c.id, c.enabled]), [['p1', true]]);
  assert.equal(r.affectsDisplay, true, 'g1/g2 是显示类');
});

test('resolveRegexTarget: display flag ignores prompt-only scripts', () => {
  const sources = { preset: { writable: true, name: 'P', items: [
    { id: 'p1', name: '仅提示', enabled: false, scope: '仅提示词' },
  ] } };
  const r = resolveRegexTarget({ overrides: { 'preset:P:p1': { enabled: true } }, sources });
  assert.deepEqual(r.changes.preset.map(c => c.id), ['p1']);
  assert.equal(r.affectsDisplay, false, '仅提示词改动不需重载');
});

test('resolveRegexTarget: read-only sources and empty bindings produce no changes', () => {
  const sources = { global: { writable: false, items: [{ id: 'g1', name: 'A', enabled: false, scope: '' }] } };
  const r = resolveRegexTarget({ defaults: { 'global:g1': { enabled: true } }, sources });
  assert.deepEqual(r.changes.global, []);
  assert.deepEqual(r.changes.preset, []);
  assert.equal(r.affectsDisplay, false);
});

// —— C-11d 控制器绑定套用 ——
function fakeBinding(initial = { enabled: false, overrides: {} }) {
  let binding = structuredClone(initial), defaults = {};
  return {
    readBinding: () => binding, writeBinding: v => { binding = structuredClone(v); },
    readDefaults: () => defaults, writeDefaults: v => { defaults = structuredClone(v); },
    get binding() { return binding; }, get defaults() { return defaults; },
  };
}

test('applyBinding is inert while the binding toggle is off', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const bind = fakeBinding({ enabled: false, overrides: { 'global:g1': { enabled: false } } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), ...bind });
  assert.equal(await ctrl.applyBinding(), 0);
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, false, '未启用绑定 → 不写');
  assert.equal(st.log.saves, 0);
});

test('applyBinding writes only the diff and reloads once for display-type changes', async () => {
  const st = fakeST({ global: [
    { id: 'g1', scriptName: '显示A', disabled: true },
    { id: 'g2', scriptName: '仅提示', disabled: false, promptOnly: true },
    { id: 'g3', scriptName: '已达标', disabled: false },
  ] });
  const timers = manualTimers();
  const bind = fakeBinding({ enabled: true, overrides: {
    'global:g1': { enabled: true }, 'global:g2': { enabled: false }, 'global:g3': { enabled: true },
  } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, ...bind });
  const changed = await ctrl.applyBinding();
  assert.equal(changed, 2, 'g1 开、g2 关；g3 已达标不写');
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, false);
  assert.equal(st.ctx.extensionSettings.regex[1].disabled, true);
  assert.equal(st.log.saves, 1, '整批一次保存');
  assert.equal(timers.size, 1, '有显示类改动 → 安排一次重载');
  timers.flush(); await settle();
  assert.equal(st.log.reloads, 1);
});

test('applyBinding does not reload when only prompt-only scripts change', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: '仅提示', disabled: false, promptOnly: true }] });
  const timers = manualTimers();
  const bind = fakeBinding({ enabled: true, overrides: { 'global:g1': { enabled: false } } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, ...bind });
  assert.equal(await ctrl.applyBinding(), 1);
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, true);
  assert.equal(timers.size, 0, '仅提示词改动不重载');
});

test('applyBinding is idempotent: a second pass finds no diff and schedules no reload', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: '显示A', disabled: true }] });
  const timers = manualTimers();
  const bind = fakeBinding({ enabled: true, overrides: { 'global:g1': { enabled: true } } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, ...bind });
  await ctrl.applyBinding(); timers.flush(); await settle();
  const saves = st.log.saves, reloads = st.log.reloads;
  assert.equal(await ctrl.applyBinding(), 0, '第二遍无差异');
  assert.equal(st.log.saves, saves, '不再保存');
  assert.equal(timers.size, 0, '不再安排重载');
  assert.equal(st.log.reloads, reloads);
});

test('setBindingOverride captures the live baseline into defaults so other chats reset', () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const bind = fakeBinding({ enabled: true, overrides: {} });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), ...bind });
  ctrl.actions.setBindingOverride({ key: 'global:g1', enabled: false, liveEnabled: true });
  assert.deepEqual(bind.defaults['global:g1'], { enabled: true }, '首次纳入抓当前 live 态作基线');
  assert.deepEqual(bind.binding.overrides['global:g1'], { enabled: false });
  ctrl.actions.clearBindingOverride('global:g1');
  assert.equal('global:g1' in bind.binding.overrides, false, '移出覆盖');
});

test('setBindingEnabled off then on toggles enable and applies immediately', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: '显示A', disabled: true }] });
  const timers = manualTimers();
  const bind = fakeBinding({ enabled: false, overrides: { 'global:g1': { enabled: true } } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, ...bind });
  await ctrl.actions.setBindingEnabled(true);
  assert.equal(bind.binding.enabled, true);
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, false, '开启后立即套用');
});

test('view shows a 绑定 toggle and marks bound rows when binding is on', async () => {
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
  const host = make('div'); host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }) };
  const calls = [];
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, setBindingEnabled: on => { calls.push(on); } } });
  // off: 绑定按钮在、未按下、无 bound 标记
  view.render(Object.freeze({ ...ctrl.state(), binding: { enabled: false, overrides: {} } }));
  let bind = walk(host).find(n => n.dataset.key === 'bind');
  assert.ok(bind, '有绑定按钮');
  assert.equal(bind.attrs['aria-pressed'], 'false');
  assert.equal(walk(host).filter(n => n.classList?.contains('qm-regex-bound-mark')).length, 0, '未开绑定无标记');
  bind.listeners.click(); await settle();
  assert.deepEqual(calls, [true], '点击切换绑定开启');
  // on: 按下态 + g1 被标记
  view.render(Object.freeze({ ...ctrl.state(), binding: { enabled: true, overrides: { 'global:g1': { enabled: false } } } }));
  bind = walk(host).find(n => n.dataset.key === 'bind');
  assert.equal(bind.attrs['aria-pressed'], 'true');
  assert.ok(bind.classList.contains('is-on'));
  const marks = walk(host).filter(n => n.classList?.contains('qm-regex-bound-mark'));
  assert.equal(marks.length, 1, '仅被覆盖的 g1 带标记');
  view.dispose();
});

// —— C-12 预设绑定 + 聊天内预设快切 ——
// 一个带原生选预设能力的假 ST：每个预设各带自己的正则数组，selectPreset 按 option value 切换。
function fakePresetST({ presets = { 甲: [], 乙: [] }, selected = '甲', global = [], allowed = null } = {}) {
  const log = { selects: [], saves: 0, reloads: 0 };
  const names = Object.keys(presets);
  let current = selected;
  const lists = structuredClone(presets);
  const manager = {
    apiId: 'openai',
    getAllPresets: () => [...names],
    getSelectedPresetName: () => current,
    findPreset: name => (names.includes(name) ? String(names.indexOf(name)) : undefined),
    selectPreset: async value => { log.selects.push(value); current = names[Number(value)]; },
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? lists[current] : null),
    writePresetExtensionField: async ({ path, value }) => { if (path === 'regex_scripts') lists[current] = value; },
  };
  const ctx = { extensionSettings: { regex: structuredClone(global), preset_allowed_regex: { openai: allowed ?? names } },
    getPresetManager: () => manager, saveSettingsDebounced: () => { log.saves += 1; },
    getCurrentChatId: () => 'chat-1', reloadCurrentChat: async () => { log.reloads += 1; } };
  return { ctx, log, current: () => current, lists };
}

test('resolvePresetTarget: none when unbound or already selected, missing when gone, else switch', () => {
  assert.deepEqual({ ...resolvePresetTarget({ bound: '', current: '甲', names: ['甲'] }) }, { action: 'none', name: '' });
  assert.equal(resolvePresetTarget({ bound: '甲', current: '甲', names: ['甲'] }).action, 'none');
  assert.equal(resolvePresetTarget({ bound: '丙', current: '甲', names: ['甲', '乙'] }).action, 'missing');
  assert.deepEqual({ ...resolvePresetTarget({ bound: ' 乙 ', current: '甲', names: ['甲', '乙'] }) }, { action: 'switch', name: '乙' });
  assert.equal(resolvePresetTarget().action, 'none');
});

test('readPresetChoices lists names of the active API and degrades without native switching', () => {
  const st = fakePresetST({ presets: { 甲: [], 乙: [], '': [] } });
  const read = readPresetChoices(st.ctx);
  assert.equal(read.available, true);
  assert.equal(read.current, '甲');
  assert.deepEqual([...read.names], ['甲', '乙'], '空名被滤掉');
  assert.equal(readPresetChoices({ getPresetManager: () => ({ getSelectedPresetName: () => 'x' }) }).available, false, '缺 selectPreset → 不支持');
  assert.equal(readPresetChoices(undefined).available, false);
});

test('switchPreset goes through native findPreset + selectPreset and refuses a missing name', async () => {
  const st = fakePresetST();
  assert.equal(await switchPreset(st.ctx, '乙'), true);
  assert.deepEqual(st.log.selects, ['1'], '传的是 option value，不是名字');
  assert.equal(st.current(), '乙');
  await assert.rejects(switchPreset(st.ctx, '丙'), /已不存在/);
  await assert.rejects(switchPreset({}, '甲'), /不支持/);
});

test('presetDisplaySignature only counts enabled display scripts of an allowed preset', () => {
  const items = [{ id: 'a', enabled: true, scope: '' }, { id: 'b', enabled: true, scope: '仅提示词' }, { id: 'c', enabled: false, scope: '' }];
  assert.equal(presetDisplaySignature({ preset: { allowed: true, items } }), 'a');
  assert.equal(presetDisplaySignature({ preset: { allowed: false, items } }), '', '未被允许运行 → 不影响显示');
  assert.equal(presetDisplaySignature({}), '');
});

test('applyBinding switches to the bound preset first, then applies regex overrides of that preset', async () => {
  const st = fakePresetST({ presets: { 甲: [], 乙: [{ id: 'p1', scriptName: '乙显示', disabled: true }] } });
  const timers = manualTimers();
  const bind = fakeBinding({ enabled: true, preset: '乙', overrides: { 'preset:乙:p1': { enabled: true } } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, ...bind });
  const changed = await ctrl.applyBinding();
  assert.equal(st.current(), '乙', '先切预设');
  assert.equal(st.lists.乙[0].disabled, false, '再按新预设名套用预设正则覆盖');
  assert.equal(changed, 2);
  assert.equal(timers.size, 1, '显示类改动 → 一次重载');
  timers.flush(); await settle();
  assert.equal(await ctrl.applyBinding(), 0, '幂等：第二遍不再切、不再写');
  assert.deepEqual(st.log.selects, ['1'], '只切过一次');
});

test('applyBinding warns once per chat when the bound preset is gone, and still applies regex', async () => {
  const st = fakePresetST({ global: [{ id: 'g1', scriptName: 'A', disabled: true, promptOnly: true }] });
  const notes = [];
  const bind = fakeBinding({ enabled: true, preset: '已删', overrides: { 'global:g1': { enabled: true } } });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, k) => notes.push([m, k]), ...bind });
  assert.equal(await ctrl.applyBinding(), 1, '正则照常套用');
  assert.equal(st.ctx.extensionSettings.regex[0].disabled, false);
  await ctrl.applyBinding();
  assert.equal(notes.filter(([m]) => m.includes('已删')).length, 1, '同一聊天只提示一次');
  assert.equal(st.current(), '甲', '预设不动');
});

test('switching to a preset without display regex does not reload the chat', async () => {
  const st = fakePresetST({ presets: { 甲: [], 乙: [{ id: 'p1', scriptName: '仅提示', promptOnly: true }] } });
  const timers = manualTimers();
  const bind = fakeBinding({ enabled: true, preset: '乙', overrides: {} });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, ...bind });
  assert.equal(await ctrl.applyBinding(), 1);
  assert.equal(timers.size, 0, '前后显示签名相同 → 不重载');
});

test('selectPreset quick-switches natively and records the preset only while binding is on', async () => {
  const st = fakePresetST();
  const bind = fakeBinding({ enabled: false, overrides: {} });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), ...bind });
  assert.equal(await ctrl.actions.selectPreset('乙'), true);
  assert.equal(st.current(), '乙');
  assert.equal(bind.binding.preset, undefined, '绑定关着 → 只切不记');
  await ctrl.actions.setBindingEnabled(true);
  await ctrl.actions.selectPreset('甲');
  assert.equal(bind.binding.preset, '甲', '绑定开着 → 记入本聊天');
  assert.equal(bind.binding.enabled, true);
  const notes = [];
  const c2 = createChatRegex({ getContext: () => st.ctx, notify: m => notes.push(m), timers: manualTimers(), ...bind });
  assert.equal(await c2.actions.selectPreset('丙'), false);
  assert.ok(notes.some(m => m.includes('已不存在')));
});

test('turning binding on records the current preset if none is bound; regex writers keep it', async () => {
  const st = fakePresetST({ selected: '乙', global: [{ id: 'g1', scriptName: 'A' }] });
  const bind = fakeBinding({ enabled: false, overrides: {} });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), ...bind });
  await ctrl.actions.setBindingEnabled(true);
  assert.equal(bind.binding.preset, '乙', '开绑定 = 记住此刻的预设');
  ctrl.actions.setBindingOverride({ key: 'global:g1', enabled: false, liveEnabled: true });
  ctrl.actions.clearBindingOverride('global:g1');
  await ctrl.actions.setBindingEnabled(false);
  assert.equal(bind.binding.preset, '乙', '正则覆盖增删与关绑定都不丢预设');
  assert.equal(bind.binding.enabled, false);
  assert.equal(ctrl.state().presets.current, '乙');
});

test('presetChanged event only refreshes the panel and never records a binding', async () => {
  const st = fakePresetST();
  const bind = fakeBinding({ enabled: true, overrides: {} });
  let renders = 0;
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), ...bind,
    loadView: async () => ({ mountChatRegexView: () => ({ render() { renders += 1; }, dispose() {} }) }) });
  await ctrl.mount({ isConnected: true });
  const before = renders;
  await st.ctx.getPresetManager().selectPreset('1');
  ctrl.events.presetChanged();
  assert.equal(renders, before + 1);
  assert.equal(bind.binding.preset, undefined, 'ST 自动选预设也发此事件，不能拿来记绑定');
});

test('view heads the page with a preset quick switch that calls actions.selectPreset and marks the bound preset', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', selected: false,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }, toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); } },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(type, fn) { this.listeners[type] = fn; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const walk = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walk(k, out)); return out; };
  const host = make('div'); host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }) };
  const picks = [];
  const st = fakePresetST();
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, selectPreset: name => { picks.push(name); } } });
  view.render(Object.freeze({ ...ctrl.state(), binding: { enabled: true, overrides: {}, preset: '乙' } }));
  assert.equal(host.children[0].className.includes('qm-regex-preset'), true, '预设快切在页顶');
  // C-16 item2 → C-17 s6：原生 <select> 换成触发钮 + 内联可折叠目录（不再浮层），避免移动端整页弹窗
  const trigger = walk(host).find(n => n.dataset.key === 'preset');
  assert.ok(trigger && trigger.tagName === 'button', '触发器是按钮不是 select');
  assert.ok(walk(trigger).some(n => n.textContent === '甲'), '触发器显示当前预设');
  const menu = walk(host).find(n => n.classList?.contains('qm-regex-preset-dir'));
  assert.ok(menu, '有内联目录');
  assert.equal(trigger.attrs['aria-expanded'], 'false', '默认收起');
  const options = walk(host).filter(n => n.classList?.contains('qm-regex-preset-option'));
  assert.deepEqual(options.map(o => o.textContent), ['甲', '乙（本聊天）']);
  assert.ok(walk(host).some(n => n.classList?.contains('qm-regex-preset-bound') && n.classList.contains('is-off')), '当前不是绑定预设 → 链环转灰');
  trigger.listeners.click();
  assert.equal(trigger.attrs['aria-expanded'], 'true', '点触发器展开');
  options.find(o => o.dataset.value === '乙').listeners.click(); await settle();
  assert.deepEqual(picks, ['乙']);
  assert.equal(trigger.attrs['aria-expanded'], 'false', '选中后收起');
  trigger.listeners.click();
  options.find(o => o.dataset.value === '甲').listeners.click(); await settle();
  assert.deepEqual(picks, ['乙'], '选回当前预设不触发');
  // 不支持快切的 ST：不渲染
  view.render(Object.freeze({ ...ctrl.state(), presets: { available: false, names: [] } }));
  assert.equal(walk(host).some(n => n.dataset.key === 'preset'), false);
  view.dispose();
});

test('the preset dropdown folds version series into groups and keeps lone presets flat', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', label: '', disabled: false, value: '', selected: false,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }, toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); } },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { this.listeners[type] = fn; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const walk = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walk(k, out)); return out; };
  const host = make('div'); host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }) };
  const st = fakePresetST({ presets: { '写作 v1': [], '写作 v2': [], '独立预设': [] }, selected: '写作 v1' });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, selectPreset: () => {} } });
  view.render(Object.freeze({ ...ctrl.state(), binding: { enabled: true, overrides: {}, preset: '写作 v2' } }));
  const menu = walk(host).find(n => n.classList?.contains('qm-regex-preset-dir'));
  const group = menu.children.find(n => n.classList?.contains('qm-regex-preset-group'));
  assert.ok(group, '同系列预设进分组');
  const groupLabel = walk(group).find(n => n.classList?.contains('qm-regex-preset-group-label'));
  assert.equal(groupLabel.textContent, '写作');
  const groupOptions = walk(group).filter(n => n.classList?.contains('qm-regex-preset-option'));
  assert.deepEqual(groupOptions.map(o => o.textContent), ['写作 v2（本聊天）', '写作 v1']);
  const flat = menu.children.filter(n => n.classList?.contains('qm-regex-preset-option'));
  assert.ok(flat.some(o => o.textContent === '独立预设'), '孤立预设保持平铺');
  assert.equal(flat.some(o => o.textContent === '写作 v1'), false, '系列成员不再平铺');
  view.dispose();
});

test('preset quick switch is wired natively and never writes presets itself', async () => {
  const source = await readFile(new URL('features/chat/qianmu-chat-regex.js', root), 'utf8');
  assert.match(source, /manager\.findPreset\(/);
  assert.match(source, /await manager\.selectPreset\(value\)/);
  assert.ok(!/savePreset|preset_settings_openai\s*=/.test(source), '不旁路写预设');
  const index = await readFile(new URL('index.js', root), 'utf8');
  assert.match(index, /\['PRESET_CHANGED', 'PRESET_RENAMED', 'PRESET_DELETED', 'MAIN_API_CHANGED'\]\.filter\(key => types\[key\]\)\.map\(key => \[types\[key\], chatRegex\.events\.presetChanged\]\)/);
  assert.match(index, /preset: typeof b\?\.preset === 'string' \? b\.preset : ''/, '读路径带出 preset');
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('.qm-regex-preset-trigger'), '自定义触发钮样式');
  assert.ok(css.includes('.qm-regex-preset-dir'), '内联目录样式（C-17 s6 取代浮层）');
});

// —— C-14f 条目管理：纯函数 ——
test('blankRegexScript defaults to an AI-output display script with a fresh id', () => {
  const a = blankRegexScript(), b = blankRegexScript();
  assert.notEqual(a.id, b.id, '每次新 id');
  assert.deepEqual(a.placement, [2]);
  assert.equal(a.disabled, false);
  assert.equal(a.runOnEdit, true);
  assert.equal(blankRegexScript({ scriptName: '命名', placement: [1] }).scriptName, '命名');
  assert.deepEqual(blankRegexScript({ placement: [1] }).placement, [1]);
});

test('removeRegexEntries + restoreRegexEntries round-trips entries back to their slots', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const { next, removed } = removeRegexEntries(list, [2, 0]);
  assert.deepEqual(next.map(s => s.id), ['b', 'd']);
  assert.deepEqual(removed.map(r => r.index), [0, 2], '按升序记录原位');
  const back = restoreRegexEntries(next, removed);
  assert.deepEqual(back.map(s => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(restoreRegexEntries([{ id: 'a' }, { id: 'b' }, { id: 'd' }], removed).filter(s => s.id === 'a').length, 1);
});

test('cloneRegexScript + copyRegexEntries place a 副本 right after each original', () => {
  const clone = cloneRegexScript({ id: 'x', scriptName: '原' });
  assert.notEqual(clone.id, 'x');
  assert.equal(clone.scriptName, '原 副本');
  const list = [{ id: 'a', scriptName: 'A' }, { id: 'b', scriptName: 'B' }];
  const next = copyRegexEntries(list, [0]);
  assert.deepEqual(next.map(s => s.scriptName), ['A', 'A 副本', 'B']);
  assert.notEqual(next[1].id, 'a', '副本带新 id');
});

test('moveRegexEntries slides a selection before a target index', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(moveRegexEntries(list, [2], 0).map(s => s.id), ['c', 'a', 'b', 'd'], '移到最前');
  assert.deepEqual(moveRegexEntries(list, [0], 4).map(s => s.id), ['b', 'c', 'd', 'a'], '移到末尾');
});

test('assignRegexGroup rewrites the name prefix and clears it when moving out', () => {
  assert.equal(assignRegexGroup('美化-标题', { from: '美化', to: '排版' }), '排版-标题');
  assert.equal(assignRegexGroup('美化-标题', { from: '美化', to: '' }), '标题', '移出分组去掉前缀');
  assert.equal(assignRegexGroup('独立', { from: '', to: '新组' }), '新组-独立', '未分组加前缀');
  assert.equal(assignRegexGroup('【标签】甲', { from: '标签', to: '乙' }), '【乙】甲', '方括号标签改写');
});

test('parseRegexLiteral mirrors ST regexFromString: /pat/flags, unslashed = raw pattern', () => {
  assert.equal(parseRegexLiteral('/a.c/i').flags, 'i');
  assert.equal(parseRegexLiteral('/a.c/i').source, 'a.c');
  assert.equal(parseRegexLiteral('a.c').source, 'a.c', 'C-17：不带斜杠按原始正则源（同 ST），不再转义');
  assert.equal(parseRegexLiteral('a.c').flags, '', '无斜杠无 flags');
  assert.ok(parseRegexLiteral('/a/zz').test('/a/zz'), '非法 flags → 整串当正则（同 ST）');
  assert.equal(parseRegexLiteral('/(/'), null, '非法正则 → null');
  assert.equal(parseRegexLiteral(''), null);
});

test('previewRegexScript applies capture groups, {{match}} and trim strings like the engine', () => {
  assert.deepEqual(previewRegexScript({ findRegex: '/(\\w+)@(\\w+)/', replaceString: '$2.$1' }, 'a@b').output, 'b.a');
  assert.equal(previewRegexScript({ findRegex: '/x/g', replaceString: '[{{match}}]' }, 'xx').output, '[x][x]');
  assert.equal(previewRegexScript({ findRegex: '/<(\\w+)>/', replaceString: '$1', trimStrings: ['_'] }, '<a_b>').output, 'ab', '捕获组先剔除修剪串');
  assert.equal(previewRegexScript({ findRegex: '/(/', replaceString: 'x' }, 'y').ok, false, '非法正则不改原文');
  assert.equal(previewRegexScript({ findRegex: '/(/', replaceString: 'x' }, 'y').output, 'y');
});

test('editRegexList reads raw, writes once and flags reload only for display scripts', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const promptOnly = await editRegexList(st.ctx, 'global', raw => ({ next: [...raw, { id: 'g2', scriptName: 'B', promptOnly: true }], touched: [{ promptOnly: true }] }));
  assert.equal(promptOnly.reload, false, 'promptOnly 改动不重载');
  assert.equal(st.log.saves, 1);
  const display = await editRegexList(st.ctx, 'global', raw => ({ next: [...raw], touched: [{ disabled: false }] }));
  assert.equal(display.reload, true);
  const noop = await editRegexList(st.ctx, 'global', () => ({ next: null }));
  assert.equal(noop.changed, false, 'next 为空不写');
});

// —— C-14f 条目管理：控制器 ——
const mgr = (overrides = {}) => {
  const st = fakeST(overrides);
  const timers = manualTimers();
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers, notify: (m, t) => notes.push([t, m]) });
  return { st, timers, notes, ctrl };
};

test('removeMany moves a batch into the recycle bin, exposes a count, and undoRemove restores them', async () => {
  const { st, ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }, { id: 'g3', scriptName: 'C' }] });
  const n = await ctrl.actions.removeMany({ items: [{ source: 'global', id: 'g1', name: 'A' }, { source: 'global', id: 'g3', name: 'C' }] });
  assert.equal(n, 2);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g2']);
  assert.equal(ctrl.state().recycle.count, 2, '回收站计数');
  assert.deepEqual(ctrl.state().recycle.items.map(e => e.name), ['C', 'A'], '最近删除在前');
  const back = await ctrl.actions.undoRemove();
  assert.equal(back, 2);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g1', 'g2', 'g3'], '还原到原位');
  assert.equal(ctrl.state().recycle.count, 0, '全部还原后清空');
});

test('the recycle bin accumulates across deletions and restores a single entry by key', async () => {
  const { st, ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }, { id: 'g3', scriptName: 'C' }] });
  await ctrl.actions.removeMany({ items: [{ source: 'global', id: 'g1', name: 'A' }] });
  await ctrl.actions.removeMany({ items: [{ source: 'global', id: 'g3', name: 'C' }] });
  assert.equal(ctrl.state().recycle.count, 2, '多次删除累积');
  const first = ctrl.state().recycle.items.find(e => e.name === 'A');
  const back = await ctrl.actions.undoRemove({ keys: [first.key] });
  assert.equal(back, 1);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g1', 'g2'], 'A 回到原位，C 仍在回收站');
  assert.deepEqual(ctrl.state().recycle.items.map(e => e.name), ['C'], '只剩未还原的那条');
});

test('copyMany duplicates in place for the same source and appends across sources', async () => {
  const { st, ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A' }], preset: [{ id: 'p1', scriptName: 'P' }] });
  await ctrl.actions.copyMany({ items: [{ source: 'global', id: 'g1', name: 'A' }] });
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.scriptName), ['A', 'A 副本']);
  await ctrl.actions.copyMany({ items: [{ source: 'global', id: 'g1', name: 'A' }], to: 'preset' });
  assert.deepEqual(st.preset().map(s => s.scriptName), ['P', 'A'], '跨源用原名追加到末尾');
});

test('move reorders one source and insert adds a named entry returning its id', async () => {
  const { st, ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  await ctrl.actions.move({ source: 'global', items: [{ id: 'g2', name: 'B' }], to: 0 });
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g2', 'g1']);
  const id = await ctrl.actions.insert({ source: 'global', script: { scriptName: '新条目' } });
  assert.equal(typeof id, 'string');
  assert.equal(st.ctx.extensionSettings.regex.at(-1).scriptName, '新条目');
  const bad = await ctrl.actions.insert({ source: 'global', script: { scriptName: '' } });
  assert.equal(bad, null, '无名拒绝新建');
});

test('saveScript replaces fields in place and keeps the real id', async () => {
  const { st, ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A', findRegex: '/a/' }] });
  await ctrl.actions.saveScript({ source: 'global', id: 'g1', name: 'A', script: { scriptName: 'A2', replaceString: 'x' } });
  const row = st.ctx.extensionSettings.regex[0];
  assert.equal(row.id, 'g1', 'id 不变');
  assert.equal(row.scriptName, 'A2');
  assert.equal(row.replaceString, 'x');
});

test('regroup moves selected entries into a named group without a reload', async () => {
  const { st, timers, ctrl } = mgr({ global: [{ id: 'g1', scriptName: '甲' }, { id: 'g2', scriptName: '乙' }] });
  const n = await ctrl.actions.regroup({ items: [{ source: 'global', id: 'g1', name: '甲' }, { source: 'global', id: 'g2', name: '乙' }], to: '组' });
  assert.equal(n, 2);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.scriptName), ['组-甲', '组-乙']);
  assert.equal(timers.size, 0, '改名不触发重载');
});

test('structural actions are mutually exclusive: a second one bails while the first is still writing', async () => {
  const { st, ctrl } = mgr({ preset: [{ id: 'p1', scriptName: 'A' }, { id: 'p2', scriptName: 'B' }] });
  let release;
  const slow = new Promise(r => { release = r; });
  const manager = st.ctx.getPresetManager();
  const realWrite = manager.writePresetExtensionField;
  manager.writePresetExtensionField = async args => { await slow; return realWrite(args); };
  const first = ctrl.actions.removeMany({ items: [{ source: 'preset', id: 'p1', name: 'A' }] });
  await settle();
  const blocked = await ctrl.actions.copyMany({ items: [{ source: 'preset', id: 'p2', name: 'B' }] });
  assert.equal(blocked, null, '已有结构性写回在跑时第二个直接退出');
  release();
  assert.equal(await first, 1);
  assert.deepEqual(st.preset().map(s => s.id), ['p2'], '只删了第一个，复制没发生');
});

test('setManaging/setSelected track selection and clear it on exit; openEditor/closeEditor drive the sub-page', () => {
  const { ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A' }] });
  ctrl.actions.setManaging(true);
  ctrl.actions.setSelected(['global:g1']);
  assert.deepEqual(ctrl.state().selected, ['global:g1']);
  assert.equal(ctrl.state().managing, true);
  ctrl.actions.setManaging(false);
  assert.deepEqual(ctrl.state().selected, [], '退出管理态清空选择');
  ctrl.actions.openEditor({ source: 'global', id: 'g1', name: 'A' });
  assert.deepEqual(ctrl.state().editing, { isNew: false, source: 'global', id: 'g1', name: 'A' });
  ctrl.actions.openEditor({ isNew: true, source: 'preset' });
  assert.deepEqual(ctrl.state().editing, { isNew: true, source: 'preset' });
  ctrl.actions.closeEditor();
  assert.equal(ctrl.state().editing, null);
});

test('readScript returns a deep copy and unmount resets editing/managing/selection', async () => {
  const { ctrl } = mgr({ global: [{ id: 'g1', scriptName: 'A', trimStrings: ['x'] }] });
  const copy = ctrl.actions.readScript({ source: 'global', id: 'g1', name: 'A' });
  copy.trimStrings.push('y');
  assert.deepEqual(ctrl.actions.readScript({ source: 'global', id: 'g1', name: 'A' }).trimStrings, ['x'], '改副本不影响源');
  ctrl.actions.setManaging(true); ctrl.actions.setSelected(['global:g1']); ctrl.actions.openEditor({ source: 'global', id: 'g1', name: 'A' });
  ctrl.unmount();
  assert.equal(ctrl.state().managing, false);
  assert.equal(ctrl.state().editing, null);
  assert.deepEqual(ctrl.state().selected, []);
});

// —— C-14f 管理态 UI / C-14g 编辑子页：视图 ——
function fakeDom() {
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', type: '', placeholder: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
        toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); } },
      style: { setProperty() {}, removeProperty() {} },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { this.listeners[type] = fn; },
      closest() { return null; }, getBoundingClientRect() { return { height: 400 }; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const host = make('div');
  host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }), defaultView: {} };
  return host;
}
const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };
const byKey = (host, key) => walkAll(host).find(n => n.dataset?.key === key);

test('manage toggle turns rows into checkbox + reorder + editable name, and a selection bar batches delete/copy/group', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const calls = [];
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const stub = { ...ctrl.actions };
  for (const name of ['setManaging', 'setSelected', 'removeMany', 'copyMany', 'regroup', 'pickMove', 'dropMove', 'openEditor']) stub[name] = (...args) => { calls.push([name, args]); return null; };
  const view = mountChatRegexView({ root: host, actions: stub });
  // 非管理态：没有复选框
  view.render(Object.freeze({ ...ctrl.state(), managing: false }));
  assert.equal(walkAll(host).some(n => n.dataset?.key?.startsWith?.('sel:')), false);
  // 管理态：每行一个复选框 + 行尾图标（拾取/编辑/复制/删除）+ 可点名编辑
  view.render(Object.freeze({ ...ctrl.state(), managing: true, selected: ['global:g1'] }));
  const checks = walkAll(host).filter(n => n.dataset?.key?.startsWith?.('sel:'));
  assert.equal(checks.length, 2);
  assert.equal(checks[0].attrs['aria-checked'], 'true', 'g1 已选');
  checks[1].listeners.click();
  assert.deepEqual(calls.at(-1), ['setSelected', ['global:g2', true]]);
  byKey(host, 'edit:global:g1').listeners.click();
  assert.deepEqual(calls.at(-1), ['openEditor', [{ source: 'global', id: 'g1', name: 'A' }]]);
  // 行尾图标：复制 / 删除（删除走二次确认，fake DOM 无 confirm → 放行）
  byKey(host, 'rowcopy:global:g2').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['copyMany', [{ items: [{ source: 'global', id: 'g2', name: 'B' }] }]]);
  byKey(host, 'rowdel:global:g2').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['removeMany', [{ items: [{ source: 'global', id: 'g2', name: 'B' }] }]]);
  // 移动：废弃上下箭头，改拾取 → 插入。拾取 g2（点按 grip），再点目标落点插入
  assert.equal(walkAll(host).some(n => n.dataset?.key?.startsWith?.('move:')), false, '不再有上下箭头');
  byKey(host, 'pick:global:g2').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['pickMove', [{ source: 'global', items: [{ source: 'global', id: 'g2', name: 'B' }] }]]);
  // 拖拽 grip：dragstart 也触发 pickMove
  byKey(host, 'pick:global:g1').listeners.dragstart?.({ dataTransfer: {} }); await settle();
  assert.deepEqual(calls.at(-1), ['pickMove', [{ source: 'global', items: [{ source: 'global', id: 'g1', name: 'A' }] }]]);
  // 拾取态：出现落点；点落点＝落定到该条目之前
  view.render(Object.freeze({ ...ctrl.state(), managing: true, picking: [{ source: 'global', id: 'g2', name: 'B' }] }));
  const drops = walkAll(host).filter(n => n.dataset?.key?.startsWith?.('drop:global:'));
  assert.ok(drops.length >= 2, '每条前 + 末尾各一个落点');
  byKey(host, 'drop:global:g1').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['dropMove', [{ source: 'global', before: { id: 'g1', name: 'A' } }]]);
  byKey(host, 'drop:global:end').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['dropMove', [{ source: 'global', before: null }]]);
  // 选择工具条（回到选中态）
  view.render(Object.freeze({ ...ctrl.state(), managing: true, selected: ['global:g1'] }));
  byKey(host, 'sel-act:del').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['removeMany', [{ items: [{ source: 'global', id: 'g1', name: 'A' }] }]]);
  byKey(host, 'sel-act:copy').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['copyMany', [{ items: [{ source: 'global', id: 'g1', name: 'A' }] }]]);
  byKey(host, 'sel-act:cancel').listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), ['setManaging', [false]]);
  view.dispose();
});

test('a recycle toggle appears when entries are deleted; opening it lists them and restores by key', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const restored = [];
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: { ...ctrl.actions, setRecycle: () => {}, undoRemove: args => { restored.push(args); return 1; } } });
  const recycle = { open: false, count: 2, items: [{ key: 'trash-2', source: 'global', preset: '', name: 'C' }, { key: 'trash-1', source: 'global', preset: '', name: 'A' }] };
  // 折叠态：工具行里出现回收站开关，没有旧的「撤销条」。
  view.render(Object.freeze({ ...ctrl.state(), recycle: { ...recycle, open: false } }));
  assert.ok(byKey(host, 'recycle'), '回收站开关出现');
  assert.equal(walkAll(host).find(n => n.classList?.contains('qm-regex-undobar')), undefined, '旧撤销条已移除');
  // 打开态：列表显示已删除条目 + 还原图标 + 全部还原 + 内存态小字。
  view.render(Object.freeze({ ...ctrl.state(), recycle: { ...recycle, open: true } }));
  const text = walkAll(host).map(n => n.textContent).join('|');
  assert.ok(text.includes('已删除') && text.includes('刷新或重启 ST 后自动清空'), '回收站标题与内存态说明');
  byKey(host, 'restore:trash-1').listeners.click(); await settle();
  assert.deepEqual(restored.at(-1), { keys: ['trash-1'] }, '单条按键还原');
  byKey(host, 'recycle-all').listeners.click(); await settle();
  assert.deepEqual(restored.at(-1), {}, '全部还原');
  view.dispose();
});

test('editor sub-page mirrors ST fields, saves collected data through insert/saveScript, and previews via actions.preview', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const saved = [];
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', findRegex: '/x/', replaceString: 'y', placement: [2], trimStrings: ['q'] }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const stub = { ...ctrl.actions,
    readScript: () => ({ scriptName: 'A', findRegex: '/x/', replaceString: 'y', placement: [2], trimStrings: ['q'], markdownOnly: false, promptOnly: false, runOnEdit: true, disabled: false, substituteRegex: 0, minDepth: null, maxDepth: null }),
    saveScript: args => { saved.push(['save', args]); return true; },
    insert: args => { saved.push(['insert', args]); return 'new-id'; },
    closeEditor: () => { saved.push(['close']); },
    preview: (script, input) => ({ ok: true, output: `${script.replaceString}:${input}` }) };
  const view = mountChatRegexView({ root: host, actions: stub });
  // 编辑现有：字段预填
  view.render(Object.freeze({ ...ctrl.state(), editing: { isNew: false, source: 'global', id: 'g1', name: 'A' } }));
  assert.ok(walkAll(host).some(n => n.classList?.contains('qm-regex-editor')), '进入编辑子页');
  const nameField = byKey(host, 'field:scriptName');
  assert.equal(nameField.value, 'A');
  const findField = byKey(host, 'field:findRegex');
  assert.equal(findField.value, '/x/');
  // s8→C-16 s6：ST 原生中文命名（宏标签精简）+ 圆点式选项 + 测试区常驻 + 取消/保存为图标按钮
  const labels = walkAll(host).filter(n => n.classList?.contains('qm-regex-field-label')).map(n => n.textContent);
  assert.ok(labels.includes('脚本名称') && labels.includes('查找正则表达式') && labels.includes('作用范围') && labels.includes('其他选项') && labels.includes('正则表达式查找宏'), '采用 ST 原生字段名');
  assert.ok(walkAll(host).some(n => n.classList?.contains('qm-regex-opt')), '选项改圆点式');
  const testTitle = byKey(host, 'editor-test-title');
  assert.equal(testTitle?.textContent, '测试', '测试区标题只写「测试」');
  assert.ok(byKey(host, 'editor-cancel').children.some(c => c.classList?.contains?.('fa-xmark') || c.classList?.set?.has?.('fa-xmark')), '取消为图标');
  const testOut0 = walkAll(host).find(n => n.classList?.contains('qm-regex-testout'));
  assert.equal(testOut0.classList.contains('is-empty'), true, '预览为空时隐藏');
  // s8b：查找/替换带着色层；输入含 {{宏}}/$1/\d/(组)/.* 时 <pre> 出现对应 token span
  const hl = walkAll(host).find(n => n.classList?.contains('qm-regex-hl'));
  assert.ok(hl, '查找框有着色层');
  const codeArea = byKey(host, 'field:findRegex');
  codeArea.value = '{{user}}(\\d+).*$1';
  codeArea.listeners.input?.();
  const classesOf = node => [...(node.classList?.set || [])];
  const tokenClasses = (hl.children || []).flatMap(classesOf);
  assert.ok(tokenClasses.includes('qm-hl-macro'), '{{宏}} 着色');
  assert.ok(tokenClasses.includes('qm-hl-group'), '() 分组着色');
  assert.ok(tokenClasses.includes('qm-hl-esc'), '\\d 转义着色');
  assert.ok(tokenClasses.includes('qm-hl-meta'), '.* 元字符着色');
  assert.ok(tokenClasses.includes('qm-hl-ref'), '$1 反向引用着色');
  // 展开按钮切换全屏 is-full（作用在字段 wrap 上）
  const expand = walkAll(host).find(n => n.classList?.contains('qm-regex-expand'));
  const findWrap = walkAll(host).find(n => n.classList?.contains('qm-regex-field') && walkAll(n).includes(expand));
  expand.listeners.click();
  assert.equal(findWrap.classList.contains('is-full'), true, '展开进入全屏');
  // 改名 + 作用位置勾选 + 测试
  nameField.value = 'A2';
  byKey(host, 'place:1').listeners.click();
  const testIn = byKey(host, 'field:testInput'); testIn.value = 'hi';
  byKey(host, 'editor-test').listeners.click();
  assert.match(walkAll(host).find(n => n.classList?.contains('qm-regex-testout')).textContent, /y:hi/);
  // 保存：收集字段 → saveScript
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved[0][0], 'save');
  assert.equal(saved[0][1].script.scriptName, 'A2');
  assert.ok(saved[0][1].script.placement.includes(1) && saved[0][1].script.placement.includes(2), '作用位置含新勾选的 1 与原有 2');
  assert.deepEqual(saved.at(-1), ['close'], '保存成功后返回列表');
  // 返回按钮
  byKey(host, 'editor-back').listeners.click();
  assert.equal(saved.at(-1)[0], 'close');
  view.dispose();
});

test('editor new mode inserts a blank script and refuses an empty name', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const saved = []; const notes = [];
  const st = fakeST({ global: [] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, notify: (m, t) => notes.push([t, m]),
    actions: { ...ctrl.actions, insert: args => { saved.push(args); return 'id'; }, closeEditor: () => saved.push('close') } });
  view.render(Object.freeze({ ...ctrl.state(), editing: { isNew: true, source: 'global' } }));
  // 空名保存被拒
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved.length, 0);
  assert.match(notes.at(-1)[1], /填写正则名称/);
  // 填名后新建
  byKey(host, 'field:scriptName').value = '新建条目';
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved[0].source, 'global');
  assert.equal(saved[0].script.scriptName, '新建条目');
  view.dispose();
});

// C-15 s9c：手动命名组 = 写【标签】；双击组名就地改名；整组拾取；编辑页分组栏。
test('retag writes a leading 【tag】 per entry without a reload, and empty tag clears it', async () => {
  const { st, timers, ctrl } = mgr({ global: [{ id: 'g1', scriptName: '不发送剧场' }, { id: 'g2', scriptName: '[旧]不发送片尾' }, { id: 'g3', scriptName: '独立' }] });
  const items = [{ source: 'global', id: 'g1', name: '不发送剧场' }, { source: 'global', id: 'g2', name: '[旧]不发送片尾' }];
  assert.equal(await ctrl.actions.retag({ items, tag: '屏蔽' }), 2);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.scriptName), ['【屏蔽】不发送剧场', '【屏蔽】不发送片尾', '独立']);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g1', 'g2', 'g3'], 'id 不变（绑定不受影响）');
  assert.equal(timers.size, 0, '改名不触发重载');
  assert.equal(await ctrl.actions.retag({ items, tag: '' }), 2);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.scriptName), ['不发送剧场', '不发送片尾', '独立']);
});

test('managing group header: double-click renames via retag, grip picks the whole group, drop lands before the header', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const calls = [];
  const st = fakeST({ global: [{ id: 'g0', scriptName: '独立' }, { id: 'g1', scriptName: '不发送剧场' }, { id: 'g2', scriptName: '不发送片尾' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const stub = { ...ctrl.actions };
  for (const name of ['retag', 'pickMove', 'dropMove']) stub[name] = (...args) => { calls.push([name, args]); return null; };
  const view = mountChatRegexView({ root: host, actions: stub });
  view.render(Object.freeze({ ...ctrl.state(), managing: true }));
  assert.equal(byKey(host, 'view'), undefined, '无视图切换按钮');
  const title = byKey(host, 'gname:global:不发送');
  assert.ok(title, '组名可双击改名');
  assert.equal(byKey(host, 'grename:global:不发送'), undefined, '平时不显示输入框');
  title.listeners.dblclick();
  const field = byKey(host, 'grename:global:不发送');
  assert.equal(field.value, '不发送');
  field.value = '屏蔽'; field.listeners.keydown({ key: 'Enter', preventDefault() {} }); await settle();
  assert.equal(calls[0][0], 'retag');
  assert.equal(calls[0][1][0].tag, '屏蔽');
  assert.deepEqual(calls[0][1][0].items.map(i => i.id), ['g1', 'g2'], '整组成员');
  field.listeners.blur(); await settle();
  assert.equal(calls.filter(c => c[0] === 'retag').length, 1, 'Enter 后失焦不重复提交');
  // 触屏双点：两次 click 间隔 <400ms 也进入改名；Esc 取消不写
  view.render(Object.freeze({ ...ctrl.state(), managing: true }));
  const t2 = byKey(host, 'gname:global:不发送');
  t2.listeners.click({ timeStamp: 1000 }); t2.listeners.click({ timeStamp: 1200 });
  const f2 = byKey(host, 'grename:global:不发送');
  assert.ok(f2, '双点进入改名');
  f2.value = '别的'; f2.listeners.keydown({ key: 'Escape', preventDefault() {} }); await settle();
  assert.equal(calls.filter(c => c[0] === 'retag').length, 1, 'Esc 不提交');
  // 自动组清空名字 = 不改
  view.render(Object.freeze({ ...ctrl.state(), managing: true }));
  byKey(host, 'gname:global:不发送').listeners.dblclick();
  const f3 = byKey(host, 'grename:global:不发送'); f3.value = ''; f3.listeners.blur(); await settle();
  assert.equal(calls.filter(c => c[0] === 'retag').length, 1, '自动组留空不写');
  // 整组拾取
  byKey(host, 'gpick:global:不发送').listeners.click(); await settle();
  const pick = calls.find(c => c[0] === 'pickMove');
  assert.deepEqual(pick[1][0].items.map(i => i.id), ['g1', 'g2']);
  // 拾取态：组头前有落点（插到组首成员之前），组首行前不重复落点
  view.render(Object.freeze({ ...ctrl.state(), managing: true, picking: [{ source: 'global', id: 'g0', name: '独立' }] }));
  const list = walkAll(host).find(n => n.classList?.contains('qm-regex-list'));
  const seq = list.children.map(n => n.dataset?.key || (n.classList?.contains('qm-regex-group') ? 'HEAD' : n.dataset?.id));
  assert.deepEqual(seq, ['drop:global:g0', 'g0', 'drop:global:g1', 'HEAD', 'g1', 'drop:global:g2', 'g2', 'drop:global:end']);
  view.dispose();
});

test('editor 分组 field edits the 【tag】 separately and keeps an untouched name verbatim', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const saved = [];
  const st = fakeST({ global: [{ id: 'g1', scriptName: '[排版]标题' }, { id: 'g2', scriptName: '【排版】段落' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  let raw = '[排版]标题';
  const stub = { ...ctrl.actions, readScript: () => ({ scriptName: raw, placement: [2] }),
    saveScript: args => { saved.push(args); return true; }, closeEditor: () => {} };
  const view = mountChatRegexView({ root: host, actions: stub });
  const open = () => view.render(Object.freeze({ ...ctrl.state(), editing: { isNew: false, source: 'global', id: 'g1', name: raw } }));
  open();
  assert.equal(byKey(host, 'field:scriptName').value, '标题', '名字栏只显示正文');
  assert.equal(byKey(host, 'field:group').value, '排版', '分组栏显示标签');
  assert.ok(walkAll(host).some(n => n.tagName === 'datalist' && n.children.some(o => o.value === '排版')), '已有组可选');
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved.at(-1).script.scriptName, '[排版]标题', '未改动时原样保留（不把 [X] 改写成【X】）');
  open();
  byKey(host, 'field:group').value = '美化';
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved.at(-1).script.scriptName, '【美化】标题');
  open();
  byKey(host, 'field:group').value = '';
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved.at(-1).script.scriptName, '标题', '留空 = 去掉标签');
  raw = '不发送剧场'; open();
  assert.equal(byKey(host, 'field:group').value, '');
  byKey(host, 'field:group').value = '屏蔽';
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved.at(-1).script.scriptName, '【屏蔽】不发送剧场');
  raw = '甲'; open();
  byKey(host, 'field:scriptName').value = '【手写】甲';
  byKey(host, 'editor-save').listeners.click(); await settle();
  assert.equal(saved.at(-1).script.scriptName, '【手写】甲', '分组栏留空时名字栏里手写的标签原样保留');
  view.dispose();
});

// —— C-16 s6 编辑页重构（反馈项 6）——
function openEditorView(data) {
  return (async () => {
    const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
    const host = fakeDom();
    const st = fakeST({ global: [{ id: 'g1', scriptName: data.scriptName || 'A' }] });
    const ctrl = createChatRegex({ getContext: () => st.ctx });
    const stub = { ...ctrl.actions, readScript: () => structuredClone(data), closeEditor: () => {},
      preview: (script, input) => previewRegexScript(script, input) };
    const view = mountChatRegexView({ root: host, actions: stub });
    view.render(Object.freeze({ ...ctrl.state(), editing: { isNew: false, source: 'global', id: 'g1', name: data.scriptName || 'A' } }));
    return { host, view };
  })();
}

test('item6: 宏标签改名、深度合并为「深度」、作用范围/其他选项分左右两列', async () => {
  const { host, view } = await openEditorView({ scriptName: 'A', placement: [2], substituteRegex: 0 });
  const labels = walkAll(host).filter(n => n.classList?.contains('qm-regex-field-label')).map(n => n.textContent);
  assert.ok(labels.includes('正则表达式查找宏'), '宏标签改为「正则表达式查找宏」');
  assert.ok(!labels.some(t => t === '正则表达式查找时的宏'), '旧宏标签移除');
  assert.ok(labels.includes('深度'), '深度合并为单一「深度」标签');
  assert.ok(!labels.some(t => t && t.includes('最小 / 最大')), '旧「最小 / 最大深度」标签移除');
  const cols = walkAll(host).find(n => n.classList?.contains('qm-regex-optcols'));
  assert.ok(cols, '作用范围与其他选项放进两列容器');
  assert.equal(cols.children.length, 2, '两列');
  view.dispose();
});

test('item6: 测试区标题仅「测试」、预览默认隐藏触发后显示、含美化模式开关', async () => {
  const { host, view } = await openEditorView({ scriptName: 'A', findRegex: '/a/g', replaceString: 'b' });
  const title = walkAll(host).find(n => n.dataset?.key === 'editor-test-title');
  assert.ok(title, '有测试区标题');
  assert.equal(title.textContent, '测试', '标题仅「测试」');
  const out = walkAll(host).find(n => n.classList?.contains('qm-regex-testout'));
  assert.ok(out.classList.contains('is-empty'), '预览默认隐藏');
  const beautify = walkAll(host).find(n => n.dataset?.key === 'editor-beautify');
  assert.ok(beautify, '有美化模式开关');
  beautify.listeners.click();
  assert.ok(beautify.classList.contains('is-on'), '美化模式可切换');
  const input = walkAll(host).find(n => n.dataset?.key === 'field:testInput');
  input.value = 'aaa';
  walkAll(host).find(n => n.dataset?.key === 'editor-test').listeners.click();
  const frame = walkAll(host).find(n => n.classList?.contains('qm-regex-testframe'));
  assert.ok(frame && frame.hidden === false, 'C-17：美化模式运行后用沙箱 iframe 渲染');
  assert.equal(frame.attrs.sandbox, 'allow-same-origin', '沙箱不给 allow-scripts');
  assert.ok(String(frame.srcdoc).endsWith('bbb'), '渲染的是替换后的结果');
  beautify.listeners.click();
  assert.ok(!out.classList.contains('is-empty'), '切回代码模式后文本预览显示');
  assert.equal(out.textContent, 'bbb');
  assert.equal(frame.hidden, true, '代码模式隐藏 iframe');
  view.dispose();
});

test('item6: 展开按钮进入全屏（is-full），再次点击退出', async () => {
  const { host, view } = await openEditorView({ scriptName: 'A', findRegex: '/a/' });
  const expand = walkAll(host).find(n => n.classList?.contains('qm-regex-expand'));
  assert.ok(expand, '有展开按钮');
  const field = walkAll(host).find(n => n.classList?.contains('qm-regex-field') && walkAll(n).includes(expand));
  expand.listeners.click();
  assert.ok(field.classList.contains('is-full'), '点击进入全屏');
  expand.listeners.click();
  assert.ok(!field.classList.contains('is-full'), '再次点击退出全屏');
  view.dispose();
});

test('item6: 全屏/两列/美化模式的 CSS 落位', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('.qm-regex-optcols'), '两列容器样式');
  assert.match(css, /\.qm-regex-field\.is-full\b/, '全屏态样式');
  assert.ok(css.includes('.qm-regex-beautify'), '美化开关样式');
});
