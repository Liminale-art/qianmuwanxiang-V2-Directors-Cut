// 千幕·共享叙事账本。纯数据合同：不读写 DOM、聊天、存储或网络。
export const QIANMU_NARRATIVE_LEDGER_SCHEMA = 'qianmu.narrative-ledger.v1';
export const QIANMU_NARRATIVE_ENTRY_SCHEMA = 'qianmu.narrative-entry.v1';
export const QIANMU_NARRATIVE_SOURCE_KINDS = Object.freeze(['prose', 'simulation']);
export const QIANMU_NARRATIVE_TEMPORAL_STATES = Object.freeze(['past', 'present', 'future', 'timeless', 'unknown']);
export const QIANMU_NARRATIVE_CONFIDENCE_STATES = Object.freeze(['confirmed', 'inferred', 'possible', 'disputed']);
export const QIANMU_NARRATIVE_VISIBILITY_SCOPES = Object.freeze(['mainline', 'limited', 'director_only']);
export const QIANMU_NARRATIVE_CONTINUITY_STATES = Object.freeze(['active', 'superseded', 'invalidated']);
export const QIANMU_NARRATIVE_INVALIDATION_KINDS = Object.freeze([
  'source_deleted', 'message_revised', 'swipe_changed', 'superseded', 'manual',
]);

const MAX_LEDGER_ENTRIES = 400;
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const integer = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const list = (value, max = 80, itemMax = 240) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, itemMax)).filter(Boolean))].slice(0, max)
  : [];
const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};

function sourceKind(value) {
  return QIANMU_NARRATIVE_SOURCE_KINDS.includes(value) ? value : 'simulation';
}

function normalizeSource(value = {}) {
  const raw = plain(value) ? value : {};
  const kind = sourceKind(raw.kind);
  const recordId = text(raw.recordId || raw.record_id || raw.messageId || raw.message_id, 200);
  return {
    kind,
    authority: kind === 'prose' ? 'canon' : 'possibility',
    recordId,
    floor: integer(raw.floor),
    messageId: text(raw.messageId || raw.message_id, 200),
    revisionId: text(raw.revisionId || raw.revision_id, 200),
    field: text(raw.field, 80),
    itemId: text(raw.itemId || raw.item_id, 200),
  };
}

function normalizeConfidence(value, kind) {
  const raw = plain(value) ? value : { state: value };
  const requested = choice(raw.state, QIANMU_NARRATIVE_CONFIDENCE_STATES, kind === 'prose' ? 'inferred' : 'possible');
  const state = kind === 'simulation' && !['possible', 'disputed'].includes(requested) ? 'possible' : requested;
  const scoreValue = Number(raw.score);
  const score = Number.isFinite(scoreValue) ? Math.max(0, Math.min(1, scoreValue)) : null;
  return { state, score: kind === 'simulation' && score != null ? Math.min(score, .69) : score };
}

function normalizeVisibility(value, kind) {
  const raw = plain(value) ? value : { scope: value };
  const requested = choice(raw.scope, QIANMU_NARRATIVE_VISIBILITY_SCOPES, kind === 'prose' ? 'mainline' : 'director_only');
  const scope = kind === 'simulation' ? 'director_only' : requested;
  return {
    scope,
    viewerIds: scope === 'limited' ? list(raw.viewerIds || raw.viewer_ids, 40, 160) : [],
    hiddenFrom: list(raw.hiddenFrom || raw.hidden_from, 40, 160),
  };
}

function normalizeInvalidationCondition(value = {}) {
  const raw = plain(value) ? value : {};
  const kind = choice(raw.kind, QIANMU_NARRATIVE_INVALIDATION_KINDS, 'manual');
  return { kind, refId: text(raw.refId || raw.ref_id, 200) };
}

