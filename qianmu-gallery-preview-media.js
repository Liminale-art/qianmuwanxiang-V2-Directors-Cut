import { comfyReferencePath } from './qianmu-comfy-reference-contract.js';

export const GALLERY_PREVIEW_MAX_BYTES = 24 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { code: 'gallery_preview_media' });
function signature(bytes) {
    if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 12 && [82,73,70,70].every((n, i) => bytes[i] === n) && [87,69,66,80].every((n, i) => bytes[i + 8] === n)) return 'image/webp';
    return '';
}
// Explicit click only; portable ST image paths, no proxy, remote redirects,
// persisted media, arbitrary request headers or global browser cache writes.
export async function loadGalleryPreviewImage(url, { fetchImpl = globalThis.fetch, guard = async () => {}, signal,
    decode = blob => globalThis.createImageBitmap(blob), timeoutMs = 30000 } = {}) {
    const path = comfyReferencePath(url), controller = new AbortController(); let rejectCancellation, reader;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); rejectCancellation(fail('原图读取已取消或超时，请重新打开；未改动原件')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(100, Math.min(60000, Number(timeoutMs) || 30000)));
    const check = () => { if (controller.signal.aborted) throw fail('原图读取已取消'); };
    try {
        if (signal?.aborted) abort();
        return await Promise.race([(async () => {
            await guard(); check();
            const response = await fetchImpl(path, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
            if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); check(); }
            const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!response.ok || response.redirected || !['image/png', 'image/jpeg', 'image/webp'].includes(type)
                || Number(response.headers.get('content-length')) > GALLERY_PREVIEW_MAX_BYTES) {
                void response.body?.cancel().catch(() => {}); throw fail('原图不存在、格式不支持或超过 24 MiB；目录引用保留');
            }
            reader = response.body?.getReader(); if (!reader) throw fail('原图返回不完整');
            const chunks = []; let length = 0;
            try {
                while (true) {
                    check(); const part = await reader.read(); check(); if (part.done) break;
                    length += part.value.byteLength;
                    if (length > GALLERY_PREVIEW_MAX_BYTES) throw fail('原图超过 24 MiB，已停止读取'); chunks.push(part.value);
                }
            } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); reader = null; }
            if (!length) throw fail('原图内容为空');
            const blob = new Blob(chunks, { type }), prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer()); check();
            const extension = path.split('.').at(-1).toLowerCase(), wanted = ['jpg', 'jpeg'].includes(extension) ? 'image/jpeg' : `image/${extension}`;
            if (signature(prefix) !== type || wanted !== type) throw fail('原图格式与内容不一致，未显示');
            await guard(); check();
            const decoding = Promise.resolve().then(() => { check(); return decode(blob); });
            void decoding.then(bitmap => { if (controller.signal.aborted) bitmap?.close(); }, () => {}).catch(() => {});
            const bitmap = await decoding;
            try {
                check(); if (!Number.isSafeInteger(bitmap?.width) || bitmap.width < 1 || !Number.isSafeInteger(bitmap.height) || bitmap.height < 1 || bitmap.width * bitmap.height > 32000000) throw fail('原图超过 3200 万像素或无法解码，请在原聊天查看');
                await guard(); check(); return { blob, width: bitmap.width, height: bitmap.height };
            } finally { bitmap?.close(); }
        })(), cancellation]);
    } catch (error) {
        if (error?.code === 'gallery_preview_media') throw error;
        throw fail('原图读取失败或账户已变化；未修改或删除任何资料');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); void reader?.cancel().catch(() => {}); }
}
