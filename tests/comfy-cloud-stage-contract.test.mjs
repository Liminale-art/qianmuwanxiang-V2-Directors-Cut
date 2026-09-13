import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComfyCloudStage as normalize, COMFY_CLOUD_STAGE_SCHEMA as schema, RUNNINGHUB_STAGE_SCHEMA } from '../qianmu-comfy-cloud-stage-contract.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { COMFY_CLOUD_RECEIPT_SCHEMA } from '../qianmu-comfy-cloud-receipt.js';

const owner = { namespace: 'st-user:alice', channelKey: 'a'.repeat(64), attemptId: 'original', requestDigest: 'b'.repeat(64), fence: 'original-fence' };
const task = bindComfyCloudTask(bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2'), 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function fixture() {
  return { schema, identity: { ...owner }, receipt: { schema: COMFY_CLOUD_RECEIPT_SCHEMA, task, requestDigest: owner.requestDigest,
    workflow: { templateHash: 'c'.repeat(64), executionHash: 'd'.repeat(64) },
    stillOutput: { version: 1, model: 'workflow', previewNodeIds: ['preview'], execution: { version: 1, automatic: false, maxImages: 2, expectedImages: 2, outputNodeIds: ['save'] } } },
    selection: [2, 1].map(number => ({ assetId: id(number), nodeId: 'save', mime: 'image/png', sizeBytes: 100, hash: null })),
    images: [2, 1].map(number => ({ assetId: id(number), hash: null, integrity: { version: 1, sizeBytes: 100,
      sha256: 'e'.repeat(64), blake3: 'f'.repeat(64), platformHash: null, platformVerified: null } })) };
}
const rejected = run => assert.throws(run, { code: 'comfy_cloud_stage_invalid', retryable: false });

function rhFixture() {
  const value = fixture(); value.schema = RUNNINGHUB_STAGE_SCHEMA;
  value.receipt.task = bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1'), '18446744073709551616');
  value.selection.forEach((row, index) => {
    delete row.assetId; delete value.images[index].assetId;
    row.outputIndex = index + 1;
    row.outputKey = value.images[index].outputKey = `rh:${value.receipt.task.taskId}:${row.outputIndex}:${row.nodeId}`;
  });
  return value;
}

test('RH stages use exact original task/node/order keys and explicitly unknown upstream integrity', () => {
  const value = rhFixture(), result = normalize(value, owner);
  assert.equal(result.schema, RUNNINGHUB_STAGE_SCHEMA);
  assert.deepEqual(result.selection.map(row => row.outputIndex), [1, 2]);
  assert.equal(result.selection[0].outputKey, 'rh:18446744073709551616:1:save');
  assert.equal(result.images[0].integrity.platformVerified, null);
  assert.equal(Object.hasOwn(result.images[0], 'assetId'), false);
  value.selection[0].outputKey = 'changed'; assert.ok(Object.isFrozen(result.selection[0]));
  assert.equal(result.selection[0].outputKey, 'rh:18446744073709551616:1:save');
});

test('RH cannot impersonate Comfy assets, prove an absent platform hash, reorder outputs or store signed URLs', () => {
  for (const mutate of [s => { s.schema = schema; }, s => { s.receipt.task = task; },
    s => { s.selection[0].outputKey = 'rh:99:1:save'; }, s => { s.images[0].outputKey = s.images[1].outputKey; },
    s => { s.selection.reverse(); s.images.reverse(); }, s => { s.selection[0].outputIndex = 64; },
    s => { s.images[0].integrity.platformVerified = true; }, s => { s.selection[0].sourceUrl = 'https://private/?key=x'; },
    s => { s.selection[0].assetId = id(1); }, s => { s.images[0].hash = `blake3:${'f'.repeat(64)}`; },
    s => { s.selection[0].outputIndex = -1; }]) {
    const value = rhFixture(); mutate(value); rejected(() => normalize(value, owner));
  }
  rejected(() => normalize(rhFixture(), { ...owner, namespace: 'st-user:bob' }));
});

test('cloud stage metadata freezes the original owner, receipt and query order without binary or signed URLs', () => {
  const source = fixture(), result = normalize(source, owner);
  assert.deepEqual(result.selection.map(row => row.assetId), [id(2), id(1)]);
  assert.equal(Object.isFrozen(result.images[0].integrity), true); assert.equal(Object.isFrozen(result.receipt.workflow), true);
  source.images[0].integrity.sha256 = '0'.repeat(64); source.identity.fence = 'new';
  assert.equal(result.images[0].integrity.sha256, 'e'.repeat(64)); assert.equal(result.identity.fence, 'original-fence');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16384);
});

test('another account, fence, request or receipt cannot reuse the same cloud staging slot', () => {
  for (const extra of [{ namespace: 'st-user:bob' }, { fence: 'changed' }, { attemptId: 'other' }, { requestDigest: 'c'.repeat(64) }]) rejected(() => normalize(fixture(), { ...owner, ...extra }));
  const source = fixture(); source.receipt.requestDigest = 'c'.repeat(64); rejected(() => normalize(source, owner));
});

test('missing, duplicate, out-of-order, preview and oversized images cannot complete a cloud stage', () => {
  for (const mutate of [s => s.images.pop(), s => s.images.reverse(), s => { s.selection[1].assetId = s.selection[0].assetId; },
    s => { s.selection[0].nodeId = 'preview'; }, s => { s.selection[0].sizeBytes = 48 * 1024 * 1024; },
    s => { s.receipt.stillOutput.execution.automatic = true; }]) {
    const source = fixture(); mutate(source); rejected(() => normalize(source, owner));
  }
});

test('late platform hashes may refine missing query evidence but cannot contradict an existing hash or claim a missing hash was verified', () => {
  const source = fixture(), hash = `blake3:${'f'.repeat(64)}`;
  source.images[0].hash = hash; source.images[0].integrity.platformHash = hash; source.images[0].integrity.platformVerified = true;
  assert.equal(normalize(source, owner).images[0].integrity.platformVerified, true);
  source.selection[0].hash = `blake3:${'0'.repeat(64)}`; rejected(() => normalize(source, owner));
  const absent = fixture(); absent.images[0].integrity.platformVerified = true; rejected(() => normalize(absent, owner));
});

test('stage metadata rejects unexpected credential, URL, binary and accessor fields without executing getters', () => {
  for (const target of ['root', 'image', 'proof', 'selection']) {
    const source = fixture(), value = target === 'root' ? source : target === 'image' ? source.images[0] : target === 'proof' ? source.images[0].integrity : source.selection[0];
    value.sourceUrl = 'https://private.test/?key=not-for-storage'; rejected(() => normalize(source, owner));
  }
  const source = fixture(); let touched = false;
  Object.defineProperty(source.images[0], 'hash', { get() { touched = true; return null; } });
  rejected(() => normalize(source, owner)); assert.equal(touched, false);
  const indexed = fixture();
  Object.defineProperty(indexed.selection, '0', { get() { touched = true; return null; } });
  rejected(() => normalize(indexed, owner)); assert.equal(touched, false);
  const extraArray = fixture(); extraArray.images.sourceUrl = 'private'; rejected(() => normalize(extraArray, owner));
});
