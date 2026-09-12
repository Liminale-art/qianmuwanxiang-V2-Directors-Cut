import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { normalizeComfyReceipt } from '../qianmu-comfy-receipt.js';
import { COMFY_CLOUD_RECEIPT_SCHEMA as schema, normalizeComfyCloudReceipt as normalize, assertComfyCloudReceiptMatches as matches } from '../qianmu-comfy-cloud-receipt.js';
import { COMFY_CLOUD_INTENT_SCHEMA, normalizeComfyCloudIntent, assertComfyCloudReceiptForIntent } from '../qianmu-comfy-cloud-receipt.js';
const connection = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
const task = bindComfyCloudTask(connection, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
const stillOutput = { version: 1, model: 'workflow', previewNodeIds: ['preview'], execution: { version: 1, automatic: false, maxImages: 2, outputNodeIds: ['save'], expectedImages: 1 } };
const templateHash = 'a'.repeat(64), executionHash = 'b'.repeat(64), requestDigest = 'c'.repeat(64);
const binding = { schemaVersion: 1, namespace: 'st-user:fixture', id: 'recipe', revision: 'revision', version: 1, name: 'Saved', workflowHash: templateHash, recipeHash: 'd'.repeat(64) };
const receipt = { schema, task, requestDigest, workflow: { templateHash, executionHash, binding }, stillOutput };
const expected = { connection, requestDigest, templateHash, executionHash, upstreamId: 'original' };
const invalid = { code: 'comfy_cloud_receipt_invalid', retryable: false };
const intent = { schema: COMFY_CLOUD_INTENT_SCHEMA, connection, requestDigest, workflow: receipt.workflow, stillOutput };

test('pre-submit intent is an owned frozen snapshot without task id or credentials', () => {
  const source = structuredClone(intent), actual = normalizeComfyCloudIntent(source);
  assert.deepEqual(actual, intent); assert.equal(Object.isFrozen(actual.connection), true);
  assert.equal(Object.isFrozen(actual.stillOutput.execution), true);
  assert.equal(Object.isFrozen(actual.workflow.binding), true);
  source.workflow.binding.name = 'later edit'; source.stillOutput.execution.outputNodeIds.push('later');
  assert.deepEqual(actual, intent);
  assert.throws(() => normalize(intent), invalid);
  assert.throws(() => normalizeComfyCloudIntent(receipt), { code: 'comfy_cloud_intent_invalid' });
});

test('pre-submit intent rejects missing identity, changed platform, future schema and nested authentication', () => {
  let getterReads = 0;
  for (const change of [v => { delete v.workflow; }, v => { v.schema += '.future'; }, v => { v.connection.provider = 'runninghub'; },
    v => { v.apiKey = 'test-only-secret'; }, v => { v.connection.apiKey = 'test-only-secret'; },
    v => { v.workflow.binding.extra_data = { key: 'test-only-secret' }; },
    v => { Object.defineProperty(v, 'requestDigest', { get() { getterReads++; return requestDigest; }, enumerable: true }); }]) {
    const bad = structuredClone(intent); change(bad);
    assert.throws(() => normalizeComfyCloudIntent(bad), error => error.code === 'comfy_cloud_intent_invalid' && !error.message.includes('test-only-secret') && !Object.hasOwn(error, 'submissionState'));
  }
  assert.equal(getterReads, 0, 'invalid objects are rejected without evaluating their accessors');
});

test('accepted receipt must match every frozen workflow version and output choice, not only graph hashes', () => {
  assert.deepEqual(assertComfyCloudReceiptForIntent(receipt, intent, 'original'), receipt);
  for (const change of [r => { r.workflow.binding.version = 2; }, r => { delete r.workflow.binding; },
    r => { r.stillOutput.model = 'different workflow'; }, r => { r.stillOutput.execution.outputNodeIds = ['another']; },
    r => { r.stillOutput.previewNodeIds = []; }, r => { r.stillOutput.execution.maxImages = 3; },
    r => { r.stillOutput.execution.expectedImages = 2; }]) {
    const bad = structuredClone(receipt); change(bad);
    assert.throws(() => assertComfyCloudReceiptForIntent(bad, intent, 'original'), invalid);
  }
});

test('cloud receipt freezes original platform, both workflow hashes and saved version without changing native evidence', () => {
  const source = structuredClone(receipt), before = JSON.stringify(source), actual = normalize(source);
  assert.deepEqual(actual, source); assert.equal(JSON.stringify(source), before);
  assert.notEqual(actual.stillOutput, source.stillOutput); assert.notEqual(actual.workflow.binding, source.workflow.binding);
  for (const object of [actual, actual.workflow, actual.workflow.binding, actual.task.links, actual.stillOutput.execution.outputNodeIds]) assert.equal(Object.isFrozen(object), true);
  assert.deepEqual(normalizeComfyReceipt(stillOutput), stillOutput);
  assert.throws(() => normalizeComfyReceipt(actual), { code: 'comfy_receipt_invalid' });
  assert.throws(() => normalize(stillOutput), invalid);
});
test('execution hash may differ after dynamic slot binding but template hash must match its saved recipe', () => {
  assert.deepEqual(matches(receipt, expected), receipt);
  const bad = structuredClone(receipt); bad.workflow.binding.workflowHash = executionHash;
  assert.throws(() => normalize(bad), invalid);
  const direct = structuredClone(receipt); delete direct.workflow.binding;
  assert.equal(Object.hasOwn(normalize(direct).workflow, 'binding'), false);
});
test('RH task ids retain precision and cannot acquire Cloud links or a different regional origin', () => {
  const rh = bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1');
  const original = { ...receipt, task: bindComfyCloudTask(rh, '1904152026220003329') };
  assert.equal(normalize(original).task.taskId, '1904152026220003329');
  assert.throws(() => normalize({ ...original, task: { ...original.task, links: task.links } }), invalid);
  assert.throws(() => matches(original, { ...expected, connection: bindComfyCloudProtocol('https://www.runninghub.ai', rh.protocol), upstreamId: original.task.taskId }), invalid);
});
test('missing/future fields, credentials and unsafe extra layers are rejected instead of silently dropped', () => {
  for (const key of ['schema', 'task', 'requestDigest', 'workflow', 'stillOutput']) {
    const bad = structuredClone(receipt); delete bad[key]; assert.throws(() => normalize(bad), invalid);
  }
  assert.throws(() => normalize({ ...receipt, schema: 'qianmu.comfy-cloud-receipt.v2' }), invalid);
  for (const path of [[], ['task'], ['workflow'], ['workflow', 'binding'], ['stillOutput'], ['stillOutput', 'execution']]) {
    const bad = structuredClone(receipt); let object = bad; for (const key of path) object = object[key]; object.apiKey = 'test-only-secret';
    assert.throws(() => normalize(bad), error => error.code === invalid.code && !error.message.includes('test-only-secret') && !Object.hasOwn(error, 'submissionState'));
  }
  let getterReads = 0;
  const getter = structuredClone(receipt); Object.defineProperty(getter.workflow, 'templateHash', { get() { getterReads++; return templateHash; }, enumerable: true });
  assert.throws(() => normalize(getter), invalid);
  assert.equal(getterReads, 0, 'an accessor error must not be swallowed and mistaken for successful validation');
});
test('cloud output policy retains existing preview, node uniqueness and automatic single-image constraints', () => {
  for (const change of [value => { value.execution.outputNodeIds = ['preview']; }, value => { value.execution.outputNodeIds = ['save', 'save']; },
    value => { value.execution.maxImages = 9; }, value => { value.execution.automatic = true; }, value => { value.execution.expectedImages = 3; }]) {
    const bad = structuredClone(receipt); change(bad.stillOutput); assert.throws(() => normalize(bad), invalid);
  }
  const automatic = structuredClone(receipt); automatic.stillOutput.execution.automatic = true; automatic.stillOutput.execution.maxImages = 1;
  assert.equal(normalize(automatic).stillOutput.execution.automatic, true);
});
test('a receipt cannot be attached to another reserved request, workflow or cloud connection', () => {
  for (const patch of [{ requestDigest: 'f'.repeat(64) }, { templateHash: executionHash }, { executionHash: templateHash },
    { upstreamId: 'another' }, { connection: { ...connection, protocol: 'future' } },
    { connection: bindComfyCloudProtocol('https://dep-other.run.comfy.app', connection.protocol) }]) {
    assert.throws(() => matches(receipt, { ...expected, ...patch }), invalid);
  }
  assert.throws(() => matches(receipt, undefined), invalid);
});
