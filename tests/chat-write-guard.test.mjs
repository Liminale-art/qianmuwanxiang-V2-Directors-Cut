import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createChatWriteGuard } from '../qianmu-chat-write-guard.js';

const url = 'https://synthetic.invalid';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const rows = n => [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'synthetic' } },
  ...Array.from({ length: n }, (_, i) => ({ mes: `synthetic-${i}`, is_user: false }))];
const empty = (metadata = {}) => [{ user_name: 'unused', character_name: 'unused', chat_metadata: metadata }];
const request = (chat, extra = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ avatar_url: 'Synthetic.png', file_name: 'chat-A', ...(chat ? { chat } : {}), ...extra }) });
function fixture(options = {}) {
  let account = 'st-user:synthetic', enabled = true;
  const calls = [], blocks = [], diagnostics = [], loads = [];
  const context = { characterId: 0, groupId: null, characters: [{ avatar: 'Synthetic.png', chat: 'chat-A' }], chat: rows(2).slice(1), chatMetadata: { integrity: 'synthetic' } };
  Object.defineProperty(context, 'chatId', { configurable: true, get: () => context.characters[context.characterId]?.chat });
  const fetchImpl = function (input, init) {
    calls.push({ input, init, receiver: this });
    const route = typeof input === 'string' ? input : input.url;
    if (route.endsWith('/get')) { const pending = deferred(); loads.push(pending); return pending.promise; }
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  const guard = createChatWriteGuard({ fetchImpl, getContext: () => context, resolveAccount: async () => account,
    baseUrl: url, isEnabled: () => enabled, onBlock: detail => blocks.push(detail), onDiagnostic: detail => diagnostics.push(detail), ...options });
  return { guard, context, calls, blocks, diagnostics, loads,
    set account(value) { account = value; }, set enabled(value) { enabled = value; },
  };
}
async function open(f, file = 'chat-A') {
  const before = f.loads.length;
  f.context.characters[0].chat = file; f.context.chat = []; f.context.chatMetadata = {};
  const result = f.guard.fetch('/api/chats/get', request(undefined, { file_name: file }));
  for (let i = 0; i < 100 && f.loads.length === before; i++) await Promise.resolve();
  assert.equal(f.loads.length, before + 1);
  return { result, load: f.loads.at(-1) };
}
async function finish(f, flight, data = rows(2)) {
  flight.load.resolve(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
  const response = await flight.result, parsed = await response.json();
  f.context.chat = parsed.slice(1); f.context.chatMetadata = parsed[0]?.chat_metadata ?? {};
  return response;
}
const blocked = promise => assert.rejects(promise, { code: 'qianmu_chat_empty_write_blocked' });

test('only the known nonempty exact target in its loading window rejects, without a save or replay', async () => {
  const f = fixture(); assert.equal(await f.guard.observeCurrent(), true);
  const flight = await open(f);
  await blocked(f.guard.fetch('/api/chats/save', request(empty({ arbitraryPlugin: { value: 1 } }))));
  await blocked(f.guard.fetch('/api/chats/save', request(empty())));
  assert.equal(f.calls.length, 1); assert.equal(f.blocks.length, 1);
  assert.deepEqual(f.blocks[0], { code: 'qianmu_chat_empty_write_blocked', scope: 'chat-write-guard', phase: 'loading', messageCount: 0 });
  await finish(f, flight); assert.equal(f.calls.length, 1);
  await f.guard.fetch('/api/chats/save', request(rows(2))); assert.equal(f.calls.length, 2);
});

for (const [label, build] of [
  ['plain string', () => ['/api/chats/save', request(empty())]],
  ['gzip Uint8Array', () => { const init = request(empty()); init.body = new Uint8Array(gzipSync(init.body)); init.headers['content-encoding'] = 'gzip'; return ['/api/chats/save', init]; }],
  ['gzip ArrayBuffer', () => { const init = request(empty()); const bytes = new Uint8Array(gzipSync(init.body)); init.body = bytes.buffer; init.headers['Content-Encoding'] = 'gzip'; return ['/api/chats/save', init]; }],
  ['gzip Blob', () => { const init = request(empty()); init.body = new Blob([gzipSync(init.body)]); init.headers['Content-Encoding'] = 'gzip'; return ['/api/chats/save', init]; }],
  ['native Request', () => [new Request(url + '/api/chats/save', request(empty()))]],
  ['gzip Request', () => { const init = request(empty()); init.body = gzipSync(init.body); init.headers['content-encoding'] = 'gzip'; return [new Request(url + '/api/chats/save', init)]; }],
]) {
  test(`${label}: independent inspection does not consume or mutate the original`, async () => {
    const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f), args = build();
    const before = args[1]?.body;
    await blocked(f.guard.fetch(...args)); assert.equal(f.calls.length, 1);
    if (args[0] instanceof Request) assert.equal(args[0].bodyUsed, false);
    else assert.equal(args[1].body, before);
    await finish(f, flight);
  });
}

for (const [label, data, extra] of [
  ['complete save', rows(2), {}], ['legitimate clear with integrity', empty({ integrity: 'synthetic' }), {}],
  ['new target', empty(), { file_name: 'new-chat' }], ['other character', empty(), { avatar_url: 'Other.png' }],
  ['empty array is not the reproduced header-only shape', [], {}], ['message-shaped singleton', [{ mes: '' }], {}],
]) {
  test(`${label}: forwards exactly once`, async () => {
    const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f), init = request(data, extra);
    const response = await f.guard.fetch('/api/chats/save', init);
    assert.equal(response.ok, true); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].init, init); assert.equal(f.blocks.length, 0);
    await finish(f, flight);
  });
}

