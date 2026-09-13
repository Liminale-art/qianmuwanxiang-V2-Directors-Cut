import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createComfyServerTransport, createComfyCloudServerTransport, createComfyCloudAssetTransport, createComfyCloudFileTransport, pinnedComfyFetch } from '../qianmu-comfy-server-transport.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { queryComfyCloudTask } from '../qianmu-comfy-cloud-query.js';
import { checkComfyCloudConnection } from '../qianmu-comfy-cloud-check.js';
import { createComfyCloudLedger } from '../qianmu-comfy-cloud-ledger.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceResults } from '../qianmu-image-service-results.js';
import { COMFY_CLOUD_INTENT_SCHEMA, COMFY_CLOUD_RECEIPT_SCHEMA } from '../qianmu-comfy-cloud-receipt.js';
import { readComfyCloudJsonResponse, readComfyCloudAcceptance } from '../qianmu-comfy-cloud-response.js';
import { submitComfyCloudTask } from '../qianmu-comfy-cloud-submit.js';
import { prepareComfyCloudSubmission } from '../qianmu-comfy-cloud-prepare.js';
import { readComfyCloudAsset, downloadComfyCloudAsset, downloadComfyCloudJob } from '../qianmu-comfy-cloud-asset-read.js';
import { downloadRunningHubJob } from '../qianmu-runninghub-download.js';
import { createComfyCloudReceiver } from '../qianmu-comfy-cloud-receive.js';
import { createComfyCloudService } from '../qianmu-comfy-cloud-service.js';
import { createComfyRecoveryClient } from '../qianmu-comfy-recovery-client.js';
import { normalizeComfyDelivery, assertComfyDeliveryUpdate } from '../qianmu-comfy-delivery-store.js';
import { comfyCloudResourceKey } from '../qianmu-comfy-cloud-ledger.js';
import { init, exit } from '../server-plugin.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { comfyTargetId } from '../qianmu-comfy-target-store.js';
import { blake3 } from '../vendor/noble-hashes-2.4.0/blake3.js';

const account = (admin = false) => ({ user: { profile: { handle: 'alice', enabled: true, admin } } });
const workflow = (refs = false) => ({ '1': { class_type: 'FixtureOutput', inputs: { text: '%qianmu_prompt%', ...(refs ? { refs: '%qianmu_references%' } : {}) } }, save: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } });
const input = (extra = {}) => ({ provider: 'comfy', baseUrl: 'https://comfy.test/api', apiKey: 'test-only-secret', model: 'workflow', prompt: 'rain',
  comfyQueue: { version: 1, attemptId: 'fixture-attempt', expectedAccount: imageServiceAccount(account()).namespace, automatic: false },
  comfyExecution: { version: 1, automatic: false, outputNodeIds: ['save'], maxImages: 1, allowUnverified: true },
  parameters: { pollIntervalMs: 250, workflow: workflow() }, ...extra });
const roots = [];
after(async () => { await exit(); for (const root of roots) { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('qianmu-comfy-routes-')); await fs.rm(root, { recursive: true, force: true }); } });
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
function mockNodeRequest(calls, respond = () => ({ body: {} })) {
  return (url, options, callback) => {
    const chunks = [], call = { url: new URL(url), options }; calls.push(call);
    return new Writable({
      write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
      final(done) {
        call.body = Buffer.concat(chunks); const result = respond(call);
        const incoming = new PassThrough(); incoming.statusCode = result.status || 200;
        incoming.headers = result.headers || { 'content-type': 'application/json' };
        callback(incoming); incoming.end(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body || {})); done();
      },
    });
  };
}
const response = () => ({ statusCode: 200, headers: {}, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } });
const cloudBinding = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
const rhBinding = bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1');
const cloudGrant = async () => async () => {};

async function cloudSubmissionFixture(t, binding = cloudBinding) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-routes-')); roots.push(root);
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = account(), apiKey = 'test-only-secret';
  const input = { apiKey, expectedAccount: imageServiceAccount(req).namespace, attemptId: 'new-cloud-task', request: {
    connection: binding, workflow: workflow(), prompt: 'quiet rain', model: 'workflow', parameters: {},
    execution: { version: 1, automatic: false, maxImages: 1, outputNodeIds: ['save'], allowUnverified: true },
  } };
  return { root, req, input, store, key: comfyCloudResourceKey(binding, apiKey), options: {
    ledger: createComfyCloudLedger({ store }), authorizeTarget: cloudGrant, resolveHost: publicDns,
  } };
}
const acceptedCloudBody = (binding = cloudBinding, id = 'new-job') => binding.provider === 'runninghub' ? { code: 0, data: { taskId: id } }
  : { id, urls: { self: `/api/v2/jobs/${id}`, cancel: `/api/v2/jobs/${id}/cancel` } };

test('host owns the single cloud submission ledger and repeated submission cannot create another paid job', async t => {
  for (const binding of [cloudBinding,rhBinding]) {
    const f = await cloudSubmissionFixture(t,binding), calls = [], id = binding.provider === 'runninghub' ? '1904152026220003329' : 'host-original';
    const service = createComfyCloudService({ store: f.store, dataRoot: f.root,
      transportOptions: { ...f.options, requestImpl: mockNodeRequest(calls,() => ({ body: acceptedCloudBody(binding,id) })) } });
    t.after(() => service.close());
    const input = { ...f.input, version: 1 }, result = await service.submit(f.req,input);
    assert.equal(result.status,'accepted'); assert.equal(result.version,1); assert.equal(result.task.taskId,id);
    assert.equal(result.locator.channelKey,f.key);
    const persisted = (await f.store.inspectChannel(f.key)).entries[0];
    assert.equal(persisted.upstreamId,id); assert.equal(persisted.cloudReceipt.task.taskId,id);
    assert.doesNotMatch(JSON.stringify(persisted),/test-only-secret|quiet rain/);
    await assert.rejects(service.submit(f.req,input)); assert.equal(calls.length,1);
  }
});

test('invalid account and cancellation before host submission make no network or ledger mutation', async t => {
  const f = await cloudSubmissionFixture(t), calls = [];
  const service = createComfyCloudService({ store: f.store, dataRoot: f.root,
    transportOptions: { ...f.options, requestImpl: mockNodeRequest(calls) } }); t.after(() => service.close());
  const input = { ...f.input, version: 1 };
  await assert.rejects(service.submit({},input),{submissionState:'not_submitted'});
  await assert.rejects(service.submit(f.req,{...input,version:2}),{submissionState:'not_submitted'});
  const controller = new AbortController();controller.abort();
  await assert.rejects(service.submit(f.req,input,{signal:controller.signal}),{submissionState:'not_submitted'});
  assert.equal(calls.length,0);assert.deepEqual(await fs.readdir(f.root),[]);
});

test('host shutdown waits for dispatched acceptance and preserves its receipt instead of pretending it was not submitted', { timeout: 10000 }, async t => {
  const f = await cloudSubmissionFixture(t), calls = [];let entered,release;
  const arriving = new Promise(resolve => { entered = resolve; }), ready = new Promise(resolve => { release = resolve; });
  const mock = mockNodeRequest(calls,() => ({ body: acceptedCloudBody(cloudBinding,'late-host-original') }));
  const service = createComfyCloudService({ store: f.store, dataRoot: f.root, transportOptions: { ...f.options,
    requestImpl: (url,options,callback) => mock(url,options,incoming => { entered();void ready.then(() => callback(incoming)); }) } });
  t.after(() => service.close());
  const work = service.submit(f.req,{...f.input,version:1});
  const rejected = assert.rejects(work,{submissionState:'accepted'});
  await arriving;
  const catalog = await service.catalog(f.req,{version:1,expectedAccount:f.input.expectedAccount});
  assert.equal(catalog.tasks[0].live,true,'active resource fingerprint must match its persisted task');
  const closed = service.close(); release(); await rejected; await closed;
  const reopened = createImageServiceStore({ dataRoot: f.root, scope: 'comfy-cloud' });t.after(() => reopened.close());
  const row = (await reopened.inspectChannel(f.key)).entries[0];
  assert.equal(row.upstreamId,'late-host-original');assert.equal(row.cloudReceipt.task.taskId,'late-host-original');
  assert.equal(row.status,'uncertain');assert.equal(calls.length,1);
  await assert.rejects(service.submit(f.req,{...f.input,version:1}),{submissionState:'not_submitted'});
});

test('single cloud submit runner persists original acceptance with platform authentication only at dispatch', async t => {
  for (const binding of [cloudBinding, rhBinding]) {
    const f = await cloudSubmissionFixture(t, binding), calls = [], id = binding.provider === 'runninghub' ? '1904152026220003329' : 'new-job';
    const result = await submitComfyCloudTask(f.req, f.input, { ...f.options, requestImpl: mockNodeRequest(calls, () => ({ body: acceptedCloudBody(binding, id) })) });
    assert.equal(result.status, 'accepted'); assert.equal(result.task.taskId, id); assert.equal(calls.length, 1);
    const row = (await f.store.inspectChannel(f.key)).entries[0]; assert.equal(row.status, 'submitting'); assert.equal(row.upstreamId, id); assert.ok(row.cloudReceipt);
    assert.doesNotMatch(JSON.stringify(row), /test-only-secret|apiKey/);
    const body = JSON.parse(calls[0].body);
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-only-secret');
    if (binding.provider === 'runninghub') { assert.equal(body.apiKey, 'test-only-secret'); assert.equal(typeof body.workflow, 'string'); assert.equal(calls[0].options.headers['idempotency-key'], undefined); }
    else { assert.equal(body.apiKey, undefined); assert.equal(typeof body.workflow, 'object'); assert.equal(calls[0].options.headers['idempotency-key'], row.fence); }
    await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, requestImpl: mockNodeRequest(calls) }));
    assert.equal(calls.length, 1, 'repeated UI calls cannot create a second job');
  }
});

async function reopenCloudSubmission(t, f) {
  await f.store.close();
  const store = createImageServiceStore({ dataRoot: f.root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const ledger = createComfyCloudLedger({ store }), before = await store.inspectChannel(f.key), row = before.entries[0];
  const locator = { channelKey: f.key, attemptId: row.attemptId, apiKey: f.input.apiKey };
  return { store, ledger, before, row, options: { apiKey: f.input.apiKey, authorizeTarget: cloudGrant, resolveHost: publicDns,
    authorizeTask: (req, original) => ledger.authorizeQuery(req, locator, original) } };
}

test('actual cloud submission survives service restart and remote success still does not release an uncollected image', async t => {
  for (const binding of [cloudBinding, rhBinding]) {
    const f = await cloudSubmissionFixture(t, binding), calls = [], cloud = binding.provider === 'comfy-cloud', id = cloud ? 'new-job' : '1904152026220003329';
    const body = acceptedCloudBody(binding, id);
    if (cloud) body.urls = { self: `/deployment/kept/api/v2/jobs/${id}`, cancel: `/deployment/kept/api/v2/jobs/${id}/cancel` };
    const submitted = await submitComfyCloudTask(f.req, f.input, { ...f.options, requestImpl: mockNodeRequest(calls, () => ({ body })) });
    const reopened = await reopenCloudSubmission(t, f), task = reopened.row.cloudReceipt.task;
    assert.deepEqual(task, submitted.task, 'recovery must use the receipt actually produced by submission');
    const queried = await queryComfyCloudTask(account(), task, { ...reopened.options, requestImpl: mockNodeRequest(calls, () => ({ body: cloud
      ? { id, status: 'succeeded', urls: task.links, outputs: ['unverified'] }
      : { taskId: id, status: 'SUCCESS', errorCode: '', results: ['unverified'] } })) });
    assert.equal(queried.status, 'succeeded'); assert.equal(queried.images, undefined);
    assert.equal(calls.length, 2);
    if (cloud) { assert.equal(calls[1].url.href, task.links.self); assert.equal(calls[1].options.method, 'GET'); }
    else { assert.equal(calls[1].url.pathname, '/openapi/v2/query'); assert.deepEqual(JSON.parse(calls[1].body), { taskId: id }); }
    await assert.rejects(submitComfyCloudTask(account(), f.input, { ...f.options, ledger: reopened.ledger, requestImpl: mockNodeRequest(calls) }));
    await assert.rejects(submitComfyCloudTask(account(), { ...f.input, attemptId: 'replacement-attempt' }, { ...f.options, ledger: reopened.ledger, requestImpl: mockNodeRequest(calls) }));
    assert.equal(calls.length, 2, 'neither replay nor a new attempt may re-charge before the original result is verified');
    assert.deepEqual(await reopened.store.inspectChannel(f.key), reopened.before);
  }
});

test('cancelled or switched-account submissions recover only under the original account after restart', async t => {
  for (const binding of [cloudBinding, rhBinding]) for (const changeAccount of [false, true]) {
    const f = await cloudSubmissionFixture(t, binding), controller = new AbortController(), calls = [], id = binding.provider === 'comfy-cloud' ? 'new-job' : '1904152026220003329';
    await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, signal: controller.signal, requestImpl: mockNodeRequest(calls, () => {
      if (changeAccount) f.req.user.profile.handle = 'bob'; else controller.abort();
      return { body: acceptedCloudBody(binding, id) };
    }) }), { submissionState: 'accepted' });
    const reopened = await reopenCloudSubmission(t, f), task = reopened.row.cloudReceipt.task;
    const bob = { user: { profile: { handle: 'bob', enabled: true, admin: false } } }; let deniedDns = 0;
    await assert.rejects(queryComfyCloudTask(bob, task, { ...reopened.options, resolveHost: async () => { deniedDns++; return publicDns(); }, requestImpl: mockNodeRequest(calls) }), { code: 'comfy_cloud_query_authorization' });
    assert.equal(deniedDns, 0); assert.equal(calls.length, 1);
    const result = await queryComfyCloudTask(account(), task, { ...reopened.options, requestImpl: mockNodeRequest(calls, () => ({ body: binding.provider === 'comfy-cloud'
      ? { id, status: 'running', urls: task.links } : { taskId: id, status: 'RUNNING', errorCode: '' } })) });
    assert.equal(result.status, 'running'); assert.equal(calls.length, 2);
    assert.equal(reopened.row.status, 'uncertain'); assert.equal(reopened.row.namespace, f.input.expectedAccount);
    assert.deepEqual(await reopened.store.inspectChannel(f.key), reopened.before);
  }
});

test('unknown acceptance after restart is neither guessed into a query route nor replayed as a new generation', async t => {
  for (const malformed of [false, true]) {
    const f = await cloudSubmissionFixture(t), calls = [];
    await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, requestImpl: mockNodeRequest(calls, () => malformed
      ? { body: { id: 'new-job', urls: { self: 'https://else.test/job', cancel: 'https://else.test/job/cancel' } } }
      : { status: 503, body: { error: 'unavailable' } }) }));
    const reopened = await reopenCloudSubmission(t, f);
    const guessed = bindComfyCloudTask(cloudBinding, 'new-job', { self: '/api/v2/jobs/new-job', cancel: '/api/v2/jobs/new-job/cancel' }); let queries = 0;
    await assert.rejects(queryComfyCloudTask(account(), guessed, { ...reopened.options, resolveHost: async () => { queries++; return publicDns(); }, requestImpl: mockNodeRequest(calls) }), { code: 'comfy_cloud_query_authorization' });
    await assert.rejects(submitComfyCloudTask(account(), { ...f.input, attemptId: 'not-a-retry' }, { ...f.options, ledger: reopened.ledger, requestImpl: mockNodeRequest(calls) }));
    assert.equal(queries, 0); assert.equal(calls.length, 1);
    assert.equal(reopened.row.upstreamId, malformed ? 'new-job' : undefined); assert.equal(reopened.row.cloudReceipt, undefined);
    assert.equal(reopened.row.status, 'uncertain'); assert.deepEqual(await reopened.store.inspectChannel(f.key), reopened.before);
  }
});

test('cloud submit cancellation before dispatch creates no reservation, DNS lookup or request', async t => {
  const f = await cloudSubmissionFixture(t), controller = new AbortController(); controller.abort(); let resolutions = 0; const calls = [];
  await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, signal: controller.signal,
    resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls) }), { code: 'comfy_cloud_submit_cancelled', submissionState: 'not_submitted' });
  assert.equal(resolutions, 0); assert.equal(calls.length, 0); assert.deepEqual(await fs.readdir(f.root), []);
});

test('cloud submit preserves accepted ids for malformed links and does not retry HTTP idempotency errors', async t => {
  for (const malformed of [false, true]) {
    const f = await cloudSubmissionFixture(t), calls = [];
    await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, requestImpl: mockNodeRequest(calls, () => malformed
      ? { body: { id: 'new-job', urls: { self: 'https://evil.test', cancel: 'https://evil.test' } } }
      : { status: 422, body: { error: { code: 'idempotency_key_reuse' } } }) }), error => malformed
      ? error.submissionState === 'accepted' && error.upstreamId === 'new-job'
      : error.submissionState === 'unknown' && error.httpStatus === 422);
    const row = (await f.store.inspectChannel(f.key)).entries[0]; assert.equal(row.status, 'uncertain'); assert.equal(row.cloudReceipt, undefined);
    assert.equal(row.upstreamId, malformed ? 'new-job' : undefined); assert.equal(calls.length, 1);
  }
});

test('post-dispatch page cancellation or login change retains original cloud acceptance before refusing delivery', async t => {
  for (const changeAccount of [false, true]) {
    const f = await cloudSubmissionFixture(t), controller = new AbortController(), calls = [];
    await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, signal: controller.signal,
      requestImpl: mockNodeRequest(calls, () => {
        if (changeAccount) f.req.user.profile.handle = 'bob'; else controller.abort();
        return { body: acceptedCloudBody() };
      }),
    }), error => error.submissionState === 'accepted' && error.code === `comfy_cloud_submit_${changeAccount ? 'account' : 'cancelled'}`
      && (changeAccount ? !Object.hasOwn(error, 'upstreamId') : error.upstreamId === 'new-job'));
    const row = (await f.store.inspectChannel(f.key)).entries[0]; assert.equal(row.namespace, f.input.expectedAccount);
    assert.equal(row.upstreamId, 'new-job'); assert.ok(row.cloudReceipt); assert.equal(row.status, 'uncertain'); assert.equal(calls.length, 1);
  }
});

