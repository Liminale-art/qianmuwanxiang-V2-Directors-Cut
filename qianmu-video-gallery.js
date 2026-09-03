// 千幕动态阅片室轻索引、任务摘要与播放会话。列表不读取 Blob；只有打开单条成片时才创建临时 Object URL。
import { normalizeVideoTask } from './qianmu-video-task.js';

export const QIANMU_VIDEO_GALLERY_SCHEMA = 'qianmu.video-gallery.v1';
export const QIANMU_VIDEO_GALLERY_MAX_BYTES = 768 * 1024 * 1024;

const MEDIA_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'application/octet-stream',
]);
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  return Number.isFinite(result) ? Math.min(max, Math.max(min, result)) : min;
};

function id(value, max = 200) {
  const result = text(value, max);
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : '';
}

function referenceIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => id(item)).filter(Boolean))].slice(0, 12);
}

export function normalizeVideoGalleryItem(value = {}) {
  const raw = plain(value) ? value : {};
  const meta = plain(raw.meta) ? raw.meta : raw;
  const assetId = id(raw.assetId || raw.asset_id || meta.assetId || meta.asset_id);
  const recordId = id(raw.recordId || raw.record_id || meta.recordId || meta.record_id);
  const taskId = id(meta.taskId || meta.task_id);
  const shotId = id(meta.shotId || meta.shot_id);
  const versionRootId = id(meta.versionRootId || meta.version_root_id) || taskId || shotId || recordId || assetId;
  const mimeType = text(raw.mimeType || raw.mime_type || meta.mimeType || meta.mime_type, 100).toLowerCase().split(';')[0].trim();
  const rawFloor = meta.floor;
  const floorValue = Number(rawFloor);
  return {
    schema: QIANMU_VIDEO_GALLERY_SCHEMA,
    assetId,
    recordId,
    taskId,
    shotId,
    versionRootId,
    parentRecordId: id(meta.parentRecordId || meta.parent_record_id),
    manifestId: id(meta.manifestId || meta.manifest_id),
    budgetReservationId: id(meta.budgetReservationId || meta.budget_reservation_id),
    attempt: Math.round(number(meta.attempt, 1, 99)),
    owner: {
      chatKey: text(meta.chatKey || meta.chat_key, 512),
      floor: rawFloor !== '' && rawFloor !== null && rawFloor !== undefined && Number.isInteger(floorValue) && floorValue >= 0 ? floorValue : null,
      messageId: id(meta.messageId || meta.message_id),
    },
    technical: {
      durationSeconds: number(meta.durationSeconds || meta.duration_seconds, 0, 3600),
      resolution: text(meta.resolution, 40),
      ratio: text(meta.ratio, 40),
      mimeType,
      size: Math.round(number(raw.size || meta.size, 0, QIANMU_VIDEO_GALLERY_MAX_BYTES)),
      audioMode: text(meta.audioMode || meta.audio_mode, 80),
    },
    referenceAssetIds: referenceIds(meta.referenceAssetIds || meta.reference_asset_ids),
    createdAt: Math.round(number(raw.createdAt || raw.created_at || meta.createdAt || meta.created_at)),
    updatedAt: Math.round(number(raw.updatedAt || raw.updated_at || meta.updatedAt || meta.updated_at)),
  };
}

export function buildVideoVersionChains(values = []) {
  const groups = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const item = normalizeVideoGalleryItem(value);
    if (!item.assetId || !item.recordId || !item.owner.chatKey) continue;
    const key = `${item.owner.chatKey}\n${item.versionRootId}`;
    const chain = groups.get(key) || { chatKey: item.owner.chatKey, versionRootId: item.versionRootId, items: [] };
    chain.items.push(item);
    groups.set(key, chain);
  }
  return [...groups.values()].map((chain) => {
    chain.items.sort((left, right) => left.attempt - right.attempt || left.createdAt - right.createdAt || left.recordId.localeCompare(right.recordId));
    return {
      ...chain,
      items: chain.items,
      latest: chain.items[chain.items.length - 1],
      count: chain.items.length,
    };
  }).sort((left, right) => right.latest.updatedAt - left.latest.updatedAt);
}

