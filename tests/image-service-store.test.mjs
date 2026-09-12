import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceQueue, imageServiceChannelKey, describeImageServiceRequest, normalizeImageServiceChannel } from '../qianmu-image-service-queue.js';
import { generateImage } from '../qianmu-image-gateway.js';
import { COMFY_CLOUD_CHANNEL_SCHEMA, normalizeComfyCloudChannel } from '../qianmu-comfy-cloud-channel-state.js';
import { COMFY_CLOUD_RECEIPT_SCHEMA, COMFY_CLOUD_INTENT_SCHEMA } from '../qianmu-comfy-cloud-receipt.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { comfyCloudResourceKey, createComfyCloudLedger } from '../qianmu-comfy-cloud-ledger.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';

const key = imageServiceChannelKey('mock-persistence-key');
const never = () => assert.fail('must not authorize another request');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const request = { provider: 'novel', model: 'nai-diffusion-5-full', apiKey: 'mock-persistence-key', prompt: 'a quiet lake' };
const args = id => ({ apiKey: request.apiKey, namespace: 'account-a', attemptId: id, automatic: true, ...describeImageServiceRequest(request) });
const metadata = (id = 'first') => ({ schema: 'qianmu.image-service-channel.v1', channelKey: key, entries: [{
  namespace: 'account-a', attemptId: id, requestDigest: args(id).requestDigest, ownerId: 'server-a', fence: `fence-${id}`,
  status: 'submitting', automatic: true, createdAt: 1, updatedAt: 1,
}] });
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-service-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^qianmu-service-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  const store = createImageServiceStore({ dataRoot: root });
  t.after(() => store.close());
  return { root, store, directory: path.join(root, '.qianmu-service', 'image-queue-v1') };
}
async function child(script) {
  const instance = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const pipe of [instance.stdout, instance.stderr]) pipe.on('data', chunk => { output += chunk; });
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.once('close', code => code === 0 ? resolve(output) : reject(Error(`test child failed ${code}: ${output.slice(0, 1000)}`)));
  });
}
const storeUrl = new URL('../qianmu-image-service-store.js', import.meta.url).href;
const queueUrl = new URL('../qianmu-image-service-queue.js', import.meta.url).href;

function cloudMetadata() {
  const state = metadata(); state.schema = COMFY_CLOUD_CHANNEL_SCHEMA;
  const row = state.entries[0]; row.status = 'uncertain'; row.upstreamId = 'original';
  row.cloudReceipt = { schema: COMFY_CLOUD_RECEIPT_SCHEMA,
    task: bindComfyCloudTask(bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2'), row.upstreamId,
      { self: '/deployment/work/api/v2/jobs/original', cancel: '/deployment/work/api/v2/jobs/original/cancel' }),
    requestDigest: row.requestDigest, workflow: { templateHash: 'a'.repeat(64), executionHash: 'b'.repeat(64) },
    stillOutput: { version: 1, model: 'workflow', previewNodeIds: [], execution: { version: 1, automatic: true, maxImages: 1, expectedImages: 1, outputNodeIds: ['save'] } },
  };
  return state;
}

function withCloudIntent() {
  const state = cloudMetadata(), row = state.entries[0], receipt = row.cloudReceipt;
  const { version, provider, protocol, origin } = receipt.task;
  row.cloudIntent = { schema: COMFY_CLOUD_INTENT_SCHEMA, connection: { version, provider, protocol, origin },
    requestDigest: row.requestDigest, workflow: structuredClone(receipt.workflow), stillOutput: structuredClone(receipt.stillOutput) };
  return state;
}

const cloudActor = (handle = 'alice') => ({ user: { profile: { handle, enabled: true } } });
const cloudInput = (req, attemptId = 'cloud-once', apiKey = 'mock-cloud-key') => ({
  expectedAccount: imageServiceAccount(req).namespace, attemptId, apiKey, intent: withCloudIntent().entries[0].cloudIntent,
});

function cloudAccepted(reservation, taskId = 'original') {
  const { cloudIntent: intent } = reservation;
  return { schema: COMFY_CLOUD_RECEIPT_SCHEMA,
    task: bindComfyCloudTask(intent.connection, taskId, { self: `/api/v2/jobs/${taskId}`, cancel: `/api/v2/jobs/${taskId}/cancel` }),
    requestDigest: intent.requestDigest, workflow: intent.workflow, stillOutput: intent.stillOutput };
}

test('only unsent cloud reservations release; submitted and uncertain tasks remain fenced', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), ledger = createComfyCloudLedger({ store }), input = cloudInput(req), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await assert.rejects(ticket.markUncertain(), { code: 'image_service_cloud_ticket_changed' });
  req.user.profile.handle = 'bob'; await ticket.releaseUnsent(); req.user.profile.handle = 'alice';
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].status, 'released');
  await assert.rejects(ticket.beforeSubmit(), { code: 'image_service_cloud_ticket_changed' });
  const second = await ledger.reserve(req, cloudInput(req, 'second')), active = ledger.submission(second);
  await active.beforeSubmit(); await assert.rejects(active.releaseUnsent(), { code: 'image_service_cloud_ticket_changed' });
  await active.markUncertain();
  await assert.rejects(ledger.reserve(req, cloudInput(req, 'third')), { code: 'image_service_cloud_occupied' });
  await active.recordAccepted('original', cloudAccepted(second));
  const row = (await store.inspectChannel(second.channelKey)).entries[1];
  assert.equal(row.status, 'uncertain'); assert.equal(row.upstreamId, 'original');
});