test('submit deadline includes authorization and late grants cannot dispatch or reserve', async t => {
  const f = await cloudSubmissionFixture(t); let release, resolutions = 0;
  const grant = new Promise(resolve => { release = resolve; }); const calls = [];
  await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, timeoutMs: 15, authorizeTarget: () => grant,
    resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls) }), { code: 'comfy_cloud_submit_timeout', submissionState: 'not_submitted' });
  release(async () => {}); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolutions, 0); assert.equal(calls.length, 0); assert.deepEqual(await fs.readdir(f.root), []);
});

test('submit deadline bounds a stalled response and keeps the durable task fenced without a replay', async t => {
  const f = await cloudSubmissionFixture(t); let calls = 0;
  await assert.rejects(submitComfyCloudTask(f.req, f.input, { ...f.options, timeoutMs: 150, requestImpl: (_url, _options, callback) => {
    calls++;
    return new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
      const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' }; callback(incoming); done();
    } });
  } }), { code: 'comfy_cloud_submit_timeout', submissionState: 'unknown' });
  let row;
  for (let i = 0; i < 50; i++) { row = (await f.store.inspectChannel(f.key))?.entries[0]; if (row?.status === 'uncertain') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(row.status, 'uncertain'); assert.equal(calls, 1); assert.equal(row.upstreamId, undefined);
});

test('Node response bridge does not prefetch into a closed reader when bounded admission rejects early', async () => {
  const task = bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  for (const result of [{ status: 503, body: { error: 'unavailable' } },
    { headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>not JSON</html>') },
    { headers: { 'content-type': 'application/json', 'content-length': '5000000' }, body: { oversized: true } }]) {
    const transport = await createComfyCloudServerTransport(account(), { binding: cloudBinding, operation: 'query', task }, {
      authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest([], () => result),
    });
    const response = await transport.fetchImpl(transport.plan.url, { method: 'GET' });
    await assert.rejects(readComfyCloudJsonResponse(response, { task }), error => error.code.startsWith('comfy_cloud_response_'));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('cloud submit response retains bounded acceptance evidence after login changes but cannot pass delivery checks', async () => {
  for (const binding of [cloudBinding, rhBinding]) {
    const req = account(), calls = [], task = bindComfyCloudTask(binding, binding.provider === 'runninghub' ? '1904152026220003329' : 'accepted',
      binding.provider === 'runninghub' ? undefined : { self: '/api/v2/jobs/accepted', cancel: '/api/v2/jobs/accepted/cancel' });
    const transport = await createComfyCloudServerTransport(req, { binding, operation: 'submit' }, {
      authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest(calls, () => {
        req.user.profile.handle = 'bob';
        return { body: binding.provider === 'runninghub' ? { code: 0, data: { taskId: task.taskId } } : { id: task.taskId, urls: task.links } };
      }),
    });
    const response = await transport.fetchImpl(transport.plan.url, { method: 'POST', body: '{}' });
    assert.deepEqual(readComfyCloudAcceptance(binding, await readComfyCloudJsonResponse(response)), task);
    await assert.rejects(transport.verify(), { code: 'comfy_transport_account_changed', submissionState: 'unknown' });
    await assert.rejects(transport.fetchImpl(transport.plan.url, { method: 'POST', body: '{}' }), { code: 'comfy_transport_cloud_replay' });
    assert.equal(calls.length, 1);
  }
});

test('cloud query and cancellation keep rejecting changed-account responses rather than exposing their contents', async () => {
  for (const operation of ['query', 'cancel']) {
    const req = account(), task = bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
    const transport = await createComfyCloudServerTransport(req, { binding: cloudBinding, operation, task }, {
      authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest([], () => { req.user.profile.handle = 'bob'; return { body: { private: 'original owner only' } }; }),
    });
    await assert.rejects(transport.fetchImpl(transport.plan.url, { method: transport.plan.method }), { code: 'comfy_transport_account_changed', submissionState: 'accepted', upstreamId: task.taskId });
  }
});

async function persistedCloudTask(t, binding = cloudBinding, imageCount = 1) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-routes-')); roots.push(root);
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = account(), apiKey = 'test-only-secret', taskId = binding.provider === 'runninghub' ? '1904152026220003329' : 'persisted';
  const task = bindComfyCloudTask(binding, taskId, binding.provider === 'runninghub' ? undefined
    : { self: `/deployment/saved/api/v2/jobs/${taskId}`, cancel: `/deployment/saved/api/v2/jobs/${taskId}/cancel` });
  const intent = { schema: COMFY_CLOUD_INTENT_SCHEMA, connection: binding, requestDigest: 'a'.repeat(64),
    workflow: { templateHash: 'b'.repeat(64), executionHash: 'c'.repeat(64) },
    stillOutput: { version: 1, model: 'workflow', previewNodeIds: [], execution: { version: 1, automatic: imageCount === 1, maxImages: imageCount, expectedImages: imageCount, outputNodeIds: ['save'] } } };
  const ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, { expectedAccount: imageServiceAccount(req).namespace, attemptId: 'persisted-attempt', apiKey, intent });
  const ticket = ledger.submission(reservation); await ticket.beforeSubmit();
  await ticket.recordAccepted(taskId, { schema: COMFY_CLOUD_RECEIPT_SCHEMA, task, requestDigest: intent.requestDigest, workflow: intent.workflow, stillOutput: intent.stillOutput });
  await ticket.markUncertain(); await store.close();
  const reopened = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => reopened.close());
  const next = createComfyCloudLedger({ store: reopened }), locator = { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey };
  return { root, req, task, store: reopened, ledger: next, locator, options: {
    apiKey, authorizeTask: (req, original) => next.authorizeQuery(req, locator, original), authorizeTarget: cloudGrant, resolveHost: publicDns,
  } };
}

test('persisted cloud and RH originals pass real ledger grants through the bounded query runner after restart', async t => {
  for (const binding of [cloudBinding, rhBinding]) {
    const f = await persistedCloudTask(t, binding), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
    const result = await queryComfyCloudTask(f.req, f.task, { ...f.options, requestImpl: mockNodeRequest(calls, () => ({ body: binding.provider === 'runninghub'
      ? { taskId: f.task.taskId, status: 'RUNNING', errorCode: '' } : { id: f.task.taskId, status: 'running', urls: f.task.links } })) });
    assert.equal(result.status, 'running'); assert.equal(calls.length, 1);
    if (binding.provider === 'runninghub') { assert.equal(calls[0].url.pathname, '/openapi/v2/query'); assert.deepEqual(JSON.parse(calls[0].body), { taskId: f.task.taskId }); }
    else { assert.equal(calls[0].url.href, f.task.links.self); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].body.length, 0); }
    assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before, 'query must not mark a generating job complete or release its fence');
  }
});

const cloudOutput = (id = '00000000-0000-4000-8000-000000000001', extra = {}) => ({
  id, node_id: 'save', type: 'image', content_type: 'image/png', size_bytes: png.length, hash: null,
  url: 'https://signed.test/result?secret=temporary', ...extra,
});

const rhFileUrl = index => `https://files.test/${index}.png?signature=temporary`;
function rhDownloadReply(f, call, count = 2) {
  if (call.url.hostname === 'files.test') return { body: png, headers: { 'content-type': 'image/png' } };
  assert.equal(JSON.parse(call.body).taskId, f.task.taskId);
  if (call.url.pathname === '/openapi/v2/query') return { body: { taskId: f.task.taskId, status: 'SUCCESS', errorCode: '',
    ...(f.usage?{usage:f.usage}:{}),
    results: Array.from({ length: count }, (_, index) => ({ url: rhFileUrl(index), outputType: 'png' })) } };
  assert.equal(call.url.pathname, '/task/openapi/outputs');
  return { body: { code: 0, data: Array.from({ length: count }, (_, index) => ({ fileUrl: rhFileUrl(index), fileType: 'png', nodeId: 'save' })).reverse() } };
}

test('RH sequential download preserves original ordering and stages local proofs without URLs or invented upstream hashes', async t => {
  const f = await persistedCloudTask(t, rhBinding, 2), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
  const got = await downloadRunningHubJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f),
    requestImpl: mockNodeRequest(calls, call => rhDownloadReply(f, call)) });
  assert.equal(got.status, 'integrity_checked'); assert.equal(got.result.provider, 'runninghub');
  assert.deepEqual(got.result.cloud.selection.map(row => row.outputIndex), [0, 1]);
  assert.equal(got.result.cloud.selection[0].outputKey, `rh:${f.task.taskId}:0:save`);
  for (const image of got.result.images) assert.deepEqual(Buffer.from(image.bytes), png);
  for (const proof of got.result.cloud.images) { assert.equal(proof.integrity.platformVerified, null); assert.equal(proof.hash, null); }
  assert.equal(JSON.stringify(got.result.cloud).includes('signature'), false); assert.equal(JSON.stringify(got.result.cloud).includes('assetId'), false);
  assert.deepEqual(calls.map(call => call.url.pathname), ['/openapi/v2/query', '/task/openapi/outputs', '/0.png', '/1.png']);
  for (const call of calls.slice(2)) { assert.deepEqual(call.options.headers, { Accept: 'image/*' }); assert.equal(call.options.method, 'GET'); assert.equal(call.body.length, 0); }
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before, 'download is not an archive or re-submission');
  const cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
  await cache.reserve(got.grant.identity); await cache.save(got.grant.identity, got.result);
  const stored = await got.grant.recordStored(cache); assert.equal(stored.delivery.imageCount, 2);
  assert.deepEqual(stored.result.cloud.selection, got.result.cloud.selection);
  assert.deepEqual(Buffer.from(stored.result.images[1].bytes), png);
});

test('RH cannot partially deliver on a bad second image, redirect, private CDN, cancelled read or changed account', async t => {
  for (const mode of ['bad-image', 'redirect', 'private-dns', 'cancel', 'account']) {
    const f = await persistedCloudTask(t, rhBinding, 2), calls = [], controller = new AbortController();
    const before = await f.store.inspectChannel(f.locator.channelKey);
    await assert.rejects(downloadRunningHubJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f), signal: controller.signal,
      resolveHost: async host => host === 'files.test' && mode === 'private-dns' ? [{ address: '127.0.0.1', family: 4 }] : publicDns(),
      requestImpl: mockNodeRequest(calls, call => {
        if (call.url.pathname === '/1.png') {
          if (mode === 'bad-image') return { body: Buffer.from('<html>not an image</html>'), headers: { 'content-type': 'image/png' } };
          if (mode === 'redirect') return { status: 302, headers: { location: 'https://other.test/private' } };
          if (mode === 'cancel') controller.abort();
          if (mode === 'account') f.req.user.profile.handle = 'bob';
        }
        return rhDownloadReply(f, call);
      }) }), error => error.submissionState === 'accepted' && error.upstreamId === f.task.taskId && !error.message.includes('signature'));
    assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
    assert.equal(calls.some(call => call.url.pathname.includes('/create')), false);
    assert.ok(calls.length <= 4);
  }
});

test('RH shares persistent receive/readback/ack: repeated retrieval has no cloud calls and cleanup needs the exact receipt', async t => {
  const f = await persistedCloudTask(t, rhBinding, 2), calls = [];
  const service = createComfyCloudService({ dataRoot: f.root, store: f.store, transportOptions: {
    authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => rhDownloadReply(f, call)),
  } }); t.after(() => service.close());
  const input = { version: 1, expectedAccount: imageServiceAccount(f.req).namespace, task: f.task, ...f.locator };
  const first = await service.result(f.req, input); assert.equal(first.status, 'ready'); assert.equal(first.images.length, 2);
  assert.equal(first.images[0].id, `rh:${f.task.taskId}:0:save`); assert.deepEqual(Buffer.from(first.images[1].data, 'base64'), png);
  assert.equal(JSON.stringify(first).includes('signature'), false); assert.equal(JSON.stringify(first).includes(f.locator.apiKey), false);
  const second = await service.result(f.req, input); assert.equal(second.receipt, first.receipt); assert.equal(calls.length, 4);
  const ack = { ...input, archived: true, receipt: first.receipt }; delete ack.apiKey;
  await assert.rejects(service.acknowledge(f.req, { ...ack, receipt: 'f'.repeat(64) }));
  await assert.rejects(service.acknowledge({ user: { profile: { handle: 'bob', enabled: true } } }, ack));
  assert.equal((await service.acknowledge(f.req, ack)).cleanup, 'complete');
  assert.equal((await service.acknowledge(f.req, ack)).cleanup, 'complete');
  assert.equal((await service.result(f.req, input)).status, 'archived'); assert.equal(calls.length, 4);
});

test('failed RH tasks persist reported usage through query and collection without pretending files were stored or resubmitting',async t=>{
  const usage={consumeCoins:'0.7500',consumeMoney:null,thirdPartyConsumeMoney:null,taskCostTime:'12.25'};
  for(const method of ['query','result']){
    const f=await persistedCloudTask(t,rhBinding),calls=[];
    const service=createComfyCloudService({dataRoot:f.root,store:f.store,transportOptions:{authorizeTarget:cloudGrant,resolveHost:publicDns,
      requestImpl:mockNodeRequest(calls,()=>({body:{taskId:f.task.taskId,status:'FAILED',errorCode:'1501',usage}}))}});t.after(()=>service.close());
    const input={version:1,expectedAccount:imageServiceAccount(f.req).namespace,task:f.task,...f.locator};
    assert.equal((await service[method](f.req,input)).status,'failed');assert.equal(calls.length,1);
    const catalog=await service.catalog(f.req,{version:1,expectedAccount:input.expectedAccount});
    assert.equal(catalog.tasks[0].reportedStatus,'failed');assert.deepEqual(catalog.tasks[0].usage,usage);
    const saved=(await f.store.inspectChannel(f.locator.channelKey)).entries[0];
    assert.equal(saved.cloudDelivery,undefined,'reported expense is not proof of stored media');assert.notEqual(saved.status,'succeeded');
    await service.close();const reopened=createImageServiceStore({dataRoot:f.root,scope:'comfy-cloud'});t.after(()=>reopened.close());
    assert.deepEqual((await reopened.inspectChannel(f.locator.channelKey)).entries[0].cloudObservation.usage,usage);
    assert.doesNotMatch(JSON.stringify(saved),/test-only-secret|apiKey/);
  }
});

test('RH observation rejects foreign task reports and conflicting terminal status without changing the original evidence',async t=>{
  const f=await persistedCloudTask(t,rhBinding),ledger=createComfyCloudLedger({store:f.store}),grant=await ledger.authorizeStaging(f.req,f.locator,f.task);
  const result={task:f.task,status:'failed',usage:{consumeCoins:'0',consumeMoney:null,thirdPartyConsumeMoney:null,taskCostTime:null}};
  await assert.rejects(grant.recordUsage({...result,task:{...f.task,taskId:'999'}}),{code:'image_service_cloud_usage_identity'});
  await grant.recordUsage(result);const before=await f.store.inspectChannel(f.locator.channelKey);
  await assert.rejects(grant.recordUsage({...result,status:'succeeded'}),{code:'image_service_cloud_usage_conflict'});
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey),before);
  await grant.recordUsage({...result,status:'running'});assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey),before);
});

test('RH node evidence is fetched only after matching v2 success, under the same original ledger grant',async t=>{
  const f=await persistedCloudTask(t,rhBinding),calls=[];
  const result=await queryComfyCloudTask(f.req,f.task,{...f.options,includeStillOutputs:true,requestImpl:mockNodeRequest(calls,call=>{
    assert.equal(JSON.parse(call.body).taskId,f.task.taskId);
    if(call.url.pathname==='/openapi/v2/query')return{body:{taskId:f.task.taskId,status:'SUCCESS',errorCode:'',usage:{consumeCoins:'17',taskCostTime:'83'},results:[{url:'https://image.example/original.png',outputType:'png'}]}};
    assert.equal(call.url.pathname,'/task/openapi/outputs');return{body:{code:0,data:[{fileUrl:'https://image.example/original.png',fileType:'png',nodeId:'save'}]}};
  })});
  assert.equal(calls.length,2);assert.equal(result.stillOutputs.outputs[0].nodeId,'save');assert.equal(result.usage.consumeCoins,'17');
  assert.equal(result.status,'succeeded');assert.equal(result.archived,undefined);assert.equal(result.images,undefined);
  for(const state of ['RUNNING','FAILED']){const reads=[];const result=await queryComfyCloudTask(f.req,f.task,{...f.options,includeStillOutputs:true,
    requestImpl:mockNodeRequest(reads,()=>({body:{taskId:f.task.taskId,status:state,errorCode:state==='FAILED'?'failure':''}}))});assert.equal(result.stillOutputs,null);assert.equal(reads.length,1);}
  const unavailable=[];await assert.rejects(queryComfyCloudTask(f.req,f.task,{...f.options,includeStillOutputs:true,
    requestImpl:mockNodeRequest(unavailable,call=>call.url.pathname==='/openapi/v2/query'
      ?{body:{taskId:f.task.taskId,status:'SUCCESS',errorCode:'',results:[{url:'https://image.example/original.png',outputType:'png'}]}}
      :{status:404,body:{message:'private-upstream-text'}})}),{code:'comfy_cloud_query_outputs',submissionState:'accepted'});
  assert.equal(unavailable.length,2,'missing supplemental evidence never triggers a new generation or another fallback');
});

