import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createComfyCloudLedger } from '../qianmu-comfy-cloud-ledger.js';
import { createComfyCloudService } from '../qianmu-comfy-cloud-service.js';
import { prepareComfyCloudSubmissionInput } from '../qianmu-comfy-cloud-prepare.js';
import { normalizeComfyCloudChannel } from '../qianmu-comfy-cloud-channel-state.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { init, exit } from '../server-plugin.js';
import { stillInput } from './helpers/runninghub-validation-fixture.mjs';

const copy = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const account = handle => ({ user: { profile: { handle, enabled: true, admin: true } } });
const noIO = () => assert.fail('Manual review must never perform provider, DNS or image IO');
function memoryStore() {
  const rows = new Map(); let tail = Promise.resolve();
  const store = {
    rows, writes: 0, beforeReduce: null, afterCommit: null, afterRead: null,
    async transaction(key, reduce) {
      const work = tail.then(async () => {
        await store.beforeReduce?.(key);
        const next = reduce(copy(rows.get(key)));
        rows.set(key, copy(next.state)); store.writes++;
        return next.result;
      });
      tail = work.catch(() => {});
      const result = await work;
      await store.afterCommit?.(key);
      return result;
    },
    async inspectChannel(key) { const value = copy(rows.get(key)); await store.afterRead?.(); return value; },
    async inspectAccount(namespace) {
      const entries = [...rows].flatMap(([channelKey, state]) => state.entries.filter(row => row.namespace === namespace).map(row => ({ ...copy(row), channelKey })));
      return { entries, selected: [], total: entries.length, nextCursor: null };
    },
    async close() { await tail; },
  };
  return store;
}
async function fixture(t) {
  const store = memoryStore(), req = account('review-owner'), expectedAccount = imageServiceAccount(req).namespace;
  const request = stillInput(), intent = prepareComfyCloudSubmissionInput(request).complete([]).intent;
  const ledger = createComfyCloudLedger({ store, ownerId: 'original-process', now: () => 2000 });
  const reservation = await ledger.reserve(req, { apiKey: 'synthetic-key', expectedAccount, attemptId: 'original-attempt', intent });
  const ticket = ledger.submission(reservation); await ticket.beforeSubmit(); await ticket.markUncertain();
  const input = { version: 1, expectedAccount, channelKey: reservation.channelKey, attemptId: reservation.attemptId };
  const cache = { inventory: async () => ({ entries: [], totals: {} }), load: noIO, reserve: noIO, save: noIO };
  const transportOptions = { authorizeTarget: noIO, resolveHost: noIO, requestImpl: noIO };
  const service = createComfyCloudService({ store, cache, transportOptions });
  t.after(() => service.close());
  const row = () => store.rows.get(input.channelKey).entries[0];
  const confirm = view => ({ ...input, confirmation: view.confirmation, confirmed: true, possibleCharge: true });
  const receipt = { schema: 'qianmu.comfy-cloud-receipt.v1', task: { ...intent.connection, taskId: '1904152026220003329' },
    requestDigest: intent.requestDigest, workflow: intent.workflow, stillOutput: intent.stillOutput };
  return { store, req, input, ledger, ticket, reservation, intent, request, service, cache, row, confirm, receipt };
}

