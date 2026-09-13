import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareComfyCloudSubmission as prepare } from '../qianmu-comfy-cloud-prepare.js';
import { bindComfyCloudProtocol } from '../qianmu-comfy-cloud-protocol.js';
import { comfyWorkflowReferenceHash } from '../qianmu-comfy-references.js';
const node = (class_type, inputs = {}) => ({ class_type, inputs });
const graph = () => ({
  checkpoint: node('CheckpointLoaderSimple', { ckpt_name: 'saved.safetensors' }),
  positive: node('CLIPTextEncode', { text: 'fixed style, %qianmu_prompt%', clip: ['checkpoint', 1] }),
  negative: node('CLIPTextEncode', { text: 'fixed negative', clip: ['checkpoint', 1] }),
  latent: node('EmptyLatentImage', { width: '%qianmu_width%', height: 512, batch_size: 1 }),
  sampler: node('KSampler', { model: ['checkpoint', 0], positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0], seed: '%qianmu_seed%' }),
  decode: node('VAEDecode', { samples: ['sampler', 0], vae: ['checkpoint', 2] }), save: node('SaveImage', { images: ['decode', 0] }),
});
const cloud = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
const rh = bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1');
const source = (connection = cloud) => ({ connection, workflow: graph(), prompt: 'rain, %qianmu_negative%', negativePrompt: 'dynamic negative', model: 'workflow',
  parameters: { seed: 12, width: 768 }, execution: { version: 1, automatic: true, maxImages: 1, outputNodeIds: ['save'], allowUnverified: false } });
const invalid = { code: 'comfy_cloud_prepare_invalid', submissionState: 'not_submitted', retryable: false };

test('cloud preparation preserves topology and fixed words, performs one typed slot pass, and owns its snapshot', async () => {
  const input = source(), before = structuredClone(input), prepared = prepare(input), actual = prepared.body.workflow;
  assert.equal(actual.positive.inputs.text, 'fixed style, rain, %qianmu_negative%');
  assert.equal(actual.negative.inputs.text, 'fixed negative'); assert.equal(actual.latent.inputs.width, 768);
  assert.deepEqual(actual.save, before.workflow.save); assert.deepEqual(input, before);
  assert.equal(prepared.intent.workflow.templateHash, await comfyWorkflowReferenceHash(before.workflow));
  assert.equal(prepared.intent.workflow.executionHash, await comfyWorkflowReferenceHash(actual));
  assert.notEqual(prepared.intent.workflow.templateHash, prepared.intent.workflow.executionHash);
  input.workflow.save.inputs.images[0] = 'changed'; input.parameters.width = 999;
  assert.deepEqual(actual.save, before.workflow.save); assert.equal(Object.isFrozen(actual.sampler.inputs), true);
  assert.equal(prepared.intent.stillOutput.execution.expectedImages, 1); assert.equal(Object.hasOwn(prepared.intent.stillOutput.execution, 'allowUnverified'), false);
});

test('RH wraps the compiled graph as a string without a second node override or credential layer', () => {
  const input = source(rh); input.runninghub = { workflowId: '1904136902449209346' };
  const prepared = prepare(input);
  assert.equal(typeof prepared.body.workflow, 'string'); assert.equal(prepared.body.workflowId, input.runninghub.workflowId);
  assert.equal(JSON.parse(prepared.body.workflow).latent.inputs.width, 768);
  assert.deepEqual(Object.keys(prepared.body).sort(), ['workflow', 'workflowId']);
  assert.equal(prepared.bodyBytes, Buffer.byteLength(JSON.stringify(prepared.body)));
  assert.notEqual(prepared.intent.requestDigest, prepare(source()).intent.requestDigest);
});

