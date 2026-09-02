// 千幕动态镜头成片归档。浏览器只访问同源增强服务，并把完成视频写入独立 IndexedDB Blob 仓。
import * as defaultStorage from './qianmu-blobstore.js';

export const QIANMU_VIDEO_RESULT_SCHEMA = 'qianmu.video-result.v1';
export const QIANMU_VIDEO_RESULT_ENDPOINT = '/api/plugins/qianmu-tts/video/minimax/result';
export const QIANMU_VIDEO_RESULT_MAX_BYTES = 768 * 1024 * 1024;

const RESULT_TIMEOUT_MS = 15 * 60 * 1000;
const RESULT_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'application/octet-stream',
]);
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);

export class VideoResultError extends Error {
  constructor(code, message, options = {}) {
    super(text(message, 1000) || '视频成片保存失败');
    this.name = 'VideoResultError';
    this.code = text(code, 160) || 'video_result_error';
    this.status = Math.max(0, Math.round(Number(options.status) || 0));
    this.retryable = Boolean(options.retryable);
  }
}

function safeConnection(value = {}) {
  const raw = plain(value) ? value : {};
  return {
    region: raw.region === 'cn' ? 'cn' : 'global',
    connectionId: text(raw.connectionId || raw.connection_id, 200),
  };
}

function normalizedHeaders(value) {
  const source = plain(value) ? value : {};
  const headers = {};
  for (const [key, rawValue] of Object.entries(source).slice(0, 32)) {
    const name = text(key, 120);
    const headerValue = text(rawValue, 4096);
    if (!name || !headerValue || /^(?:x-api-key|api-key)$/i.test(name)) continue;
    headers[name] = headerValue;
  }
  headers['Content-Type'] = 'application/json';
  headers.Accept = 'video/*,application/json;q=0.8';
  return headers;
}

async function boundedErrorBody(response, maxBytes = 64 * 1024) {
  const declared = Math.max(0, Number(response.headers?.get?.('content-length')) || 0);
  if (declared > maxBytes) return {};
  const raw = text(await response.text().catch(() => ''), maxBytes);
  try { return raw ? JSON.parse(raw) : {}; }
  catch (_) { return {}; }
}

function responseMime(response) {
  return text(response.headers?.get?.('content-type'), 100).toLowerCase().split(';')[0].trim();
}

