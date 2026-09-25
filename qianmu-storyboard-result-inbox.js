// Only accepted original-image bytes cross an ST account switch. Recipes and
// provider credentials remain with their original ST account, never in IDB.
const IMAGE_LIMIT = 24 * 1024 * 1024;
const BATCH_LIMIT = 64 * 1024 * 1024;
const allowedMime = value => /^(?:image\/png|image\/jpeg|image\/webp|image\/gif)$/i.test(String(value || ''));

export async function pendingOriginalBlob(image, { fetchImpl = globalThis.fetch } = {}) {
  const mime = String(image?.mime || '').split(';')[0].toLowerCase();
  if (image?.data) {
    const encoded = String(image.data).replace(/^data:image\/[^;,]+;base64,/i, '').replace(/\s+/g, '');
    if (!allowedMime(mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || !encoded.length || encoded.length > Math.ceil(IMAGE_LIMIT * 4 / 3) + 4)
      throw new Error('返回原图格式或大小不适合本机暂存');
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error('返回原图超过本机暂存容量');
    return new Blob([bytes], { type: mime });
  }
  const url = String(image?.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('返回原图缺少可保存的数据');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const length = Number(response.headers?.get('content-length') || 0);
    if (!response.ok || length > IMAGE_LIMIT) throw new Error('原图地址不可读取或超过本机暂存容量');
    const blob = await response.blob();
    if (!allowedMime(blob.type) || !blob.size || blob.size > IMAGE_LIMIT) throw new Error('原图地址未返回可暂存的图片');
    return blob;
  } finally { clearTimeout(timer); }
}

export async function captureForeignAccountOriginals(job, images, store, { fetchImpl = globalThis.fetch } = {}) {
  const namespace = String(job?.imageAccountNamespace || job?.imageAdmission?.namespace || '');
  if (Array.isArray(images) && images.length > 8)
    throw new Error('返回图超过 8 张，本机未暂存；请到原生图渠道核对');
  if (!namespace || job.imageAdmission?.namespace && job.imageAdmission.namespace !== namespace
    || !String(job.id || '') || !String(job.chatKey || '') || !Array.isArray(images) || !images.length || images.length > 8)
    throw new Error('跨账户原图来源无法核对，未写入当前账户');
  const originals = []; let total = 0;
  for (const image of images) {
    const blob = await pendingOriginalBlob(image, { fetchImpl });
    total += blob.size;
    if (total > BATCH_LIMIT) throw new Error('返回原图合计超过本机暂存容量');
    originals.push(blob);
  }
  const delivery = { namespace, taskId: String(job.id), chatKey: String(job.chatKey),
    target: String(job.target || 'gallery'), source: String(job.source || ''),
    logId: String(job.logId || ''), planId: String(job.planId || ''), shotId: String(job.planShotId || ''),
    imageCount: originals.length, originalOnly: true, createdAt: Date.now() };
  let error = null;
  try {
    await store.putStoryboardPendingOriginals(job.id, delivery, originals);
  } catch (cause) {
    error = cause;
  }
  return { delivery, durable: !error, originals: error ? originals : [], error };
}

export function storyboardImageExtension(mime = '') {
  const type = String(mime || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  return 'png';
}

// The ST file helper is account-scoped. Every asynchronous preparation step
// must be followed by an owner check before calling it; the host call itself
// is checked again on return before its URL may be attached to a gallery.
export async function persistStoryboardGatewayImage(image, job, index, {
  requireLocal = false, utilsModule, comfyFilename, assertOwner, safeUrl, toBase64,
  characterName, fetchImpl, origin,
} = {}) {
  const utils = await utilsModule().catch(() => null);
  const extension = storyboardImageExtension(image?.mime);
  const comfyService = requireLocal && job.source === 'comfy';
  const filename = comfyService ? await comfyFilename(job, index)
    : `qianmu_storyboard_${Date.now()}_${String(index + 1).padStart(2, '0')}`;
  if (image?.data && typeof utils?.saveBase64AsFile === 'function') {
    await assertOwner(job);
    const saved = await utils.saveBase64AsFile(String(image.data), comfyService ? 'Qianmu-Comfy' : characterName() || 'Qianmu', filename, extension);
    await assertOwner(job);
    const url = safeUrl(saved);
    if (url && (!requireLocal || new URL(url, origin).origin === origin)) return url;
  }
  if (requireLocal) throw new Error(`第 ${index + 1} 张原图未确认本地保存，服务暂存已保留`);
  const upstreamUrl = safeUrl(image?.url);
  if (!upstreamUrl) throw new Error(`第 ${index + 1} 张图片没有可保存的数据`);
  if (typeof utils?.saveBase64AsFile === 'function') {
    try {
      const response = await fetchImpl(upstreamUrl);
      if (response.ok) {
        const blob = await response.blob();
        if (blob.type?.startsWith('image/') && blob.size <= 32 * 1024 * 1024) {
          const base64 = await toBase64(blob);
          await assertOwner(job);
          const saved = await utils.saveBase64AsFile(base64, characterName() || 'Qianmu', filename, storyboardImageExtension(blob.type));
          await assertOwner(job);
          const localUrl = safeUrl(saved);
          if (localUrl) return localUrl;
        }
      }
    } catch (_) {}
  }
  return upstreamUrl;
}
