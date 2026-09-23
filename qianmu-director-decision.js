// 千幕·导演决策单。把用户确认后的候选转成下游唯一可消费凭据；不读写存储、媒体或网络。
import { QIANMU_DIRECTOR_CANDIDATE_SCHEMA, normalizeDirectorCandidate, scoreNarrativeDirectorCandidate } from './qianmu-director-candidate.js';
import { validateNarrativeLedgerEntry, adaptProductionPacketToNarrativeLedgerEntry } from './qianmu-narrative-ledger.js';
import { QIANMU_PRODUCTION_PACKET_SCHEMA } from './qianmu-production-packet.js';
import { normalizeWorldSource } from './qianmu-world-source.js';
import {normalizeWorldAutomaticApproval,worldAutomaticApprovalMatches} from './qianmu-world-automatic-approval.js?v=1.59.340';
import { narrativeContextField, narrativeContextIssues, matchingNarrativeContexts, isMainlineNarrativeFact } from './qianmu-narrative-context.js';

export const QIANMU_DIRECTOR_DECISION_SCHEMA = 'qianmu.director-decision.v1';
export const QIANMU_DIRECTOR_DECISION_CONSUMERS = Object.freeze(['storyboard', 'voice', 'subtitle', 'film']);
export const QIANMU_DIRECTOR_DECISION_STATUSES = Object.freeze(['approved', 'revoked']);

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 80, itemMax = 1000) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, itemMax)).filter(Boolean))].slice(0, max)
  : [];
const timestamp = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
const hash = (value) => {
  let result = 2166136261;
  for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(16).padStart(8, '0');
};

function normalizeOutputs(value) {
  const raw = plain(value) ? value : {};
  return Object.fromEntries(QIANMU_DIRECTOR_DECISION_CONSUMERS.map((consumer) => [consumer, raw[consumer] === true]));
}

function packetOwner(packet) {
  return text(packet?.timelineAnchor?.chatKey || packet?.timeline_anchor?.chat_key, 512);
}

function normalizeDecisionCharacters(value) {
  return (Array.isArray(value) ? value : []).slice(0, 24).map((item, index) => {
    const raw = plain(item) ? item : {};
    const id = text(raw.id || raw.name || `character-${index + 1}`, 160);
    return { id, name: text(raw.name || id, 160), state: text(raw.state, 1000), ...(raw.visible === false ? {visible:false} : {}) };
  }).filter((item) => item.id);
}

function normalizeDecisionScene(value) {
  const raw = plain(value) ? value : {};
  return {
    location: text(raw.location, 1000),
    time: text(raw.time, 240),
    weather: text(raw.weather, 240),
    environment: list(raw.environment, 40, 240),
    props: list(raw.props, 40, 240),
  };
}

