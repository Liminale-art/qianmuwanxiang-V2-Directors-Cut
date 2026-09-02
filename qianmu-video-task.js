// 千幕异步视频任务合同。纯数据层：不访问 DOM、设置、聊天、网络或媒体二进制。
export const QIANMU_VIDEO_TASK_SCHEMA = 'qianmu.video-task.v1';

export const QIANMU_VIDEO_TASK_STATES = Object.freeze([
  'queued',
  'preparing',
  'uploading',
  'submitted',
  'polling',
  'cancel_requested',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

export const QIANMU_VIDEO_TASK_TERMINAL_STATES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  queued: ['preparing', 'cancel_requested', 'failed', 'expired'],
  preparing: ['uploading', 'submitted', 'cancel_requested', 'failed', 'expired'],
  uploading: ['submitted', 'cancel_requested', 'failed', 'expired'],
  submitted: ['polling', 'succeeded', 'cancel_requested', 'failed', 'cancelled', 'expired'],
  polling: ['polling', 'succeeded', 'cancel_requested', 'failed', 'cancelled', 'expired'],
  cancel_requested: ['cancelled', 'succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
});

const BUDGET_SETTLEMENTS = Object.freeze(['unsettled', 'reserved', 'committed', 'released', 'unknown']);
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const integer = (value, min, max, fallback = min) => Math.min(max, Math.max(min, Math.round(finite(value, fallback))));
const time = (value, fallback = 0) => Math.max(0, Math.round(finite(value, fallback)));

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function redactDiagnostic(value, max = 1600) {
  return text(value, max)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|token|key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_ -]?key|authorization|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function idempotencyKey(taskId, attempt) {
  return `qianmu-video-${hash(`${taskId}|attempt:${attempt}`)}`;
}

function normalizeOwner(value = {}) {
  const raw = plain(value) ? value : {};
  const floor = Number(raw.floor);
  return {
    chatKey: text(raw.chatKey || raw.chat_key, 512),
    floor: Number.isInteger(floor) && floor >= 0 ? floor : null,
    messageId: text(raw.messageId || raw.message_id, 200),
  };
}

function normalizeLogEntry(value = {}, index = 0) {
  const raw = plain(value) ? value : {};
  const state = QIANMU_VIDEO_TASK_STATES.includes(raw.state) ? raw.state : '';
  return {
    eventId: text(raw.eventId || raw.event_id, 160) || `event-${index + 1}`,
    at: time(raw.at || raw.timestamp),
    state,
    attempt: integer(raw.attempt, 1, 99, 1),
    code: text(raw.code, 160),
    message: redactDiagnostic(raw.message),
    providerStatus: text(raw.providerStatus || raw.provider_status, 200),
    requestId: text(raw.requestId || raw.request_id, 300),
  };
}

export function normalizeVideoTask(value = {}) {
  const raw = plain(value) ? value : {};
  const timingRaw = plain(raw.timing) ? raw.timing : {};
  const owner = normalizeOwner(raw.owner || raw.timelineAnchor || raw.timeline_anchor);
  const shotId = text(raw.shotId || raw.shot_id, 200);
  const createdAt = time(timingRaw.createdAt || timingRaw.created_at || raw.createdAt || raw.created_at);
  const taskSeed = `${owner.chatKey}|${owner.floor ?? ''}|${shotId}|${createdAt}|${text(raw.clientNonce || raw.client_nonce, 160)}`;
  const taskId = text(raw.taskId || raw.task_id || raw.id, 200) || `video-task-${hash(taskSeed)}`;
  const attempt = integer(raw.attempt, 1, 99, 1);
  const providerRaw = plain(raw.provider) ? raw.provider : {};
  const submissionRaw = plain(raw.submission) ? raw.submission : {};
  const progressRaw = plain(raw.progress) ? raw.progress : {};
  const resultRaw = plain(raw.result) ? raw.result : {};
  const failureRaw = plain(raw.failure) ? raw.failure : {};
  const budgetRaw = plain(raw.budget) ? raw.budget : {};
  const leaseRaw = plain(raw.lease) ? raw.lease : {};
  const state = QIANMU_VIDEO_TASK_STATES.includes(raw.state) ? raw.state : 'queued';
  const progressPercent = state === 'succeeded' ? 100 : integer(progressRaw.percent, 0, 100, 0);
  return {
    schema: QIANMU_VIDEO_TASK_SCHEMA,
    taskId,
    shotId,
    manifestId: text(raw.manifestId || raw.manifest_id, 200),
    owner,
    state,
    attempt,
    provider: {
      channel: text(providerRaw.channel, 120),
      connectionId: text(providerRaw.connectionId || providerRaw.connection_id, 200),
      remoteTaskId: text(providerRaw.remoteTaskId || providerRaw.remote_task_id, 400),
      lastStatus: text(providerRaw.lastStatus || providerRaw.last_status, 200),
    },
    submission: {
      idempotencyKey: text(submissionRaw.idempotencyKey || submissionRaw.idempotency_key, 300) || idempotencyKey(taskId, attempt),
      providerAccepted: Boolean(submissionRaw.providerAccepted ?? submissionRaw.provider_accepted),
      acceptedAt: time(submissionRaw.acceptedAt || submissionRaw.accepted_at),
      requestId: text(submissionRaw.requestId || submissionRaw.request_id, 300),
    },
    progress: {
      percent: progressPercent,
      stage: text(progressRaw.stage, 160),
      detail: redactDiagnostic(progressRaw.detail, 800),
    },
    result: {
      recordId: text(resultRaw.recordId || resultRaw.record_id, 200),
      assetId: text(resultRaw.assetId || resultRaw.asset_id, 200),
      durationSeconds: Math.max(0, finite(resultRaw.durationSeconds || resultRaw.duration_seconds, 0)),
      resolution: text(resultRaw.resolution, 80),
    },
    failure: {
      code: text(failureRaw.code, 160),
      message: redactDiagnostic(failureRaw.message),
      retryable: Boolean(failureRaw.retryable),
      chargeState: ['not_charged', 'charged', 'unknown'].includes(failureRaw.chargeState || failureRaw.charge_state)
        ? (failureRaw.chargeState || failureRaw.charge_state)
        : 'unknown',
    },
    budget: {
      reservationId: text(budgetRaw.reservationId || budgetRaw.reservation_id, 200),
      estimatedUnits: Math.max(0, finite(budgetRaw.estimatedUnits || budgetRaw.estimated_units, 0)),
      settlement: BUDGET_SETTLEMENTS.includes(budgetRaw.settlement) ? budgetRaw.settlement : 'unsettled',
      settledAt: time(budgetRaw.settledAt || budgetRaw.settled_at),
    },
    timing: {
      createdAt,
      updatedAt: time(timingRaw.updatedAt || timingRaw.updated_at || raw.updatedAt || raw.updated_at, createdAt),
      nextPollAt: time(timingRaw.nextPollAt || timingRaw.next_poll_at),
      expiresAt: time(timingRaw.expiresAt || timingRaw.expires_at || raw.expiresAt || raw.expires_at),
      cancelRequestedAt: time(timingRaw.cancelRequestedAt || timingRaw.cancel_requested_at),
    },
    lease: {
      holder: text(leaseRaw.holder, 200),
      expiresAt: time(leaseRaw.expiresAt || leaseRaw.expires_at),
    },
    history: (Array.isArray(raw.history) ? raw.history : []).slice(-80).map(normalizeLogEntry),
  };
}

export function createVideoTask(value = {}, options = {}) {
  const now = time(options.now, Date.now());
  const raw = plain(value) ? value : {};
  const task = normalizeVideoTask({
    ...raw,
    state: 'queued',
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    clientNonce: raw.clientNonce || raw.client_nonce || text(options.clientNonce, 160),
  });
  task.history = [{
    eventId: `event-${hash(`${task.taskId}|created|${now}`)}`,
    at: now,
    state: 'queued',
    attempt: 1,
    code: 'task_created',
    message: '',
    providerStatus: '',
    requestId: '',
  }];
  return task;
}

export function transitionVideoTask(value, nextState, details = {}, options = {}) {
  const task = normalizeVideoTask(value);
  const next = QIANMU_VIDEO_TASK_STATES.includes(nextState) ? nextState : '';
  const allowed = next && (next === task.state || ALLOWED_TRANSITIONS[task.state].includes(next));
  if (!allowed || (QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(task.state) && next === task.state)) {
    return { ok: false, issue: `transition_not_allowed:${task.state}->${next || 'invalid'}`, task };
  }
  const patch = plain(details) ? details : {};
  const now = time(options.now, Date.now());
  const providerPatch = plain(patch.provider) ? patch.provider : {};
  const submissionPatch = plain(patch.submission) ? patch.submission : {};
  const progressPatch = plain(patch.progress) ? patch.progress : {};
  const resultPatch = plain(patch.result) ? patch.result : {};
  const failurePatch = plain(patch.failure) ? patch.failure : {};
  const budgetPatch = plain(patch.budget) ? patch.budget : {};
  const terminal = QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(next);
  const updated = normalizeVideoTask({
    ...task,
    state: next,
    provider: { ...task.provider, ...providerPatch },
    submission: {
      ...task.submission,
      ...submissionPatch,
      providerAccepted: submissionPatch.providerAccepted ?? submissionPatch.provider_accepted ?? task.submission.providerAccepted,
      acceptedAt: submissionPatch.acceptedAt || submissionPatch.accepted_at || task.submission.acceptedAt,
    },
    progress: { ...task.progress, ...progressPatch },
    result: { ...task.result, ...resultPatch },
    failure: { ...task.failure, ...failurePatch },
    budget: { ...task.budget, ...budgetPatch },
    timing: {
      ...task.timing,
      updatedAt: now,
      nextPollAt: terminal ? 0 : (patch.nextPollAt ?? patch.next_poll_at ?? task.timing.nextPollAt),
      cancelRequestedAt: next === 'cancel_requested' ? now : task.timing.cancelRequestedAt,
    },
    lease: terminal ? {} : task.lease,
  });
  updated.history = [...task.history, normalizeLogEntry({
    eventId: `event-${hash(`${task.taskId}|${task.attempt}|${next}|${now}|${task.history.length}`)}`,
    at: now,
    state: next,
    attempt: task.attempt,
    code: patch.code || `state_${next}`,
    message: patch.message || failurePatch.message || progressPatch.detail,
    providerStatus: providerPatch.lastStatus || providerPatch.last_status,
    requestId: submissionPatch.requestId || submissionPatch.request_id,
  }, task.history.length)].slice(-80);
  return { ok: true, issue: '', task: updated };
}

export function resumeVideoTask(value, context = {}, options = {}) {
  const task = normalizeVideoTask(value);
  const now = time(options.now, Date.now());
  const chatKey = text(context.chatKey || context.chat_key, 512);
  const workerId = text(context.workerId || context.worker_id, 200);
  if (task.owner.chatKey && chatKey !== task.owner.chatKey) return { action: 'skip', reason: 'owner_mismatch', task };
  if (task.timing.expiresAt && now >= task.timing.expiresAt && !QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(task.state)) {
    const expired = transitionVideoTask(task, 'expired', { code: 'task_expired' }, { now });
    return { action: 'none', reason: 'expired', task: expired.task };
  }
  if (task.lease.holder && task.lease.expiresAt > now && task.lease.holder !== workerId) {
    return { action: 'skip', reason: 'leased_by_another_worker', task };
  }
  if (QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(task.state)) {
    return { action: task.state === 'failed' && task.failure.retryable ? 'await_retry_confirmation' : 'none', reason: task.state, task };
  }
  if (task.state === 'cancel_requested') {
    return { action: task.provider.remoteTaskId ? 'cancel_provider' : 'finalize_cancel', reason: 'cancel_requested', task };
  }
  if (task.state === 'submitted' || task.state === 'polling') {
    return task.provider.remoteTaskId
      ? { action: 'poll', reason: 'remote_task_known', task }
      : { action: 'reconcile_submission', reason: 'remote_task_unknown', task };
  }
  return { action: 'prepare', reason: 'local_preparation_incomplete', task };
}

export function requestVideoTaskCancellation(value, options = {}) {
  const task = normalizeVideoTask(value);
  if (QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(task.state)) return { ok: false, issue: `task_already_${task.state}`, task };
  if (task.state === 'cancel_requested') return { ok: true, issue: '', task };
  return transitionVideoTask(task, 'cancel_requested', { code: 'cancel_requested_by_user' }, options);
}

export function beginVideoTaskRetry(value, options = {}) {
  const task = normalizeVideoTask(value);
  if (task.state !== 'failed') return { ok: false, issue: 'retry_requires_failed_task', task };
  if (!task.failure.retryable) return { ok: false, issue: 'failure_not_retryable', task };
  if (options.allowNewCharge !== true) return { ok: false, issue: 'retry_requires_charge_confirmation', task };
  if (task.attempt >= 99) return { ok: false, issue: 'retry_limit_reached', task };
  const now = time(options.now, Date.now());
  const attempt = task.attempt + 1;
  const retried = normalizeVideoTask({
    ...task,
    state: 'queued',
    attempt,
    provider: { ...task.provider, remoteTaskId: '', lastStatus: '' },
    submission: { idempotencyKey: idempotencyKey(task.taskId, attempt) },
    progress: { percent: 0, stage: '', detail: '' },
    result: {},
    failure: {},
    budget: { estimatedUnits: task.budget.estimatedUnits },
    timing: { ...task.timing, updatedAt: now, nextPollAt: 0, cancelRequestedAt: 0 },
    lease: {},
  });
  retried.history = [...task.history, normalizeLogEntry({
    eventId: `event-${hash(`${task.taskId}|retry|${attempt}|${now}`)}`,
    at: now,
    state: 'queued',
    attempt,
    code: 'retry_confirmed',
  }, task.history.length)].slice(-80);
  return { ok: true, issue: '', task: retried };
}

export function claimVideoTaskLease(value, workerId, options = {}) {
  const task = normalizeVideoTask(value);
  const holder = text(workerId, 200);
  const now = time(options.now, Date.now());
  const ttlMs = integer(options.ttlMs ?? options.ttl_ms, 1000, 120000, 15000);
  if (!holder) return { acquired: false, reason: 'worker_id_missing', task };
  if (QIANMU_VIDEO_TASK_TERMINAL_STATES.includes(task.state)) return { acquired: false, reason: 'task_terminal', task };
  if (task.lease.holder && task.lease.expiresAt > now && task.lease.holder !== holder) {
    return { acquired: false, reason: 'lease_held', task };
  }
  task.lease = { holder, expiresAt: now + ttlMs };
  return { acquired: true, reason: '', task };
}

export function releaseVideoTaskLease(value, workerId) {
  const task = normalizeVideoTask(value);
  const holder = text(workerId, 200);
  if (task.lease.holder && task.lease.holder !== holder) return { released: false, reason: 'lease_owner_mismatch', task };
  task.lease = { holder: '', expiresAt: 0 };
  return { released: true, reason: '', task };
}

export function videoTasksForChat(values = [], chatKey = '') {
  const ownerKey = text(chatKey, 512);
  return (Array.isArray(values) ? values : []).map(normalizeVideoTask).filter((task) => task.owner.chatKey === ownerKey);
}

export function validateVideoTask(value = {}) {
  const task = normalizeVideoTask(value);
  const issues = [];
  if (!task.taskId) issues.push('task_id_missing');
  if (!task.shotId) issues.push('shot_id_missing');
  if (!task.owner.chatKey) issues.push('owner_chat_missing');
  if (!task.submission.idempotencyKey) issues.push('idempotency_key_missing');
  if (['polling', 'succeeded'].includes(task.state) && !task.provider.remoteTaskId) issues.push('remote_task_id_missing');
  if (task.state === 'succeeded' && !task.result.recordId && !task.result.assetId) issues.push('result_reference_missing');
  return { ok: issues.length === 0, issues: [...new Set(issues)], task };
}
