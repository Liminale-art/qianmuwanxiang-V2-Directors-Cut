import { filterExternalCandidates } from './external-memory-contract.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const integer = value => Number.isSafeInteger(value) ? value : null;

/**
 * Structural guard for the candidate list used by the lexical path.
 *
 * This is deliberately not a relevance scorer. The recall module still owns
 * keyword scoring and its bounded budget; this function only prevents a
 * candidate from crossing the current chat/range/status boundary.
 */
export function filterLocalRetrievalCandidates(candidates = [], context = {}) {
    const blocked = new Set(Array.isArray(context.blockedIds) ? context.blockedIds : []);
    const invalid = new Set(Array.isArray(context.invalidIds) ? context.invalidIds : []);
    const beforeFloor = integer(context.beforeFloor);
    const scope = text(context.scope) || 'chat';
    const storyId = text(context.storyId);
    const timeline = text(context.timeline);
    const knownTo = new Set(Array.isArray(context.knownTo) ? context.knownTo.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : []);
    return (Array.isArray(candidates) ? candidates : []).filter(candidate => {
        if (!candidate || typeof candidate !== 'object' || !text(candidate.id)) return false;
        if (blocked.has(candidate.id) || invalid.has(candidate.id)) return false;
        if (candidate.injectionBlocked === true || ['deleted', 'excluded'].includes(candidate.status)) return false;
        if (candidate.scope && candidate.scope !== scope) return false;
        if (storyId && candidate.storyId && candidate.storyId !== storyId) return false;
        if (timeline && candidate.timeline && candidate.timeline !== timeline) return false;
        if (knownTo.size && Array.isArray(candidate.knownTo) && candidate.knownTo.length
            && !candidate.knownTo.some(value => knownTo.has(value))) return false;
        const start = integer(candidate.start), end = integer(candidate.end);
        if (start === null || end === null || start < 1 || end < start) return false;
        if (beforeFloor !== null && end >= beforeFloor) return false;
        return true;
    });
}

const sourceLabel = candidate => candidate?.kind === 'external'
    ? `${text(candidate.adapterLabel) || '外部来源'}（只读）`
    : '忆幕';

/**
 * Build the reviewable retrieval snapshot without changing the memory store.
 * External entries are accepted only after the explicit read-only adapter
 * boundary; they are displayed as candidates and never gain replacement
 * authority. Local candidates keep their recall text for the existing prompt.
 */
export function buildRetrievalCandidates({ localCandidates = [], externalCandidates = [], context = {}, at = Date.now() } = {}) {
    const local = filterLocalRetrievalCandidates(localCandidates, context);
    const external = filterExternalCandidates(externalCandidates, context);
    const seen = new Set();
    const candidates = [...local.map(candidate => ({
        ...candidate,
        kind: 'local',
        sourceLabel: sourceLabel(candidate),
        reason: candidate.reason || '关键词命中 · 仅作候选，未写入记忆',
    })), ...external.map(candidate => ({
        ...candidate,
        kind: 'external',
        sourceLabel: sourceLabel({ ...candidate, kind: 'external' }),
        reason: candidate.reason || '外部只读来源 · 仅作候选，未写入记忆',
    }))].filter(candidate => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
    });
    return {
        candidates,
        localCount: local.length,
        externalCount: external.length,
        count: candidates.length,
        at,
    };
}

export function retrievalContext(document, { beforeFloor = null, invalidIds = [] } = {}) {
    const entries = Array.isArray(document?.entries) ? document.entries : [];
    return {
        scope: 'chat',
        storyId: text(document?.storyId || document?.lineage?.storyId),
        timeline: text(document?.timeline || document?.lineage?.timeline),
        beforeFloor,
        invalidIds,
        blockedIds: entries.filter(entry => entry?.injectionBlocked === true || ['deleted', 'excluded'].includes(entry?.status)).map(entry => entry.id),
    };
}
