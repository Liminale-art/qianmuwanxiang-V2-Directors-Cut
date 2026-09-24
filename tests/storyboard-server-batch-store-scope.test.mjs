import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { normalizeImageServiceChannel } from '../qianmu-image-service-queue.js';
import { createStoryboardServerBatchBusinessError, normalizePreparedBatch, storyboardServerBatchKey } from '../qianmu-storyboard-server-batch-contract.js';
import { uid } from '../qianmu-storyboard-utils.js';

const ACCOUNT = `st-user:${'e'.repeat(64)}`;
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const prepared = () => ({
  version: 1,
  batchId: BATCH_ID,
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: 'a'.repeat(64), floor: 42, sourceDigest: 'b'.repeat(64), originPlanId: uid('story') },
  requestedMode: 'automatic',
  planDigest: 'c'.repeat(64),
  routeDigest: 'd'.repeat(64),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: 'f'.repeat(64) }],
});
const KEY = storyboardServerBatchKey(ACCOUNT, BATCH_ID);

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-store-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-store-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  return { root, batchDirectory: path.join(root, '.qianmu-service', 'storyboard-batches-v1'),
    nativeDirectory: path.join(root, '.qianmu-service', 'image-queue-v1') };
}

test('batch scope stays lazy and uses its own closed directory without touching the native scope', async t => {
  const { root, batchDirectory, nativeDirectory } = await fixture(t);
  const batch = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  const native = createImageServiceStore({ dataRoot: root });
  t.after(async () => { await batch.close(); await native.close(); });
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await batch.inspectChannel(KEY), undefined);
  assert.deepEqual(await fs.readdir(root), [], 'absent batch reads must not create a database');

  const nativeState = normalizeImageServiceChannel(undefined, KEY);
  await native.transaction(KEY, () => ({ state: nativeState }));
  const nativeBytes = await fs.readFile(path.join(nativeDirectory, `${KEY}.json`), 'utf8');
  const batchState = normalizePreparedBatch(prepared(), ACCOUNT, 1000);
  await batch.transaction(KEY, () => ({ state: batchState }));

  assert.deepEqual(await batch.inspectChannel(KEY), batchState);
  assert.deepEqual(await native.inspectChannel(KEY), nativeState);
  assert.equal(await fs.readFile(path.join(nativeDirectory, `${KEY}.json`), 'utf8'), nativeBytes);
  assert.deepEqual(await fs.readdir(batchDirectory), [`${KEY}.json`]);
  assert.throws(() => createImageServiceStore({ dataRoot: root, scope: 'storyboard-batches-v1' }), { code: 'image_service_storage_scope' });
});

test('batch transactions commit atomically and reopen from the same scoped record', async t => {
  const { root, batchDirectory } = await fixture(t);
  const batch = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  const state = normalizePreparedBatch(prepared(), ACCOUNT, 1000);
  assert.equal(await batch.transaction(KEY, () => ({ state, result: 'committed' })), 'committed');
  const envelope = JSON.parse(await fs.readFile(path.join(batchDirectory, `${KEY}.json`), 'utf8'));
  assert.equal(envelope.revision, 1);
  assert.equal(envelope.channelKey, KEY);
  assert.deepEqual(envelope.state, state);
  await batch.close();

  const reopened = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.inspectChannel(KEY), state);
  assert.equal((await reopened.inspectChannel(KEY)).state, 'prepared_unrunnable');
});

test('failed batch replacement preserves the original durable record for a fresh store', async t => {
  const { root, batchDirectory } = await fixture(t);
  const original = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  t.after(() => original.close());
  const state = normalizePreparedBatch(prepared(), ACCOUNT, 1000);
  await original.transaction(KEY, () => ({ state }));
  const target = path.join(batchDirectory, `${KEY}.json`);
  const before = await fs.readFile(target, 'utf8');
  const faulty = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch', fileSystem: {
    ...fs, rename: async () => { throw Object.assign(new Error('private path'), { code: 'EIO' }); },
  } });
  t.after(() => faulty.close());
  await assert.rejects(faulty.transaction(KEY, previous => ({ state: previous })), { code: 'image_service_storage_unavailable' });
  assert.equal(await fs.readFile(target, 'utf8'), before);
  const reopened = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.inspectChannel(KEY), state);
  assert.deepEqual(await fs.readdir(batchDirectory), [`${KEY}.json`], 'failed temporary write must be cleaned');
});

