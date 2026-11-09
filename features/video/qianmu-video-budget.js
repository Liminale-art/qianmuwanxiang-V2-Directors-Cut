// 千幕视频费用闸门。纯数据层：价格由渠道报价提供，本模块不写死厂商费率。
export const QIANMU_VIDEO_BUDGET_POLICY_SCHEMA = 'qianmu.video-budget-policy.v1';
export const QIANMU_VIDEO_COST_QUOTE_SCHEMA = 'qianmu.video-cost-quote.v1';
export const QIANMU_VIDEO_BUDGET_RESERVATION_SCHEMA = 'qianmu.video-budget-reservation.v1';

const SETTLEMENTS = Object.freeze(['reserved', 'committed', 'released', 'unknown']);
const ACTIVE_SETTLEMENTS = new Set(['reserved', 'committed', 'unknown']);
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const amount = (value, fallback = 0) => Math.max(0, finite(value, fallback));
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

export function normalizeVideoBudgetPolicy(value = {}) {
  const raw = plain(value) ? value : {};
  const autoRaw = plain(raw.automatic) ? raw.automatic : {};
  const manualRaw = plain(raw.manual) ? raw.manual : {};
  return {
    schema: QIANMU_VIDEO_BUDGET_POLICY_SCHEMA,
    unit: text(raw.unit, 40) || 'provider_units',
    timezoneOffsetMinutes: integer(raw.timezoneOffsetMinutes ?? raw.timezone_offset_minutes, -720, 840, 0),
    totalDailyLimitUnits: amount(raw.totalDailyLimitUnits ?? raw.total_daily_limit_units),
    automatic: {
      enabled: Boolean(autoRaw.enabled),
      maxPerTaskUnits: amount(autoRaw.maxPerTaskUnits ?? autoRaw.max_per_task_units),
      dailyLimitUnits: amount(autoRaw.dailyLimitUnits ?? autoRaw.daily_limit_units),
      perChatDailyLimitUnits: amount(autoRaw.perChatDailyLimitUnits ?? autoRaw.per_chat_daily_limit_units),
      maxDurationSeconds: integer(autoRaw.maxDurationSeconds ?? autoRaw.max_duration_seconds, 4, 15, 8),
    },
    manual: {
      requireCostConfirmation: manualRaw.requireCostConfirmation !== false,
    },
    highResolution: {
      requireExplicitConfirmation: raw.highResolution?.requireExplicitConfirmation !== false,
    },
  };
}

export function normalizeVideoCostQuote(value = {}) {
  const raw = plain(value) ? value : {};
  const inputRaw = plain(raw.input) ? raw.input : {};
  const estimatedUnits = amount(raw.estimatedUnits ?? raw.estimated_units);
  return {
    schema: QIANMU_VIDEO_COST_QUOTE_SCHEMA,
    quoteId: text(raw.quoteId || raw.quote_id, 200),
    provider: text(raw.provider, 120),
    model: text(raw.model, 200),
    unit: text(raw.unit, 40) || 'provider_units',
    estimatedUnits,
    maximumUnits: Math.max(estimatedUnits, amount(raw.maximumUnits ?? raw.maximum_units, estimatedUnits)),
    displayLabel: text(raw.displayLabel || raw.display_label, 160),
    createdAt: time(raw.createdAt || raw.created_at),
    expiresAt: time(raw.expiresAt || raw.expires_at),
    input: {
      durationSeconds: amount(inputRaw.durationSeconds ?? inputRaw.duration_seconds),
      resolution: text(inputRaw.resolution, 40).toLowerCase(),
      count: integer(inputRaw.count, 1, 16, 1),
      includesAudio: Boolean(inputRaw.includesAudio ?? inputRaw.includes_audio),
    },
  };
}