test('keyless two-step review preserves the exact original record, does not generate, and leaves replay fenced', async t => {
  const f = await fixture(t), before = copy(f.row()), writes = f.store.writes;
  const review = await f.service.review(f.req, f.input);
  assert.deepEqual(Object.keys(review).sort(), ['ok','version','channelKey','attemptId','status','canReview','reviewed','confirmation','resultAvailable','message'].sort());
  assert.equal(review.canReview, true); assert.equal(review.reviewed, false); assert.equal(review.resultAvailable, false);
  assert.match(review.confirmation, /^[a-f0-9]{64}$/); assert.equal(f.store.writes, writes);
  assert.doesNotMatch(JSON.stringify(review), /synthetic-key|ownerId|fence|cloudIntent|prompt|workflow/);
  assert.doesNotMatch(review.message, /已结束|未收费|未受理/);
  await assert.rejects(f.ledger.reserve(f.req, { apiKey: 'synthetic-key', expectedAccount: f.input.expectedAccount, attemptId: 'new-attempt', intent: f.intent }), { code: 'image_service_cloud_occupied' });
  const result = await f.service.confirmReview(f.req, f.confirm(review));
  assert.equal(result.status, 'acknowledged'); assert.equal(result.reviewed, true); assert.equal(result.canReview, false); assert.equal(result.confirmation, '');
  const acknowledged = copy(f.row());
  assert.ok(acknowledged.updatedAt >= before.updatedAt);
  assert.deepEqual(acknowledged, { ...before, status: 'acknowledged', updatedAt: acknowledged.updatedAt });
  assert.equal(f.store.rows.get(f.input.channelKey).entries.length, 1);
  await assert.rejects(f.ledger.reserve(f.req, { apiKey: 'synthetic-key', expectedAccount: f.input.expectedAccount, attemptId: f.input.attemptId, intent: f.intent }), { code: 'image_service_cloud_duplicate' });
  const next = await f.ledger.reserve(f.req, { apiKey: 'synthetic-key', expectedAccount: f.input.expectedAccount, attemptId: 'new-attempt', intent: f.intent });
  assert.equal(next.status, 'reserved'); assert.notEqual(next.fence, before.fence); assert.deepEqual(f.row(), acknowledged);
});

test('cancelled or unconfirmed review does not mutate and repeated confirmation only reports the same acknowledgement', async t => {
  const f = await fixture(t), review = await f.service.review(f.req, f.input), before = copy(f.row()), writes = f.store.writes;
  for (const patch of [{ confirmed: false }, { possibleCharge: false }, { confirmation: '' }, { ended: true }]) {
    await assert.rejects(f.service.confirmReview(f.req, { ...f.confirm(review), ...patch }));
    assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.confirmReview(f.req, f.confirm(review), { signal: controller.signal }));
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
  const first = await f.service.confirmReview(f.req, f.confirm(review));
  const after = copy(f.row());
  assert.deepEqual(await f.service.confirmReview(f.req, f.confirm(review)), first);
  assert.deepEqual(f.row(), after); assert.equal(f.store.rows.get(f.input.channelKey).entries.length, 1);
});

test('missing and another account original are indistinguishable, even to an administrator with the same channel', async t => {
  const f = await fixture(t), req = account('another-account'), input = { ...f.input, expectedAccount: imageServiceAccount(req).namespace };
  const before = copy(f.row()), writes = f.store.writes;
  let missing, other;
  try { await f.service.review(req, { ...input, attemptId: 'missing-attempt' }); } catch (error) { missing = error; }
  try { await f.service.review(req, input); } catch (error) { other = error; }
  assert.equal(other.code, missing.code); assert.equal(other.message, missing.message);
  const proof = await f.service.review(f.req, f.input);
  await assert.rejects(f.service.confirmReview(req, { ...f.confirm(proof), expectedAccount: input.expectedAccount }));
  const catalog = await f.service.catalog(req, { version: 1, expectedAccount: input.expectedAccount });
  assert.deepEqual(catalog.tasks, []); assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
});

test('browser namespaces, snapshots, invented records and mismatched channel locators never authorize a review', async t => {
  const f = await fixture(t), before = copy(f.row()), writes = f.store.writes;
  for (const patch of [{ namespace: f.input.expectedAccount }, { snapshot: before }, { cloudIntent: f.intent }, { apiKey: 'synthetic-key' }, { channelKey: 'f'.repeat(64) }, { attemptId: 'invented' }]) {
    await assert.rejects(f.service.review(f.req, { ...f.input, ...patch }));
  }
  delete f.row().cloudIntent;
  await assert.rejects(f.service.review(f.req, f.input));
  f.row().cloudIntent = before.cloudIntent;
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes); assert.equal(f.store.rows.size, 1);
});

