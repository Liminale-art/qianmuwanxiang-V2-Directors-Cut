import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChatSaveFollowup } from '../features/chat/qianmu-chat-save-followup.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
function fixture({ replies }) {
  const timers = []; const calls = []; const context = { chatId: 'chat-a', saves: 0, saveChat: null };
  const followup = createChatSaveFollowup({
    fetchImpl: async (input, init) => { calls.push([String(input), init?.method]); return replies.shift()(); },
    getContext: () => context, baseUrl: 'http://st.local', schedule: fn => { timers.push(fn); return timers.length; }, cancel: id => { timers[id - 1] = () => {}; },
  });
  context.saveChat = async () => { context.saves++; await followup.fetch('/api/chats/save', { method: 'POST', body: '{}' }); };
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  const fire = async () => { const pending = timers.splice(0); for (const fn of pending) await fn(); await settle(); };
  return { followup, context, calls, timers, settle, fire };
}

test('a save answered as skipped is saved once more; the original response is returned untouched', async () => {
  const skipped = json({ ok: true, skipped: true });
  const f = fixture({ replies: [() => skipped, () => json({ ok: true })] });
  const response = await f.followup.fetch('/api/chats/save', { method: 'POST', body: '{}' });
  assert.equal(response, skipped); assert.deepEqual(await response.json(), { ok: true, skipped: true }, 'the caller can still read the body');
  await f.settle(); assert.equal(f.timers.length, 1); assert.equal(f.context.saves, 0, 'nothing happens before the delay');
  await f.fire(); assert.equal(f.context.saves, 1); assert.equal(f.calls.length, 2);
  await f.fire(); assert.equal(f.context.saves, 1, 'one follow-up per skipped save');
});

test('native saves, other requests and failures are left completely alone', async () => {
  const f = fixture({ replies: [() => json({ ok: true }), () => json({ skipped: true }), () => json({ skipped: true }), () => new Response('nope', { status: 500 }), () => new Response('ok')] });
  await f.followup.fetch('/api/chats/save', { method: 'POST' });
  await f.followup.fetch('/api/chats/group/save', { method: 'POST' });
  await f.followup.fetch('/api/chats/save', { method: 'GET' });
  await f.followup.fetch('/api/chats/save', { method: 'POST' });
  await f.followup.fetch('/api/chats/save', { method: 'POST' });
  await f.settle(); await f.fire(); assert.equal(f.context.saves, 0);
});

test('no follow-up when a real write landed meanwhile, the chat changed, or the follow-up itself is skipped', async () => {
  let f = fixture({ replies: [() => json({ skipped: true }), () => json({ ok: true })] });
  await f.followup.fetch('/api/chats/save', { method: 'POST' }); await f.settle();
  await f.followup.fetch('/api/chats/save', { method: 'POST' }); await f.settle();
  await f.fire(); assert.equal(f.context.saves, 0, 'an ordinary save already carried the state');

  f = fixture({ replies: [() => json({ skipped: true })] });
  await f.followup.fetch('/api/chats/save', { method: 'POST' }); await f.settle();
  f.context.chatId = 'chat-b'; await f.fire(); assert.equal(f.context.saves, 0, 'never saves a different chat');

  f = fixture({ replies: [() => json({ skipped: true }), () => json({ skipped: true })] });
  await f.followup.fetch('/api/chats/save', { method: 'POST' }); await f.settle();
  await f.fire(); assert.equal(f.context.saves, 1); await f.fire(); assert.equal(f.context.saves, 1, 'a skipped follow-up is not chased again');

  f = fixture({ replies: [() => json({ skipped: true })] });
  await f.followup.fetch('/api/chats/save', { method: 'POST' }); await f.settle();
  f.followup.dispose(); await f.fire(); assert.equal(f.context.saves, 0);
});

test('the entry puts the follow-up inside the write guard and releases it with the guard', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /chatSaveFollowup = createChatSaveFollowup\(\{ fetchImpl: chatWriteFetchBefore\.bind\(globalThis\), getContext: ctx,/);
  assert.match(entry, /createChatWriteGuard\(\{ fetchImpl: chatSaveFollowup\.fetch, getContext: ctx,/);
  assert.match(entry, /chatSaveFollowup\?\.dispose\(\); chatSaveFollowup = null;/);
});