test('a fresh cloud session queries only the original account, credential and exact task links', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); await ticket.recordAccepted('original', cloudAccepted(reservation));
  const nextStore = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => nextStore.close());
  const next = createComfyCloudLedger({ store: nextStore }), locator = { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey: input.apiKey }, task = cloudAccepted(reservation).task;
  const verify = await next.authorizeQuery(req, locator, task); await verify();
  const before = await nextStore.inspectChannel(reservation.channelKey);
  for (const [actor, target, original] of [[cloudActor('bob'), locator, task], [req, { ...locator, apiKey: 'another-key' }, task],
    [req, locator, cloudAccepted(reservation, 'another').task], [req, locator, bindComfyCloudTask(task, task.taskId, { self: '/deployment/other/api/v2/jobs/original', cancel: '/deployment/other/api/v2/jobs/original/cancel' })]]) {
    await assert.rejects(next.authorizeQuery(actor, target, original), { code: 'image_service_cloud_query_identity' });
  }
  assert.deepEqual(await nextStore.inspectChannel(reservation.channelKey), before, 'query grants are read-only');
});

test('cloud query grants recheck login and persistent fence while allowing ordinary status progress', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); await ticket.recordAccepted('original', cloudAccepted(reservation));
  const locator = { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey: input.apiKey };
  const verify = await ledger.authorizeQuery(req, locator, cloudAccepted(reservation).task);
  await ticket.markUncertain(); await verify();
  req.user.profile.handle = 'bob'; await assert.rejects(verify(), { code: 'image_service_cloud_account_changed' }); req.user.profile.handle = 'alice';
  await store.transaction(reservation.channelKey, state => { state.entries[0].fence = 'replaced'; return { state }; });
  await assert.rejects(verify(), { code: 'image_service_cloud_query_changed' });
});

test('cloud staging identity comes from the same original read and cannot recreate a submission ticket', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); await ticket.recordAccepted('original', cloudAccepted(reservation));
  const before = await store.inspectChannel(reservation.channelKey), next = createComfyCloudLedger({ store });
  const grant = await next.authorizeStaging(req, { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey: input.apiKey,
    namespace: 'forged', fence: 'forged', requestDigest: '0'.repeat(64) }, cloudAccepted(reservation).task);
  assert.deepEqual(grant.identity, { namespace: reservation.namespace, channelKey: reservation.channelKey, attemptId: reservation.attemptId,
    requestDigest: reservation.requestDigest, fence: reservation.fence });
  assert.ok(Object.isFrozen(grant)); assert.ok(Object.isFrozen(grant.identity)); assert.ok(Object.isFrozen(grant.receipt));
  assert.equal(await grant.verify(), grant.receipt);
  assert.equal(JSON.stringify(grant).includes(input.apiKey), false);
  assert.throws(() => next.submission(grant.identity), { code: 'image_service_cloud_ticket' });
  assert.deepEqual(await store.inspectChannel(reservation.channelKey), before, 'readback permission must not change paid task occupancy');
});

test('cloud staging grants retain their first fence across waits and never adopt a replacement record', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); await ticket.recordAccepted('original', cloudAccepted(reservation));
  const grant = await ledger.authorizeStaging(req, { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey: input.apiKey }, cloudAccepted(reservation).task);
  await ticket.markUncertain(); await grant.verify();
  req.user.profile.handle = 'bob'; await assert.rejects(grant.verify(), { code: 'image_service_cloud_account_changed' }); req.user.profile.handle = 'alice';
  await store.transaction(reservation.channelKey, state => { state.entries[0].fence = 'replacement'; return { state }; });
  assert.equal(grant.identity.fence, reservation.fence);
  await assert.rejects(grant.verify(), { code: 'image_service_cloud_query_changed' });
});

test('cloud staging rejects other accounts and ID-only evidence before returning any cache identity', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); await ticket.recordAccepted('original');
  const locator = { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey: input.apiKey }, task = cloudAccepted(reservation).task;
  await assert.rejects(ledger.authorizeStaging(req, locator, task), { code: 'image_service_cloud_query_identity' });
  await ticket.recordAccepted('original', cloudAccepted(reservation));
  await assert.rejects(ledger.authorizeStaging(cloudActor('bob'), locator, task), { code: 'image_service_cloud_query_identity' });
  await assert.rejects(ledger.authorizeStaging(req, { ...locator, apiKey: 'other-key' }, task), { code: 'image_service_cloud_query_identity' });
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].upstreamId, 'original');
});