export function normalizeDirectorDecision(value = {}) {
  const raw = plain(value) ? value : {};
  const source = plain(raw.source) ? raw.source : {};
  const approval = plain(raw.approval) ? raw.approval : {};
  const lanes = plain(raw.lanes) ? raw.lanes : {};
  const visual = plain(lanes.visual) ? lanes.visual : {};
  return {
    schema: QIANMU_DIRECTOR_DECISION_SCHEMA,
    decisionId: text(raw.decisionId || raw.decision_id, 200),
    owner: { chatKey: text(raw.owner?.chatKey || raw.owner?.chat_key, 512) },
    status: QIANMU_DIRECTOR_DECISION_STATUSES.includes(raw.status) ? raw.status : 'revoked',
    truthMode: raw.truthMode === 'canon' ? 'canon' : 'speculative',
    source: {
      candidateId: text(source.candidateId || source.candidate_id, 200),
      ledgerEntryId: text(source.ledgerEntryId || source.ledger_entry_id, 200),
      packetId: text(source.packetId || source.packet_id, 200),
      eventId: text(source.eventId || source.event_id, 200),
      track: ['main_camera', 'second_camera'].includes(source.track) ? source.track : '',
      canonLevel: ['canon', 'director', 'draft'].includes(source.canonLevel || source.canon_level) ? (source.canonLevel || source.canon_level) : '',
      ...(normalizeWorldSource(source.worldSource) ? {worldSource:normalizeWorldSource(source.worldSource)} : {}),
      ...narrativeContextField(source),
    },
    approval: {
      mode: ['explicit','world_setting'].includes(approval.mode) ? approval.mode : 'none',
      ...(Object.hasOwn(approval,'worldAutomation')?{worldAutomation:normalizeWorldAutomaticApproval(approval.worldAutomation)}:{}),
      approvedAt: timestamp(approval.approvedAt || approval.approved_at),
      revokedAt: timestamp(approval.revokedAt || approval.revoked_at),
      revision: Math.max(1, Math.min(1000, Math.floor(Number(approval.revision) || 1))),
    },
    outputs: normalizeOutputs(raw.outputs),
    lanes: {
      visual: {
        duty: text(visual.duty, 80), shotPattern: text(visual.shotPattern || visual.shot_pattern, 80),
        subject: text(visual.subject, 1000), description: text(visual.description, 4000),
        characters: normalizeDecisionCharacters(visual.characters),
        scene: normalizeDecisionScene(visual.scene),
        evidenceRefs: list(visual.evidenceRefs || visual.evidence_refs, 80, 200),
      },
      dialogue: list(lanes.dialogue, 40, 1000),
      ambience: list(lanes.ambience, 40, 1000),
      caption: text(lanes.caption, 1200),
    },
  };
}

export function validateDirectorDecision(value = {}) {
  const decision = normalizeDirectorDecision(value);
  const issues = [];
  if (value?.schema !== undefined && value.schema !== QIANMU_DIRECTOR_DECISION_SCHEMA) issues.push('decision_schema_unsupported');
  if (!decision.decisionId) issues.push('decision_id_missing');
  if (!decision.owner.chatKey) issues.push('owner_chat_missing');
  issues.push(...narrativeContextIssues(decision.source, decision.owner.chatKey));
  if (decision.truthMode === 'canon' && Object.hasOwn(decision.source, 'narrativeContext')
    && !isMainlineNarrativeFact(decision.source.narrativeContext)) issues.push('narrative_context_truth_mismatch');
  if (!decision.source.candidateId || !decision.source.ledgerEntryId || !decision.source.packetId) issues.push('source_chain_incomplete');
  if (decision.status === 'approved' && !['explicit','world_setting'].includes(decision.approval.mode)) issues.push('explicit_approval_missing');
  if(decision.approval.mode==='world_setting') {
    if(!worldAutomaticApprovalMatches(decision.approval.worldAutomation,decision.source.worldSource,decision.owner.chatKey))issues.push('world_automatic_source_invalid');
    if(decision.truthMode!=='speculative'||!decision.outputs.storyboard||['voice','subtitle','film'].some(key=>decision.outputs[key]))issues.push('world_automatic_scope_invalid');
    if(decision.lanes.dialogue.length||decision.lanes.ambience.length||decision.lanes.caption)issues.push('world_automatic_lane_invalid');
  } else if(Object.hasOwn(decision.approval,'worldAutomation'))issues.push('world_automatic_mode_mismatch');
  if (decision.status === 'approved' && !decision.approval.approvedAt) issues.push('approval_time_missing');
  if (!Object.values(decision.outputs).some(Boolean)) issues.push('consumer_missing');
  if (!decision.lanes.visual.description && !decision.lanes.visual.subject && !decision.lanes.dialogue.length && !decision.lanes.ambience.length && !decision.lanes.caption) issues.push('decision_content_missing');
  if (decision.status === 'revoked' && !decision.approval.revokedAt) issues.push('revocation_time_missing');
  return { ok: issues.length === 0, issues, decision };
}

