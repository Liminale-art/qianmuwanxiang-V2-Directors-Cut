import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STILL_CANDIDATE_IDS, readStillCandidate, validateStillCandidate, prepareStillCandidateCase,
  inspectStillCandidates, exportStillCandidate } from '../scripts/comfy-still-candidates.mjs';
import { importComfyLibraryDocument } from '../qianmu-comfy-library.js';
import { buildComfyCloudRequest } from '../qianmu-comfy-cloud-request.js';
import { prepareComfyCloudSubmission } from '../qianmu-comfy-cloud-prepare.js';
import { collectReleaseFiles, validateReleasePlan } from '../scripts/build-release.mjs';

const graphOf = prepared => typeof prepared.body.workflow === 'string' ? JSON.parse(prepared.body.workflow) : prepared.body.workflow;
const root = fileURLToPath(new URL('../', import.meta.url));
const rows = await Promise.all(STILL_CANDIDATE_IDS.map(readStillCandidate));

test('four platform-owned actual candidate graphs compile all twenty declared sizes without IO or approval claims', async () => {
  const oldFetch = globalThis.fetch; globalThis.fetch = () => assert.fail('offline checker must not call any network');
  try {
    const summary = await inspectStillCandidates();
    assert.equal(summary.candidates, 4); assert.equal(summary.preparedCases, 20);
    assert.equal(summary.submittedTasks, 0); assert.equal(summary.releaseReady, false);
    assert.equal(new Set(summary.results.map(row => row.artifactDigest)).size, 4);
    for (const raw of rows) for (const size of raw.sizes) {
      const item = prepareStillCandidateCase(raw, { sizeId: size.id, seed: 0 }), graph = graphOf(item.prepared);
      assert.equal(graph.latent.inputs.width, size.width); assert.equal(graph.latent.inputs.height, size.height);
      assert.equal(graph.latent.inputs.batch_size, 1); assert.equal(graph.sampler.inputs.seed, 0);
      assert.equal(item.prepared.intent.stillOutput.execution.expectedImages, 1);
      assert.deepEqual(item.prepared.intent.stillOutput.execution.outputNodeIds, ['save']);
      assert.equal(item.prepared.intent.stillOutput.execution.automatic, false);
      assert.equal(item.releaseReady, false); assert.equal(item.actualGenerationVerified, false);
    }
  } finally { globalThis.fetch = oldFetch; }
});

test('maintainer documents survive the real library import and browser-to-host request preparation', () => {
  for (const raw of rows) {
    const exported = exportStillCandidate(raw), imported = importComfyLibraryDocument(JSON.stringify(exported));
    assert.match(imported.name, /^待验证/);
    const checked = validateStillCandidate(raw); assert.deepEqual(imported.document, checked.document);
    const { input, prepared } = prepareStillCandidateCase(raw, { seed: 1234, sizeId: 'portrait' });
    const id = 'synthetic-maintainer-case', namespace = 'st-user:synthetic-test';
    const job = { id, source: 'comfy', automatic: false, profile: {
      ...(raw.provider === 'runninghub' ? { comfyInstanceType: 'default' } : {}) },
      connection: { baseUrl: input.connection.origin }, imageAdmission: { version: 1, attemptId: id, namespace } };
    const gateway = { provider: 'comfy', baseUrl: input.connection.origin, model: 'comfy-workflow',
      prompt: input.prompt, negativePrompt: input.negativePrompt, parameters: { ...input.parameters, workflow: imported.document.workflow },
      comfyExecution: { ...input.execution, expectedImages: 1 } };
    const projected = buildComfyCloudRequest(job, gateway, input.connection);
    assert.deepEqual(prepareComfyCloudSubmission(projected), prepared);
    if (raw.provider === 'runninghub') {
      assert.equal(typeof prepared.body.workflow, 'string');
      assert.deepEqual(prepared.body.nodeInfoList, [{ nodeId: 'sampler', fieldName: 'seed', fieldValue: 1234 }]);
      assert.equal(prepared.body.instanceType, 'default'); assert.match(prepared.intent.workflow.validationScope, /^[a-f0-9]{64}$/);
    } else {
      assert.equal(typeof prepared.body.workflow, 'object');
      assert.equal(Object.hasOwn(prepared.body, 'nodeInfoList'), false);
      assert.equal(Object.hasOwn(prepared.body, 'instanceType'), false);
    }
  }
});

test('platform anime graphs pin different actual loading layouts rather than assuming one JSON is portable', () => {
  const cloud = rows.find(row => row.id === 'comfy-cloud-anime'), rh = rows.find(row => row.id === 'runninghub-anime');
  assert.equal(cloud.document.workflow.model.class_type, 'UNETLoader');
  assert.equal(rh.document.workflow.model.class_type, 'CheckpointLoaderSimple');
  assert.equal(cloud.dependencies.models.length, 3); assert.equal(rh.dependencies.models.length, 1);
  assert.equal(cloud.document.workflow.model.inputs.unet_name, 'anima-base-v1.0.safetensors');
  assert.equal(rh.document.workflow.model.inputs.ckpt_name, 'anima-base-v1.0-checkpoints.safetensors');
  assert.deepEqual(cloud.document.workflow.decode.inputs.vae, ['vae', 0]);
  assert.deepEqual(rh.document.workflow.decode.inputs.vae, ['model', 2]);
});

