import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createStoryboardServerBatchStore } from '../qianmu-storyboard-server-batch-store.js';
import { uid } from '../qianmu-storyboard-utils.js';

const request = (handle = 'alice') => ({ user: { profile: { handle, enabled: true } } });
const hash = letter => letter.repeat(64);
const manifest = (count = 13, batchId = randomUUID()) => ({
  version: 1, batchId, requestedMode: 'automatic',
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: hash('a'), floor: 12, sourceDigest: hash('b'), originPlanId: uid('story') },
  planDigest: hash('c'), routeDigest: hash('d'),
  shots: Array.from({ length: count }, (_, index) => ({
    shotId: uid('shotdraft'), attemptId: uid('shotjob'), contentDigest: hash('e'),
    shotIndex: index, requestIndex: 1,
  })),
});

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-ledger-test-'));
  const store = createStoryboardServerBatchStore({ dataRoot: root, now: () => 1000 });
  t.after(async () => {
    await store.close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-ledger-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  return { root, store };
}

test('read-only missing query does not initialize storage or reveal another account', async t => {
  const { root, store } = await fixture(t);
  const input = manifest(21);
  assert.equal(await store.query(request(), input.batchId), null);
  await assert.rejects(fs.lstat(path.join(root, '.qianmu-service')), { code: 'ENOENT' });
  const saved = await store.prepare(request(), input);
  assert.equal(saved.state, 'prepared_unrunnable');
  assert.equal(saved.stateRevision, 1);
  assert.equal(saved.shotCount, 21);
  assert.equal(await store.query(request('bob'), input.batchId), null);
  await assert.rejects(store.stop(request('bob'), input.batchId, 1), { code: 'storyboard_server_batch_not_found' });
  assert.deepEqual(await store.query(request(), input.batchId), saved);
});

test('same batch and digest are idempotent without revision churn; changed content conflicts', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  const first = await store.prepare(req, input);
  const second = await store.prepare(req, structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(second.stateRevision, 1);
  await assert.rejects(store.prepare(req, { ...input, planDigest: hash('f') }), {
    code: 'storyboard_server_batch_conflict',
  });
  assert.deepEqual(await store.query(req, input.batchId), first);
  const directory = path.join(root, '.qianmu-service', 'storyboard-batches-v1');
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const bytes = await fs.readFile(path.join(directory, files[0]), 'utf8');
  assert.equal(bytes.includes('apiKey'), false);
  assert.equal(bytes.includes('prompt'), false);
});

test('stop is CAS, sticky, survives a fresh session, and never revives on prepare retry', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  const prepared = await store.prepare(req, input);
  await assert.rejects(store.stop(req, input.batchId, 2), { code: 'storyboard_server_batch_revision' });
  const stopped = await store.stop(req, input.batchId, prepared.stateRevision);
  assert.equal(stopped.state, 'stopped_unrunnable');
  assert.equal(stopped.stateRevision, 2);
  assert.equal(stopped.stoppedAt, 1000);
  assert.deepEqual(await store.stop(req, input.batchId, 1), stopped);
  assert.deepEqual(await store.prepare(req, input), stopped);
  const next = createStoryboardServerBatchStore({ dataRoot: root, now: () => 2000 });
  t.after(() => next.close());
  assert.deepEqual(await next.query(req, input.batchId), stopped);
});

test('private or unknown manifest fields fail before any persisted batch exists', async t => {
  const { store } = await fixture(t), req = request(), input = manifest();
  await assert.rejects(store.prepare(req, { ...input, apiKey: 'do-not-save' }), {
    code: 'storyboard_server_batch_contract',
  });
  assert.equal(await store.query(req, input.batchId), null);
  await assert.rejects(store.prepare({ user: null }, input), { code: 'image_service_authentication_required' });
  assert.equal(await store.query(req, input.batchId), null);
});

test('switching accounts cannot query an existing batch or duplicate its ownership', async t => {
  const { store } = await fixture(t), req = request(), input = manifest();
  const prepared = await store.prepare(req, input);
  req.user.profile.handle = 'bob';
  assert.equal(await store.query(req, input.batchId), null);
  req.user.profile.handle = 'alice';
  assert.deepEqual(await store.query(req, input.batchId), prepared);
});

test('a queued prepare refuses an account switch before its transaction commits', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fakeStore = {
    async transaction(_key, reduce) { await gate; return reduce(undefined).result; },
    async inspectChannel() { return undefined; },
    async close() {},
  };
  const store = createStoryboardServerBatchStore({ store: fakeStore, now: () => 1000 });
  const req = request(), input = manifest();
  const pending = store.prepare(req, input);
  req.user.profile.handle = 'bob';
  release();
  await assert.rejects(pending, { code: 'storyboard_server_batch_account_changed' });
});

test('a lost reply after prepare does not authorize the new account to inspect the original batch', async () => {
  const req = request(), input = manifest();
  let saved;
  const fakeStore = {
    async transaction(_key, reduce) {
      const result = reduce(saved);
      saved = result.state;
      req.user.profile.handle = 'bob';
      return result.result;
    },
    async inspectChannel() { return saved; },
    async close() {},
  };
  const store = createStoryboardServerBatchStore({ store: fakeStore, now: () => 1000 });
  await assert.rejects(store.prepare(req, input), { code: 'storyboard_server_batch_account_changed' });
  req.user.profile.handle = 'alice';
  assert.equal((await store.query(req, input.batchId)).state, 'prepared_unrunnable');
});

test('metadata capacity refuses a second batch without evicting the first or blocking its idempotent retry', async t => {
  const { root } = await fixture(t);
  const storage = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch', maxChannels: 1 });
  const store = createStoryboardServerBatchStore({ store: storage, now: () => 1000 });
  t.after(() => store.close());
  const req = request(), first = manifest(), second = manifest();
  const accepted = await store.prepare(req, first);
  await assert.rejects(store.prepare(req, second), { code: 'image_service_storage_full' });
  assert.deepEqual(await store.query(req, first.batchId), accepted);
  assert.deepEqual(await store.prepare(req, first), accepted);
  assert.equal(await store.query(req, second.batchId), null);
});
