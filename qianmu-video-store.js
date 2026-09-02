// 千幕动态镜头持久仓适配器。把运行层检查点规整后写入 IndexedDB，不允许瞬时凭据或媒体进入存储。
import * as defaultStorage from './qianmu-blobstore.js';
import { normalizeVideoBudgetReservation } from './qianmu-video-budget.js';
import {
  QIANMU_VIDEO_TASK_TERMINAL_STATES,
  normalizeVideoTask,
  validateVideoTask,
} from './qianmu-video-task.js';

export const QIANMU_VIDEO_STORE_SCHEMA = 'qianmu.video-store.v1';

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);

function assertStorage(storage) {
  const required = ['putVideoRuntimeCheckpoint', 'getVideoRuntimeTask', 'listVideoRuntimeTasks', 'listVideoBudgetRecords', 'deleteVideoRuntimeTasks'];
  if (!plain(storage) && typeof storage !== 'object') throw new Error('video storage adapter is unavailable');
  for (const method of required) if (typeof storage?.[method] !== 'function') throw new Error(`video storage method is unavailable: ${method}`);
  return storage;
}

function normalizedReservations(values, taskId = '', limit = 100) {
  const unique = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const item = normalizeVideoBudgetReservation(value);
    if (item.reservationId && (!taskId || item.taskId === taskId)) unique.set(item.reservationId, item);
  }
  return [...unique.values()].slice(0, Math.min(5000, Math.max(1, Number(limit) || 100)));
}

export function normalizeVideoStoreCheckpoint(value = {}) {
  const raw = plain(value) ? value : {};
  const task = normalizeVideoTask(raw.task);
  const validation = validateVideoTask(task);
  if (!validation.ok) throw new Error(`video task is not storable: ${validation.issues.join(',')}`);
  const reservations = normalizedReservations(raw.reservations, task.taskId);
  return {
    schema: QIANMU_VIDEO_STORE_SCHEMA,
    reason: text(raw.reason, 120),
    task,
    reservations,
  };
}

function normalizeStoredTaskRecord(value = {}) {
  const raw = plain(value) ? value : {};
  const task = normalizeVideoTask(raw.task);
  if (!task.taskId || !task.owner.chatKey) return null;
  return {
    schema: QIANMU_VIDEO_STORE_SCHEMA,
    task,
    updatedAt: Math.max(0, Number(raw.updatedAt) || task.timing.updatedAt),
  };
}

export function createVideoRuntimeStoreAdapter(storageValue = defaultStorage) {
  const storage = assertStorage(storageValue);
  const writeCheckpoint = async (value = {}) => {
    const checkpoint = normalizeVideoStoreCheckpoint(value);
    const stored = await storage.putVideoRuntimeCheckpoint(checkpoint.task, checkpoint.reservations);
    return {
      schema: QIANMU_VIDEO_STORE_SCHEMA,
      taskId: checkpoint.task.taskId,
      reservationIds: Array.isArray(stored?.reservations) ? stored.reservations.map((item) => text(item, 200)).filter(Boolean) : [],
    };
  };
  return Object.freeze({
    writeCheckpoint,

    checkpointWriter() {
      return writeCheckpoint;
    },

    async loadTask(taskId) {
      const record = normalizeStoredTaskRecord(await storage.getVideoRuntimeTask(text(taskId, 200)));
      return record?.task || null;
    },

    async restoreTask(taskId) {
      const id = text(taskId, 200);
      const [record, budgetRecords] = await Promise.all([
        storage.getVideoRuntimeTask(id),
        storage.listVideoBudgetRecords({ taskId: id }, { limit: 100 }),
      ]);
      const normalized = normalizeStoredTaskRecord(record);
      if (!normalized) return null;
      return {
        schema: QIANMU_VIDEO_STORE_SCHEMA,
        task: normalized.task,
        reservations: normalizedReservations((Array.isArray(budgetRecords) ? budgetRecords : []).map((item) => item?.reservation), id),
      };
    },

    async listTasks(chatKey = '', options = {}) {
      const records = await storage.listVideoRuntimeTasks(text(chatKey, 512), { limit: options.limit });
      const tasks = (Array.isArray(records) ? records : [])
        .map(normalizeStoredTaskRecord)
        .filter(Boolean)
        .map((item) => item.task);
      return options.resumableOnly === true
        ? tasks.filter((task) => !QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(task.state))
        : tasks;
    },

    async listBudget(filters = {}, options = {}) {
      const records = await storage.listVideoBudgetRecords({
        taskId: text(filters.taskId || filters.task_id, 200),
        chatKey: text(filters.chatKey || filters.chat_key, 512),
        dayKey: text(filters.dayKey || filters.day_key, 20),
      }, { limit: options.limit });
      return normalizedReservations(
        (Array.isArray(records) ? records : []).map((item) => item?.reservation),
        '',
        Math.min(5000, Math.max(1, Number(options.limit) || 2000)),
      );
    },

    async deleteTasks(taskIds = []) {
      const ids = [...new Set((Array.isArray(taskIds) ? taskIds : [])
        .map((item) => text(item, 200)).filter(Boolean))].slice(0, 500);
      return storage.deleteVideoRuntimeTasks(ids);
    },
  });
}