test('bounded query collects still descriptors only from the original durable receipt and never archives remote success', async t => {
  const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
  const result = await queryComfyCloudTask(f.req, f.task, { ...f.options, includeStillOutputs: true,
    receipt: { stillOutput: { execution: { outputNodeIds: ['other'], maxImages: 99 } } }, // Not a supported override.
    requestImpl: mockNodeRequest(calls, () => ({ body: { id: f.task.taskId, status: 'succeeded', urls: f.task.links, error: null, outputs: [cloudOutput()] } })),
  });
  assert.equal(result.status, 'succeeded'); assert.equal(result.stillOutputs.outputs[0].nodeId, 'save');
  assert.equal(result.stillOutputs.requestDigest, before.entries[0].requestDigest); assert.equal(result.images, undefined);
  assert.ok(Object.isFrozen(result.stillOutputs.outputs)); assert.doesNotMatch(JSON.stringify(result), /temporary|signed.test/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
});

test('output collection cannot use an empty or other-provider grant and waiting snapshots contain no partial image', async t => {
  const f = await persistedCloudTask(t), calls = []; let resolutions = 0;
  const options = { ...f.options, includeStillOutputs: true, resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls) };
  await assert.rejects(queryComfyCloudTask(f.req, f.task, { ...options, authorizeTask: cloudGrant }), { code: 'comfy_cloud_query_authorization' });
  await assert.rejects(queryComfyCloudTask(f.req, bindComfyCloudTask(rhBinding, '123'), options), { code: 'comfy_cloud_query_authorization' });
  await assert.rejects(queryComfyCloudTask(f.req, f.task, { ...options, includeStillOutputs: 'true' }), { code: 'comfy_cloud_query_output_mode' });
  assert.equal(resolutions, 0); assert.equal(calls.length, 0);
  const result = await queryComfyCloudTask(f.req, f.task, { ...options, requestImpl: mockNodeRequest(calls, () => ({ body: {
    id: f.task.taskId, status: 'running', urls: f.task.links, outputs: [cloudOutput()],
  } })) });
  assert.equal(result.status, 'running'); assert.equal(result.stillOutputs, null); assert.equal(calls.length, 1);
});

test('output mismatch is a failed collection of the original task, never a generation retry', async t => {
  for (const outputs of [[cloudOutput(undefined, { node_id: 'other' })], [cloudOutput(), cloudOutput('00000000-0000-4000-8000-000000000002')]]) {
    const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
    await assert.rejects(queryComfyCloudTask(f.req, f.task, { ...f.options, includeStillOutputs: true,
      requestImpl: mockNodeRequest(calls, () => ({ body: { id: f.task.taskId, status: 'succeeded', urls: f.task.links, outputs } })),
    }), { code: 'comfy_cloud_query_outputs', submissionState: 'accepted', upstreamId: f.task.taskId, retryable: false });
    assert.equal(calls.length, 1); assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('revocation after a valid output response blocks descriptor delivery under the original durable grant', async t => {
  const f = await persistedCloudTask(t), calls = []; let revoked;
  await assert.rejects(queryComfyCloudTask(f.req, f.task, { ...f.options, includeStillOutputs: true,
    authorizeTask: async (req, original) => {
      const verify = await f.ledger.authorizeQuery(req, f.locator, original);
      return async () => { if (revoked) await revoked; return verify(); };
    },
    requestImpl: mockNodeRequest(calls, () => {
      revoked = f.store.transaction(f.locator.channelKey, state => { state.entries[0].fence = 'revoked'; return { state }; });
      return { body: { id: f.task.taskId, status: 'succeeded', urls: f.task.links, outputs: [cloudOutput()] } };
    }),
  }), { code: 'comfy_cloud_query_delivery', submissionState: 'accepted', upstreamId: f.task.taskId });
  await revoked; assert.equal(calls.length, 1);
});

const assetReadInput = f => ({ task: f.task, assetId: cloudOutput().id, ...f.locator });
const assetReadOptions = f => ({ ledger: f.ledger, authorizeTarget: cloudGrant, resolveHost: publicDns });
const assetMetadataBody = f => ({ id: cloudOutput().id, job_id: f.task.taskId, size_bytes: png.length, content_type: 'image/png', hash: null,
  url: 'https://files.test/image?secret=temporary', url_expires_at: new Date(Date.now() + 60000).toISOString() });
const readyCloudJob = f => ({ id: f.task.taskId, status: 'succeeded', urls: f.task.links, outputs: [cloudOutput()] });

const assetDownloadReply = (f, call) => call.url.hostname === 'files.test' ? { body: png, headers: { 'content-type': 'image/png' } }
  : { body: call.url.pathname.includes('/assets/') ? assetMetadataBody(f) : readyCloudJob(f) };

const twoCloudIds = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'];
const multiAssetReply = (f, call) => call.url.hostname === 'files.test' ? { body: png, headers: { 'content-type': 'image/png' } }
  : { body: call.url.pathname.includes('/assets/') ? { ...assetMetadataBody(f), id: call.url.pathname.split('/').at(-1),
    url: `https://files.test/${call.url.pathname.split('/').at(-1)}?secret=temporary` } : { ...readyCloudJob(f), outputs: twoCloudIds.map(id => cloudOutput(id)) } };

test('whole cloud job preserves the final query order with one grant and feeds the existing binary staging contract', async t => {
  const f = await persistedCloudTask(t, cloudBinding, 2), calls = [], before = await f.store.inspectChannel(f.locator.channelKey); let grants = 0;
  const received = await downloadComfyCloudJob(f.req, { task: f.task, ...f.locator, selection: ['forged'], assetId: 'forged' }, { ...assetReadOptions(f),
    ledger: { authorizeStaging: (...args) => { grants++; return f.ledger.authorizeStaging(...args); } }, requestImpl: mockNodeRequest(calls, call => multiAssetReply(f, call)) });
  assert.equal(received.status, 'integrity_checked'); assert.equal(grants, 1); assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.deepEqual(received.result.cloud.selection.map(row => row.assetId), twoCloudIds);
  assert.deepEqual(received.result.cloud.images.map(row => row.assetId), twoCloudIds);
  assert.deepEqual(calls.filter(call => call.url.hostname === 'files.test').map(call => call.url.pathname.slice(1)), twoCloudIds);
  assert.doesNotMatch(JSON.stringify(received), /files\.test|temporary|test-only-secret/);
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before, 'collecting is neither settlement nor acknowledgement');
  assert.equal(await received.grant.verify(), received.grant.receipt, 'the original durable grant survives the download controller closing');
  const cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
  await cache.reserve(received.grant.identity); await cache.save(received.grant.identity, received.result);
  const loaded = await cache.load(received.grant.identity);
  assert.equal(loaded.images.length, 2); assert.deepEqual(loaded.cloud.selection.map(row => row.assetId), twoCloudIds);
  assert.deepEqual(loaded.images.map(image => Buffer.from(image.bytes)), [png, png]);
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
});

test('verified cloud asset CDN links use the original cloud permission, without separate CDN registration or credential forwarding', async t => {
  const f = await persistedCloudTask(t), calls = [], targets = [];
  const result = await downloadComfyCloudJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f),
    authorizeTarget: async (_req, target) => {
      targets.push(target.baseUrl);
      assert.equal(target.baseUrl, `${f.task.origin}/`); assert.equal(target.allowPrivateNetwork, false);
      return async () => {};
    }, requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) });
  assert.equal(result.status, 'integrity_checked'); assert.equal(targets.length, 3);
  const file = calls.find(call => call.url.hostname === 'files.test');
  assert.ok(file); assert.equal(file.options.method, 'GET');
  assert.doesNotMatch(JSON.stringify(file.options.headers), /test-only-secret|Bearer|Cookie/i);
});

test('revoking the original cloud connection before CDN download prevents file IO', async t => {
  const f = await persistedCloudTask(t), calls = []; let grants = 0;
  await assert.rejects(downloadComfyCloudJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f),
    authorizeTarget: async () => { if (++grants === 3) throw new Error('revoked'); return async () => {}; },
    requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) }), { code: 'comfy_cloud_asset_read_file' });
  assert.equal(calls.length, 2); assert.equal(calls.filter(call => call.url.hostname === 'files.test').length, 0);
});

test('cloud receiver confirms full storage but never client ACK, then serves the original without further cloud IO', async t => {
  const f = await persistedCloudTask(t, cloudBinding, 2), calls = [], before = await f.store.inspectChannel(f.locator.channelKey); let grants = 0;
  const cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
  const receiver = createComfyCloudReceiver({ cache, ledger: { authorizeStaging: (...args) => { grants++; return f.ledger.authorizeStaging(...args); } } });
  const packet = await receiver.receive(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => multiAssetReply(f, call)) });
  assert.equal(packet.status, 'staged'); assert.equal(packet.result.images.length, 2); assert.equal(grants, 1); assert.equal(calls.length, 5);
  const stored = await f.store.inspectChannel(f.locator.channelKey);
  assert.equal(stored.entries[0].status, 'succeeded'); assert.equal(stored.entries[0].cloudDelivery.state, 'stored');
  assert.equal(stored.entries[0].cloudDelivery.archivedAt, undefined);
  assert.equal(stored.entries[0].fence, before.entries[0].fence); assert.deepEqual(stored.entries[0].cloudReceipt, before.entries[0].cloudReceipt);
  const reopened = createComfyCloudReceiver({ cache, ledger: f.ledger, download: () => assert.fail('saved originals must not depend on expired remote URLs') });
  const readback = await reopened.receive(f.req, { task: f.task, ...f.locator });
  assert.equal(readback.status, 'staged'); assert.equal(readback.result.receipt, packet.result.receipt);
  assert.deepEqual(readback.result.cloud.selection.map(row => row.assetId), twoCloudIds);
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), stored);
});

test('one receiver suppresses duplicate in-flight collection without sharing the first caller result', async t => {
  const f = await persistedCloudTask(t), calls = []; let enter, release, downloads = 0;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
  const receiver = createComfyCloudReceiver({ cache, ledger: f.ledger, download: async (...args) => { downloads++; enter(); await gate; return downloadComfyCloudJob(...args); } });
  const input = { task: f.task, ...f.locator }, options = { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) };
  const first = receiver.receive(f.req, input, options); await entered;
  try {
    const second = await receiver.receive(f.req, input, options);
    assert.deepEqual(second, { status: 'collecting', task: f.task, result: null }); assert.equal(downloads, 1);
  } finally { release(); }
  assert.equal((await first).status, 'staged'); assert.equal(calls.length, 3);
});

async function stagedBeforeSettlement(t) {
  const f = await persistedCloudTask(t), calls = [], cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
  const downloaded = await downloadComfyCloudJob(f.req, { task: f.task, ...f.locator },
    { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) });
  await cache.reserve(downloaded.grant.identity); await cache.save(downloaded.grant.identity, downloaded.result);
  return { f, calls, cache, received: { grant: downloaded.grant, result: await cache.load(downloaded.grant.identity) } };
}

test('only a full original cache read can record stored completion, and repeats preserve its receipt and timestamps', async t => {
  const { f, calls, cache, received } = await stagedBeforeSettlement(t);
  assert.equal(await received.grant.readDelivery(), null);
  const saved = await received.grant.recordStored(cache);
  assert.equal(saved.delivery.state, 'stored'); assert.equal(saved.delivery.cacheReceipt, received.result.receipt);
  assert.equal(saved.delivery.bytes, png.length); assert.equal(saved.delivery.archivedAt, undefined);
  const before = await f.store.inspectChannel(f.locator.channelKey); assert.equal(before.entries[0].status, 'succeeded');
  assert.deepEqual((await received.grant.recordStored(cache)).delivery, saved.delivery);
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  assert.equal((await cache.load(received.grant.identity)).images.length, 1, 'recording storage does not delete the only image');
  const next = createComfyCloudLedger({ store: f.store }), grant = await next.authorizeStaging(f.req, f.locator, f.task);
  assert.deepEqual(await grant.readDelivery(), saved.delivery); assert.equal(calls.length, 3);
  assert.throws(() => next.submission(grant.identity), { code: 'image_service_cloud_ticket' });
});

test('stored completion refuses missing bytes, changed ownership, cancellation and conflicting cache receipts', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  const before = await f.store.inspectChannel(f.locator.channelKey);
  await assert.rejects(received.grant.recordStored({ load: identity => cache.load(identity, { metadataOnly: true }) }), { code: 'image_service_cloud_delivery_missing' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(received.grant.recordStored(cache, { signal: controller.signal }), { code: 'image_service_cloud_delivery_cancelled' });
  f.req.user.profile.handle = 'bob'; await assert.rejects(received.grant.recordStored(cache), { code: 'image_service_cloud_account_changed' }); f.req.user.profile.handle = 'alice';
  await assert.rejects(received.grant.recordStored({ load: async identity => {
    const result = await cache.load(identity); f.req.user.profile.handle = 'bob'; return result;
  } }), { code: 'image_service_cloud_account_changed' }); f.req.user.profile.handle = 'alice';
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  const saved = await received.grant.recordStored(cache);
  await assert.rejects(received.grant.recordStored({ load: async identity => ({ ...await cache.load(identity), receipt: '0'.repeat(64) }) }), { code: 'image_service_cloud_delivery_conflict' });
  assert.deepEqual(await received.grant.readDelivery(), saved.delivery);
  await f.store.transaction(f.locator.channelKey, state => { state.entries[0].fence = 'replacement'; return { state }; });
  await assert.rejects(received.grant.recordStored(cache), { code: 'image_service_cloud_query_changed' });
});

test('a failed delivery ledger commit preserves original bytes and the conservative task state for later recovery', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  const broken = createComfyCloudLedger({ store: { ...f.store, transaction: async () => { throw new Error('simulated write unavailable'); } } });
  const grant = await broken.authorizeStaging(f.req, f.locator, f.task);
  await assert.rejects(grant.recordStored(cache));
  assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].status, 'uncertain');
  assert.equal((await cache.load(received.grant.identity)).receipt, received.result.receipt);
  assert.equal((await received.grant.recordStored(cache)).delivery.state, 'stored');
});

test('archived cloud jobs never re-download and missing previously stored images require review instead of a silent fallback', async t => {
  for (const archived of [true, false]) {
    const { f, cache, received } = await stagedBeforeSettlement(t); await received.grant.recordStored(cache);
    if (archived) await f.store.transaction(f.locator.channelKey, state => {
      const row = state.entries[0]; row.updatedAt++;
      row.cloudDelivery = { ...row.cloudDelivery, state: 'archived', archivedAt: row.updatedAt }; return { state };
    });
    await cache.discard(received.grant.identity, received.result.receipt);
    let downloads = 0;
    const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache, download: () => { downloads++; assert.fail('a recorded archive/storage outcome is not permission to restart collection'); } });
    const pending = receiver.receive(f.req, { task: f.task, ...f.locator });
    if (archived) assert.deepEqual(await pending, { status: 'archived', task: f.task, result: null });
    else await assert.rejects(pending, { code: 'comfy_cloud_receive_readback' });
    assert.equal(downloads, 0); assert.equal(await cache.load(received.grant.identity), null);
    assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].cloudDelivery.state, archived ? 'archived' : 'stored');
  }
});

test('receiver does not announce stored success when the ledger write failed and recovery needs no second full image read', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  const broken = createComfyCloudLedger({ store: { ...f.store, transaction: async () => { throw new Error('simulated unavailable ledger'); } } });
  const input = { task: f.task, ...f.locator }, download = () => assert.fail('keep the already verified private image');
  await assert.rejects(createComfyCloudReceiver({ ledger: broken, cache, download }).receive(f.req, input), { code: 'comfy_cloud_receive_readback' });
  assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].status, 'uncertain');
  assert.equal((await cache.load(received.grant.identity)).receipt, received.result.receipt);
  let fullReads = 0;
  const result = await createComfyCloudReceiver({ ledger: f.ledger, download, cache: { ...cache, load: (...args) => {
    if (!args[1]?.metadataOnly) fullReads++; return cache.load(...args);
  } } }).receive(f.req, input);
  assert.equal(result.status, 'staged'); assert.equal(result.delivery.state, 'stored'); assert.equal(fullReads, 1);
});

test('archive confirmation requires stored evidence and exact explicit consent before touching original files', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t), grant = received.grant;
  const input = { archived: true, receipt: received.result.receipt };
  let reads = 0;
  const counted = { ...cache, load: (...args) => { reads++; return cache.load(...args); } };
  await assert.rejects(grant.recordArchived(counted, input), { code: 'image_service_cloud_archive_receipt' });
  await grant.recordStored(cache);
  for (const invalid of [{ ...input, archived: false }, { ...input, receipt: '0'.repeat(64) }, {}]) {
    await assert.rejects(grant.recordArchived(counted, invalid));
  }
  assert.equal(reads, 0, 'invalid consent never reads or cleans originals');
  const archived = await grant.recordArchived(counted, input);
  assert.equal(reads, 1); assert.equal(archived.state, 'archived');
  assert.equal(archived.cacheReceipt, input.receipt); assert.ok(archived.archivedAt >= archived.storedAt);
  assert.equal((await cache.load(grant.identity)).receipt, input.receipt, 'recording client consent alone cannot delete files');
  const before = await f.store.inspectChannel(f.locator.channelKey);
  const next = await createComfyCloudLedger({ store: f.store }).authorizeStaging(f.req, f.locator, f.task);
  assert.deepEqual(await next.recordArchived({ load: () => assert.fail('repeated confirmed ACK must tolerate partially cleaned files') }, input), archived);
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before, 'retries preserve original task, identity and confirmation time');
});

test('unconfirmed or corrupt originals cannot become archived and cancelled or changed accounts cannot confirm', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t), grant = received.grant;
  await grant.recordStored(cache);
  const before = await f.store.inspectChannel(f.locator.channelKey), input = { archived: true, receipt: received.result.receipt };
  await assert.rejects(grant.recordArchived({ ...cache, load: () => cache.load(grant.identity, { metadataOnly: true }) }, input));
  await assert.rejects(grant.recordArchived(cache, { ...input, signal: AbortSignal.abort() }), { code: 'image_service_cloud_delivery_cancelled' });
  await assert.rejects(grant.recordArchived({ ...cache, load: async (...args) => {
    const value = await cache.load(...args); f.req.user.profile.handle = 'bob'; return value;
  } }, input), { code: 'image_service_cloud_account_changed' });
  f.req.user.profile.handle = 'alice';
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  assert.equal((await cache.load(grant.identity)).receipt, input.receipt);
});

