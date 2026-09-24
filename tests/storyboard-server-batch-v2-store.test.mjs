import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStoryboardServerBatchV2Store } from '../qianmu-storyboard-server-batch-v2-store.js';
import { storyboardBatchV2Location } from '../qianmu-storyboard-server-batch-layout.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { uid } from '../qianmu-storyboard-utils.js';

const request = (handle = 'alice') => ({ user: { profile: { handle, enabled: true } } });
const hash = digit => digit.repeat(64);
const manifest = (batchId = randomUUID()) => ({
  version: 1, batchId, requestedMode: 'automatic',
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: hash('a'), floor: 12, sourceDigest: hash('b'), originPlanId: uid('story') },
  planDigest: hash('c'), routeDigest: hash('d'),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: hash('e') }],
});
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-v2-store-test-'));
  const store = createStoryboardServerBatchV2Store({ dataRoot: root, now: () => 1000, ...options });
  t.after(async () => {
    await store.close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-v2-store-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  return { root, store };
}
const accountDirectory = (root, req) => path.join(root,
  ...storyboardBatchV2Location(imageServiceAccount(req).namespace,
    '00000000-0000-4000-8000-000000000000').segments.slice(0, 3));
async function recordPath(root, req, batchId) {
  const location = storyboardBatchV2Location(imageServiceAccount(req).namespace, batchId);
  const shard = path.join(root, ...location.segments);
  const names = await fs.readdir(shard);
  const name = names.find(value => value.endsWith(`-${batchId}.json`));
  assert.ok(name);
  return path.join(shard, name);
}

test('read-only empty query/list never creates directories; prepare remains server-only metadata', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  assert.equal(await store.query(req, input.batchId), null);
  assert.deepEqual(await store.listOwned(req), { entries: [], total: 0, nextCursor: null, full: false });
  await assert.rejects(fs.lstat(path.join(root, '.qianmu-service')), { code: 'ENOENT' });
  const prepared = await store.prepare(req, input);
  assert.equal(prepared.state, 'prepared_unrunnable');
  assert.equal(prepared.shotCount, 1);
  assert.deepEqual(await store.query(req, input.batchId), prepared);
  const bytes = await fs.readFile(await recordPath(root, req, input.batchId), 'utf8');
  assert.doesNotMatch(bytes, /apiKey|prompt|referenceImage|imageBytes/);
});

test('same digest is idempotent, changed content conflicts, stop is sticky CAS across instances', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  const prepared = await store.prepare(req, input);
  assert.deepEqual(await store.prepare(req, structuredClone(input)), prepared);
  await assert.rejects(store.prepare(req, { ...input, planDigest: hash('f') }), {
    code: 'storyboard_server_batch_conflict',
  });
  await assert.rejects(store.stop(req, input.batchId, 2), { code: 'storyboard_server_batch_revision' });
  const stopped = await store.stop(req, input.batchId, 1);
  assert.equal(stopped.state, 'stopped_unrunnable');
  assert.equal(stopped.stateRevision, 2);
  assert.deepEqual(await store.stop(req, input.batchId, 1), stopped);
  assert.deepEqual(await store.prepare(req, input), stopped);
  const another = createStoryboardServerBatchV2Store({ dataRoot: root, now: () => 2000 });
  t.after(() => another.close());
  assert.deepEqual(await another.query(req, input.batchId), stopped);
});

