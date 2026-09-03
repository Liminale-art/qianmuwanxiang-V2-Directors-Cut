// 千幕 MiniMax H3 客户端运行层。只连接同源网关，并把付费提交、轮询、归档与取消写回稳定合同。
import {
  normalizeVideoBudgetReservation,
  normalizeVideoCostQuote,
  reserveVideoBudget,
  settleVideoBudgetReservation,
} from './qianmu-video-budget.js';
import {
  claimVideoTaskLease,
  normalizeVideoTask,
  transitionVideoTask,
  validateVideoTask,
} from './qianmu-video-task.js';

export const QIANMU_VIDEO_RUNTIME_SCHEMA = 'qianmu.video-runtime.v1';
export const QIANMU_MINIMAX_H3_GATEWAY_BASE = '/api/plugins/qianmu-tts/video/minimax';

const MAX_GATEWAY_RESPONSE_CHARS = 3 * 1024 * 1024;
const CREATE_TIMEOUT_MS = 55_000;
const QUERY_TIMEOUT_MS = 25_000;
const AMBIGUOUS_CREATE_CODES = new Set([
  'gateway_outcome_unknown',
  'gateway_response_invalid',
  'gateway_response_unreadable',
  'submission_outcome_unknown',
  'task_id_missing',
  'upstream_response_invalid',
  'upstream_response_too_large',
  'upstream_response_unreadable',
]);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const time = (value, fallback = 0) => Math.max(0, Math.round(finite(value, fallback)));

