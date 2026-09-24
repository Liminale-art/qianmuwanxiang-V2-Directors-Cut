import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { init, exit } from '../server-plugin.js';
import { installStoryboardServerBatchV2Routes } from '../qianmu-storyboard-server-batch-v2-routes.js';
import { storyboardBatchV2Location } from '../qianmu-storyboard-server-batch-layout.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { uid } from '../qianmu-storyboard-utils.js';

const BASE = '/image/storyboard/batches/v2';
const hash = digit => digit.repeat(64);
const actor = handle => ({ user: { profile: { handle, enabled: true } } });
const manifest = (batchId = randomUUID()) => ({
  version: 1, batchId, requestedMode: 'automatic',
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: hash('a'), floor: 12, sourceDigest: hash('b'), originPlanId: uid('story') },
  planDigest: hash('c'), routeDigest: hash('d'),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: hash('e') }],
});

async function fixture(t, { production = false, enableWrites = false, dataRootOverride,
  serviceOptions = {} } = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-v2-http-test-'));
  const routes = new Map(), services = [];
  const router = {
    get: (name, handler) => routes.set(`GET ${name}`, handler),
    post: (name, handler) => routes.set(`POST ${name}`, handler),
  };
  const dataRoot = () => dataRootOverride ? dataRootOverride() : root;
  if (production) await init(router, { dataRoot: root });
  else installStoryboardServerBatchV2Routes(router, { dataRoot,
    register: service => services.push(service), enableWrites,
    serviceOptions: { now: () => 1000, ...serviceOptions } });
  const server = http.createServer(async (req, res) => {
    // Only the fixture impersonates host authentication. Production receives
    // req.user from ST and must not accept body or header account claims.
    if (typeof req.headers['x-test-account'] === 'string') req.user = actor(req.headers['x-test-account']).user;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    try { req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
    catch (_) { res.statusCode = 400; res.end(); return; }
    res.set = (name, value) => { res.setHeader(name, value); return res; };
    res.status = status => { res.statusCode = status; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res; };
    const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) { res.statusCode = 404; res.end(); return; }
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (production) await exit();
    else await Promise.all(services.map(service => service.close()));
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-v2-http-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (action, body = {}, account = 'alice', headers = {}) => fetch(`${origin}${BASE}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(account === null ? {} : { 'x-test-account': account }), ...headers },
    body: JSON.stringify(body),
  });
  return { root, routes, call, origin };
}

test('production registers only authenticated query/list; no write route or directory appears', async t => {
  const f = await fixture(t, { production: true });
  assert.equal(f.routes.has(`POST ${BASE}/prepare`), false);
  assert.equal(f.routes.has(`POST ${BASE}/stop`), false);
  assert.equal(f.routes.has(`POST ${BASE}/query`), true);
  assert.equal(f.routes.has(`POST ${BASE}/list`), true);
  assert.equal((await f.call('prepare', manifest())).status, 404);
  assert.equal((await f.call('stop', { batchId: randomUUID(), expectedRevision: 1 })).status, 404);
  const denied = await f.call('query', { batchId: randomUUID() }, null);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).submissionState, 'not_submitted');
  const listed = await f.call('list');
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.equal(listed.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual((await listed.json()).page,
    { entries: [], total: 0, nextCursor: null });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('read routes reject foreign origins, non-JSON, extra fields, oversized parsed bodies and forged account claims', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  assert.equal((await f.call('query', { batchId: id }, 'alice', { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await f.call('query', { batchId: id }, 'alice', { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await f.call('query', { batchId: id }, 'alice', { origin: f.origin,
    'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await f.call('query', { batchId: id }, 'alice', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.call('query', { batchId: id, user: actor('alice').user }, null)).status, 401);
  for (const action of ['query', 'list']) {
    const body = action === 'query' ? { batchId: id, apiKey: 'private-key' } : { cursor: null, prompt: 'private-story' };
    const response = await f.call(action, body);
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /private-key|private-story/);
  }
  const huge = await f.call('list', { padding: 'x'.repeat(73 * 1024) });
  assert.equal(huge.status, 413);
  const noLength = f.routes.get(`POST ${BASE}/list`);
  let status = 200, payload;
  await noLength({ ...actor('alice'), headers: { 'content-type': 'application/json', host: 'localhost' },
    body: { padding: 'x'.repeat(73 * 1024) } }, {
    set() { return this; }, status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  });
  assert.equal(status, 413, 'parsed JSON is still bounded when Content-Length is missing');
  assert.equal(payload.submissionState, 'not_submitted');
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('test-only write opt-in proves identity isolation, idempotency, stop CAS and v1 fail-closed behavior', async t => {
  const f = await fixture(t, { enableWrites: true });
  const input = manifest();
  const forged = await f.call('prepare', { ...input, prompt: 'PRIVATE STORY', apiKey: 'PRIVATE KEY' });
  assert.equal(forged.status, 400);
  const created = await f.call('prepare', input);
  assert.equal(created.status, 200);
  const original = (await created.json()).batch;
  assert.equal(original.state, 'prepared_unrunnable');
  assert.equal(original.shotCount, 1);
  assert.deepEqual((await (await f.call('prepare', input)).json()).batch, original);
  assert.deepEqual((await (await f.call('query', { batchId: input.batchId })).json()).batch, original);
  assert.deepEqual((await (await f.call('query', { batchId: input.batchId }, 'bob')).json()).batch, null);
  assert.deepEqual((await (await f.call('list', {}, 'bob')).json()).page.entries, []);
  assert.equal((await f.call('stop', { batchId: input.batchId, expectedRevision: 1 }, 'bob')).status, 404);
  assert.equal((await f.call('stop', { batchId: input.batchId, expectedRevision: 2 })).status, 409);
  const stopped = (await (await f.call('stop', { batchId: input.batchId, expectedRevision: 1 })).json()).batch;
  assert.equal(stopped.state, 'stopped_unrunnable');
  assert.equal(stopped.stateRevision, 2);
  assert.deepEqual((await (await f.call('stop', { batchId: input.batchId, expectedRevision: 1 })).json()).batch, stopped);
  const account = imageServiceAccount(actor('alice')).namespace;
  const folder = path.join(f.root, ...storyboardBatchV2Location(account, input.batchId).segments);
  const names = await fs.readdir(folder);
  assert.equal(names.length, 1);
  const stored = await fs.readFile(path.join(folder, names[0]), 'utf8');
  assert.doesNotMatch(stored, /PRIVATE STORY|PRIVATE KEY|prompt|apiKey|referenceImage/);
  const legacy = path.join(f.root, '.qianmu-service', 'storyboard-batches-v1');
  await fs.mkdir(legacy);
  const refused = await f.call('query', { batchId: input.batchId });
  assert.equal(refused.status, 409);
  assert.equal((await f.call('prepare', manifest())).status, 409);
  assert.deepEqual(await fs.readdir(legacy), []);
});

test('unknown and forged errors do not leak paths, private strings or arbitrary status', async t => {
  const privateError = Object.assign(new Error('C:\\private\\api-key is secret'),
    { code: 'storyboard_batch_http_forged', status: 201 });
  const f = await fixture(t, { dataRootOverride: () => { throw privateError; } });
  const response = await f.call('query', { batchId: randomUUID() });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.doesNotMatch(body, /private|api-key|forged|201/);
  assert.match(body, /storyboard_batch_unavailable/);
});

test('error-code getters and inherited object names cannot affect the safe HTTP fallback', async t => {
  const secret = 'C:\\private\\do-not-send';
  for (const cause of [
    Object.assign(new Error(secret), { code: 'toString', status: 200 }),
    new Proxy(new Error(secret), { get(target, name) {
      if (name === 'code') throw new Error(secret);
      return Reflect.get(target, name);
    } }),
  ]) {
    const f = await fixture(t, { dataRootOverride: () => { throw cause; } });
    const reply = await f.call('list');
    assert.equal(reply.status, 503);
    const text = await reply.text();
    assert.doesNotMatch(text, /private|do-not-send|toString/);
    assert.match(text, /storyboard_batch_unavailable/);
  }
});

test('account switch during a read refuses delivery of the previously opened account record', async t => {
  let activeRequest;
  const f = await fixture(t, { enableWrites: true, serviceOptions: { fileSystem: {
    ...fs, async readdir(target, ...options) {
      const value = await fs.readdir(target, ...options);
      if (activeRequest && String(target).includes('storyboard-batches-v2')) {
        activeRequest.user.profile.handle = 'bob'; activeRequest = null;
      }
      return value;
    },
  } } });
  const input = manifest();
  assert.equal((await f.call('prepare', input)).status, 200);
  const request = { ...actor('alice'), headers: { 'content-type': 'application/json', host: 'localhost' },
    body: { batchId: input.batchId } };
  activeRequest = request;
  let status = 200, payload;
  await f.routes.get(`POST ${BASE}/query`)(request, {
    set() { return this; }, status(value) { status = value; return this; },
    json(value) { payload = value; return this; },
  });
  assert.equal(status, 401);
  assert.equal(payload.batch, undefined);
  assert.equal(payload.submissionState, 'not_submitted');
});

test('read route rate limiting is in-process only and does not create a disk record', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 120; i++) {
    const response = await f.call('query', { batchId: randomUUID() });
    assert.equal(response.status, 200, `read ${i + 1}`);
  }
  const limited = await f.call('query', { batchId: randomUUID() });
  assert.equal(limited.status, 429);
  assert.deepEqual(await fs.readdir(f.root), []);
});