test('first load without nonempty evidence passes; its parsed response establishes a later baseline', async () => {
  const f = fixture(); const first = await open(f);
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0);
  await finish(f, first); const second = await open(f);
  await blocked(f.guard.fetch('/api/chats/save', request(empty()))); await finish(f, second);
});

test('no loading GET / completed GET: never blocks an intentional missing-identity empty save', async () => {
  const f = fixture(); await f.guard.observeCurrent(); f.context.chat = []; f.context.chatMetadata = {};
  await f.guard.fetch('/api/chats/save', request(empty()));
  const flight = await open(f); await finish(f, flight); f.context.chat = []; f.context.chatMetadata = {};
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0);
});

test('response JSON body still in flight remains protected; native response stays readable', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f);
  let controller;
  const original = new Response(new ReadableStream({ start(c) { controller = c; } }));
  flight.load.resolve(original); const response = await flight.result; assert.equal(response, original);
  const parsing = response.json();
  await blocked(f.guard.fetch('/api/chats/save', request(empty())));
  controller.enqueue(new TextEncoder().encode(JSON.stringify(rows(3)))); controller.close();
  assert.deepEqual(await parsing, rows(3));
  await assert.rejects(response.json(), TypeError);
});

test('original GET error and JSON error remain errors and clear their exact loading windows', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const one = await open(f), error = new Error('synthetic transport failure');
  one.load.reject(error); await assert.rejects(one.result, value => value === error);
  await f.guard.fetch('/api/chats/save', request(empty()));
  const two = await open(f); two.load.resolve(new Response('{bad')); const response = await two.result;
  await assert.rejects(response.json(), SyntaxError); await f.guard.fetch('/api/chats/save', request(empty()));
  assert.equal(f.blocks.length, 0);
});

test('non-OK GET and confirmed empty response revoke coverage rather than invent nonempty evidence', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const one = await open(f);
  one.load.resolve(new Response('{}', { status: 503 })); assert.equal((await one.result).status, 503);
  await f.guard.fetch('/api/chats/save', request(empty()));
  const two = await open(f); await finish(f, two, empty()); const three = await open(f);
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0); await finish(f, three);
});

test('concurrent same-target GETs are independent: completing one does not release the other', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const one = await open(f), two = await open(f);
  await finish(f, one); f.context.chat = []; f.context.chatMetadata = {};
  await blocked(f.guard.fetch('/api/chats/save', request(empty()))); await finish(f, two);
});

test('fast switch never borrows another target baseline or current loading context', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const a = await open(f), b = await open(f, 'chat-B');
  await f.guard.fetch('/api/chats/save', request(empty())); // A is not current.
  await f.guard.fetch('/api/chats/save', request(empty(), { file_name: 'chat-B' })); // B has no baseline.
  assert.equal(f.blocks.length, 0); await finish(f, b); await finish(f, a);
});

test('account switch / reset discards old windows and delayed responses cannot restore them', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const old = await open(f); f.account = 'st-user:other';
  await f.guard.fetch('/api/chats/save', request(empty()));
  await finish(f, old); f.guard.reset(); const next = await open(f);
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0); await finish(f, next);
});

