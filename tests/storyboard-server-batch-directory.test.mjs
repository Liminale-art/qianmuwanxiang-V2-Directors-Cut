import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStoryboardServerBatchStore } from '../qianmu-storyboard-server-batch-store.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { uid } from '../qianmu-storyboard-utils.js';

const request = (handle = 'alice') => ({ user: { profile: { handle, enabled: true } } });
const fakeLedger = inspectStoryboardBatchAccount => ({
  transaction: async () => { throw Error('not used by directory test'); },
  inspectChannel: async () => { throw Error('not used by directory test'); },
  close: async () => {},
  ...(inspectStoryboardBatchAccount ? { inspectStoryboardBatchAccount } : {}),
});
const manifest = () => ({
  version: 1, batchId: randomUUID(), requestedMode: 'automatic',
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: 'a'.repeat(64), floor: 12, sourceDigest: 'b'.repeat(64), originPlanId: uid('story') },
  planDigest: 'c'.repeat(64), routeDigest: 'd'.repeat(64),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: 'e'.repeat(64) }],
});

test('listOwned derives the active ST account and passes pagination to the ledger exactly', async () => {
  const req = request(), calls = [];
  const page = { entries: [{ batchId: randomUUID(), state: 'prepared_unrunnable' }],
    total: 1, nextCursor: null, full: false };
  const store = createStoryboardServerBatchStore({ store: fakeLedger(async (...args) => {
    calls.push(args); return page;
  }) });
  assert.strictEqual(await store.listOwned(req, { cursor: 'opaque-cursor', limit: 2 }), page);
  assert.deepEqual(calls, [[imageServiceAccount(req).namespace, { cursor: 'opaque-cursor', limit: 2 }]]);
  assert.strictEqual(await store.listOwned(req), page);
  assert.deepEqual(calls[1], [imageServiceAccount(req).namespace, { cursor: null, limit: 40 }]);
});

test('listOwned fails closed when the optional ledger capability or ST login is absent', async () => {
  const store = createStoryboardServerBatchStore({ store: fakeLedger() });
  await assert.rejects(store.listOwned(request()), error => {
    assert.equal(error.code, 'storyboard_server_batch_storage');
    assert.equal(error.status, 503);
    assert.equal(error.submissionState, 'not_submitted');
    return true;
  });
  await assert.rejects(store.listOwned({ user: null }), { code: 'image_service_authentication_required' });
});

test('listOwned never returns a page after the request switches accounts during the read', async () => {
  const req = request();
  let resolveRead;
  const pendingRead = new Promise(resolve => { resolveRead = resolve; });
  const calls = [];
  const store = createStoryboardServerBatchStore({ store: fakeLedger((...args) => {
    calls.push(args); return pendingRead;
  }) });
  const pending = store.listOwned(req);
  assert.equal(calls[0][0], imageServiceAccount(req).namespace);
  req.user.profile.handle = 'bob';
  resolveRead({ entries: [{ batchId: randomUUID() }], total: 1, nextCursor: null, full: false });
  await assert.rejects(pending, { code: 'storyboard_server_batch_account_changed' });
});

test('real directory returns only owned public batch views across mixed accounts', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-directory-test-'));
  const store = createStoryboardServerBatchStore({ dataRoot: root, now: () => 1000 });
  t.after(async () => {
    await store.close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-directory-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  const alice = request('alice'), bob = request('bob');
  const empty = await store.listOwned(alice);
  assert.deepEqual(empty, { entries: [], total: 0, nextCursor: null, full: false });
  await assert.rejects(fs.lstat(path.join(root, '.qianmu-service')), { code: 'ENOENT' });
  const own = [manifest(), manifest()], other = manifest();
  for (const item of own) await store.prepare(alice, item);
  await store.prepare(bob, other);
  const first = await store.listOwned(alice, { limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.entries.length, 1);
  assert.ok(first.nextCursor);
  const second = await store.listOwned(alice, { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.total, 2);
  assert.equal(second.entries.length, 1);
  assert.deepEqual(new Set([...first.entries, ...second.entries].map(row => row.batchId)),
    new Set(own.map(row => row.batchId)));
  const bobPage = await store.listOwned(bob);
  assert.equal(bobPage.total, 1);
  assert.deepEqual(bobPage.entries.map(row => row.batchId), [other.batchId]);
  for (const row of [...first.entries, ...second.entries, ...bobPage.entries]) {
    assert.deepEqual(Object.keys(row), ['version','batchId','state','stateRevision','shotCount',
      'digest','createdAt','updatedAt']);
  }
});
