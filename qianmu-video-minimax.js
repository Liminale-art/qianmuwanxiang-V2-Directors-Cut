// MiniMax H3 官方 V2 渠道适配。只构建与解析请求，不在浏览器直连官方域名。
import {
  normalizeMultimodalAssetManifest,
  normalizeVideoShotSpec,
  validateVideoShotSpec,
} from './qianmu-video-contract.js';

export const MINIMAX_H3_PROVIDER_ID = 'minimax-h3';
export const MINIMAX_H3_OFFICIAL_BASE_URLS = Object.freeze({
  global: 'https://api.minimax.io',
  cn: 'https://api.minimaxi.com',
});
export const MINIMAX_H3_PROVIDER_CAPABILITY = Object.freeze({
  id: MINIMAX_H3_PROVIDER_ID,
  label: 'MiniMax H3',
  model: 'MiniMax-H3',
  modes: Object.freeze(['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']),
  resolutions: Object.freeze(['768p', '2k']),
  duration: Object.freeze({ min: 4, max: 15, integer: true }),
  promptMaxCharacters: 7000,
  pollIntervalMs: 10000,
  queryRetentionDays: 7,
  browserDirect: false,
  transport: 'same_origin_gateway',
  keyType: 'pay_as_you_go',
  supportsCallback: true,
  cancellation: Object.freeze({ queued: true, running: false, terminalDelete: true }),
});

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function officialBase(value, region = 'global') {
  const fallback = MINIMAX_H3_OFFICIAL_BASE_URLS[region] || MINIMAX_H3_OFFICIAL_BASE_URLS.global;
  const candidate = text(value, 2048) || fallback;
  try {
    const url = new URL(candidate);
    const match = Object.values(MINIMAX_H3_OFFICIAL_BASE_URLS).find((base) => new URL(base).hostname === url.hostname.toLowerCase());
    return match || fallback;
  } catch (_) {
    return fallback;
  }
}

function endpoint(baseUrl, pathname) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

