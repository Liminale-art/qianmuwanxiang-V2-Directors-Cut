// Maintainer-only, offline artifacts. Never installs models, contacts a provider,
// submits work, or turns a candidate into an approved built-in workflow.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeComfyLibraryDocument, exportComfyLibraryDocument } from '../qianmu-comfy-library.js';
import { inspectComfyWorkflow } from '../qianmu-comfy-workflow.js';
import { checkComfyConfiguration } from '../qianmu-comfy-preflight.js';
import { prepareComfyCloudSubmission } from '../qianmu-comfy-cloud-prepare.js';
import { bindComfyCloudProtocol } from '../qianmu-comfy-cloud-protocol.js';

export const STILL_CANDIDATE_IDS = Object.freeze(['comfy-cloud-anime', 'comfy-cloud-cg', 'runninghub-anime', 'runninghub-cg']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`内置静帧候选：${message}`); };
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sorted = values => [...values].sort();
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const exact = (value, keys, label) => {
  if (!object(value) || !same(sorted(Object.keys(value)), sorted(keys))) fail(`${label}字段不完整或含未支持内容`);
};
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const MODEL_INPUTS = {
  CheckpointLoaderSimple: ['ckpt_name', 'checkpoints'], UNETLoader: ['unet_name', 'diffusion_models'],
  CLIPLoader: ['clip_name', 'text_encoders'], VAELoader: ['vae_name', 'vae'],
};
const URLS = new Set(['github.com', 'docs.comfy.org', 'huggingface.co', 'www.runninghub.ai', 'www.runninghub.cn']);

export async function readStillCandidate(id) {
  if (!STILL_CANDIDATE_IDS.includes(id)) fail('方案编号无效');
  return JSON.parse(await readFile(new URL(`../workflows/still-candidates/${id}.json`, import.meta.url), 'utf8'));
}

export function validateStillCandidate(raw) {
  exact(raw, ['schema', 'id', 'revision', 'name', 'provider', 'style', 'status', 'releaseReady', 'document',
    'dependencies', 'inputModes', 'sizes', 'defaultSize', 'cost', 'qualification', 'sources', 'licenseReview', 'limitations'], '方案');
  if (raw.schema !== 'qianmu.comfy.still-candidate.v1' || !STILL_CANDIDATE_IDS.includes(raw.id)
    || !['comfy-cloud', 'runninghub'].includes(raw.provider) || !['anime', 'cg'].includes(raw.style)
    || raw.id !== `${raw.provider}-${raw.style}` || !/^\d+\.\d+\.\d+-candidate\.\d+$/.test(raw.revision)
    || !nonempty(raw.name) || raw.name.length > 80 || raw.status !== 'unverified' || raw.releaseReady !== false) fail('身份、平台或未验收状态无效');
  exact(raw.qualification, ['platformRuntime', 'actualGenerationVerified', 'qualityReviewed', 'licenseReviewed', 'evidence'], '验收');
  if (raw.qualification.platformRuntime !== null || raw.qualification.actualGenerationVerified !== false
    || raw.qualification.qualityReviewed !== false || raw.qualification.licenseReviewed !== false
    || !same(raw.qualification.evidence, [])) fail('候选不得伪造真实验收或发行资格');
  if (!same(raw.inputModes, { textOnly: true, referenceCount: 0, characterIdentity: false })) fail('本批仅支持无参考文生图');
  if (!same(raw.cost, { basis: 'provider_gpu_usage', amount: null, currency: null, partnerApiNodes: false })) fail('费用只能保留待真实核定的GPU用量边界');
  if (!nonempty(raw.licenseReview) || !Array.isArray(raw.limitations) || !raw.limitations.length || raw.limitations.some(value => !nonempty(value))) fail('缺少许可核查或能力限制');
  if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.some(value => {
    try { const url = new URL(value); return url.protocol !== 'https:' || !URLS.has(url.hostname) || url.username || url.password || url.search || url.hash; }
    catch { return true; }
  })) fail('来源须为明确的公开一手资料，不含凭据或跟踪参数');
  const document = normalizeComfyLibraryDocument(raw.document), graph = JSON.parse(document.workflow);
  if (!same({ ...document, workflow: graph }, raw.document)) fail('工作流文档不能经脱敏、修剪或忽略字段后悄悄变更');
  if (document.positivePrompt || document.negativePrompt || !document.classification?.promptFormat
    || !same(document.classification.contentClasses, ['sfw'])) fail('固定画风须位于图内，本批仅核定SFW候选');
  if (raw.provider === 'runninghub' ? document.runninghubInstanceType !== 'default' : Object.hasOwn(document, 'runninghubInstanceType')) fail('平台运行档位不匹配');
  exact(raw.dependencies, ['nodes', 'models', 'customNodes'], '依赖');
  if (!same(raw.dependencies.customNodes, []) || !Array.isArray(raw.dependencies.nodes)
    || !same(sorted(raw.dependencies.nodes), sorted(new Set(Object.values(graph).map(node => node.class_type))))) fail('节点依赖未完整声明');
  const models = Object.entries(graph).flatMap(([id, node]) => {
    if (!Object.hasOwn(MODEL_INPUTS, node.class_type)) return [];
    const [field, category] = MODEL_INPUTS[node.class_type];
    const filename = node.inputs[field];
    if (!nonempty(filename) || /[%:/\\\u0000-\u001f]/.test(filename) || filename.includes('..')) fail('模型须固定为已注明来源的文件名');
    return [{ node: id, field, category, filename }];
  });
  if (!models.length || !same(raw.dependencies.models, models)) fail('模型依赖与实际图不一致');
  const inspection = inspectComfyWorkflow(document.workflow);
  if (!inspection.ok || !same(sorted(inspection.slots), ['height', 'negative', 'prompt', 'seed', 'width'])) fail('候选仅开放提示、排除词、种子与宽高槽');
  const samplers = Object.values(graph).filter(node => node.class_type === 'KSampler');
  const sampling = samplers[0]?.inputs;
  if (samplers.length !== 1 || sampling.seed !== '%qianmu_seed%' || sampling.denoise !== 1
    || !Number.isInteger(sampling.steps) || sampling.steps < 1 || sampling.steps > 80
    || !Number.isFinite(sampling.cfg) || sampling.cfg <= 0 || sampling.cfg > 12
    || !['euler', 'dpmpp_2m'].includes(sampling.sampler_name) || !['simple', 'karras'].includes(sampling.scheduler)
    || document.parameters.count !== '1' || document.parameters.seed !== '-1'
    || Number(document.parameters.steps) !== sampling.steps || Number(document.parameters.cfg) !== sampling.cfg
    || document.parameters.sampler !== sampling.sampler_name || document.parameters.scheduler !== sampling.scheduler) fail('固定采样参数与方案记录不一致');
  if (!Array.isArray(raw.sizes) || !raw.sizes.length || raw.sizes.length > 16
    || new Set(raw.sizes.map(size => size.id)).size !== raw.sizes.length
    || new Set(raw.sizes.map(size => `${size.width}x${size.height}`)).size !== raw.sizes.length) fail('常用尺寸清单无效');
  for (const size of raw.sizes) {
    exact(size, ['id', 'width', 'height'], '尺寸');
    if (!/^[a-z][a-z-]{0,30}$/.test(size.id) || [size.width, size.height].some(value => !Number.isInteger(value) || value < 512 || value > 1536 || value % 64)
      || size.width * size.height > 1536 * 1536) fail('候选尺寸未落在本批维护范围');
    const check = checkComfyConfiguration({ workflow: document.workflow, outputNodeId: document.outputNodeId,
      parameters: { ...document.parameters, width: size.width, height: size.height, seed: 1 }, automatic: true });
    if (!check.report.automaticSafe || check.report.samplingStages !== 1 || check.report.savedImages !== 1) fail('不是一镜一张的单阶段静帧');
  }
  const selected = raw.sizes.find(size => size.id === raw.defaultSize);
  if (!selected || Number(document.parameters.width) !== selected.width || Number(document.parameters.height) !== selected.height) fail('默认尺寸与清单不一致');
  return { id: raw.id, provider: raw.provider, style: raw.style, revision: raw.revision, artifactDigest: digest(raw),
    graphDigest: digest(graph), document, sizes: structuredClone(raw.sizes), releaseReady: false, actualGenerationVerified: false };
}