function directorSourcePairIssues(candidate, packet, ledgerEntry, chatKey) {
  const validation = validateNarrativeLedgerEntry(ledgerEntry, chatKey);
  if (!validation.ok) return ['ledger_source_invalid', ...validation.issues.map(issue => `ledger:${issue}`)];
  const entry = validation.entry, issues = [];
  // This is the existing world-packet adapter, not a new authorization path for prose or autonomous facts.
  if (entry.source.kind !== 'simulation' || entry.continuity.state !== 'active') issues.push('ledger_source_not_active');
  if (packet.schema !== undefined && packet.schema !== QIANMU_PRODUCTION_PACKET_SCHEMA) issues.push('packet_schema_unsupported');
  const expectedEntry = adaptProductionPacketToNarrativeLedgerEntry(packet);
  if (!validateNarrativeLedgerEntry(expectedEntry, chatKey).ok) issues.push('packet_source_invalid');
  const projection = source => JSON.stringify([source.owner, source.source, source.fact, source.temporalState, source.evidenceRefs, source.originRefs]);
  if (projection(entry) !== projection(expectedEntry)) issues.push('ledger_packet_source_mismatch');
  const expectedCandidate = scoreNarrativeDirectorCandidate(entry, {
    chatKey, viewerId: 'user', directionByEntryId: { [entry.entryId]: candidate.direction },
  });
  const candidateProjection = source => JSON.stringify([source.candidateId, source.entryId, source.sourceKind,
    source.temporalState, source.subjectIds, source.factDigest]);
  if (candidateProjection(candidate) !== candidateProjection(expectedCandidate)
    || !matchingNarrativeContexts(candidate, entry.source)) issues.push('candidate_ledger_source_mismatch');
  return issues;
}

