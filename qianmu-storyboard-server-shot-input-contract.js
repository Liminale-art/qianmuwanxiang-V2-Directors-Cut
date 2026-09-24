// R2-03: server-only, data-only NAI input contract. This module neither writes
// a snapshot nor authorizes a charge. No route or batch executor imports it.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { sanitizeImageRequest } from './qianmu-image-gateway.js';
import { describeImageServiceRequest, imageServiceChannelKey } from './qianmu-image-service-queue.js';
import { storyboardServerBatchKey } from './qianmu-storyboard-server-batch-contract.js';

const SCHEMA = 'qianmu.storyboard-shot-input.novel.v1';
const ATTEMPT = /^shotjob-[0-9a-z]{1,11}-[0-9a-z]{1,4}-(?:[a-f0-9]{8}|[0-9a-z]{1,7})$/;
const SHA = /^[a-f0-9]{64}$/;
const ROOT_FIELDS = new Set(['provider', 'modelFamily', 'protocol', 'imageProtocolVersion', 'apiKey',
  'baseUrl', 'model', 'capabilityModelId', 'allowPrivateNetwork', 'prompt', 'negativePrompt',
  'references', 'referenceImages', 'vibes', 'novelVibeVersion', 'parameters']);
const PARAMETER_FIELDS = new Set(['width', 'height', 'size', 'aspectRatio', 'imageSize', 'quality',
  'background', 'outputFormat', 'count', 'seed', 'steps', 'scale', 'cfg', 'sampler', 'scheduler',
  'guidanceScale', 'watermark', 'sequential', 'workflow', 'providerOptions', 'timeoutMs', 'pollIntervalMs']);
const PARAMETER_TEXT = { size: 40, aspectRatio: 20, imageSize: 20, quality: 40, background: 40,
  outputFormat: 20, sampler: 120, scheduler: 120 };
const REFERENCE_FIELDS = new Set(['data', 'base64', 'mime', 'name', 'strength', 'information',
  'fidelity', 'referenceType']);
const VIBE_IMAGE_FIELDS = new Set(['kind', 'data', 'base64', 'mime', 'strength', 'information', 'byteLength']);
const VIBE_ENCODING_FIELDS = new Set(['kind', 'data', 'encodingModel', 'strength', 'information',
  'byteLength', 'variant']);
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 48 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), {
  name: 'StoryboardShotInputError', code: `storyboard_shot_input_${code}`,
  status, submissionState: 'not_submitted',
}); };

