import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  buildMiniMaxH3CancelRequest,
  buildMiniMaxH3CreateRequest,
  buildMiniMaxH3QueryRequest,
  normalizeMiniMaxH3Connection,
  parseMiniMaxH3CancelResponse,
  parseMiniMaxH3CreateResponse,
  parseMiniMaxH3TaskResponse,
} from './qianmu-video-minimax.js';

const MAX_API_KEY_LENGTH = 4096;
const MAX_INLINE_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 45 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MINIMAX_H3_RESULT_MAX_BYTES = 768 * 1024 * 1024;
const CREATE_TIMEOUT_MS = 45_000;
const QUERY_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX_ITEMS = 200;
const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_SUBMISSION_CACHE = new Map();
const VIDEO_RESULT_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'application/octet-stream']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);

function hash(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export class VideoGatewayError extends Error {
  constructor(status, code, message, options = {}) {
    super(String(message || '视频请求失败'));
    this.name = 'VideoGatewayError';
    this.status = Number(status) || 500;
    this.code = String(code || 'video_gateway_error');
    this.retryable = Boolean(options.retryable);
    this.upstreamStatus = Number(options.upstreamStatus) || 0;
    this.requestId = text(options.requestId, 300);
  }
}

function apiKey(value) {
  const key = String(value ?? '').trim();
  if (!key) throw new VideoGatewayError(400, 'missing_api_key', '请先填写 MiniMax Pay-as-you-go API Key');
  if (key.length > MAX_API_KEY_LENGTH) throw new VideoGatewayError(400, 'invalid_api_key', 'MiniMax API Key 长度异常');
  return key;
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function decodeInlineImage(value, declaredMime = '') {
  const source = String(value ?? '').trim();
  const match = source.match(/^data:([^;,]+);base64,(.+)$/s);
  const mime = text(match?.[1] || declaredMime, 80).toLowerCase().replace('image/jpg', 'image/jpeg');
  const encoded = String(match?.[2] || source).replace(/\s+/g, '');
  if (!INLINE_IMAGE_MIMES.has(mime) || !encoded || encoded.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) {
    throw new VideoGatewayError(400, 'invalid_inline_image', '视频参考图只接受 PNG、JPEG 或 WebP');
  }
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); }
  catch (_) { throw new VideoGatewayError(400, 'invalid_inline_image', '视频参考图 Base64 无效'); }
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new VideoGatewayError(400, 'invalid_inline_image', '视频参考图 Base64 无效');
  }
  if (!bytes.length || bytes.length > MAX_INLINE_IMAGE_BYTES) throw new VideoGatewayError(400, 'inline_image_too_large', '单张视频参考图须小于 30 MB');
  const detected = imageMime(bytes);
  if (!detected || detected !== mime) throw new VideoGatewayError(400, 'invalid_inline_image', '视频参考图内容与格式不匹配');
  return { url: `data:${detected};base64,${bytes.toString('base64')}`, bytes: bytes.length };
}

function httpsUrl(value) {
  const source = text(value, 4096);
  try {
    const url = new URL(source);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function privateLiteralAddress(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return isIP(host) !== 0;
}

function privateNetworkAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!value || value === '::1' || value === '0.0.0.0' || value === '::') return true;
  if (value.startsWith('::ffff:')) return privateNetworkAddress(value.slice(7));
  if (isIP(value) === 6) return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9')
    || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff') || value.startsWith('2001:db8')
    || value.startsWith('2001:0:') || value.startsWith('2001:10') || value.startsWith('2001:2:')
    || value.startsWith('2002:') || value.startsWith('64:ff9b:');
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
    || (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2))
    || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    || parts[0] >= 224;
}

function safeProviderResultUrl(value) {
  const source = String(value ?? '').trim();
  if (!source || source.length > 4096) return '';
  try {
    const url = new URL(source);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateLiteralAddress(hostname)) return '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

async function validatedResultUrl(value, resolveHost) {
  const safe = safeProviderResultUrl(value);
  if (!safe) throw new VideoGatewayError(502, 'result_url_unsafe', 'MiniMax H3 返回了不安全的成片地址');
  const url = new URL(safe);
  let addresses;
  try { addresses = await resolveHost(url.hostname, { all: true, verbatim: true }); }
  catch (_) { throw new VideoGatewayError(502, 'result_url_unreachable', 'MiniMax H3 成片地址无法解析', { retryable: true }); }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length || list.some((item) => privateNetworkAddress(item?.address || item))) {
    throw new VideoGatewayError(502, 'result_url_unsafe', 'MiniMax H3 成片地址指向了不安全的网络');
  }
  return url.toString();
}

