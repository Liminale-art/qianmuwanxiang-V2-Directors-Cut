import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createStoryboardServerBatchV2Store,
  STORYBOARD_BATCH_V2_HARD_CAPACITY } from '../qianmu-storyboard-server-batch-v2-store.js';
import { normalizePreparedBatch, storyboardServerBatchKey } from '../qianmu-storyboard-server-batch-contract.js';
import { storyboardBatchV2Location } from '../qianmu-storyboard-server-batch-layout.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { uid } from '../qianmu-storyboard-utils.js';

const request = handle => ({ user: { profile: { handle, enabled: true } } });
const digest = value => createHash('sha256').update(value).digest('hex');
const manifest = (batchId = randomUUID()) => ({
  version: 1, batchId, requestedMode: 'automatic',
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: 'a'.repeat(64), floor: 12, sourceDigest: 'b'.repeat(64),
    originPlanId: uid('story') },
  planDigest: 'c'.repeat(64), routeDigest: 'd'.repeat(64),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: 'e'.repeat(64) }],
});
const v2Directory = root => path.join(root, '.qianmu-service', 'storyboard-batches-v2');
const accountDirectory = (root, req) => path.join(root,
  ...storyboardBatchV2Location(imageServiceAccount(req).namespace,
    '00000000-0000-4000-8000-000000000000').segments.slice(0, 3));

async function temporaryRoot(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'qianmu-batch-v2-capacity-test-'));
  const stores = [];
  t.after(async () => {
    await Promise.all(stores.map(store => store.close()));
    // A test fixture is the only recursively removed path. Re-resolve it and
    // prove it is one direct child of the OS temp directory before removal.
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^qianmu-batch-v2-capacity-test-/);
    await fs.rm(resolved, { recursive: true });
  });
  return { root, stores };
}

async function seedValidAccounts(root, input, count) {
  let next = 0;
  // Preparing each account through the production store would repeatedly
  // rescan all earlier accounts and turn a boundary fixture into O(n^2) work.
  // These are valid, account-bound synthetic on-disk records; the assertions
  // below exercise the real store against them.
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const namespace = imageServiceAccount(request(`capacity-account-${index}`)).namespace;
      const record = normalizePreparedBatch(input, namespace, 1000);
      const key = storyboardServerBatchKey(namespace, input.batchId);
      const directory = path.join(root, ...storyboardBatchV2Location(namespace, input.batchId).segments);
      const filename = `${String(record.createdAt).padStart(16, '0')}-${input.batchId}.json`;
      const body = JSON.stringify({ schema: 'qianmu.storyboard-batch-disk.v2', key,
        checksum: digest(JSON.stringify(record)), record });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, filename), body, { flag: 'wx', mode: 0o600 });
    }
  }));
}

const isAccountRead = (root, target) => path.dirname(String(target)) === v2Directory(root)
  && /^[a-f0-9]{64}$/.test(path.basename(String(target)));

async function firstWave(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('eight account reads did not enter')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

test('capacity scan overlaps account reads with a fixed eight-worker ceiling',
  { timeout: 30_000 }, async t => {
    const { root, stores } = await temporaryRoot(t);
    await seedValidAccounts(root, manifest(), 20);
    let release, reachedEight, active = 0, peak = 0, started = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const wave = new Promise(resolve => { reachedEight = resolve; });
    const counted = { ...fs,
      async readdir(target, ...args) {
        if (!isAccountRead(root, target)) return fs.readdir(target, ...args);
        started++; active++; peak = Math.max(peak, active);
        if (started === 8) reachedEight();
        try { await gate; return await fs.readdir(target, ...args); }
        finally { active--; }
      },
    };
    const store = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: counted,
      now: () => 1000 });
    stores.push(store);
    const prepared = store.prepare(request('capacity-parallel-new'), manifest());
    void prepared.catch(() => {});
    try {
      await firstWave(wave);
      assert.equal(started, 8, 'blocked workers cannot dispatch a ninth account');
      assert.equal(peak, 8, 'more than one account directory is read concurrently');
    } finally { release(); }
    assert.equal((await prepared).state, 'prepared_unrunnable');
    assert.equal(active, 0);
    assert.equal(peak, 8);
    assert.equal(started, 20);
  });