test('known cloud id without complete trusted links cannot be queried by guessing a public route', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, input), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); await ticket.recordAccepted('original');
  await assert.rejects(ledger.authorizeQuery(req, { channelKey: reservation.channelKey, attemptId: reservation.attemptId, apiKey: input.apiKey }, cloudAccepted(reservation).task), { code: 'image_service_cloud_query_identity' });
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].upstreamId, 'original');
});

test('marking a cloud attempt uncertain while dispatch persistence is pending cannot grant late submission', async t => {
  const { root } = await fixture(t), entered = deferred(), gate = deferred(); let pause = false;
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud', fileSystem: { ...fs, rename: async (...args) => {
    if (pause) { pause = false; entered.resolve(); await gate.promise; } return fs.rename(...args);
  } } }); t.after(() => store.close());
  const req = cloudActor(), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, cloudInput(req)), ticket = ledger.submission(reservation);
  pause = true; const begin = ticket.beforeSubmit(); await entered.promise;
  const stopped = ticket.markUncertain(); gate.resolve();
  const results = await Promise.allSettled([begin, stopped]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, 'image_service_cloud_ticket_changed');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].status, 'uncertain');
  await assert.rejects(ticket.recordAccepted('original'), { code: 'image_service_cloud_ticket' });
});

test('cloud submission is single-use, persistent before dispatch and cannot be recreated from serialized tickets', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, cloudInput(req));
  assert.throws(() => ledger.submission(structuredClone(reservation)), { code: 'image_service_cloud_ticket' });
  assert.throws(() => createComfyCloudLedger({ store }).submission(reservation), { code: 'image_service_cloud_ticket' });
  const ticket = ledger.submission(reservation); assert.equal(ticket, ledger.submission(reservation));
  await assert.rejects(ticket.recordAccepted('original'), { code: 'image_service_cloud_ticket' });
  const results = await Promise.allSettled([ticket.beforeSubmit(), ticket.beforeSubmit()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].status, 'submitting');
  await ticket.recordAccepted('original', cloudAccepted(reservation));
  const row = (await store.inspectChannel(reservation.channelKey)).entries[0];
  assert.equal(row.status, 'submitting', 'acceptance is not completion'); assert.equal(row.cloudReceipt.task.taskId, 'original');
});

test('cloud acceptance survives login change, malformed receipt and later completion of missing evidence', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, cloudInput(req)), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); req.user.profile.handle = 'bob';
  await assert.rejects(ticket.recordAccepted('original', {}), { code: 'image_service_cloud_acceptance_unconfirmed', submissionState: 'accepted', upstreamId: 'original' });
  let row = (await store.inspectChannel(reservation.channelKey)).entries[0];
  assert.equal(row.upstreamId, 'original'); assert.equal(row.namespace, reservation.namespace); assert.equal(row.cloudReceipt, undefined);
  await ticket.recordAccepted('original', cloudAccepted(reservation));
  row = (await store.inspectChannel(reservation.channelKey)).entries[0]; assert.ok(row.cloudReceipt);
  await assert.rejects(ticket.recordAccepted('another', cloudAccepted(reservation, 'another')), { code: 'image_service_cloud_acceptance_unconfirmed' });
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].upstreamId, 'original');
});

test('changing a durable owner, fence, digest or intent revokes old cloud submission authority', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  for (const field of ['ownerId', 'fence', 'requestDigest', 'cloudIntent']) {
    const req = cloudActor(), ledger = createComfyCloudLedger({ store }), input = cloudInput(req, field, `mock-${field}`), reservation = await ledger.reserve(req, input);
    await store.transaction(reservation.channelKey, state => {
      const row = state.entries[0];
      if (field === 'requestDigest') { row.requestDigest = 'e'.repeat(64); row.cloudIntent = { ...row.cloudIntent, requestDigest: row.requestDigest }; }
      else if (field === 'cloudIntent') row.cloudIntent = { ...row.cloudIntent, workflow: { ...row.cloudIntent.workflow, executionHash: 'e'.repeat(64) } };
      else row[field] = 'replaced';
      return { state };
    });
    await assert.rejects(ledger.submission(reservation).beforeSubmit(), { code: 'image_service_cloud_ticket_changed' });
  }
});

test('cloud login change before dispatch blocks authority; accepted-id write failure is never not-submitted', async t => {
  const { root } = await fixture(t); let failWrite = false;
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud', fileSystem: { ...fs, rename: async (...args) => { if (failWrite) throw Object.assign(Error('private path'), { code: 'EIO' }); return fs.rename(...args); } } }); t.after(() => store.close());
  const req = cloudActor(), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, cloudInput(req));
  req.user.profile.handle = 'bob';
  await assert.rejects(ledger.submission(reservation).beforeSubmit(), { code: 'image_service_cloud_account_changed' });
  req.user.profile.handle = 'alice'; const ticket = ledger.submission(reservation); await ticket.beforeSubmit();
  failWrite = true;
  await assert.rejects(ticket.recordAccepted('original', cloudAccepted(reservation)), error => error.code === 'image_service_cloud_acceptance_unconfirmed' && error.submissionState === 'accepted' && error.upstreamId === 'original' && !error.message.includes('private path'));
  failWrite = false;
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].status, 'submitting');
  await ticket.recordAccepted('original', cloudAccepted(reservation));
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].upstreamId, 'original');
});