for (const stage of ['read', 'transaction']) test(`account switch at ${stage} blocks old-account review disclosure and writes`, async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input), before = copy(f.row()), writes = f.store.writes;
  const change = () => { f.req.user.profile.handle = 'changed-account'; };
  if (stage === 'read') f.store.afterRead = change; else f.store.beforeReduce = change;
  await assert.rejects(stage === 'read' ? f.service.review(f.req, f.input) : f.service.confirmReview(f.req, f.confirm(view)));
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
});

test('signal and resource activity are rechecked within the confirmation transaction', async t => {
  const f = await fixture(t), view = await f.ledger.review(f.req, f.input), before = copy(f.row()), writes = f.store.writes;
  let busy = false;
  f.store.beforeReduce = () => { busy = true; };
  await assert.rejects(f.ledger.confirmReview(f.req, f.confirm(view), { resourceBusy: () => busy }), { code: 'image_service_cloud_review_changed' });
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
  const controller = new AbortController();
  f.store.beforeReduce = () => controller.abort();
  await assert.rejects(f.service.confirmReview(f.req, f.confirm(view), { signal: controller.signal }));
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
});

for (const change of ['updatedAt','fence','ownerId','intent','accepted']) test(`CAS rejects a changed ${change} even if the old prompt has been confirmed`, async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input);
  if (change === 'updatedAt') f.row().updatedAt++;
  if (change === 'fence') f.row().fence = 'replacement-fence';
  if (change === 'ownerId') f.row().ownerId = 'another-owner';
  if (change === 'intent') f.row().cloudIntent.workflow.templateHash = 'f'.repeat(64);
  if (change === 'accepted') f.row().upstreamId = f.receipt.task.taskId;
  const before = copy(f.row()), writes = f.store.writes;
  await assert.rejects(f.service.confirmReview(f.req, f.confirm(view)));
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
});

for (const status of ['reserved','submitting','released','failed','rejected']) test(`${status} is never unlockable from a stale uncertain confirmation`, async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input);
  f.row().status = status;
  const before = copy(f.row()), writes = f.store.writes;
  assert.equal((await f.service.review(f.req, f.input)).canReview, false);
  await assert.rejects(f.service.confirmReview(f.req, f.confirm(view)));
  assert.deepEqual(f.row(), before); assert.equal(f.store.writes, writes);
});

test('same-resource in-process submission blocks review before reservation, without provider IO', async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input), entered = deferred(), release = deferred();
  const service = createComfyCloudService({ store: f.store, cache: f.cache, transportOptions: {
    authorizeTarget: async () => { entered.resolve(); await release.promise; return async () => {}; }, resolveHost: noIO, requestImpl: noIO,
  } });
  t.after(() => service.close());
  const attempt = service.submit(f.req, { version: 1, expectedAccount: f.input.expectedAccount, attemptId: 'overlapping-attempt', apiKey: 'synthetic-key', request: f.request });
  const outcome = assert.rejects(attempt);
  await entered.promise;
  assert.equal((await service.review(f.req, f.input)).canReview, false);
  await assert.rejects(service.confirmReview(f.req, f.confirm(view)));
  assert.equal(f.row().status, 'uncertain'); release.resolve(); await outcome;
});

test('catalog exposes owned no-id metadata and canonical connection, never old graph or credentials', async t => {
  const f = await fixture(t), writes = f.store.writes;
  const catalog = await f.service.catalog(f.req, { version: 1, expectedAccount: f.input.expectedAccount });
  assert.equal(catalog.tasks.length, 1); const row = catalog.tasks[0];
  assert.equal(row.task, null); assert.equal(row.canReview, true); assert.equal(row.reviewed, false);
  assert.deepEqual(row.cloudConnection, f.intent.connection);
  assert.deepEqual(Object.keys(row.cloudConnection).sort(), ['version','provider','protocol','origin'].sort());
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-key|cloudIntent|stillOutput|requestDigest|ownerId|fence|prompt/);
  assert.equal(f.store.writes, writes);
});

