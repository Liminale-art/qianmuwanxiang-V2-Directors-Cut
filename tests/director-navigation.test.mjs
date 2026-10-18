import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorNavigation } from '../qianmu-director-navigation.js';

function fixture() {
  const state = { characters: [{ avatar: 'a.png', chat: 'old' }, { avatar: 'b.png', chat: 'target' }],
    groups: [{ id: 'g1', chat_id: 'g-old', chats: ['g-old', 'g-history'] }, { id: 'g2', chat_id: 'g-target', chats: ['g-target'] }],
    characterId: 0, groupId: null, chatId: 'old' };
  const calls = [], hooks = { current: true, confirm: true, idle: true };
  const setChat = chat => { state.chatId = chat;
    if (state.groupId) state.groups.find(item => item.id === state.groupId).chat_id = chat;
    else state.characters[state.characterId].chat = chat;
  };
  const selectCharacter = index => { state.groupId = null; state.characterId = index; state.chatId = state.characters[index].chat; };
  const selectGroup = id => { state.groupId = id; state.characterId = undefined; state.chatId = state.groups.find(item => item.id === id).chat_id; };
  const host = { async ready() { await hooks.ready?.(); }, assertIdle() { if (!hooks.idle) throw new Error('busy'); },
    async closeChat() { calls.push(['close']); state.characterId = undefined; state.groupId = null; state.chatId = undefined; return true; } };
  const main = {
    async selectCharacterById(index) { calls.push(['character', index]); selectCharacter(index); },
    async getPastCharacterChats(index) { calls.push(['list', index]); await hooks.list?.(); return hooks.entries ?? [{ file_id: 'history', file_name: 'history.jsonl' }]; },
    async openCharacterChat(file) { calls.push(['history', file]); setChat(file); },
    async doNewChat(options) { calls.push(['new', options]); setChat('new-chat'); },
  };
  const groups = {
    async openGroupById(id) { calls.push(['group', id]); selectGroup(id); return true; },
    async openGroupChat(id, file) { calls.push(['group-history', id, file]); setChat(file); },
  };
  const adapter = createDirectorNavigation({ getContext: () => state, host,
    loadMain: async () => { await hooks.load?.(); return main; }, loadGroups: async () => { await hooks.load?.(); return groups; },
    confirmNew: async () => { calls.push(['confirm']); await hooks.prompt?.(); return hooks.confirm; },
    hideHistory: () => calls.push(['hide']) });
  return { state, hooks, calls, main, groups, host, adapter, setChat, selectCharacter, selectGroup,
    run: raw => adapter.navigate(adapter.capture(raw), { isCurrent: () => hooks.current }) };
}

test('capture keeps frozen primitive identities and never mutates context', () => {
  const f = fixture(), before = JSON.stringify(f.state), intent = f.adapter.capture({ kind: 'character', id: '1' });
  assert.deepEqual(intent, { kind: 'character', source: { kind: 'character', avatar: 'a.png', chatId: 'old' }, target: { avatar: 'b.png', chatId: 'target' } });
  assert.equal(Object.isFrozen(intent), true); assert.equal(Object.isFrozen(intent.source), true); assert.equal(Object.isFrozen(intent.target), true);
  assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
});

test('character is re-resolved by avatar after list reorder, not stale index', async () => {
  const f = fixture(), intent = f.adapter.capture({ kind: 'character', id: 1 });
  f.state.characters.reverse(); f.state.characterId = 1;
  assert.equal(await f.adapter.navigate(intent, { isCurrent: () => true }), 'completed');
  assert.deepEqual(f.calls, [['character', 0]]);
});

for (const mutate of [
  f => { f.state.characters.pop(); },
  f => { f.state.characters[1].avatar = 'replacement.png'; },
  f => { f.state.characters[1].chat = 'changed'; },
  f => { f.state.characters.push({ avatar: 'b.png', chat: 'target' }); },
]) test(`changed target is not navigated (${mutate.toString()})`, async () => {
  const f = fixture(), intent = f.adapter.capture({ kind: 'character', id: 1 }); mutate(f);
  assert.equal(await f.adapter.navigate(intent, { isCurrent: () => true }), 'unavailable'); assert.deepEqual(f.calls, []);
});

for (const raw of [null, {}, { kind: 'delete' }, { kind: 'character', id: '1e0' }, { kind: 'character', id: -1 },
  { kind: 'group', id: 'missing' }, { kind: 'history', file: '../outside' }, { kind: 'history', file: '' }, { kind: 'new' }]) {
  test(`malformed intent rejected: ${JSON.stringify(raw)}`, () => assert.equal(fixture().adapter.capture(raw), null));
}