test('archive commit failure preserves stored originals and a lost confirmation reply can retry the durable ACK', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  await received.grant.recordStored(cache);
  const input = { archived: true, receipt: received.result.receipt };
  for (const committed of [false, true]) {
    const ledger = createComfyCloudLedger({ store: { ...f.store, transaction: async (key, update) => {
      let archiveWrite = false;
      const value = await f.store.transaction(key, raw => {
        const result = update(raw); archiveWrite = result.result?.state === 'archived';
        if (archiveWrite && !committed) throw new Error('simulated archive write failure');
        return result;
      });
      if (archiveWrite) throw new Error('simulated lost archive reply');
      return value;
    } } });
    const grant = await ledger.authorizeStaging(f.req, f.locator, f.task);
    await assert.rejects(grant.recordArchived(cache, input));
    assert.equal((await received.grant.readDelivery()).state, committed ? 'archived' : 'stored');
    assert.equal((await cache.load(received.grant.identity)).receipt, input.receipt);
  }
  assert.equal((await received.grant.recordArchived({ load: () => assert.fail('already committed') }, input)).state, 'archived');
});

test('local cloud archive authority needs only the original ST owner and receipt, never a retained provider Key or new network ticket', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t); await received.grant.recordStored(cache);
  const { apiKey: _key, ...locator } = f.locator;
  const grant = await f.ledger.authorizeArchive(f.req, locator, f.task);
  assert.equal(grant.recordStored, undefined); assert.throws(() => f.ledger.submission(grant));
  await assert.rejects(f.ledger.authorizeStaging(f.req, locator, f.task));
  await assert.rejects(f.ledger.authorizeQuery(f.req, locator, f.task));
  await assert.rejects(f.ledger.authorizeArchive({ user: { profile: { handle: 'bob', enabled: true } } }, locator, f.task));
  await assert.rejects(f.ledger.authorizeArchive(f.req, { ...locator, channelKey: 'f'.repeat(64) }, f.task));
  const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache, download: () => assert.fail('archive cannot call cloud IO') });
  const input = { ...locator, task: f.task, archived: true, receipt: received.result.receipt };
  assert.equal((await receiver.acknowledge(f.req, input)).cleanup, 'complete');
  assert.equal((await receiver.acknowledge(f.req, input)).cleanup, 'complete');
  assert.equal(await cache.load(grant.identity), null);
});

test('cloud ACK persists consent before bounded cleanup, rejects wrong receipts even after cleanup, and never redownloads', async t => {
  const { f, cache, received, calls } = await stagedBeforeSettlement(t);
  await received.grant.recordStored(cache);
  let cleaned = 0;
  const receiver = createComfyCloudReceiver({ ledger: f.ledger, download: () => assert.fail('ACK cannot generate or download'), cache: { ...cache,
    discard: async (...args) => { assert.equal((await received.grant.readDelivery()).state, 'archived'); cleaned++; return cache.discard(...args); } } });
  const input = { task: f.task, ...f.locator, archived: true, receipt: received.result.receipt };
  const result = await receiver.acknowledge(f.req, input);
  assert.equal(result.status, 'archived'); assert.equal(result.cleanup, 'complete'); assert.equal(cleaned, 1);
  assert.equal(await cache.load(received.grant.identity), null);
  assert.equal((await cache.inventory(received.grant.identity.namespace)).entries.length, 0);
  const before = await f.store.inspectChannel(f.locator.channelKey);
  assert.equal((await receiver.acknowledge(f.req, input)).cleanup, 'complete');
  for (const invalid of [{ ...input, receipt: 'f'.repeat(64) }, { ...input, archived: false }]) await assert.rejects(receiver.acknowledge(f.req, invalid));
  await assert.rejects(receiver.acknowledge({ user: { profile: { handle: 'bob', enabled: true } } }, input));
  assert.equal(cleaned, 2, 'invalid or cross-account ACK never calls discard, even if directory is already absent');
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  assert.deepEqual(await receiver.receive(f.req, input), { status: 'archived', task: f.task, result: null });
  assert.equal(calls.length, 3);
});

test('partial cloud cleanup reports pending and retries from the durable receipt without needing removed image bytes', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  await received.grant.recordStored(cache);
  const results = path.join(f.root, '.qianmu-service', 'comfy-cloud-results-v1');
  const entries = await fs.readdir(results); assert.equal(entries.length, 1); assert.match(entries[0], /^[a-f0-9]{64}$/);
  const slot = path.join(results, entries[0]);
  const input = { task: f.task, ...f.locator, archived: true, receipt: received.result.receipt };
  const interrupted = createComfyCloudReceiver({ ledger: f.ledger, cache: { ...cache, discard: async () => {
    await fs.unlink(path.join(slot, 'image-0.bin')); throw new Error('private path must not escape');
  } } });
  const pending = await interrupted.acknowledge(f.req, input);
  assert.equal(pending.cleanup, 'pending'); assert.equal(pending.delivery.state, 'archived');
  assert.doesNotMatch(JSON.stringify(pending), /private path/);
  await fs.access(path.join(slot, 'manifest.json'));
  const resumed = createComfyCloudReceiver({ ledger: f.ledger, cache: { ...cache, load: () => assert.fail('partial cleanup is not a new image read') } });
  assert.equal((await resumed.acknowledge(f.req, input)).cleanup, 'complete');
  assert.equal(await cache.load(received.grant.identity), null);
});

test('cloud cleanup refuses unknown files and cancellation after durable consent leaves the original intact', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  await received.grant.recordStored(cache);
  const input = { task: f.task, ...f.locator, archived: true, receipt: received.result.receipt };
  const controller = new AbortController();
  const interrupted = createComfyCloudReceiver({ ledger: f.ledger, cache: { ...cache, discard: (...args) => {
    controller.abort(); return cache.discard(...args);
  } } });
  await assert.rejects(interrupted.acknowledge(f.req, input, { signal: controller.signal }), { code: 'comfy_cloud_archive_cancelled' });
  assert.equal((await received.grant.readDelivery()).state, 'archived');
  assert.equal((await cache.load(received.grant.identity)).receipt, input.receipt);
  const results = path.join(f.root, '.qianmu-service', 'comfy-cloud-results-v1'), entries = await fs.readdir(results);
  assert.equal(entries.length, 1); assert.match(entries[0], /^[a-f0-9]{64}$/);
  const unknown = path.join(results, entries[0], 'user-original.txt'); await fs.writeFile(unknown, 'keep');
  const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache });
  assert.equal((await receiver.acknowledge(f.req, input)).cleanup, 'pending');
  assert.equal(await fs.readFile(unknown, 'utf8'), 'keep');
  assert.equal((await cache.load(received.grant.identity)).receipt, input.receipt);
});

test('cloud receipt and archive confirmation share the original-task in-flight gate', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  await received.grant.recordStored(cache);
  const input = { task: f.task, ...f.locator, archived: true, receipt: received.result.receipt };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache: { ...cache, load: async (...args) => { enter(); await wait; return cache.load(...args); } } });
  const first = receiver.acknowledge(f.req, input); await entered;
  try {
    assert.deepEqual(await receiver.receive(f.req, input), { status: 'collecting', task: f.task, result: null });
    await assert.rejects(receiver.acknowledge(f.req, input), { code: 'comfy_cloud_archive_busy' });
  } finally { release(); }
  assert.equal((await first).cleanup, 'complete');
});

test('cloud host service returns ordinary image packets and scoped metadata, never internal grants, source URLs or original queue internals', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  const service = createComfyCloudService({ store: f.store, cache }); t.after(() => service.close());
  const input = { version: 1, expectedAccount: received.grant.identity.namespace, task: f.task, ...f.locator };
  const packet = await service.result(f.req, input);
  assert.equal(packet.status, 'ready'); assert.equal(packet.images[0].mime, 'image/png');
  assert.deepEqual(Buffer.from(packet.images[0].data, 'base64'), png); assert.equal(packet.receipt, received.result.receipt);
  assert.doesNotMatch(JSON.stringify(packet), /namespace|requestDigest|fence|cloudIntent|grant|files\.test|temporary|test-only-secret/);
  const page = await service.catalog(f.req, input);
  assert.equal(page.storageReadable, true); assert.equal(page.totals.tasks, 1); assert.equal(page.totals.imageBytes, png.length);
  assert.equal(page.originals[0].resultAvailable, true); assert.equal(page.tasks[0].archiveState, 'stored');
  assert.doesNotMatch(JSON.stringify(page), /namespace|requestDigest|fence|cloudIntent|files\.test|test-only-secret/);
  const other = { user: { profile: { handle: 'bob', enabled: true } } };
  const empty = await service.catalog(other, { version: 1, expectedAccount: imageServiceAccount(other).namespace });
  assert.equal(empty.totals.tasks, 0); assert.equal(empty.totals.count, 0); assert.deepEqual(empty.originals, []);
  await assert.rejects(service.result(other, input), { status: 401 });
  await service.acknowledge(f.req, { ...input, archived: true, receipt: packet.receipt });
  const after = await service.catalog(f.req, input);
  assert.equal(after.totals.imageBytes, 0); assert.equal(after.tasks[0].archiveState, 'archived');
  assert.equal((await service.query(f.req, input)).status, 'archived', 'no expired remote URL or network permission is needed to read durable confirmation');
  assert.equal((await service.result(f.req, input)).status, 'archived');
});

test('cloud host catalog preserves ledger history and unknown occupancy when partial cleanup prevents inventory', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t); await received.grant.recordStored(cache);
  const input = { version: 1, expectedAccount: received.grant.identity.namespace, task: f.task, ...f.locator, archived: true, receipt: received.result.receipt };
  await received.grant.recordArchived(cache, input);
  const service = createComfyCloudService({ store: f.store, cache: { ...cache, inventory: async () => { throw new Error('unreadable private files'); } } });
  t.after(() => service.close());
  const page = await service.catalog(f.req, input);
  assert.equal(page.storageReadable, false); assert.equal(page.totals.tasks, 1); assert.equal(page.totals.imageBytes, null);
  assert.equal(page.tasks[0].canRetryCleanup, true); assert.doesNotMatch(JSON.stringify(page), /unreadable private files/);
  assert.equal((await service.acknowledge(f.req, input)).cleanup, 'complete');
});

test('cloud browser recovery composes with the actual host, binary cache and archive-only cleanup after reopening', async t => {
  const { f, cache, received, calls: providerCalls } = await stagedBeforeSettlement(t);
  let interruptCleanup = true;
  const service = createComfyCloudService({ store: f.store, cache: { ...cache, discard: async (...args) => {
    if (interruptCleanup) throw Error('simulated cleanup interruption'); return cache.discard(...args);
  } } }); t.after(() => service.close());
  const rows = new Map(), calls = [], archivePath = path.join(f.root, 'synthetic-user-archive.png');
  const localStore = { get: async (ns,id) => structuredClone(rows.get(`${ns}/${id}`) || null), put: async value => {
    const row = normalizeComfyDelivery(value, 'https://st.test'), key = `${row.namespace}/${row.attemptId}`;
    assertComfyDeliveryUpdate(rows.get(key),row); rows.set(key,row);
  }, close() {} };
  const makeClient = () => createComfyRecoveryClient({ origin: 'https://st.test', account: async () => 'st-user:alice', store: localStore, confirm: async () => true,
    locks: { request: async (_name,_options,work) => work({}) }, fetchImpl: async (url,init) => {
      assert.ok(url.startsWith('/api/plugins/qianmu-tts/image/comfy/cloud/tasks/'));
      const action = url.split('/').at(-1), body = JSON.parse(init.body); calls.push(action);
      assert.ok(['catalog','result','acknowledge'].includes(action));
      if (action !== 'result') assert.equal(body.apiKey,undefined);
      return new Response(JSON.stringify(await service[action](f.req,body)));
    } });
  const first = makeClient(), item = (await first.cloudCatalog()).originals[0];
  const archived = await first.retrieveOriginal(item, { chatKey: 'synthetic-chat', apiKey: f.locator.apiKey,
    deliver: async (job,data,files,checkpoint,guard) => {
      await guard(); assert.equal(job.originalOnly,true); assert.equal(job.target,'gallery'); assert.deepEqual(files,[]);
      const bytes = Buffer.from(data.images[0].data,'base64'); assert.deepEqual(bytes,png);
      await fs.writeFile(archivePath,bytes); await checkpoint([{ url: '/user/images/synthetic-user-archive.png' }]); return true;
    } });
  assert.equal(archived.archived,true); assert.match(archived.warning,/尚未清理完/);
  assert.equal([...rows.values()][0].status,'archived'); assert.equal((await received.grant.readDelivery()).state,'archived');
  assert.equal((await cache.load(received.grant.identity)).receipt,received.result.receipt);
  first.close(); interruptCleanup = false;
  const resumed = makeClient(); t.after(() => resumed.close());
  assert.equal((await resumed.retrieveOriginal(item, { chatKey: 'different-chat' })).warning,'');
  assert.equal([...rows.values()][0].status,'confirmed'); assert.equal(await cache.load(received.grant.identity),null);
  assert.deepEqual(await fs.readFile(archivePath),png,'cleanup preserves the separately archived original');
  assert.deepEqual(calls,['catalog','result','acknowledge','acknowledge']); assert.equal(providerCalls.length,3,'no remote redownload after the staged fixture');
  assert.doesNotMatch(JSON.stringify([...rows.values()]),/test-only-secret|apiKey|workflow|base64/);
});

test('cloud service shutdown cancels active archive work, drains it before closing storage, and admits no later operations', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t); await received.grant.recordStored(cache);
  let enter, release, storeClosed = false;
  const entering = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const service = createComfyCloudService({ store: { ...f.store, close: () => { storeClosed = true; return f.store.close(); } },
    cache: { ...cache, load: async (...args) => { enter(); await held; return cache.load(...args); } } });
  const input = { version: 1, expectedAccount: received.grant.identity.namespace, task: f.task, ...f.locator, archived: true, receipt: received.result.receipt };
  const pending = assert.rejects(service.acknowledge(f.req, input)); await entering;
  const closed = service.close(); assert.equal(service.close(), closed);
  assert.equal(storeClosed, false, 'do not close the queue while its original work can still record evidence');
  await assert.rejects(service.catalog(f.req, input), { status: 503 });
  release(); await pending; await closed; assert.equal(storeClosed, true);
  const reopened = createImageServiceStore({ dataRoot: f.root, scope: 'comfy-cloud' }); t.after(() => reopened.close());
  assert.equal((await reopened.inspectChannel(f.locator.channelKey)).entries[0].cloudDelivery.state, 'stored');
  const originals = createImageServiceResults({ dataRoot: f.root, store: reopened, scope: 'comfy-cloud' });
  assert.equal((await originals.load(received.grant.identity)).receipt, input.receipt);
});

test('cloud service snapshots caller inputs and bounds concurrent metadata work before touching storage', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), entering = new Promise(resolve => { entered = resolve; });
  const service = createComfyCloudService({ store: f.store, cache: { ...cache, inventory: async (...args) => { entered(); await gate; return cache.inventory(...args); } } });
  t.after(() => service.close());
  const input = { version: 1, expectedAccount: received.grant.identity.namespace };
  const first = service.catalog(f.req, input); input.expectedAccount = 'changed-by-caller'; await entering;
  const second = service.catalog(f.req, { ...input, expectedAccount: received.grant.identity.namespace });
  try { await assert.rejects(service.catalog(f.req, input), { status: 503 }); }
  finally { release(); }
  assert.equal((await first).totals.tasks, 1); assert.equal((await second).totals.tasks, 1);
  await assert.rejects(service.catalog(f.req, { get version() { assert.fail('never invoke caller getters'); } }));
});

test('an archive confirmed during readback cannot be downgraded into another image delivery', async t => {
  const { f, cache } = await stagedBeforeSettlement(t);
  const ledger = { authorizeStaging: async (...args) => {
    const grant = await f.ledger.authorizeStaging(...args);
    return { ...grant, recordStored: async (...input) => {
      const saved = await grant.recordStored(...input);
      await f.store.transaction(f.locator.channelKey, state => {
        const row = state.entries[0]; row.updatedAt++;
        row.cloudDelivery = { ...row.cloudDelivery, state: 'archived', archivedAt: row.updatedAt }; return { state };
      });
      return saved; // Simulate the earlier transaction snapshot arriving after a later ACK.
    } };
  } };
  const received = await createComfyCloudReceiver({ ledger, cache, download: () => assert.fail('no download needed') }).receive(f.req, { task: f.task, ...f.locator });
  assert.deepEqual(received, { status: 'archived', task: f.task, result: null });
});

test('account changes or cancellation after the private write retain evidence but block delivery', async t => {
  for (const mode of ['account', 'cancelled']) {
    const f = await persistedCloudTask(t), calls = [], controller = new AbortController();
    const cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
    const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache: { ...cache, save: async (...args) => {
      const stored = await cache.save(...args);
      if (mode === 'account') f.req.user.profile.handle = 'bob'; else controller.abort();
      return stored;
    } } });
    await assert.rejects(receiver.receive(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f), signal: controller.signal,
      requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) }), { code: `comfy_cloud_receive_${mode === 'account' ? 'save' : mode}` });
    f.req.user.profile.handle = 'alice';
    const recovered = await createComfyCloudReceiver({ ledger: f.ledger, cache, download: () => assert.fail('do not regenerate or re-download retained evidence') })
      .receive(f.req, { task: f.task, ...f.locator });
    assert.equal(recovered.status, 'staged'); assert.equal(calls.length, 3);
    assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].status, 'succeeded');
  }
});

test('corrupt cache or another account cannot fall through into fresh cloud collection', async t => {
  const f = await persistedCloudTask(t), cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' }); let reads = 0;
  const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache: { ...cache, load: async () => { reads++; throw new Error('private-path-or-secret'); } },
    download: () => assert.fail('cache/authentication failures are not permission to fetch again') });
  const input = { task: f.task, ...f.locator }; f.req.user.profile.handle = 'bob';
  await assert.rejects(receiver.receive(f.req, input), { code: 'comfy_cloud_receive_authorization' }); assert.equal(reads, 0);
  f.req.user.profile.handle = 'alice';
  await assert.rejects(receiver.receive(f.req, input), error => error.code === 'comfy_cloud_receive_readback' && !error.message.includes('private-path-or-secret'));
  assert.equal(reads, 1);
});

