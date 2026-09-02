// 千幕动态镜头草稿仓适配器。只接受白名单草稿合同，不读取媒体、不访问网络。
import * as defaultStorage from './qianmu-blobstore.js';
import { normalizeVideoDraft, validateVideoDraft } from './qianmu-video-draft.js';

export const QIANMU_VIDEO_DRAFT_STORE_SCHEMA = 'qianmu.video-draft-store.v1';

const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);

function assertStorage(storage) {
  for (const method of ['putVideoDraft', 'getVideoDraft', 'listVideoDrafts', 'deleteVideoDrafts']) {
    if (typeof storage?.[method] !== 'function') throw new Error(`video draft storage method is unavailable: ${method}`);
  }
  return storage;
}

function normalizeStoredRecord(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const draft = normalizeVideoDraft(raw.draft || raw);
  const validation = validateVideoDraft(draft);
  if (!validation.ok) return null;
  return validation.draft;
}

export function createVideoDraftStoreAdapter(storageValue = defaultStorage) {
  const storage = assertStorage(storageValue);
  return Object.freeze({
    async save(value = {}) {
      const validation = validateVideoDraft(value);
      if (!validation.ok) throw new Error(`video draft is not storable: ${validation.issues.join(',')}`);
      await storage.putVideoDraft(validation.draft);
      return validation.draft;
    },

    async load(draftId) {
      const record = await storage.getVideoDraft(text(draftId, 200));
      return record ? normalizeStoredRecord(record) : null;
    },

    async list(chatKey = '', options = {}) {
      const expectedChat = text(chatKey, 512);
      if (!expectedChat) return [];
      const records = await storage.listVideoDrafts(expectedChat, { limit: options.limit });
      return (Array.isArray(records) ? records : [])
        .map(normalizeStoredRecord)
        .filter((draft) => draft && draft.owner.chatKey === expectedChat)
        .sort((left, right) => right.timing.updatedAt - left.timing.updatedAt)
        .slice(0, Math.min(500, Math.max(1, Math.round(Number(options.limit) || 100))));
    },

    async remove(draftIds = []) {
      const ids = [...new Set((Array.isArray(draftIds) ? draftIds : [])
        .map((value) => text(value, 200)).filter(Boolean))].slice(0, 500);
      return storage.deleteVideoDrafts(ids);
    },
  });
}
