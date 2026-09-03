// 千幕完整影片时间线仓适配器。仅持久化时间线合同，不读取媒体、不访问网络。
import * as defaultStorage from './qianmu-blobstore.js';
import { normalizeVideoTimeline, validateVideoTimeline } from './qianmu-video-timeline.js';

export const QIANMU_VIDEO_TIMELINE_STORE_SCHEMA = 'qianmu.video-timeline-store.v1';

const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const timestamp = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
};

function assertStorage(storage) {
  for (const method of ['putVideoTimeline', 'getVideoTimeline', 'listVideoTimelines', 'deleteVideoTimelines']) {
    if (typeof storage?.[method] !== 'function') throw new Error(`video timeline storage method is unavailable: ${method}`);
  }
  return storage;
}

function normalizeStoredRecord(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const timeline = normalizeVideoTimeline(raw.timeline || raw);
  const validation = validateVideoTimeline(timeline);
  return validation.ok ? validation.timeline : null;
}

export function createVideoTimelineStoreAdapter(storageValue = defaultStorage) {
  const storage = assertStorage(storageValue);
  return Object.freeze({
    async save(value = {}, options = {}) {
      const validation = validateVideoTimeline(value);
      if (!validation.ok) throw new Error(`video timeline is not storable: ${validation.issues.join(',')}`);
      const now = timestamp(options.now, Date.now());
      const createdAt = timestamp(validation.timeline.createdAt, now) || now;
      const timeline = normalizeVideoTimeline({
        ...validation.timeline,
        createdAt,
        updatedAt: Math.max(createdAt, now),
      });
      await storage.putVideoTimeline(timeline);
      return timeline;
    },

    async load(timelineId, chatKey = '') {
      const expectedChat = text(chatKey, 512);
      const record = await storage.getVideoTimeline(text(timelineId, 200));
      const timeline = record ? normalizeStoredRecord(record) : null;
      return timeline && (!expectedChat || timeline.owner.chatKey === expectedChat) ? timeline : null;
    },

    async list(chatKey = '', options = {}) {
      const expectedChat = text(chatKey, 512);
      if (!expectedChat) return [];
      const limit = Math.min(500, Math.max(1, Math.round(Number(options.limit) || 100)));
      const records = await storage.listVideoTimelines(expectedChat, { limit });
      return (Array.isArray(records) ? records : [])
        .map(normalizeStoredRecord)
        .filter((timeline) => timeline && timeline.owner.chatKey === expectedChat)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit);
    },

    async remove(timelineIds = []) {
      const ids = [...new Set((Array.isArray(timelineIds) ? timelineIds : [])
        .map((value) => text(value, 200)).filter(Boolean))].slice(0, 500);
      return storage.deleteVideoTimelines(ids);
    },
  });
}