export async function downloadMiniMaxH3VideoResult(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const apiKey = text(raw.apiKey || raw.api_key, 4096);
  const taskId = text(raw.taskId || raw.task_id, 400);
  if (!apiKey) throw new VideoResultError('missing_api_key', '请先填写 MiniMax H3 API Key');
  if (!taskId) throw new VideoResultError('remote_task_id_missing', '缺少 MiniMax H3 远端任务 ID');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new VideoResultError('fetch_unavailable', '当前环境不支持视频成片下载');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = Math.min(RESULT_TIMEOUT_MS, Math.max(1000, Number(options.timeoutMs) || RESULT_TIMEOUT_MS));
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(QIANMU_VIDEO_RESULT_ENDPOINT, {
      method: 'POST',
      headers: normalizedHeaders(options.headers),
      body: JSON.stringify({ apiKey, taskId, connection: safeConnection(raw.connection) }),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      const body = await boundedErrorBody(response);
      throw new VideoResultError(body.code || (response.status === 404 ? 'gateway_missing' : 'result_download_failed'),
        body.message || (response.status === 404 ? '未安装千幕增强服务' : `视频成片下载失败（${response.status}）`),
        { status: response.status, retryable: Boolean(body.retryable) });
    }
    const mimeType = responseMime(response);
    if (!RESULT_MIME_TYPES.has(mimeType)) throw new VideoResultError('result_content_type_invalid', '视频服务返回了非视频内容', { status: response.status });
    const declaredSize = Math.max(0, Number(response.headers?.get?.('content-length')) || 0);
    if (declaredSize > QIANMU_VIDEO_RESULT_MAX_BYTES) throw new VideoResultError('video_result_too_large', '视频成片超过 768 MB 上限', { status: 413 });
    const blob = await response.blob();
    if (!blob.size || blob.size > QIANMU_VIDEO_RESULT_MAX_BYTES) throw new VideoResultError('video_result_too_large', '视频成片为空或超过 768 MB 上限', { status: 413 });
    const actualMime = text(blob.type || mimeType, 100).toLowerCase().split(';')[0].trim();
    if (!RESULT_MIME_TYPES.has(actualMime)) throw new VideoResultError('result_content_type_invalid', '视频成片格式不受支持');
    return new Blob([blob], { type: actualMime });
  } catch (error) {
    if (error instanceof VideoResultError) throw error;
    const timedOut = error?.name === 'AbortError';
    throw new VideoResultError(timedOut ? 'result_download_timeout' : 'result_download_failed',
      timedOut ? '视频成片下载超时' : '视频成片下载失败', { retryable: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stableDigest(value) {
  const source = text(value, 512);
  if (!source) throw new VideoResultError('result_idempotency_key_missing', '缺少视频成片归档标识');
  if (globalThis.crypto?.subtle && typeof TextEncoder === 'function') {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }
  let first = 2166136261;
  let second = 2246822519;
  for (const char of source) {
    first = Math.imul(first ^ char.charCodeAt(0), 16777619);
    second = Math.imul(second ^ char.charCodeAt(0), 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function assertStorage(storage) {
  for (const method of ['hasVideoMedia', 'putVideoMedia']) {
    if (typeof storage?.[method] !== 'function') throw new VideoResultError('video_storage_unavailable', `缺少视频成片存储接口：${method}`);
  }
  return storage;
}

export function createMiniMaxH3ResultArchiver(storageValue = defaultStorage, config = {}) {
  const storage = assertStorage(storageValue);
  return async (value = {}) => {
    const raw = plain(value) ? value : {};
    const digest = await stableDigest(raw.idempotencyKey || raw.idempotency_key);
    const assetId = `video-asset-${digest}`;
    const recordId = `video-record-${digest}`;
    if (await storage.hasVideoMedia(assetId)) return { schema: QIANMU_VIDEO_RESULT_SCHEMA, recordId, assetId, reused: true };
    const owner = plain(raw.owner) ? raw.owner : {};
    const result = plain(raw.result) ? raw.result : {};
    const remoteTaskId = text(raw.remoteTaskId || raw.remote_task_id, 400);
    if (!remoteTaskId) throw new VideoResultError('remote_task_id_missing', '缺少 MiniMax H3 远端任务 ID');
    // 不采用回调携带的 downloadUrl；始终由同源服务重新查询官方任务后取回可信成片。
    const blob = await downloadMiniMaxH3VideoResult({
      apiKey: config.apiKey || config.api_key,
      taskId: remoteTaskId,
      connection: config.connection,
    }, {
      fetchImpl: config.fetchImpl,
      headers: config.headers,
      timeoutMs: config.timeoutMs,
    });
    await storage.putVideoMedia(assetId, blob, {
      recordId,
      taskId: text(raw.taskId || raw.task_id, 200),
      shotId: text(raw.shotId || raw.shot_id, 200),
      versionRootId: text(raw.versionRootId || raw.version_root_id || raw.taskId || raw.task_id, 200),
      parentRecordId: text(raw.parentRecordId || raw.parent_record_id, 200),
      manifestId: text(raw.manifestId || raw.manifest_id, 200),
      budgetReservationId: text(raw.budgetReservationId || raw.budget_reservation_id, 200),
      attempt: raw.attempt,
      chatKey: text(owner.chatKey || owner.chat_key, 512),
      floor: owner.floor,
      messageId: text(owner.messageId || owner.message_id, 200),
      remoteTaskId,
      durationSeconds: result.durationSeconds || result.duration_seconds,
      resolution: result.resolution,
      ratio: result.ratio,
      audioMode: result.audioMode || result.audio_mode,
      referenceAssetIds: raw.referenceAssetIds || raw.reference_asset_ids,
      mimeType: blob.type,
      size: blob.size,
      createdAt: Date.now(),
    });
    return { schema: QIANMU_VIDEO_RESULT_SCHEMA, recordId, assetId, reused: false };
  };
}