export function videoBudgetDayKey(timestamp, timezoneOffsetMinutes = 0) {
  const shifted = time(timestamp) + integer(timezoneOffsetMinutes, -720, 840, 0) * 60_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

export function normalizeVideoBudgetReservation(value = {}) {
  const raw = plain(value) ? value : {};
  const settlement = SETTLEMENTS.includes(raw.settlement) ? raw.settlement : 'reserved';
  const attempt = integer(raw.attempt, 1, 99, 1);
  const taskId = text(raw.taskId || raw.task_id, 200);
  const createdAt = time(raw.createdAt || raw.created_at);
  return {
    schema: QIANMU_VIDEO_BUDGET_RESERVATION_SCHEMA,
    reservationId: text(raw.reservationId || raw.reservation_id, 200) || `video-budget-${hash(`${taskId}|${attempt}`)}`,
    taskId,
    attempt,
    chatKey: text(raw.chatKey || raw.chat_key, 512),
    quoteId: text(raw.quoteId || raw.quote_id, 200),
    unit: text(raw.unit, 40) || 'provider_units',
    units: amount(raw.units),
    automatic: Boolean(raw.automatic),
    resolution: text(raw.resolution, 40).toLowerCase(),
    dayKey: text(raw.dayKey || raw.day_key, 20),
    settlement,
    createdAt,
    settledAt: time(raw.settledAt || raw.settled_at),
  };
}

function normalizeRequest(value = {}) {
  const raw = plain(value) ? value : {};
  return {
    taskId: text(raw.taskId || raw.task_id, 200),
    attempt: integer(raw.attempt, 1, 99, 1),
    chatKey: text(raw.chatKey || raw.chat_key, 512),
    automatic: Boolean(raw.automatic),
    durationSeconds: amount(raw.durationSeconds ?? raw.duration_seconds),
    resolution: text(raw.resolution, 40).toLowerCase() || '768p',
    costConfirmed: Boolean(raw.costConfirmed ?? raw.cost_confirmed),
    highResolutionConfirmed: Boolean(raw.highResolutionConfirmed ?? raw.high_resolution_confirmed),
  };
}

function activeReservations(values, policy, now) {
  const dayKey = videoBudgetDayKey(now, policy.timezoneOffsetMinutes);
  return (Array.isArray(values) ? values : [])
    .map(normalizeVideoBudgetReservation)
    .filter((item) => item.dayKey === dayKey && item.unit === policy.unit && ACTIVE_SETTLEMENTS.has(item.settlement));
}

export function summarizeVideoBudget(values = [], policyValue = {}, options = {}) {
  const policy = normalizeVideoBudgetPolicy(policyValue);
  const now = time(options.now, Date.now());
  const active = activeReservations(values, policy, now);
  const byChat = {};
  const automaticByChat = {};
  let totalUnits = 0;
  let automaticUnits = 0;
  for (const item of active) {
    totalUnits += item.units;
    if (item.automatic) {
      automaticUnits += item.units;
      automaticByChat[item.chatKey] = amount(automaticByChat[item.chatKey]) + item.units;
    }
    byChat[item.chatKey] = amount(byChat[item.chatKey]) + item.units;
  }
  return {
    dayKey: videoBudgetDayKey(now, policy.timezoneOffsetMinutes),
    unit: policy.unit,
    totalUnits,
    automaticUnits,
    byChat,
    automaticByChat,
    reservations: active.length,
  };
}

export function evaluateVideoBudget(requestValue = {}, quoteValue = {}, reservations = [], policyValue = {}, options = {}) {
  const request = normalizeRequest(requestValue);
  const quote = normalizeVideoCostQuote(quoteValue);
  const policy = normalizeVideoBudgetPolicy(policyValue);
  const now = time(options.now, Date.now());
  const issues = [];
  const warnings = [];
  if (!request.taskId) issues.push('task_id_missing');
  if (!request.chatKey) issues.push('chat_key_missing');
  if (!quote.quoteId) issues.push('cost_quote_missing');
  if (quote.unit !== policy.unit) issues.push('budget_unit_mismatch');
  if (quote.expiresAt && now >= quote.expiresAt) issues.push('cost_quote_expired');
  if (quote.input.durationSeconds && Math.abs(quote.input.durationSeconds - request.durationSeconds) > 0.001) issues.push('quote_duration_mismatch');
  if (quote.input.resolution && quote.input.resolution !== request.resolution) issues.push('quote_resolution_mismatch');
  if (request.resolution === '2k' && policy.highResolution.requireExplicitConfirmation && !request.highResolutionConfirmed) {
    issues.push('high_resolution_confirmation_required');
  }
  if (!request.automatic && policy.manual.requireCostConfirmation && quote.maximumUnits > 0 && !request.costConfirmed) {
    issues.push('cost_confirmation_required');
  }

  const usage = summarizeVideoBudget(reservations, policy, { now });
  const projectedTotal = usage.totalUnits + quote.maximumUnits;
  const projectedAutomatic = usage.automaticUnits + quote.maximumUnits;
  const projectedChat = amount(usage.automaticByChat[request.chatKey]) + quote.maximumUnits;
  if (policy.totalDailyLimitUnits > 0 && projectedTotal > policy.totalDailyLimitUnits) issues.push('total_daily_budget_exceeded');
  if (request.automatic) {
    if (!policy.automatic.enabled) issues.push('automatic_video_disabled');
    if (request.durationSeconds > policy.automatic.maxDurationSeconds) issues.push('automatic_duration_exceeded');
    if (policy.automatic.maxPerTaskUnits <= 0 || quote.maximumUnits > policy.automatic.maxPerTaskUnits) issues.push('automatic_task_budget_exceeded');
    if (policy.automatic.dailyLimitUnits <= 0 || projectedAutomatic > policy.automatic.dailyLimitUnits) issues.push('automatic_daily_budget_exceeded');
    if (policy.automatic.perChatDailyLimitUnits <= 0 || projectedChat > policy.automatic.perChatDailyLimitUnits) issues.push('automatic_chat_budget_exceeded');
  }
  if (quote.maximumUnits > quote.estimatedUnits) warnings.push('cost_quote_uses_maximum_reservation');
  return {
    allowed: issues.length === 0,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
    request,
    quote,
    policy,
    usage,
    reservationUnits: quote.maximumUnits,
    projected: { totalUnits: projectedTotal, automaticUnits: projectedAutomatic, chatUnits: projectedChat },
  };
}

export function reserveVideoBudget(requestValue = {}, quoteValue = {}, reservations = [], policyValue = {}, options = {}) {
  const request = normalizeRequest(requestValue);
  const existing = (Array.isArray(reservations) ? reservations : [])
    .map(normalizeVideoBudgetReservation)
    .find((item) => item.taskId === request.taskId && item.attempt === request.attempt);
  if (existing) {
    return ACTIVE_SETTLEMENTS.has(existing.settlement)
      ? { ok: true, issue: '', reservation: existing, reservations: (Array.isArray(reservations) ? reservations : []).map(normalizeVideoBudgetReservation), reused: true }
      : { ok: false, issue: `reservation_already_${existing.settlement}`, reservation: existing, reservations: (Array.isArray(reservations) ? reservations : []).map(normalizeVideoBudgetReservation), reused: true };
  }
  const evaluation = evaluateVideoBudget(request, quoteValue, reservations, policyValue, options);
  if (!evaluation.allowed) return { ok: false, issue: evaluation.issues[0] || 'budget_rejected', evaluation, reservation: null, reservations };
  const now = time(options.now, Date.now());
  const reservation = normalizeVideoBudgetReservation({
    taskId: request.taskId,
    attempt: request.attempt,
    chatKey: request.chatKey,
    quoteId: evaluation.quote.quoteId,
    unit: evaluation.policy.unit,
    units: evaluation.reservationUnits,
    automatic: request.automatic,
    resolution: request.resolution,
    dayKey: videoBudgetDayKey(now, evaluation.policy.timezoneOffsetMinutes),
    settlement: 'reserved',
    createdAt: now,
  });
  return {
    ok: true,
    issue: '',
    evaluation,
    reservation,
    reservations: [...(Array.isArray(reservations) ? reservations : []).map(normalizeVideoBudgetReservation), reservation],
    reused: false,
  };
}

export function settleVideoBudgetReservation(values = [], reservationId = '', settlement = '', options = {}) {
  const id = text(reservationId, 200);
  const targetSettlement = ['committed', 'released', 'unknown'].includes(settlement) ? settlement : '';
  const reservations = (Array.isArray(values) ? values : []).map(normalizeVideoBudgetReservation);
  const index = reservations.findIndex((item) => item.reservationId === id);
  if (index < 0) return { ok: false, issue: 'reservation_not_found', reservations };
  if (!targetSettlement) return { ok: false, issue: 'settlement_invalid', reservations };
  const current = reservations[index];
  if (current.settlement === targetSettlement) return { ok: true, issue: '', reservation: current, reservations };
  if (current.settlement !== 'reserved' && current.settlement !== 'unknown') {
    return { ok: false, issue: `reservation_already_${current.settlement}`, reservation: current, reservations };
  }
  const next = normalizeVideoBudgetReservation({
    ...current,
    settlement: targetSettlement,
    settledAt: time(options.now, Date.now()),
  });
  reservations[index] = next;
  return { ok: true, issue: '', reservation: next, reservations };
}
