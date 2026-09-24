import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { uid } from '../qianmu-storyboard-utils.js';
import {
  STORYBOARD_SERVER_BATCH_MAX_BYTES,
  normalizePreparedBatch, normalizeBatchRecord, storyboardServerBatchKey, batchPublicView,
  createStoryboardServerBatchBusinessError, isStoryboardServerBatchBusinessError,
} from '../qianmu-storyboard-server-batch-contract.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const account = `st-user:${digest('test-account')}`;
const batchId = '00000000-0000-4000-8000-000000000001';
const uuid = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const input = (count = 13) => ({
  version: 1, batchId,
  originBatch: { batchId: uid('shotbatch'), batchStartedAt: 1234 },
  source: { chatHash: digest('chat'), floor: 7, sourceDigest: digest('current-floor'), originPlanId: uid('story') },
  requestedMode: 'automatic', planDigest: digest('plan'), routeDigest: digest('route'),
  shots: Array.from({ length: count }, (_, index) => ({
    shotId: uid(index % 2 ? 'shotplan' : 'shotdraft'), attemptId: uid('shotjob'), shotIndex: index,
    requestIndex: 1, contentDigest: digest(`shot-${index + 1}`),
  })),
});
const clone = value => structuredClone(value);
const reject = callback => assert.throws(callback, error => {
  assert.equal(error.code, 'storyboard_server_batch_contract');
  assert.equal(error.submissionState, 'not_submitted');
  return true;
});

test('13 and 21 ordered shots are accepted; count is capacity-bound rather than a 3/6 product cap', () => {
  for (const count of [13, 21, 200]) {
    const record = normalizePreparedBatch(input(count), account, 1234);
    const key = storyboardServerBatchKey(account, batchId);
    assert.equal(record.shots.length, count);
    assert.equal(record.state, 'prepared_unrunnable');
    assert.equal(record.stateRevision, 1);
    assert.equal(record.createdAt, 1234);
    assert.equal(record.updatedAt, 1234);
    assert.equal(record.expectedAccount, account);
    assert.equal(record.digest.length, 64);
    assert.equal(key, digest(JSON.stringify(['qianmu.storyboard-batch-key.v1', account, batchId])));
    assert.deepEqual(normalizeBatchRecord(record, key), record);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= STORYBOARD_SERVER_BATCH_MAX_BYTES);
  }
});

test('native ordinary IDs and short fallback UID suffixes map to an independent UUID batch', () => {
  const ordinary = input(3);
  ordinary.shots[0].shotId = 'shotdraft-1-1-a';
  ordinary.shots[0].attemptId = 'shotjob-1-1-a';
  ordinary.originBatch.batchId = 'shotbatch-1-1-a';
  ordinary.source.originPlanId = 'story-1234abcd';
  const record = normalizePreparedBatch(ordinary, account, 1234);
  assert.equal(record.batchId, batchId);
  assert.equal(record.originBatch.batchId, ordinary.originBatch.batchId);
  assert.equal(record.shots[0].shotId, 'shotdraft-1-1-a');
  assert.equal(record.shots[0].attemptId, 'shotjob-1-1-a');
  assert.notEqual(storyboardServerBatchKey(account, record.batchId), digest(record.originBatch.batchId));
});

test('two stream increments share one original order identity but have independent frozen UUID batches', () => {
  const origin = `stream-${digest('generation')}`;
  const first = input(2), next = input(2);
  first.batchId = uuid(100);
  next.batchId = uuid(101);
  for (const row of [first, next]) {
    row.originBatch = { batchId: origin, batchStartedAt: 1000 };
    row.source.originPlanId = origin;
  }
  next.shots[0].shotIndex = 2;
  next.shots[1].shotIndex = 4;
  const a = normalizePreparedBatch(first, account, 1234), b = normalizePreparedBatch(next, account, 1235);
  assert.equal(a.originBatch.batchId, b.originBatch.batchId);
  assert.deepEqual(a.shots.map(shot => shot.shotIndex), [0, 1]);
  assert.deepEqual(b.shots.map(shot => shot.shotIndex), [2, 4]);
  assert.notEqual(a.batchId, b.batchId);
  assert.notEqual(a.digest, b.digest);
  assert.notEqual(storyboardServerBatchKey(account, a.batchId), storyboardServerBatchKey(account, b.batchId));
});

test('same plan shot may have ordered variants; tuples can skip but cannot reverse or change identity', () => {
  const variants = input(3);
  variants.shots[1].shotIndex = variants.shots[0].shotIndex;
  variants.shots[1].requestIndex = 2;
  variants.shots[1].shotId = variants.shots[0].shotId;
  variants.shots[2].shotIndex = 9;
  const record = normalizePreparedBatch(variants, account, 1);
  assert.deepEqual(record.shots.map(row => [row.shotIndex, row.requestIndex]), [[0, 1], [0, 2], [9, 1]]);
  assert.equal(record.shots[0].shotId, record.shots[1].shotId);
  assert.notEqual(record.shots[0].attemptId, record.shots[1].attemptId);
  for (const change of [
    row => { row.shots[1].shotId = uid('shotdraft'); },
    row => { row.shots[2].shotId = row.shots[0].shotId; },
    row => { row.shots[1].requestIndex = 1; },
    row => { row.shots[1].requestIndex = 21; },
    row => { row.shots[1].requestIndex = 0; },
    row => { row.shots.reverse(); },
  ]) {
    const bad = clone(variants); change(bad);
    reject(() => normalizePreparedBatch(bad, account, 1));
  }
});

