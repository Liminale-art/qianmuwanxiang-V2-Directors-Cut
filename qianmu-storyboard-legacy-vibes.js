import { comfyReferencePath } from './qianmu-comfy-reference-contract.js';
import { comfyReferenceStillMime } from './qianmu-comfy-results.js';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';
import { vibeDigest } from './qianmu-vibe-file.js';

export const LEGACY_VIBE_ORIGINALS_SCHEMA = 'qianmu.storyboard.legacy-vibes.v1';
const limit = 16 * 1048576;
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_legacy_vibes', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function sourcePath(url) {
  // Do not rewrite historical recipes, follow signed URLs, or send ST credentials to an external host.
  // External/absolute sources need a separate explicit source-rebinding contract, not an implicit fetch fallback.
  try { return comfyReferencePath(url); }
  catch (_) { fail('旧 Vibe 有非本地图片地址，尚不能完整打包。请保留旧环境并单独保全该原图；本次未输出缺件包。'); }
}
function sources(urls) {
  if (!Array.isArray(urls) || urls.length > 1024) fail('旧 Vibe 地址超过 1024 项或清单无效');
  const seen = new Set();
  return urls.map(row => {
    if (!object(row) || typeof row.url !== 'string' || seen.has(row.url)) fail('旧 Vibe 地址重复或无效');
    seen.add(row.url); return { url: row.url, path: sourcePath(row.url) };
  });
}

// This manifest proves which local files accompany URL-only recipes. It grants no write or network authority.
export function inspectLegacyVibeOriginals(document, urls) {
  const expected = new Map(sources(urls).map(row => [row.url, row.path]));
  if (!only(document, ['schema','items']) || document.schema !== LEGACY_VIBE_ORIGINALS_SCHEMA || !Array.isArray(document.items) || document.items.length !== expected.size) fail('旧 Vibe 原图清单缺件、多件或版本无效');
  const paths = new Map(), rows = [];
  for (const row of document.items) {
    if (!only(row, ['url','receipt']) || !expected.has(row.url)) fail('旧 Vibe 原图位置重复或没有对应配方');
    const receipt = imageRestoreReceipt(row.receipt);
    if (receipt.bytes > limit || receipt.url !== expected.get(row.url)) fail('旧 Vibe 原图收据与历史地址不符');
    const previous = paths.get(receipt.url);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) fail('旧 Vibe 同一路径包含不同原图');
    paths.set(receipt.url, receipt); expected.delete(row.url); rows.push({ url: row.url, receipt });
  }
  if (expected.size) fail('旧 Vibe 缺少原图');
  return { rows, receipts: [...paths.values()] };
}

// Read-only export; all locations are checked before the first request. Existing recipes/IDs/parameters stay unchanged.
export async function captureLegacyVibeOriginals(urls, { guard, fetch: request = globalThis.fetch, maxBytes = 512 * 1048576, timeoutMs = 25000 } = {}) {
  if (typeof guard !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 512 * 1048576) fail('缺少旧 Vibe 原图读取范围核对');
  const locations = sources(urls), paths = new Map(), files = new Map(), items = [];
  const estimatedManifest = JSON.stringify({ schema: LEGACY_VIBE_ORIGINALS_SCHEMA, items: locations.map(row => ({ url: row.url, receipt: { url: row.path, mime: 'image/jpeg', bytes: limit, sha256: '0'.repeat(64) } })) });
  if (new TextEncoder().encode(estimatedManifest).byteLength > 2 * 1048576) fail('旧 Vibe 原图清单超过 2 MiB，未读取任何原图');
  let retainedBytes = 0;
  for (const row of locations) {
    await guard();
    if (!paths.has(row.path)) {
      if (retainedBytes >= maxBytes) fail('旧 Vibe 原图合计超过联包可用容量');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(60000, timeoutMs)));
      let reader, response;
      try {
        response = await request(row.path, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
        await guard();
        if (!response.ok || response.redirected || !response.body?.getReader) fail('旧 Vibe 原图读取失败，未输出缺件包');
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > Math.min(limit, maxBytes - retainedBytes))) fail('旧 Vibe 原图超过 16 MiB 或联包剩余容量');
        reader = response.body.getReader(); const chunks = []; let length = 0;
        while (true) {
          const part = await reader.read(); await guard(); if (part.done) break;
          length += part.value.byteLength;
          if (length > limit || retainedBytes + length > maxBytes) fail('旧 Vibe 原图超过 16 MiB 或联包剩余容量');
          chunks.push(part.value);
        }
        if (!length) fail('旧 Vibe 原图为空');
        const blob = new Blob(chunks), bytes = new Uint8Array(await blob.arrayBuffer()); await guard();
        const mime = comfyReferenceStillMime(bytes), sha256 = await vibeDigest(bytes); await guard();
        const receipt = imageRestoreReceipt({ url: row.path, mime, bytes: length, sha256 });
        paths.set(row.path, receipt);
        if (!files.has(sha256)) { files.set(sha256, new Blob([blob], { type: mime })); retainedBytes += length; }
      } finally {
        clearTimeout(timer); controller.abort();
        if (reader) { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
        else if (response?.body) try { await response.body.cancel(); } catch (_) {}
      }
    }
    items.push({ url: row.url, receipt: paths.get(row.path) });
  }
  const document = { schema: LEGACY_VIBE_ORIGINALS_SCHEMA, items };
  inspectLegacyVibeOriginals(document, urls); await guard();
  return { document, files };
}