const TASK_PRESENTATION = Object.freeze({
  queued: { label: '待提交', tone: 'pending' },
  preparing: { label: '准备中', tone: 'active' },
  uploading: { label: '素材处理中', tone: 'active' },
  submitted: { label: '已提交', tone: 'active' },
  polling: { label: '生成中', tone: 'active' },
  cancel_requested: { label: '取消处理中', tone: 'pending' },
  succeeded: { label: '成片待归档', tone: 'attention' },
  failed: { label: '生成失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'muted' },
  expired: { label: '已过期', tone: 'muted' },
});

export function buildVideoTaskGalleryStatuses(values = [], availableAssetIds = [], options = {}) {
  const available = new Set((Array.isArray(availableAssetIds) ? availableAssetIds : []).map((value) => id(value)).filter(Boolean));
  const limit = Math.min(200, Math.max(1, Math.round(Number(options.limit) || 40)));
  return (Array.isArray(values) ? values : [])
    .map(normalizeVideoTask)
    .filter((task) => task.taskId && task.owner.chatKey)
    .filter((task) => task.state !== 'succeeded'
      || ![task.result.assetId, task.result.recordId].some((value) => available.has(id(value))))
    .map((task) => {
      const unknownSubmission = task.state === 'submitted' && !task.provider.remoteTaskId;
      const base = TASK_PRESENTATION[task.state] || TASK_PRESENTATION.queued;
      const progress = Math.min(99, Math.max(0, Math.round(Number(task.progress.percent) || 0)));
      return {
        taskId: task.taskId,
        shotId: task.shotId,
        state: task.state,
        statusLabel: unknownSubmission ? '待核对提交' : base.label,
        tone: unknownSubmission ? 'attention' : base.tone,
        owner: { ...task.owner },
        attempt: task.attempt,
        progress: ['preparing', 'uploading', 'submitted', 'polling'].includes(task.state) ? progress : 0,
        retryable: task.state === 'failed' && task.failure.retryable,
        canRefresh: (['submitted', 'polling'].includes(task.state) && Boolean(task.provider.remoteTaskId))
          || task.state === 'cancel_requested',
        needsReconciliation: unknownSubmission || task.budget.settlement === 'unknown',
        chargeUnknown: task.budget.settlement === 'unknown'
          || (task.state === 'failed' && task.failure.chargeState === 'unknown'),
        updatedAt: task.timing.updatedAt || task.timing.createdAt,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId))
    .slice(0, limit);
}

function assertStorage(storage) {
  for (const method of ['listVideoMedia', 'getVideoMedia', 'deleteVideoMedia']) {
    if (typeof storage?.[method] !== 'function') throw new Error(`video gallery storage method is unavailable: ${method}`);
  }
  return storage;
}

function assertUrlApi(urlApi) {
  if (typeof urlApi?.createObjectURL !== 'function' || typeof urlApi?.revokeObjectURL !== 'function') {
    throw new Error('video gallery object URL API is unavailable');
  }
  return urlApi;
}

export function createVideoGallerySession(storageValue, options = {}) {
  const storage = assertStorage(storageValue);
  const urlApi = assertUrlApi(options.urlApi || globalThis.URL);
  const active = new Map();

  function revoke(assetIdValue) {
    const assetId = id(assetIdValue);
    const entry = active.get(assetId);
    if (!entry) return false;
    active.delete(assetId);
    try { urlApi.revokeObjectURL(entry.url); } catch (_) {}
    return true;
  }

  return Object.freeze({
    async list(chatKey = '', listOptions = {}) {
      const records = await storage.listVideoMedia(text(chatKey, 512), { limit: listOptions.limit });
      return (Array.isArray(records) ? records : [])
        .map(normalizeVideoGalleryItem)
        .filter((item) => item.assetId && item.recordId && (!chatKey || item.owner.chatKey === text(chatKey, 512)))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },

    async open(assetIdValue, openOptions = {}) {
      const assetId = id(assetIdValue);
      if (!assetId) throw new Error('video gallery asset id is invalid');
      let entry = active.get(assetId);
      if (!entry) {
        const record = await storage.getVideoMedia(assetId);
        if (!record || typeof Blob === 'undefined' || !(record.blob instanceof Blob)) throw new Error('video gallery media is missing');
        const item = normalizeVideoGalleryItem({ ...record, assetId });
        const expectedChat = text(openOptions.chatKey || openOptions.chat_key, 512);
        if (expectedChat && item.owner.chatKey !== expectedChat) throw new Error('video gallery media belongs to another chat');
        const mimeType = text(record.blob.type || item.technical.mimeType, 100).toLowerCase().split(';')[0].trim();
        if (!record.blob.size || record.blob.size > QIANMU_VIDEO_GALLERY_MAX_BYTES || !MEDIA_MIME_TYPES.has(mimeType)) {
          throw new Error('video gallery media is invalid');
        }
        entry = { url: urlApi.createObjectURL(record.blob), refs: 0, item: normalizeVideoGalleryItem({ ...record, assetId, mimeType, size: record.blob.size }) };
        active.set(assetId, entry);
      } else {
        const expectedChat = text(openOptions.chatKey || openOptions.chat_key, 512);
        if (expectedChat && entry.item.owner.chatKey !== expectedChat) throw new Error('video gallery media belongs to another chat');
      }
      entry.refs++;
      let released = false;
      return Object.freeze({
        ...entry.item,
        url: entry.url,
        release() {
          if (released) return false;
          released = true;
          entry.refs = Math.max(0, entry.refs - 1);
          if (entry.refs === 0) revoke(assetId);
          return true;
        },
      });
    },

    close(assetIdValue) {
      return revoke(assetIdValue);
    },

    async delete(assetIdValue) {
      const assetId = id(assetIdValue);
      if (!assetId) throw new Error('video gallery asset id is invalid');
      revoke(assetId);
      return storage.deleteVideoMedia(assetId);
    },

    dispose() {
      for (const assetId of [...active.keys()]) revoke(assetId);
    },

    snapshot() {
      return [...active.entries()].map(([assetId, entry]) => ({ assetId, refs: entry.refs }));
    },
  });
}
