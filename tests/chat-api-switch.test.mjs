import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  readProfiles, normalizeSwitchState, arrangeProfiles, togglePinned, moveToGroup, markUsed, checkProfileName, patchProfile,
  renderSwitchPage, renderProfileRow, createChatApiSwitch,
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

test('the page shows the current connection, tags mirroring ST, and the arranged list', () => {
  const data = readProfiles(ctxWith());
  const html = renderSwitchPage({ data, state: { pinned: ['a'], groups: [{ id: 'g', name: '备用<组>', ids: ['c'] }] } });
  assert.match(html, /当前连接[\s\S]*qm-api-row qm-api-row-current is-active" data-id="b"/);
  assert.match(html, /<h4>置顶<\/h4>[\s\S]*data-id="a"[\s\S]*<h4>备用&lt;组&gt;<\/h4>[\s\S]*data-id="c"[\s\S]*<h4>最近使用<\/h4>[\s\S]*data-id="b"/);
  assert.match(renderProfileRow(data.profiles[0]), /<span class="qm-api-tag">Claude<\/span><span class="qm-api-tag">模型 claude-x<\/span><span class="qm-api-tag">预设 长文<\/span>/);
  assert.match(renderProfileRow({ id: 'd', name: '丁', api: '', model: '', preset: '' }), /未记预设与模型/);
  const edit = renderSwitchPage({ data, state: {}, openId: 'b', openKind: 'edit', presets: ['长文', '短文'] });
  assert.match(edit, /qm-api-f-url" value="https:\/\/x.example\/v1"/);assert.match(edit, /<option value="短文">短文<\/option>/);
  assert.match(edit, /密钥：跟随 ST 当前/);
  const claude = renderSwitchPage({ data, state: {}, openId: 'a', openKind: 'edit', presets: [] });
  assert.doesNotMatch(claude, /qm-api-f-url/, 'no address field for a built-in source');
  assert.match(claude, /<option value="长文" selected>长文<\/option>/);assert.match(claude, /密钥：ST 已为这条连接存好/);
  assert.match(renderSwitchPage({ data: readProfiles({}), state: {} }), /没有找到 ST 的「连接配置」/);
});

test('picking a row switches through ST’s own profile dropdown and records the use', async () => {
  const handlers = new Map(), toasts = [], owner = {};
  const ctx = { ...ctxWith(), eventTypes: { CONNECTION_PROFILE_LOADED: 'loaded' }, eventSource: { once: (type, run) => handlers.set(type, run), emit: async () => {} } };
  const options = ['', 'a', 'b', 'c'].map((value) => ({ value }));
  const select = { options, value: 'b', dispatchEvent: (event) => { assert.equal(event.type, 'change'); ctx.extensionSettings.connectionManager.selectedProfile = select.value; handlers.get('loaded')?.(); } };
  let host = null;
  const doc = { getElementById: (id) => (id === 'connection_profiles' ? select : null) };
  const sw = createChatApiSwitch({ getContext: () => ctx, getOwner: () => owner, save: () => {}, notify: (m, l) => toasts.push([m, l]), doc });
  const listeners = {};
  host = { isConnected: true, innerHTML: '', addEventListener: (type, run) => { listeners[type] = run; }, querySelector: () => null };
  sw.mount(host);
  assert.match(host.innerHTML, /当前连接/);
  const pick = { disabled: false };
  const target = { closest: (sel) => (sel === '.qm-api-pick' ? pick : sel.startsWith('.qm-api-row') ? { dataset: { id: 'a' } } : null) };
  await listeners.click({ target });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(select.value, 'a');assert.equal(ctx.extensionSettings.connectionManager.selectedProfile, 'a');
  assert.ok(owner.apiSwitch.recent.a > 0);
  assert.deepEqual(toasts.at(-1), ['已切换到「甲 Claude」', 'success']);
  // 在 ST 原生里切换：也记最近使用
  sw.events.profileLoaded('丙');
  assert.ok(owner.apiSwitch.recent.c > 0);
});

test('the toolkit gets an API tab that mounts the page and follows ST’s profile events', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /data-floor-tab="regex">快切<\/button><button type="button" role="tab" data-floor-tab="api">API<\/button>/);
  assert.match(source, /if \(floorNavigatorView === 'api'\) chatApiSwitch\.mount\(/);
  assert.match(source, /CONNECTION_PROFILE_LOADED \|\| 'connection_profile_loaded', chatApiSwitch\.events\.profileLoaded/);
  const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sd-floor-tabs \{ display: grid; grid-template-columns: repeat\(6,/);
});
