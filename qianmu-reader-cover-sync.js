// 伴读封面跟随 ST 账户走（只同步缩略图；书籍正文不同步）。
//
// The bookshelf (ids, titles, progress) is in ST settings and already follows the account, so a second
// device listed the books without their covers. Each cover is mirrored to one ST account file by the
// shared engine in qianmu-account-mirror.js. Only a thumbnail travels: the original stays in this browser
// untouched, and a device that received a thumbnail keeps showing that. A cover goes with its book — when
// the book is deleted the reader calls remove([bookId]) and other devices drop their copy too.
import { createAccountMirror, bytesToBase64, base64ToBytes } from './qianmu-account-mirror.js';

export const READER_COVER_INDEX_SLOT = 'reader-covers';
const SLOT_PREFIX = 'reader-cover-';
export const READER_COVER_MAX_EDGE = 600, READER_COVER_QUALITY = 0.82, READER_COVER_MAX_BYTES = 2 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlob = value => typeof Blob === 'function' && value instanceof Blob;

/** Browser default: longest edge 600 px, JPEG. Returns null when this browser cannot do it. */
export async function shrinkCoverImage(blob, { maxEdge = READER_COVER_MAX_EDGE, quality = READER_COVER_QUALITY } = {}) {
  if (typeof globalThis.createImageBitmap !== 'function') return null;
  const bitmap = await globalThis.createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const offscreen = typeof globalThis.OffscreenCanvas === 'function';
    if (!offscreen && !globalThis.document?.createElement) return null;
    const canvas = offscreen ? new globalThis.OffscreenCanvas(width, height) : Object.assign(globalThis.document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fff';   // JPEG has no transparency
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    if (offscreen) return await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally { bitmap.close?.(); }
}

/** `blobStore` is the browser store module: listCoverKeys / getCover / putCover / deleteCover. */
export function createReaderCoverSync({ blobStore, shrink = shrinkCoverImage, ...options } = {}) {
  const store = {
    listKeys: () => blobStore.listCoverKeys(),
    get: key => blobStore.getCover(key),
    put: (key, record) => blobStore.putCover(key, record),
    delete: key => blobStore.deleteCover(key),
  };
  return createAccountMirror({
    ...options, store, name: 'reader-cover', label: '伴读封面', indexSlot: READER_COVER_INDEX_SLOT, slotPrefix: SLOT_PREFIX, compress: false,
    token: record => (isBlob(record) ? `${record.size}|${record.type || ''}` : ''),
    order: () => 0,
    encode: async record => {
      if (!isBlob(record) || !record.size) return null;
      let small = null;
      try { small = await shrink(record); }
      catch (error) { console.warn('[千幕] 一张伴读封面未能缩小', error?.message || error); }
      // What cannot be shrunk travels as it is, unless it is too large for that; then it stays on this device.
      const out = isBlob(small) && small.size ? small : record;
      if (out.size > READER_COVER_MAX_BYTES) return null;
      return JSON.stringify({ version: 1, type: String(out.type || ''), data: bytesToBase64(new Uint8Array(await out.arrayBuffer())) });
    },
    decode: async text => {
      try {
        const value = JSON.parse(text);
        if (!plain(value) || value.version !== 1 || typeof value.data !== 'string' || !value.data) return null;
        return new Blob([base64ToBytes(value.data)], { type: String(value.type || '') });
      } catch { return null; }
    },
  });
}