test('interruption between accepted id and full receipt writes preserves recovery evidence after reopening', async t => {
  const { root } = await fixture(t); let acceptedWrites = 0, failReceipt = false;
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud', fileSystem: { ...fs, rename: async (...args) => {
    if (failReceipt && ++acceptedWrites === 2) throw Object.assign(Error('interrupted'), { code: 'EIO' });
    return fs.rename(...args);
  } } }); t.after(() => store.close());
  const req = cloudActor(), ledger = createComfyCloudLedger({ store }), reservation = await ledger.reserve(req, cloudInput(req)), ticket = ledger.submission(reservation);
  await ticket.beforeSubmit(); failReceipt = true;
  await assert.rejects(ticket.recordAccepted('original', cloudAccepted(reservation)), { code: 'image_service_cloud_acceptance_unconfirmed', submissionState: 'accepted' });
  const next = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => next.close());
  const row = (await next.inspectChannel(reservation.channelKey)).entries[0];
  assert.equal(row.upstreamId, 'original'); assert.equal(row.cloudReceipt, undefined); assert.equal(row.status, 'submitting');
  await assert.rejects(createComfyCloudLedger({ store: next }).reserve(req, cloudInput(req, 'not-a-retry')), { code: 'image_service_cloud_occupied' });
});

test('cloud resource scope separates actual keys and origins, never stores the credential', () => {
  const connection = withCloudIntent().entries[0].cloudIntent.connection;
  const original = comfyCloudResourceKey(connection, 'mock-cloud-key'); assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(original, comfyCloudResourceKey(structuredClone(connection), 'mock-cloud-key'));
  assert.notEqual(original, comfyCloudResourceKey(connection, 'another-key'));
  assert.notEqual(original, comfyCloudResourceKey(bindComfyCloudProtocol('https://dep.run.comfy.app', connection.protocol), 'mock-cloud-key'));
  for (const key of ['', ' key ', 'a\nb', 'k'.repeat(2049)]) assert.throws(() => comfyCloudResourceKey(connection, key), { code: 'image_service_cloud_key' });
});

test('cloud reservation is durable before return and never authorizes replay across service restarts', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const req = cloudActor(), input = cloudInput(req), ledger = createComfyCloudLedger({ store, ownerId: 'first-owner' });
  const reservation = await ledger.reserve(req, input);
  assert.equal(Object.isFrozen(reservation), true); assert.equal(reservation.status, 'reserved');
  assert.equal((await store.inspectChannel(reservation.channelKey)).entries[0].fence, reservation.fence);
  const contents = await fs.readFile(path.join(root, '.qianmu-service', 'comfy-cloud-queue-v1', `${reservation.channelKey}.json`), 'utf8');
  assert.doesNotMatch(contents, /mock-cloud-key|apiKey/);
  const nextStore = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => nextStore.close());
  const next = createComfyCloudLedger({ store: nextStore, ownerId: 'new-owner' });
  await assert.rejects(next.reserve(req, input), { code: 'image_service_cloud_duplicate' });
  const changed = structuredClone(input); changed.intent.requestDigest = 'f'.repeat(64);
  await assert.rejects(next.reserve(req, changed), { code: 'image_service_cloud_conflict' });
  assert.equal((await nextStore.inspectChannel(reservation.channelKey)).entries.length, 1);
  await nextStore.transaction(reservation.channelKey, state => { state.entries[0].status = 'uncertain'; return { state }; });
  await assert.rejects(next.reserve(req, cloudInput(req, 'new-attempt')), { code: 'image_service_cloud_occupied' });
});

test('shared cloud keys fence different ST users while separate keys remain independent', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const ledger = createComfyCloudLedger({ store }), alice = cloudActor(), bob = cloudActor('bob');
  const results = await Promise.allSettled([ledger.reserve(alice, cloudInput(alice)), ledger.reserve(bob, cloudInput(bob))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'image_service_cloud_occupied');
  assert.equal((await ledger.reserve(bob, cloudInput(bob, 'independent', 'another-key'))).status, 'reserved');
});