function normalizeContinuity(value = {}) {
  const raw = plain(value) ? value : {};
  return {
    state: choice(raw.state, QIANMU_NARRATIVE_CONTINUITY_STATES, 'active'),
    invalidatedBy: list(raw.invalidatedBy || raw.invalidated_by, 40, 200),
    conditions: (Array.isArray(raw.conditions) ? raw.conditions : []).slice(0, 16).map(normalizeInvalidationCondition),
  };
}

export function normalizeNarrativeLedgerEntry(value = {}, ownerChatKey = '') {
  const raw = plain(value) ? value : {};
  const ownerRaw = plain(raw.owner) ? raw.owner : {};
  const source = normalizeSource(raw.source);
  const factRaw = plain(raw.fact) ? raw.fact : {};
  const chatKey = text(ownerRaw.chatKey || ownerRaw.chat_key || ownerChatKey, 512);
  const summary = text(factRaw.summary || raw.summary, 2000);
  const predicate = text(factRaw.predicate, 240);
  const object = text(factRaw.object, 1000);
  const seed = [chatKey, source.kind, source.recordId, source.field, source.itemId, summary, predicate, object].join('|');
  return {
    schema: QIANMU_NARRATIVE_ENTRY_SCHEMA,
    entryId: text(raw.entryId || raw.entry_id, 200) || `fact-${hash(seed)}`,
    owner: { chatKey },
    source,
    fact: {
      subjectIds: list(factRaw.subjectIds || factRaw.subject_ids, 40, 160),
      predicate,
      object,
      summary,
    },
    temporalState: choice(raw.temporalState || raw.temporal_state, QIANMU_NARRATIVE_TEMPORAL_STATES, 'unknown'),
    confidence: normalizeConfidence(raw.confidence, source.kind),
    readerVisibility: normalizeVisibility(raw.readerVisibility || raw.reader_visibility, source.kind),
    continuity: normalizeContinuity(raw.continuity),
    evidenceRefs: list(raw.evidenceRefs || raw.evidence_refs, 80, 200),
    originRefs: list(raw.originRefs || raw.origin_refs, 40, 200),
    createdAt: text(raw.createdAt || raw.created_at, 64),
    updatedAt: text(raw.updatedAt || raw.updated_at, 64),
  };
}

export function validateNarrativeLedgerEntry(value = {}, ownerChatKey = '') {
  const raw = plain(value) ? value : {};
  const entry = normalizeNarrativeLedgerEntry(raw, ownerChatKey);
  const issues = [];
  if (!plain(value)) issues.push('entry_not_object');
  if (!entry.owner.chatKey) issues.push('owner_chat_missing');
  if (!QIANMU_NARRATIVE_SOURCE_KINDS.includes(raw.source?.kind)) issues.push('source_kind_invalid');
  if (!entry.source.recordId) issues.push('source_record_missing');
  if (!entry.fact.summary && !entry.fact.predicate) issues.push('fact_content_missing');
  if (raw.source?.authority && raw.source.authority !== entry.source.authority) issues.push('source_authority_mismatch');
  if (entry.source.kind === 'simulation' && ['confirmed', 'inferred'].includes(raw.confidence?.state)) issues.push('simulation_cannot_confirm');
  if (entry.source.kind === 'simulation' && ['mainline', 'limited'].includes(raw.readerVisibility?.scope || raw.reader_visibility?.scope)) issues.push('simulation_cannot_reveal');
  if (ownerChatKey && entry.owner.chatKey !== text(ownerChatKey, 512)) issues.push('owner_chat_mismatch');
  if (entry.continuity.state !== 'active' && !entry.continuity.invalidatedBy.length) issues.push('continuity_reason_missing');
  return { ok: issues.length === 0, issues, entry };
}

