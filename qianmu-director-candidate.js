// 千幕·导演候选池。只对叙事账本条目作确定性评估，不读取正文、媒体、存储或网络。
import {
  canExposeNarrativeLedgerEntryToMainline,
  normalizeNarrativeLedgerEntry,
  validateNarrativeLedgerEntry,
} from './qianmu-narrative-ledger.js';

export const QIANMU_DIRECTOR_CANDIDATE_SCHEMA = 'qianmu.director-candidate.v1';
export const QIANMU_DIRECTOR_CANDIDATE_POOL_SCHEMA = 'qianmu.director-candidate-pool.v1';
export const QIANMU_DIRECTOR_RECOMMENDATIONS = Object.freeze(['automatic', 'manual_review', 'reject']);

const MAX_CANDIDATES = 120;
const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 80, itemMax = 240) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, itemMax)).filter(Boolean))].slice(0, max)
  : [];
const score = (value, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback;
};
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};

function words(value) {
  return new Set(text(value, 1200).toLocaleLowerCase().split(/[\s,，。！？；;、:：/|]+/u).filter(Boolean).slice(0, 80));
}

function similarity(left, right) {
  const a = words(left), b = words(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function shotNovelty(signature, recentSignatures) {
  if (!signature) return 50;
  const maximum = recentSignatures.reduce((result, recent) => Math.max(result, similarity(signature, recent)), 0);
  return Math.max(0, Math.min(100, Math.round((1 - maximum) * 100)));
}

function rhythmDistance(entry, currentFloor) {
  const sourceFloor = entry.source.floor;
  if (!Number.isInteger(sourceFloor) || !Number.isInteger(currentFloor)) return 50;
  return Math.min(100, Math.abs(currentFloor - sourceFloor) * 12);
}

function spoilerRisk(entry, viewerId) {
  if (entry.source.kind === 'simulation' || entry.readerVisibility.scope === 'director_only') return 100;
  if (canExposeNarrativeLedgerEntryToMainline(entry, viewerId)) return 0;
  if (entry.readerVisibility.scope === 'limited') return 90;
  return 70;
}

export function scoreNarrativeDirectorCandidate(value = {}, context = {}) {
  const raw = plain(value) ? value : {};
  const options = plain(context) ? context : {};
  const ownerChatKey = text(options.chatKey || options.chat_key, 512);
  const validation = validateNarrativeLedgerEntry(raw, ownerChatKey);
  const entry = validation.entry;
  const directionMap = plain(options.directionByEntryId) ? options.directionByEntryId : {};
  const direction = plain(directionMap[entry.entryId]) ? directionMap[entry.entryId] : {};
  const contradicted = new Set(list(options.contradictedEntryIds || options.contradicted_entry_ids, MAX_CANDIDATES, 200));
  const recentSignatures = list(options.recentShotSignatures || options.recent_shot_signatures, 24, 1200);
  const signature = text(direction.shotSignature || direction.shot_signature || [direction.duty, entry.fact.summary].filter(Boolean).join(' '), 1200);
  const sourceValid = validation.ok;
  const factConsistency = entry.continuity.state === 'active' && !contradicted.has(entry.entryId);
  const spoilerSafe = canExposeNarrativeLedgerEntryToMainline(entry, options.viewerId || options.viewer_id);
  const novelty = shotNovelty(signature, recentSignatures);
  const shotDistinct = novelty >= 25;
  const dimensions = {
    narrativeValue: score(direction.narrativeValue ?? direction.narrative_value, entry.evidenceRefs.length ? 65 : 50),
    continuityRisk: factConsistency ? (entry.evidenceRefs.length ? 10 : 30) : 100,
    spoilerRisk: spoilerRisk(entry, options.viewerId || options.viewer_id),
    rhythmDistance: rhythmDistance(entry, Number(options.currentFloor ?? options.current_floor)),
    shotNovelty: novelty,
  };
  const total = sourceValid ? Math.round(
    dimensions.narrativeValue * .32
    + (100 - dimensions.continuityRisk) * .20
    + (100 - dimensions.spoilerRisk) * .15
    + (100 - dimensions.rhythmDistance) * .08
    + dimensions.shotNovelty * .25,
  ) : 0;
  const gates = { sourceValid, factConsistency, spoilerSafe, shotDistinct };
  const blockers = [
    ...validation.issues.map((issue) => `source:${issue}`),
    ...(!factConsistency ? ['fact_inconsistent'] : []),
    ...(!spoilerSafe ? ['reader_visibility_unconfirmed'] : []),
    ...(!shotDistinct ? ['shot_too_similar'] : []),
  ];
  const recommendation = sourceValid && factConsistency && spoilerSafe && shotDistinct
    ? 'automatic'
    : sourceValid && factConsistency && shotDistinct
      ? 'manual_review'
      : 'reject';
  return {
    schema: QIANMU_DIRECTOR_CANDIDATE_SCHEMA,
    candidateId: `candidate-${hash(`${entry.owner.chatKey}|${entry.entryId}|${signature}`)}`,
    owner: { chatKey: entry.owner.chatKey },
    entryId: entry.entryId,
    sourceKind: entry.source.kind,
    temporalState: entry.temporalState,
    subjectIds: [...entry.fact.subjectIds],
    factDigest: text(entry.fact.summary || [entry.fact.predicate, entry.fact.object].filter(Boolean).join(' '), 360),
    direction: {
      duty: text(direction.duty, 80),
      framing: text(direction.framing, 80),
      shotSignature: signature,
    },
    dimensions,
    total,
    gates,
    blockers: list(blockers, 32, 200),
    recommendation,
  };
}

export function buildNarrativeDirectorCandidatePool(entries = [], context = {}) {
  const options = plain(context) ? context : {};
  const chatKey = text(options.chatKey || options.chat_key, 512);
  const candidates = (Array.isArray(entries) ? entries : []).slice(0, MAX_CANDIDATES)
    .map((entry) => scoreNarrativeDirectorCandidate(entry, { ...options, chatKey }))
    .sort((left, right) => right.total - left.total || left.candidateId.localeCompare(right.candidateId));
  return {
    schema: QIANMU_DIRECTOR_CANDIDATE_POOL_SCHEMA,
    owner: { chatKey },
    candidates,
    summary: {
      automatic: candidates.filter((item) => item.recommendation === 'automatic').length,
      manualReview: candidates.filter((item) => item.recommendation === 'manual_review').length,
      rejected: candidates.filter((item) => item.recommendation === 'reject').length,
    },
  };
}

export function normalizeDirectorCandidate(value = {}) {
  const raw = plain(value) ? value : {};
  const dimensionsRaw = plain(raw.dimensions) ? raw.dimensions : {};
  const gatesRaw = plain(raw.gates) ? raw.gates : {};
  const directionRaw = plain(raw.direction) ? raw.direction : {};
  return {
    schema: QIANMU_DIRECTOR_CANDIDATE_SCHEMA,
    candidateId: text(raw.candidateId || raw.candidate_id, 200),
    owner: { chatKey: text(raw.owner?.chatKey || raw.owner?.chat_key, 512) },
    entryId: text(raw.entryId || raw.entry_id, 200),
    sourceKind: ['prose', 'simulation'].includes(raw.sourceKind || raw.source_kind) ? (raw.sourceKind || raw.source_kind) : 'simulation',
    temporalState: text(raw.temporalState || raw.temporal_state, 40),
    subjectIds: list(raw.subjectIds || raw.subject_ids, 40, 160),
    factDigest: text(raw.factDigest || raw.fact_digest, 360),
    direction: {
      duty: text(directionRaw.duty, 80), framing: text(directionRaw.framing, 80),
      shotSignature: text(directionRaw.shotSignature || directionRaw.shot_signature, 1200),
    },
    dimensions: {
      narrativeValue: score(dimensionsRaw.narrativeValue ?? dimensionsRaw.narrative_value),
      continuityRisk: score(dimensionsRaw.continuityRisk ?? dimensionsRaw.continuity_risk),
      spoilerRisk: score(dimensionsRaw.spoilerRisk ?? dimensionsRaw.spoiler_risk),
      rhythmDistance: score(dimensionsRaw.rhythmDistance ?? dimensionsRaw.rhythm_distance),
      shotNovelty: score(dimensionsRaw.shotNovelty ?? dimensionsRaw.shot_novelty),
    },
    total: score(raw.total, 0),
    gates: {
      sourceValid: Boolean(gatesRaw.sourceValid ?? gatesRaw.source_valid),
      factConsistency: Boolean(gatesRaw.factConsistency ?? gatesRaw.fact_consistency),
      spoilerSafe: Boolean(gatesRaw.spoilerSafe ?? gatesRaw.spoiler_safe),
      shotDistinct: Boolean(gatesRaw.shotDistinct ?? gatesRaw.shot_distinct),
    },
    blockers: list(raw.blockers, 32, 200),
    recommendation: QIANMU_DIRECTOR_RECOMMENDATIONS.includes(raw.recommendation) ? raw.recommendation : 'reject',
  };
}