export function prepareStillCandidateCase(raw, { sizeId = raw.defaultSize, seed = 20260922,
  prompt = 'Two adults prepare a meal in a kitchen. One holds a wooden spoon above a pot; the other passes a small blue bowl. Warm side light from the left window, natural interaction, both hands and the shared counter visible.',
  negativePrompt = 'duplicate person, unreadable hands' } = {}) {
  const candidate = validateStillCandidate(raw), size = candidate.sizes.find(value => value.id === sizeId);
  if (!size || !Number.isSafeInteger(seed) || seed < 0) fail('试跑尺寸或种子无效');
  const connection = raw.provider === 'runninghub'
    ? bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1')
    : bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
  const input = { connection, workflow: candidate.document.workflow, prompt, negativePrompt, model: 'comfy-workflow',
    parameters: { ...candidate.document.parameters, width: size.width, height: size.height, seed },
    execution: { version: 1, automatic: false, maxImages: 1, outputNodeIds: [candidate.document.outputNodeId], allowUnverified: false },
    ...(raw.provider === 'runninghub' ? { runninghub: { instanceType: candidate.document.runninghubInstanceType } } : {}) };
  const prepared = prepareComfyCloudSubmission(input);
  return { candidateId: candidate.id, artifactDigest: candidate.artifactDigest, sizeId, seed, input, prepared,
    actualGenerationVerified: false, releaseReady: false };
}

export function exportStillCandidate(raw) {
  const candidate = validateStillCandidate(raw);
  return exportComfyLibraryDocument(`待验证 · ${raw.name}`, candidate.document);
}

export async function inspectStillCandidates() {
  const results = [];
  for (const id of STILL_CANDIDATE_IDS) {
    const raw = await readStillCandidate(id), candidate = validateStillCandidate(raw);
    const cases = raw.sizes.map(size => prepareStillCandidateCase(raw, { sizeId: size.id }));
    results.push({ id, revision: raw.revision, provider: raw.provider, artifactDigest: candidate.artifactDigest,
      nodeCount: Object.keys(raw.document.workflow).length, nodeClasses: raw.dependencies.nodes.length, modelFiles: raw.dependencies.models.length,
      sizes: cases.map(item => ({ id: item.sizeId, executionHash: item.prepared.intent.workflow.executionHash })),
      actualGenerationVerified: false, releaseReady: false });
  }
  return { mode: 'offline-only', candidates: results.length, preparedCases: results.reduce((n, row) => n + row.sizes.length, 0),
    networkRequests: 0, submittedTasks: 0, releaseReady: false, results };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  try {
    if (args.length && !(args.length === 2 && args[0] === '--export' && STILL_CANDIDATE_IDS.includes(args[1]))) fail('只支持无参数离线检查，或 --export <方案编号>');
    console.log(JSON.stringify(args.length ? exportStillCandidate(await readStillCandidate(args[1])) : await inspectStillCandidates(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