test('batch scope explicitly rejects single-shot account inspection without enumerating records', async t => {
  const { root } = await fixture(t);
  const batch = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  t.after(() => batch.close());
  await assert.rejects(batch.inspectAccount(ACCOUNT), { code: 'image_service_storage_scope' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('explicit unchanged batch transaction does not rewrite disk or advance revision', async t => {
  const { root, batchDirectory } = await fixture(t);
  let renames = 0;
  const batch = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch', fileSystem: {
    ...fs, rename: async (...args) => { renames++; return fs.rename(...args); },
  } });
  t.after(() => batch.close());
  const state = normalizePreparedBatch(prepared(), ACCOUNT, 1000);
  await assert.rejects(batch.transaction(KEY, () => ({ state, unchanged: true })), { code: 'image_service_storage_transaction' });
  await batch.transaction(KEY, () => ({ state }));
  const target = path.join(batchDirectory, `${KEY}.json`);
  const before = await fs.readFile(target, 'utf8');
  assert.equal(renames, 1);
  assert.equal(await batch.transaction(KEY, previous => ({ state: previous, unchanged: true, result: 'same' })), 'same');
  assert.equal(renames, 1);
  assert.equal(await fs.readFile(target, 'utf8'), before);
  assert.equal(JSON.parse(before).revision, 1);

  await assert.rejects(batch.transaction(KEY, previous => ({ state: { ...previous }, unchanged: true })), { code: 'image_service_storage_transaction' });
  await assert.rejects(batch.transaction(KEY, previous => {
    previous.updatedAt++;
    return { state: previous, unchanged: true };
  }), { code: 'image_service_storage_transaction' });
  assert.equal(renames, 1);
  assert.equal(await fs.readFile(target, 'utf8'), before, 'a false no-op claim must never mutate durable data');
});

test('legacy scope retains its original write-and-revise behavior even with an extra unchanged flag', async t => {
  const { root, nativeDirectory } = await fixture(t);
  const native = createImageServiceStore({ dataRoot: root, scope: 'novel' });
  t.after(() => native.close());
  const state = normalizeImageServiceChannel(undefined, KEY);
  await native.transaction(KEY, () => ({ state }));
  await native.transaction(KEY, previous => ({ state: previous, unchanged: true }));
  const envelope = JSON.parse(await fs.readFile(path.join(nativeDirectory, `${KEY}.json`), 'utf8'));
  assert.equal(envelope.revision, 2);
  assert.deepEqual(await native.inspectChannel(KEY), state);
});

test('batch business errors are explicit while unknown errors remain masked and legacy scope is unchanged', async t => {
  const { root } = await fixture(t);
  const batch = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch' });
  const native = createImageServiceStore({ dataRoot: root, scope: 'novel' });
  t.after(async () => { await batch.close(); await native.close(); });
  const business = code => createStoryboardServerBatchBusinessError(code, '可安全显示的批次结果');
  for (const code of ['account_changed', 'conflict', 'not_found', 'identity', 'revision']) {
    await assert.rejects(batch.transaction(KEY, () => { throw business(code); }), { code: `storyboard_server_batch_${code}` });
  }
  for (const cause of [Object.assign(new Error('private disk path'), {
    name: 'StoryboardServerBatchError', code: 'storyboard_server_batch_conflict',
    status: 409, submissionState: 'not_submitted',
  }), Object.assign(new Error('private disk path'), {
    name: 'StoryboardServerBatchError', code: 'storyboard_server_batch_secret_internal',
  }), new Error('private disk path')]) {
    await assert.rejects(batch.transaction(KEY, () => { throw cause; }), rejected =>
      rejected.code === 'image_service_storage_unavailable' && !rejected.message.includes('private disk path'));
  }
  await assert.rejects(native.transaction(KEY, () => { throw business('conflict'); }), { code: 'image_service_storage_unavailable' });
});
