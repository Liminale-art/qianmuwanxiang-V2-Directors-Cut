import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { recipeRestoreRequest, inspectRecipeRestoreRequest, recipeRestoreResponse } from '../qianmu-recipe-restore-contract.js';
import { recipeArchiveRequest, recipeArchiveEnvelope, RECIPE_ARCHIVE_LIMITS } from '../qianmu-recipe-archive-contract.js';
import { createRecipeRestoreClient } from '../qianmu-recipe-restore-client.js';
import { init, exit } from '../server-plugin.js';
import { recipeRestoreFixture, restoreRequest, clientInput, sha, account, deferred } from './helpers/recipe-restore-fixture.mjs';
import { historicalSourceFixture } from './helpers/historical-source-fixture.mjs';

test('restore contract preserves full original content and exact archive source, never ordinary selectors', async () => {
  const input = restoreRequest(), before = structuredClone(input), result = await inspectRecipeRestoreRequest(input);
  assert.deepEqual(result.request, input); assert.deepEqual(input, before);
  assert.equal(result.envelope.snapshot.payload.parameters.workflow.nodes.length, 120);
  assert.equal(result.envelope.snapshot.profile.seed, 0); assert.equal(result.envelope.snapshot.prompt, ' full original\n');
  assert.throws(() => recipeArchiveRequest(input));
  for (const patch of [{ confirmed: false }, { confirmed: 1 }, { version: 2 }, { path: '/private' }, { expectedAccount: 'st-user:alice' }, { source: { ...input.source, owner: 'bob' } }])
    assert.throws(() => recipeRestoreRequest({ ...input, ...patch }));
});

test('request must match original hash/byte count and cannot rebind record, time, owner or target', async () => {
  const input = restoreRequest();
  for (const patch of [{ snapshot: { ...input.snapshot, prompt: 'different' } }, { originalReference: { ...input.originalReference, bytes: input.originalReference.bytes + 1 } },
    { source: { ...input.source, createdAt: 2 } }, { source: { ...input.source, recordId: 'other' } }, { expectedAccount: account('bob') },
    { source: { ...input.source, target: { kind: 'group', chatId: 'chat' } } }])
    await assert.rejects(inspectRecipeRestoreRequest({ ...input, ...patch }), { code: 'recipe_archive_restore_contract' });
});

test('structured and serialized workflow credentials, duplicate JSON keys, unsafe URLs, oversize are rejected intact', async () => {
  for (const workflow of ['{"apiKey":"PRIVATE"}', '{"nodes":[{"headers":{"Authorization":"PRIVATE"}}]}', '{"a":1,"a":2}', '{"endpoint":"https://user:pass@example.test"}']) {
    const input = restoreRequest(); input.snapshot.payload.parameters.workflow = workflow;
    const signed = restoreRequest({ snapshot: input.snapshot });
    await assert.rejects(inspectRecipeRestoreRequest(signed), { code: workflow.includes('user:pass') ? 'storyboard_connection_identity' : 'storyboard_package_credentials' });
    assert.equal(signed.snapshot.payload.parameters.workflow, workflow);
  }
  const input = restoreRequest(); input.snapshot.prompt = 'x'.repeat(RECIPE_ARCHIVE_LIMITS.recipeBytes);
  assert.throws(() => recipeRestoreRequest(input));
});

test('inspection detaches nested fields before async validation', async () => {
  const input = restoreRequest(), before = structuredClone(input), task = inspectRecipeRestoreRequest(input);
  input.source.recordId = 'changed'; input.snapshot.payload.parameters.workflow.nodes[0].text = 'changed'; input.originalReference.bytes++;
  assert.deepEqual((await task).request, before);
});

test('restore is immutable and lossless; same content reuses stable file while chat remains byte-identical', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest(), before = await fs.readFile(f.file);
  const result = await f.service.restore(f.req, input); assert.equal(result.proof, 'durable-restored-recipe');
  assert.notEqual(result.reference.id, input.originalReference.id); assert.equal(result.reference.sha256, input.originalReference.sha256);
  const file = path.join(f.archive, result.reference.id + '.json'), bytes = await fs.readFile(file), stat = await fs.stat(file);
  assert.equal(sha(bytes), result.reference.sha256); assert.equal(bytes.length, result.reference.bytes);
  assert.deepEqual((await f.store.get(f.req, input.expectedAccount, result.reference)).snapshot, input.snapshot);
  assert.deepEqual((await f.service.restore(f.req, input)).reference, result.reference);
  assert.equal((await fs.stat(file)).ino, stat.ino); assert.equal((await fs.readdir(f.archive)).length, 1);
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal(result.snapshot, undefined); assert.equal(result.metadataApplied, undefined);
});