test('narrative prompts bind literally without topology, style, dependency or quantity changes', () => {
  for (const raw of rows) {
    const before = JSON.stringify(raw), prompt = 'A blue cup on a kitchen counter, cool reflected light. %qianmu_width% "}], private_literal';
    const negativePrompt = 'signature, %qianmu_model%';
    const base = graphOf(prepareStillCandidateCase(raw).prepared);
    const item = prepareStillCandidateCase(raw, { prompt, negativePrompt, seed: 42 }), graph = graphOf(item.prepared);
    assert.ok(graph.positive.inputs.text.endsWith(prompt)); assert.ok(graph.negative.inputs.text.endsWith(negativePrompt));
    assert.equal(graph.latent.inputs.width, 1024);
    assert.deepEqual(graph.model, base.model); assert.deepEqual(graph.sampler.inputs.model, ['model', 0]);
    assert.deepEqual(graph.sampler.inputs.positive, ['positive', 0]); assert.deepEqual(graph.sampler.inputs.negative, ['negative', 0]);
    assert.deepEqual(graph.save.inputs.images, ['decode', 0]); assert.equal(JSON.stringify(raw), before);
  }
});

test('a changed candidate, default or model gets a new artifact identity; prepared tasks remain immutable', () => {
  for (const original of rows) {
    const raw = structuredClone(original), base = prepareStillCandidateCase(raw), digest = base.artifactDigest;
    raw.document.workflow.positive.inputs.text = 'changed style, %qianmu_prompt%';
    assert.notEqual(prepareStillCandidateCase(raw).artifactDigest, digest);
    assert.notEqual(prepareStillCandidateCase(raw).prepared.intent.workflow.executionHash, base.prepared.intent.workflow.executionHash);
    assert.notEqual(graphOf(base.prepared).positive.inputs.text, graphOf(prepareStillCandidateCase(raw).prepared).positive.inputs.text);
    const changed = structuredClone(original); changed.document.workflow.sampler.inputs.steps++;
    assert.throws(() => validateStillCandidate(changed));
    changed.document.parameters.steps = String(changed.document.workflow.sampler.inputs.steps);
    assert.notEqual(validateStillCandidate(changed).artifactDigest, digest);
    assert.throws(() => { base.prepared.intent.workflow.templateHash = 'forged'; }, TypeError);
  }
});

test('unsupported dimensions, seeds, identities, modes and forged qualification stop offline', async () => {
  await assert.rejects(readStillCandidate('../secret'));
  for (const raw of rows) {
    assert.throws(() => prepareStillCandidateCase(raw, { sizeId: 'invented' }));
    assert.throws(() => prepareStillCandidateCase(raw, { seed: -1 }));
    assert.throws(() => prepareStillCandidateCase(raw, { seed: Number.MAX_SAFE_INTEGER + 1 }));
    for (const change of [value => { value.provider = 'unknown'; }, value => { value.releaseReady = true; },
      value => { value.qualification.actualGenerationVerified = true; }, value => { value.qualification.evidence = ['pretend']; },
      value => { value.qualification.platformRuntime = 'guessed'; }, value => { value.inputModes.referenceCount = 1; },
      value => { value.cost.amount = 0; }, value => { value.sources.push('https://private.test/?apiKey=secret'); },
      value => { value.sizes[0].width = 1025; }, value => { value.sizes.push({ ...value.sizes[0] }); },
      value => { value.document.parameters.width = '832'; }, value => { value.document.workflow.latent.inputs.batch_size = 2; }]) {
      const copy = structuredClone(raw); change(copy); assert.throws(() => validateStillCandidate(copy));
    }
  }
});

test('dependency mismatches, custom loaders, paid partner nodes and undeclared model slots cannot pass candidate checks', () => {
  for (const raw of rows) for (const change of [
    value => { value.dependencies.models[0].filename = 'other.safetensors'; },
    value => { value.dependencies.nodes.pop(); }, value => { value.dependencies.customNodes = ['unknown']; },
    value => { value.document.workflow.partner = { class_type: 'PaidPartnerNode', inputs: {} }; value.dependencies.nodes.push('PaidPartnerNode'); },
    value => { value.document.workflow.model.inputs[value.dependencies.models[0].field] = '%qianmu_model%'; },
    value => { value.document.workflow.model.inputs.api_key = 'synthetic-secret'; },
    value => { value.document.apiKey = 'synthetic-secret'; },
    value => { value.document.workflow.save.inputs.images = ['missing', 0]; },
  ]) { const copy = structuredClone(raw); change(copy); assert.throws(() => validateStillCandidate(copy)); }
});

test('CLI default is read-only, export is a library document, and unsupported action cannot submit', () => {
  const run = args => execFileSync(process.execPath, ['scripts/comfy-still-candidates.mjs', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(run([])).preparedCases, 20);
  assert.equal(JSON.parse(run(['--export', 'comfy-cloud-anime'])).schema, 'qianmu.comfy.workflow.v1');
  assert.throws(() => run(['--submit']), error => error.status === 1);
});

test('unverified artifacts and their maintainer tool are absent from the installation bundle', async () => {
  const files = await collectReleaseFiles(root); await validateReleasePlan(root, null, files);
  assert.equal(files.some(file => file.includes('still-candidates') || file === 'scripts/comfy-still-candidates.mjs'), false);
  await assert.rejects(validateReleasePlan(root, null, [...files, 'workflows/still-candidates/comfy-cloud-anime.json']), /forbidden\/invalid/);
});
