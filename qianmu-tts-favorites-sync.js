// 配音收藏（用户主动留存的音频）跟随 ST 账户走。
//
// A favourite is a short audio clip the user chose to keep — paid output that existed only in this browser.
// Each one is mirrored to one ST account file by the shared engine in qianmu-account-mirror.js: nothing is
// ever deleted remotely, removing a favourite here does not remove it on other devices, and a cleared
// browser gets them all back. Audio is already compressed, so the clip is stored as base64 without gzip.
import { createAccountMirror, portableJson, bytesToBase64, base64ToBytes } from './qianmu-account-mirror.js';

export const TTS_FAVORITES_INDEX_SLOT = 'tts-favorites';
const SLOT_PREFIX = 'tts-favorite-', MAX_CLIP_BYTES = 6 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlob = value => typeof Blob === 'function' && value instanceof Blob;

/** `blobStore` is the browser store module: listFavorites / getFavorite / restoreFavorite. */
export function createTtsFavoritesSync({ blobStore, ...options } = {}) {
  const store = {
    listKeys: async () => (await blobStore.listFavorites()).map(item => item.id),
    get: key => blobStore.getFavorite(key),
    put: (key, record) => blobStore.restoreFavorite(key, record),
  };
  return createAccountMirror({
    ...options, store, name: 'tts-favorite', label: '配音收藏', indexSlot: TTS_FAVORITES_INDEX_SLOT, slotPrefix: SLOT_PREFIX, compress: false,
    // The clip itself never changes after it is saved; the label and metadata can.
    token: record => JSON.stringify([Number(record?.createdAt) || 0, String(record?.label || ''), portableJson({ meta: record?.meta || {} }), isBlob(record?.blob) ? record.blob.size : -1]),
    encode: async record => {
      if (!plain(record) || !isBlob(record.blob) || !record.blob.size || record.blob.size > MAX_CLIP_BYTES) return null;
      const meta = portableJson({ meta: record.meta || {} });
      if (meta === null) return null;
      return JSON.stringify({ version: 1, label: String(record.label || ''), meta: JSON.parse(meta).meta, createdAt: Number(record.createdAt) || 0,
        type: String(record.blob.type || ''), data: bytesToBase64(new Uint8Array(await record.blob.arrayBuffer())) });
    },
    decode: async text => {
      try {
        const value = JSON.parse(text);
        if (!plain(value) || value.version !== 1 || typeof value.data !== 'string' || !value.data) return null;
        return { blob: new Blob([base64ToBytes(value.data)], { type: String(value.type || '') }), meta: plain(value.meta) ? value.meta : {}, label: String(value.label || ''), createdAt: Number(value.createdAt) || 0 };
      } catch { return null; }
    },
  });
}