test('1000 batches are listable beyond v1 capacity, opening only page records and cursor anchor', async t => {
  let clock = 1000, recordOpens = 0;
  const counted = { ...fs, async open(target, ...args) {
    if (String(target).endsWith('.json')) recordOpens++;
    return fs.open(target, ...args);
  } };
  const { store } = await fixture(t, { now: () => clock++, fileSystem: counted });
  const req = request(), inputs = Array.from({ length: 1000 }, () => manifest());
  for (const input of inputs) await store.prepare(req, input);
  recordOpens = 0;
  const started = performance.now();
  const forty = await store.listOwned(req, { limit: 40 });
  const firstFortyMs = performance.now() - started;
  assert.equal(forty.entries.length, 40);
  assert.equal(recordOpens, 40);
  t.diagnostic(`local 1000-batch list(40): ${firstFortyMs.toFixed(1)}ms, 40 record opens; not a VPS benchmark`);
  recordOpens = 0;
  const first = await store.listOwned(req, { limit: 20 });
  assert.equal(first.total, 1000);
  assert.equal(first.entries.length, 20);
  assert.equal(recordOpens, 20, 'page one must not cold-read the other 980 records');
  recordOpens = 0;
  const second = await store.listOwned(req, { limit: 20, cursor: first.nextCursor });
  assert.equal(second.entries.length, 20);
  assert.equal(recordOpens, 21, 'page two reads its 20 records plus one cursor anchor');
  assert.ok(first.entries.every((row, index) => index === 0 || first.entries[index - 1].createdAt >= row.createdAt));
  assert.equal(new Set([...first.entries, ...second.entries].map(row => row.batchId)).size, 40);
});

test('same-millisecond batches have stable UUID tie order and pagination is live, not snapshot', async t => {
  let clock = 1000;
  const { store } = await fixture(t, { now: () => clock });
  const req = request();
  const ids = ['00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002'];
  for (const id of ids) await store.prepare(req, manifest(id));
  const page = await store.listOwned(req, { limit: 2 });
  assert.deepEqual(page.entries.map(row => row.batchId), [ids[1], ids[2]]);
  clock = 999;
  const later = manifest();
  await store.prepare(req, later);
  const live = await store.listOwned(req, { limit: 2, cursor: page.nextCursor });
  assert.deepEqual(live.entries.map(row => row.batchId), [ids[0], later.batchId]);
  clock = 2000;
  const ahead = manifest();
  await store.prepare(req, ahead);
  const stillLive = await store.listOwned(req, { limit: 3, cursor: page.nextCursor });
  assert.equal(stillLive.entries.some(row => row.batchId === ahead.batchId), false,
    'new records ahead of the cursor are seen by reopening page one, not by page two');
});

test('stop keeps the stable cursor usable; deleted anchor fails closed instead of skipping a page', async t => {
  const { root, store } = await fixture(t), req = request();
  const a = manifest(), b = manifest();
  await store.prepare(req, a); await store.prepare(req, b);
  const page = await store.listOwned(req, { limit: 1 });
  await store.stop(req, page.nextCursor.batchId, 1);
  assert.equal((await store.listOwned(req, { cursor: page.nextCursor })).entries.length, 1);
  const currentPage = await store.listOwned(req, { limit: 1 });
  await fs.unlink(await recordPath(root, req, currentPage.nextCursor.batchId));
  await assert.rejects(store.listOwned(req, { cursor: currentPage.nextCursor }), {
    code: 'storyboard_server_batch_v2_storage_cursor',
  });
  await assert.rejects(store.listOwned(req, { cursor: { ...currentPage.nextCursor, apiKey: 'bad' } }), {
    code: 'storyboard_server_batch_v2_storage_cursor',
  });
});

test('account isolation and changed ST identity refuse delivery', async t => {
  const { root, store } = await fixture(t), alice = request(), bob = request('bob'), input = manifest();
  const view = await store.prepare(alice, input);
  assert.equal(await store.query(bob, input.batchId), null);
  assert.equal((await store.listOwned(bob)).total, 0);
  await assert.rejects(store.stop(bob, input.batchId, 1), { code: 'storyboard_server_batch_not_found' });
  assert.deepEqual(await store.query(alice, input.batchId), view);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const pausedFs = { ...fs, async rename(...args) { entered(); await gate; return fs.rename(...args); } };
  const switched = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: pausedFs });
  t.after(() => switched.close());
  const moving = request(), newInput = manifest();
  const pending = switched.prepare(moving, newInput);
  await enteredGate;
  moving.user.profile.handle = 'bob';
  release();
  await assert.rejects(pending, { code: 'storyboard_server_batch_account_changed' });
  assert.equal(await switched.query(moving, newInput.batchId), null);
  moving.user.profile.handle = 'alice';
  assert.equal((await switched.query(moving, newInput.batchId)).state, 'prepared_unrunnable');
});