test('waiting or expired cloud jobs retain the reserved quota and no receipt claims a completed archive', async t => {
  for (const status of ['running', 'expired']) {
    const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
    const cache = createImageServiceResults({ dataRoot: f.root, store: f.store, scope: 'comfy-cloud' });
    const receiver = createComfyCloudReceiver({ ledger: f.ledger, cache });
    const result = await receiver.receive(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f),
      requestImpl: mockNodeRequest(calls, () => ({ body: { ...readyCloudJob(f), status } })) });
    assert.deepEqual(result, { status, task: f.task, result: null }); assert.equal(calls.length, 1);
    const inventory = await cache.inventory(imageServiceAccount(f.req).namespace);
    assert.equal(inventory.totals.reservedBytes, 48 * 1024 * 1024); assert.equal(inventory.entries[0].ready, false);
    assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('a failed or cancelled second cloud image never returns a partial whole-job packet or re-submits the job', async t => {
  for (const mode of ['bytes', 'metadata', 'cancelled']) {
    const f = await persistedCloudTask(t, cloudBinding, 2), calls = [], before = await f.store.inspectChannel(f.locator.channelKey), controller = new AbortController(); let grants = 0;
    const pending = downloadComfyCloudJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f), signal: controller.signal,
      ledger: { authorizeStaging: (...args) => { grants++; return f.ledger.authorizeStaging(...args); } }, requestImpl: mockNodeRequest(calls, call => {
        const reply = multiAssetReply(f, call), second = call.url.pathname.endsWith(twoCloudIds[1]);
        if (second && call.url.pathname.includes('/assets/')) {
          if (mode === 'metadata') reply.body.size_bytes++;
          if (mode === 'cancelled') controller.abort();
        }
        if (second && call.url.hostname === 'files.test' && mode === 'bytes') reply.body = Buffer.alloc(png.length);
        return reply;
      }) });
    await assert.rejects(pending, { code: `comfy_cloud_asset_read_${mode === 'metadata' ? 'match' : mode}`, submissionState: 'accepted', upstreamId: f.task.taskId, retryable: false });
    assert.equal(grants, 1); assert.ok(calls.every(call => call.options.method === 'GET'));
    assert.equal(calls.filter(call => call.url.href === f.task.links.self).length, 1);
    assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('a waiting whole cloud job returns status only and a later revoked grant cannot authorize staging', async t => {
  const f = await persistedCloudTask(t), calls = [];
  const waiting = await downloadComfyCloudJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls,
    () => ({ body: { ...readyCloudJob(f), status: 'running' } })) });
  assert.equal(waiting.status, 'running'); assert.equal(waiting.result, null); assert.equal(waiting.grant, undefined); assert.equal(calls.length, 1);
  const received = await downloadComfyCloudJob(f.req, { task: f.task, ...f.locator }, { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) });
  await f.store.transaction(f.locator.channelKey, state => { state.entries[0].fence = 'revoked'; return { state }; });
  await assert.rejects(received.grant.verify(), { code: 'image_service_cloud_query_changed' });
});

test('one original stored grant spans job, metadata and image bytes without persisting the signed source or acknowledging the task', async t => {
  const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey); let grants = 0;
  const result = await downloadComfyCloudAsset(f.req, { ...assetReadInput(f), expected: { mime: 'image/jpeg', sizeBytes: 1 } }, { ...assetReadOptions(f),
    ledger: { authorizeQuery: (...args) => { grants++; return f.ledger.authorizeQuery(...args); } }, requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) });
  assert.equal(result.status, 'integrity_checked'); assert.equal(result.mime, 'image/png'); assert.deepEqual(result.bytes, new Uint8Array(png));
  assert.equal(result.integrity.platformVerified, null); assert.equal(result.integrity.platformHash, null);
  assert.equal(result.integrity.sizeBytes, png.length); assert.match(result.integrity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.asset.assetId, cloudOutput().id); assert.equal(grants, 1); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.method === 'GET')); assert.deepEqual(calls[2].options.headers, { Accept: 'image/*' });
  assert.doesNotMatch(JSON.stringify(result), /files\.test|temporary|apiKey/); assert.equal(result.source, undefined);
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before, 'download is not acknowledgement or a new submission');
});

test('download verifies the actual platform BLAKE3 and preserves the task when bytes disagree with valid metadata', async t => {
  for (const matching of [true, false]) {
    const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
    const hash = `blake3:${matching ? Buffer.from(blake3(png)).toString('hex') : '0'.repeat(64)}`;
    const pending = downloadComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => {
      if (call.url.hostname === 'files.test') return assetDownloadReply(f, call);
      return { body: call.url.pathname.includes('/assets/') ? { ...assetMetadataBody(f), hash }
        : { ...readyCloudJob(f), outputs: [cloudOutput(undefined, { hash })] } };
    }) });
    if (matching) {
      const result = await pending;
      assert.equal(result.status, 'integrity_checked'); assert.equal(result.integrity.platformVerified, true);
      assert.equal(result.integrity.platformHash, hash); assert.equal(`blake3:${result.integrity.blake3}`, hash);
    } else await assert.rejects(pending, { code: 'comfy_cloud_asset_read_digest', submissionState: 'accepted', upstreamId: f.task.taskId, retryable: false });
    assert.equal(calls.length, 3); assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('cancellation or account change after file EOF still blocks the digest delivery checkpoint', async t => {
  for (const cancel of [true, false]) {
    const f = await persistedCloudTask(t), calls = [], controller = new AbortController(); let afterFile = false;
    const before = await f.store.inspectChannel(f.locator.channelKey), api = mockNodeRequest(calls, call => assetDownloadReply(f, call));
    await assert.rejects(downloadComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), signal: controller.signal,
      requestImpl: (url, options, callback) => {
        if (new URL(url).hostname !== 'files.test') return api(url, options, callback);
        calls.push({ url: new URL(url), options });
        return new Writable({ final(done) {
          const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'image/png' };
          incoming.once('end', () => setImmediate(() => { afterFile = true; if (cancel) controller.abort('private-test-reason'); else f.req.user.profile.handle = 'bob'; }));
          callback(incoming); incoming.end(png); done();
        } });
      },
    }), { code: `comfy_cloud_asset_read_${cancel ? 'cancelled' : 'account'}`, submissionState: 'accepted', upstreamId: f.task.taskId });
    assert.equal(afterFile, true); assert.equal(calls.length, 3);
    assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('waiting tasks and file body mismatches cannot become downloaded or cause a generation retry', async t => {
  for (const waiting of [true, false]) {
    const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
    const pending = downloadComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => {
      if (waiting) return { body: { ...readyCloudJob(f), status: 'running' } };
      if (call.url.hostname === 'files.test') return { body: png.subarray(0, -1), headers: { 'content-type': 'image/png' } };
      return assetDownloadReply(f, call);
    }) });
    if (waiting) assert.deepEqual(await pending, { task: f.task, status: 'running', asset: null });
    else await assert.rejects(pending, { code: 'comfy_cloud_asset_read_bytes', submissionState: 'accepted', upstreamId: f.task.taskId, retryable: false });
    assert.equal(calls.length, waiting ? 1 : 3); assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('changing the original persisted fence during file arrival cannot be bypassed by acquiring a replacement grant', async t => {
  const f = await persistedCloudTask(t), calls = []; let revoked, grants = 0;
  await assert.rejects(downloadComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), ledger: {
    authorizeQuery: async (...args) => { grants++; const verify = await f.ledger.authorizeQuery(...args); return async () => { if (revoked) await revoked; return verify(); }; },
  }, requestImpl: mockNodeRequest(calls, call => {
    if (call.url.hostname === 'files.test') revoked = f.store.transaction(f.locator.channelKey, state => { state.entries[0].fence = 'changed-during-download'; return { state }; });
    return assetDownloadReply(f, call);
  }) }), { code: 'comfy_cloud_asset_read_file', submissionState: 'accepted', upstreamId: f.task.taskId });
  await revoked; assert.equal(grants, 1); assert.equal(calls.length, 3);
});

test('cancelled file target approval cannot start a late CDN request after the caller has returned', { timeout: 5000 }, async t => {
  const f = await persistedCloudTask(t), calls = [], controller = new AbortController(); let entered, release, approvals = 0;
  const entering = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const pending = downloadComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), signal: controller.signal,
    authorizeTarget: async (_req, target) => { assert.equal(target.baseUrl, `${f.task.origin}/`); if (++approvals === 3) { entered(); await held; } return async () => {}; },
    requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) });
  await entering; controller.abort();
  await assert.rejects(pending, { code: 'comfy_cloud_asset_read_cancelled', submissionState: 'accepted', upstreamId: f.task.taskId });
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2);
});

test('file body stalls share the whole operation deadline and do not clear the original queue record', async t => {
  const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey); let fileSignal;
  const api = mockNodeRequest(calls, call => assetDownloadReply(f, call));
  await assert.rejects(downloadComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), timeoutMs: 500,
    requestImpl: (url, options, callback) => {
      if (new URL(url).hostname !== 'files.test') return api(url, options, callback);
      calls.push({ url: new URL(url), options }); fileSignal = options.signal;
      return new Writable({ final(done) { const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'image/png' }; callback(incoming); done(); } });
    },
  }), { code: 'comfy_cloud_asset_read_timeout', submissionState: 'accepted', upstreamId: f.task.taskId, retryable: false });
  assert.equal(calls.length, 3); assert.equal(fileSignal.aborted, true); assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
});

test('asset reader derives its descriptor from the actual original query and never reads file bytes or mutates the ledger', async t => {
  const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
  const result = await readComfyCloudAsset(f.req, { ...assetReadInput(f), expected: { sizeBytes: 999, nodeId: 'other' } }, { ...assetReadOptions(f),
    requestImpl: mockNodeRequest(calls, call => ({ body: call.url.pathname.includes('/assets/') ? assetMetadataBody(f) : readyCloudJob(f) })),
  });
  assert.equal(result.status, 'metadata_ready'); assert.equal(result.asset.sizeBytes, png.length); assert.equal(result.asset.nodeId, 'save');
  assert.equal(calls.length, 2); assert.equal(calls[0].url.href, f.task.links.self);
  assert.equal(calls[1].url.href, `${cloudBinding.origin}/api/v2/assets/${cloudOutput().id}`);
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.headers.authorization === 'Bearer test-only-secret'));
  assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before); assert.doesNotMatch(JSON.stringify(before), /temporary|files.test/);
});

test('waiting jobs and assets absent from the original output cannot cause an asset metadata request', async t => {
  for (const waiting of [true, false]) {
    const f = await persistedCloudTask(t), calls = [];
    const promise = readComfyCloudAsset(f.req, { ...assetReadInput(f), assetId: '00000000-0000-4000-8000-000000000099' }, { ...assetReadOptions(f),
      requestImpl: mockNodeRequest(calls, () => ({ body: { ...readyCloudJob(f), status: waiting ? 'running' : 'succeeded' } })),
    });
    if (waiting) assert.equal((await promise).asset, null);
    else await assert.rejects(promise, { code: 'comfy_cloud_asset_read_asset', submissionState: 'accepted' });
    assert.equal(calls.length, 1);
  }
});

test('metadata mismatch or expiry preserves the original record and does not request the returned file URL', async t => {
  for (const wrong of [true, false]) {
    const f = await persistedCloudTask(t), calls = [], before = await f.store.inspectChannel(f.locator.channelKey);
    await assert.rejects(readComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), requestImpl: mockNodeRequest(calls, call => ({ body: call.url.pathname.includes('/assets/')
      ? { ...assetMetadataBody(f), ...(wrong ? { size_bytes: 999 } : { url_expires_at: '2000-01-01T00:00:00Z' }) } : readyCloudJob(f) })) }),
    error => error.code === 'comfy_cloud_asset_read_match' && error.submissionState === 'accepted' && !error.message.includes('temporary'));
    assert.equal(calls.length, 2); assert.deepEqual(await f.store.inspectChannel(f.locator.channelKey), before);
  }
});

test('one original fence spans job query and metadata, including revocation after the metadata arrives', async t => {
  const f = await persistedCloudTask(t), calls = []; let revoked, grants = 0;
  await assert.rejects(readComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), ledger: {
    authorizeQuery: async (...args) => { grants++; const verify = await f.ledger.authorizeQuery(...args); return async () => { if (revoked) await revoked; return verify(); }; },
  }, requestImpl: mockNodeRequest(calls, call => {
    if (!call.url.pathname.includes('/assets/')) return { body: readyCloudJob(f) };
    revoked = f.store.transaction(f.locator.channelKey, state => { state.entries[0].fence = 'revoked'; return { state }; });
    return { body: assetMetadataBody(f) };
  }) }), { code: 'comfy_cloud_asset_read_delivery', submissionState: 'accepted', upstreamId: f.task.taskId });
  await revoked; assert.equal(grants, 1); assert.equal(calls.length, 2);
});

test('asset metadata deadline and pre-cancellation prevent late authority from starting any network read', async t => {
  const f = await persistedCloudTask(t), calls = []; let release, grants = 0;
  const grant = new Promise(resolve => { release = resolve; }), controller = new AbortController(); controller.abort();
  const options = { ...assetReadOptions(f), timeoutMs: 15, ledger: { authorizeQuery: () => { grants++; return grant; } }, requestImpl: mockNodeRequest(calls) };
  await assert.rejects(readComfyCloudAsset(f.req, assetReadInput(f), { ...options, signal: controller.signal }), { code: 'comfy_cloud_asset_read_cancelled' });
  assert.equal(grants, 0);
  await assert.rejects(readComfyCloudAsset(f.req, assetReadInput(f), options), { code: 'comfy_cloud_asset_read_timeout' });
  release(async () => {}); await new Promise(resolve => setImmediate(resolve)); assert.equal(grants, 1); assert.equal(calls.length, 0);
});

test('metadata response stalls and mid-read account changes cannot outlive the bounded original read', async t => {
  for (const changeAccount of [false, true]) {
    const f = await persistedCloudTask(t), calls = []; let metadataSignal;
    const jobRequest = mockNodeRequest(calls, () => ({ body: readyCloudJob(f) }));
    await assert.rejects(readComfyCloudAsset(f.req, assetReadInput(f), { ...assetReadOptions(f), timeoutMs: 300,
      requestImpl: (url, options, callback) => {
        if (!new URL(url).pathname.includes('/assets/')) return jobRequest(url, options, callback);
        calls.push({ url: new URL(url), options }); metadataSignal = options.signal;
        return new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
          const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' };
          if (changeAccount) f.req.user.profile.handle = 'bob';
          callback(incoming); if (changeAccount) incoming.end(JSON.stringify(assetMetadataBody(f))); done();
        } });
      },
    }), error => error.submissionState === 'accepted' && error.upstreamId === f.task.taskId
      && error.code === (changeAccount ? 'comfy_cloud_asset_read_metadata' : 'comfy_cloud_asset_read_timeout'));
    assert.equal(calls.length, 2); assert.equal(metadataSignal.aborted, true);
    assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].status, 'uncertain');
  }
});

test('real stored ownership and network target grants both precede cloud DNS or requests', async t => {
  const f = await persistedCloudTask(t); let resolutions = 0; const calls = [];
  for (const variation of [
    { req: { user: { profile: { handle: 'bob', enabled: true } } }, options: {} },
    { req: f.req, options: { authorizeTarget: undefined } },
    { req: f.req, options: { authorizeTask: (req, task) => f.ledger.authorizeQuery(req, { ...f.locator, apiKey: 'another-key' }, task) } },
  ]) {
    await assert.rejects(queryComfyCloudTask(variation.req, f.task, { ...f.options, ...variation.options,
      resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls) }),
    error => error.submissionState === 'accepted' && error.upstreamId === f.task.taskId && error.code.startsWith('comfy_cloud_query_'));
  }
  assert.equal(resolutions, 0); assert.equal(calls.length, 0);
  assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].status, 'uncertain');
});

test('revoking a real stored cloud fence during response prevents delivery without any resubmission', async t => {
  const f = await persistedCloudTask(t), calls = []; let revoked;
  await assert.rejects(queryComfyCloudTask(f.req, f.task, { ...f.options,
    authorizeTask: async (req, original) => {
      const verify = await f.ledger.authorizeQuery(req, f.locator, original);
      return async () => { if (revoked) await revoked; await verify(); };
    },
    requestImpl: mockNodeRequest(calls, () => {
      revoked = f.store.transaction(f.locator.channelKey, state => { state.entries[0].fence = 'revoked'; return { state }; });
      return { body: { id: f.task.taskId, status: 'succeeded', urls: f.task.links } };
    }),
  }), error => error.submissionState === 'accepted' && error.upstreamId === f.task.taskId && error.code.startsWith('comfy_cloud_query_'));
  await revoked; assert.equal(calls.length, 1);
  const row = (await f.store.inspectChannel(f.locator.channelKey)).entries[0];
  assert.equal(row.fence, 'revoked'); assert.equal(row.status, 'uncertain'); assert.equal(row.upstreamId, f.task.taskId);
});

test('real cloud ledger becoming unavailable after response never delivers an unverified result', async t => {
  const f = await persistedCloudTask(t), calls = []; let closing;
  await assert.rejects(queryComfyCloudTask(f.req, f.task, { ...f.options,
    authorizeTask: async (req, original) => {
      const verify = await f.ledger.authorizeQuery(req, f.locator, original);
      return async () => { if (closing) await closing; await verify(); };
    },
    requestImpl: mockNodeRequest(calls, () => {
      closing = f.store.close(); return { body: { id: f.task.taskId, status: 'succeeded', urls: f.task.links } };
    }),
  }), error => error.submissionState === 'accepted' && error.upstreamId === f.task.taskId && error.code.startsWith('comfy_cloud_query_'));
  await closing; assert.equal(calls.length, 1);
});

