// Optional vector-candidate boundary. This module never stores originals,
// changes source state, or decides what is admitted to a generation request.
export const VECTOR_LIMITS = Object.freeze({ dimensions: 8192, candidates: 64, text: 20000 });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const cleanText = value => typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, VECTOR_LIMITS.text) : '';

export function normalizeVector(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > VECTOR_LIMITS.dimensions || value.some(value => !finite(value))) return null;
    const magnitude = Math.hypot(...value);
    if (!Number.isFinite(magnitude) || magnitude === 0) return null;
    return value.map(value => value / magnitude);
}

export function cosineSimilarity(left, right) {
    const a = normalizeVector(left), b = normalizeVector(right);
    if (!a || !b || a.length !== b.length) return null;
    return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

/** Rank already-filtered candidates; scores stay internal and are not UI facts. */
export function rankVectorCandidates(candidates = [], queryVector, { limit = 6 } = {}) {
    const query = normalizeVector(queryVector);
    if (!query) return [];
    const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, VECTOR_LIMITS.candidates)) : 6;
    const seen = new Set();
    return (Array.isArray(candidates) ? candidates : []).map(candidate => {
        if (!candidate?.id || seen.has(candidate.id)) return null;
        const score = cosineSimilarity(query, candidate.vector);
        if (score === null) return null;
        seen.add(candidate.id);
        return { candidate, score };
    }).filter(Boolean).sort((left, right) => right.score - left.score).slice(0, max).map(({ candidate }) => {
        const { vector, ...safe } = candidate;
        return safe;
    });
}

/**
 * Invoke an explicitly supplied embedding/candidate provider. A missing
 * provider is a normal unavailable state, not an error and never blocks the
 * lexical path. Provider results are treated as read-only candidate data.
 */
export async function discoverVectorCandidates({ provider, query, candidates = [], context = {}, limit = 6 } = {}) {
    if (typeof provider !== 'function') return { status: 'unavailable', candidates: [], reason: '尚未配置向量候选接口' };
    const safeQuery = cleanText(query);
    const safeCandidates = (Array.isArray(candidates) ? candidates : []).slice(0, VECTOR_LIMITS.candidates).map(candidate => ({
        id: typeof candidate?.id === 'string' ? candidate.id : '',
        text: cleanText(candidate?.text),
        title: cleanText(candidate?.title),
        start: candidate?.start,
        end: candidate?.end,
    })).filter(candidate => candidate.id && candidate.text);
    try {
        const response = await provider(Object.freeze({ query: safeQuery, candidates: safeCandidates, context: Object.freeze({ ...context }) }));
        const vectorCandidates = Array.isArray(response) ? response : response?.candidates;
        if (!Array.isArray(vectorCandidates)) return { status: 'error', candidates: [], reason: '向量接口返回格式无效' };
        const allowed = new Map(safeCandidates.map(candidate => [candidate.id, candidate]));
        const normalized = vectorCandidates.map(candidate => {
            const base = allowed.get(candidate?.id);
            const score = candidate?.score;
            if (!base || !finite(score)) return null;
            return { ...base, vectorScore: score };
        }).filter(Boolean);
        const unique = [...new Map(normalized.map(candidate => [candidate.id, candidate])).values()]
            .sort((left, right) => right.vectorScore - left.vectorScore)
            .slice(0, Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 6, VECTOR_LIMITS.candidates)))
            .map(({ vectorScore, ...candidate }) => candidate);
        return { status: 'ready', candidates: unique };
    } catch (error) {
        return { status: 'error', candidates: [], reason: error instanceof Error ? error.message : '向量候选接口不可用' };
    }
}