test('the unchanged archive already present under its original ID is reused', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest();
  // The envelope endpoint does not accept import-only keys; construct it explicitly.
  assert.throws(() => recipeArchiveEnvelope(input));
  const existing = await f.store.put(f.req, { version: 1, expectedAccount: input.expectedAccount, source: input.source, snapshot: input.snapshot });
  const result = await f.service.restore(f.req, { ...input, originalReference: existing });
  assert.deepEqual(result.reference, existing); assert.deepEqual(result.originalReference, existing);
});

test('damaged old archive is retained and a fresh verified ID returned instead of overwrite', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest();
  await fs.mkdir(f.archive); const old = path.join(f.archive, input.originalReference.id + '.json');
  await fs.writeFile(old, 'corrupt-original');
  const result = await f.service.restore(f.req, input);
  assert.notEqual(result.reference.id, input.originalReference.id); assert.equal(await fs.readFile(old, 'utf8'), 'corrupt-original');
  assert.equal((await fs.readdir(f.archive)).length, 2);
});

test('existing ordinary historical source can supply a restorable snapshot without borrowing current settings', async t => {
  const f = await historicalSourceFixture(t), session = await f.capture(); t.after(() => session.close());
  const { source } = session, item = source.recipes.find(row => row.origin === 'server-archive');
  const input = { version: 1, expectedAccount: account('alice'), confirmed: true, source: { target: source.target, recordId: item.recordId, createdAt: item.createdAt }, snapshot: item.snapshot, originalReference: item.reference };
  const before = await fs.readFile(f.file), result = await f.recipes.restore(f.req, input);
  assert.deepEqual(result.reference, item.reference); assert.equal(item.snapshot.prompt, 'server original'); assert.deepEqual(await fs.readFile(f.file), before);
});

test('wrong account, malformed or cancelled imports do not create archive directories', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest(), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.service.restore({}, input));
  await assert.rejects(f.service.restore(f.req, restoreRequest({ owner: 'bob' })));
  await assert.rejects(f.service.restore(f.req, { ...input, confirmed: false }));
  await assert.rejects(f.service.restore(f.req, input, { signal: cancelled.signal }));
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' });
});

test('service rejects serialized secrets before disk writes', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest(); input.snapshot.payload.parameters.workflow = '{"apiKey":"PRIVATE"}';
  await assert.rejects(f.service.restore(f.req, restoreRequest({ snapshot: input.snapshot })), { code: 'storyboard_package_credentials' });
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' });
});

test('failed writes leave partial files and retry uses a fresh immutable file without cleanup', async t => {
  let broken = true;
  const io = { ...fs, open: async (file, ...args) => { const handle = await fs.open(file, ...args);
    if (args[0] === 'wx') { const write = handle.writeFile.bind(handle); handle.writeFile = async text => { if (broken) { await write(text.slice(0, 7)); throw Error('PRIVATE DISK ERROR'); } return write(text); }; } return handle; } };
  const f = await recipeRestoreFixture(t, { io }), input = restoreRequest();
  await assert.rejects(f.service.restore(f.req, input)); const [partial] = await fs.readdir(f.archive), bytes = await fs.readFile(path.join(f.archive, partial));
  broken = false; const result = await f.service.restore(f.req, input); assert.notEqual(result.reference.id + '.json', partial);
  assert.deepEqual(await fs.readFile(path.join(f.archive, partial)), bytes); assert.equal(bytes.length, 7);
});

test('account/root changes, cancellation and service closure during durable write never return successful receipts', async t => {
  for (const mode of ['account', 'root', 'abort', 'close']) {
    let change, closing;
    const io = { ...fs, open: async (file, ...args) => { const handle = await fs.open(file, ...args);
      if (args[0] === 'wx') { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); change(); }; } return handle; } };
    const f = await recipeRestoreFixture(t, { io }), signal = new AbortController(), before = await fs.readFile(f.file);
    change = () => { if (mode === 'account') f.req.user.profile.handle = 'bob'; else if (mode === 'root') f.req.user.directories.root = path.join(f.root, 'other'); else if (mode === 'abort') signal.abort(); else closing = f.service.close(); };
    await assert.rejects(f.service.restore(f.req, restoreRequest(), { signal: signal.signal })); await closing;
    assert.deepEqual(await fs.readFile(f.file), before); assert.equal((await fs.readdir(f.archive)).length, 1);
  }
});