test('cloud reservation rejects missing host identity, foreign recipe or storage without creating records', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  assert.throws(() => createComfyCloudLedger(), { code: 'image_service_cloud_storage' });
  const ledger = createComfyCloudLedger({ store }), req = cloudActor(), input = cloudInput(req);
  await assert.rejects(ledger.reserve({}, input), { code: 'image_service_authentication_required' });
  await assert.rejects(ledger.reserve(cloudActor('other'), input), { code: 'image_service_cloud_identity' });
  const foreign = structuredClone(input); foreign.intent.workflow.binding = { schemaVersion: 1, namespace: imageServiceAccount(cloudActor('other')).namespace, id: 'recipe', revision: 'r', version: 1, name: 'Saved', workflowHash: 'a'.repeat(64), recipeHash: 'd'.repeat(64) };
  await assert.rejects(ledger.reserve(req, foreign), { code: 'image_service_cloud_identity' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('an account switch after durable reservation cannot receive the ticket or erase original ownership', async t => {
  const { root } = await fixture(t), req = cloudActor(), input = cloudInput(req);
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud', fileSystem: { ...fs, rename: async (...args) => { await fs.rename(...args); req.user.profile.handle = 'bob'; } } }); t.after(() => store.close());
  await assert.rejects(createComfyCloudLedger({ store }).reserve(req, input), { code: 'image_service_cloud_account_changed' });
  const state = await store.inspectChannel(comfyCloudResourceKey(input.intent.connection, input.apiKey));
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].namespace, input.expectedAccount);
  assert.equal(state.entries[0].status, 'reserved');
});

test('cloud reservation does not return a ticket when durable write fails', async t => {
  const { root } = await fixture(t), req = cloudActor(), input = cloudInput(req);
  const store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud', fileSystem: { ...fs, rename: async () => { throw Object.assign(Error('private path'), { code: 'EIO' }); } } }); t.after(() => store.close());
  await assert.rejects(createComfyCloudLedger({ store }).reserve(req, input), { code: 'image_service_storage_unavailable' });
  assert.equal(await store.inspectChannel(comfyCloudResourceKey(input.intent.connection, input.apiKey)), undefined);
});

test('a cloud reservation needs pre-submit intent and accepted evidence must agree with it after reopen', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  const state = withCloudIntent(); state.entries[0].status = 'reserved'; delete state.entries[0].upstreamId; delete state.entries[0].cloudReceipt;
  const missing = structuredClone(state); delete missing.entries[0].cloudIntent;
  await assert.rejects(store.transaction(key, () => ({ state: missing })), { code: 'image_service_cloud_state' });
  await store.transaction(key, () => ({ state }));
  const next = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => next.close());
  assert.deepEqual(await next.inspectChannel(key), state);
  await next.transaction(key, () => ({ state: withCloudIntent() }));
  assert.deepEqual(await store.inspectChannel(key), withCloudIntent());
  const mismatch = withCloudIntent(); mismatch.entries[0].cloudReceipt.stillOutput.execution.outputNodeIds = ['other'];
  await assert.rejects(store.transaction(key, () => ({ state: mismatch })), { code: 'image_service_cloud_state' });
  assert.deepEqual(await next.inspectChannel(key), withCloudIntent());
});

test('pre-submit intent must match owning row, and historical uncertain records never gain an invented intent', () => {
  for (const change of [s => { s.entries[0].cloudIntent.requestDigest = 'f'.repeat(64); },
    s => { s.entries[0].automatic = false; }, s => { s.entries[0].cloudIntent = undefined; },
    s => { s.entries[0].cloudIntent.workflow.executionHash = 'e'.repeat(64); }]) {
    const state = withCloudIntent(); change(state);
    assert.throws(() => normalizeComfyCloudChannel(state, key), { code: 'image_service_cloud_state' });
  }
  const old = normalizeComfyCloudChannel(cloudMetadata(), key);
  assert.equal(Object.hasOwn(old.entries[0], 'cloudIntent'), false);
  assert.equal(old.entries[0].status, 'uncertain');
});

test('cloud scope round-trips accepted evidence after reopening without touching native records', async t => {
  const { root, store, directory } = await fixture(t);
  await store.transaction(key, () => ({ state: metadata() }));
  const original = await fs.readFile(path.join(directory, `${key}.json`), 'utf8');
  const cloud = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => cloud.close());
  assert.equal(cloud.inspect().initialized, false);
  assert.deepEqual(await cloud.inspectAccount('account-a'), { entries: [], selected: [], total: 0, nextCursor: null });
  await cloud.transaction(key, () => ({ state: cloudMetadata(), result: 'durable' }));
  await cloud.close();
  const reopened = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.inspectChannel(key), cloudMetadata());
  assert.equal((await reopened.inspectAccount('account-a')).entries[0].cloudReceipt.task.taskId, 'original');
  assert.equal((await reopened.inspectAccount('account-b')).total, 0);
  assert.equal(await fs.readFile(path.join(directory, `${key}.json`), 'utf8'), original);
  assert.deepEqual(await store.inspectChannel(key), metadata());
  assert.ok((await fs.readdir(path.join(root, '.qianmu-service', 'comfy-cloud-queue-v1'))).includes(`${key}.json`));
});