test('an account read error drains in-flight scans under the global lock and cannot create a batch',
  { timeout: 30_000 }, async t => {
    const { root, stores } = await temporaryRoot(t);
    await seedValidAccounts(root, manifest(), 20);
    const target = request('capacity-failed-new');
    let reachedEight, active = 0, started = 0, jsonOpens = 0, releaseAll = false;
    const wave = new Promise(resolve => { reachedEight = resolve; });
    const held = [];
    const faulty = { ...fs,
      async readdir(directory, ...args) {
        if (!isAccountRead(root, directory)) return fs.readdir(directory, ...args);
        started++; active++;
        if (releaseAll) {
          try { return await fs.readdir(directory, ...args); }
          finally { active--; }
        }
        let resolve, reject;
        const gate = new Promise((yes, no) => { resolve = yes; reject = no; });
        held.push({ resolve, reject });
        if (started === 8) reachedEight();
        try { await gate; return await fs.readdir(directory, ...args); }
        finally { active--; }
      },
      async open(targetPath, ...args) {
        if (String(targetPath).endsWith('.json')) jsonOpens++;
        return fs.open(targetPath, ...args);
      },
    };
    const store = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: faulty,
      now: () => 1000 });
    stores.push(store);
    const pending = store.prepare(target, manifest());
    void pending.catch(() => {});
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await firstWave(wave);
      held[0].reject(Object.assign(new Error('injected account readdir failure'), { code: 'EIO' }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'failure must not release the lock while reads are still held');
      assert.equal((await fs.lstat(path.join(v2Directory(root), '.capacity.lock'))).isFile(), true);
      held[1].resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(started, 8, 'a drained worker must not dispatch a ninth read after failure');
      assert.equal(settled, false);
    } finally {
      // Also unblock reads dispatched after a failed wave assertion; otherwise
      // a regressed serial scanner could leave the test fixture hanging.
      releaseAll = true;
      held.forEach(item => item.resolve());
    }
    await assert.rejects(pending, {
      code: 'storyboard_server_batch_v2_storage_unavailable', submissionState: 'not_submitted',
    });
    assert.equal(started, 8);
    assert.equal(active, 0, 'all in-flight reads have drained before the lock is released');
    assert.equal(jsonOpens, 0);
    await assert.rejects(fs.lstat(accountDirectory(root, target)), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(v2Directory(root), '.capacity.lock')), { code: 'ENOENT' });
  });

test('capacity scan rejects duplicate and foreign root entries before any account read', async t => {
  const { root, stores } = await temporaryRoot(t);
  await seedValidAccounts(root, manifest(), 2);
  const target = request('capacity-invalid-root-new');
  let mode = 'duplicate', accountReads = 0;
  const invalid = { ...fs,
    async readdir(directory, ...args) {
      if (isAccountRead(root, directory)) accountReads++;
      const entries = await fs.readdir(directory, ...args);
      if (String(directory) !== v2Directory(root)) return entries;
      if (mode === 'duplicate') {
        return [...entries, entries.find(entry => /^[a-f0-9]{64}$/.test(entry.name))];
      }
      return [...entries, { name: 'foreign', isDirectory: () => false, isFile: () => true }];
    },
  };
  const store = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: invalid,
    now: () => 1000 });
  stores.push(store);
  for (mode of ['duplicate', 'foreign']) {
    accountReads = 0;
    await assert.rejects(store.prepare(target, manifest()), {
      code: 'storyboard_server_batch_v2_storage_path', submissionState: 'not_submitted',
    });
    assert.equal(accountReads, 0, `${mode} fails before reading any account`);
    await assert.rejects(fs.lstat(accountDirectory(root, target)), { code: 'ENOENT' });
  }
});

test('a falsy I/O rejection cannot turn partial capacity counts into a write', async t => {
  const { root, stores } = await temporaryRoot(t);
  await seedValidAccounts(root, manifest(), 2);
  const target = request('capacity-undefined-error-new');
  let reason;
  const faulty = { ...fs,
    readdir(directory, ...args) {
      return isAccountRead(root, directory) ? Promise.reject(reason)
        : fs.readdir(directory, ...args);
    },
  };
  const store = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: faulty,
    now: () => 1000 });
  stores.push(store);
  for (reason of [undefined, null, false, 0, '']) {
    await assert.rejects(store.prepare(target, manifest()), {
      code: 'storyboard_server_batch_v2_storage_unavailable', submissionState: 'not_submitted',
    });
    await assert.rejects(fs.lstat(accountDirectory(root, target)), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(v2Directory(root), '.capacity.lock')), { code: 'ENOENT' });
  }
});