function plain(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('shape', `${name}结构无效，未封存镜头`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || allowed && !allowed.has(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
      fail('shape', `${name}包含不受支持的字段，未封存镜头`);
    }
  }
  return value;
}
function textWithin(value, max, name, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) {
    fail('size', `${name}无效或超过安全长度，未截断、未封存镜头`, 413);
  }
}
function assertJsonData(value, name, depth = 0, budget = { nodes: 0 }, seen = new Set()) {
  if (++budget.nodes > 5000 || depth > 10) fail('size', `${name}结构过大，未封存镜头`, 413);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) fail('shape', `${name}含非 JSON 数据，未封存镜头`);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) fail('shape', `${name}数组不完整，未封存镜头`);
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('shape', `${name}数组含动态属性，未封存镜头`);
      assertJsonData(descriptor.value, name, depth + 1, budget, seen);
    }
    seen.delete(value);
    return;
  }
  plain(value, null, name);
  seen.add(value);
  for (const item of Object.values(value)) assertJsonData(item, name, depth + 1, budget, seen);
  seen.delete(value);
}
function images(value, name) {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 16 || Reflect.ownKeys(value).length !== value.length + 1) {
    fail('size', `${name}超出安全数量或列表不完整，未截断、未封存镜头`, 413);
  }
  let encodedLength = 0;
  for (const row of value) {
    plain(row, null, name);
    plain(row, name !== 'Vibe' ? REFERENCE_FIELDS
      : row?.kind === 'novelai-vibe-encoding' ? VIBE_ENCODING_FIELDS : VIBE_IMAGE_FIELDS, name);
    // A Vibe variant selects its source asset; only resolved bytes are sent
    // to NAI. It is intentionally not part of the replayable provider input.
    if (row.variant !== undefined && (name !== 'Vibe' || row.kind !== 'novelai-vibe-encoding'
      || typeof row.variant !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(row.variant))) {
      fail('shape', 'Vibe 来源档位无效，未封存镜头');
    }
    if (row.data !== undefined && row.base64 !== undefined
      || row.data !== undefined && typeof row.data !== 'string'
      || row.base64 !== undefined && typeof row.base64 !== 'string'
      || (row.data?.length ?? row.base64?.length ?? 0) > Math.ceil(16 * 1024 * 1024 / 3) * 4 + 256) {
      fail('size', `${name}字节无效或超出安全容量，未截断、未封存镜头`, 413);
    }
    encodedLength += (row.data?.length ?? row.base64?.length ?? 0);
  }
  return encodedLength;
}
function preflight(raw) {
  plain(raw, ROOT_FIELDS, 'NAI 请求');
  if (raw.provider !== 'novel' || raw.protocol !== 'novelai' || raw.modelFamily !== 'novel'
    || raw.allowPrivateNetwork === true || raw.imageProtocolVersion !== undefined) {
    fail('provider', '仅支持 NAI 原生单镜输入封存，未创建任务');
  }
  for (const [key, max] of Object.entries({ apiKey: 2048, baseUrl: 2048, model: 240,
    capabilityModelId: 240, prompt: 32000, negativePrompt: 16000 })) {
    textWithin(raw[key], max, key, ['apiKey', 'model', 'prompt'].includes(key));
  }
  if (raw.apiKey !== raw.apiKey.trim() || raw.prompt !== raw.prompt.trim()
    || raw.referenceImages !== undefined && raw.references !== undefined
      && (raw.referenceImages.length || raw.references.length)) {
    fail('lossy', 'NAI 请求包含会被忽略或修剪的内容，未封存镜头');
  }
  const encodedLength = images(raw.referenceImages, '参考图')
    + images(raw.references, '参考图') + images(raw.vibes, 'Vibe');
  if (encodedLength > Math.ceil(48 * 1024 * 1024 / 3) * 4 + 32 * 256) {
    fail('size', 'NAI 参考图与 Vibe 合计超出 48 MB，未封存镜头', 413);
  }
  const parameters = plain(raw.parameters === undefined ? {} : raw.parameters, PARAMETER_FIELDS, 'NAI 参数');
  for (const [key, max] of Object.entries(PARAMETER_TEXT)) textWithin(parameters[key], max, key);
  if (parameters.count !== undefined && parameters.count !== 1
    || parameters.scale !== undefined && parameters.cfg !== undefined
    || parameters.workflow !== undefined && Object.keys(plain(parameters.workflow, null, '工作流')).length) {
    fail('lossy', 'NAI 单镜数量或工作流参数不适合封存，未创建任务');
  }
  if (parameters.providerOptions !== undefined) {
    plain(parameters.providerOptions, null, 'NAI 高级参数');
    assertJsonData(parameters.providerOptions, 'NAI 高级参数');
  }
}