test('cloud format rejects legacy, future, credential and native-only fields before disk replacement', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  await store.transaction(key, () => ({ state: cloudMetadata() }));
  const target = path.join(root, '.qianmu-service', 'comfy-cloud-queue-v1', `${key}.json`), original = await fs.readFile(target, 'utf8');
  const changed = patch => { const state = cloudMetadata(); patch(state); return state; };
  for (const state of [metadata(), changed(s => { s.schema = 'qianmu.comfy-cloud-channel.v2'; }),
    changed(s => { s.apiKey = 'mock-secret'; }), changed(s => { s.entries[0].apiKey = 'mock-secret'; }),
    changed(s => { s.entries[0].comfyReceipt = s.entries[0].cloudReceipt.stillOutput; }),
    changed(s => { s.entries[0].nativeReceipt = {}; }), changed(s => { s.entries[0].cloudReceipt = undefined; })]) {
    await assert.rejects(store.transaction(key, () => ({ state })), { code: 'image_service_cloud_state' });
    assert.equal(await fs.readFile(target, 'utf8'), original);
  }
  assert.throws(() => createImageServiceStore({ dataRoot: root, scope: '../comfy-cloud-queue-v1' }), { code: 'image_service_storage_scope' });
});

test('cloud row cannot attach another request receipt or silently switch automatic output policy', () => {
  for (const patch of [s => { s.entries[0].upstreamId = 'other'; }, s => { s.entries[0].requestDigest = 'e'.repeat(64); },
    s => { s.entries[0].automatic = false; }, s => { s.entries[0].status = 'reserved'; },
    s => { s.entries[0].cloudReceipt.workflow.binding = { schemaVersion: 1, namespace: 'st-user:someone-else', id: 'recipe', revision: 'r', version: 1, name: 'Saved', workflowHash: 'a'.repeat(64), recipeHash: 'd'.repeat(64) }; },
    s => { s.entries.push(structuredClone(s.entries[0])); }, s => { s.entries.length = 2; }]) {
    const state = cloudMetadata(); patch(state); assert.throws(() => normalizeComfyCloudChannel(state, key), { code: 'image_service_cloud_state' });
  }
  assert.deepEqual(normalizeComfyCloudChannel(undefined, key), { schema: COMFY_CLOUD_CHANNEL_SCHEMA, channelKey: key, entries: [] });
});

test('incomplete acceptance retains original id as uncertain and cannot become verified success', () => {
  const state = cloudMetadata(); delete state.entries[0].cloudReceipt;
  assert.equal(normalizeComfyCloudChannel(state, key).entries[0].upstreamId, 'original');
  state.entries[0].status = 'succeeded';
  assert.throws(() => normalizeComfyCloudChannel(state, key), { code: 'image_service_cloud_state' });
  assert.throws(() => normalizeImageServiceChannel(cloudMetadata(), key), { code: 'image_service_state' });
});

test('native queue cannot accidentally execute or settle an existing cloud task', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' });
  const queue = createImageServiceQueue({ store }); t.after(async () => { queue.close(); await store.close(); });
  await store.transaction(key, () => ({ state: cloudMetadata() }));
  await assert.rejects(queue.run(args('first'), never), { code: 'image_service_state' });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'uncertain');
});

test('failed cloud replacement keeps prior accepted task readable through another instance', async t => {
  const { root } = await fixture(t), store = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => store.close());
  await store.transaction(key, () => ({ state: cloudMetadata() }));
  const broken = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud', fileSystem: { ...fs, rename: async () => { throw Object.assign(Error('private path'), { code: 'EIO' }); } } }); t.after(() => broken.close());
  await assert.rejects(broken.transaction(key, state => { state.entries[0].updatedAt = 2; return { state }; }), { code: 'image_service_storage_unavailable' });
  const next = createImageServiceStore({ dataRoot: root, scope: 'comfy-cloud' }); t.after(() => next.close());
  assert.deepEqual(await next.inspectChannel(key), cloudMetadata());
});

test('private store is lazy and rejects untrusted roots and channel path traversal', async t => {
  for (const dataRoot of [undefined, '', '.', '/', path.parse(process.cwd()).root, 'a\0b']) assert.throws(() => createImageServiceStore({ dataRoot }), { code: 'image_service_storage_root' });
  const { root, store } = await fixture(t);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(store.inspect().initialized, false);
  for (const invalid of ['../../secrets', 'key', 'f'.repeat(65), key.toUpperCase()]) await assert.rejects(store.transaction(invalid, never), { code: 'image_service_storage_identity' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('atomic metadata survives another store instance without persisting credentials, prompts or media', async t => {
  const { root, store, directory } = await fixture(t);
  assert.equal(await store.transaction(key, () => ({ state: { ...metadata(), apiKey: request.apiKey, prompt: 'private-text', image: 'private-image' }, result: 'committed' })), 'committed');
  assert.deepEqual(await fs.readdir(directory), [`${key}.json`]);
  const text = await fs.readFile(path.join(directory, `${key}.json`), 'utf8');
  assert.doesNotMatch(text, /mock-persistence-key|private-text|private-image|apiKey/);
  const next = createImageServiceStore({ dataRoot: root }); t.after(() => next.close());
  assert.deepEqual(await next.inspectChannel(key), metadata());
  assert.deepEqual(await next.transaction(key, state => ({ state, result: state.entries[0].attemptId })), 'first');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, `${key}.json`), 'utf8')).revision, 2);
});