function mediaUrl(value) {
  const source = text(value, 4096);
  try {
    const url = new URL(source);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function urlForAsset(assetId, mediaUrls) {
  if (mediaUrls instanceof Map) return mediaUrl(mediaUrls.get(assetId));
  if (plain(mediaUrls)) return mediaUrl(mediaUrls[assetId]);
  return '';
}

function providerContentItem(asset, role, url) {
  if (asset.kind === 'video') return { type: 'video_url', video_url: { url }, role };
  if (asset.kind === 'audio') return { type: 'audio_url', audio_url: { url }, role };
  return { type: 'image_url', image_url: { url }, role };
}

function errorResult(status, body = {}) {
  const raw = plain(body) ? body : {};
  const error = plain(raw.error) ? raw.error : {};
  const httpStatus = Number(status) || Number(error.http_code) || 0;
  const providerType = text(error.type || raw.type, 160);
  const requestId = text(raw.request_id || raw.requestId, 300);
  let code = providerType || 'minimax_h3_error';
  if (httpStatus === 400) code = 'invalid_request';
  else if (httpStatus === 401 || httpStatus === 403) code = 'authentication_failed';
  else if (httpStatus === 402) code = 'insufficient_balance';
  else if (httpStatus === 422) code = 'content_rejected';
  else if (httpStatus === 429) code = 'rate_limited';
  else if (httpStatus >= 500) code = 'provider_unavailable';
  return {
    ok: false,
    status: httpStatus,
    code,
    message: text(error.message || raw.message, 1200) || 'MiniMax H3 请求失败',
    requestId,
    retryable: httpStatus === 429 || httpStatus >= 500,
  };
}

export function normalizeMiniMaxH3Connection(value = {}) {
  const raw = plain(value) ? value : {};
  const region = raw.region === 'cn' ? 'cn' : 'global';
  return {
    provider: MINIMAX_H3_PROVIDER_ID,
    region,
    baseUrl: officialBase(raw.baseUrl || raw.base_url, region),
    model: 'MiniMax-H3',
    connectionId: text(raw.connectionId || raw.connection_id, 200),
    transport: 'same_origin_gateway',
    keyType: 'pay_as_you_go',
    pollIntervalMs: MINIMAX_H3_PROVIDER_CAPABILITY.pollIntervalMs,
  };
}

export function buildMiniMaxH3CreateRequest(specValue = {}, manifestValue = {}, runtime = {}) {
  const manifest = normalizeMultimodalAssetManifest(manifestValue);
  const spec = normalizeVideoShotSpec(specValue, manifest);
  const validation = validateVideoShotSpec(spec, manifest);
  const connection = normalizeMiniMaxH3Connection(runtime.connection);
  const rawPrompt = String(runtime.prompt ?? '').trim();
  const issues = [...validation.issues];
  if (!rawPrompt) issues.push('video_prompt_missing');
  if (rawPrompt.length > MINIMAX_H3_PROVIDER_CAPABILITY.promptMaxCharacters) issues.push('video_prompt_too_long');
  const content = [{ type: 'text', text: rawPrompt.slice(0, MINIMAX_H3_PROVIDER_CAPABILITY.promptMaxCharacters) }];
  const assetById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const selected = [];
  if (spec.route.mode === 'ref2va') {
    spec.route.inputs.referenceAssetIds.forEach((assetId) => selected.push({ assetId, role: `reference_${assetById.get(assetId)?.kind || 'image'}` }));
  } else {
    if (spec.route.inputs.firstFrameAssetId) selected.push({ assetId: spec.route.inputs.firstFrameAssetId, role: 'first_frame' });
    if (spec.route.inputs.lastFrameAssetId) selected.push({ assetId: spec.route.inputs.lastFrameAssetId, role: 'last_frame' });
  }
  const seen = new Set();
  for (const item of selected) {
    const contentIdentity = `${item.assetId}|${item.role}`;
    if (seen.has(contentIdentity)) continue;
    seen.add(contentIdentity);
    const asset = assetById.get(item.assetId);
    if (!asset) {
      issues.push(`provider_asset_missing:${item.assetId}`);
      continue;
    }
    const url = urlForAsset(item.assetId, runtime.mediaUrls);
    if (!url) {
      issues.push(`provider_asset_url_missing:${item.assetId}`);
      continue;
    }
    content.push(providerContentItem(asset, item.role, url));
  }
  if (spec.route.mode === 'ref2va') {
    const references = manifest.assets.filter((asset) => spec.route.inputs.referenceAssetIds.includes(asset.assetId));
    if (references.filter((asset) => asset.kind === 'image').length > 9) issues.push('provider_reference_images_exceeded');
    if (references.filter((asset) => asset.kind === 'video').length > 3) issues.push('provider_reference_videos_exceeded');
    if (references.filter((asset) => asset.kind === 'audio').length > 3) issues.push('provider_reference_audio_exceeded');
    if (references.length > 12) issues.push('provider_reference_assets_exceeded');
    const videoDuration = references.filter((asset) => asset.kind === 'video').reduce((sum, asset) => sum + asset.technical.durationSeconds, 0);
    const audioDuration = references.filter((asset) => asset.kind === 'audio').reduce((sum, asset) => sum + asset.technical.durationSeconds, 0);
    references.filter((asset) => asset.kind === 'video' || asset.kind === 'audio').forEach((asset) => {
      if (!asset.technical.durationSeconds) issues.push(`provider_reference_duration_unknown:${asset.assetId}`);
      else if (asset.technical.durationSeconds < 2 || asset.technical.durationSeconds > 15) issues.push(`provider_reference_duration_invalid:${asset.assetId}`);
    });
    if (videoDuration > 15) issues.push('provider_reference_video_duration_exceeded');
    if (audioDuration > 15) issues.push('provider_reference_audio_duration_exceeded');
  }
  const ratio = ['i2va', 'l2va', 'fl2va'].includes(spec.route.mode)
    ? 'adaptive'
    : spec.aspectRatio === 'adaptive' && spec.route.mode === 't2va' ? '16:9' : spec.aspectRatio;
  const body = {
    model: connection.model,
    content,
    resolution: spec.resolution === '2k' ? '2K' : '768P',
    duration: spec.durationSeconds,
    ratio,
  };
  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    spec,
    manifest,
    connection,
    request: {
      method: 'POST',
      url: endpoint(connection.baseUrl, '/v2/video_generation'),
      auth: { type: 'bearer', source: 'runtime_api_key' },
      headers: { 'Content-Type': 'application/json' },
      body,
    },
  };
}

export function buildMiniMaxH3QueryRequest(taskId, connectionValue = {}) {
  const connection = normalizeMiniMaxH3Connection(connectionValue);
  const id = text(taskId, 400);
  return {
    ok: Boolean(id),
    issue: id ? '' : 'remote_task_id_missing',
    request: id ? {
      method: 'GET',
      url: endpoint(connection.baseUrl, `/v2/query/video_generation/${encodeURIComponent(id)}`),
      auth: { type: 'bearer', source: 'runtime_api_key' },
      headers: {},
    } : null,
  };
}

export function parseMiniMaxH3CreateResponse(value = {}, status = 200) {
  const raw = plain(value) ? value : {};
  if (Number(status) >= 400 || raw.type === 'error' || raw.error) return errorResult(status, raw);
  const remoteTaskId = text(raw.task_id || raw.taskId, 400);
  if (!remoteTaskId) return { ...errorResult(502, { message: 'MiniMax H3 未返回任务 ID' }), code: 'task_id_missing' };
  return { ok: true, status: Number(status) || 200, remoteTaskId, requestId: text(raw.request_id || raw.requestId, 300) };
}

export function parseMiniMaxH3TaskResponse(value = {}, status = 200) {
  const raw = plain(value) ? value : {};
  if (Number(status) >= 400 || raw.type === 'error' || raw.error) return errorResult(status, raw);
  const task = plain(raw.task) ? raw.task : {};
  const remoteTaskId = text(task.id || task.task_id, 400);
  const providerStatus = text(task.status, 80).toLowerCase();
  const stateMap = { queued: 'submitted', running: 'polling', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' };
  const state = stateMap[providerStatus] || 'polling';
  const downloadUrl = state === 'succeeded' ? mediaUrl(task.content?.url) : '';
  const usage = plain(task.usage) ? task.usage : {};
  const valid = Boolean(remoteTaskId && providerStatus && (state !== 'succeeded' || downloadUrl));
  return {
    ok: valid,
    code: valid ? '' : state === 'succeeded' && !downloadUrl ? 'result_url_missing' : 'task_response_invalid',
    remoteTaskId,
    providerStatus,
    recognizedStatus: Boolean(stateMap[providerStatus]),
    state,
    retryable: state === 'failed' ? false : !stateMap[providerStatus],
    error: state === 'failed' ? text(task.error?.message || task.error, 1200) : '',
    result: {
      downloadUrl,
      resolution: text(task.resolution, 40),
      durationSeconds: Math.max(0, finite(task.duration, 0)),
      ratio: text(task.ratio, 40),
      taskType: text(task.task_type, 80),
      modality: text(task.modality, 80),
    },
    usage: {
      totalSeconds: Math.max(0, finite(usage.total_seconds, 0)),
      inputSeconds: Math.max(0, finite(usage.input_seconds, 0)),
      outputSeconds: Math.max(0, finite(usage.output_seconds, 0)),
      inputImageCount: Math.max(0, Math.round(finite(usage.input_image_count, 0))),
      inputAudioSeconds: Math.max(0, finite(usage.input_audio_seconds, 0)),
      totalTokens: Math.max(0, Math.round(finite(usage.total_tokens, 0))),
    },
    timing: {
      createdAt: Math.max(0, Math.round(finite(task.created_at, 0) * 1000)),
      updatedAt: Math.max(0, Math.round(finite(task.updated_at, 0) * 1000)),
    },
  };
}

export function planMiniMaxH3Cancellation(providerStatus) {
  const status = text(providerStatus, 80).toLowerCase();
  if (status === 'queued') return { action: 'cancel', allowed: true, reason: 'queued_task_can_cancel' };
  if (status === 'running') return { action: 'wait_terminal', allowed: false, reason: 'running_task_cannot_cancel' };
  if (status === 'succeeded' || status === 'failed') return { action: 'preserve_record', allowed: false, reason: 'terminal_delete_is_not_cancel' };
  if (status === 'cancelled') return { action: 'none', allowed: false, reason: 'already_cancelled' };
  return { action: 'query_first', allowed: false, reason: 'provider_status_unknown' };
}

export function buildMiniMaxH3CancelRequest(taskId, providerStatus, connectionValue = {}) {
  const plan = planMiniMaxH3Cancellation(providerStatus);
  const connection = normalizeMiniMaxH3Connection(connectionValue);
  const id = text(taskId, 400);
  if (!id) return { ok: false, issue: 'remote_task_id_missing', plan, request: null };
  if (!plan.allowed) return { ok: false, issue: plan.reason, plan, request: null };
  return {
    ok: true,
    issue: '',
    plan,
    request: {
      method: 'DELETE',
      url: endpoint(connection.baseUrl, `/v2/video_generation/${encodeURIComponent(id)}`),
      auth: { type: 'bearer', source: 'runtime_api_key' },
      headers: {},
    },
  };
}

export function parseMiniMaxH3CancelResponse(value = {}, status = 200) {
  const raw = plain(value) ? value : {};
  if (Number(status) >= 400 || raw.type === 'error' || raw.error) return errorResult(status, raw);
  const action = text(raw.action, 80).toLowerCase();
  const providerStatus = text(raw.status, 80).toLowerCase();
  if (action !== 'cancelled' || providerStatus !== 'cancelled') {
    return { ...errorResult(409, { message: 'MiniMax H3 未确认取消排队任务' }), code: 'cancel_not_confirmed' };
  }
  return { ok: true, remoteTaskId: text(raw.task_id || raw.taskId, 400), action, providerStatus };
}