test('duplicate/unknown current owner and inconsistent chat identity fail closed', () => {
  const f = fixture(); f.state.characters.push({ avatar: 'a.png', chat: 'old' });
  assert.equal(f.adapter.capture({ kind: 'close' }), null);
  f.state.characters.pop(); f.state.chatId = 'different';
  assert.equal(f.adapter.capture({ kind: 'new', confirm: false }), null);
});

test('forged, cloned and consumed intents cannot invoke native operations', async () => {
  const f = fixture(), intent = f.adapter.capture({ kind: 'close' });
  assert.equal(await f.adapter.navigate({ ...intent }, { isCurrent: () => true }), 'unavailable');
  assert.equal(await f.adapter.navigate(intent, { isCurrent: () => true }), 'completed');
  assert.equal(await f.adapter.navigate(intent, { isCurrent: () => true }), 'unavailable');
  assert.deepEqual(f.calls, [['close']]);
});

test('group selection uses openGroupById and verifies destination', async () => {
  const f = fixture(); assert.equal(await f.run({ kind: 'group', id: 'g2' }), 'completed');
  assert.deepEqual(f.calls, [['group', 'g2']]);
});

test('group history is bound to selected group and its live history membership', async () => {
  const f = fixture(); f.selectGroup('g1');
  assert.equal(await f.run({ kind: 'history', file: 'g-history' }), 'completed');
  assert.deepEqual(f.calls, [['group-history', 'g1', 'g-history'], ['hide']]);
  assert.equal(f.adapter.capture({ kind: 'history', file: 'g-target' }), null);
});

test('group history removed while loading is not reopened', async () => {
  const f = fixture(); f.selectGroup('g1'); f.hooks.load = () => { f.state.groups[0].chats = ['g-old']; };
  assert.equal(await f.run({ kind: 'history', file: 'g-history' }), 'unavailable'); assert.deepEqual(f.calls, []);
});

for (const entries of [[{ file_id: 'history' }], [{ file_name: 'history.jsonl' }]]) test('history presence checked read-only before open', async () => {
  const f = fixture(); f.hooks.entries = entries;
  assert.equal(await f.run({ kind: 'history', file: 'history' }), 'completed');
  assert.deepEqual(f.calls, [['list', 0], ['history', 'history'], ['hide']]);
});

test('logical name ending in .jsonl is preserved, not mistaken for another file', async () => {
  const f = fixture(); f.hooks.entries = [{ file_name: 'history.jsonl' }];
  assert.equal(await f.run({ kind: 'history', file: 'history.jsonl' }), 'unavailable');
  f.hooks.entries = [{ file_name: 'history.jsonl.jsonl' }]; f.calls.length = 0;
  assert.equal(await f.run({ kind: 'history', file: 'history.jsonl' }), 'completed');
  assert.deepEqual(f.calls, [['list', 0], ['history', 'history.jsonl'], ['hide']]);
});

for (const entries of [[], null, { error: true }, [{ file_id: 'other' }]]) test(`missing history never becomes a new chat: ${JSON.stringify(entries)}`, async () => {
  const f = fixture(); f.hooks.entries = entries === null ? false : entries;
  assert.equal(await f.run({ kind: 'history', file: 'history' }), 'unavailable'); assert.deepEqual(f.calls, [['list', 0]]);
});

for (const phase of ['ready', 'load', 'list', 'prompt']) test(`source checked again after ${phase}`, async () => {
  const f = fixture(); f.hooks[phase] = () => f.setChat('changed');
  const raw = phase === 'prompt' ? { kind: 'new', confirm: true } : { kind: 'history', file: 'history' };
  assert.equal(await f.run(raw), 'unavailable');
  assert.equal(f.calls.some(call => ['history', 'new'].includes(call[0])), false);
});

for (const phase of ['ready', 'load', 'list', 'prompt']) test(`host busy checked again after ${phase}`, async () => {
  const f = fixture(); f.hooks[phase] = () => { f.hooks.idle = false; };
  const raw = phase === 'prompt' ? { kind: 'new', confirm: true } : { kind: 'history', file: 'history' };
  await assert.rejects(f.run(raw), /busy/);
  assert.equal(f.calls.some(call => ['history', 'new'].includes(call[0])), false);
});

test('isCurrent must return exactly true', async () => {
  const f = fixture();
  assert.equal(await f.adapter.navigate(f.adapter.capture({ kind: 'close' }), { isCurrent: () => 1 }), 'unavailable');
  assert.deepEqual(f.calls, []);
});

