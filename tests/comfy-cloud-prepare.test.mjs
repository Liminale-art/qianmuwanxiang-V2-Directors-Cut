import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareComfyCloudSubmission as prepare, prepareComfyCloudSubmissionInput } from '../qianmu-comfy-cloud-prepare.js';
import { planComfyCloudUpload, readComfyCloudUpload } from '../qianmu-comfy-cloud-upload-contract.js';
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

test('reference admission freezes selection before IO and only hashes the graph with actual host uploads', async () => {
  for (const connection of [cloud, rh]) {
    const input=source(connection), original=graph();
    input.references=[{url:'/user/images/reference.png',name:'private name',mime:'image/png',bytes:123,sha256:'a'.repeat(64)}];
    input.workflow.reference=node('LoadImage',{image:'%qianmu_reference%'});
    input.workflow.save.inputs.images=['reference',0];
    const admission=prepareComfyCloudSubmissionInput(input), plan=planComfyCloudUpload(connection,input.references[0]);
    const upload=readComfyCloudUpload(plan,connection.provider==='comfy-cloud'
      ? {id:'00112233-4455-6677-8899-aabbccddeeff',hash:null,size_bytes:123,content_type:'image/png',file_path:plan.filename}
      : {code:0,data:{type:'image',size:'123',fileName:'openapi/reference.png'}});
    input.references[0].sha256='b'.repeat(64); input.workflow.negative.inputs.text='changed after admission';
    assert.equal(Object.hasOwn(admission,'intent'),false,'placeholder hashes must never become a reserved task');
    assert.throws(()=>admission.complete([]),invalid);
    const compiled=admission.complete([upload]), actual=typeof compiled.body.workflow==='string'?JSON.parse(compiled.body.workflow):compiled.body.workflow;
    assert.deepEqual(actual.reference.inputs.image,upload.reference);
    assert.deepEqual(actual.negative,original.negative);
    assert.equal(compiled.intent.workflow.executionHash,await comfyWorkflowReferenceHash(actual));
    assert.equal(compiled.intent.stillOutput.execution.expectedImages,1);
    assert.equal(Object.isFrozen(admission.references[0]),true);
    assert.throws(()=>admission.complete([{...upload,source:{...upload.source,sha256:'c'.repeat(64)}}]),invalid);
  }
});

test('bad reference slots, source counts and admission settings fail before upload authority is requested', () => {
  const input=source(); input.references=[{url:'/user/images/reference.png',name:'ref',mime:'image/png',bytes:123,sha256:'a'.repeat(64)}];
  assert.throws(()=>prepareComfyCloudSubmissionInput(input),invalid,'unused source must not upload');
  input.workflow.reference=node('LoadImage',{image:'prefix/%qianmu_reference%'});
  assert.throws(()=>prepareComfyCloudSubmissionInput(input),invalid,'embedded typed assets cannot form filenames');
  input.workflow.reference.inputs.image='%qianmu_reference%';input.workflow.save.inputs.images=['reference',0];
  assert.throws(()=>prepare(input),invalid,'legacy preparation cannot accept user-supplied uploads');
  assert.throws(()=>prepareComfyCloudSubmissionInput({...input,uploads:[]}),invalid);
  assert.throws(()=>prepareComfyCloudSubmissionInput({...input,execution:{...input.execution,maxImages:0}}),invalid);
  assert.throws(()=>prepareComfyCloudSubmissionInput({...input,references:Array(17).fill(input.references[0])}),invalid);
  assert.throws(()=>prepareComfyCloudSubmissionInput({...input,references:Array(4).fill({...input.references[0],bytes:16*1024*1024})}),invalid);
});

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

test('RH wraps the compiled graph and mirrors its seed without caller overrides or credentials', () => {
  const input = source(rh); input.runninghub = { workflowId: '1904136902449209346' };
  const prepared = prepare(input);
  assert.equal(typeof prepared.body.workflow, 'string'); assert.equal(prepared.body.workflowId, input.runninghub.workflowId);
  assert.equal(JSON.parse(prepared.body.workflow).latent.inputs.width, 768);
  assert.deepEqual(Object.keys(prepared.body).sort(), ['nodeInfoList', 'workflow', 'workflowId']);
  assert.deepEqual(prepared.body.nodeInfoList, [{ nodeId: 'sampler', fieldName: 'seed', fieldValue: 12 }]);
  assert.equal(prepared.bodyBytes, Buffer.byteLength(JSON.stringify(prepared.body)));
  assert.notEqual(prepared.intent.requestDigest, prepare(source()).intent.requestDigest);
});

test('production deployments receive only the frozen API graph, without invented editor version or inputs fields',()=>{
  const binding=bindComfyCloudProtocol('https://sample.run.comfy.app','comfy-cloud-v2');
  const input=source(binding);input.execution.automatic=false;
  const prepared=prepare(input);
  assert.deepEqual(Object.keys(prepared.body),['workflow']);
  assert.equal(prepared.body.workflow.positive.inputs.text,'fixed style, rain, %qianmu_negative%');
  assert.equal(prepared.body.workflow.negative.inputs.text,'fixed negative');
  assert.deepEqual(prepared.body.workflow.save,input.workflow.save);
  assert.equal(prepared.intent.connection.origin,binding.origin);
  for(const field of ['inputs','webhook_url','workflow_id','workflow_version','extra_data'])assert.throws(()=>prepare({...input,[field]:{}}),invalid);
});