test('cloud query runner performs only the original task read through real authorization and response projection', async () => {
  const calls = [], task = bindComfyCloudTask(rhBinding, '1904152026220003329'); let ownershipChecks = 0;
  const result = await queryComfyCloudTask(account(), task, { apiKey: 'test-only-secret', authorizeTask: async (_req, original, owner) => {
    assert.deepEqual(original, task); assert.match(owner.namespace, /^st-user:/); return async () => { ownershipChecks++; };
  }, authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest(calls, () => ({ body: { taskId: task.taskId, status: 'SUCCESS', errorCode: '', usage: { ignored: true } } })) });
  assert.equal(result.status, 'succeeded'); assert.equal(calls.length, 1); assert.equal(calls[0].url.pathname, '/openapi/v2/query');
  assert.deepEqual(JSON.parse(calls[0].body), { taskId: task.taskId }); assert.ok(ownershipChecks >= 3);
  assert.deepEqual(Object.keys(result), ['task', 'status', 'terminal']); assert.equal(JSON.stringify(result).includes('test-only-secret'), false);
});

test('cloud query runner cannot use missing ownership grants or keys to reach DNS', async () => {
  const task = bindComfyCloudTask(rhBinding, '1904152026220003329');
  const options = { apiKey: 'test-only-secret', authorizeTarget: cloudGrant, resolveHost: () => assert.fail('no DNS') };
  await assert.rejects(queryComfyCloudTask(account(), task, options), { code: 'comfy_cloud_query_authorization', submissionState: 'accepted' });
  await assert.rejects(queryComfyCloudTask(account(), task, { ...options, authorizeTask: async () => {} }), { code: 'comfy_cloud_query_authorization' });
  await assert.rejects(queryComfyCloudTask(account(), task, { ...options, apiKey: 'bad\nkey', authorizeTask: cloudGrant }), { code: 'comfy_cloud_query_key' });
});

test('Cloud v2 query runner follows the original mounted GET link and sends no RH body', async () => {
  const calls = [], binding = bindComfyCloudProtocol('https://dep-one.run.comfy.app', 'comfy-cloud-v2');
  const urls = { self: '/deployment/dep-one/api/v2/jobs/original', cancel: '/deployment/dep-one/api/v2/jobs/original/cancel' };
  const task = bindComfyCloudTask(binding, 'original', urls);
  const result = await queryComfyCloudTask(account(), task, { apiKey: 'test-only-secret', authorizeTask: cloudGrant, authorizeTarget: cloudGrant,
    resolveHost: publicDns, requestImpl: mockNodeRequest(calls, () => ({ body: { id: 'original', status: 'running', urls } })),
  });
  assert.equal(result.status, 'running'); assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].url.pathname, urls.self); assert.equal(calls[0].body.length, 0);
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-only-secret');
});

test('query deadline includes a response body that stalls after headers and tears down its stream', async () => {
  const task = bindComfyCloudTask(rhBinding, '1904152026220003329'); let incoming, calls = 0;
  await assert.rejects(queryComfyCloudTask(account(), task, { apiKey: 'test-only-secret', timeoutMs: 30,
    authorizeTask: cloudGrant, authorizeTarget: cloudGrant, resolveHost: publicDns,
    requestImpl: (_url, options, callback) => {
      calls++;
      return new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
        incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'application/json' };
        options.signal.addEventListener('abort', () => incoming.destroy(), { once: true });
        callback(incoming); incoming.write('{"taskId":'); done();
      } });
    },
  }), { code: 'comfy_cloud_query_timeout', submissionState: 'accepted', upstreamId: task.taskId });
  assert.equal(calls, 1); assert.equal(incoming.destroyed, true);
});

test('query deadline covers a stalled ownership grant and prevents late DNS after the caller has timed out', async () => {
  const task = bindComfyCloudTask(rhBinding, '1904152026220003329'); let release;
  const granted = new Promise(resolve => { release = resolve; });
  const result = queryComfyCloudTask(account(), task, { apiKey: 'test-only-secret', timeoutMs: 5,
    authorizeTask: () => granted, authorizeTarget: cloudGrant, resolveHost: () => assert.fail('late DNS') });
  await assert.rejects(result, { code: 'comfy_cloud_query_timeout', submissionState: 'accepted', upstreamId: task.taskId });
  release(async () => {}); await new Promise(resolve => setImmediate(resolve));
});

test('query deadline and external cancellation abort header waits without creating another request', async () => {
  const task = bindComfyCloudTask(rhBinding, '1904152026220003329');
  for (const cancel of [false, true]) {
    const controller = new AbortController(); let calls = 0, socketSignal;
    const result = queryComfyCloudTask(account(), task, { apiKey: 'test-only-secret', timeoutMs: cancel ? 1000 : 5, signal: controller.signal,
      authorizeTask: cloudGrant, authorizeTarget: cloudGrant, resolveHost: publicDns,
      requestImpl: (_url, options) => { calls++; socketSignal = options.signal; if (cancel) queueMicrotask(() => controller.abort());
        const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
        options.signal.addEventListener('abort', () => output.destroy(Error('test-only-secret')), { once: true }); return output;
      },
    });
    await assert.rejects(result, { code: cancel ? 'comfy_cloud_query_cancelled' : 'comfy_cloud_query_timeout', submissionState: 'accepted', upstreamId: task.taskId });
    assert.equal(calls, 1); assert.equal(socketSignal.aborted, true);
  }
});

test('task ownership or ST account revocation during a returned response blocks delivery', async () => {
  const task = bindComfyCloudTask(rhBinding, '1904152026220003329');
  for (const changeAccount of [true, false]) {
    const req = account(); let permitted = true;
    await assert.rejects(queryComfyCloudTask(req, task, { apiKey: 'test-only-secret',
      authorizeTask: async () => async () => { if (!permitted) throw Error('test-only-secret'); }, authorizeTarget: cloudGrant, resolveHost: publicDns,
      requestImpl: mockNodeRequest([], () => { if (changeAccount) req.user.profile.handle = 'bob'; else permitted = false;
        return { body: { taskId: task.taskId, status: 'SUCCESS', errorCode: '' } }; }),
    }), error => error.submissionState === 'accepted' && error.upstreamId === task.taskId && !error.message.includes('test-only-secret'));
  }
});

const fileInput = () => ({ task: bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' }),
  assetId: '00000000-0000-4000-8000-000000000001', source: { url: 'https://cdn.example.test/original.png?sig=private-test-signature', expiresAt: 2000 } });
const fileOptions = calls => ({ now: () => 1000, authorizeAsset: cloudGrant, authorizeTarget: cloudGrant, resolveHost: publicDns,
  requestImpl: mockNodeRequest(calls, () => ({ body: png, headers: { 'content-type': 'image/png' } })) });

test('cloud file download pins the exact signed source and never forwards keys or cookies', async () => {
  const calls = [], req = account(), input = fileInput(); let grants = 0;
  const transport = await createComfyCloudFileTransport(req, input, { ...fileOptions(calls), authorizeAsset: async (_req, resource, owner) => {
    assert.deepEqual(resource, input); assert.equal(owner.namespace, imageServiceAccount(req).namespace);
    assert.ok(Object.isFrozen(resource.source)); return async () => { grants++; };
  } });
  const response = await transport.fetchImpl(input.source.url, { method: 'GET', headers: { Authorization: 'private-api-key', Cookie: 'private-cookie' }, credentials: 'include' });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png); await transport.verify();
  assert.equal(calls.length, 1); assert.equal(calls[0].url.href, input.source.url);
  assert.deepEqual(calls[0].options.headers, { Accept: 'image/*' }); assert.equal(calls[0].body.length, 0); assert.equal(calls[0].options.agent, false);
  assert.ok(grants >= 4);
  for (const init of [{ method: 'POST' }, { method: 'GET', body: 'x' }, { method: 'GET', redirect: 'follow' }]) await assert.rejects(transport.fetchImpl(input.source.url, init), { code: 'comfy_transport_file_target', submissionState: 'accepted', upstreamId: 'original', retryable: false });
  await assert.rejects(transport.fetchImpl('https://cdn.example.test/other.png', { method: 'GET' }), { code: 'comfy_transport_file_target' });
  assert.equal(calls.length, 1);
});

test('file authority, expiry and safe address rules run before any image request', async () => {
  const calls = []; let dns = 0;
  const options = { ...fileOptions(calls), resolveHost: async () => { dns++; return publicDns(); } };
  await assert.rejects(createComfyCloudFileTransport({}, fileInput(), options), { status: 401 });
  for (const override of [{ authorizeAsset: undefined }, { authorizeAsset: async () => null }, { authorizeTarget: undefined }, { now: () => 2000 }]) await assert.rejects(createComfyCloudFileTransport(account(), fileInput(), { ...options, ...override }));
  assert.equal(dns, 0);
  for (const address of ['127.0.0.1', '0:0:0:0:0:0:0:1']) await assert.rejects(createComfyCloudFileTransport(account(true), fileInput(), { ...options, resolveHost: async () => [{ address }] }));
  const input = fileInput(); input.source.url += 'x'.repeat(4096);
  await assert.rejects(createComfyCloudFileTransport(account(), input, options), { code: 'comfy_transport_file_source' });
  assert.equal(calls.length, 0);
});

test('file transport snapshots its source and refuses expiry or revoked original ownership on reuse', async () => {
  const calls = [], input = fileInput(); let time = 1000, revoked = false;
  const transport = await createComfyCloudFileTransport(account(), input, { ...fileOptions(calls), now: () => time,
    authorizeAsset: async () => async () => { if (revoked) throw new Error('private-test-signature'); } });
  input.source.expiresAt = 9999; time = 2000;
  await assert.rejects(transport.fetchImpl(input.source.url, { method: 'GET' }), { code: 'comfy_transport_file_expired' });
  time = 1000; revoked = true;
  await assert.rejects(transport.fetchImpl(input.source.url, { method: 'GET' }), error => error.submissionState === 'accepted' && error.upstreamId === 'original' && !error.message.includes('private-test-signature'));
  assert.equal(calls.length, 0);
});

test('file expiry during DNS and cancellation before dispatch stop the download, and final byte delivery must recheck the grant', async () => {
  const calls = [], input = fileInput(); let time = 1000;
  await assert.rejects(createComfyCloudFileTransport(account(), input, { ...fileOptions(calls), now: () => time,
    resolveHost: async () => { time = 2000; return publicDns(); } }), { code: 'comfy_transport_file_expired' });
  const controller = new AbortController();
  const cancelled = await createComfyCloudFileTransport(account(), input, { ...fileOptions(calls), signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled.fetchImpl(input.source.url, { method: 'GET' }), { submissionState: 'accepted', upstreamId: 'original' });
  assert.equal(calls.length, 0);
  const req = account(), transport = await createComfyCloudFileTransport(req, input, fileOptions(calls));
  const response = await transport.fetchImpl(input.source.url, { method: 'GET' });
  await response.arrayBuffer(); req.user.profile.handle = 'bob';
  await assert.rejects(transport.verify(), { code: 'comfy_transport_account_changed', upstreamId: 'original' });
  assert.equal(calls.length, 1, 'byte receipt is not permission to store under another account');
});

test('account changes, expired delivery and redirects cannot deliver an original cloud file', async () => {
  for (const kind of ['account', 'expiry', 'redirect']) {
    const calls = [], req = account(), input = fileInput(); let time = 1000;
    const transport = await createComfyCloudFileTransport(req, input, { ...fileOptions(calls), now: () => time, requestImpl: mockNodeRequest(calls, () => {
      if (kind === 'account') req.user.profile.handle = 'bob';
      if (kind === 'expiry') time = 2000;
      return { status: kind === 'redirect' ? 302 : 200, body: png, headers: { 'content-type': 'image/png', location: 'https://other.test/image.png' } };
    }) });
    await assert.rejects(transport.fetchImpl(input.source.url, { method: 'GET' }), error => error.submissionState === 'accepted' && error.upstreamId === 'original' && !error.message.includes('private-test-signature'));
    assert.equal(calls.length, 1);
  }
});

test('asset transport requires original asset and target grants before DNS, even for an administrator', async () => {
  const task = bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const assetId = '00000000-0000-4000-8000-000000000001'; let resolutions = 0; const calls = [];
  const options = { authorizeAsset: cloudGrant, authorizeTarget: cloudGrant, resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls) };
  await assert.rejects(createComfyCloudAssetTransport({}, { task, assetId }, options), { code: 'comfy_transport_authentication_required', status: 401, submissionState: 'accepted', upstreamId: 'original' });
  for (const overrides of [{ authorizeAsset: undefined }, { authorizeTarget: undefined }, { authorizeAsset: async () => {} },
    { authorizeAsset: async () => { throw Error('private-test-secret'); } }]) {
    await assert.rejects(createComfyCloudAssetTransport(account(true), { task, assetId }, { ...options, ...overrides }), error => error.submissionState === 'accepted' && error.upstreamId === 'original' && !error.message.includes('private-test-secret'));
  }
  assert.equal(resolutions, 0); assert.equal(calls.length, 0);
});

test('asset transport pins one metadata GET and refuses content, other assets, writes, credentials forwarding and redirects', async () => {
  const task = bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const assetId = '00000000-0000-4000-8000-000000000001', calls = []; let grants = 0;
  const transport = await createComfyCloudAssetTransport(account(), { task, assetId }, {
    authorizeAsset: async (req, resource, owner) => { assert.deepEqual(resource, { task, assetId }); assert.equal(owner.namespace, imageServiceAccount(req).namespace); return async () => { grants++; }; },
    authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest(calls, () => ({ body: { id: assetId } })),
  });
  const url = `${cloudBinding.origin}/api/v2/assets/${assetId}`;
  const result = await transport.fetchImpl(url, { headers: { Authorization: 'Bearer test-only-secret', Accept: 'application/json' } });
  assert.deepEqual(await result.json(), { id: assetId }); await transport.verify(); assert.ok(grants > 1);
  for (const [target, init] of [[`${url}/content`, {}], [url.replace(/1$/, '2'), {}], [url, { method: 'DELETE' }],
    [url, { method: 'POST', body: '{}' }], [url, { headers: { Cookie: 'secret' } }], [url, { body: '{}' }]]) await assert.rejects(transport.fetchImpl(target, init));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.authorization, 'Bearer test-only-secret');
  calls[0].options.lookup('cloud.comfy.org', {}, (error, ip) => { assert.equal(error, null); assert.equal(ip, '8.8.8.8'); });
  const redirect = await createComfyCloudAssetTransport(account(), { task, assetId }, { authorizeAsset: cloudGrant, authorizeTarget: cloudGrant, resolveHost: publicDns,
    requestImpl: mockNodeRequest([], () => ({ status: 302, headers: { location: 'https://files.test/a?private-test-secret' } })) });
  await assert.rejects(redirect.fetchImpl(url), { code: 'comfy_transport_redirect', submissionState: 'accepted', upstreamId: 'original' });
});

test('revoked asset permission blocks prepared reads and returned response delivery without a new request', async () => {
  const task = bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const assetId = '00000000-0000-4000-8000-000000000001', calls = []; let permitted = true;
  const transport = await createComfyCloudAssetTransport(account(), { task, assetId }, {
    authorizeAsset: async () => async () => { if (!permitted) throw Error('private-test-secret'); }, authorizeTarget: cloudGrant, resolveHost: publicDns,
    requestImpl: mockNodeRequest(calls, () => { permitted = false; return { body: { id: assetId } }; }),
  });
  permitted = false; await assert.rejects(transport.fetchImpl(transport.plan.url)); assert.equal(calls.length, 0);
  permitted = true; const response = await transport.fetchImpl(transport.plan.url); await response.json();
  await assert.rejects(transport.verify(), error => error.submissionState === 'accepted' && error.upstreamId === 'original' && !error.message.includes('private-test-secret'));
  assert.equal(calls.length, 1);
});

test('account changes during asset grant or private DNS results cannot open metadata connections', async () => {
  const task = bindComfyCloudTask(cloudBinding, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const assetId = '00000000-0000-4000-8000-000000000001', req = account(), calls = []; let resolutions = 0;
  await assert.rejects(createComfyCloudAssetTransport(req, { task, assetId }, {
    authorizeAsset: async () => { req.user.profile.handle = 'bob'; return async () => {}; }, authorizeTarget: cloudGrant,
    resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls),
  }), { code: 'comfy_transport_account_changed' });
  assert.equal(resolutions, 0);
  await assert.rejects(createComfyCloudAssetTransport(account(true), { task, assetId }, { authorizeAsset: cloudGrant, authorizeTarget: cloudGrant,
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], requestImpl: mockNodeRequest(calls) }));
  assert.equal(calls.length, 0);
});

test('cloud transport requires a logged-in account and a recheckable grant before any DNS/network', async () => {
  const request = { binding: cloudBinding, operation: 'submit' }, denied = { resolveHost: () => assert.fail('no DNS'), requestImpl: () => assert.fail('no request') };
  await assert.rejects(createComfyCloudServerTransport({}, request, { ...denied, authorizeTarget: cloudGrant }), { code: 'comfy_transport_authentication_required', submissionState: 'not_submitted' });
  await assert.rejects(createComfyCloudServerTransport(account(), request, denied), { code: 'comfy_transport_cloud_authorization' });
  await assert.rejects(createComfyCloudServerTransport(account(), request, { ...denied, authorizeTarget: async () => {} }), { code: 'comfy_transport_cloud_authorization' });
});