export function normalizeNarrativeLedger(value = {}) {
  const raw = plain(value) ? value : {};
  const ownerRaw = plain(raw.owner) ? raw.owner : {};
  const chatKey = text(ownerRaw.chatKey || ownerRaw.chat_key, 512);
  return {
    schema: QIANMU_NARRATIVE_LEDGER_SCHEMA,
    owner: { chatKey },
    entries: (Array.isArray(raw.entries) ? raw.entries : []).slice(0, MAX_LEDGER_ENTRIES)
      .map((entry) => normalizeNarrativeLedgerEntry(entry, chatKey)),
    revision: Math.max(0, integer(raw.revision) || 0),
    updatedAt: text(raw.updatedAt || raw.updated_at, 64),
  };
}

export function validateNarrativeLedger(value = {}) {
  const raw = plain(value) ? value : {};
  const ledger = normalizeNarrativeLedger(raw);
  const issues = [];
  if (!plain(value)) issues.push('ledger_not_object');
  if (!ledger.owner.chatKey) issues.push('owner_chat_missing');
  if (!Array.isArray(raw.entries)) issues.push('entries_missing');
  if (Array.isArray(raw.entries) && raw.entries.length > MAX_LEDGER_ENTRIES) issues.push('entries_limit');
  const ids = new Set();
  (Array.isArray(raw.entries) ? raw.entries.slice(0, MAX_LEDGER_ENTRIES) : []).forEach((entry, index) => {
    const result = validateNarrativeLedgerEntry(entry, ledger.owner.chatKey);
    result.issues.forEach((issue) => issues.push(`entry_${index}_${issue}`));
    if (ids.has(result.entry.entryId)) issues.push(`entry_${index}_duplicate_id`);
    ids.add(result.entry.entryId);
  });
  return { ok: issues.length === 0, issues, ledger };
}

export function canExposeNarrativeLedgerEntryToMainline(value = {}, viewerId = '') {
  const entry = normalizeNarrativeLedgerEntry(value);
  if (entry.source.kind !== 'prose' || entry.source.authority !== 'canon') return false;
  if (entry.continuity.state !== 'active' || ['possible', 'disputed'].includes(entry.confidence.state)) return false;
  const viewer = text(viewerId, 160);
  if (entry.readerVisibility.hiddenFrom.includes(viewer)) return false;
  if (entry.readerVisibility.scope === 'mainline') return true;
  return entry.readerVisibility.scope === 'limited' && Boolean(viewer && entry.readerVisibility.viewerIds.includes(viewer));
}

export function adaptProductionPacketToNarrativeLedgerEntry(value = {}) {
  const packet = plain(value) ? value : {};
  const anchor = plain(packet.timelineAnchor) ? packet.timelineAnchor : {};
  const source = plain(packet.sourceRef) ? packet.sourceRef : {};
  const visual = plain(packet.visualIntent) ? packet.visualIntent : {};
  const characters = Array.isArray(packet.characterState) ? packet.characterState.slice(0, 24) : [];
  const recordId = text(packet.packetId || packet.eventId, 200);
  return normalizeNarrativeLedgerEntry({
    entryId: recordId ? `simulation-${recordId}` : '',
    owner: { chatKey: anchor.chatKey },
    source: {
      kind: 'simulation', recordId, floor: anchor.floor, messageId: anchor.messageId,
      revisionId: anchor.revisionId, field: source.field, itemId: source.itemId,
    },
    fact: {
      subjectIds: characters.map((item) => item?.id || item?.name),
      predicate: visual.duty,
      object: visual.subject,
      summary: visual.description || visual.subject,
    },
    temporalState: /未来|稍后|将要|next|future/i.test(String(anchor.time || '')) ? 'future' : 'present',
    confidence: { state: 'possible', score: .6 },
    readerVisibility: { scope: 'director_only' },
    continuity: {
      state: 'active',
      conditions: [
        { kind: 'source_deleted', refId: recordId },
        ...(anchor.revisionId ? [{ kind: 'swipe_changed', refId: anchor.revisionId }] : []),
      ],
    },
    evidenceRefs: visual.evidenceRefs,
    originRefs: [packet.eventId, ...list(packet.continuityRefs, 40, 200)],
  });
}