test('RH runtime tier is a frozen, hashed user choice independent of the compiled workflow, never an automatic upgrade', () => {
  const digests = new Set(), base = prepare(source(rh));
  assert.equal(Object.hasOwn(base.body, 'instanceType'), false, 'historical unspecified mode stays unspecified');
  for (const instanceType of ['default', 'plus', 'ultra']) {
    const input = source(rh); input.runninghub = { instanceType };
    const got = prepare(input); input.runninghub.instanceType = 'changed';
    assert.equal(got.body.instanceType, instanceType); assert.ok(Object.isFrozen(got.body));
    assert.equal(got.body.workflow, base.body.workflow);
    assert.equal(got.intent.workflow.templateHash, base.intent.workflow.templateHash);
    assert.equal(got.intent.workflow.executionHash, base.intent.workflow.executionHash);
    assert.notEqual(got.intent.workflow.validationScope, base.intent.workflow.validationScope);
    assert.notEqual(got.intent.requestDigest, base.intent.requestDigest); digests.add(got.intent.requestDigest);
    assert.deepEqual(Object.keys(got.body).sort(), ['instanceType', 'nodeInfoList', 'workflow']);
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

test('RH preserves literal seeds, zero and exact uint64 strings from all nodes without rewriting the graph', async () => {
  const input = source(rh); input.parameters.seed = 0;
  input.execution.automatic = false; input.execution.allowUnverified = true;
  input.workflow.noise = node('RandomNoise', { noise_seed: '18446744073709551615' });
  input.workflow.detail = node('CustomSampler', { seed: 42, text: 'do not mirror prompts' });
  const before = structuredClone(input), prepared = prepare(input), actual = JSON.parse(prepared.body.workflow);
  assert.deepEqual(prepared.body.nodeInfoList, [
    { nodeId: 'sampler', fieldName: 'seed', fieldValue: 0 },
    { nodeId: 'noise', fieldName: 'noise_seed', fieldValue: '18446744073709551615' },
    { nodeId: 'detail', fieldName: 'seed', fieldValue: 42 },
  ]);
  assert.deepEqual(input, before);
  for (const entry of prepared.body.nodeInfoList) assert.equal(entry.fieldValue, actual[entry.nodeId].inputs[entry.fieldName]);
  assert.deepEqual(actual.noise, before.workflow.noise); assert.deepEqual(actual.detail, before.workflow.detail);
  assert.equal(prepared.intent.workflow.executionHash, await comfyWorkflowReferenceHash(actual));
  assert.ok(Object.isFrozen(prepared.body.nodeInfoList[0]));
});

test('RH seed protection never mirrors links, metadata, nested values, prompt text or invented inputs', () => {
  const input = source(rh); input.workflow.sampler.inputs.seed = ['integer', 0];
  input.execution.automatic = false; input.execution.allowUnverified = true;
  input.workflow.integer = node('PrimitiveInt', { value: 123 });
  input.workflow.positive.inputs.text = '%qianmu_prompt%';
  input.workflow.positive._meta = { seed: 456 };
  input.workflow.detail = node('CustomSampler', { settings: { seed: 789 }, random_seed: 90 });
  const result = prepare(input);
  assert.equal(Object.hasOwn(result.body, 'nodeInfoList'), false);
  const actual = JSON.parse(result.body.workflow);
  assert.deepEqual(actual.sampler.inputs.seed, ['integer', 0]);
  assert.deepEqual(actual.detail, input.workflow.detail);
  assert.equal(actual.positive.inputs.text, input.prompt);
});

test('RH random seed is selected once before IO and the mirror stays identical across completion calls', () => {
  const input = source(rh); input.parameters.seed = -1;
  const admission = prepareComfyCloudSubmissionInput(input);
  input.parameters.seed = 999; input.workflow.sampler.inputs.seed = 888;
  const first = admission.complete([]), second = admission.complete([]), value = first.body.nodeInfoList[0].fieldValue;
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.equal(value, JSON.parse(first.body.workflow).sampler.inputs.seed);
  assert.deepEqual(first, second); assert.ok(Object.isFrozen(first.body.nodeInfoList));
});

test('RH refuses imprecise or invalid scalar seeds before creating a submission intent', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'random', '1e3', '18446744073709551616', null, true, { seed: 1 }]) {
    const input = source(rh); input.workflow.sampler.inputs.seed = value;
    assert.throws(() => prepareComfyCloudSubmissionInput(input), invalid, String(value));
  }
});

test('seed mirrors stay RH-only and callers cannot supply arbitrary nodeInfoList overrides', () => {
  for (const connection of [cloud, rh]) {
    const input = source(connection);
    assert.throws(() => prepare({ ...input, nodeInfoList: [{ nodeId: 'save', fieldName: 'images', fieldValue: [] }] }), invalid);
    if (connection === cloud) assert.equal(Object.hasOwn(prepare(input).body, 'nodeInfoList'), false);
  }
  const first = source(rh), second = source(rh); second.parameters.seed = 13;
  assert.notEqual(prepare(first).intent.requestDigest, prepare(second).intent.requestDigest);
  assert.notEqual(prepare(first).intent.workflow.executionHash, prepare(second).intent.workflow.executionHash);
});