test('RH runtime tier is a frozen, hashed user choice independent of the compiled workflow, never an automatic upgrade', () => {
  const digests = new Set(), base = prepare(source(rh));
  assert.equal(Object.hasOwn(base.body, 'instanceType'), false, 'historical unspecified mode stays unspecified');
  for (const instanceType of ['default', 'plus', 'ultra']) {
    const input = source(rh); input.runninghub = { instanceType };
    const got = prepare(input); input.runninghub.instanceType = 'changed';
    assert.equal(got.body.instanceType, instanceType); assert.ok(Object.isFrozen(got.body));
    assert.equal(got.body.workflow, base.body.workflow); assert.deepEqual(got.intent.workflow, base.intent.workflow);
    assert.notEqual(got.intent.requestDigest, base.intent.requestDigest); digests.add(got.intent.requestDigest);
    assert.deepEqual(Object.keys(got.body).sort(), ['instanceType', 'workflow']);
  }
  assert.equal(digests.size, 3);
  for (const runninghub of [{}, { instanceType: 'pro' }, { instanceType: 'PLUS' }, { instanceType: null },
    { instanceType: 'lite' }, { instanceType: 'default', retainSeconds: 60 }, { instanceType: 'plus', nodeInfoList: [] },
    { instanceType: 'plus', workflowId: 123 }]) assert.throws(() => prepare({ ...source(rh), runninghub }), invalid);
  assert.throws(() => prepare({ ...source(), runninghub: { instanceType: 'plus' } }), invalid, 'RH settings cannot leak into Comfy Cloud');
});

test('saved recipe hash must match the original graph rather than the dynamic execution graph', async () => {
  const input = source(), hash = await comfyWorkflowReferenceHash(input.workflow);
  input.binding = { schemaVersion: 1, namespace: 'st-user:fixture', id: 'saved', revision: 'first', version: 1, name: 'Saved', workflowHash: hash, recipeHash: 'd'.repeat(64) };
  assert.equal(prepare(input).intent.workflow.binding.workflowHash, hash);
  input.workflow.negative.inputs.text = 'changed'; assert.throws(() => prepare(input), invalid);
});

test('unknown fields, connection credentials, unsupported references and invalid formats fail before submission', () => {
  for (const change of [v => { v.apiKey = 'test-only-secret'; }, v => { v.parameters.token = 'test-only-secret'; }, v => { v.execution.apiKey = 'test-only-secret'; }, v => { v.parameters = false; }, v => { v.model = 0; },
    v => { v.references = []; }, v => { v.workflow.positive.inputs.text = '%qianmu_reference% %qianmu_prompt%'; },
    v => { v.workflow = { nodes: [] }; }, v => { v.workflow.positive.inputs.text = '%qianmu_future%'; },
    v => { v.runninghub = { workflowId: '123' }; }, v => { v.prompt = ''; }, v => { v.prompt = '长'.repeat(24001); }]) {
    const input = source(); change(input); assert.throws(() => prepare(input), invalid);
  }
  let reads = 0; const input = source(); Object.defineProperty(input.workflow.save.inputs, 'images', { enumerable: true, get() { reads++; return ['decode', 0]; } });
  assert.throws(() => prepare(input), invalid); assert.equal(reads, 0);
});

test('automatic multi-image and unverified graphs remain blocked by the existing execution audit', () => {
  const input = source(); input.workflow.latent.inputs.batch_size = 2; assert.throws(() => prepare(input), invalid);
  input.workflow.latent.inputs.batch_size = 1; input.workflow.decode.class_type = 'UnknownDecode'; assert.throws(() => prepare(input), invalid);
  input.execution.automatic = false; input.execution.allowUnverified = true;
  assert.equal(prepare(input).intent.stillOutput.execution.automatic, false);
});

test('one prepared random seed is stable and affects the actual execution identity', () => {
  const input = source(); input.parameters.seed = -1;
  const prepared = prepare(input), seed = prepared.body.workflow.sampler.inputs.seed;
  assert.ok(Number.isSafeInteger(seed) && seed >= 0); assert.equal(prepared.body.workflow.sampler.inputs.seed, seed);
  input.parameters.seed = seed;
  assert.equal(prepare(input).intent.workflow.executionHash, prepared.intent.workflow.executionHash);
});