test('menu new asks once, keeps old chat, and verifies changed chat', async () => {
  const f = fixture(); assert.equal(await f.run({ kind: 'new', confirm: true }), 'completed');
  assert.deepEqual(f.calls, [['confirm'], ['new', { deleteCurrentChat: false }]]);
});

test('manage new skips confirmation and closes only its history presentation', async () => {
  const f = fixture(); assert.equal(await f.run({ kind: 'new', confirm: false }), 'completed');
  assert.deepEqual(f.calls, [['new', { deleteCurrentChat: false }], ['hide']]);
});

test('group new uses same native doNewChat, never delete or direct group creation', async () => {
  const f = fixture(); f.selectGroup('g1');
  assert.equal(await f.run({ kind: 'new', confirm: false }), 'completed');
  assert.deepEqual(f.calls, [['new', { deleteCurrentChat: false }], ['hide']]); assert.equal(f.state.groupId, 'g1');
});

for (const answer of [false, null, undefined, 1]) test(`new popup cancellation is not a failure: ${answer}`, async () => {
  const f = fixture(); f.hooks.confirm = answer;
  assert.equal(await f.run({ kind: 'new', confirm: true }), 'cancelled'); assert.deepEqual(f.calls, [['confirm']]);
});

for (const kind of ['close', 'character', 'group', 'history', 'new']) test(`native void/no-op does not prove ${kind} completed`, async () => {
  const f = fixture();
  f.host.closeChat = async () => {}; f.main.selectCharacterById = async () => {};
  f.groups.openGroupById = async () => {}; f.main.openCharacterChat = async () => {}; f.main.doNewChat = async () => {};
  const raw = { kind, id: kind === 'group' ? 'g2' : '1', file: 'history', confirm: false };
  assert.equal(await f.run(raw), 'unavailable'); assert.equal(f.calls.some(call => call[0] === 'hide'), false);
});

test('own expected navigation invalidates source guard but still completes', async () => {
  const f = fixture(), intent = f.adapter.capture({ kind: 'history', file: 'history' });
  assert.equal(await f.adapter.navigate(intent, { isCurrent: () => f.state.chatId === 'old' }), 'completed');
});

test('native rejection is propagated with no replay or extra native operation', async () => {
  const f = fixture(); f.main.doNewChat = async options => { f.calls.push(['new', options]); throw new Error('native failure'); };
  await assert.rejects(f.run({ kind: 'new', confirm: false }), /native failure/);
  assert.deepEqual(f.calls, [['new', { deleteCurrentChat: false }]]);
});

test('same owner but unexpected destination is not reported completed', async () => {
  const f = fixture(); f.main.openCharacterChat = async () => f.setChat('unrelated');
  assert.equal(await f.run({ kind: 'history', file: 'history' }), 'unavailable'); assert.deepEqual(f.calls, [['list', 0]]);
});

test('close preserves explicit native success/refusal rather than trusting void', async () => {
  const f = fixture(); f.host.closeChat = async () => true;
  assert.equal(await f.run({ kind: 'close' }), 'completed');
  f.host.closeChat = async () => false;
  assert.equal(await f.run({ kind: 'close' }), 'unavailable');
});

test('new chat under a different owner is not confirmed or hidden', async () => {
  const f = fixture(); f.main.doNewChat = async () => { f.selectCharacter(1); f.setChat('new-chat'); };
  assert.equal(await f.run({ kind: 'new', confirm: false }), 'unavailable'); assert.deepEqual(f.calls, []);
});

test('missing optional native export fails closed without fallbacks', async () => {
  const f = fixture(); delete f.main.openCharacterChat;
  assert.equal(await f.run({ kind: 'history', file: 'history' }), 'unavailable'); assert.deepEqual(f.calls, []);
});

test('group returning false is a refusal even if target identity happens to match', async () => {
  const f = fixture(); f.groups.openGroupById = async id => { f.selectGroup(id); return false; };
  assert.equal(await f.run({ kind: 'group', id: 'g2' }), 'unavailable');
});

test('a concurrent second call cannot duplicate a native operation', async () => {
  const f = fixture(), intent = f.adapter.capture({ kind: 'new', confirm: false });
  const results = await Promise.all([f.adapter.navigate(intent, { isCurrent: () => true }), f.adapter.navigate(intent, { isCurrent: () => true })]);
  assert.deepEqual(results, ['completed', 'unavailable']); assert.deepEqual(f.calls, [['new', { deleteCurrentChat: false }], ['hide']]);
});