function redact(value, max = 1200) {
  return text(value, max)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|token|key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_ -]?key|authorization|access[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function gatewayBase(value) {
  const source = String(value || QIANMU_MINIMAX_H3_GATEWAY_BASE).trim().replace(/\/+$/, '');
  if (!/^\/api\/plugins\/qianmu-tts(?:\/video\/minimax)?$/i.test(source) || /[?#]/.test(source)) {
    return QIANMU_MINIMAX_H3_GATEWAY_BASE;
  }
  return source.endsWith('/video/minimax') ? source : `${source}/video/minimax`;
}

function normalizedHeaders(value, includeJson = false) {
  const source = plain(value) ? value : {};
  const headers = {};
  for (const [key, raw] of Object.entries(source).slice(0, 32)) {
    const name = text(key, 120);
    const headerValue = text(raw, 4096);
    if (name && headerValue) headers[name] = headerValue;
  }
  if (includeJson && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

export class VideoRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(redact(message) || '视频服务请求失败');
    this.name = 'VideoRuntimeError';
    this.code = text(code, 160) || 'video_runtime_error';
    this.status = Math.max(0, Math.round(finite(options.status, 0)));
    this.retryable = Boolean(options.retryable);
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
    this.upstreamStatus = Math.max(0, Math.round(finite(options.upstreamStatus, 0)));
    this.requestId = text(options.requestId, 300);
    this.phase = text(options.phase, 80);
  }
}

function runtimeError(error, phase = '') {
  if (error instanceof VideoRuntimeError) return error;
  return new VideoRuntimeError(
    phase === 'create' ? 'gateway_outcome_unknown' : 'gateway_unreachable',
    phase === 'create' ? '视频提交结果未知，请勿直接重复提交' : '视频服务暂不可达',
    { phase, retryable: phase !== 'create', outcomeUnknown: phase === 'create' },
  );
}

export function videoRuntimeErrorPayload(error, phase = '') {
  const source = runtimeError(error, phase);
  return {
    schema: QIANMU_VIDEO_RUNTIME_SCHEMA,
    code: source.code,
    message: source.message,
    status: source.status,
    retryable: source.retryable,
    outcomeUnknown: source.outcomeUnknown,
    upstreamStatus: source.upstreamStatus,
    requestId: source.requestId,
    phase: source.phase,
  };
}

async function gatewayJson(route, payload, options = {}) {
  const phase = text(options.phase, 80) || 'query';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new VideoRuntimeError('fetch_unavailable', '当前环境不支持视频服务请求', { phase });
  const method = payload === undefined ? 'GET' : 'POST';
  let serializedBody;
  if (method === 'POST') {
    try { serializedBody = JSON.stringify(payload); }
    catch (_) {
      throw new VideoRuntimeError('request_not_serializable', '视频请求包含无法发送的数据', { phase });
    }
    if (typeof serializedBody !== 'string') throw new VideoRuntimeError('request_not_serializable', '视频请求包含无法发送的数据', { phase });
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutDefault = phase === 'create' ? CREATE_TIMEOUT_MS : QUERY_TIMEOUT_MS;
  const timeoutMs = Math.min(60_000, Math.max(1000, finite(options.timeoutMs, timeoutDefault)));
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(`${gatewayBase(options.gatewayBase)}/${route}`, {
      method,
      headers: normalizedHeaders(options.headers, method === 'POST'),
      ...(method === 'POST' ? { body: serializedBody } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (_) {
    throw new VideoRuntimeError(
      phase === 'create' ? 'gateway_outcome_unknown' : 'gateway_unreachable',
      phase === 'create' ? '视频提交结果未知，请勿直接重复提交' : '视频服务暂不可达',
      { phase, retryable: phase !== 'create', outcomeUnknown: phase === 'create' },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  let raw = '';
  const bodyTimer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try { raw = await response.text(); }
  catch (_) {
    throw new VideoRuntimeError('gateway_response_unreadable', '视频服务响应无法读取', {
      phase, status: response.status, retryable: phase !== 'create', outcomeUnknown: phase === 'create',
    });
  } finally {
    if (bodyTimer) clearTimeout(bodyTimer);
  }
  if (raw.length > MAX_GATEWAY_RESPONSE_CHARS) {
    throw new VideoRuntimeError('gateway_response_too_large', '视频服务响应异常过大', {
      phase, status: response.status, retryable: false, outcomeUnknown: phase === 'create',
    });
  }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch (_) {
    throw new VideoRuntimeError('gateway_response_invalid', '视频服务返回了无效数据', {
      phase, status: response.status, retryable: phase !== 'create', outcomeUnknown: phase === 'create',
    });
  }
  if (!response.ok || body?.ok !== true) {
    const hasStableError = plain(body) && typeof body.code === 'string' && body.code.trim();
    const code = hasStableError ? text(body.code, 160) : response.status === 404 ? 'gateway_missing' : 'gateway_request_failed';
    const ambiguous = phase === 'create' && (AMBIGUOUS_CREATE_CODES.has(code) || (!hasStableError && response.status >= 500));
    throw new VideoRuntimeError(code, body?.message || (response.status === 404 ? '未安装千幕增强服务' : `视频服务请求失败（${response.status}）`), {
      phase,
      status: response.status,
      retryable: ambiguous ? false : Boolean(body?.retryable),
      outcomeUnknown: ambiguous,
      upstreamStatus: body?.upstreamStatus,
      requestId: body?.requestId,
    });
  }
  return body;
}

function normalizeCreateResult(value = {}) {
  const raw = plain(value) ? value : {};
  const remoteTaskId = text(raw.remoteTaskId || raw.remote_task_id, 400);
  if (!remoteTaskId) throw new VideoRuntimeError('task_id_missing', '视频服务未返回任务 ID', { phase: 'create', outcomeUnknown: true });
  return {
    ok: true,
    remoteTaskId,
    requestId: text(raw.requestId || raw.request_id, 300),
    reused: Boolean(raw.reused),
  };
}

function normalizeQueryResult(value = {}) {
  const raw = plain(value) ? value : {};
  const state = ['submitted', 'polling', 'succeeded', 'failed', 'cancelled'].includes(raw.state) ? raw.state : 'polling';
  const resultRaw = plain(raw.result) ? raw.result : {};
  const usageRaw = plain(raw.usage) ? raw.usage : {};
  const downloadUrl = text(resultRaw.downloadUrl || resultRaw.download_url, 4096);
  if (state === 'succeeded' && !/^https:\/\//i.test(downloadUrl)) {
    throw new VideoRuntimeError('result_url_missing', '视频任务已完成，但没有可用的成片地址', { phase: 'query' });
  }
  return {
    ok: true,
    remoteTaskId: text(raw.remoteTaskId || raw.remote_task_id, 400),
    providerStatus: text(raw.providerStatus || raw.provider_status, 80),
    recognizedStatus: Boolean(raw.recognizedStatus ?? raw.recognized_status),
    state,
    retryable: Boolean(raw.retryable),
    error: redact(raw.error),
    result: {
      downloadUrl,
      resolution: text(resultRaw.resolution, 40),
      durationSeconds: Math.max(0, finite(resultRaw.durationSeconds || resultRaw.duration_seconds, 0)),
      ratio: text(resultRaw.ratio, 40),
      taskType: text(resultRaw.taskType || resultRaw.task_type, 80),
      modality: text(resultRaw.modality, 80),
    },
    usage: {
      totalSeconds: Math.max(0, finite(usageRaw.totalSeconds || usageRaw.total_seconds, 0)),
      inputSeconds: Math.max(0, finite(usageRaw.inputSeconds || usageRaw.input_seconds, 0)),
      outputSeconds: Math.max(0, finite(usageRaw.outputSeconds || usageRaw.output_seconds, 0)),
      inputImageCount: Math.max(0, Math.round(finite(usageRaw.inputImageCount || usageRaw.input_image_count, 0))),
      inputAudioSeconds: Math.max(0, finite(usageRaw.inputAudioSeconds || usageRaw.input_audio_seconds, 0)),
      totalTokens: Math.max(0, Math.round(finite(usageRaw.totalTokens || usageRaw.total_tokens, 0))),
    },
  };
}

export async function fetchMiniMaxH3Capabilities(options = {}) {
  const raw = await gatewayJson('capabilities', undefined, { ...options, phase: 'capabilities' });
  return {
    ok: true,
    provider: text(raw.provider, 120),
    model: text(raw.model, 200),
    modes: Array.isArray(raw.modes) ? raw.modes.map((item) => text(item, 40)).filter(Boolean).slice(0, 12) : [],
    resolutions: Array.isArray(raw.resolutions) ? raw.resolutions.map((item) => text(item, 40)).filter(Boolean).slice(0, 8) : [],
    duration: plain(raw.duration) ? {
      min: Math.max(0, finite(raw.duration.min, 0)),
      max: Math.max(0, finite(raw.duration.max, 0)),
      integer: Boolean(raw.duration.integer),
    } : { min: 0, max: 0, integer: false },
    transport: text(raw.transport, 80),
    browserDirect: Boolean(raw.browserDirect),
    keyType: text(raw.keyType, 80),
  };
}

export async function submitMiniMaxH3Gateway(payload, options = {}) {
  return normalizeCreateResult(await gatewayJson('create', payload, { ...options, phase: 'create' }));
}

export async function queryMiniMaxH3Gateway(payload, options = {}) {
  return normalizeQueryResult(await gatewayJson('query', payload, { ...options, phase: 'query' }));
}

export async function cancelMiniMaxH3Gateway(payload, options = {}) {
  const raw = await gatewayJson('cancel', payload, { ...options, phase: 'cancel' });
  if (text(raw.action, 80) !== 'cancelled' || text(raw.providerStatus || raw.provider_status, 80) !== 'cancelled') {
    throw new VideoRuntimeError('cancel_not_confirmed', '视频服务未确认取消排队任务', { phase: 'cancel' });
  }
  return {
    ok: true,
    remoteTaskId: text(raw.remoteTaskId || raw.remote_task_id, 400),
    action: 'cancelled',
    providerStatus: 'cancelled',
  };
}

function transition(task, nextState, details, now) {
  const result = transitionVideoTask(task, nextState, details, { now });
  if (!result.ok) throw new VideoRuntimeError('task_transition_invalid', result.issue, { phase: 'state' });
  return result.task;
}

function claimRuntimeLease(task, options, now) {
  const claimed = claimVideoTaskLease(task, options.workerId || options.worker_id, {
    now,
    ttlMs: options.leaseTtlMs || options.lease_ttl_ms,
  });
  return claimed.acquired
    ? { ok: true, issue: '', task: claimed.task }
    : { ok: false, issue: claimed.reason || 'task_lease_unavailable', task: claimed.task };
}

function normalizeReservations(value) {
  return (Array.isArray(value) ? value : []).map(normalizeVideoBudgetReservation);
}

function settlement(values, reservationId, next, now) {
  if (!reservationId) return { ok: true, reservations: normalizeReservations(values), reservation: null };
  return settleVideoBudgetReservation(values, reservationId, next, { now });
}

async function checkpoint(writer, task, reservations, reason) {
  if (typeof writer !== 'function') throw new VideoRuntimeError('checkpoint_writer_missing', '缺少视频任务持久化接口', { phase: 'checkpoint' });
  await writer({
    schema: QIANMU_VIDEO_RUNTIME_SCHEMA,
    reason: text(reason, 120),
    task: normalizeVideoTask(task),
    reservations: normalizeReservations(reservations),
  });
}

function safeCheckpointError(error) {
  return videoRuntimeErrorPayload(
    error instanceof VideoRuntimeError
      ? error
      : new VideoRuntimeError('checkpoint_failed', '视频任务状态保存失败', { phase: 'checkpoint', retryable: true }),
  );
}

function taskBudgetPatch(reservation, nextSettlement, now) {
  return {
    reservationId: reservation?.reservationId || '',
    estimatedUnits: reservation?.units || 0,
    settlement: nextSettlement,
    settledAt: nextSettlement === 'reserved' ? 0 : now,
  };
}

export async function submitMiniMaxH3VideoTask(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  const originalTask = normalizeVideoTask(raw.task);
  const originalReservations = normalizeReservations(raw.reservations);
  const now = time(options.now, Date.now());
  if (!['queued', 'preparing'].includes(originalTask.state)) {
    return { ok: false, action: 'blocked', issue: `submission_requires_queued_task:${originalTask.state}`, task: originalTask, reservations: originalReservations };
  }
  if (typeof options.persistCheckpoint !== 'function') {
    return { ok: false, action: 'blocked', issue: 'checkpoint_writer_missing', task: originalTask, reservations: originalReservations };
  }
  const taskValidation = validateVideoTask(originalTask);
  if (!taskValidation.ok) {
    return { ok: false, action: 'blocked', issue: taskValidation.issues[0], issues: taskValidation.issues, task: originalTask, reservations: originalReservations };
  }
  if (originalTask.provider.channel && originalTask.provider.channel !== 'minimax-h3') {
    return { ok: false, action: 'blocked', issue: 'task_provider_mismatch', task: originalTask, reservations: originalReservations };
  }
  const connectionId = text(raw.connection?.connectionId || raw.connection?.connection_id, 200);
  if (originalTask.provider.connectionId && connectionId && originalTask.provider.connectionId !== connectionId) {
    return { ok: false, action: 'blocked', issue: 'task_connection_mismatch', task: originalTask, reservations: originalReservations };
  }
  const normalizedQuote = normalizeVideoCostQuote(raw.quote);
  if (normalizedQuote.provider !== 'minimax-h3') {
    return { ok: false, action: 'blocked', issue: 'quote_provider_mismatch', task: originalTask, reservations: originalReservations };
  }
  if (normalizedQuote.model && normalizedQuote.model !== 'MiniMax-H3') {
    return { ok: false, action: 'blocked', issue: 'quote_model_mismatch', task: originalTask, reservations: originalReservations };
  }
  if (raw.materialRightsConfirmed !== true && raw.material_rights_confirmed !== true) {
    return { ok: false, action: 'blocked', issue: 'material_rights_confirmation_required', task: originalTask, reservations: originalReservations };
  }
  if (raw.h3LicenseConfirmed !== true && raw.h3_license_confirmed !== true) {
    return { ok: false, action: 'blocked', issue: 'h3_license_confirmation_required', task: originalTask, reservations: originalReservations };
  }
  const lease = claimRuntimeLease(originalTask, options, now);
  if (!lease.ok) return { ok: false, action: 'blocked', issue: lease.issue, task: lease.task, reservations: originalReservations };
  const spec = plain(raw.spec) ? raw.spec : {};
  const budgetRequest = {
    taskId: originalTask.taskId,
    attempt: originalTask.attempt,
    chatKey: originalTask.owner.chatKey,
    automatic: Boolean(raw.automatic),
    durationSeconds: spec.durationSeconds || spec.duration_seconds,
    resolution: spec.resolution,
    costConfirmed: Boolean(raw.costConfirmed ?? raw.cost_confirmed),
    highResolutionConfirmed: Boolean(raw.highResolutionConfirmed ?? raw.high_resolution_confirmed),
  };
  const reserved = reserveVideoBudget(budgetRequest, normalizedQuote, originalReservations, raw.budgetPolicy || raw.budget_policy, { now });
  if (!reserved.ok) {
    return { ok: false, action: 'blocked', issue: reserved.issue, task: originalTask, reservations: originalReservations, evaluation: reserved.evaluation };
  }
  if (reserved.reservation.settlement !== 'reserved') {
    return { ok: false, action: 'reconcile_budget', issue: `reservation_already_${reserved.reservation.settlement}`, task: originalTask, reservations: reserved.reservations };
  }

  let task = lease.task.state === 'queued'
    ? transition(lease.task, 'preparing', { code: 'video_prepare_started' }, now)
    : lease.task;
  task = transition(task, 'preparing', {
    code: 'video_budget_reserved',
    budget: taskBudgetPatch(reserved.reservation, 'reserved', now),
    progress: { percent: 5, stage: 'preparing' },
  }, now);
  try {
    await checkpoint(options.persistCheckpoint, task, reserved.reservations, 'before_submission');
  } catch (error) {
    const released = settlement(reserved.reservations, reserved.reservation.reservationId, 'released', now);
    return {
      ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_before_submission', task: originalTask,
      reservations: released.reservations, error: safeCheckpointError(error),
    };
  }

  const preparedTask = task;
  task = transition(task, 'submitted', {
    code: 'video_submission_marked',
    provider: { channel: 'minimax-h3', connectionId },
    submission: { providerAccepted: false },
    progress: { percent: 10, stage: 'submitting' },
  }, now);
  try {
    await checkpoint(options.persistCheckpoint, task, reserved.reservations, 'submission_may_start');
  } catch (error) {
    return {
      ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_before_network', task: preparedTask,
      reservations: reserved.reservations, error: safeCheckpointError(error),
    };
  }

  let gateway;
  try {
    gateway = await submitMiniMaxH3Gateway({
      apiKey: raw.apiKey || raw.api_key,
      idempotencyKey: task.submission.idempotencyKey,
      spec: raw.spec,
      manifest: raw.manifest,
      prompt: raw.prompt,
      mediaInputs: raw.mediaInputs || raw.media_inputs,
      connection: raw.connection,
    }, options);
  } catch (error) {
    const failure = runtimeError(error, 'create');
    const unknown = failure.outcomeUnknown || AMBIGUOUS_CREATE_CODES.has(failure.code);
    const settled = settlement(reserved.reservations, reserved.reservation.reservationId, unknown ? 'unknown' : 'released', now);
    task = transition(task, unknown ? 'submitted' : 'failed', {
      code: failure.code,
      message: failure.message,
      failure: { code: failure.code, message: failure.message, retryable: unknown ? false : failure.retryable, chargeState: unknown ? 'unknown' : 'not_charged' },
      budget: taskBudgetPatch(settled.reservation || reserved.reservation, unknown ? 'unknown' : 'released', now),
      submission: { requestId: failure.requestId },
      nextPollAt: 0,
    }, now);
    let checkpointError = null;
    try { await checkpoint(options.persistCheckpoint, task, settled.reservations, 'submission_failed'); }
    catch (persistError) { checkpointError = safeCheckpointError(persistError); }
    return {
      ok: false,
      action: unknown ? 'reconcile_submission' : 'failed',
      issue: failure.code,
      task,
      reservations: settled.reservations,
      error: videoRuntimeErrorPayload(failure),
      ...(checkpointError ? { checkpointError } : {}),
    };
  }

  task = transition(task, 'submitted', {
    code: gateway.reused ? 'video_submission_recovered' : 'video_submission_accepted',
    provider: { channel: 'minimax-h3', remoteTaskId: gateway.remoteTaskId, lastStatus: 'queued' },
    submission: { providerAccepted: true, acceptedAt: now, requestId: gateway.requestId },
    progress: { percent: 15, stage: 'queued' },
    nextPollAt: now + 10_000,
  }, now);
  try {
    await checkpoint(options.persistCheckpoint, task, reserved.reservations, 'submission_accepted');
  } catch (error) {
    return {
      ok: false, action: 'accepted_checkpoint_failed', issue: 'checkpoint_failed_after_acceptance', accepted: true,
      task, reservations: reserved.reservations, gateway, error: safeCheckpointError(error),
    };
  }
  return { ok: true, action: 'submitted', issue: '', task, reservations: reserved.reservations, gateway };
}

async function archiveSucceededTask(taskValue, provider, reservations, options = {}) {
  let task = normalizeVideoTask(taskValue);
  const now = time(options.now, Date.now());
  if (typeof options.storeResult !== 'function') {
    return { ok: true, action: 'await_result_archive', issue: '', task, reservations, provider };
  }
  let reference;
  try {
    reference = await options.storeResult({
      idempotencyKey: `qianmu-video-result-${task.taskId}-attempt-${task.attempt}`,
      taskId: task.taskId,
      draftId: task.draftId,
      sourceRecordId: task.sourceRecordId,
      shotId: task.shotId,
      attempt: task.attempt,
      manifestId: task.manifestId,
      budgetReservationId: task.budget.reservationId,
      versionRootId: task.taskId,
      owner: { ...task.owner },
      remoteTaskId: task.provider.remoteTaskId || provider.remoteTaskId,
      downloadUrl: provider.result.downloadUrl,
      result: { ...provider.result },
      usage: { ...provider.usage },
    });
  } catch (_) {
    return {
      ok: false, action: 'result_archive_failed', issue: 'result_archive_failed', task, reservations, provider,
      error: videoRuntimeErrorPayload(new VideoRuntimeError('result_archive_failed', '视频成片保存失败', { phase: 'archive', retryable: true })),
    };
  }
  const recordId = text(reference?.recordId || reference?.record_id, 200);
  const assetId = text(reference?.assetId || reference?.asset_id, 200);
  if (!recordId && !assetId) {
    return {
      ok: false, action: 'result_archive_failed', issue: 'result_reference_missing', task, reservations, provider,
      error: videoRuntimeErrorPayload(new VideoRuntimeError('result_reference_missing', '视频成片未返回稳定记录', { phase: 'archive' })),
    };
  }
  task = transition(task, 'succeeded', {
    code: 'video_result_archived',
    provider: { lastStatus: 'succeeded' },
    result: {
      recordId,
      assetId,
      durationSeconds: provider.result.durationSeconds,
      resolution: provider.result.resolution,
    },
    progress: { percent: 100, stage: 'succeeded' },
  }, now);
  try {
    await checkpoint(options.persistCheckpoint, task, reservations, 'result_archived');
  } catch (error) {
    return {
      ok: false, action: 'result_checkpoint_failed', issue: 'checkpoint_failed_after_archive', archived: true,
      task, reservations, provider, error: safeCheckpointError(error),
    };
  }
  return { ok: true, action: 'succeeded', issue: '', task, reservations, provider };
}

function settleForProviderState(task, reservations, provider, now) {
  const reservationId = task.budget.reservationId;
  if (!reservationId) return { task, reservations: normalizeReservations(reservations) };
  const providerState = provider?.state;
  const confirmedRunning = providerState === 'polling'
    && provider?.recognizedStatus === true
    && provider?.providerStatus === 'running';
  const next = confirmedRunning || providerState === 'succeeded'
    ? 'committed'
    : providerState === 'failed'
      ? 'unknown'
      : providerState === 'cancelled'
        ? task.state === 'cancel_requested' ? 'released' : 'unknown'
        : '';
  if (!next || task.budget.settlement === next || (task.budget.settlement === 'committed' && next !== 'committed')) {
    return { task, reservations: normalizeReservations(reservations) };
  }
  const result = settlement(reservations, reservationId, next, now);
  if (!result.ok) return { task, reservations: normalizeReservations(reservations) };
  task.budget = taskBudgetPatch(result.reservation, next, now);
  return { task: normalizeVideoTask(task), reservations: result.reservations };
}

async function applyQueryResult(taskValue, provider, reservationsValue, options = {}) {
  let task = normalizeVideoTask(taskValue);
  let reservations = normalizeReservations(reservationsValue);
  const now = time(options.now, Date.now());
  const settled = settleForProviderState(task, reservations, provider, now);
  task = settled.task;
  reservations = settled.reservations;
  if (provider.state === 'succeeded') {
    const currentState = task.state === 'cancel_requested' ? 'cancel_requested' : 'polling';
    task = transition(task, currentState, {
      code: 'video_result_ready',
      provider: { remoteTaskId: provider.remoteTaskId || task.provider.remoteTaskId, lastStatus: provider.providerStatus || 'succeeded' },
      progress: { percent: 99, stage: 'awaiting_archive' },
      budget: task.budget,
      nextPollAt: 0,
    }, now);
    try { await checkpoint(options.persistCheckpoint, task, reservations, 'result_ready'); }
    catch (error) {
      return { ok: false, action: 'result_checkpoint_failed', issue: 'checkpoint_failed_before_archive', task, reservations, provider, error: safeCheckpointError(error) };
    }
    return archiveSucceededTask(task, provider, reservations, options);
  }
  if (provider.state === 'failed') {
    task = transition(task, 'failed', {
      code: 'provider_task_failed',
      message: provider.error || 'MiniMax H3 生成失败',
      provider: { lastStatus: provider.providerStatus || 'failed' },
      failure: { code: 'provider_task_failed', message: provider.error, retryable: provider.retryable, chargeState: 'unknown' },
      budget: task.budget,
    }, now);
  } else if (provider.state === 'cancelled') {
    task = transition(task, 'cancelled', {
      code: 'provider_task_cancelled', provider: { lastStatus: provider.providerStatus || 'cancelled' }, budget: task.budget,
    }, now);
  } else {
    const nextState = task.state === 'submitted' && provider.state === 'submitted' ? 'submitted' : 'polling';
    task = transition(task, nextState, {
      code: provider.recognizedStatus ? `provider_${provider.providerStatus || provider.state}` : 'provider_status_unknown',
      provider: { remoteTaskId: provider.remoteTaskId || task.provider.remoteTaskId, lastStatus: provider.providerStatus },
      progress: { percent: provider.state === 'polling' ? Math.max(20, task.progress.percent) : task.progress.percent, stage: provider.providerStatus || provider.state },
      budget: task.budget,
      nextPollAt: now + 10_000,
    }, now);
  }
  try { await checkpoint(options.persistCheckpoint, task, reservations, `provider_${provider.state}`); }
  catch (error) {
    return { ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_after_query', task, reservations, provider, error: safeCheckpointError(error) };
  }
  return { ok: true, action: task.state, issue: '', task, reservations, provider };
}

export async function pollMiniMaxH3VideoTask(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  let task = normalizeVideoTask(raw.task);
  const reservations = normalizeReservations(raw.reservations);
  if (typeof options.persistCheckpoint !== 'function') {
    return { ok: false, action: 'blocked', issue: 'checkpoint_writer_missing', task, reservations };
  }
  if (task.state === 'cancel_requested') return reconcileMiniMaxH3Cancellation(raw, options);
  if (!['submitted', 'polling'].includes(task.state) || !task.provider.remoteTaskId) {
    return { ok: false, action: 'blocked', issue: 'poll_requires_remote_task', task, reservations };
  }
  const lease = claimRuntimeLease(task, options, time(options.now, Date.now()));
  if (!lease.ok) return { ok: false, action: 'blocked', issue: lease.issue, task: lease.task, reservations };
  task = lease.task;
  try { await checkpoint(options.persistCheckpoint, task, reservations, 'before_query'); }
  catch (error) {
    return { ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_before_query', task, reservations, error: safeCheckpointError(error) };
  }
  let provider;
  try {
    provider = await queryMiniMaxH3Gateway({
      apiKey: raw.apiKey || raw.api_key,
      taskId: task.provider.remoteTaskId,
      connection: raw.connection,
    }, options);
  } catch (error) {
    const failure = runtimeError(error, 'query');
    const now = time(options.now, Date.now());
    const nextState = task.state;
    const updated = transition(task, nextState, {
      code: failure.code,
      message: failure.message,
      progress: { ...task.progress, detail: failure.message },
      nextPollAt: failure.retryable ? now + 10_000 : 0,
    }, now);
    let checkpointError = null;
    try { await checkpoint(options.persistCheckpoint, updated, reservations, 'query_failed'); }
    catch (persistError) { checkpointError = safeCheckpointError(persistError); }
    return {
      ok: false, action: failure.retryable ? 'poll_later' : 'needs_user', issue: failure.code,
      task: updated, reservations, error: videoRuntimeErrorPayload(failure), ...(checkpointError ? { checkpointError } : {}),
    };
  }
  return applyQueryResult(task, provider, reservations, options);
}

export async function reconcileMiniMaxH3Cancellation(value = {}, options = {}) {
  const raw = plain(value) ? value : {};
  let task = normalizeVideoTask(raw.task);
  let reservations = normalizeReservations(raw.reservations);
  const now = time(options.now, Date.now());
  if (typeof options.persistCheckpoint !== 'function') {
    return { ok: false, action: 'blocked', issue: 'checkpoint_writer_missing', task, reservations };
  }
  if (task.state !== 'cancel_requested') {
    return { ok: false, action: 'blocked', issue: 'cancellation_not_requested', task, reservations };
  }
  const lease = claimRuntimeLease(task, options, now);
  if (!lease.ok) return { ok: false, action: 'blocked', issue: lease.issue, task: lease.task, reservations };
  task = lease.task;
  if (!task.provider.remoteTaskId) {
    const released = settlement(reservations, task.budget.reservationId, 'released', now);
    if (released.ok) {
      reservations = released.reservations;
      task.budget = taskBudgetPatch(released.reservation, 'released', now);
    }
    task = transition(task, 'cancelled', { code: 'local_video_cancelled' }, now);
    try { await checkpoint(options.persistCheckpoint, task, reservations, 'local_cancelled'); }
    catch (error) { return { ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_after_cancel', task, reservations, error: safeCheckpointError(error) }; }
    return { ok: true, action: 'cancelled', issue: '', task, reservations };
  }

  try { await checkpoint(options.persistCheckpoint, task, reservations, 'before_cancel_reconcile'); }
  catch (error) {
    return { ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_before_cancel_query', task, reservations, error: safeCheckpointError(error) };
  }

  let provider;
  try {
    provider = await queryMiniMaxH3Gateway({ apiKey: raw.apiKey || raw.api_key, taskId: task.provider.remoteTaskId, connection: raw.connection }, options);
  } catch (error) {
    const failure = runtimeError(error, 'query');
    task = transition(task, 'cancel_requested', {
      code: failure.code, message: failure.message, nextPollAt: failure.retryable ? now + 10_000 : 0,
    }, now);
    let checkpointError = null;
    try { await checkpoint(options.persistCheckpoint, task, reservations, 'cancel_query_failed'); }
    catch (persistError) { checkpointError = safeCheckpointError(persistError); }
    return {
      ok: false, action: failure.retryable ? 'poll_later' : 'needs_user', issue: failure.code,
      task, reservations, error: videoRuntimeErrorPayload(failure), ...(checkpointError ? { checkpointError } : {}),
    };
  }
  if (['succeeded', 'failed', 'cancelled'].includes(provider.state)) {
    return applyQueryResult(task, provider, reservations, options);
  }
  if (provider.providerStatus !== 'queued') {
    const settled = settleForProviderState(task, reservations, provider, now);
    task = settled.task;
    reservations = settled.reservations;
    task = transition(task, 'cancel_requested', {
      code: provider.providerStatus === 'running' ? 'running_task_cannot_cancel' : 'provider_status_unknown',
      provider: { lastStatus: provider.providerStatus },
      progress: { ...task.progress, stage: 'cancel_waiting_terminal' },
      nextPollAt: now + 10_000,
    }, now);
    try { await checkpoint(options.persistCheckpoint, task, reservations, 'cancel_waiting_terminal'); }
    catch (error) { return { ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_while_waiting_cancel', task, reservations, provider, error: safeCheckpointError(error) }; }
    return { ok: true, action: 'wait_terminal', issue: '', task, reservations, provider };
  }

  try {
    await cancelMiniMaxH3Gateway({
      apiKey: raw.apiKey || raw.api_key,
      taskId: task.provider.remoteTaskId,
      providerStatus: 'queued',
      connection: raw.connection,
    }, options);
  } catch (error) {
    const failure = runtimeError(error, 'cancel');
    task = transition(task, 'cancel_requested', {
      code: failure.code, message: failure.message, nextPollAt: now + 10_000,
    }, now);
    let checkpointError = null;
    try { await checkpoint(options.persistCheckpoint, task, reservations, 'cancel_failed'); }
    catch (persistError) { checkpointError = safeCheckpointError(persistError); }
    return {
      ok: false, action: 'poll_later', issue: failure.code, task, reservations,
      error: videoRuntimeErrorPayload(failure), ...(checkpointError ? { checkpointError } : {}),
    };
  }
  const released = settlement(reservations, task.budget.reservationId, 'released', now);
  if (released.ok) {
    reservations = released.reservations;
    task.budget = taskBudgetPatch(released.reservation, 'released', now);
  }
  task = transition(task, 'cancelled', {
    code: 'queued_video_cancelled', provider: { lastStatus: 'cancelled' }, budget: task.budget,
  }, now);
  try { await checkpoint(options.persistCheckpoint, task, reservations, 'provider_cancelled'); }
  catch (error) { return { ok: false, action: 'checkpoint_failed', issue: 'checkpoint_failed_after_cancel', task, reservations, error: safeCheckpointError(error) }; }
  return { ok: true, action: 'cancelled', issue: '', task, reservations };
}