test('v1 namespace of any type blocks v2 writes without deleting or migrating it', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  const service = path.join(root, '.qianmu-service');
  await fs.mkdir(service);
  const legacy = path.join(service, 'storyboard-batches-v1');
  await fs.mkdir(legacy);
  await assert.rejects(store.prepare(req, input), { code: 'storyboard_server_batch_conflict' });
  assert.equal((await fs.lstat(legacy)).isDirectory(), true);
  await assert.rejects(fs.lstat(path.join(service, 'storyboard-batches-v2')), { code: 'ENOENT' });
  await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_conflict' });
});

test('stop for an absent batch is read-only and does not create an empty account directory', async t => {
  const { root, store } = await fixture(t), req = request();
  await assert.rejects(store.stop(req, randomUUID(), 1), { code: 'storyboard_server_batch_not_found' });
  await assert.rejects(fs.lstat(path.join(root, '.qianmu-service')), { code: 'ENOENT' });
});

test('stale or foreign account lock is never stolen', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  const lock = path.join(accountDirectory(root, req), '.transaction.lock');
  await fs.writeFile(lock, 'foreign-lock');
  await assert.rejects(store.prepare(req, manifest()), { code: 'storyboard_server_batch_v2_storage_busy' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'foreign-lock');
  await assert.rejects(store.listOwned(req), { code: 'storyboard_server_batch_v2_storage_busy' });
  await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_busy' });
});

test('a legitimate in-flight write makes concurrent readers busy, not corrupt', async t => {
  const { root, store } = await fixture(t, { lockWaitMs: 0 }), req = request(), input = manifest();
  await store.prepare(req, input);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const delayed = { ...fs, async rename(...args) { entered(); await gate; return fs.rename(...args); } };
  const writer = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: delayed, now: () => 1000 });
  t.after(() => writer.close());
  const pending = writer.stop(req, input.batchId, 1);
  await enteredGate;
  await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_busy' });
  await assert.rejects(store.listOwned(req), { code: 'storyboard_server_batch_v2_storage_busy' });
  release();
  assert.equal((await pending).state, 'stopped_unrunnable');
  assert.equal((await store.query(req, input.batchId)).state, 'stopped_unrunnable');
});

test('default short lock wait lets an ordinary overlapping read complete after a write', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const delayed = { ...fs, async rename(...args) { entered(); await gate; return fs.rename(...args); } };
  const writer = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: delayed, now: () => 1000 });
  t.after(() => writer.close());
  const writing = writer.stop(req, input.batchId, 1);
  await enteredGate;
  const reading = store.query(req, input.batchId);
  setTimeout(release, 50);
  assert.equal((await reading).state, 'stopped_unrunnable');
  assert.equal((await writing).state, 'stopped_unrunnable');
});

test('two reads of the same account do not block one another on an exclusive lock', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const delayed = { ...fs, async readdir(...args) {
    if (first) { first = false; entered(); await gate; }
    return fs.readdir(...args);
  } };
  const reader = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: delayed });
  t.after(() => reader.close());
  const firstRead = reader.query(req, input.batchId);
  await enteredGate;
  const secondRead = reader.query(req, input.batchId);
  try {
    const finished = await Promise.race([
      secondRead.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(finished, true, 'the second read should not wait for the first reader to release');
  } finally { release(); }
  assert.equal((await firstRead).batchId, input.batchId);
  assert.equal((await secondRead).batchId, input.batchId);
});

test('record checksum, symlink and hardlink anomalies fail closed', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  const record = await recordPath(root, req, input.batchId);
  const external = path.join(root, 'record-hardlink.json');
  await fs.link(record, external);
  await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_record' });
  await fs.unlink(external);
  const data = JSON.parse(await fs.readFile(record, 'utf8'));
  data.checksum = hash('0');
  await fs.writeFile(record, JSON.stringify(data));
  await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_corrupt' });
  const stray = path.join(path.dirname(record), 'unexpected-file');
  await fs.writeFile(stray, 'unexpected');
  await assert.rejects(store.listOwned(req), { code: 'storyboard_server_batch_v2_storage_path' });
});