test('canonical digest preserves shot order and changes for any frozen source, plan, route or shot commitment', () => {
  const original = input(21), baseline = normalizePreparedBatch(original, account, 1).digest;
  const reversedKeys = {
    shots: original.shots.map(row => ({ contentDigest: row.contentDigest, requestIndex: row.requestIndex,
      shotIndex: row.shotIndex, attemptId: row.attemptId, shotId: row.shotId })),
    routeDigest: original.routeDigest, planDigest: original.planDigest, requestedMode: original.requestedMode,
    source: { originPlanId: original.source.originPlanId, sourceDigest: original.source.sourceDigest,
      floor: original.source.floor, chatHash: original.source.chatHash },
    originBatch: { batchStartedAt: original.originBatch.batchStartedAt, batchId: original.originBatch.batchId },
    batchId: original.batchId, version: original.version,
  };
  assert.equal(normalizePreparedBatch(reversedKeys, account, 2).digest, baseline);
  for (const change of [
    row => { row.shots[0].contentDigest = digest('different picture'); },
    row => { row.shots[0].attemptId = uid('shotjob'); },
    row => { row.shots[0].requestIndex = 2; },
    row => { row.shots.forEach(shot => { shot.shotIndex += 10; }); },
    row => { row.source.sourceDigest = digest('different narrative'); },
    row => { row.source.originPlanId = uid('story'); },
    row => { row.originBatch.batchId = uid('shotbatch'); },
    row => { row.originBatch.batchStartedAt++; },
    row => { row.planDigest = digest('different plan'); },
    row => { row.routeDigest = digest('different route'); },
    row => { row.requestedMode = 'manual'; },
  ]) {
    const changed = clone(original); change(changed);
    assert.notEqual(normalizePreparedBatch(changed, account, 1).digest, baseline);
  }
});

test('duplicate IDs, missing rows, non-safe floor, malformed IDs and oversized complete batches fail closed', () => {
  const repeatedShot = input(); repeatedShot.shots[1].shotId = repeatedShot.shots[0].shotId;
  const repeatedAttempt = input(); repeatedAttempt.shots[1].attemptId = repeatedAttempt.shots[0].attemptId;
  const missing = input(); delete missing.shots[0];
  const extraArraySlot = input(); extraArraySlot.shots.extra = 'untrusted';
  const unsafeFloor = input(); unsafeFloor.source.floor = Number.MAX_SAFE_INTEGER + 1;
  const malformed = input(); malformed.shots[0].shotId = 'S0';
  const keyAsId = input(); keyAsId.shots[0].attemptId = 'sk-secret';
  const reusedBatchId = input(); reusedBatchId.batchId = uid('shotbatch');
  const reusedStreamId = input(); reusedStreamId.batchId = `stream-${digest('generation')}`;
  const wrongOrigin = input(); wrongOrigin.originBatch.batchId = uid('shotjob');
  const wrongShot = input(); wrongShot.shots[0].shotId = uid('shotbatch');
  const wrongAttempt = input(); wrongAttempt.shots[0].attemptId = uid('shotdraft');
  const uuidAttempt = input(); uuidAttempt.shots[0].attemptId = uuid(999);
  const sAlias = input(); sAlias.shots[0].shotId = 'S1';
  const hashAlias = input(); hashAlias.shots[0].shotId = digest('old shot id');
  const noPlan = input(); noPlan.source.originPlanId = '';
  const hugePlan = input(); hugePlan.source.originPlanId = 'p'.repeat(201);
  const controlPlan = input(); controlPlan.source.originPlanId = 'story-\nsecret';
  const prosePlan = input(); prosePlan.source.originPlanId = 'private narrative in an ID field';
  const wrongStreamPlan = input(); wrongStreamPlan.originBatch.batchId = `stream-${digest('generation')}`;
  const noFloor = input(); noFloor.source.floor = -1;
  const noOriginTime = input(); noOriginTime.originBatch.batchStartedAt = 0;
  const wrongMode = input(); wrongMode.requestedMode = 'redraw';
  const badIndex = input(); badIndex.shots[1].shotIndex = -1;
  const unsafeIndex = input(); unsafeIndex.shots[1].shotIndex = Number.MAX_SAFE_INTEGER + 1;
  for (const bad of [repeatedShot, repeatedAttempt, missing, extraArraySlot, unsafeFloor, malformed, keyAsId,
    reusedBatchId, reusedStreamId, wrongOrigin, wrongShot, wrongAttempt, uuidAttempt,
    sAlias, hashAlias, noPlan, hugePlan, controlPlan, prosePlan, wrongStreamPlan,
    noFloor, noOriginTime, wrongMode, badIndex, unsafeIndex]) {
    reject(() => normalizePreparedBatch(bad, account, 1));
  }
  reject(() => normalizePreparedBatch(input(0), account, 1));
  const huge = input(2000);
  assert.throws(() => normalizePreparedBatch(huge, account, 1), error => {
    assert.equal(error.status, 413);
    return true;
  });
});