test('cloud read POST is pinned to the original RH task and cannot submit or forward cookies', async () => {
  const task = bindComfyCloudTask(rhBinding, '1904152026220003329'), calls = []; let resolutions = 0;
  const transport = await createComfyCloudServerTransport(account(), { binding: rhBinding, operation: 'query', task }, {
    authorizeTarget: cloudGrant, resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls),
  });
  const init = { method: 'POST', headers: { Authorization: 'Bearer test-only-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.taskId }) };
  const result = await transport.fetchImpl(transport.plan.url, init); await result.text();
  assert.equal(transport.plan.effect, 'read'); assert.equal(transport.plan.createsJob, false); assert.equal(resolutions, 1); assert.equal(calls.length, 1);
  const ip = await new Promise((resolve, reject) => calls[0].options.lookup('www.runninghub.cn', {}, (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(ip, '8.8.8.8'); assert.equal(calls[0].options.headers.authorization, 'Bearer test-only-secret');
  for (const [url, override] of [[`${rhBinding.origin}/task/openapi/create`, {}], [transport.plan.url, { body: JSON.stringify({ taskId: 'other' }) }],
    [transport.plan.url, { body: JSON.stringify({ taskId: task.taskId, workflowId: 'another' }) }], [transport.plan.url, { headers: { Cookie: 'secret' } }]]) {
    await assert.rejects(transport.fetchImpl(url, { ...init, ...override }), error => error.submissionState === 'accepted' && error.upstreamId === task.taskId);
  }
  assert.equal(calls.length, 1);
});

test('cloud submission refuses redirects and cannot dispatch again after an uncertain first request', async () => {
  const calls = [], transport = await createComfyCloudServerTransport(account(), { binding: cloudBinding, operation: 'submit' }, {
    authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest(calls, () => ({ status: 302, headers: { location: 'https://else.test' } })),
  });
  const init = { method: 'POST', headers: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000000' }, body: '{}' };
  await assert.rejects(transport.fetchImpl(transport.plan.url, init), { code: 'comfy_transport_redirect', submissionState: 'unknown' });
  await assert.rejects(transport.fetchImpl(transport.plan.url, init), { code: 'comfy_transport_cloud_replay', submissionState: 'unknown' });
  assert.equal(calls.length, 1);
});

test('concurrent cloud submit calls cannot both cross the final dispatch fence', async () => {
  const calls = [], transport = await createComfyCloudServerTransport(account(), { binding: cloudBinding, operation: 'submit' }, {
    authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: mockNodeRequest(calls),
  });
  const results = await Promise.allSettled([1, 2].map(() => transport.fetchImpl(transport.plan.url, { method: 'POST', body: '{}' })));
  assert.equal(calls.length, 1); assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const rejected = results.find(row => row.status === 'rejected').reason;
  assert.equal(rejected.code, 'comfy_transport_cloud_replay'); assert.equal(rejected.submissionState, 'unknown');
  await results.find(row => row.status === 'fulfilled').value.text();
});

test('cloud task recovery preserves accepted identity when account changes after preparation', async () => {
  const req = account(), task = bindComfyCloudTask(rhBinding, '1904152026220003329');
  const transport = await createComfyCloudServerTransport(req, { binding: rhBinding, operation: 'query', task }, {
    authorizeTarget: cloudGrant, resolveHost: publicDns, requestImpl: () => assert.fail('no request after account change'),
  });
  req.user.profile.handle = 'bob';
  assert.throws(() => transport.assertCurrent(), { submissionState: 'accepted', upstreamId: task.taskId });
  await assert.rejects(transport.verify(), { submissionState: 'accepted', upstreamId: task.taskId });
  await assert.rejects(transport.fetchImpl(transport.plan.url, { method: 'POST', body: JSON.stringify({ taskId: task.taskId }) }), { submissionState: 'accepted', upstreamId: task.taskId });
});

test('grant revocation, private DNS and identity changes cannot use a prepared cloud request', async () => {
  const calls = [], req = account(); let granted = true;
  const transport = await createComfyCloudServerTransport(req, { binding: cloudBinding, operation: 'submit' }, {
    authorizeTarget: async () => async () => { if (!granted) throw Error('revoked secret details'); }, resolveHost: publicDns, requestImpl: mockNodeRequest(calls),
  });
  granted = false;
  await assert.rejects(transport.fetchImpl(transport.plan.url, { method: 'POST' }), { code: 'comfy_transport_cloud_unavailable', submissionState: 'not_submitted' });
  granted = true; req.user.profile.handle = 'bob';
  await assert.rejects(transport.fetchImpl(transport.plan.url, { method: 'POST' }), { code: 'comfy_transport_account_changed', submissionState: 'not_submitted' });
  assert.equal(calls.length, 0);
  await assert.rejects(createComfyCloudServerTransport(account(true), { binding: cloudBinding, operation: 'submit' }, {
    authorizeTarget: cloudGrant, resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], requestImpl: () => assert.fail('private connection'),
  }));
});

test('native transport does not inherit cloud paths, idempotency headers or arbitrary operation capabilities', async () => {
  const calls = [], transport = await createComfyServerTransport(account(), { baseUrl: cloudBinding.origin }, {
    operation: 'generate', resolveHost: publicDns, requestImpl: mockNodeRequest(calls),
  });
  await assert.rejects(transport.fetchImpl(`${cloudBinding.origin}/api/v2/jobs`, { method: 'POST' }), { code: 'comfy_transport_target_changed' });
  await assert.rejects(transport.fetchImpl(`${cloudBinding.origin}/prompt`, { method: 'POST', headers: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000000' } }), { code: 'comfy_transport_headers' });
  assert.equal(calls.length, 0);
});
async function routes(options = {}) {
  const handlers = new Map();
  const dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'qianmu-comfy-routes-')); roots.push(dataRoot);
  const comfyTargetStore = { read: async () => ({ schemaVersion: 1, revision: 1, targets: [
    ['https://comfy.test/api', false], ['http://127.0.0.1:8188', true],
  ].map(([baseUrl, allowPrivateNetwork]) => ({ id: comfyTargetId(baseUrl, allowPrivateNetwork), baseUrl, allowPrivateNetwork, shared: !allowPrivateNetwork, name: 'Approved fixture', grantId: '00000000-0000-4000-8000-000000000000', updatedAt: 0 })) }) };
  await init({ get: (path, handler) => handlers.set(`GET ${path}`, handler), post: (path, handler) => handlers.set(`POST ${path}`, handler) }, { dataRoot, comfyTransportOptions: options, comfyTargetStore });
  return handlers;
}

test('installed cloud recovery endpoints advertise only implemented operations and require account identity before storage or DNS', async () => {
  const handlers = await routes({ resolveHost: () => assert.fail('recovery capabilities do not use DNS'), requestImpl: () => assert.fail('no paid work') });
  for (const route of ['GET /image/comfy/cloud/capabilities', ...['submit', 'query', 'result', 'acknowledge', 'catalog'].map(action => `POST /image/comfy/cloud/tasks/${action}`)]) {
    const res = response(); await handlers.get(route)({ body: {} }, res);
    assert.equal(res.statusCode, 401); assert.equal(res.headers['cache-control'], 'no-store');
  }
  const res = response(); await handlers.get('GET /image/comfy/cloud/capabilities')(account(), res);
  assert.equal(res.body.submission, true); assert.equal(res.body.scope,'cloud-manual-text'); assert.deepEqual(res.body.submissionProviders,['comfy-cloud','runninghub']); assert.equal(res.body.cancellation, false); assert.equal(res.body.referenceUpload, false);
  assert.deepEqual(res.body.resultProviders, ['comfy-cloud', 'runninghub']); assert.equal(res.body.archiveConfirmation, true);
  assert.equal(handlers.has('POST /image/comfy/cloud/tasks/submit'), true, 'manual text generation has one guarded route; unsupported providers remain closed');
});

test('installed single-submit route preserves original receipts, refuses duplicate POST execution and binds account before dispatch', async t => {
  const f = await cloudSubmissionFixture(t), handlers = new Map(), calls = [];
  await init({ get: (key, handler) => handlers.set(`GET ${key}`, handler), post: (key, handler) => handlers.set(`POST ${key}`, handler) }, {
    dataRoot: f.root, comfyCloudTaskOptions: { store: f.store },
    comfyTargetStore: { read: async () => assert.fail('official cloud must not require native administrator enrollment') },
    comfyTransportOptions: { resolveHost: publicDns, requestImpl: mockNodeRequest(calls, () => ({body:acceptedCloudBody(cloudBinding,'route-original')})) },
  });
  const submit = handlers.get('POST /image/comfy/cloud/tasks/submit'), body = {...f.input, version:1};
  for(const changed of [
    {...body,automatic:true},
    {...body,request:{...body.request,execution:{...body.request.execution,automatic:true}}},
    {...body,request:{...body.request,connection:bindComfyCloudProtocol('https://sample.run.comfy.app','comfy-cloud-v2')}},
  ]){
    const denied=response();await submit({...f.req,body:changed},denied);
    assert.equal(denied.statusCode,400);assert.equal(denied.body.submissionState,'not_submitted');assert.equal(denied.body.code,'comfy_cloud_submission_scope');
    assert.equal(calls.length,0,'out-of-scope generation must stop before any provider request or ledger admission');
  }
  const wrong = response();await submit({...f.req,body:{...body,expectedAccount:'st-user:wrong'}},wrong);
  assert.equal(wrong.statusCode,401);assert.equal(wrong.body.submissionState,'not_submitted');assert.equal(calls.length,0);
  const accepted = response();await submit({...f.req,body},accepted);
  assert.equal(accepted.statusCode,200);assert.equal(accepted.headers['cache-control'],'no-store');
  assert.equal(accepted.body.task.taskId,'route-original');assert.equal(accepted.body.locator.attemptId,body.attemptId);
  assert.doesNotMatch(JSON.stringify(accepted.body),/test-only-secret|quiet rain|requestDigest/);
  const duplicate = response();await submit({...f.req,body},duplicate);assert.equal(duplicate.body.ok,false);assert.equal(calls.length,1);
  assert.equal((await f.store.inspectChannel(f.key)).entries[0].cloudReceipt.task.taskId,'route-original');
});

test('installed cloud routes deliver saved originals and complete ACK without leaking internal grants or downloading twice', async t => {
  const { f, cache, received } = await stagedBeforeSettlement(t), handlers = new Map();
  await init({ get: (key, handler) => handlers.set(`GET ${key}`, handler), post: (key, handler) => handlers.set(`POST ${key}`, handler) }, {
    dataRoot: f.root, comfyCloudTaskOptions: { store: f.store, cache },
    comfyTransportOptions: { requestImpl: () => assert.fail('cached recovery cannot contact a provider') },
  });
  const input = { version: 1, expectedAccount: received.grant.identity.namespace, task: f.task, ...f.locator };
  const loaded = response(); await handlers.get('POST /image/comfy/cloud/tasks/result')({ ...f.req, body: input }, loaded);
  assert.equal(loaded.statusCode, 200); assert.equal(loaded.body.status, 'ready');
  assert.deepEqual(Buffer.from(loaded.body.images[0].data, 'base64'), png);
  assert.doesNotMatch(JSON.stringify(loaded.body), /grant|fence|requestDigest|test-only-secret|files\.test/);
  const done = response(); await handlers.get('POST /image/comfy/cloud/tasks/acknowledge')({ ...f.req,
    body: { ...input, apiKey: undefined, archived: true, receipt: loaded.body.receipt } }, done);
  assert.equal(done.body.cleanup, 'complete'); assert.equal(await cache.load(received.grant.identity), null);
  const again = response(); await handlers.get('POST /image/comfy/cloud/tasks/result')({ ...f.req, body: input }, again);
  assert.equal(again.body.status, 'archived'); assert.equal(again.body.result, null);
  const catalog = response(); await handlers.get('POST /image/comfy/cloud/tasks/catalog')({ ...f.req, body: input }, catalog);
  assert.equal(catalog.body.totals.imageBytes, 0); assert.equal(catalog.body.tasks[0].archiveState, 'archived');
});

test('installed RH route submits a fixed graph once with its explicit tier and collects the same original before keyless ACK',async t=>{
  const f=await cloudSubmissionFixture(t,rhBinding),handlers=new Map(),calls=[],task=bindComfyCloudTask(rhBinding,'1904152026220003329');
  const usage={consumeCoins:'1.25000',consumeMoney:'0',thirdPartyConsumeMoney:null,taskCostTime:'35'};
  await init({get:(key,handler)=>handlers.set(`GET ${key}`,handler),post:(key,handler)=>handlers.set(`POST ${key}`,handler)},{
    dataRoot:f.root,comfyCloudTaskOptions:{store:f.store},
    comfyTransportOptions:{resolveHost:publicDns,requestImpl:mockNodeRequest(calls,call=>call.url.pathname==='/task/openapi/create'
      ? {body:acceptedCloudBody(rhBinding,task.taskId)}:rhDownloadReply({task,usage},call,1))},
  });
  const body={...f.input,version:1,request:{...f.input.request,runninghub:{instanceType:'plus'}}};
  const accepted=response();await handlers.get('POST /image/comfy/cloud/tasks/submit')({...f.req,body},accepted);
  assert.equal(accepted.body.status,'accepted');assert.equal(accepted.body.task.taskId,task.taskId);
  const sent=JSON.parse(calls[0].body);assert.equal(sent.instanceType,'plus');assert.equal(sent.retainSeconds,undefined);
  assert.equal(sent.workflow,prepareComfyCloudSubmission(body.request).body.workflow);
  const duplicate=response();await handlers.get('POST /image/comfy/cloud/tasks/submit')({...f.req,body},duplicate);
  assert.equal(duplicate.body.ok,false);assert.equal(calls.length,1);
  const original={version:1,expectedAccount:body.expectedAccount,apiKey:body.apiKey,task,...accepted.body.locator};
  const result=response();await handlers.get('POST /image/comfy/cloud/tasks/result')({...f.req,body:original},result);
  assert.equal(result.body.status,'ready');assert.deepEqual(Buffer.from(result.body.images[0].data,'base64'),png);
  assert.equal(result.body.images[0].id,`rh:${task.taskId}:0:save`);
  assert.deepEqual(result.body.delivery.usage,usage);
  const cached=response();await handlers.get('POST /image/comfy/cloud/tasks/result')({...f.req,body:original},cached);
  assert.deepEqual(cached.body.delivery.usage,usage);
  const ack=response();await handlers.get('POST /image/comfy/cloud/tasks/acknowledge')({...f.req,
    body:{...original,apiKey:undefined,archived:true,receipt:result.body.receipt}},ack);
  assert.equal(ack.body.cleanup,'complete');
  const catalog=response();await handlers.get('POST /image/comfy/cloud/tasks/catalog')({...f.req,body:{version:1,expectedAccount:body.expectedAccount}},catalog);
  assert.deepEqual(catalog.body.tasks[0].usage,usage,'reported task usage survives cache deletion without a second billed read');
  assert.equal(catalog.body.tasks[0].canRetryCleanup,false,'retained usage is not another temporary file to clean');
  assert.deepEqual(calls.map(call=>call.url.pathname),['/task/openapi/create','/openapi/v2/query','/task/openapi/outputs','/0.png']);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).options.headers),/Bearer|test-only-secret|Cookie/i);
  assert.doesNotMatch(JSON.stringify(await f.store.inspectChannel(f.key)),/test-only-secret|signature/);
});

test('installed cloud recovery obeys original site policy for CDN collection without a separate native/CDN registration', async t => {
  const f = await persistedCloudTask(t), handlers = new Map(), calls = []; let approved = false;
  await init({ get: (key, handler) => handlers.set(`GET ${key}`, handler), post: (key, handler) => handlers.set(`POST ${key}`, handler) }, {
    dataRoot: f.root, comfyCloudTaskOptions: { store: f.store },
    comfyTargetStore: { read: async () => assert.fail('cloud originals do not use the native registry') },
    authorizeCloudTarget: async (_req,binding) => { assert.equal(binding.origin,f.task.origin);return async()=>{if(!approved)throw Error('site revoked cloud');}; },
    comfyTransportOptions: { resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => assetDownloadReply(f, call)) },
  });
  const input = { version: 1, expectedAccount: imageServiceAccount(f.req).namespace, task: f.task, ...f.locator };
  const denied = response(); await handlers.get('POST /image/comfy/cloud/tasks/result')({ ...f.req, body: input }, denied);
  assert.equal(denied.body.ok, false); assert.equal(calls.length, 0, 'original platform permission is still required');
  approved = true;
  const result = response(); await handlers.get('POST /image/comfy/cloud/tasks/result')({ ...f.req, body: input }, result);
  assert.equal(result.body.status, 'ready'); assert.equal(result.body.images.length, 1); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.method === 'GET'));
  const file = calls.find(call => call.url.hostname === 'files.test'); assert.ok(file);
  assert.doesNotMatch(JSON.stringify(file.options.headers), /Bearer|test-only-secret|Cookie/i);
  assert.equal((await f.store.inspectChannel(f.locator.channelKey)).entries[0].cloudDelivery.state, 'stored');
  approved = false;
  const cached = response(); await handlers.get('POST /image/comfy/cloud/tasks/result')({ ...f.req, body: input }, cached);
  assert.equal(cached.body.status, 'ready'); assert.equal(calls.length, 3, 'original owned files remain readable after remote permission revocation');
});

test('every installed Comfy gateway operation requires ST identity and private administrator opt-in before DNS', async () => {
  const handlers = await routes({ resolveHost: () => assert.fail('unauthorized DNS'), requestImpl: () => assert.fail('unauthorized request') });
  for (const path of ['check', 'models', 'generate']) {
    for (const [req, body, status] of [[{}, input(), 401], [account(false), input({ allowPrivateNetwork: true }), 403]]) {
      const res = response(); await handlers.get(`POST /image/${path}`)({ ...req, body }, res);
      assert.equal(res.statusCode, status); assert.match(res.body.code, path === 'generate' && status === 403 ? /^comfy_targets_/ : /^comfy_transport_/); assert.equal(res.headers['cache-control'], 'no-store');
      if (path === 'generate') assert.equal(res.body.submissionState, 'not_submitted');
    }
  }
});

test('invalid protocol, root path, graph and DNS answers never open a socket', async () => {
  const denied = { operation: 'check', resolveHost: () => assert.fail('invalid URL DNS'), requestImpl: () => assert.fail('socket') };
  for (const baseUrl of ['file:///etc/passwd', 'https://a.test/api/../b', 'https://a.test/%2e%2e/b', 'https://a.test/api//b', 'https://a.test/api%2fb',
    'https://user:pass@a.test', 'https://a.test?a=b', 'https://a.test/#x', 'https://a.test/\\api', 'http://a.test', 'https://a.test/ api']) {
    await assert.rejects(createComfyServerTransport(account(), input({ baseUrl }), denied));
  }
  for (const addresses of [[], Array(33).fill({ address: '8.8.8.8' }), [{ address: 'junk' }], [{ address: '8.8.8.8', family: 6 }]]) {
    await assert.rejects(createComfyServerTransport(account(), input(), { operation: 'check', resolveHost: async () => addresses }), { code: 'comfy_transport_address' });
  }
  const handlers = await routes(denied), res = response();
  await handlers.get('POST /image/generate')({ ...account(), body: input({ parameters: { workflow: {} } }) }, res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.submissionState, 'not_submitted');
});

