import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComfyCloudProtocol as bind, planComfyCloudOperation as plan } from '../qianmu-comfy-cloud-protocol.js';
import { readComfyCloudAcceptance as accept, readComfyCloudTaskStatus as status, readComfyCloudJsonResponse as read, readComfyCloudImageResponse as readImage, readRunningHubImageResponse as readRHImage } from '../qianmu-comfy-cloud-response.js';
const cloud = bind('https://dep-one.run.comfy.app', 'comfy-cloud-v2'), rh = bind('https://www.runninghub.cn', 'runninghub-workflow-v1');
const id = 'original-id', rhId = '1904152026220003329';
const urls = { self: `/deployment/dep-one/api/v2/jobs/${id}`, cancel: `/deployment/dep-one/api/v2/jobs/${id}/cancel` };
const cloudBody = { id, status: 'queued', urls }, rhBody = { code: 0, data: { taskId: rhId } };
const cloudTask = accept(cloud, cloudBody), rhTask = accept(rh, rhBody);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
const imageContract = { task: cloudTask, mime: 'image/png', sizeBytes: png.length };

test('RH accepts missing CDN byte metadata but enforces the actual job budget, type and any advertised complete length', async () => {
  const contract = { task: rhTask, mime: 'image/png', maxBytes: png.length };
  const response = (bytes = png, headers = {}) => new Response(bytes, { headers: { 'content-type': 'image/png', ...headers } });
  for (const headers of [{}, { 'content-length': String(png.length) }]) {
    const result = await readRHImage(response(png, headers), contract); assert.deepEqual(Buffer.from(result.bytes), png);
  }
  for (const [bytes, headers, extra] of [
    [png, {}, { maxBytes: png.length - 1 }], [png, { 'content-length': String(png.length - 1) }, {}],
    [png, { 'content-length': String(png.length + 1) }, { maxBytes: png.length + 2 }],
    [png, { 'content-encoding': 'gzip' }, {}], [png, { 'content-type': 'text/html' }, {}],
    [png.subarray(0, 35), {}, {}], [Buffer.alloc(0), {}, {}], [png, {}, { task: cloudTask }],
  ]) await assert.rejects(readRHImage(response(bytes, headers), { ...contract, ...extra }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readRHImage(response(), { ...contract, signal: controller.signal }), { code: 'comfy_cloud_response_cancelled' });
  const stalled = new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(readRHImage(stalled, { ...contract, timeoutMs: 10 }), { code: 'comfy_cloud_response_timeout' });
});

test('cloud still reading requires the original byte count and container, including a binary CDN response', async () => {
  for (const mime of ['image/png', 'application/octet-stream']) {
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(png.subarray(0, 30)); stream.enqueue(png.subarray(30)); stream.close(); } }),
      { headers: { 'content-type': mime, 'content-length': png.length } });
    const result = await readImage(response, imageContract);
    assert.equal(result.mime, 'image/png'); assert.deepEqual(result.bytes, new Uint8Array(png)); assert.equal(response.body.locked, false);
  }
});

test('invalid still contracts and partial, encoded or differently typed responses never become archived images', async () => {
  for (const extra of [{ task: null }, { mime: 'image/gif' }, { sizeBytes: 0 }, { sizeBytes: 48 * 1024 * 1024 + 1 }]) {
    await assert.rejects(readImage(new Response(png, { headers: { 'content-type': 'image/png' } }), { ...imageContract, ...extra }), { code: 'comfy_cloud_response_limits' });
  }
  for (const init of [{ status: 206, headers: { 'content-type': 'image/png' } }, { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-type': 'image/jpeg' } }]) {
    await assert.rejects(readImage(new Response(png, init), imageContract), { code: 'comfy_cloud_response_type', submissionState: 'accepted', upstreamId: id, retryable: false });
  }
  await assert.rejects(readImage(new Response(png, { headers: { 'content-type': 'image/jpeg' } }), { ...imageContract, mime: 'image/jpeg' }), { code: 'comfy_cloud_response_image_type' });
});

test('a smaller declaration, short body or extra bytes cannot override the original image size', async () => {
  for (const [body, headers, code] of [[png, { 'content-length': png.length - 1 }, 'image_size'], [png.subarray(0, -1), {}, 'image_size'], [Buffer.concat([png, Buffer.from([0])]), {}, 'size']]) {
    await assert.rejects(readImage(new Response(body, { headers: { 'content-type': 'image/png', ...headers } }), imageContract), { code: `comfy_cloud_response_${code}`, upstreamId: id });
  }
});

test('HTML, truncated containers and animation never pass merely because metadata says PNG', async () => {
  const animation = Buffer.concat([png.subarray(0, 33), Buffer.from([0,0,0,0]), Buffer.from('acTL'), Buffer.alloc(4), png.subarray(33)]);
  for (const body of [Buffer.from('<html>test-only-secret</html>'), png.subarray(0, 33), animation]) {
    await assert.rejects(readImage(new Response(body, { headers: { 'content-type': 'image/png' } }), { ...imageContract, sizeBytes: body.length }), error =>
      error.code === 'comfy_cloud_response_image_invalid' && error.upstreamId === id && !error.message.includes('test-only-secret'));
  }
});

test('still body deadlines and cancellation reuse the bounded reader without an unbounded arrayBuffer fallback', async () => {
  for (const abort of [false, true]) {
    let cancelled = 0; const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { 'content-type': 'image/png' } });
    const pending = readImage(response, { ...imageContract, timeoutMs: abort ? 1000 : 5, signal: controller.signal });
    if (abort) controller.abort('test-only-secret');
    await assert.rejects(pending, { code: `comfy_cloud_response_${abort ? 'cancelled' : 'timeout'}`, submissionState: 'accepted', upstreamId: id });
    assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  }
  await assert.rejects(readImage({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: () => assert.fail('unbounded fallback') }, imageContract), { code: 'comfy_cloud_response_stream' });
});