test('a symlinked record and accessor or Proxy cursor are rejected safely', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  const record = await recordPath(root, req, input.batchId);
  const moved = path.join(root, 'record-outside-shard.json');
  await fs.rename(record, moved);
  let linked = false;
  try { await fs.symlink(moved, record, 'file'); linked = true; }
  catch (cause) {
    if (cause?.code === 'EPERM' || cause?.code === 'EACCES') t.diagnostic('symlink creation unavailable on this host');
    else throw cause;
  }
  if (linked) {
    await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_path' });
  } else {
    const synthetic = { ...fs, async readdir(target, options) {
      const entries = await fs.readdir(target, options);
      return path.basename(target) === path.basename(path.dirname(record))
        ? [{ name: path.basename(record), isFile: () => false }] : entries;
    } };
    const simulated = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: synthetic });
    t.after(() => simulated.close());
    await assert.rejects(simulated.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_path' });
  }
  const getter = Object.defineProperty({}, 'batchId', { get() { throw Error('secret cursor'); } });
  const proxy = new Proxy({}, { getPrototypeOf() { throw Error('secret proxy'); } });
  for (const cursor of [getter, proxy]) {
    await assert.rejects(store.listOwned(req, { cursor }), error =>
      error.code === 'storyboard_server_batch_v2_storage_cursor' && !/secret/.test(error.message));
  }
  const options = Object.defineProperty({}, 'limit', { get() { throw Error('secret options'); } });
  await assert.rejects(store.listOwned(req, options), error =>
    error.code === 'storyboard_server_batch_v2_storage_cursor' && !/secret/.test(error.message));
});

test('orphan write temp is preserved for recovery; account and shard junctions fail closed', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  const record = await recordPath(root, req, input.batchId);
  const orphan = path.join(path.dirname(record), `.write-${randomUUID()}.tmp`);
  await fs.writeFile(orphan, 'orphan');
  await assert.rejects(store.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_path' });
  assert.equal(await fs.readFile(orphan, 'utf8'), 'orphan');
  await fs.unlink(orphan);
  const account = accountDirectory(root, req), shard = path.dirname(record);
  for (const spoofed of [account, shard]) {
    const fake = { ...fs, async realpath(target) {
      return path.resolve(target) === path.resolve(spoofed) ? root : fs.realpath(target);
    } };
    const unsafe = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: fake });
    t.after(() => unsafe.close());
    await assert.rejects(unsafe.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_path' });
  }
});

test('a changed account directory after an unlocked read is rejected before delivery', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  const account = accountDirectory(root, req);
  let accountChecks = 0;
  const swapped = { ...fs, async realpath(target) {
    if (path.resolve(target) === path.resolve(account) && ++accountChecks === 3) return root;
    return fs.realpath(target);
  } };
  const reader = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: swapped });
  t.after(() => reader.close());
  await assert.rejects(reader.query(req, input.batchId), {
    code: 'storyboard_server_batch_v2_storage_path',
  });
  assert.equal(accountChecks, 3);
});

test('a temp seen only during one directory read is retried, including a transient capacity spike', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  const record = await recordPath(root, req, input.batchId);
  const shard = path.dirname(record);
  let inserted = false;
  const tempName = `.write-${randomUUID()}.tmp`;
  const transient = { ...fs, async readdir(target, options) {
    const entries = await fs.readdir(target, options);
    if (!inserted && path.resolve(target) === path.resolve(shard)) {
      inserted = true;
      return [...entries, ...Array.from({ length: 256 }, () => ({ name: tempName,
        isFile: () => true }))];
    }
    return entries;
  } };
  const reader = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: transient });
  t.after(() => reader.close());
  assert.equal((await reader.query(req, input.batchId)).batchId, input.batchId);
  assert.equal(inserted, true);
  assert.equal((await reader.listOwned(req)).total, 1);
});