function rejectSilentNormalization(raw, normalized) {
  if (raw.novelVibeVersion !== undefined && raw.novelVibeVersion !== normalized.novelVibeVersion) {
    fail('lossy', 'NAI Vibe 版本会被静默忽略，未封存镜头');
  }
  for (const key of ['baseUrl', 'model', 'capabilityModelId', 'prompt', 'negativePrompt']) {
    if (raw[key] !== undefined && raw[key] !== '' && raw[key] !== normalized[key]) {
      fail('lossy', `NAI ${key} 会被静默修剪，未封存镜头`);
    }
  }
  const original = raw.parameters || {}, actual = normalized.parameters;
  const numeric = new Set(['width', 'height', 'count', 'seed', 'steps', 'guidanceScale', 'timeoutMs', 'pollIntervalMs']);
  const same = (source, result, allowNumeric = false) => source === result || allowNumeric
    && typeof source === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source)
    && Number.isFinite(Number(source)) && Number(source) === result;
  for (const key of ['width', 'height', 'size', 'aspectRatio', 'imageSize', 'quality',
    'background', 'outputFormat', 'count', 'seed', 'steps', 'sampler', 'scheduler',
    'guidanceScale', 'watermark', 'sequential', 'timeoutMs', 'pollIntervalMs']) {
    if (original[key] !== undefined && !same(original[key], actual[key], numeric.has(key))) {
      fail('lossy', `NAI ${key} 参数会被静默改写，未封存镜头`);
    }
  }
  const scale = original.scale === undefined ? original.cfg : original.scale;
  if (scale !== undefined && !same(scale, actual.scale, true)) fail('lossy', 'NAI scale 参数会被静默改写，未封存镜头');
  const originalReferences = raw.referenceImages || raw.references || [];
  for (const [index, row] of originalReferences.entries()) {
    const saved = normalized.references[index];
    const declaredMime = String((row.data ?? row.base64 ?? '').match(/^data:([^;,]+);base64,/i)?.[1] || '').toLowerCase().replace('image/jpg', 'image/jpeg');
    if (declaredMime && declaredMime !== saved?.mime) fail('lossy', 'NAI 参考图地址中的类型与文件不一致，未封存镜头');
    for (const key of ['name', 'strength', 'information', 'fidelity', 'referenceType']) {
      if (row[key] !== undefined && row[key] !== saved?.[key]) {
        fail('lossy', `NAI 参考图 ${key} 会被静默改写，未封存镜头`);
      }
    }
    if (row.mime !== undefined && (typeof row.mime !== 'string'
      || row.mime.toLowerCase().replace('image/jpg', 'image/jpeg') !== saved?.mime)) {
      fail('lossy', 'NAI 参考图 MIME 与真实文件不一致，未封存镜头');
    }
  }
  for (const [index, row] of (raw.vibes || []).entries()) {
    const saved = normalized.vibes[index];
    const declaredMime = String((row.data ?? row.base64 ?? '').match(/^data:([^;,]+);base64,/i)?.[1] || '').toLowerCase().replace('image/jpg', 'image/jpeg');
    if (declaredMime && declaredMime !== saved?.mime) fail('lossy', 'NAI Vibe 原图地址中的类型与文件不一致，未封存镜头');
    for (const key of ['strength', 'information', 'encodingModel']) {
      if (row[key] !== undefined && row[key] !== saved?.[key]) {
        fail('lossy', `NAI Vibe ${key} 会被静默改写，未封存镜头`);
      }
    }
    if (row.byteLength !== undefined && row.byteLength !== (saved?.byteLength
      ?? Buffer.byteLength(saved?.data || '', 'base64'))) {
      fail('lossy', 'NAI Vibe 原图字节数与真实文件不一致，未封存镜头');
    }
    if (row.kind !== undefined && row.kind !== saved?.kind) fail('lossy', 'NAI Vibe 类型会被静默改写，未封存镜头');
    if (row.mime !== undefined && row.mime !== saved?.mime) fail('lossy', 'NAI Vibe MIME 与真实文件不一致，未封存镜头');
  }
}

function assertPrivateEndpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch (_) { fail('endpoint', 'NAI 地址无效，未封存镜头'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail('endpoint', 'NAI 地址不能包含凭据、查询或非 HTTPS 协议，未封存镜头');
  }
}

function splitAssets(request) {
  const assets = [];
  let totalBytes = 0;
  const replace = (rows, kind) => rows.map((row, index) => {
    const { data, ...rest } = row;
    if (typeof data !== 'string') fail('asset', 'NAI 参考素材不完整，未封存镜头');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data) fail('asset', 'NAI 参考素材字节不完整，未封存镜头');
    totalBytes += bytes.length;
    if (totalBytes > MAX_ASSET_BYTES) fail('size', 'NAI 参考素材合计超出 48 MB，未封存镜头', 413);
    const digest = sha(bytes);
    assets.push({ kind, index, sha256: digest, bytes: bytes.length, data: bytes });
    return { ...rest, asset: { kind, index, sha256: digest, bytes: bytes.length } };
  });
  return {
    assets,
    references: replace(request.references, 'reference'),
    vibes: replace(request.vibes, 'vibe'),
  };
}

