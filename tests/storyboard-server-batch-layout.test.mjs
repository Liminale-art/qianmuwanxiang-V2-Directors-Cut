import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  decideStoryboardBatchV2Prepare,
  storyboardBatchV2Location,
} from '../qianmu-storyboard-server-batch-layout.js';
import { normalizePreparedBatch, normalizeBatchRecord, storyboardServerBatchKey } from '../qianmu-storyboard-server-batch-contract.js';
import { uid } from '../qianmu-storyboard-utils.js';

const ACCOUNT_A = `st-user:${'a'.repeat(64)}`;
const ACCOUNT_B = `st-user:${'b'.repeat(64)}`;
const noLegacy = Object.freeze({ legacyDirectoryStatus: 'absent' });
const hash = char => char.repeat(64);
const input = batchId => ({
  version: 1, batchId, requestedMode: 'automatic',
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1000 },
  source: { chatHash: hash('c'), floor: 2, sourceDigest: hash('d'), originPlanId: uid('story') },
  planDigest: hash('e'), routeDigest: hash('f'),
  shots: [{ shotId: uid('shotdraft'), attemptId: uid('shotjob'), shotIndex: 0,
    requestIndex: 1, contentDigest: hash('1') }],
});
const prepared = (batchId = randomUUID(), account = ACCOUNT_A) => normalizePreparedBatch(input(batchId), account, 1000);

test('v2 location is deterministic, account-isolated, path-safe and does not reuse the v1 directory', () => {
  const batchId = randomUUID();
  const a = storyboardBatchV2Location(ACCOUNT_A, batchId);
  assert.deepEqual(a, storyboardBatchV2Location(ACCOUNT_A, batchId));
  assert.equal(a.key, storyboardServerBatchKey(ACCOUNT_A, batchId));
  assert.deepEqual(a.segments.slice(0, 2), ['.qianmu-service', 'storyboard-batches-v2']);
  assert.match(a.segments[2], /^[a-f0-9]{64}$/);
  assert.match(a.segments[3], /^[a-f0-9]{2}$/);
  assert.notEqual(a.segments[2], storyboardBatchV2Location(ACCOUNT_B, batchId).segments[2]);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.segments), true);
  assert.equal(a.segments.every(segment => !segment.includes('/') && !segment.includes('\\') && segment !== '..'), true);
  for (const bad of [null, ACCOUNT_A + '/..', 'st-user:../../', ACCOUNT_A.toUpperCase()]) {
    assert.throws(() => storyboardBatchV2Location(bad, batchId), { code: 'storyboard_server_batch_contract' });
  }
  for (const bad of [null, batchId.toUpperCase(), '../' + batchId, 'stream-' + hash('a')]) {
    assert.throws(() => storyboardBatchV2Location(ACCOUNT_A, bad), { code: 'storyboard_server_batch_contract' });
  }
});

test('different batch IDs disperse across deterministic two-hex shards without affecting the account directory', () => {
  const locations = Array.from({ length: 129 }, () => storyboardBatchV2Location(ACCOUNT_A, randomUUID()));
  assert.equal(new Set(locations.map(row => row.segments[2])).size, 1);
  assert.ok(new Set(locations.map(row => row.segments[3])).size > 1);
  assert.equal(new Set(locations.map(row => row.key)).size, 129);
});

test('no prior record chooses v2 only after explicit no-legacy inspection', () => {
  const row = prepared(), original = structuredClone(row);
  const result = decideStoryboardBatchV2Prepare(row, noLegacy);
  assert.equal(result.kind, 'insert_v2');
  assert.deepEqual(result.record, row);
  assert.notStrictEqual(result.record, row);
  assert.deepEqual(result.location, storyboardBatchV2Location(ACCOUNT_A, row.batchId));
  assert.deepEqual(row, original);
  assert.equal(Object.hasOwn(result, 'view'), false);
});

test('same-content v2 retry returns the existing public view without replacing the original', () => {
  const row = prepared(), legacy = structuredClone(row), next = structuredClone(row);
  next.createdAt = 2000; next.updatedAt = 2000;
  const b = decideStoryboardBatchV2Prepare(next, { ...noLegacy, v2Record: legacy });
  assert.equal(b.kind, 'existing_v2');
  assert.deepEqual(Object.keys(b.view), ['version', 'batchId', 'state', 'stateRevision', 'shotCount',
    'digest', 'createdAt', 'updatedAt']);
  assert.equal(Object.hasOwn(b, 'record'), false);
  assert.deepEqual(legacy, row);
});

