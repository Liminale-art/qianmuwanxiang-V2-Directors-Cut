import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createChatWriteGuard } from '../qianmu-chat-write-guard.js';

const baseUrl = 'https://synthetic.invalid';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const input = chat => ({ avatar_url: 'Same.png', file_name: 'same-chat', ...(chat ? { chat } : {}) });
const empty = [{ chat_metadata: {} }];
const init = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const nonempty = [{ chat_metadata: { integrity: 'synthetic' } }, { mes: 'synthetic only' }];
const until = async check => { for (let i = 0; i < 100 && !check(); i++) await Promise.resolve(); assert.ok(check()); };

test('a late old-account resolution cannot revoke a newer confirmed account baseline', async () => {
  const oldOwner = deferred(), loading = deferred(), calls = [], blocks = [];
  let resolutions = 0;
  const context = { chatId: 'same-chat', characterId: 0, characters: [{ avatar: 'Same.png', chat: 'same-chat' }],
    chat: [{ mes: 'B nonempty' }], chatMetadata: { integrity: 'B' } };
  const guard = createChatWriteGuard({ baseUrl, getContext: () => context,
    resolveAccount: () => ++resolutions === 1 ? oldOwner.promise : Promise.resolve('st-user:B'),
    onBlock: event => blocks.push(event), fetchImpl: async (url, request) => {
      calls.push({ url, request }); return url.endsWith('/get') ? loading.promise : new Response('{}');
    } });
  const stale = guard.observeCurrent();
  assert.equal(await guard.observeCurrent(), true);
  oldOwner.resolve('st-user:A'); await stale;
  context.chat = []; context.chatMetadata = {};
  const reading = guard.fetch('/api/chats/get', init(input())); await until(() => calls.length === 1);
  try {
    await assert.rejects(guard.fetch('/api/chats/save', init(input(empty))), { code: 'qianmu_chat_empty_write_blocked' });
    assert.equal(calls.length, 1);
    assert.equal(blocks.length, 1);
  } finally {
    loading.resolve(new Response(JSON.stringify(nonempty)));
    await (await reading).json(); guard.dispose();
  }
});

test('a valid gzip Request is forwarded once with the same object, receiver and original compressed bytes', async () => {
  const bytes = gzipSync(JSON.stringify(input(nonempty))), calls = [], receiver = { marker: true };
  const request = new Request(`${baseUrl}/api/chats/save`, { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: bytes });
  const response = new Response('{"saved":true}');
  const guard = createChatWriteGuard({ baseUrl, getContext: () => ({}), resolveAccount: async () => 'st-user:A',
    fetchImpl: async function (arg) {
      calls.push({ arg, receiver: this });
      assert.deepEqual(Buffer.from(await arg.arrayBuffer()), bytes);
      assert.deepEqual(JSON.parse(gunzipSync(bytes)), input(nonempty)); return response;
    } });
  assert.equal(await guard.fetch.call(receiver, request), response);
  assert.equal(calls.length, 1); assert.equal(calls[0].arg, request); assert.equal(calls[0].receiver, receiver);
  assert.equal(request.bodyUsed, true); guard.dispose();
});

test('Response JSON window closes on parsing failure without replaying or substituting host errors', async () => {
  const loading = deferred(), json = deferred(), calls = [];
  const context = { chatId: 'same-chat', characterId: 0, characters: [{ avatar: 'Same.png', chat: 'same-chat' }],
    chat: [{ mes: 'original' }], chatMetadata: { integrity: 'old' } };
  const guard = createChatWriteGuard({ baseUrl, getContext: () => context, resolveAccount: async () => 'st-user:A',
    fetchImpl: async url => { calls.push(url); return url.endsWith('/get') ? loading.promise : new Response('{}'); } });
  await guard.observeCurrent(); context.chat = []; context.chatMetadata = {};
  const reading = guard.fetch('/api/chats/get', init(input())); await until(() => calls.length === 1);
  const original = { ok: true, json: () => json.promise };
  loading.resolve(original); assert.equal(await reading, original);
  const parsing = original.json(), failure = new SyntaxError('synthetic parse failure');
  await assert.rejects(guard.fetch('/api/chats/save', init(input(empty))), { code: 'qianmu_chat_empty_write_blocked' });
  const rejectParsing = assert.rejects(parsing, error => error === failure);
  // Assimilate an explicitly rejected thenable without creating an unobserved rejection.
  json.resolve({ then(_yes, no) { no(failure); } }); await rejectParsing;
  await guard.fetch('/api/chats/save', init(input(empty)));
  assert.deepEqual(calls, ['/api/chats/get', '/api/chats/save']); guard.dispose();
});