export function sealStoryboardNovelShotInput({ expectedAccount, batchId, attemptId, request } = {}) {
  // The v1 batch ID is a correlation key only, never execution authority.
  storyboardServerBatchKey(expectedAccount, batchId);
  if (typeof attemptId !== 'string' || !ATTEMPT.test(attemptId)) fail('identity', '镜头尝试编号无效，未封存镜头');
  preflight(request);
  let normalized;
  try { normalized = sanitizeImageRequest(request); }
  catch (cause) { fail('request', cause?.name === 'ImageGatewayError' ? cause.message : 'NAI 请求校验未通过，未封存镜头', cause?.status === 413 ? 413 : 400); }
  rejectSilentNormalization(request, normalized);
  assertPrivateEndpoint(normalized.baseUrl);
  if (normalized.provider !== 'novel' || normalized.parameters.count !== 1
    || JSON.stringify(normalized.parameters.providerOptions) !== JSON.stringify(request.parameters?.providerOptions || {})) {
    fail('lossy', 'NAI 请求参数会被静默删改，未封存镜头');
  }
  const { apiKey, ...safeRequest } = normalized;
  const { assets, references, vibes } = splitAssets(safeRequest);
  const payload = { ...safeRequest, references, vibes };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) fail('size', 'NAI 镜头载荷超出私有容量，未封存镜头', 413);
  if (apiKey && payloadJson.includes(apiKey)) fail('secret', 'NAI 请求凭据出现在内容中，未封存镜头');
  const { requestDigest } = describeImageServiceRequest(normalized);
  const snapshot = {
    schema: SCHEMA, state: 'data_only_unrunnable', expectedAccount, batchId, attemptId,
    channelKey: imageServiceChannelKey(apiKey), requestDigest,
    payloadDigest: sha(payloadJson), payload,
    assets: assets.map(({ data, ...identity }) => identity),
  };
  return { snapshot, assets };
}

// Readback proves content identity only. It deliberately cannot recover a Key,
// confirm a fee, bind a narrative source, or run a provider request.
export function inspectStoryboardNovelShotInput(snapshot, assets) {
  if (!snapshot || snapshot.schema !== SCHEMA || snapshot.state !== 'data_only_unrunnable'
    || typeof snapshot.requestDigest !== 'string' || !SHA.test(snapshot.requestDigest)
    || typeof snapshot.payloadDigest !== 'string' || !SHA.test(snapshot.payloadDigest)
    || typeof snapshot.channelKey !== 'string' || !SHA.test(snapshot.channelKey)
    || !Array.isArray(snapshot.assets) || !Array.isArray(assets)
    || snapshot.assets.length > 32 || assets.length > 32) fail('record', 'NAI 镜头快照不完整');
  storyboardServerBatchKey(snapshot.expectedAccount, snapshot.batchId);
  let payloadJson;
  try { payloadJson = JSON.stringify(snapshot.payload); } catch (_) { fail('record', 'NAI 镜头快照已变化'); }
  if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
    fail('record', 'NAI 镜头快照超过安全容量或内容缺失');
  }
  if (typeof snapshot.attemptId !== 'string' || !ATTEMPT.test(snapshot.attemptId)
    || sha(payloadJson) !== snapshot.payloadDigest || snapshot.payload?.provider !== 'novel'
    || !Array.isArray(snapshot.payload?.references) || !Array.isArray(snapshot.payload?.vibes)
    || snapshot.payload.references.length + snapshot.payload.vibes.length !== snapshot.assets.length
    || Object.hasOwn(snapshot.payload, 'apiKey') || snapshot.assets.length !== assets.length) {
    fail('record', 'NAI 镜头快照已变化');
  }
  const assetMap = new Map();
  let totalBytes = 0;
  for (const asset of assets) {
    totalBytes += asset?.data?.length || 0;
    if (!Buffer.isBuffer(asset?.data) || !['reference', 'vibe'].includes(asset.kind)
      || asset.data.length > 16 * 1024 * 1024 || totalBytes > MAX_ASSET_BYTES
      || !Number.isInteger(asset.index) || asset.index < 0 || assetMap.has(`${asset.kind}:${asset.index}`)) {
      fail('asset', 'NAI 镜头素材引用无效');
    }
    assetMap.set(`${asset.kind}:${asset.index}`, asset);
  }
  const used = new Set();
  const restore = (rows, kind) => rows.map((row, index) => {
    const { asset: locator, ...rest } = row;
    const actual = assetMap.get(`${kind}:${index}`);
    if (!actual || !locator || locator.kind !== kind || locator.index !== index
      || locator.sha256 !== sha(actual.data) || locator.bytes !== actual.data.length
      || JSON.stringify(snapshot.assets.find(item => item.kind === kind && item.index === index))
        !== JSON.stringify(locator)) fail('asset', 'NAI 镜头素材字节与快照不符');
    used.add(`${kind}:${index}`);
    return { data: actual.data.toString('base64'), ...rest };
  });
  const request = { ...snapshot.payload, references: restore(snapshot.payload.references, 'reference'),
    vibes: restore(snapshot.payload.vibes, 'vibe') };
  if (used.size !== assetMap.size) fail('asset', 'NAI 镜头素材列表与快照不符');
  if (describeImageServiceRequest(request).requestDigest !== snapshot.requestDigest) {
    fail('record', 'NAI 镜头请求与快照不符');
  }
  return request;
}
