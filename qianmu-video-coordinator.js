// 千幕 H3 客户端协调门面。集中串联任务仓、预算、网关与成片归档，但不自行启动轮询或付费任务。
import * as defaultStorage from './qianmu-blobstore.js';
import { createMiniMaxH3ResultArchiver } from './qianmu-video-result.js';
import {
  fetchMiniMaxH3Capabilities,
  pollMiniMaxH3VideoTask,
  reconcileMiniMaxH3Cancellation,
  submitMiniMaxH3VideoTask,
} from './qianmu-video-runtime.js';
import { createVideoRuntimeStoreAdapter } from './qianmu-video-store.js';
import {
  beginVideoTaskRetry,
  claimVideoTaskLease,
  createVideoTask,
  normalizeVideoTask,
  requestVideoTaskCancellation,
  resumeVideoTask,
  validateVideoTask,
} from './qianmu-video-task.js';

export const QIANMU_VIDEO_COORDINATOR_SCHEMA = 'qianmu.video-coordinator.v1';

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const time = (value, fallback = Date.now()) => Math.max(0, Math.round(Number.isFinite(Number(value)) ? Number(value) : fallback));

function generatedWorkerId() {
  try { return `qianmu-video-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
  catch (_) { return `qianmu-video-${Date.now()}`; }
}

async function resolved(value, fallback) {
  if (typeof value === 'function') return value();
  return value === undefined ? fallback : value;
}

function blocked(issue, task = null, reservations = []) {
  return {
    schema: QIANMU_VIDEO_COORDINATOR_SCHEMA,
    ok: false,
    action: 'blocked',
    issue: text(issue, 160),
    task: task ? normalizeVideoTask(task) : null,
    reservations: Array.isArray(reservations) ? reservations : [],
  };
}

export function createMiniMaxH3Coordinator(config = {}) {
  const storage = config.storage || defaultStorage;
  const taskStore = createVideoRuntimeStoreAdapter(storage);
  const workerId = text(config.workerId || config.worker_id, 200) || generatedWorkerId();
  const active = new Set();
  let disposed = false;

  async function requestContext(value = {}) {
    const raw = plain(value) ? value : {};
    const apiKey = text(raw.apiKey || raw.api_key || await resolved(config.getApiKey || config.get_api_key, ''), 4096);
    const configuredConnection = plain(raw.connection) ? raw.connection : await resolved(config.connection, {});
    const configuredHeaders = plain(raw.headers) ? raw.headers : await resolved(config.headers, {});
    const connection = plain(configuredConnection) ? configuredConnection : {};
    const headers = plain(configuredHeaders) ? configuredHeaders : {};
    return { apiKey, connection, headers };
  }

  function runtimeOptions(context, value = {}, includeResult = false) {
    const raw = plain(value) ? value : {};
    const base = {
      workerId,
      now: time(raw.now, Date.now()),
      persistCheckpoint: taskStore.checkpointWriter(),
      fetchImpl: raw.fetchImpl || config.fetchImpl,
      headers: context.headers,
      gatewayBase: raw.gatewayBase || config.gatewayBase,
      leaseTtlMs: raw.leaseTtlMs || config.leaseTtlMs,
    };
    if (includeResult) {
      base.storeResult = createMiniMaxH3ResultArchiver(storage, {
        apiKey: context.apiKey,
        connection: context.connection,
        headers: context.headers,
        fetchImpl: base.fetchImpl,
        timeoutMs: raw.resultTimeoutMs || config.resultTimeoutMs,
      });
    }
    return base;
  }

  async function loadTaskAndBudget(taskIdValue) {
    const taskId = text(taskIdValue, 200);
    if (!taskId) return null;
    return taskStore.restoreTask(taskId);
  }

  async function submissionMedia(raw, task) {
    const explicit = raw.mediaInputs ?? raw.media_inputs;
    if (Array.isArray(explicit)) return { ok: true, mediaInputs: explicit };
    const resolver = raw.resolveMediaInputs || raw.resolve_media_inputs || config.resolveMediaInputs || config.resolve_media_inputs;
    if (typeof resolver !== 'function') return { ok: true, mediaInputs: [] };
    try {
      const resolvedMedia = await resolver({
        spec: raw.spec,
        manifest: raw.manifest,
        chatKey: task.owner.chatKey,
        taskId: task.taskId,
        attempt: task.attempt,
        signal: raw.signal,
      });
      if (!resolvedMedia?.ok) return { ok: false, issue: text(resolvedMedia?.issues?.[0], 260) || 'media_resolution_failed' };
      if (!Array.isArray(resolvedMedia.mediaInputs)) return { ok: false, issue: 'media_resolution_invalid' };
      return { ok: true, mediaInputs: resolvedMedia.mediaInputs };
    } catch (_) {
      return { ok: false, issue: 'media_resolution_failed' };
    }
  }

  async function exclusive(taskIdValue, work) {
    const taskId = text(taskIdValue, 200);
    if (disposed) return blocked('coordinator_disposed');
    if (!taskId) return blocked('task_id_missing');
    if (active.has(taskId)) return blocked('local_operation_in_progress');
    active.add(taskId);
    try { return await work(taskId); }
    finally { active.delete(taskId); }
  }

  return Object.freeze({
    workerId,

    async capabilities(value = {}) {
      if (disposed) return blocked('coordinator_disposed');
      const context = await requestContext(value);
      return fetchMiniMaxH3Capabilities(runtimeOptions(context, value));
    },

    async createTask(value = {}) {
      if (disposed) return blocked('coordinator_disposed');
      const raw = plain(value) ? value : {};
      const task = createVideoTask({
        ...raw,
        provider: {
          ...(plain(raw.provider) ? raw.provider : {}),
          channel: 'minimax-h3',
          connectionId: text(raw.connectionId || raw.connection_id || raw.provider?.connectionId || raw.provider?.connection_id
            || raw.connection?.connectionId || raw.connection?.connection_id, 200),
        },
      }, { now: time(raw.now, Date.now()), clientNonce: raw.clientNonce || raw.client_nonce });
      const validation = validateVideoTask(task);
      if (!validation.ok) return blocked(validation.issues[0], task);
      await taskStore.writeCheckpoint({ reason: 'task_created', task, reservations: [] });
      return { schema: QIANMU_VIDEO_COORDINATOR_SCHEMA, ok: true, action: 'created', issue: '', task, reservations: [] };
    },

    async submit(value = {}) {
      const raw = plain(value) ? value : {};
      const suppliedTask = raw.task ? normalizeVideoTask(raw.task) : null;
      const requestedId = suppliedTask?.taskId || raw.taskId || raw.task_id;
      return exclusive(requestedId, async (taskId) => {
        const restored = suppliedTask ? null : await loadTaskAndBudget(taskId);
        const task = suppliedTask || restored?.task;
        if (!task) return blocked('task_not_found');
        const context = await requestContext(raw);
        if (!context.apiKey) return blocked('missing_api_key', task, restored?.reservations);
        const media = await submissionMedia(raw, task);
        if (!media.ok) return blocked(media.issue, task, restored?.reservations);
        const reservations = await taskStore.listBudget({}, { limit: config.budgetScanLimit || 2000 });
        return submitMiniMaxH3VideoTask({
          ...raw,
          task,
          reservations,
          apiKey: context.apiKey,
          connection: context.connection,
          mediaInputs: media.mediaInputs,
        }, runtimeOptions(context, raw));
      });
    },

    async drive(value = {}) {
      const raw = plain(value) ? value : {};
      return exclusive(raw.taskId || raw.task_id, async (taskId) => {
        const restored = await loadTaskAndBudget(taskId);
        if (!restored?.task) return blocked('task_not_found');
        const task = restored.task;
        const plan = resumeVideoTask(task, { chatKey: raw.chatKey || raw.chat_key, workerId }, { now: time(raw.now, Date.now()) });
        if (plan.action === 'skip') return blocked(plan.reason, plan.task, restored.reservations);
        if (plan.action === 'none' || plan.action === 'await_retry_confirmation') {
          return { schema: QIANMU_VIDEO_COORDINATOR_SCHEMA, ok: true, action: plan.action, issue: plan.reason, task: plan.task, reservations: restored.reservations };
        }
        if (plan.action === 'prepare' || plan.action === 'reconcile_submission') {
          return { schema: QIANMU_VIDEO_COORDINATOR_SCHEMA, ok: false, action: plan.action, issue: plan.reason, task: plan.task, reservations: restored.reservations };
        }
        const context = await requestContext(raw);
        if (!context.apiKey && plan.action !== 'finalize_cancel') return blocked('missing_api_key', task, restored.reservations);
        const input = { task, reservations: restored.reservations, apiKey: context.apiKey, connection: context.connection };
        const options = runtimeOptions(context, raw, true);
        return plan.action === 'poll'
          ? pollMiniMaxH3VideoTask(input, options)
          : reconcileMiniMaxH3Cancellation(input, options);
      });
    },

    async requestCancellation(value = {}) {
      const raw = plain(value) ? value : {};
      return exclusive(raw.taskId || raw.task_id, async (taskId) => {
        const restored = await loadTaskAndBudget(taskId);
        if (!restored?.task) return blocked('task_not_found');
        const expectedChat = text(raw.chatKey || raw.chat_key, 512);
        if (!expectedChat || restored.task.owner.chatKey !== expectedChat) return blocked('owner_mismatch', restored.task, restored.reservations);
        const leased = claimVideoTaskLease(restored.task, workerId, { now: time(raw.now, Date.now()), ttlMs: raw.leaseTtlMs || config.leaseTtlMs });
        if (!leased.acquired) return blocked(leased.reason, leased.task, restored.reservations);
        const requested = requestVideoTaskCancellation(leased.task, { now: time(raw.now, Date.now()) });
        if (!requested.ok) return blocked(requested.issue, requested.task, restored.reservations);
        await taskStore.writeCheckpoint({ reason: 'cancel_requested', task: requested.task, reservations: restored.reservations });
        return { schema: QIANMU_VIDEO_COORDINATOR_SCHEMA, ok: true, action: 'cancel_requested', issue: '', task: requested.task, reservations: restored.reservations };
      });
    },

    async retry(value = {}) {
      const raw = plain(value) ? value : {};
      return exclusive(raw.taskId || raw.task_id, async (taskId) => {
        const restored = await loadTaskAndBudget(taskId);
        if (!restored?.task) return blocked('task_not_found');
        const expectedChat = text(raw.chatKey || raw.chat_key, 512);
        if (!expectedChat || restored.task.owner.chatKey !== expectedChat) return blocked('owner_mismatch', restored.task, restored.reservations);
        const retried = beginVideoTaskRetry(restored.task, { allowNewCharge: raw.allowNewCharge === true, now: time(raw.now, Date.now()) });
        if (!retried.ok) return blocked(retried.issue, retried.task, restored.reservations);
        await taskStore.writeCheckpoint({ reason: 'retry_confirmed', task: retried.task, reservations: restored.reservations });
        return { schema: QIANMU_VIDEO_COORDINATOR_SCHEMA, ok: true, action: 'retry_ready', issue: '', task: retried.task, reservations: restored.reservations };
      });
    },

    async getTask(taskId) {
      if (disposed) return null;
      return taskStore.loadTask(taskId);
    },

    async listTasks(chatKey, options = {}) {
      if (disposed) return [];
      return taskStore.listTasks(text(chatKey, 512), options);
    },

    async resumePlans(chatKey, options = {}) {
      if (disposed) return [];
      const expectedChat = text(chatKey, 512);
      if (!expectedChat) return [];
      const tasks = await taskStore.listTasks(expectedChat, { ...options, resumableOnly: true });
      return tasks.map((task) => resumeVideoTask(task, { chatKey: expectedChat, workerId }, { now: time(options.now, Date.now()) }));
    },

    snapshot() {
      return { schema: QIANMU_VIDEO_COORDINATOR_SCHEMA, workerId, disposed, activeTaskIds: [...active] };
    },

    dispose() {
      disposed = true;
    },
  });
}
