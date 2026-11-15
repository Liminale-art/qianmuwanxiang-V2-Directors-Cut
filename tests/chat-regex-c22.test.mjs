// C-22：回退「固定分组＋聚拢」，改为「真实顺序显示 + 自定义分组优先 + 相邻同类自动折叠」。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createChatRegex, groupRegexRuns, setRegexAssign, renameRegexAssign, normalizeRegexAssign, REGEX_NO_GROUP } = await import('../features/chat/qianmu-chat-regex.js');

const rowsOf = list => list.map(s => ({ id: s.id, name: s.scriptName }));
const shape = (list, assign) => groupRegexRuns(rowsOf(list), assign)
  .map(r => `${r.label || '·'}${r.custom ? '*' : ''}[${r.items.map(i => i.id).join('')}]`).join(' ');

// 用户截图里的列表：a 独立，b/c 自动成「甲组」，d/e 自动成「心情」。
const base = () => [
  { id: 'a', scriptName: '(A选一)独立条目5' }, { id: 'b', scriptName: '甲组 · 占位标记' }, { id: 'c', scriptName: '甲组 · 隐藏标记' },
  { id: 'd', scriptName: '心情1' }, { id: 'e', scriptName: '心情2' }];

function harness(list = base(), assign0 = {}) {
  const ctx = { extensionSettings: { regex: structuredClone(list) }, getCurrentChatId: () => 'c', reloadCurrentChat: async () => {}, saveSettingsDebounced() {} };
  let assign = structuredClone(assign0);
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => ctx, timers: { set: () => 1, clear() {} }, notify: (m, t) => notes.push([t, m]),
    readGroups: () => assign, writeGroups: v => { assign = JSON.parse(JSON.stringify(v)); } });
  return { ctx, ctrl, notes, get assign() { return assign; }, shape: () => shape(ctx.extensionSettings.regex, assign), raw: () => ctx.extensionSettings.regex.map(s => s.id).join('') };
}
async function move(h, ids, at) {
  h.ctrl.actions.pickMove({ source: 'global', items: ids.map(id => ({ id, name: '' })) });
  await h.ctrl.actions.dropMove({ source: 'global', ...at });
}

test('pure: list always shows the real order; custom groups win; null = explicitly ungrouped; no reordering', () => {
  assert.equal(shape(base(), {}), '·[a] 甲组[bc] 心情[de]', '纯自动折叠');
  assert.equal(shape(base(), { a: '甲组' }), '甲组*[abc] 心情[de]', '自定义成员与相邻同名自动段合成一组（自定义）');
  assert.equal(shape(base(), { c: REGEX_NO_GROUP }), '·[abc] 心情[de]', '明确不分组：自动折叠不再把它拉回组');
  // 自定义组被别处（例如 ST 原生面板）拆开：如实显示两段同名组，不偷偷重排
  const split = [base()[1], base()[0], base()[2]];
  assert.equal(shape(split, { b: '组', c: '组' }), '组*[b] ·[a] 组*[c]');
  // 拼回恰为原列表
  const runs = groupRegexRuns(rowsOf(base()), { d: '甲组' });
  assert.deepEqual(runs.flatMap(r => r.items.map(i => i.id)), ['a', 'b', 'c', 'd', 'e']);
});

test('pure: assignment helpers', () => {
  const a = setRegexAssign({}, ['x', 'y', '#3'], '【组】');
  assert.deepEqual(a, { x: '组', y: '组' }, '无真实 id 的行不可手动分组；组名去括号');
  assert.deepEqual(setRegexAssign(a, ['x'], undefined), { y: '组' }, 'undefined = 清除，回到自动');
  assert.deepEqual(setRegexAssign(a, ['x'], null), { x: null, y: '组' }, 'null = 明确不分组');
  assert.deepEqual(renameRegexAssign(a, '组', '新'), { x: '新', y: '新' });
  assert.deepEqual(normalizeRegexAssign({ order: ['旧'], members: { 旧: ['x'] } }), {}, '旧版固定分组数据不迁移');
});