test('disabled or disposed guard forwards without identity calls or body inspection', async () => {
  let resolutions = 0;
  const f = fixture({ resolveAccount: async () => { resolutions++; return 'synthetic'; } });
  await f.guard.observeCurrent(); const flight = await open(f); const before = resolutions;
  f.enabled = false; const init = request(empty()); await f.guard.fetch('/api/chats/save', init);
  assert.equal(resolutions, before); assert.equal(f.calls.at(-1).init, init);
  f.enabled = true; f.guard.dispose(); await f.guard.fetch('/api/chats/save', init);
  assert.equal(resolutions, before); await finish(f, flight); assert.equal(f.blocks.length, 0);
});

test('unrelated, other-origin and group requests do not resolve account or inspect data', async () => {
  let resolutions = 0; const f = fixture({ resolveAccount: async () => { resolutions++; return 'synthetic'; } });
  for (const address of ['/api/settings/save', '/api/chats/group/save', 'https://other.invalid/api/chats/save']) {
    const init = request(empty()); await f.guard.fetch(address, init); assert.equal(f.calls.at(-1).init, init);
  }
  assert.equal(resolutions, 0);
});

for (const [label, transform, options] of [
  ['invalid JSON', init => { init.body = '{bad'; }],
  ['unknown encoding', init => { init.headers['content-encoding'] = 'br'; }],
  ['malformed gzip', init => { init.headers['content-encoding'] = 'gzip'; init.body = new Uint8Array([1, 2]); }],
  ['no decoder', init => { init.headers['content-encoding'] = 'gzip'; init.body = gzipSync(init.body); }, { platform: { ...Object.fromEntries(['Headers', 'Request', 'Blob', 'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout'].map(k => [k, globalThis[k]])) } }],
  ['oversized', init => { init.body += ' '.repeat(1024); }, { maxBodyBytes: 1024 }],
  ['direct stream', init => { init.body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }); init.duplex = 'half'; }],
]) {
  test(`${label}: unknown format passes unchanged with body-free fixed diagnostic`, async () => {
    const f = fixture(options); await f.guard.observeCurrent(); const flight = await open(f), init = request(empty()); transform(init);
    await f.guard.fetch('/api/chats/save', init); assert.equal(f.calls.at(-1).init, init); assert.equal(f.blocks.length, 0);
    assert.deepEqual(f.diagnostics, [{ code: 'body-uninspectable', scope: 'chat-write-guard' }]);
    if (init.body instanceof ReadableStream) assert.equal(init.body.locked, false);
    await finish(f, flight);
  });
}

test('account failure passes through, never assumes default account', async () => {
  const f = fixture({ resolveAccount: async () => { throw new Error('synthetic secret'); } });
  assert.equal(await f.guard.observeCurrent(), false); const init = request(empty());
  await f.guard.fetch('/api/chats/save', init); assert.equal(f.calls[0].init, init);
  assert.deepEqual(f.diagnostics, [{ code: 'account-unavailable', scope: 'chat-write-guard' }]);
});

test('original save rejection is not swallowed or converted to a synthetic success', async () => {
  const error = new Error('native failure'); let calls = 0;
  const f = fixture({ fetchImpl: () => { calls++; return Promise.reject(error); } });
  await assert.rejects(f.guard.fetch('/api/chats/save', request(rows(2))), value => value === error); assert.equal(calls, 1);
});

test('ordinary saves with no GET window skip all account and decoder work', async () => {
  let resolutions = 0;
  const f = fixture({ resolveAccount: async () => { resolutions++; return 'synthetic'; } });
  const init = request(rows(2)); init.body = 'not JSON'; init.headers['content-encoding'] = 'unknown';
  await f.guard.fetch('/api/chats/save', init);
  assert.equal(resolutions, 0); assert.equal(f.diagnostics.length, 0); assert.equal(f.calls[0].init, init);
});

for (const kind of ['mismatched chatId', 'duplicate avatar', 'group']) {
  test(`${kind}: no ambiguous nonempty baseline or native loading window`, async () => {
    const f = fixture();
    if (kind === 'mismatched chatId') Object.defineProperty(f.context, 'chatId', { value: 'different' });
    if (kind === 'duplicate avatar') f.context.characters.push({ avatar: 'Synthetic.png', chat: 'duplicate' });
    if (kind === 'group') f.context.groupId = 'group';
    assert.equal(await f.guard.observeCurrent(), false); const flight = await open(f);
    await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0); await finish(f, flight);
  });
}