test('Cloud follows validated response links including the serverless mount once, not a guessed base path', () => {
  assert.equal(plan(cloud, 'query', cloudTask).url, `${cloud.origin}${urls.self}`);
  assert.equal(plan(cloud, 'cancel', cloudTask).url, `${cloud.origin}${urls.cancel}`);
  assert.deepEqual(status(cloudTask, cloudBody), { task: cloudTask, status: 'queued', terminal: false });
  assert.equal(Object.isFrozen(cloudTask.links), true);
});
test('success-shaped replies without exact IDs leave acceptance unknown and never authorize replay', () => {
  for (const body of [undefined, null, [], '```json {} ```', { prompt_id: id }, { id: 1 }, {}]) {
    assert.throws(() => accept(cloud, body), error => error.submissionState === 'unknown' && error.retryable === false);
  }
  for (const body of [{ code: 0, data: { taskId: Number(rhId) } }, { code: '0', data: { taskId: rhId } }, { code: 500, data: null }]) {
    assert.throws(() => accept(rh, body), error => error.submissionState === 'unknown' && error.retryable === false);
  }
});
test('an accepted id survives malformed or hostile links without forwarding credentials or guessing a replacement', () => {
  for (const self of [`https://evil.test${urls.self}`, `//evil.test${urls.self}`, `${urls.self}?key=secret`,
    '/api/v2/jobs/other', '/admin/../api/v2/jobs/original-id', '/deployment/dep-one/../api/v2/jobs/original-id',
    '/%61pi/v2/jobs/original-id', '/api/v2/jobs/original-id#secret', 'https://key@dep-one.run.comfy.app/api/v2/jobs/original-id']) {
    assert.throws(() => accept(cloud, { ...cloudBody, urls: { ...urls, self } }), error => error.submissionState === 'accepted' && error.upstreamId === id);
  }
  assert.throws(() => accept(cloud, { id }), { submissionState: 'accepted', upstreamId: id });
  assert.throws(() => accept(cloud, { ...cloudBody, urls: { ...urls, cancel: '/api/v2/jobs/original-id/cancel' } }), { submissionState: 'accepted' });
});
test('status reads reject another task, an unknown enum and contradictory RH errors without resetting accepted state', () => {
  for (const body of [null, { ...cloudBody, id: 'other' }, { ...cloudBody, status: 'complete' },
    { ...cloudBody, urls: { self: '/api/v2/jobs/original-id', cancel: '/api/v2/jobs/original-id/cancel' } }]) {
    assert.throws(() => status(cloudTask, body), { submissionState: 'accepted', upstreamId: id, retryable: false });
  }
  for (const body of [{ taskId: 'other', status: 'SUCCESS', errorCode: '' }, { taskId: rhId, status: 'SUCCESS', errorCode: 'error' },
    { taskId: rhId, status: 'SUCCESS' }, { taskId: rhId, status: '__proto__', errorCode: '' }]) {
    assert.throws(() => status(rhTask, body), { submissionState: 'accepted', upstreamId: rhId });
  }
});
test('canceling is nonterminal and platform success is not an output adoption or a billing receipt', () => {
  for (const state of ['queued', 'running', 'succeeded', 'canceling', 'canceled', 'failed', 'expired']) {
    const result = status(cloudTask, { ...cloudBody, status: state, apiKey: 'test-secret', outputs: [{ unsafe: true }] });
    assert.equal(result.status, state); assert.equal(result.terminal, ['succeeded', 'canceled', 'failed', 'expired'].includes(state));
    assert.deepEqual(Object.keys(result), ['task', 'status', 'terminal']); assert.equal(Object.isFrozen(result), true);
  }
  for (const [state, normalized] of Object.entries({ QUEUED: 'queued', RUNNING: 'running', SUCCESS: 'succeeded', FAILED: 'failed' })) {
    assert.equal(status(rhTask, { taskId: rhId, status: state, errorCode: state === 'FAILED' ? 'runtime' : '' }).status, normalized);
  }
});

