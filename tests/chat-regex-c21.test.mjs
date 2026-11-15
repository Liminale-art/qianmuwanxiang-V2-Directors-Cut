// C-21：移动后列表不变（聚拢引入）——落点决定分组归属、残留单成员组、散条分段折叠。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createChatRegex, groupRegexWithFixed, pruneRegexGroups, shrunkRegexGroups } = await import('../features/chat/qianmu-chat-regex.js');

const base = () => [
  { id: 'a', scriptName: '(A选一)极简状态栏5' }, { id: 'b', scriptName: '柏宝绘 · 生图标签占位' }, { id: 'c', scriptName: '柏宝绘 · 隐藏生图标签' },
  { id: 'd', scriptName: '情感变化1' }, { id: 'e', scriptName: '情感变化2' }];
const shape = (ctx, groups) => groupRegexWithFixed(ctx.extensionSettings.regex.map(s => ({ id: s.id, name: s.scriptName })), groups)
  .map(r => `${r.label || '·'}${r.fixed ? '*' : ''}[${r.items.map(i => i.id).join('')}]`).join(' ');

async function move(groups0, ids, at) {
  const ctx = { extensionSettings: { regex: base() }, getCurrentChatId: () => 'c', reloadCurrentChat: async () => {}, saveSettingsDebounced() {} };
  let groups = structuredClone(groups0);
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => ctx, timers: { set: () => 1, clear() {} }, notify: (m, t) => notes.push([t, m]),
    readGroups: () => groups, writeGroups: v => { groups = JSON.parse(JSON.stringify(v)); } });
  const before = shape(ctx, groups);
  ctrl.actions.pickMove({ source: 'global', items: ids.map(id => ({ id, name: '' })) });
  await ctrl.actions.dropMove({ source: 'global', ...at });
  return { before, after: shape(ctx, groups), raw: ctx.extensionSettings.regex.map(s => s.id).join(''), groups: groups.members, note: notes.at(-1) };
}
const fixedABC = { order: ['柏宝绘'], members: { 柏宝绘: ['a', 'b', 'c'] } };

test('C-21: moving a fixed-group member OUTSIDE the group really takes it out (was: list unchanged, toast said moved)', async () => {
  const end = await move(fixedABC, ['c'], { before: null });
  assert.equal(end.before, '柏宝绘*[abc] 情感变化[de]');
  assert.equal(end.after, '柏宝绘*[ab] 情感变化[de] ·[c]', '移到列表末尾 = 离开分组，显示也在末尾');
  assert.deepEqual(end.groups, { 柏宝绘: ['a', 'b'] });
  const top = await move(fixedABC, ['c'], { before: { id: 'a' } });
  assert.equal(top.after, '·[c] 柏宝绘*[ab] 情感变化[de]', '组头之前 = 组外');
});

test('C-21: user case — 情感变化1 into 柏宝绘 shows up in that group', async () => {
  const between = await move(fixedABC, ['d'], { before: { id: 'c' }, group: '柏宝绘' });
  assert.equal(between.after, '柏宝绘*[abdc] ·[e]');
  assert.equal(between.note[1], '1 项已移至指定位置');
  const end = await move(fixedABC, ['d'], { before: { id: 'd' }, group: '柏宝绘' });
  assert.equal(end.after, '柏宝绘*[abcd] ·[e]', '组内末尾：顺序没变也归入该组');
  assert.equal(end.note[1], '1 项已加入分组「柏宝绘」');
});

test('C-21: joining an AUTO group fixes the whole group (was: a 1-member ghost group that broke the auto group apart)', async () => {
  const r = await move({ order: [], members: {} }, ['d'], { before: { id: 'c' }, group: '柏宝绘' });
  assert.equal(r.before, '·[a] 柏宝绘[bc] 情感变化[de]');
  assert.equal(r.after, '·[a] 柏宝绘*[bdc] ·[e]', '原组成员与新来的条目一起成为固定组');
  assert.deepEqual(r.groups, { 柏宝绘: ['b', 'c', 'd'] });
});

test('C-21: a leaving member drops a group to one → that group is cleared; dragging a whole group keeps it', async () => {
  const two = { order: ['情感变化'], members: { 情感变化: ['d', 'e'] } };
  const r = await move(two, ['d'], { before: { id: 'a' } });
  assert.deepEqual(r.groups, {}, '只剩一条的组随写入清掉，不留幽灵');
  const whole = await move(fixedABC, ['a', 'b', 'c'], { before: null });
  assert.equal(whole.after, '情感变化[de] 柏宝绘*[abc]', '整组拖动 = 搬动这个组，不是解散');
  assert.deepEqual(whole.groups, { 柏宝绘: ['a', 'b', 'c'] });
});

test('C-21: loose rows separated by a fixed group are folded per real segment (no row jumping above)', () => {
  const rows = base().map(s => ({ id: s.id, name: s.scriptName }));
  const order = ['a', 'b', 'd', 'c', 'e'].map(id => rows.find(r => r.id === id));
  const runs = groupRegexWithFixed(order, { order: ['柏宝绘'], members: { 柏宝绘: ['b', 'c', 'd'] } });
  assert.deepEqual(runs.map(r => r.items.map(i => i.id).join('')), ['a', 'bdc', 'e'], 'e 仍在最后，不会和 a 折到一起跑到上面');
});

test('C-21: a legacy single-member fixed group still merges with its same-name auto run, and unrelated moves do not wipe it', async () => {
  const ghost = { order: ['柏宝绘'], members: { 柏宝绘: ['a'] } };
  const r = await move(ghost, ['e'], { before: null });
  assert.equal(r.before, '柏宝绘*[abc] 情感变化[de]');
  assert.equal(r.after, r.before, '无关移动不清理旧组，别处条目不跳动');
  assert.equal(r.note[0], 'info', '位置没变：不报成功');
  assert.deepEqual(pruneRegexGroups(ghost, '', shrunkRegexGroups(ghost, ghost)).members, { 柏宝绘: ['a'] });
});
