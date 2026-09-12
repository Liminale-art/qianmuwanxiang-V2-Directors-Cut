// Metadata plans/matching only. A plan or browser-supplied descriptor is NOT an
// asset grant. The coordinator must obtain the descriptor from the original job.
import { bindComfyCloudTask, comfyCloudAssetId } from './qianmu-comfy-cloud-protocol.js';
const fail = (task, code, message) => { throw Object.assign(new Error(message), {
  code: `comfy_cloud_asset_${code}`, retryable: false, submissionState: 'accepted', upstreamId: task.taskId,
}); };
const hash = value => value === null || typeof value === 'string' && /^blake3:[a-f0-9]{64}$/.test(value);

export function planComfyCloudAssetMetadata(rawTask, rawId) {
  const task = bindComfyCloudTask(rawTask, rawTask?.taskId, rawTask?.links), assetId = comfyCloudAssetId(rawId);
  if (task.provider !== 'comfy-cloud' || !assetId) fail(task, 'identity', '云端资产身份或平台无效');
  // This is the configured official API root, not a guessed path derived from a
  // returned job's deployment prefix. No alternate-path or provider fallback.
  return Object.freeze({ version: task.version, provider: task.provider, protocol: task.protocol, origin: task.origin,
    taskId: task.taskId, assetId, operation: 'asset_metadata', effect: 'read', createsJob: false,
    method: 'GET', url: `${task.origin}/api/v2/assets/${assetId}`, redirect: 'error' });
}

export function matchComfyCloudAssetMetadata(rawTask, expected, body, { now = Date.now() } = {}) {
  const task = bindComfyCloudTask(rawTask, rawTask?.taskId, rawTask?.links);
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || ![Object.prototype, null].includes(Object.getPrototypeOf(expected))) fail(task, 'expected', '缺少原任务的图片资产约定');
  for (const key of Reflect.ownKeys(expected)) {
    const property = Object.getOwnPropertyDescriptor(expected, key);
    if (!['assetId', 'nodeId', 'mime', 'sizeBytes', 'hash'].includes(key) || property.get || property.set) fail(task, 'expected', '原任务图片资产约定无效');
  }
  const plan = planComfyCloudAssetMetadata(task, expected.assetId);
  if (typeof expected.nodeId !== 'string' || !/^[a-zA-Z0-9_:-]{1,120}$/.test(expected.nodeId)
    || !['image/png', 'image/jpeg', 'image/webp'].includes(expected.mime)
    || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 || expected.sizeBytes > 48 * 1024 * 1024 || !hash(expected.hash)) fail(task, 'expected', '原任务图片资产约定无效');
  if (!body || typeof body !== 'object' || Array.isArray(body) || comfyCloudAssetId(body.id) !== plan.assetId
    || body.job_id != null && body.job_id !== task.taskId) fail(task, 'identity', '云端资产不属于原任务结果，未下载');
  if (body.content_type !== expected.mime || body.size_bytes !== expected.sizeBytes || !hash(body.hash)
    || expected.hash !== null && body.hash !== expected.hash) fail(task, 'changed', '云端图片信息与原结果不一致，未下载');
  if (!Number.isSafeInteger(now) || now < 0) fail(task, 'clock', '云端下载有效期无法核对');
  const expiresAt = typeof body.url_expires_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.url_expires_at)
    ? Date.parse(body.url_expires_at) : NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) fail(task, 'expired', '图片下载地址已失效，请刷新原任务，不必重新生图');
  const rawUrl = body.url;
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192 || !/^https:\/\//i.test(rawUrl) || /[\u0000-\u0020\u007f\\]/.test(rawUrl)) fail(task, 'url', '云端图片下载地址无效');
  let url; try { url = new URL(rawUrl); } catch (_) { fail(task, 'url', '云端图片下载地址无效'); }
  if (url.username || url.password || url.port || url.hash) fail(task, 'url', '云端图片下载地址含不允许的字段');
  // This source is transient and sensitive. DNS/public-address authorization and
  // byte validation still belong to the downloader; never persist/log this URL.
  return Object.freeze({ task, asset: Object.freeze({ assetId: plan.assetId, nodeId: expected.nodeId,
    mime: expected.mime, sizeBytes: expected.sizeBytes, hash: body.hash }), source: Object.freeze({ url: url.href, expiresAt }) });
}
