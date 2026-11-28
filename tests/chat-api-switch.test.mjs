import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  readProfiles, normalizeSwitchState, arrangeProfiles, togglePinned, moveToGroup, markUsed, checkProfileName, patchProfile,
} from '../features/chat/qianmu-chat-api-switch.js';

const raw = () => ({ profiles: [
  { id: 'a', name: '甲 Claude', mode: 'cc', api: 'claude', model: 'claude-x', preset: '长文', 'secret-id': 's1' },
  { id: 'b', name: '乙 自定义', mode: 'cc', api: 'custom', 'api-url': 'https://x.example/v1', model: 'm-b' },
  { id: 'c', name: '丙', mode: 'tc', api: 'textgenerationwebui' },
  { id: '', name: '坏的' }, null,
], selectedProfile: 'b' });
const ctxWith = (manager = raw()) => ({ extensionSettings: { connectionManager: manager }, saveSettingsDebounced() { this.saved = (this.saved || 0) + 1; } });

test('profiles are read from ST’s connection manager as they are; keys stay a yes/no', () => {
  const data = readProfiles(ctxWith());
  assert.equal(data.available, true);assert.equal(data.selected, 'b');
  assert.deepEqual(data.profiles.map((p) => [p.id, p.api, p.url, p.model, p.preset, p.hasSecret]), [
    ['a', 'claude', '', 'claude-x', '长文', true], ['b', 'custom', 'https://x.example/v1', 'm-b', '', false], ['c', 'textgenerationwebui', '', '', '', false]]);
  assert.doesNotMatch(JSON.stringify(data), /s1/, 'the secret id itself is not carried');
  assert.equal(readProfiles({}).available, false);
  assert.equal(readProfiles(ctxWith({ profiles: raw().profiles, selectedProfile: 'gone' })).selected, '');
});

test('pinned first, then groups, then the rest by recent use (unused by name); each profile appears once', () => {
  const { profiles } = readProfiles(ctxWith());
  let state = togglePinned({}, 'c');
  state = { ...state, groups: [{ id: 'g', name: '工作', ids: ['a', 'c'] }] };
  state = markUsed(markUsed(state, 'b', 10), 'a', 5);
  const out = arrangeProfiles(profiles, state);
  assert.deepEqual(out.pinned.map((p) => p.id), ['c']);
  assert.deepEqual(out.groups.map((g) => [g.name, g.items.map((p) => p.id)]), [['工作', ['a']]], 'c is pinned, so it is not repeated in its group');
  assert.deepEqual(out.others.map((p) => p.id), ['b']);
  const byName = ['a', 'b'].sort((x, y) => profiles.find((p) => p.id === x).name.localeCompare(profiles.find((p) => p.id === y).name));
  assert.deepEqual(arrangeProfiles(profiles, markUsed({}, 'c', 9)).others.map((p) => p.id), ['c', ...byName], 'used first, the rest by name');
  assert.deepEqual(togglePinned(togglePinned({}, 'a'), 'a').pinned, []);
});

test('moving into a group takes it out of any other group; moving to none takes it out', () => {
  let state = normalizeSwitchState({ groups: [{ id: 'g1', name: '一', ids: ['a'] }, { id: 'g2', name: '二', ids: [] }] });
  state = moveToGroup(state, 'a', 'g2');
  assert.deepEqual(state.groups.map((g) => g.ids), [[], ['a']]);
  state = moveToGroup(state, 'a', '');
  assert.deepEqual(state.groups.map((g) => g.ids), [[], []]);
  assert.deepEqual(normalizeSwitchState({ groups: [{ id: 'x', name: '', ids: ['a', 'a'] }, { id: 'y', ids: ['a'] }] }).groups.map((g) => [g.name, g.ids]), [['未命名分组', ['a']], ['未命名分组', []]]);
});