test('default 4096-account boundary accepts slot 4096, refuses 4097 without an empty account',
  { timeout: 120_000 }, async t => {
    const { root, stores } = await temporaryRoot(t);
    const seededInput = manifest();
    const cap = STORYBOARD_BATCH_V2_HARD_CAPACITY.total;
    assert.equal(cap, 4096);
    await seedValidAccounts(root, seededInput, cap - 1);
    let directoryReads = 0, jsonOpens = 0;
    const counted = { ...fs,
      async readdir(target, ...args) { directoryReads++; return fs.readdir(target, ...args); },
      async open(target, ...args) {
        if (String(target).endsWith('.json')) jsonOpens++;
        return fs.open(target, ...args);
      },
    };
    const store = createStoryboardServerBatchV2Store({ dataRoot: root, fileSystem: counted,
      now: () => 1000 });
    stores.push(store);
    const last = request(`capacity-account-${cap - 1}`), lastInput = manifest();
    const started = performance.now();
    const view = await store.prepare(last, lastInput);
    t.diagnostic(`local 4095-account cold scan + slot 4096: ${(performance.now() - started).toFixed(1)}ms, ${directoryReads} readdir calls; not a VPS benchmark`);
    assert.equal(view.state, 'prepared_unrunnable');
    assert.equal((await fs.readdir(v2Directory(root))).length, cap);

    directoryReads = 0; jsonOpens = 0;
    const over = request(`capacity-account-${cap}`);
    const fullStarted = performance.now();
    await assert.rejects(store.prepare(over, manifest()), {
      code: 'storyboard_server_batch_v2_storage_full', submissionState: 'not_submitted',
    });
    t.diagnostic(`local 4096-account full refusal: ${(performance.now() - fullStarted).toFixed(1)}ms, ${directoryReads} readdir calls; not a VPS benchmark`);
    assert.ok(directoryReads <= cap * 2 + 8, 'full refusal scans each account and shard only once');
    assert.equal(jsonOpens, 0, 'other accounts\' complete records are not opened for a quota count');
    await assert.rejects(fs.lstat(accountDirectory(root, over)), { code: 'ENOENT' });
    assert.equal((await fs.readdir(v2Directory(root))).length, cap);

    assert.deepEqual(await store.prepare(last, structuredClone(lastInput)), view,
      'an exact original batch remains idempotently readable at full capacity');
    assert.deepEqual(await store.query(last, lastInput.batchId), view);
    assert.equal((await store.listOwned(request('capacity-account-0'))).total, 1);
  });