test('strict whitelist rejects credentials, prose, original prompts, workflow and material payloads at every level', () => {
  for (const change of [
    row => { row.apiKey = 'secret'; },
    row => { row.prompt = 'original positive words'; },
    row => { row.negativePrompt = 'original negative words'; },
    row => { row.workflow = { nodes: [] }; },
    row => { row.material = 'base64 image'; },
    row => { row.authorization = 'automatic'; },
    row => { row.originBatch.apiKey = 'secret'; },
    row => { row.source.prose = 'private narrative'; },
    row => { row.shots[0].prompt = 'original shot prompt'; },
    row => { row.shots[0].apiKey = 'secret'; },
  ]) {
    const bad = input(); change(bad);
    reject(() => normalizePreparedBatch(bad, account, 1));
  }
  const getter = input(); Object.defineProperty(getter, 'apiKey', { get() { throw Error('must not read secret'); } });
  reject(() => normalizePreparedBatch(getter, account, 1));
  reject(() => normalizePreparedBatch(input(), 'st-user:alice', 1));
});

test('record reader rejects changed digest, account/key, unknown state and inconsistent stop revision or time', () => {
  const record = normalizePreparedBatch(input(), account, 1234), key = storyboardServerBatchKey(account, batchId);
  for (const bad of [
    { ...record, digest: digest('forged') },
    { ...record, state: 'running' },
    { ...record, stateRevision: 2 },
    { ...record, updatedAt: 1235 },
    { ...record, apiKey: 'secret' },
    { ...record, shots: record.shots.slice(1) },
    { ...record, state: 'stopped_unrunnable' },
    { ...record, state: 'stopped_unrunnable', stoppedAt: 1235, updatedAt: 1235, stateRevision: 1 },
    { ...record, state: 'stopped_unrunnable', stoppedAt: 1235, updatedAt: 1235, stateRevision: 3 },
    { ...record, state: 'stopped_unrunnable', stoppedAt: 1234, updatedAt: 1235, stateRevision: 2 },
  ]) reject(() => normalizeBatchRecord(bad, key));
  reject(() => normalizeBatchRecord(record, digest('wrong-key')));
  const stopped = { ...record, state: 'stopped_unrunnable', stateRevision: 2, updatedAt: 1235, stoppedAt: 1235 };
  assert.deepEqual(normalizeBatchRecord(stopped, key), stopped);
  assert.equal(stopped.digest, record.digest);
});

test('public view reveals only batch metadata and remains valid after stop', () => {
  const prepared = normalizePreparedBatch(input(21), account, 1234);
  const stopped = { ...prepared, state: 'stopped_unrunnable', stateRevision: 2, updatedAt: 1235, stoppedAt: 1235 };
  for (const record of [prepared, stopped]) {
    const view = batchPublicView(record), text = JSON.stringify(view);
    assert.equal(view.shotCount, 21);
    assert.equal(view.state, record.state);
    assert.equal(view.digest, record.digest);
    assert.equal(Object.hasOwn(view, 'stoppedAt'), record.state === 'stopped_unrunnable');
    for (const secret of [account, record.source.chatHash, record.source.sourceDigest,
      record.source.originPlanId, record.originBatch.batchId,
      record.planDigest, record.routeDigest, record.shots[0].contentDigest,
      record.shots[0].attemptId, 'prompt', 'workflow', 'apiKey']) assert.ok(!text.includes(secret));
    assert.deepEqual(Object.keys(view), record.state === 'stopped_unrunnable'
      ? ['version','batchId','state','stateRevision','shotCount','digest','createdAt','updatedAt','stoppedAt']
      : ['version','batchId','state','stateRevision','shotCount','digest','createdAt','updatedAt']);
  }
});

test('only private-brand business refusals pass; forged name/code and contract failures do not', () => {
  const real = createStoryboardServerBatchBusinessError('conflict', '同一批次编号已有不同内容，未覆盖原批次');
  assert.equal(real.code, 'storyboard_server_batch_conflict');
  assert.equal(real.status, 409);
  assert.equal(isStoryboardServerBatchBusinessError(real), true);
  assert.equal(Object.isFrozen(real), true);
  const forged = Object.assign(new Error('C:\\private\\secret.txt'), {
    name: real.name, code: real.code, status: real.status,
    submissionState: real.submissionState,
  });
  assert.equal(isStoryboardServerBatchBusinessError(forged), false);
  assert.equal(isStoryboardServerBatchBusinessError({ ...real }), false);
  try { normalizePreparedBatch({ ...input(), apiKey: 'secret' }, account, 1); }
  catch (error) { assert.equal(isStoryboardServerBatchBusinessError(error), false); }
  reject(() => createStoryboardServerBatchBusinessError('storage', 'private storage error'));
});