test('names are checked like ST does, plus no | or {{ that would break the slash command', () => {
  const { profiles } = readProfiles(ctxWith());
  assert.equal(checkProfileName('  ', profiles), '名称不能为空');
  assert.match(checkProfileName('a|b', profiles), /\|/);assert.match(checkProfileName('{{char}}', profiles), /\{\{/);
  assert.equal(checkProfileName('甲 Claude', profiles), '已有同名的连接');
  assert.equal(checkProfileName('甲 Claude', profiles, 'a'), '', 'keeping its own name is fine');
});

test('editing writes ST’s own fields; an empty address or preset removes the field', () => {
  const ctx = ctxWith();
  patchProfile(ctx, 'b', { name: '乙 新名', url: 'https://y.example/v1', model: 'm-2', preset: '' });
  const b = ctx.extensionSettings.connectionManager.profiles[1];
  assert.deepEqual([b.name, b['api-url'], b.model, 'preset' in b], ['乙 新名', 'https://y.example/v1', 'm-2', false]);
  patchProfile(ctx, 'a', { name: '甲 Claude', url: undefined, model: 'claude-y', preset: '短文' });
  const a = ctx.extensionSettings.connectionManager.profiles[0];
  assert.deepEqual([a.model, a.preset, 'api-url' in a, a['secret-id']], ['claude-y', '短文', false, 's1'], 'the key reference is left alone');
  assert.equal(ctx.saved, 2);
  assert.throws(() => patchProfile(ctx, 'a', { name: '乙 新名' }), /同名/);
  assert.throws(() => patchProfile(ctx, 'zz', { name: 'x' }), /不存在/);
});

test('the active connection is lifted out of pinned / groups / recent and listed first', () => {
  const { profiles } = readProfiles(ctxWith());
  const state = { pinned: ['a'], groups: [{ id: 'g', name: '工作', ids: ['c'] }] };
  const out = arrangeProfiles(profiles, state, 'a');
  assert.equal(out.active.id, 'a'); assert.deepEqual(out.pinned, []);
  assert.deepEqual(out.groups[0].items.map((p) => p.id), ['c']); assert.deepEqual(out.others.map((p) => p.id), ['b']);
  assert.equal(arrangeProfiles(profiles, state, 'c').groups[0].items.length, 0, 'out of its group too');
  assert.equal(arrangeProfiles(profiles, state).active, null);
  assert.equal(arrangeProfiles(profiles, state, 'gone').active, null);
});

test('fetched model lists are kept per connection, cleaned and capped; deleting a connection forgets everything about it', async () => {
  const { MODEL_LIST_CAP, setModels, forgetProfile } = await import('../features/chat/qianmu-chat-api-switch.js');
  const many = Array.from({ length: MODEL_LIST_CAP + 20 }, (_, i) => `m${i}`);
  const state = normalizeSwitchState({ models: { a: [' x ', 'x', '', 3, 'y'], b: many, c: [], d: 'nope', '': ['z'] } });
  assert.deepEqual(state.models.a, ['x', 'y']); assert.equal(state.models.b.length, MODEL_LIST_CAP);
  assert.deepEqual(Object.keys(state.models).sort(), ['a', 'b'], 'empty or malformed lists are dropped');
  assert.deepEqual(normalizeSwitchState({ models: ['bad'] }).models, {}); assert.deepEqual(normalizeSwitchState(null).models, {});
  assert.deepEqual(setModels(state, 'c', ['q']).models.c, ['q']);
  assert.equal(setModels(state, 'a', []).models.a, undefined, 'an empty list removes the entry');
  let full = { ...state, pinned: ['a', 'b'], groups: [{ id: 'g', name: '一', ids: ['a', 'b'] }], recent: { a: 1, b: 2 } };
  full = forgetProfile(full, 'a');
  assert.deepEqual([full.pinned, full.groups[0].ids, Object.keys(full.recent), Object.keys(full.models)], [['b'], ['b'], ['b'], ['b']]);
});

test('a typed group name joins the existing group or creates a new one; empty means no group', async () => {
  const { ensureGroup } = await import('../features/chat/qianmu-chat-api-switch.js');
  const base = { groups: [{ id: 'g1', name: '工作', ids: [] }] };
  assert.deepEqual(ensureGroup(base, ' 工作 ').id, 'g1');
  const made = ensureGroup(base, '新组', () => 'g2');
  assert.equal(made.id, 'g2'); assert.deepEqual(made.state.groups.map((g) => g.name), ['工作', '新组']);
  assert.deepEqual(moveToGroup(made.state, 'a', made.id).groups.map((g) => g.ids), [[], ['a']]);
  assert.equal(ensureGroup(base, '  ').id, '');
});