test('completed real adapter requests remain non-replayable after reopening the disk store', async t => {
  const { root, store } = await fixture(t), queue = createImageServiceQueue({ store }); let posts = 0;
  const result = await queue.run(args('once'), ticket => generateImage(request, {
    beforeSubmit: ticket.beforeSubmit, resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => {
      assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting'); posts++;
      return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=' }] }), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  assert.ok(result); assert.equal(posts, 1); queue.close(); await store.close();
  const reopened = createImageServiceStore({ dataRoot: root }), next = createImageServiceQueue({ store: reopened });
  t.after(async () => { next.close(); await reopened.close(); });
  await assert.rejects(next.run(args('once'), never), { code: 'image_service_already_finished' });
  assert.equal((await reopened.inspectChannel(key)).entries[0].status, 'succeeded');
});

test('same-process transactions serialize and return only after disk commit', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.transaction(key, previous => {
    const state = previous || normalizeImageServiceChannel(undefined, key);
    const row = metadata(`request-${n}`).entries[0]; row.status = 'succeeded'; state.entries.push(row);
    return { state, result: n };
  })));
  assert.equal((await store.inspectChannel(key)).entries.length, 12);
  assert.equal(store.inspect().pending, 0);
});

test('two store instances cannot enter the same disk transaction at once', async t => {
  const { root, directory } = await fixture(t), gate = deferred(), acquired = deferred();
  const slow = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, rename: async (...input) => { acquired.resolve(); await gate.promise; return fs.rename(...input); } } });
  const other = createImageServiceStore({ dataRoot: root }); t.after(async () => { await slow.close(); await other.close(); });
  const first = slow.transaction(key, () => ({ state: metadata() })); await acquired.promise;
  await assert.rejects(other.transaction(key, never), { code: 'image_service_storage_busy' });
  assert.ok((await fs.readdir(directory)).includes('.transaction.lock'));
  gate.resolve(); await first;
  await other.transaction(key, state => ({ state }));
});

test('a real process exit after submit leaves a persistent fence and never authorizes an automatic retry', async t => {
  const { root, store } = await fixture(t);
  await child(`import {createImageServiceStore} from ${JSON.stringify(storeUrl)};
    import {createImageServiceQueue} from ${JSON.stringify(queueUrl)};
    const store=createImageServiceStore({dataRoot:${JSON.stringify(root)}}), queue=createImageServiceQueue({store});
    await queue.run(${JSON.stringify(args('crashed'))}, async ticket=>{await ticket.beforeSubmit();process.exit(0)});`);
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting');
  const queue = createImageServiceQueue({ store }); t.after(() => queue.close());
  await assert.rejects(queue.run(args('after-restart'), never), { code: 'image_service_busy' });
});

test('crash during an atomic write leaves evidence and is not reset by a fresh session', async t => {
  const { root, store, directory } = await fixture(t);
  await child(`import * as fs from 'node:fs/promises';import {createImageServiceStore} from ${JSON.stringify(storeUrl)};
    const store=createImageServiceStore({dataRoot:${JSON.stringify(root)},fileSystem:{...fs,rename:async()=>process.exit(0)}});
    await store.transaction(${JSON.stringify(key)},()=>({state:${JSON.stringify(metadata())}}));`);
  const before = await fs.readdir(directory);
  assert.ok(before.includes('.transaction.lock')); assert.ok(before.some(name => name.endsWith('.tmp')));
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_busy' });
  assert.deepEqual(await fs.readdir(directory), before, 'stale lock and staged metadata are not silently swept');
});

test('invalid JSON, checksum mismatch and null records cannot be treated as an empty database', async t => {
  const { root, directory, store } = await fixture(t);
  await store.transaction(key, () => ({ state: metadata() }));
  const target = path.join(directory, `${key}.json`), original = await fs.readFile(target, 'utf8');
  for (const body of ['null', '{', '{}', original.replace('submitting', 'succeeded')]) {
    await fs.writeFile(target, body);
    const next = createImageServiceStore({ dataRoot: root }); t.after(() => next.close());
    await assert.rejects(next.transaction(key, never), { code: 'image_service_storage_corrupt' });
    assert.equal(await fs.readFile(target, 'utf8'), body);
  }
});

test('directory junctions and hard-linked records are refused without touching the target', async t => {
  const { root, store, directory } = await fixture(t);
  const elsewhere = path.join(root, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(root, '.qianmu-service'), 'junction');
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_path' });
  assert.deepEqual(await fs.readdir(elsewhere), []);
  await fs.unlink(path.join(root, '.qianmu-service'));
  const safe = createImageServiceStore({ dataRoot: root }); t.after(() => safe.close());
  await safe.transaction(key, () => ({ state: metadata() }));
  await fs.link(path.join(directory, `${key}.json`), path.join(elsewhere, 'same-data.json'));
  await assert.rejects(safe.transaction(key, never), { code: 'image_service_storage_record' });
});

