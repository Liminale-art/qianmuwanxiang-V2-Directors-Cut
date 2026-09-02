// 千幕动态镜头的瞬时素材解析层。只在用户明确提交时读取本聊天阅片记录，
// 不持久化图片、Base64、Blob URL 或远端地址。
import {
  normalizeMultimodalAssetManifest,
  normalizeVideoShotSpec,
} from './qianmu-video-contract.js';

export const QIANMU_VIDEO_MEDIA_RESOLUTION_SCHEMA = 'qianmu.video-media-resolution.v1';
export const QIANMU_VIDEO_MEDIA_LIMITS = Object.freeze({
  maxAssetBytes: 30 * 1024 * 1024,
  maxTotalBytes: 45 * 1024 * 1024,
  maxAssets: 12,
  timeoutMs: 30_000,
});

const GALLERY_SEPARATOR = '\u241f';
const ALLOWED_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const MEDIA_ERROR_CODES = new Set([
  'asset_media_aborted',
  'asset_media_base64_invalid',
  'asset_media_loader_missing',
  'asset_media_timeout',
  'asset_media_too_large',
  'asset_media_unreadable',
  'asset_media_url_invalid',
]);
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);

function normalizedMime(value) {
  const mime = text(value, 100).toLowerCase().split(';', 1)[0].trim();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function mediaErrorCode(error) {
  const code = text(error?.message, 120);
  return MEDIA_ERROR_CODES.has(code) ? code : 'asset_media_unreadable';
}

function recordOwner(record) {
  return text(record?.chatKey || record?.messageRef?.chatKey || record?.snapshot?.chatKey, 512);
}

function selectedAssetIds(spec) {
  const ids = spec.route.mode === 'ref2va'
    ? spec.route.inputs.referenceAssetIds
    : [spec.route.inputs.firstFrameAssetId, spec.route.inputs.lastFrameAssetId];
  return [...new Set(ids.map((value) => text(value, 200)).filter(Boolean))];
}

function decodedSize(base64) {
  if (!base64 || base64.length % 4 === 1) return -1;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function decodeBase64(base64) {
  if (!/^[a-z0-9+/]+={0,2}$/i.test(base64) || base64.length % 4 === 1) throw new Error('invalid_base64');
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  throw new Error('base64_decoder_unavailable');
}

function encodeBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts = [];
  const chunkSize = 48 * 1024;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(bytes.length, start + chunkSize);
    let output = '';
    for (let index = start; index < end; index += 3) {
      const a = bytes[index];
      const hasB = index + 1 < bytes.length;
      const hasC = index + 2 < bytes.length;
      const b = hasB ? bytes[index + 1] : 0;
      const c = hasC ? bytes[index + 2] : 0;
      output += alphabet[a >> 2];
      output += alphabet[((a & 3) << 4) | (b >> 4)];
      output += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
      output += hasC ? alphabet[c & 63] : '=';
    }
    parts.push(output);
  }
  return parts.join('');
}

function imageMimeFromSignature(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return '';
}

function parseInlineImage(value, maxBytes) {
  const source = String(value || '').trim();
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(source);
  if (!match) throw new Error('asset_media_url_invalid');
  const estimated = decodedSize(match[2]);
  if (estimated < 0) throw new Error('asset_media_base64_invalid');
  if (estimated > maxBytes) throw new Error('asset_media_too_large');
  let bytes;
  try { bytes = decodeBase64(match[2]); }
  catch (_) { throw new Error('asset_media_base64_invalid'); }
  return { bytes, declaredMime: normalizedMime(match[1]) };
}

function fetchableUrl(value) {
  const source = String(value || '').trim();
  if (/^(?:\/|\.\/)/.test(source) && !source.startsWith('//')) return { url: source, local: true };
  if (/^blob:/i.test(source)) return { url: source, local: true };
  try {
    const url = new URL(source);
    return url.protocol === 'https:' ? { url: url.toString(), local: false } : null;
  } catch (_) {
    return null;
  }
}

async function readResponseBytes(response, maxBytes) {
  if (!response?.ok) throw new Error('asset_media_unreadable');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('asset_media_too_large');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('asset_media_too_large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('asset_media_too_large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function loadRecordMedia(record, options, limits) {
  if (typeof options.loadRecordMedia === 'function') return options.loadRecordMedia(record);
  const source = String(record?.url || '').trim();
  if (/^data:/i.test(source)) return parseInlineImage(source, limits.maxAssetBytes);
  const target = fetchableUrl(source);
  if (!target) throw new Error('asset_media_url_invalid');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('asset_media_loader_missing');
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('asset_media_timeout')), limits.timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET',
      signal: controller.signal,
      credentials: target.local ? 'same-origin' : 'omit',
      cache: 'no-store',
    });
    const bytes = await readResponseBytes(response, limits.maxAssetBytes);
    return { bytes, declaredMime: normalizedMime(response.headers?.get?.('content-type')) };
  } catch (error) {
    if (externalSignal?.aborted) throw new Error('asset_media_aborted');
    if (controller.signal.aborted) throw new Error('asset_media_timeout');
    throw new Error(mediaErrorCode(error));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', abort);
  }
}

async function normalizeLoadedMedia(value, maxBytes) {
  if (typeof value === 'string') return parseInlineImage(value, maxBytes);
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    if (value.size > maxBytes) throw new Error('asset_media_too_large');
    return { bytes: new Uint8Array(await value.arrayBuffer()), declaredMime: normalizedMime(value.type) };
  }
  if (value?.bytes instanceof Uint8Array) return {
    bytes: value.bytes,
    declaredMime: normalizedMime(value.declaredMime || value.mime || value.type),
  };
  if (value instanceof Uint8Array) return { bytes: value, declaredMime: '' };
  throw new Error('asset_media_unreadable');
}