for (const method of ['text', 'arrayBuffer', 'blob', 'clone', 'direct body reader']) {
  test(`${method}: non-native body consumption is preserved but releases the loading window`, async () => {
    const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f);
    const encoded = JSON.stringify(rows(2)); flight.load.resolve(new Response(encoded));
    const response = await flight.result;
    if (method === 'direct body reader') {
      const reader = response.body.getReader(); await reader.read(); await reader.cancel();
    } else if (method === 'clone') {
      const clone = response.clone(); assert.deepEqual(await clone.json(), rows(2)); assert.deepEqual(await response.json(), rows(2));
    } else await response[method]();
    await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0);
  });
}

test('unconsumed response cannot retain a phantom loading window', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f);
  flight.load.resolve(new Response(JSON.stringify(rows(2)))); const response = await flight.result;
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0);
  assert.deepEqual(await response.json(), rows(2));
});

test('an aborted save remains the transport abort, not a guard block', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f), controller = new AbortController();
  controller.abort(); const init = { ...request(empty()), signal: controller.signal };
  await f.guard.fetch('/api/chats/save', init); assert.equal(f.calls.at(-1).init, init); assert.equal(f.blocks.length, 0);
  await finish(f, flight);
});

test('reset during asynchronous account resolution cannot restore old evidence', async () => {
  const pending = deferred(), f = fixture({ resolveAccount: () => pending.promise });
  const observing = f.guard.observeCurrent(); f.guard.reset(); pending.resolve('st-user:synthetic');
  assert.equal(await observing, false);
  const flight = await open(f); await f.guard.fetch('/api/chats/save', request(empty()));
  assert.equal(f.blocks.length, 0); await finish(f, flight);
});

test('account validation failure revokes previous evidence before a later successful lookup', async () => {
  let available = true;
  const f = fixture({ resolveAccount: async () => { if (!available) throw new Error('failed'); return 'st-user:synthetic'; } });
  await f.guard.observeCurrent(); const old = await open(f); available = false;
  await f.guard.fetch('/api/chats/save', request(empty())); available = true;
  await finish(f, old); const next = await open(f);
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0); await finish(f, next);
});

test('disable during Request decoding forwards the unchanged original once', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f);
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const input = new Request(url + '/api/chats/save', { method: 'POST', body, duplex: 'half' });
  const saving = f.guard.fetch(input);
  await Promise.resolve(); await Promise.resolve(); f.enabled = false;
  controller.enqueue(new TextEncoder().encode(request(empty()).body)); controller.close();
  await saving; assert.equal(f.calls.at(-1).input, input); assert.equal(input.bodyUsed, false); assert.equal(f.blocks.length, 0);
  await finish(f, flight);
});

test('a successful legitimate clear invalidates the previous nonempty baseline', async () => {
  const f = fixture(); await f.guard.observeCurrent(); const flight = await open(f);
  await f.guard.fetch('/api/chats/save', request(empty({ integrity: 'synthetic' })));
  await f.guard.fetch('/api/chats/save', request(empty())); assert.equal(f.blocks.length, 0); await finish(f, flight, empty());
});

test('observer errors never turn a blocked save into a pass or a success', async () => {
  const f = fixture({ onBlock: () => { throw new Error('observer'); } });
  await f.guard.observeCurrent(); const flight = await open(f);
  await blocked(f.guard.fetch('/api/chats/save', request(empty()))); assert.equal(f.calls.length, 1); await finish(f, flight);
});

test('an earlier owner resolving first does not invalidate a newer pending lookup', async () => {
  const older = deferred(), newer = deferred(); let attempts = 0;
  const f = fixture({ resolveAccount: () => ++attempts === 1 ? older.promise : attempts === 2 ? newer.promise : Promise.resolve('st-user:new') });
  const first = f.guard.observeCurrent(), second = f.guard.observeCurrent();
  older.resolve('st-user:old'); assert.equal(await first, true);
  newer.resolve('st-user:new'); assert.equal(await second, true);
  const flight = await open(f); await blocked(f.guard.fetch('/api/chats/save', request(empty()))); await finish(f, flight);
});

test('an older failed owner lookup cannot revoke newer confirmed evidence', async () => {
  const older = deferred(); let attempts = 0;
  const f = fixture({ resolveAccount: () => ++attempts === 1 ? older.promise : Promise.resolve('st-user:new') });
  const first = f.guard.observeCurrent(); assert.equal(await f.guard.observeCurrent(), true);
  older.reject(new Error('stale failure')); assert.equal(await first, false);
  const flight = await open(f); await blocked(f.guard.fetch('/api/chats/save', request(empty()))); await finish(f, flight);
  assert.equal(f.diagnostics.length, 0);
});