function buildDirectorDecision(candidateValue = {}, packetValue = {}, options = {}, automaticWorld = false) {
  const candidate = normalizeDirectorCandidate(candidateValue);
  const packet = plain(packetValue) ? packetValue : {};
  const input = plain(options) ? options : {};
  const chatKey = text(input.chatKey || input.chat_key, 512);
  const packetChatKey = packetOwner(packet);
  const issues = [];
  if (candidateValue?.schema !== undefined && candidateValue.schema !== QIANMU_DIRECTOR_CANDIDATE_SCHEMA) issues.push('candidate_schema_unsupported');
  if (!chatKey || candidate.owner.chatKey !== chatKey || packetChatKey !== chatKey) issues.push('owner_chat_mismatch');
  issues.push(...narrativeContextIssues(candidate, chatKey), ...narrativeContextIssues(packet.sourceRef, chatKey));
  if (!matchingNarrativeContexts(candidate, packet.sourceRef)) issues.push('narrative_context_source_mismatch');
  if (candidate.recommendation === 'reject') issues.push('candidate_rejected');
  if (!candidate.gates.sourceValid || !candidate.gates.factConsistency || !candidate.gates.shotDistinct
    || (candidate.recommendation === 'automatic' && (!candidate.gates.spoilerSafe || candidate.sourceKind !== 'prose'))) issues.push('candidate_gate_failed');
  if(!automaticWorld&&input.explicitApproval !== true) issues.push('explicit_approval_required');
  if(automaticWorld){
    if(input.worldAutoEnabled!==true)issues.push('world_automatic_opt_in_required');
    if(candidate.sourceKind!=='simulation'||!Object.hasOwn(input,'ledgerEntry'))issues.push('world_automatic_source_required');
    if(!worldAutomaticApprovalMatches(input.worldAutomation,packet.sourceRef?.worldSource,chatKey))issues.push('world_automatic_source_invalid');
    if(typeof input.namespace!=='string'||input.namespace!==input.worldAutomation?.namespace)issues.push('world_automatic_account_mismatch');
    if(packet.sourceRef?.field!==input.worldAutomation?.source?.field)issues.push('world_automatic_source_invalid');
    if(input.explicitApproval===true)issues.push('world_automatic_mode_mismatch');
  }
  if (candidate.entryId !== text(input.ledgerEntryId || input.ledger_entry_id, 200)) issues.push('ledger_entry_mismatch');
  // Legacy receipts stay readable; current world creation supplies the actual source rather than just its ID.
  if (Object.hasOwn(input, 'ledgerEntry')) issues.push(...directorSourcePairIssues(candidate, packet, input.ledgerEntry, chatKey));
  const visual = plain(packet.visualIntent) ? packet.visualIntent : {};
  const audio = plain(packet.audioIntent) ? packet.audioIntent : {};
  const scene = plain(packet.sceneState) ? packet.sceneState : {};
  const consequence = plain(packet.perceivedConsequence) ? packet.perceivedConsequence : {};
  const outputs = normalizeOutputs(input.outputs || { storyboard: true });
  const approvedAt = timestamp(input.approvedAt || input.approved_at) || Date.now();
  const decision = normalizeDirectorDecision({
    decisionId: automaticWorld ? `decision-${input.worldAutomation?.requestId || 'invalid'}` : `decision-${hash(`${chatKey}|${candidate.candidateId}|${packet.packetId}|${approvedAt}`)}`,
    owner: { chatKey },
    status: 'approved',
    truthMode: !automaticWorld&&candidate.sourceKind === 'prose' && (!Object.hasOwn(candidate, 'narrativeContext') || isMainlineNarrativeFact(candidate.narrativeContext)) ? 'canon' : 'speculative',
    source: {
      candidateId: candidate.candidateId, ledgerEntryId: candidate.entryId, packetId: packet.packetId,
      eventId: packet.eventId, track: packet.track, canonLevel: packet.canonLevel,
      worldSource: packet.sourceRef?.worldSource,
      ...narrativeContextField(candidate),
    },
    approval: { mode: automaticWorld?'world_setting':'explicit', approvedAt, revision: 1,
      ...(automaticWorld?{worldAutomation:input.worldAutomation}:{}) },
    outputs,
    lanes: {
      visual: {
        duty: visual.duty, shotPattern: visual.shotPattern, subject: visual.subject, description: visual.description,
        characters: packet.characterState, scene, evidenceRefs: visual.evidenceRefs,
      },
      dialogue: automaticWorld?[]:audio.dialogue,
      ambience: automaticWorld?[]:audio.ambience,
      caption: automaticWorld?'':consequence.summary,
    },
  });
  const validation = validateDirectorDecision(decision);
  const ok = issues.length === 0 && validation.ok;
  // A failed confirmation must not hand callers an apparently approved receipt.
  return { ok, issues: [...new Set([...issues, ...validation.issues])], decision: ok ? decision : null };
}

export function createDirectorDecision(candidate={},packet={},options={}) {
  return buildDirectorDecision(candidate,packet,options);
}
export function createAutomaticWorldDirectorDecision(candidate={},packet={},options={}) {
  return buildDirectorDecision(candidate,packet,options,true);
}

export function canConsumeDirectorDecision(value = {}, consumer = '', chatKey = '') {
  const validation = validateDirectorDecision(value);
  if (!validation.ok || validation.decision.status !== 'approved') return false;
  const normalizedConsumer = text(consumer, 40);
  if (!QIANMU_DIRECTOR_DECISION_CONSUMERS.includes(normalizedConsumer)) return false;
  if (text(chatKey, 512) !== validation.decision.owner.chatKey) return false;
  return validation.decision.outputs[normalizedConsumer] === true;
}

export function revokeDirectorDecision(value = {}, revokedAt = Date.now()) {
  const current = normalizeDirectorDecision(value);
  return normalizeDirectorDecision({
    ...current,
    status: 'revoked',
    approval: { ...current.approval, revokedAt: timestamp(revokedAt) || Date.now(), revision: current.approval.revision + 1 },
  });
}