test('late acceptance survives both transactions after review and cannot alter a separate newer request', async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input);
  await f.service.confirmReview(f.req, f.confirm(view));
  const firstWrite = deferred(), continueWrite = deferred(); let blocked = false;
  f.store.afterCommit = async () => {
    if (!blocked && f.row().upstreamId && !f.row().cloudReceipt) { blocked = true; firstWrite.resolve(); await continueWrite.promise; }
  };
  const late = f.ticket.recordAccepted(f.receipt.task.taskId, f.receipt);
  await firstWrite.promise;
  assert.equal(f.row().status, 'acknowledged'); assert.equal(f.row().upstreamId, f.receipt.task.taskId);
  const otherProcess = createComfyCloudLedger({ store: f.store, ownerId: 'next-process', now: () => 3000 });
  await otherProcess.reserve(f.req, { apiKey: 'synthetic-key', expectedAccount: f.input.expectedAccount, attemptId: 'new-attempt', intent: f.intent });
  const next = copy(f.store.rows.get(f.input.channelKey).entries[1]);
  continueWrite.resolve(); await late; await f.ticket.markUncertain();
  assert.equal(f.row().status, 'acknowledged'); assert.deepEqual(f.row().cloudReceipt, f.receipt);
  assert.deepEqual(f.store.rows.get(f.input.channelKey).entries[1], next);
  assert.equal(normalizeComfyCloudChannel(f.store.rows.get(f.input.channelKey), f.input.channelKey).entries.length, 2);
});

test('an accepted id arriving between review and confirmation invalidates the old proof, while its receipt still completes', async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input), firstWrite = deferred(), continueWrite = deferred(); let blocked = false;
  f.store.afterCommit = async () => {
    if (!blocked && f.row().upstreamId && !f.row().cloudReceipt) { blocked = true; firstWrite.resolve(); await continueWrite.promise; }
  };
  const late = f.ticket.recordAccepted(f.receipt.task.taskId, f.receipt);
  await firstWrite.promise;
  await assert.rejects(f.service.confirmReview(f.req, f.confirm(view)));
  assert.equal(f.row().status, 'uncertain'); continueWrite.resolve(); await late;
  assert.deepEqual(f.row().cloudReceipt, f.receipt);
});

for (const field of ['ownerId','fence','requestDigest','cloudIntent']) test(`a late ticket cannot append evidence after its ${field} changes`, async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input);
  await f.service.confirmReview(f.req, f.confirm(view));
  if (field === 'requestDigest') { f.row().requestDigest = 'f'.repeat(64); f.row().cloudIntent.requestDigest = 'f'.repeat(64); }
  else if (field === 'cloudIntent') f.row().cloudIntent.workflow.templateHash = 'f'.repeat(64);
  else f.row()[field] = 'different-owner-or-fence';
  const before = copy(f.row());
  await assert.rejects(f.ticket.recordAccepted(f.receipt.task.taskId, f.receipt), { code: 'image_service_cloud_acceptance_unconfirmed', submissionState: 'accepted' });
  assert.deepEqual(f.row(), before); assert.equal(f.row().status, 'acknowledged');
});

for (const committed of [false, true]) test(`storage failure ${committed ? 'after' : 'before'} commit never claims success or automatically creates another attempt`, async t => {
  const f = await fixture(t), view = await f.service.review(f.req, f.input), before = copy(f.row());
  const fail = () => { throw Error('PRIVATE_STORE_ERROR'); };
  if (committed) f.store.afterCommit = fail; else f.store.beforeReduce = fail;
  await assert.rejects(f.service.confirmReview(f.req, f.confirm(view)), error => { assert.doesNotMatch(error.message, /PRIVATE_STORE_ERROR/); return true; });
  f.store.beforeReduce = null; f.store.afterCommit = null;
  assert.equal(f.store.rows.get(f.input.channelKey).entries.length, 1);
  const refreshed = await f.service.review(f.req, f.input);
  assert.equal(refreshed.reviewed, committed); assert.equal(refreshed.status, committed ? 'acknowledged' : 'uncertain');
  if (!committed) assert.deepEqual(f.row(), before);
});