function result(ok, issues = [], mediaInputs = [], usage = {}) {
  return {
    schema: QIANMU_VIDEO_MEDIA_RESOLUTION_SCHEMA,
    ok,
    issues: [...new Set(issues.map((item) => text(item, 260)).filter(Boolean))],
    mediaInputs,
    usage: {
      assets: Math.max(0, Number(usage.assets) || 0),
      bytes: Math.max(0, Number(usage.bytes) || 0),
    },
  };
}

export function videoSelectedAssetIds(specValue = {}, manifestValue = {}) {
  const manifest = normalizeMultimodalAssetManifest(manifestValue);
  const spec = normalizeVideoShotSpec(specValue, manifest);
  return selectedAssetIds(spec);
}

export async function resolveStoryboardGalleryMediaInputs(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const manifest = normalizeMultimodalAssetManifest(raw.manifest);
  const spec = normalizeVideoShotSpec(raw.spec, manifest);
  const chatKey = text(raw.chatKey || raw.chat_key, 512);
  const limits = {
    maxAssetBytes: Math.min(QIANMU_VIDEO_MEDIA_LIMITS.maxAssetBytes, Math.max(1, Number(options.maxAssetBytes) || QIANMU_VIDEO_MEDIA_LIMITS.maxAssetBytes)),
    maxTotalBytes: Math.min(QIANMU_VIDEO_MEDIA_LIMITS.maxTotalBytes, Math.max(1, Number(options.maxTotalBytes) || QIANMU_VIDEO_MEDIA_LIMITS.maxTotalBytes)),
    timeoutMs: Math.min(120_000, Math.max(1000, Number(options.timeoutMs) || QIANMU_VIDEO_MEDIA_LIMITS.timeoutMs)),
  };
  const assetIds = selectedAssetIds(spec);
  if (!assetIds.length) return result(true);
  if (!chatKey) return result(false, ['media_chat_key_missing']);
  if (assetIds.length > QIANMU_VIDEO_MEDIA_LIMITS.maxAssets) return result(false, ['media_assets_exceeded']);
  let recordsValue;
  try { recordsValue = typeof options.getRecords === 'function' ? await options.getRecords(chatKey) : options.records; }
  catch (_) { return result(false, ['asset_gallery_unreadable']); }
  const records = Array.isArray(recordsValue) ? recordsValue : [];
  const assetById = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
  const mediaInputs = [];
  let totalBytes = 0;

  for (const assetId of assetIds) {
    const asset = assetById.get(assetId);
    if (!asset) return result(false, [`asset_manifest_missing:${assetId}`]);
    if (asset.kind !== 'image' || asset.locator.kind !== 'gallery' || asset.sourceRef.type !== 'storyboard_record') {
      return result(false, [`asset_gallery_source_unsupported:${assetId}`]);
    }
    const owner = text(asset.sourceRef.chatKey, 512);
    const recordId = text(asset.sourceRef.recordId, 200);
    if (!owner || owner !== chatKey || !recordId || asset.locator.ref !== `${owner}${GALLERY_SEPARATOR}${recordId}`) {
      return result(false, [`asset_owner_mismatch:${assetId}`]);
    }
    let record;
    try {
      record = typeof options.findRecord === 'function'
        ? await options.findRecord({ chatKey, recordId, assetId })
        : records.find((item) => text(item?.id || item?.recordId || item?.record_id, 200) === recordId);
    } catch (_) { return result(false, [`asset_gallery_unreadable:${assetId}`]); }
    if (!record) return result(false, [`asset_gallery_record_missing:${assetId}`]);
    if (text(record.id || record.recordId || record.record_id, 200) !== recordId) return result(false, [`asset_gallery_record_mismatch:${assetId}`]);
    const storedOwner = recordOwner(record);
    if (storedOwner && storedOwner !== chatKey) return result(false, [`asset_owner_mismatch:${assetId}`]);

    let loaded;
    try { loaded = await normalizeLoadedMedia(await loadRecordMedia(record, options, limits), limits.maxAssetBytes); }
    catch (error) { return result(false, [`${mediaErrorCode(error)}:${assetId}`]); }
    const bytes = loaded.bytes;
    if (!bytes.byteLength) return result(false, [`asset_media_empty:${assetId}`]);
    if (bytes.byteLength > limits.maxAssetBytes) return result(false, [`asset_media_too_large:${assetId}`]);
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) return result(false, ['inline_media_too_large']);
    const actualMime = imageMimeFromSignature(bytes);
    if (!actualMime) return result(false, [`asset_media_signature_invalid:${assetId}`]);
    const expectedMime = normalizedMime(asset.technical.mimeType);
    const declaredMime = loaded.declaredMime;
    if ((expectedMime && expectedMime !== actualMime) || (declaredMime && !ALLOWED_IMAGE_MIMES.includes(declaredMime)) || (declaredMime && declaredMime !== actualMime)) {
      return result(false, [`asset_media_mime_mismatch:${assetId}`]);
    }
    mediaInputs.push({ assetId, mime: actualMime, data: encodeBase64(bytes) });
  }
  return result(true, [], mediaInputs, { assets: mediaInputs.length, bytes: totalBytes });
}

export function createStoryboardGalleryMediaResolver(config = {}) {
  return (value = {}) => resolveStoryboardGalleryMediaInputs(value, config);
}