test('stopped v2 is sticky, a changed digest conflicts, and any v1 directory fails closed', () => {
  const row = prepared();
  const stopped = normalizeBatchRecord({ ...row, state: 'stopped_unrunnable', stateRevision: 2,
    updatedAt: 2000, stoppedAt: 2000 }, storyboardServerBatchKey(ACCOUNT_A, row.batchId));
  const unchanged = decideStoryboardBatchV2Prepare(row, { ...noLegacy, v2Record: stopped });
  assert.equal(unchanged.kind, 'existing_v2');
  assert.equal(unchanged.view.state, 'stopped_unrunnable');
  assert.throws(() => decideStoryboardBatchV2Prepare(stopped, noLegacy), {
    code: 'storyboard_server_batch_identity', submissionState: 'not_submitted',
  }, 'a stopped record is not a new v2 insertion payload');
  const changed = normalizePreparedBatch({ ...input(row.batchId), planDigest: hash('9') }, ACCOUNT_A, 3000);
  assert.throws(() => decideStoryboardBatchV2Prepare(changed, { ...noLegacy, v2Record: row }), {
    code: 'storyboard_server_batch_conflict', submissionState: 'not_submitted',
  });
  for (const inspection of [{}, { legacyDirectoryStatus: 'present' },
    { legacyDirectoryStatus: 'unknown' }, { ...noLegacy, v1Record: row },
    { ...noLegacy, v2Record: row, v1Record: row }]) {
    assert.throws(() => decideStoryboardBatchV2Prepare(row, inspection), {
      code: 'storyboard_server_batch_conflict', submissionState: 'not_submitted',
    });
  }
});

test('legacy absence must be an own plain data field, never inherited or accessor-provided', () => {
  const row = prepared();
  const inherited = Object.create({ legacyDirectoryStatus: 'absent' });
  const legacyGetter = Object.defineProperty({}, 'legacyDirectoryStatus', {
    enumerable: true, get() { throw new Error('must not read legacy getter'); },
  });
  const recordGetter = Object.defineProperties({}, {
    legacyDirectoryStatus: { value: 'absent', enumerable: true },
    v2Record: { enumerable: true, get() { throw new Error('must not read record getter'); } },
  });
  const inheritedRecord = Object.assign(Object.create({ v2Record: row }), noLegacy);
  const forgedError = new Proxy({}, { getPrototypeOf() {
    throw Object.assign(new Error('untrusted trap'), { code: 'storyboard_server_batch_conflict' });
  } });
  for (const inspection of [inherited, legacyGetter, recordGetter, inheritedRecord, forgedError]) {
    assert.throws(() => decideStoryboardBatchV2Prepare(row, inspection), {
      code: 'storyboard_server_batch_conflict', submissionState: 'not_submitted',
    });
  }
  assert.throws(() => decideStoryboardBatchV2Prepare(row, forgedError), error => error.message !== 'untrusted trap');
});

test('wrong-account, wrong-ID or damaged existing records cannot be silently selected', () => {
  const row = prepared(), foreign = prepared(row.batchId, ACCOUNT_B);
  const wrongId = prepared(randomUUID());
  const damaged = { ...row, digest: hash('0') };
  for (const existing of [foreign, wrongId, damaged, { ...row, apiKey: 'private' }]) {
    assert.throws(() => decideStoryboardBatchV2Prepare(row, { ...noLegacy, v2Record: existing }), {
      code: 'storyboard_server_batch_contract', submissionState: 'not_submitted',
    });
  }
});

test('layout remains pure and published HTTP wiring is read-only without execution', async () => {
  const source = await readFile(new URL('../qianmu-storyboard-server-batch-layout.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:fs|\bfetch\(|\bwriteFile\(|\bmkdir\(|\brename\(|\bunlink\(/);
  assert.match(source, /partition persistence and directory pagination[\s\S]*not implemented here/i);
  const plugin = await readFile(new URL('../server-plugin.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../qianmu-storyboard-server-batch-v2-routes.js', import.meta.url), 'utf8');
  assert.match(plugin, /installStoryboardServerBatchV2Routes\(router,/);
  assert.doesNotMatch(plugin, /enableWrites:\s*true|scope:\s*['"]storyboard-batch['"]/,
    'production must not turn on writes or the old batch scope');
  assert.match(routes, /if \(config\.write && enableWrites !== true\) continue/);
  assert.doesNotMatch(routes, /\b(?:generateImage|createImageService|comfyTasksFor|tasksFor|fetch)\s*\(/,
    'metadata routes cannot submit or query a paid provider');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.equal(release.files.includes('qianmu-storyboard-server-batch-v2-store.js'), true);
  assert.equal(release.files.includes('qianmu-storyboard-server-batch-v2-routes.js'), true);
  assert.equal(release.files.includes('qianmu-storyboard-server-batch-store.js'), false);
});