test('validated status owns a frozen task snapshot rather than retaining the callers mutable locator', () => {
  const mutable = structuredClone(cloudTask), original = structuredClone(mutable), response = structuredClone(cloudBody);
  const result = status(mutable, response);
  mutable.taskId = 'changed'; mutable.links.self = 'https://evil.test'; response.urls.self = 'changed';
  assert.deepEqual(result.task, original); assert.equal(Object.isFrozen(result.task), true);
  assert.equal(Object.isFrozen(result.task.links), true);
});

test('bounded JSON reading supports split UTF8 bytes and keeps exact task IDs without copying defaults', async () => {
  const body = { taskId: rhId, status: 'RUNNING', errorCode: '', note: '千幕' }, encoded = new TextEncoder().encode(JSON.stringify(body));
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.deepEqual(await read(response, { task: rhTask, maxBytes: encoded.length }), body);
  assert.equal(response.body.locked, false);
});
test('retained byte chunks own their memory even when a Node Buffer producer reuses its buffer', async () => {
  const buffer = Buffer.from('{"id":"kept"}'); let reads = 0;
  const response = { ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => ({
    read: async () => { if (!reads++) return { done: false, value: buffer }; buffer.fill(0); return { done: true }; },
    cancel: async () => {}, releaseLock: () => {},
  }) } };
  assert.deepEqual(await read(response), { id: 'kept' });
});
test('declared and streamed oversize metadata is rejected, not silently truncated or replaced by arrayBuffer', async () => {
  for (const declared of ['100', '-1', 'abc', '9007199254740993', null]) {
    let cancelled = 0;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"large":"01234567890123456789"}')); }, cancel() { cancelled++; } }),
      { headers: { 'content-type': 'application/json', ...(declared === null ? {} : { 'content-length': declared }) } });
    await assert.rejects(read(response, { task: rhTask, maxBytes: 10 }), { code: 'comfy_cloud_response_size', submissionState: 'accepted', upstreamId: rhId });
    assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  }
  await assert.rejects(read({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), arrayBuffer: () => assert.fail('unbounded fallback') }), { code: 'comfy_cloud_response_stream' });
});
test('invalid syntax, duplicate fields, unsafe keys, deep JSON and invalid UTF8 never become a repaired response', async () => {
  for (const text of ['{"id":"first","id":"second"}', '{"constructor":{}}', '```json {} ```', 'null', '[]', '{', '{"x":1e999}', '['.repeat(34) + '0' + ']'.repeat(34), new Uint8Array([255])]) {
    await assert.rejects(read(new Response(text, { headers: { 'content-type': 'application/json' } })), error =>
      /^comfy_cloud_response_(json|shape)$/.test(error.code) && error.submissionState === 'unknown' && error.retryable === false);
  }
});
test('body timeout cancels a stalled stream without waiting for its stuck cancel callback', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(read(response, { task: rhTask, timeoutMs: 5 }), { code: 'comfy_cloud_response_timeout', submissionState: 'accepted', upstreamId: rhId });
  assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
});
test('external cancellation and stream failure preserve the original task and do not expose raw upstream errors', async () => {
  const controller = new AbortController(); let cancelled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } });
  const pending = read(response, { task: rhTask, signal: controller.signal }); controller.abort('test-only-secret');
  await assert.rejects(pending, { code: 'comfy_cloud_response_cancelled', submissionState: 'accepted', upstreamId: rhId });
  assert.equal(cancelled, 1);
  const broken = new Response(new ReadableStream({ start(stream) { stream.error(Object.assign(Error('test-only-secret'), { code: 'comfy_cloud_response_size' })); } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(read(broken), error => error.code === 'comfy_cloud_response_stream' && !error.message.includes('test-only-secret'));
});

test('endless empty chunks cannot bypass the byte limit and starve the timeout indefinitely', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ pull(stream) { stream.enqueue(new Uint8Array()); }, cancel() { cancelled++; } }),
    { headers: { 'content-type': 'application/json' } });
  await assert.rejects(read(response), { code: 'comfy_cloud_response_size', submissionState: 'unknown' });
  assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
});
test('HTTP errors and wrong MIME do not reset an accepted task or return an upstream HTML page as content', async () => {
  for (const code of [400, 401, 402, 404, 429, 500, 503]) {
    await assert.rejects(read(new Response('test-only-secret', { status: code }), { task: rhTask }), {
      code: 'comfy_cloud_response_http', httpStatus: code, submissionState: 'accepted', upstreamId: rhId, retryable: false,
    });
  }
  await assert.rejects(read(new Response('<html>test-only-secret</html>')), { code: 'comfy_cloud_response_type', submissionState: 'unknown' });
});