test('lock open/write/unlink failures are sanitized; uncertain cleanup poisons the instance', async t => {
  const { root, store } = await fixture(t), req = request(), existing = manifest();
  await store.prepare(req, existing);
  const marker = 'PRIVATE C:/secret/lock';
  const lockPath = path.join(accountDirectory(root, req), '.transaction.lock');
  const openFails = { ...fs, async open(target, ...args) {
    if (path.resolve(target) === path.resolve(lockPath)) throw new Error(marker);
    return fs.open(target, ...args);
  } };
  const failedOpen = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: openFails });
  t.after(() => failedOpen.close());
  await assert.rejects(failedOpen.prepare(req, manifest()), error =>
    error.code === 'storyboard_server_batch_v2_storage_unavailable' && !error.message.includes(marker));

  let failWrite = true;
  const writeFails = { ...fs, async open(target, ...args) {
    const handle = await fs.open(target, ...args);
    if (path.resolve(target) !== path.resolve(lockPath) || !failWrite) return handle;
    failWrite = false;
    return { stat: () => handle.stat(), writeFile: () => { throw new Error(marker); },
      sync: () => handle.sync(), close: () => handle.close() };
  } };
  const failedWrite = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: writeFails });
  t.after(() => failedWrite.close());
  await assert.rejects(failedWrite.prepare(req, manifest()), error =>
    error.code === 'storyboard_server_batch_v2_storage_unavailable' && !error.message.includes(marker));
  assert.equal((await failedWrite.prepare(req, existing)).batchId, existing.batchId);

  const unlinkFails = { ...fs, async unlink(target) {
    if (path.resolve(target) === path.resolve(lockPath)) throw new Error(marker);
    return fs.unlink(target);
  } };
  const failedUnlink = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: unlinkFails });
  t.after(() => failedUnlink.close());
  await assert.rejects(failedUnlink.prepare(req, manifest()), error =>
    error.code === 'storyboard_server_batch_v2_storage_unavailable' && !error.message.includes(marker));
  assert.equal(failedUnlink.inspect().paused, true);
  assert.equal((await fs.lstat(lockPath)).isFile(), true);
});

test('same-instance pending work is bounded instead of accumulating without limit', async t => {
  const { root, store } = await fixture(t), req = request(), input = manifest();
  await store.prepare(req, input);
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const delayed = { ...fs, async readdir(...args) {
    if (first) { first = false; entered(); }
    await gate;
    return fs.readdir(...args);
  } };
  const bounded = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: delayed });
  t.after(() => bounded.close());
  const active = bounded.query(req, input.batchId);
  await enteredGate;
  const waiting = Array.from({ length: 63 }, () => bounded.query(req, input.batchId));
  assert.equal(bounded.inspect().pending, 64);
  await assert.rejects(bounded.query(req, input.batchId), { code: 'storyboard_server_batch_v2_storage_busy' });
  release();
  const delivered = await Promise.all([active, ...waiting]);
  assert.equal(delivered.length, 64);
  assert.equal(bounded.inspect().pending, 0);
});

test('rename-then-error is uncertain: poison process, preserve record, and require fresh readback', async t => {
  const unsafe = 'PRIVATE C:/secret/path';
  let failOnce = true;
  const injected = { ...fs, async rename(...args) {
    await fs.rename(...args);
    if (failOnce) { failOnce = false; throw new Error(unsafe); }
  } };
  const { root, store } = await fixture(t, { fileSystem: injected }), req = request(), input = manifest();
  await assert.rejects(store.prepare(req, input), error => error.code === 'storyboard_server_batch_v2_storage_unavailable'
    && !error.message.includes(unsafe));
  assert.equal(store.inspect().paused, true);
  await assert.rejects(store.prepare(req, input), { code: 'storyboard_server_batch_v2_storage_closed' });
  const fresh = createStoryboardServerBatchV2Store({ dataRoot: root, now: () => 2000 });
  t.after(() => fresh.close());
  const readback = await fresh.query(req, input.batchId);
  assert.equal(readback.state, 'prepared_unrunnable');
  assert.deepEqual(await fresh.prepare(req, input), readback);
});

test('two instances serialize by account-wide lock; a failed contender may retry idempotently', async t => {
  const { root, store } = await fixture(t, { lockWaitMs: 1000 }), req = request(), input = manifest();
  const second = createStoryboardServerBatchV2Store({ dataRoot: root, now: () => 1000,
    lockWaitMs: 1000 });
  t.after(() => second.close());
  const [firstView, secondView] = await Promise.all([store.prepare(req, input), second.prepare(req, input)]);
  assert.deepEqual(firstView, secondView);
  assert.equal((await store.listOwned(req)).total, 1);
});