async function fetchVideoResult(urlValue, options, init) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const resolveHost = options.resolveHost || dnsLookup;
  let currentUrl = urlValue;
  for (let redirects = 0; redirects <= 5; redirects++) {
    currentUrl = await validatedResultUrl(currentUrl, resolveHost);
    const response = await fetchImpl(currentUrl, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    try { await response.body?.cancel?.(); } catch (_) {}
    if (!location || redirects === 5) throw new VideoGatewayError(502, 'result_redirect_invalid', 'MiniMax H3 成片跳转无效');
    try { currentUrl = new URL(location, currentUrl).toString(); }
    catch (_) { throw new VideoGatewayError(502, 'result_redirect_invalid', 'MiniMax H3 成片跳转无效'); }
  }
  throw new VideoGatewayError(502, 'result_redirect_invalid', 'MiniMax H3 成片跳转过多');
}

export function sanitizeMiniMaxH3MediaInputs(value = []) {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > 12) throw new VideoGatewayError(400, 'media_assets_exceeded', '视频素材不得超过 12 项');
  const mediaUrls = new Map();
  let inlineBytes = 0;
  for (const rawItem of rows) {
    const item = plain(rawItem) ? rawItem : {};
    const assetId = text(item.assetId || item.asset_id, 200);
    if (!assetId) throw new VideoGatewayError(400, 'media_asset_id_missing', '视频素材缺少稳定 ID');
    if (mediaUrls.has(assetId)) throw new VideoGatewayError(400, 'media_asset_duplicate', `视频素材重复：${assetId}`);
    const remote = httpsUrl(item.url);
    if (remote) {
      mediaUrls.set(assetId, remote);
      continue;
    }
    if (!item.data && !String(item.url || '').startsWith('data:')) {
      throw new VideoGatewayError(400, 'media_url_invalid', `视频素材地址无效：${assetId}`);
    }
    const inline = decodeInlineImage(item.data || item.url, item.mime);
    inlineBytes += inline.bytes;
    if (inlineBytes > MAX_INLINE_TOTAL_BYTES) throw new VideoGatewayError(400, 'inline_media_too_large', '内联视频参考图总计须小于 45 MB');
    mediaUrls.set(assetId, inline.url);
  }
  return { mediaUrls, inlineBytes };
}

export function sanitizeMiniMaxH3GatewayCreate(value = {}) {
  const raw = plain(value) ? value : {};
  const key = apiKey(raw.apiKey || raw.api_key);
  const idempotencyKey = String(raw.idempotencyKey || raw.idempotency_key || '').trim();
  if (!idempotencyKey) throw new VideoGatewayError(400, 'idempotency_key_missing', '视频任务缺少防重复提交标识');
  if (idempotencyKey.length > 300) throw new VideoGatewayError(400, 'idempotency_key_invalid', '视频任务防重复提交标识过长');
  const media = sanitizeMiniMaxH3MediaInputs(raw.mediaInputs || raw.media_inputs);
  const descriptor = buildMiniMaxH3CreateRequest(raw.spec, raw.manifest, {
    prompt: raw.prompt,
    connection: raw.connection,
    mediaUrls: media.mediaUrls,
    allowInlineMedia: true,
  });
  if (!descriptor.ok) throw new VideoGatewayError(400, descriptor.issues[0] || 'invalid_video_request', `视频请求未通过校验：${descriptor.issues.join('、')}`);
  let serialized;
  try { serialized = JSON.stringify(descriptor.request.body); }
  catch (_) { throw new VideoGatewayError(400, 'video_request_invalid', '视频请求无法序列化'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw new VideoGatewayError(400, 'video_request_too_large', '视频请求总大小超过 64 MB');
  return {
    apiKey: key,
    idempotencyKey,
    connection: descriptor.connection,
    request: descriptor.request,
    serializedBody: serialized,
    payloadFingerprint: hash(serialized),
  };
}

async function responseJson(response) {
  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); }
  catch (error) { throw new VideoGatewayError(502, 'upstream_response_unreadable', `MiniMax H3 响应读取失败：${error?.message || error}`, { upstreamStatus: response.status }); }
  if (bytes.length > MAX_RESPONSE_BYTES) throw new VideoGatewayError(502, 'upstream_response_too_large', 'MiniMax H3 响应异常过大', { upstreamStatus: response.status });
  if (!bytes.length) return {};
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (_) { throw new VideoGatewayError(502, 'upstream_response_invalid', 'MiniMax H3 返回了无效 JSON', { upstreamStatus: response.status }); }
}