test('user case 1: 心情1 dropped into 甲组 really joins it (and the auto group is not broken apart)', async () => {
  const h = harness();
  await move(h, ['d'], { before: { id: 'c' }, group: '甲组', members: ['b', 'c'] });
  assert.equal(h.raw(), 'abdce');
  assert.equal(h.shape(), '·[a] 甲组*[bdc] ·[e]', '原组成员与新来的条目一起成为自定义组，显示即真实顺序');
  assert.equal(h.notes.at(-1)[0], 'success');
});

test('user case 2: an auto-grouped member CAN be dragged out (was: 位置没有变化)', async () => {
  const h = harness();
  // c 是「甲组」最后一条，拖到组外紧邻处（下一组的组头之前）——真实位置不变，但它要离开组
  await move(h, ['c'], { before: { id: 'd' } });
  assert.equal(h.raw(), 'abcde', '位置本来就在这里');
  assert.equal(h.assign.c, null, '标为明确不分组，自动折叠不会再拉回去');
  assert.equal(h.notes.at(-1)[1], '1 项已移出分组');
  // 甲组只剩 b 一条，自动组不成立，a b c 都是散条
  assert.equal(h.shape(), '·[abc] 心情[de]');
});

test('custom member dragged outside leaves; dragged back inside rejoins; whole-group drag keeps the group', async () => {
  const h = harness(base(), { b: '甲组', c: '甲组' });
  await move(h, ['c'], { before: null });
  assert.equal(h.raw(), 'abdec');
  assert.equal(h.shape(), '·[a] 甲组*[b] 心情[de] ·[c]', '离开分组并显示在落点；剩一条的自定义组仍显示（是你手动建的）');
  await move(h, ['c'], { before: null, group: '甲组', members: ['b'] });
  assert.equal(h.shape(), '·[a] 甲组*[b] 心情[de] 甲组*[c]', '组内落点按真实位置归组，不偷偷挪');
  const g = harness(base(), { b: '甲组', c: '甲组' });
  await move(g, ['b', 'c'], { before: null });
  assert.equal(g.shape(), '·[a] 心情[de] 甲组*[bc]', '整组拖动 = 搬动这个组');
});

test('移入分组 sets the custom group, gathers items at the group end, and never renames', async () => {
  const h = harness();
  await h.ctrl.actions.retag({ items: [{ source: 'global', id: 'a', name: '' }], tag: '心情' });
  assert.equal(h.raw(), 'bcdea', '挪到该组末尾，执行顺序随之连成一段');
  assert.equal(h.shape(), '甲组[bc] 心情*[dea]');
  assert.equal(h.ctx.extensionSettings.regex.find(s => s.id === 'a').scriptName, '(A选一)独立条目5', '名字不动');
  await h.ctrl.actions.retag({ items: [{ source: 'global', id: 'a', name: '' }], tag: '' });
  assert.equal(h.assign.a, undefined, '留空 = 回到自动');
});

test('rename turns an auto group into a custom one; unfix returns it to auto', async () => {
  const h = harness();
  await h.ctrl.actions.renameGroup({ from: '', to: '画图', members: [{ id: 'b' }, { id: 'c' }] });
  assert.equal(h.shape(), '·[a] 画图*[bc] 心情[de]');
  await h.ctrl.actions.renameGroup({ from: '画图', to: '生图', members: [{ id: 'b' }, { id: 'c' }] });
  assert.equal(h.shape(), '·[a] 生图*[bc] 心情[de]');
  h.ctrl.actions.unfixGroup({ name: '生图' });
  assert.equal(h.shape(), '·[a] 甲组[bc] 心情[de]', '取消自定义 = 回到自动折叠');
});

test('delete + undo keeps the manual assignment', async () => {
  const h = harness(base(), { b: '组', c: '组' });
  await h.ctrl.actions.removeMany({ items: [{ source: 'global', id: 'b', name: '' }] });
  assert.equal(h.assign.b, undefined);
  await h.ctrl.actions.undoRemove({});
  assert.equal(h.assign.b, '组');
  assert.equal(h.shape(), '·[a] 组*[bc] 心情[de]');
});