test('concurrent writes share the existing bounded store rather than race old archive names', async t => {
  const entered = deferred(), release = deferred();
  const io = { ...fs, open: async (file, ...args) => { const handle = await fs.open(file, ...args);
    if (args[0] === 'wx') { const write = handle.writeFile.bind(handle); handle.writeFile = async text => { entered.resolve(); await release.promise; return write(text); }; } return handle; } };
  const f = await recipeRestoreFixture(t, { io }), input = restoreRequest(), pending = f.service.restore(f.req, input); await entered.promise;
  try { await assert.rejects(f.service.restore(f.req, input), { code: 'recipe_archive_busy' }); } finally { release.resolve(); }
  const result = await pending; assert.equal((await fs.readdir(f.archive)).length, 1); assert.equal(result.proof, 'durable-restored-recipe');
});

test('client sends only CSRF plus JSON headers and returns exact-source durable receipt, without metadata writes', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest(), before = await fs.readFile(f.file);
  const result = await f.client({ headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE', 'X-API-Key': 'PRIVATE' }) }).restore(clientInput(input), { confirmed: true });
  const [call] = f.calls; assert.deepEqual(call.body, input); assert.deepEqual(call.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': 'fixture' });
  assert.equal(call.credentials, 'same-origin'); assert.equal(call.redirect, 'error'); assert.equal(call.cache, 'no-store');
  assert.deepEqual(result.originalReference, input.originalReference); assert.deepEqual(await fs.readFile(f.file), before);
});

test('client requires explicit consent and rejects account overrides, extra paths and missing guard', async t => {
  const f = await recipeRestoreFixture(t), input = clientInput(restoreRequest()), client = f.client();
  assert.throws(() => createRecipeRestoreClient({ namespace: 'st-user:alice' }));
  await assert.rejects(client.restore(input), { recipeWriteState: 'not_started' });
  for (const patch of [{ expectedAccount: account('bob') }, { version: 1 }, { confirmed: true }, { path: 'anything' }])
    await assert.rejects(client.restore({ ...input, ...patch }, { confirmed: true }), { recipeWriteState: 'not_started' });
  assert.equal(f.calls.length, 0);
});

test('client captures original data before deferred guards and refuses overlapping operations', async t => {
  const f = await recipeRestoreFixture(t), input = clientInput(restoreRequest()), original = structuredClone(input), gate = deferred();
  const client = f.client({ guard: () => gate.promise }), pending = client.restore(input, { confirmed: true });
  input.snapshot.prompt = 'late edit'; input.source.recordId = 'other';
  await assert.rejects(client.restore(original, { confirmed: true })); gate.resolve(true);
  const result = await pending; assert.deepEqual(result.source, original.source); assert.equal(f.calls[0].body.snapshot.prompt, original.snapshot.prompt);
});

test('whole client deadline covers stalled guards/headers without fetch or late writes', async t => {
  for (const kind of ['guard', 'headers']) {
    const f = await recipeRestoreFixture(t), gate = deferred(), options = { timeoutMs: 25, [kind]: () => gate.promise };
    await assert.rejects(f.client(options).restore(clientInput(restoreRequest()), { confirmed: true }), { recipeWriteState: 'not_started' });
    gate.resolve(kind === 'guard' ? true : {}); await new Promise(done => setTimeout(done, 5)); assert.equal(f.calls.length, 0);
  }
});

test('close/abort settle unresolved guards and late continuations never upload', async t => {
  for (const mode of ['close', 'abort', 'already-aborted']) {
    const f = await recipeRestoreFixture(t), gate = deferred(), controller = new AbortController(), client = f.client({ guard: () => gate.promise });
    if (mode === 'already-aborted') controller.abort();
    const pending = client.restore(clientInput(restoreRequest()), { confirmed: true, signal: controller.signal });
    if (mode === 'close') client.close(); else controller.abort();
    await assert.rejects(pending, { recipeWriteState: 'not_started' }); gate.resolve(true); await new Promise(done => setTimeout(done, 5)); assert.equal(f.calls.length, 0);
  }
});

test('missing success acknowledgement is uncertain, closes session, and a new explicit retry reuses durable bytes', async t => {
  const f = await recipeRestoreFixture(t), input = clientInput(restoreRequest());
  const client = f.client({ fetchImpl: async (...args) => { await f.fetch(...args); throw Error('network gone after commit'); } });
  await assert.rejects(client.restore(input, { confirmed: true }), { recipeWriteState: 'unconfirmed' });
  const [file] = await fs.readdir(f.archive), before = await fs.readFile(path.join(f.archive, file));
  await assert.rejects(client.restore(input, { confirmed: true })); assert.equal(f.calls.length, 1);
  const result = await f.client().restore(input, { confirmed: true }); assert.equal(result.reference.id + '.json', file);
  assert.deepEqual(await fs.readFile(path.join(f.archive, file)), before); assert.equal((await fs.readdir(f.archive)).length, 1);
});

test('late success after cancellation is not adopted and does not trigger auto retry', async t => {
  const f = await recipeRestoreFixture(t), gate = deferred(), entered = deferred(), client = f.client({ fetchImpl: async (...args) => { const response = await f.fetch(...args); entered.resolve(); await gate.promise; return response; } });
  const pending = client.restore(clientInput(restoreRequest()), { confirmed: true }); await entered.promise; client.close();
  await assert.rejects(pending, { recipeWriteState: 'unconfirmed' }); gate.resolve(); await new Promise(done => setTimeout(done, 5)); assert.equal(f.calls.length, 1);
});

test('guard changed after confirmed disk publication refuses reference adoption', async t => {
  const f = await recipeRestoreFixture(t), client = f.client({ fetchImpl: async (...args) => { const response = await f.fetch(...args); f.active = false; return response; } });
  await assert.rejects(client.restore(clientInput(restoreRequest()), { confirmed: true }), { recipeWriteState: 'unconfirmed' });
  assert.equal((await fs.readdir(f.archive)).length, 1);
});

test('receipt validator/client reject changed account/source/original ID and impossible restored bytes', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest(), good = await f.service.restore(f.req, input);
  for (const patch of [{ expectedAccount: account('bob') }, { source: { ...good.source, recordId: 'different' } },
    { originalReference: { ...good.originalReference, id: good.originalReference.sha256 + '-12345678-1234-4123-8123-123456789abc' } },
    { reference: { ...good.reference, bytes: good.reference.bytes + 1 } }, { extra: true }, { proof: 'durable-recipe' }]) {
    await assert.rejects(f.client({ fetchImpl: async () => Response.json({ ...good, ...patch }) }).restore(clientInput(input), { confirmed: true }), { recipeWriteState: 'unconfirmed' });
  }
  assert.deepEqual(recipeRestoreResponse(good), good);
});

test('old backend, malformed, non-JSON, oversized and stalled bodies never return usable references', async t => {
  const f = await recipeRestoreFixture(t), input = clientInput(restoreRequest());
  for (const response of [new Response('old', { status: 404 }), new Response('old', { status: 405 }), new Response('not json'),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }), Response.json({ private: 'x'.repeat(9000) }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '10000' } }), Response.json({ ok: false }, { status: 500 })])
    await assert.rejects(f.client({ fetchImpl: async () => response }).restore(input, { confirmed: true }), { recipeWriteState: 'unconfirmed' });
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(f.client({ timeoutMs: 30, fetchImpl: async () => response }).restore(input, { confirmed: true }), { recipeWriteState: 'unconfirmed' });
  assert.equal(cancelled, true);
});

test('actual authenticated route imports only explicit bounded requests with private responses', async t => {
  const f = await recipeRestoreFixture(t), input = restoreRequest(), routes = new Map();
  await init({ get: (name, handler) => routes.set('GET ' + name, handler), post: (name, handler) => routes.set('POST ' + name, handler) }, { dataRoot: f.root });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.headers['x-fixture-user'] === 'alice') req.user = f.req.user;
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    await routes.get('POST ' + req.url)(req, res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => server.close(done)); await exit(); });
  const request = (body, auth = true) => fetch('http://127.0.0.1:' + server.address().port + '/chat-gallery/recipe/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Fixture-User': 'alice' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request(input, false)).status, 401);
  for (const patch of [{ confirmed: false }, { diskPath: 'PRIVATE' }, { expectedAccount: account('bob') }]) assert.notEqual((await request({ ...input, ...patch })).status, 200);
  const response = await request(input); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.json(); assert.equal(body.proof, 'durable-restored-recipe'); assert.doesNotMatch(JSON.stringify(body), /PRIVATE_BODY|payload|parameters|node 1/);
});
