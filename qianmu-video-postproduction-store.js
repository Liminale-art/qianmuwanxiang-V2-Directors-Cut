// 千幕影片后期分层仓适配器。保存前绑定真实时间线重新校验，不读取任何媒体。
import * as defaultStorage from './qianmu-blobstore.js';
import { normalizeVideoPostproduction, validateVideoPostproduction } from './qianmu-video-postproduction.js';

export const QIANMU_VIDEO_POSTPRODUCTION_STORE_SCHEMA = 'qianmu.video-postproduction-store.v1';

const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const timestamp = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
};

function assertStorage(storage) {
  for (const method of ['putVideoPostproduction', 'getVideoPostproduction', 'deleteVideoPostproduction']) {
    if (typeof storage?.[method] !== 'function') throw new Error(`video postproduction storage method is unavailable: ${method}`);
  }
  return storage;
}

function storedProject(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return raw.project && typeof raw.project === 'object' && !Array.isArray(raw.project) ? raw.project : raw;
}

export function createVideoPostproductionStoreAdapter(storageValue = defaultStorage) {
  const storage = assertStorage(storageValue);
  return Object.freeze({
    async save(value = {}, timelineValue = {}, options = {}) {
      const validation = validateVideoPostproduction(value, timelineValue);
      if (!validation.ok) throw new Error(`video postproduction is not storable: ${validation.issues.join(',')}`);
      const now = timestamp(options.now, Date.now());
      const createdAt = timestamp(validation.project.createdAt, now) || now;
      const project = normalizeVideoPostproduction({
        ...validation.project,
        createdAt,
        updatedAt: Math.max(createdAt, now),
      }, timelineValue);
      await storage.putVideoPostproduction(project);
      return project;
    },

    async load(timelineId, chatKey = '', timelineValue = {}) {
      const expectedTimelineId = text(timelineId, 200);
      const expectedChat = text(chatKey, 512);
      if (!expectedTimelineId || !expectedChat) return null;
      const record = await storage.getVideoPostproduction(expectedTimelineId);
      if (!record) return null;
      const project = normalizeVideoPostproduction(storedProject(record), timelineValue);
      if (project.timelineId !== expectedTimelineId || project.owner.chatKey !== expectedChat) return null;
      const hasTimeline = Boolean(timelineValue?.timelineId || timelineValue?.timeline_id);
      if (hasTimeline && !validateVideoPostproduction(project, timelineValue).ok) return null;
      return project;
    },

    async remove(timelineIds = []) {
      const ids = [...new Set((Array.isArray(timelineIds) ? timelineIds : [])
        .map((value) => text(value, 200)).filter(Boolean))].slice(0, 500);
      return storage.deleteVideoPostproduction(ids);
    },
  });
}