test('private opt-in never permits link-local, unspecified, multicast or IPv6 translation targets', async () => {
  for (const address of ['0.0.0.0', '169.254.169.254', '224.0.0.1', '::', '0:0:0:0:0:0:0:0', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001::1', '2001:0000:0000:0000:0000:0000:0000:0001']) {
    await assert.rejects(createComfyServerTransport(account(true), input({ allowPrivateNetwork: true }), { resolveHost: async () => [{ address }] }), { code: 'comfy_transport_unsafe_target' });
  }
  for (const address of ['127.0.0.1', '192.168.1.3', 'fd00::1', '0:0:0:0:0:0:0:1']) {
    await assert.rejects(createComfyServerTransport(account(), input(), { resolveHost: async () => [{ address }] }), { code: 'private_network_blocked' });
  }
});

test('DNS has a bounded timeout; cancelling or changing identity during resolution does not connect', async () => {
  await assert.rejects(createComfyServerTransport(account(), input(), { resolveHost: async () => { throw new Error('getaddrinfo private details'); } }), { code: 'comfy_transport_dns', message: '无法解析 Comfy 地址，请核对域名与 ST 主机网络' });
  await assert.rejects(createComfyServerTransport(account(), input(), { resolveHost: () => new Promise(() => {}), dnsTimeoutMs: 5 }), { code: 'comfy_transport_dns_timeout' });
  const req = account(), controller = new AbortController();
  await assert.rejects(createComfyServerTransport(req, input(), { signal: controller.signal, resolveHost: async () => { controller.abort(); return publicDns(); } }), { name: 'AbortError' });
  await assert.rejects(createComfyServerTransport(req, input(), { resolveHost: async () => { req.user.profile.handle = 'bob'; return publicDns(); } }), { code: 'comfy_transport_account_changed' });
});

test('pinned transport limits each operation to exact native paths and excludes cookies, redirects and arbitrary reads', async () => {
  const base = new URL('https://comfy.test/api'), addresses = [{ address: '8.8.8.8' }];
  for (const [operation, route, method] of [['check', 'prompt', 'POST'], ['models', 'history/x', 'GET'], ['readiness', 'object_info', 'GET'],
    ['readiness', 'object_info/A/extra', 'GET'], ['generate', 'queue', 'POST'], ['generate', 'interrupt', 'POST'], ['generate', 'history', 'GET'],
    ['generate', 'view?filename=a.png&type=input', 'GET'], ['generate', 'view?filename=a.png&type=output&url=https://else.test', 'GET'],
    ['generate', 'view?filename=a.png&type=output&type=output', 'GET'], ['generate', 'view?filename=a.png&type=output&subfolder=../x', 'GET']]) {
    const fetcher = pinnedComfyFetch(base, addresses, { operation, requestImpl: () => assert.fail('must not connect') });
    await assert.rejects(fetcher(new URL(route, `${base}/`), { method }), { code: 'comfy_transport_target_changed' });
  }
  const fetcher = pinnedComfyFetch(base, addresses, { operation: 'check', requestImpl: () => assert.fail('must not connect') });
  await assert.rejects(fetcher('https://other.test/api/system_stats'), { code: 'comfy_transport_target_changed' });
  await assert.rejects(fetcher(`${base}/system_stats`, { headers: { Cookie: 'session=secret' } }), { code: 'comfy_transport_headers' });
  await assert.rejects(fetcher(`${base}/system_stats`, { body: 'not read-only' }), { code: 'comfy_transport_body' });
});

test('installed cloud connection checks use official read-only endpoints, not native stats or job submission',async()=>{
  for(const [baseUrl,reply] of [['https://cloud.comfy.org',{queue_running:[],queue_pending:[]}],
    ['https://www.runninghub.cn',{code:0,data:{remainCoins:'12.50',currentTaskCounts:'0',privateDetail:'must stay upstream'}}]]){
    const handlers=new Map(),calls=[];
    await init({get:(key,fn)=>handlers.set(`GET ${key}`,fn),post:(key,fn)=>handlers.set(`POST ${key}`,fn)},
      {comfyTargetStore:{read:()=>assert.fail('cloud checks never enroll native targets')},comfyTransportOptions:{resolveHost:publicDns,requestImpl:mockNodeRequest(calls,()=>({body:reply}))}});
    const res=response();await handlers.get('POST /image/check')({...account(),body:input({baseUrl,allowPrivateNetwork:true})},res);
    assert.equal(res.body.ok,true);assert.equal(res.body.verified,false);assert.equal(res.body.message,'地址可达，请以生图验证');
    assert.equal(calls.length,1);assert.doesNotMatch(JSON.stringify(res.body),/test-only-secret|privateDetail|remainCoins|queue_running/);
    if(baseUrl.includes('runninghub')){
      assert.equal(calls[0].url.pathname,'/uc/openapi/accountStatus');assert.equal(calls[0].options.method,'POST');
      assert.deepEqual(JSON.parse(calls[0].body),{apikey:'test-only-secret'});assert.equal(calls[0].options.headers.authorization,'Bearer test-only-secret');
    }else{assert.equal(calls[0].url.pathname,'/api/queue');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.headers['x-api-key'],'test-only-secret');assert.equal(calls[0].options.headers.authorization,undefined);}
  }
});

test('cloud connection failures are bounded, concise and cannot fall back to paid generation or leak upstream text',async()=>{
  const connection=input({baseUrl:'https://cloud.comfy.org'});
  for(const reply of [{status:401,body:{error:'test-only-secret'}},{status:429,body:{}},{status:302,headers:{location:'https://other.test'}},
    {body:{arbitrary:'test-only-secret'}},{body:{queue_running:[],queue_pending:[],huge:'x'.repeat(1048576)}}]){
    const calls=[];await assert.rejects(checkComfyCloudConnection(account(),connection,{transportOptions:{resolveHost:publicDns,requestImpl:mockNodeRequest(calls,()=>reply)}}),error=>{
      assert.equal(error.submissionState,'not_submitted');assert.doesNotMatch(error.message,/test-only-secret|arbitrary/);return true;
    });assert.equal(calls.length,1);
  }
  await assert.rejects(checkComfyCloudConnection(account(),connection,{timeoutMs:20,transportOptions:{resolveHost:()=>new Promise(()=>{}),requestImpl:()=>assert.fail('DNS must not reach socket')}}),{code:'comfy_cloud_check_timeout'});
  await assert.rejects(checkComfyCloudConnection({},connection),/登录/);
  await assert.rejects(checkComfyCloudConnection(account(),{...connection,apiKey:''}),/Key/);
  await assert.rejects(checkComfyCloudConnection(account(),connection,{transportOptions:{resolveHost:async()=>[{address:'127.0.0.1'}],requestImpl:()=>assert.fail('private egress')}}));
  const state=account();await assert.rejects(checkComfyCloudConnection(state,connection,{transportOptions:{resolveHost:async()=>{state.user.profile.handle='other';return publicDns();},requestImpl:()=>assert.fail('changed account')}}));
  const deployment=await checkComfyCloudConnection(account(),{...connection,baseUrl:'https://sample.run.comfy.app'},{transportOptions:{resolveHost:()=>assert.fail('no invented probe')}});
  assert.equal(deployment.transport,'configured');assert.match(deployment.message,/未执行连接探测/);
  await assert.rejects(checkComfyCloudConnection(account(),input({baseUrl:'https://www.runninghub.ai'}),{transportOptions:{resolveHost:publicDns,requestImpl:mockNodeRequest([],()=>({body:{code:401,msg:'test-only-secret'}}))}}),{code:'comfy_cloud_check_platform'});
});

test('check and model routes use pinned Node transport with auth, never the generic browser fetch', async () => {
  const calls = []; let resolutions = 0;
  const handlers = await routes({ resolveHost: async () => { resolutions++; return publicDns(); }, requestImpl: mockNodeRequest(calls, call => ({ body: call.url.pathname.endsWith('object_info')
    ? { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors']] } } } } : { system: {} } })) });
  const first = response(); await handlers.get('POST /image/check')({ ...account(), body: input() }, first);
  assert.equal(first.body.ok, true); assert.equal(first.body.verified, false); assert.equal(first.body.message, '地址可达，请以生图验证');
  const second = response(); await handlers.get('POST /image/models')({ ...account(), body: input() }, second);
  assert.equal(second.body.models[0].id, 'model.safetensors'); assert.equal(resolutions, 2); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.headers.authorization, 'Bearer test-only-secret');
    call.options.lookup('comfy.test', { all: true }, (error, list) => { assert.equal(error, null); assert.deepEqual(list, [{ address: '8.8.8.8', family: 4 }]); });
    call.options.lookup('changed.test', {}, error => assert.ok(error));
  }
});

test('actual generation route pins upload, prompt, original history and view to one DNS snapshot with streaming multipart', async () => {
  const calls = []; let resolutions = 0;
  const handlers = await routes({ resolveHost: async () => { resolutions++; return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1' }]; }, requestImpl: mockNodeRequest(calls, call => {
    const path = call.url.pathname;
    if (path.endsWith('/upload/image')) {
      assert.match(call.options.headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.match(call.body.toString(), /name="overwrite"\r\n\r\nfalse/); assert.ok(call.body.includes(png));
      return { body: { name: 'uploaded.png' } };
    }
    if (path.endsWith('/prompt')) { assert.deepEqual(JSON.parse(call.body).prompt['1'].inputs, { text: 'rain', refs: ['uploaded.png'] }); return { body: { prompt_id: 'original-id' } }; }
    if (path.endsWith('/history/original-id')) return { body: { 'original-id': { status: { completed: true }, outputs: { save: { images: [{ filename: 'done.png', type: 'output' }] } } } } };
    if (path.endsWith('/view')) return { body: png, headers: { 'content-type': 'image/png' } };
    assert.fail(path);
  }) });
  const res = response(); await handlers.get('POST /image/generate')({ ...account(), body: input({ referenceImages: [{ data: png.toString('base64'), mime: 'image/png' }],
    parameters: { pollIntervalMs: 250, workflow: workflow(true) } }) }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.upstreamId, 'original-id'); assert.equal(res.body.images.length, 1);
  assert.equal(resolutions, 1); assert.equal(calls.length, 4);
  for (const call of calls) { assert.equal(call.options.headers.authorization, 'Bearer test-only-secret'); call.options.lookup('comfy.test', {}, (error, ip) => { assert.equal(error, null); assert.equal(ip, '8.8.8.8'); }); }
});

test('redirects are not followed and a failure after acceptance retains the original id without submitting twice', async () => {
  const calls = [];
  const handlers = await routes({ resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => call.url.pathname.endsWith('prompt') ? { body: { prompt_id: 'original-id' } }
    : { status: 302, headers: { location: 'http://127.0.0.1/secret?key=test-only-secret' } }) });
  const res = response(); await handlers.get('POST /image/generate')({ ...account(), body: input() }, res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.code, 'comfy_transport_redirect'); assert.equal(res.body.upstreamId, 'original-id');
  assert.equal(res.body.submissionState, 'accepted'); assert.equal(calls.length, 2); assert.ok(!JSON.stringify(res.body).includes('test-only-secret'));
});

test('installed result and acknowledgement routes recover the original by GET only, then release only its cached files', async () => {
  const calls = []; let available = false;
  const handlers = await routes({ resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => {
    const route = call.url.pathname;
    if (route.endsWith('/prompt')) return { body: { prompt_id: 'original-id' } };
    if (route.includes('/history/')) return available ? { body: { 'original-id': { status: { completed: true }, outputs: { save: { images: [{ filename: 'done.png', type: 'output' }] } } } } } : { status: 502 };
    if (route.endsWith('/view')) return { body: png, headers: { 'content-type': 'image/png' } };
    assert.fail(route);
  }) });
  const submitted = response(); await handlers.get('POST /image/generate')({ ...account(), body: input() }, submitted);
  assert.equal(submitted.body.submissionState, 'accepted'); available = true;
  const body = { ...input().comfyQueue, baseUrl: input().baseUrl, apiKey: input().apiKey };
  const recovered = response(); await handlers.get('POST /image/comfy/tasks/result')({ ...account(), body }, recovered);
  assert.equal(recovered.statusCode, 200); assert.equal(recovered.body.status, 'ready'); assert.equal(recovered.body.images.length, 1);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  const done = response(); await handlers.get('POST /image/comfy/tasks/acknowledge')({ ...account(), body: { ...body, archived: true, receipt: recovered.body.comfyTask.receipt } }, done);
  assert.equal(done.body.ok, true); assert.ok(done.body.bytes > 0);
  const queried = response(); await handlers.get('POST /image/comfy/tasks/query')({ ...account(), body }, queried);
  assert.equal(queried.body.task.status, 'succeeded'); assert.equal(queried.body.task.resultStored, false);
});

test('installed Comfy catalog and explicit cleanup use ST authentication, never provider network or ledger deletion', async () => {
  const calls = [];
  const handlers = await routes({ resolveHost: publicDns, requestImpl: mockNodeRequest(calls, call => {
    if (call.url.pathname.endsWith('/prompt')) return { body: { prompt_id: 'catalog-original' } };
    if (call.url.pathname.includes('/history/')) return { body: { 'catalog-original': { status: { completed: true }, outputs: { save: { images: [{ filename: 'catalog.png', type: 'output' }] } } } } };
    if (call.url.pathname.endsWith('/view')) return { body: png, headers: { 'content-type': 'image/png' } };
    assert.fail(call.url.pathname);
  }) });
  const generated = response(); await handlers.get('POST /image/generate')({ ...account(), body: input() }, generated);
  assert.equal(generated.body.ok, true); const previousCalls = calls.length;
  const body = { version: 1, expectedAccount: input().comfyQueue.expectedAccount };
  const unauthorized = response(); await handlers.get('POST /image/comfy/tasks/catalog')({ body }, unauthorized); assert.equal(unauthorized.statusCode, 401);
  const listed = response(); await handlers.get('POST /image/comfy/tasks/catalog')({ ...account(), body }, listed);
  assert.equal(listed.body.catalogVersion, 1); assert.equal(listed.headers['cache-control'], 'no-store'); assert.equal(listed.body.originals.length, 1);
  const original = listed.body.originals[0], target = { ...body, attemptId: original.attemptId, taskLocator: original.taskLocator, receipt: original.cacheReceipt };
  const denied = response(); await handlers.get('POST /image/comfy/tasks/discard')({ ...account(), body: target }, denied); assert.equal(denied.statusCode, 409);
  const removed = response(); await handlers.get('POST /image/comfy/tasks/discard')({ ...account(), body: { ...target, confirmed: true } }, removed); assert.equal(removed.body.ok, true);
  const queried = response(); await handlers.get('POST /image/comfy/tasks/query')({ ...account(), body: target }, queried); assert.equal(queried.body.task.status, 'succeeded');
  assert.equal(calls.length, previousCalls);
});

test('revoking private admin stops subsequent reads and response delivery', async () => {
  const req = account(true), calls = [];
  const handlers = await routes({ resolveHost: async () => [{ address: '127.0.0.1' }], requestImpl: mockNodeRequest(calls, () => {
    req.user.profile.admin = false; return { body: { system: {} } };
  }) });
  const res = response(); await handlers.get('POST /image/check')({ ...req, body: input({ baseUrl: 'http://127.0.0.1:8188', allowPrivateNetwork: true }) }, res);
  assert.equal(res.statusCode, 401); assert.equal(res.body.code, 'comfy_transport_account_changed'); assert.equal(calls.length, 1);
});

test('real local HTTP stub verifies streaming bodies, response byte reads and explicit local administrator connection', async () => {
  const seen = []; const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ prompt_id: 'local-stub' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const transport = await createComfyServerTransport(account(true), input({ baseUrl, allowPrivateNetwork: true }), { operation: 'generate' });
    const result = await transport.fetchImpl(`${baseUrl}/prompt`, { method: 'POST', headers: { Authorization: 'Bearer local-only', 'Content-Type': 'application/json' }, body: '{"prompt":{}}' });
    assert.deepEqual(await result.json(), { prompt_id: 'local-stub' });
    assert.deepEqual(seen, [{ path: '/prompt', method: 'POST', auth: 'Bearer local-only', body: '{"prompt":{}}' }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('pending DNS cannot retarget the API root and pinned addresses cannot be mutated or reused from a global pool', async () => {
  const body = input(), calls = [], addresses = [{ address: '8.8.8.8', family: 4 }];
  const transport = await createComfyServerTransport(account(), body, { operation: 'check', resolveHost: async () => {
    body.baseUrl = 'https://else.test/new'; return addresses;
  }, requestImpl: mockNodeRequest(calls) });
  addresses[0].address = '127.0.0.1'; transport.base.pathname = '/changed';
  await transport.fetchImpl('https://comfy.test/api/system_stats');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.agent, false);
  calls[0].options.lookup('comfy.test', {}, (error, ip) => { assert.equal(error, null); assert.equal(ip, '8.8.8.8'); });
  assert.throws(() => pinnedComfyFetch(new URL('https://1.1.1.1'), addresses, { operation: 'check' }), { code: 'comfy_transport_address' });
});

test('non-Comfy route preserves its legacy transport without requiring Comfy credentials, DNS or service coordination', async () => {
  const handlers = await routes({ resolveHost: () => assert.fail('not Comfy'), requestImpl: () => assert.fail('not Comfy') });
  const originalFetch = globalThis.fetch; let count = 0;
  try {
    globalThis.fetch = async (url, options) => {
      count++; assert.equal(String(url), 'https://8.8.8.8/models'); assert.equal(options.headers.Authorization, 'Bearer nai-test');
      return new Response('{}', { status: 404 });
    };
    // Ordinary model API behavior stays on the existing path, not the durable queue or Comfy requester.
    const res = response(); await handlers.get('POST /image/check')({ body: { provider: 'novel', apiKey: 'nai-test', baseUrl: 'https://8.8.8.8' } }, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.verified, false); assert.equal(count, 1);
  } finally { globalThis.fetch = originalFetch; }
});
