import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { batchPublicView, normalizePreparedBatch, storyboardServerBatchKey } from '../qianmu-storyboard-server-batch-contract.js';
import { uid } from '../qianmu-storyboard-utils.js';

const ACCOUNT_A = `st-user:${'a'.repeat(64)}`;
const ACCOUNT_B = `st-user:${'b'.repeat(64)}`;
const batchId = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const input = index => ({
  version: 1, batchId: batchId(index),
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: 'c'.repeat(64), floor: 2, sourceDigest: 'd'.repeat(64), originPlanId: uid('story') },
  requestedMode: 'automatic', planDigest: 'e'.repeat(64), routeDigest: 'f'.repeat(64),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: '1'.repeat(64) }],
});

async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-directory-test-'));
  const store = createImageServiceStore({ dataRoot: root, scope: 'storyboard-batch', ...options });
  t.after(async () => {
    await store.close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-directory-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  const directory = path.join(root, '.qianmu-service', 'storyboard-batches-v1');
  const add = async (index, account = ACCOUNT_A, now = index) => {
    const state = normalizePreparedBatch(input(index), account, now);
    await store.transaction(storyboardServerBatchKey(account, state.batchId), () => ({ state }));
    return state;
  };
  return { root, directory, store, add };
}

test('missing batch directory is inspected without creating any path or file', async t => {
  const { root, store } = await fixture(t);
  assert.deepEqual(await store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    entries: [], total: 0, nextCursor: null, full: false,
  });
  assert.deepEqual(await fs.readdir(root), []);
});

test('directory pages owned public summaries by descending creation time and stable batch ID', async t => {
  const { store, add } = await fixture(t);
  const [older, tiedHigh, tiedLow, foreign] = await Promise.all([
    add(1, ACCOUNT_A, 100), add(3, ACCOUNT_A, 200), add(2, ACCOUNT_A, 200), add(4, ACCOUNT_B, 300),
  ]);
  const first = await store.inspectStoryboardBatchAccount(ACCOUNT_A, { limit: 2 });
  assert.deepEqual(first, {
    entries: [batchPublicView(tiedLow), batchPublicView(tiedHigh)],
    total: 3, nextCursor: tiedHigh.batchId, full: false,
  });
  assert.equal(JSON.stringify(first).includes(foreign.batchId), false);
  assert.equal(Object.hasOwn(first.entries[0], 'source'), false);
  assert.equal(Object.hasOwn(first.entries[0], 'shots'), false);
  const second = await store.inspectStoryboardBatchAccount(ACCOUNT_A, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second, { entries: [batchPublicView(older)], total: 3, nextCursor: null, full: false });
  assert.deepEqual(await store.inspectStoryboardBatchAccount(ACCOUNT_A, { cursor: older.batchId, limit: 1 }), {
    entries: [], total: 3, nextCursor: null, full: false,
  });
  assert.deepEqual(await store.inspectStoryboardBatchAccount(ACCOUNT_B), {
    entries: [batchPublicView(foreign)], total: 1, nextCursor: null, full: false,
  });
});

test('identity and cross-account cursors fail closed without enumerating batch files', async t => {
  const { root, store, add } = await fixture(t);
  for (const [namespace, options] of [
    ['bad', undefined], [ACCOUNT_A.toUpperCase(), undefined],
    [ACCOUNT_A, { cursor: 'not-a-uuid' }], [ACCOUNT_A, { cursor: 'ABCDEF00-0000-4000-8000-000000000001' }],
    [ACCOUNT_A, { limit: 0 }], [ACCOUNT_A, { limit: 51 }], [ACCOUNT_A, { limit: 1.5 }],
    [ACCOUNT_A, null], [ACCOUNT_A, { get cursor() { throw new Error('private text'); } }],
  ]) {
    await assert.rejects(store.inspectStoryboardBatchAccount(namespace, options), {
      code: 'image_service_storage_identity',
    });
  }
  assert.deepEqual(await fs.readdir(root), []);
  const foreign = await add(7, ACCOUNT_B);
  await assert.rejects(store.inspectStoryboardBatchAccount(ACCOUNT_A, { cursor: foreign.batchId }), {
    code: 'image_service_storage_identity',
  });
  await assert.rejects(store.inspectStoryboardBatchAccount(ACCOUNT_A, { cursor: batchId(8) }), {
    code: 'image_service_storage_identity',
  });
  assert.deepEqual(await store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    entries: [], total: 0, nextCursor: null, full: false,
  });
});

test('full reports only global capacity reached, never foreign account count', async t => {
  const { store, add } = await fixture(t, { maxChannels: 2 });
  const own = await add(1, ACCOUNT_A);
  await add(2, ACCOUNT_B);
  assert.deepEqual(await store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    entries: [batchPublicView(own)], total: 1, nextCursor: null, full: true,
  });
  await assert.rejects(add(3, ACCOUNT_A), { code: 'image_service_storage_full' });
});

test('directory rejects corrupted envelopes and unknown entries instead of hiding them by account', async t => {
  const { directory, store, add } = await fixture(t);
  await add(1, ACCOUNT_A);
  const foreign = await add(2, ACCOUNT_B);
  const target = path.join(directory, `${storyboardServerBatchKey(ACCOUNT_B, foreign.batchId)}.json`);
  const original = await fs.readFile(target, 'utf8');
  const envelope = JSON.parse(original);
  envelope.checksum = '0'.repeat(64);
  await fs.writeFile(target, JSON.stringify(envelope));
  await assert.rejects(store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    code: 'image_service_storage_corrupt',
  });
  await fs.writeFile(target, original);
  await fs.writeFile(path.join(directory, 'unknown.txt'), 'unexpected');
  await assert.rejects(store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    code: 'image_service_storage_path',
  });
  await fs.unlink(path.join(directory, 'unknown.txt'));
  await fs.mkdir(path.join(directory, `${'2'.repeat(64)}.json`));
  await assert.rejects(store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    code: 'image_service_storage_path',
  });
});

test('active offline maintenance refuses a healthy-looking batch page', async t => {
  const { directory, store, add } = await fixture(t);
  const own = await add(1, ACCOUNT_A);
  const lock = path.join(directory, '.maintenance.lock');
  await fs.writeFile(lock, 'offline maintenance');
  await assert.rejects(store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    code: 'image_service_storage_maintenance',
  });
  await fs.unlink(lock);
  assert.deepEqual(await store.inspectStoryboardBatchAccount(ACCOUNT_A), {
    entries: [batchPublicView(own)], total: 1, nextCursor: null, full: false,
  });
});

test('directory inspection is unavailable to every legacy scope', async t => {
  const { root } = await fixture(t);
  const native = createImageServiceStore({ dataRoot: root });
  t.after(() => native.close());
  await assert.rejects(native.inspectStoryboardBatchAccount(ACCOUNT_A), {
    code: 'image_service_storage_scope',
  });
  assert.deepEqual(await fs.readdir(root), []);
});