test('actual plugin capabilities and both cloud-only routes expose the two-step contract with no generation', async t => {
  const f = await fixture(t), routes = new Map();
  await init({ get: (path, handler) => routes.set(`GET ${path}`, handler), post: (path, handler) => routes.set(`POST ${path}`, handler) }, {
    dataRoot: process.cwd(), comfyCloudTaskOptions: { store: f.store, cache: f.cache },
    comfyTransportOptions: { authorizeTarget: noIO, resolveHost: noIO, requestImpl: noIO },
  });
  t.after(() => exit());
  const call = async (method, path, body) => {
    const response = { statusCode: 200, set() { return this; }, once() {}, off() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`${method} ${path}`)({ ...f.req, body }, response); return response;
  };
  const capabilities = await call('GET', '/image/comfy/cloud/capabilities');
  assert.equal(capabilities.statusCode, 200); assert.equal(capabilities.body.manualReview, true);
  const review = await call('POST', '/image/comfy/cloud/tasks/review', f.input);
  assert.equal(review.statusCode, 200); assert.equal(review.body.canReview, true);
  const result = await call('POST', '/image/comfy/cloud/tasks/confirmReview', f.confirm(review.body));
  assert.equal(result.statusCode, 200); assert.equal(result.body.reviewed, true);
  assert.equal(f.store.rows.get(f.input.channelKey).entries.length, 1);
});

test('two host-store instances serialize confirmation and reopening retains the original unknown-charge history without a schema change', async t => {
  const parent = await fs.realpath(tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'qianmu-cloud-review-'));
  const stores = [];
  t.after(async () => {
    await Promise.all(stores.map(store => store.close()));
    const target = await fs.realpath(directory);
    assert.equal(path.dirname(target), parent); assert.match(path.basename(target), /^qianmu-cloud-review-/);
    await fs.rm(target, { recursive: true });
  });
  const open = () => { const store = createImageServiceStore({ dataRoot: directory, scope: 'comfy-cloud', lockWaitMs: 2000 }); stores.push(store); return store; };
  const store = open(), req = account('durable-review-owner'), expectedAccount = imageServiceAccount(req).namespace;
  const ledger = createComfyCloudLedger({ store }), intent = prepareComfyCloudSubmissionInput(stillInput()).complete([]).intent;
  const reserved = await ledger.reserve(req, { apiKey: 'synthetic-key', expectedAccount, attemptId: 'durable-original', intent });
  const ticket = ledger.submission(reserved); await ticket.beforeSubmit(); await ticket.markUncertain();
  const input = { version: 1, expectedAccount, channelKey: reserved.channelKey, attemptId: reserved.attemptId };
  const old = (await store.inspectChannel(input.channelKey)).entries[0];
  const other = createComfyCloudLedger({ store: open() }), view = await other.review(req, input);
  const confirmation = { ...input, confirmation: view.confirmation, confirmed: true, possibleCharge: true };
  const results = await Promise.all([ledger.confirmReview(req, confirmation), other.confirmReview(req, confirmation)]);
  assert.ok(results.every(result => result.reviewed && result.status === 'acknowledged'));
  await store.close();
  const reopened = open(), state = await reopened.inspectChannel(input.channelKey), row = state.entries[0];
  assert.equal(state.schema, 'qianmu.comfy-cloud-channel.v1'); assert.equal(state.entries.length, 1);
  assert.deepEqual(row, { ...old, status: 'acknowledged', updatedAt: row.updatedAt });
  assert.ok(row.updatedAt >= old.updatedAt); assert.deepEqual(Object.keys(row).sort(), Object.keys(old).sort());
  assert.equal((await createComfyCloudLedger({ store: reopened }).review(req, input)).reviewed, true);
});