test('reducer failure and failed atomic rename retain the old record with no orphan temporary file', async t => {
  const { root, store, directory } = await fixture(t);
  await store.transaction(key, () => ({ state: metadata() }));
  const before = await fs.readFile(path.join(directory, `${key}.json`), 'utf8');
  await assert.rejects(store.transaction(key, state => { state.entries = []; throw Error('sensitive path /test'); }), { code: 'image_service_storage_unavailable' });
  const broken = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, rename: async () => { throw Object.assign(Error('secret filename'), { code: 'EIO' }); } } });
  t.after(() => broken.close());
  await assert.rejects(broken.transaction(key, () => ({ state: metadata('new') })), cause => cause.code === 'image_service_storage_unavailable' && !cause.message.includes('secret'));
  assert.equal(await fs.readFile(path.join(directory, `${key}.json`), 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), [`${key}.json`]);
});

test('failure after atomic rename cannot grant authorization even if the new record reached disk', async t => {
  const { root, store } = await fixture(t);
  const faulty = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, rename: async (...input) => { await fs.rename(...input); throw Error('lost completion'); } } });
  t.after(() => faulty.close());
  const queue = createImageServiceQueue({ store: faulty }); t.after(() => queue.close());
  await assert.rejects(queue.run(args('ambiguous-save'), never), { code: 'image_service_storage_unavailable' });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'reserved');
  const next = createImageServiceQueue({ store }); t.after(() => next.close());
  await assert.rejects(next.run(args('next'), never), { code: 'image_service_busy' });
});

test('channel and byte caps never evict historical records to admit more work', async t => {
  const { root, directory } = await fixture(t);
  const store = createImageServiceStore({ dataRoot: root, maxChannels: 1, maxRecordBytes: 1024 }); t.after(() => store.close());
  await store.transaction(key, () => ({ state: metadata() }));
  const second = imageServiceChannelKey('different');
  await assert.rejects(store.transaction(second, () => ({ state: normalizeImageServiceChannel(undefined, second) })), { code: 'image_service_storage_full' });
  await assert.rejects(store.transaction(key, state => { for (let n = 0; n < 10; n++) { const row = metadata(`more-${n}`).entries[0]; row.status = 'succeeded'; state.entries.push(row); } return { state }; }), { code: 'image_service_storage_full' });
  assert.equal((await store.inspectChannel(key)).entries.length, 1);
  assert.deepEqual(await fs.readdir(directory), [`${key}.json`]);
});

test('bounded waiting and closing reject unsent mutations without abandoning an active disk commit', async t => {
  const { root } = await fixture(t), gate = deferred(), entered = deferred();
  const store = createImageServiceStore({ dataRoot: root, maxPending: 2, fileSystem: { ...fs, rename: async (...input) => { entered.resolve(); await gate.promise; return fs.rename(...input); } } });
  const active = store.transaction(key, () => ({ state: metadata(), result: 'saved' })); await entered.promise;
  const waiting = store.transaction(key, never);
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_busy' });
  const closing = store.close(); gate.resolve();
  assert.equal(await active, 'saved'); await assert.rejects(waiting, { code: 'image_service_storage_closed' }); await closing;
  assert.equal(store.inspect().pending, 0);
});

test('private metadata is only constructed through the task service and the release includes recovery', async () => {
  assert.doesNotMatch(await fs.readFile(new URL('../server-plugin.js', import.meta.url), 'utf8'), /createImageServiceStore/);
  const source = await fs.readFile(new URL('../qianmu-image-service.js', import.meta.url), 'utf8');
  assert.match(source, /createImageServiceStore/);
  assert.match(await fs.readFile(new URL('../release-files.json', import.meta.url), 'utf8'), /qianmu-image-service-store/);
});

test('reading absent metadata does not create a service database', async t => {
  const { store, root } = await fixture(t);
  assert.equal(await store.inspectChannel(key), undefined);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(store.inspect().initialized, false);
  await store.transaction(key, () => ({ state: metadata() }));
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting');
});

test('maintenance fencing prevents both new transactions and the pre-lock race while allowing read-only inspection', async t => {
  const { store, root, directory } = await fixture(t);
  await store.transaction(key, () => ({ state: metadata() }));
  const maintenance = path.join(directory, '.maintenance.lock');
  await fs.writeFile(maintenance, 'offline maintenance');
  await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_maintenance' });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting');
  await fs.unlink(maintenance);
  const racing = createImageServiceStore({ dataRoot: root, fileSystem: { ...fs, open: async (target, ...rest) => {
    const handle = await fs.open(target, ...rest);
    if (target.endsWith('.transaction.lock')) await fs.writeFile(maintenance, 'maintenance started after initial check');
    return handle;
  } } }); t.after(() => racing.close());
  await assert.rejects(racing.transaction(key, never), { code: 'image_service_storage_maintenance' });
  assert.ok(!(await fs.readdir(directory)).includes('.transaction.lock'));
  assert.equal(await fs.readFile(maintenance, 'utf8'), 'maintenance started after initial check');
});