async function upstreamRequest(request, key, parser, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new VideoGatewayError(500, 'fetch_unavailable', '当前服务端不支持网络请求');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = Math.min(60_000, Math.max(1000, Number(options.timeoutMs) || QUERY_TIMEOUT_MS));
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${key}` },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      redirect: 'error',
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = await responseJson(response);
    const result = parser(body, response.status);
    if (!result.ok) throw new VideoGatewayError(result.status || response.status || 502, result.code, result.message, {
      retryable: result.retryable,
      upstreamStatus: response.status,
      requestId: result.requestId,
    });
    return result;
  } catch (error) {
    if (error instanceof VideoGatewayError) throw error;
    const timedOut = error?.name === 'AbortError';
    throw new VideoGatewayError(502, 'submission_outcome_unknown', timedOut ? 'MiniMax H3 提交超时，结果未知，请勿直接重发' : 'MiniMax H3 网络结果未知，请勿直接重发', { retryable: false });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cacheError(error) {
  return {
    status: Number(error?.status) || 500,
    code: String(error?.code || 'video_gateway_error'),
    message: String(error?.message || '视频请求失败'),
    retryable: Boolean(error?.retryable),
    upstreamStatus: Number(error?.upstreamStatus) || 0,
    requestId: text(error?.requestId, 300),
  };
}

function restoreCacheError(value) {
  return new VideoGatewayError(value.status, value.code, value.message, value);
}

function pruneCache(cache, now) {
  for (const [key, entry] of cache) {
    if (entry?.state !== 'pending' && Number(entry?.expiresAt) <= now) cache.delete(key);
  }
  while (cache.size >= CACHE_MAX_ITEMS) {
    const removable = [...cache].find(([, entry]) => entry?.state !== 'pending');
    if (!removable) {
      throw new VideoGatewayError(503, 'submission_cache_busy', '当前视频提交队列已满，请稍后再试', { retryable: true });
    }
    cache.delete(removable[0]);
  }
}

export async function createMiniMaxH3Video(value = {}, options = {}) {
  const input = sanitizeMiniMaxH3GatewayCreate(value);
  const cache = options.submissionCache instanceof Map ? options.submissionCache : DEFAULT_SUBMISSION_CACHE;
  const now = Number(options.now) || Date.now();
  const cacheKey = `${input.connection.region}|${hash(input.apiKey)}|${input.idempotencyKey}`;
  let existing = cache.get(cacheKey);
  if (existing?.state !== 'pending' && Number(existing?.expiresAt) <= now) {
    cache.delete(cacheKey);
    existing = null;
  }
  if (existing) {
    if (existing.payloadFingerprint !== input.payloadFingerprint) throw new VideoGatewayError(409, 'idempotency_payload_mismatch', '同一视频任务标识不能提交不同内容');
    if (existing.state === 'resolved') return { ...existing.result, reused: true };
    if (existing.state === 'blocked') throw restoreCacheError(existing.error);
    return existing.promise.then((result) => ({ ...result, reused: true }));
  }
  pruneCache(cache, now);
  const entry = { state: 'pending', payloadFingerprint: input.payloadFingerprint, expiresAt: now + CACHE_TTL_MS, promise: null };
  entry.promise = upstreamRequest(input.request, input.apiKey, parseMiniMaxH3CreateResponse, {
    ...options,
    timeoutMs: options.timeoutMs || CREATE_TIMEOUT_MS,
  }).then((result) => {
    entry.state = 'resolved';
    entry.result = { ...result, reused: false };
    delete entry.promise;
    return entry.result;
  }).catch((error) => {
    entry.state = 'blocked';
    entry.error = cacheError(error);
    delete entry.promise;
    throw error;
  });
  cache.set(cacheKey, entry);
  return entry.promise;
}

export async function queryMiniMaxH3Video(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const key = apiKey(raw.apiKey || raw.api_key);
  const descriptor = buildMiniMaxH3QueryRequest(raw.taskId || raw.task_id, raw.connection);
  if (!descriptor.ok) throw new VideoGatewayError(400, descriptor.issue, '缺少 MiniMax H3 远端任务 ID');
  return upstreamRequest(descriptor.request, key, parseMiniMaxH3TaskResponse, options);
}

export async function cancelMiniMaxH3Video(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const key = apiKey(raw.apiKey || raw.api_key);
  const descriptor = buildMiniMaxH3CancelRequest(raw.taskId || raw.task_id, raw.providerStatus || raw.provider_status, raw.connection);
  if (!descriptor.ok) throw new VideoGatewayError(409, descriptor.issue, descriptor.plan?.reason === 'running_task_cannot_cancel'
    ? 'MiniMax H3 运行中的任务无法由官方接口强制取消'
    : '当前 MiniMax H3 任务不可取消');
  return upstreamRequest(descriptor.request, key, parseMiniMaxH3CancelResponse, options);
}

export async function openMiniMaxH3VideoResult(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const task = await queryMiniMaxH3Video(raw, options);
  if (task.state !== 'succeeded') {
    throw new VideoGatewayError(409, 'video_result_not_ready', 'MiniMax H3 成片尚未完成', { retryable: ['submitted', 'polling'].includes(task.state) });
  }
  const resultUrl = safeProviderResultUrl(task.result?.downloadUrl);
  if (!resultUrl) throw new VideoGatewayError(502, 'result_url_unsafe', 'MiniMax H3 返回了不安全的成片地址');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new VideoGatewayError(500, 'fetch_unavailable', '当前服务端不支持网络请求');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = Math.min(60_000, Math.max(1000, Number(options.resultHeaderTimeoutMs) || 30_000));
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchVideoResult(resultUrl, { ...options, fetchImpl }, {
      method: 'GET',
      headers: { Accept: 'video/*,application/octet-stream;q=0.8' },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (error instanceof VideoGatewayError) throw error;
    const timedOut = error?.name === 'AbortError';
    throw new VideoGatewayError(502, timedOut ? 'result_download_timeout' : 'result_download_failed', timedOut ? 'MiniMax H3 成片下载连接超时' : 'MiniMax H3 成片下载连接失败', { retryable: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok || !response.body) {
    try { await response.body?.cancel?.(); } catch (_) {}
    throw new VideoGatewayError(502, 'result_download_failed', `MiniMax H3 成片下载失败（${response.status}）`, { retryable: response.status === 429 || response.status >= 500, upstreamStatus: response.status });
  }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!VIDEO_RESULT_MIMES.has(contentType)) {
    try { await response.body.cancel(); } catch (_) {}
    throw new VideoGatewayError(502, 'result_content_type_invalid', 'MiniMax H3 成片返回了非视频内容');
  }
  const contentLength = Math.max(0, Number(response.headers.get('content-length')) || 0);
  if (contentLength > MINIMAX_H3_RESULT_MAX_BYTES) {
    try { await response.body.cancel(); } catch (_) {}
    throw new VideoGatewayError(413, 'video_result_too_large', 'MiniMax H3 成片超过 768 MB 上限');
  }
  const extension = contentType === 'video/webm' ? 'webm' : contentType === 'video/quicktime' ? 'mov' : contentType === 'video/x-matroska' ? 'mkv' : 'mp4';
  return {
    response,
    remoteTaskId: task.remoteTaskId,
    contentType,
    contentLength,
    fileName: `qianmu-h3-${hash(task.remoteTaskId).slice(0, 16)}.${extension}`,
    maxBytes: MINIMAX_H3_RESULT_MAX_BYTES,
  };
}

export function videoGatewayErrorPayload(error) {
  const source = error instanceof VideoGatewayError ? error : new VideoGatewayError(500, 'video_gateway_error', error?.message || error);
  return {
    status: source.status,
    body: {
      ok: false,
      code: source.code,
      message: source.message,
      retryable: source.retryable,
      ...(source.upstreamStatus ? { upstreamStatus: source.upstreamStatus } : {}),
      ...(source.requestId ? { requestId: source.requestId } : {}),
    },
  };
}