test('observed cross-process capacity-lock contention cannot claim slot 4096 twice',
  { timeout: 120_000 }, async t => {
    const { root, stores } = await temporaryRoot(t);
    const cap = STORYBOARD_BATCH_V2_HARD_CAPACITY.total;
    await seedValidAccounts(root, manifest(), cap - 1);
    const source = `
      import * as fs from 'node:fs/promises';
      import path from 'node:path';
      import { createStoryboardServerBatchV2Store } from ${JSON.stringify(new URL('../qianmu-storyboard-server-batch-v2-store.js', import.meta.url).href)};
      const value = JSON.parse(process.argv[1]);
      const directory = path.join(value.root, '.qianmu-service', 'storyboard-batches-v2');
      const lock = path.join(directory, '.capacity.lock');
      let gated = false, contended = false;
      const fileSystem = { ...fs,
        async readdir(target, ...args) {
          if (value.mode === 'holder' && !gated && path.resolve(target) === path.resolve(directory)) {
            gated = true;
            // This readdir happens inside prepare's capacity lock. Do not
            // release until the other process has actually observed EEXIST.
            await new Promise(resolve => {
              process.stdin.once('data', resolve);
              process.stdout.write('HOLDING\\n');
            });
          }
          return fs.readdir(target, ...args);
        },
        async open(target, ...args) {
          try { return await fs.open(target, ...args); }
          catch (error) {
            if (value.mode === 'contender' && !contended && error?.code === 'EEXIST'
              && path.resolve(target) === path.resolve(lock)) {
              contended = true;
              process.stdout.write('CONTENDED\\n');
            }
            throw error;
          }
        },
      };
      const store = createStoryboardServerBatchV2Store({ dataRoot: value.root,
        fileSystem, now: () => 1000, lockWaitMs: 2000 });
      let result;
      try { result = { ok: true, view: await store.prepare({ user: { profile: {
        handle: value.handle, enabled: true } } }, value.input) }; }
      catch (error) { result = { ok: false, code: error.code }; }
      await store.close(); process.stdout.write(JSON.stringify(result) + '\\n');
    `;
    function child(handle, mode) {
      const processHandle = spawn(process.execPath,
        ['--input-type=module', '-e', source,
          JSON.stringify({ root, handle, mode, input: manifest() })],
        { stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(45_000) });
      processHandle.stdin.on('error', () => {});
      let output = '', errors = '', released = false, markerSeen = false;
      const markerName = mode === 'holder' ? 'HOLDING' : 'CONTENDED';
      let resolveMarker, rejectMarker;
      const marker = new Promise((resolve, reject) => {
        resolveMarker = resolve; rejectMarker = reject;
      });
      const markerTimer = setTimeout(() => rejectMarker(new Error(`${mode} marker timed out`)), 15_000);
      const result = new Promise((resolve, reject) => {
        processHandle.stdout.setEncoding('utf8').on('data', chunk => {
          output += chunk;
          if (!markerSeen && output.split(/\r?\n/).includes(markerName)) {
            markerSeen = true; clearTimeout(markerTimer); resolveMarker();
          }
        });
        processHandle.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
        processHandle.on('error', error => { clearTimeout(markerTimer); rejectMarker(error); reject(error); });
        processHandle.on('close', code => {
          clearTimeout(markerTimer);
          if (!markerSeen) rejectMarker(new Error(`${mode} exited before ${markerName}: ${errors.slice(0, 400)}`));
          if (code !== 0) reject(new Error(`${mode} exited ${code}: ${errors.slice(0, 400)}`));
          else {
            try { resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1))); }
            catch (error) { reject(error); }
          }
        });
      });
      // The test awaits marker before result; attach a handler so an early
      // process failure cannot become an unhandled rejection in the interim.
      void result.catch(() => {});
      return { marker, result, release() {
        if (!released && processHandle.exitCode === null && !processHandle.stdin.destroyed) {
          released = true; processHandle.stdin.end('release\n');
        }
      } };
    }
    const holderHandle = 'capacity-contender-a', contenderHandle = 'capacity-contender-b';
    const started = performance.now();
    const holder = child(holderHandle, 'holder');
    let contender, outcomes;
    try {
      await holder.marker;
      assert.equal((await fs.lstat(path.join(v2Directory(root), '.capacity.lock'))).isFile(), true,
        'the holder has acquired the global lock before the contender starts');
      contender = child(contenderHandle, 'contender');
      await contender.marker;
      assert.equal((await fs.lstat(path.join(v2Directory(root), '.capacity.lock'))).isFile(), true,
        'the contender observed EEXIST while the holder still owned the lock');
      holder.release();
      outcomes = await Promise.all([holder.result, contender.result]);
    } finally {
      holder.release();
      await Promise.allSettled([holder.result, contender?.result].filter(Boolean));
    }
    t.diagnostic(`local observed 4095-account cross-process lock contention + final slot: ${(performance.now() - started).toFixed(1)}ms; not a VPS or distributed-filesystem benchmark`);
    assert.equal(outcomes[0].ok, true, 'the deliberately gated lock holder claims slot 4096');
    assert.equal(outcomes[1].ok, false, 'the process observed contending on the lock cannot claim slot 4097');
    assert.ok(['storyboard_server_batch_v2_storage_full', 'storyboard_server_batch_v2_storage_busy']
      .includes(outcomes[1].code),
    'a loser may time out on the global lock but must not create a second record');
    const loser = request(contenderHandle), winner = request(holderHandle);
    const store = createStoryboardServerBatchV2Store({ dataRoot: root, now: () => 1000 });
    stores.push(store);
    await assert.rejects(store.prepare(loser, manifest()), {
      code: 'storyboard_server_batch_v2_storage_full', submissionState: 'not_submitted',
    });
    assert.equal((await fs.readdir(v2Directory(root))).length, cap);
    assert.equal((await store.listOwned(winner)).total, 1);
    assert.equal((await store.listOwned(loser)).total, 0);
    await assert.rejects(fs.lstat(accountDirectory(root, loser)), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(v2Directory(root), '.capacity.lock')), { code: 'ENOENT' });
  });
