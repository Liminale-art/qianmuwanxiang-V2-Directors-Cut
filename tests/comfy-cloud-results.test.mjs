import test from 'node:test';
import assert from 'node:assert/strict';
import { collectComfyCloudStillResults as collect } from '../qianmu-comfy-cloud-results.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { COMFY_CLOUD_RECEIPT_SCHEMA as schema } from '../qianmu-comfy-cloud-receipt.js';
const connection = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
const task = bindComfyCloudTask(connection, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
const receipt = () => ({ schema, task, requestDigest: 'c'.repeat(64), workflow: { templateHash: 'a'.repeat(64), executionHash: 'b'.repeat(64) },
  stillOutput: { version: 1, model: 'workflow', previewNodeIds: ['preview'], execution: { version: 1, automatic: false, maxImages: 2, expectedImages: 1, outputNodeIds: ['save'] } } });
const item = (number = 1, extra = {}) => ({ node_id: 'save', type: 'image', content_type: 'image/png', size_bytes: 100,
  id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, hash: null, job_id: 'original',
  url: 'https://signed.test/image?secret=temporary', name: 'original.png', ...extra });
const body = (outputs = [item()], extra = {}) => ({ id: task.taskId, status: 'succeeded', urls: task.links, error: null, outputs, ...extra });
const rejected = code => error => error.code === `comfy_cloud_results_${code}` && error.submissionState === 'accepted'
  && error.upstreamId === task.taskId && error.retryable === false && !error.message.includes('temporary');

test('cloud still selection preserves original order and frozen asset identity without retaining signed URLs', () => {
  const r = receipt(); r.stillOutput.execution.expectedImages = 2;
  const source = body([item(9, { node_id: 'preview' }), item(2), item(3, { node_id: 'unselected' }), item(1)]);
  const result = collect(r, source);
  assert.deepEqual(result.outputs.map(row => row.assetId), [item(2).id, item(1).id]);
  assert.equal(result.outputs[0].hash, null); assert.equal(result.requestDigest, r.requestDigest);
  assert.doesNotMatch(JSON.stringify(result), /temporary|signed.test|original.png|unselected|preview/);
  source.outputs[1].size_bytes = 999; r.requestDigest = 'd'.repeat(64);
  assert.equal(result.outputs[0].sizeBytes, 100); assert.equal(result.requestDigest, 'c'.repeat(64));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.outputs)); assert.ok(Object.isFrozen(result.outputs[0]));
});

test('incremental outputs cannot establish completion and other task/status evidence is rejected', () => {
  for (const status of ['queued', 'running', 'canceling']) assert.equal(collect(receipt(), body([item()], { status })), null);
  for (const status of ['failed', 'canceled', 'expired']) assert.throws(() => collect(receipt(), body([item()], { status })), rejected('execution'));
  assert.throws(() => collect(receipt(), body([item()], { error: { message: 'temporary secret' } })), rejected('status'));
  assert.throws(() => collect(receipt(), body([item()], { id: 'other' })), { code: 'comfy_cloud_response_identity' });
  assert.throws(() => collect(receipt(), body([item(1, { job_id: 'other' })])), rejected('identity'));
});

test('preview, unsupported media and unnamed nodes never silently become a final still', () => {
  assert.throws(() => collect(receipt(), body([item(1, { node_id: 'preview' })])), rejected('missing'));
  assert.throws(() => collect(receipt(), body([item(1, { node_id: 'unselected' })])), rejected('missing'));
  for (const patch of [{ type: 'video' }, { type: 'audio' }, { content_type: 'image/gif' }])
    assert.throws(() => collect(receipt(), body([item(1, patch)])), rejected('type'));
  for (const node_id of ['', undefined, '../save']) assert.throws(() => collect(receipt(), body([item(1, { node_id })])), rejected('node'));
  const rh = receipt(); rh.task = bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1'), '123');
  assert.throws(() => collect(rh, { taskId: '123', status: 'SUCCESS', results: [{ url: 'https://signed.test/a.png' }] }), { code: 'comfy_cloud_results_unsupported' });
});

test('duplicate assets are deduplicated only when their evidence matches; content hashes do not merge separate outputs', () => {
  const first = item(1, { hash: `blake3:${'a'.repeat(64)}` });
  assert.equal(collect(receipt(), body([first, { ...first, url: 'https://signed.test/refreshed' }])).outputs.length, 1);
  for (const patch of [{ size_bytes: 101 }, { node_id: 'preview' }, { hash: null }, { content_type: 'image/jpeg' }])
    assert.throws(() => collect(receipt(), body([first, { ...first, ...patch }])), rejected('conflict'));
  const r = receipt(); r.stillOutput.execution.expectedImages = 2;
  assert.equal(collect(r, body([first, item(2, { hash: first.hash })])).outputs.length, 2);
});

test('all final outputs participate in automatic count protection, not just the selected save node', () => {
  const r = receipt(); r.stillOutput.execution.automatic = true; r.stillOutput.execution.maxImages = 1;
  assert.equal(collect(r, body([item(2, { node_id: 'preview' }), item()])).outputs.length, 1);
  assert.throws(() => collect(r, body([item(), item(2, { node_id: 'unselected' })])), rejected('count'));
  assert.throws(() => collect(receipt(), body(Array.from({ length: 9 }, (_, i) => item(i + 1, { node_id: i ? 'unselected' : 'save' })))), rejected('count'));
  assert.throws(() => collect(receipt(), body([item(), item(2)])), rejected('count'));
});

test('asset metadata, selected byte totals and output list bounds fail before any download', () => {
  for (const patch of [{ id: '../x' }, { size_bytes: 0 }, { size_bytes: Infinity }, { hash: undefined }, { hash: 'not-a-hash' }, { content_type: null }])
    assert.throws(() => collect(receipt(), body([item(1, patch)])), rejected('asset'));
  assert.throws(() => collect(receipt(), body([item(1, { size_bytes: 49 * 1024 * 1024 })])), rejected('size'));
  const r = receipt(); r.stillOutput.execution.expectedImages = 2;
  assert.throws(() => collect(r, body([item(1, { size_bytes: 25 * 1024 * 1024 }), item(2, { size_bytes: 25 * 1024 * 1024 })])), rejected('size'));
  assert.throws(() => collect(receipt(), body(new Array(4097))), rejected('shape'));
  assert.throws(() => collect(receipt(), body([null])), rejected('shape'));
});
