import { estimateTokens, narrativeTerms } from './core.mjs';
import { excerptRecords, recallBlockReason } from './recall-contract.mjs';
import { sourceMatches } from './contract.mjs';
import { composePrompt } from './prompt-settings.mjs';

const parse = response => {
    try { return JSON.parse(String(response).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')); }
    catch { return null; }
};

const normalizeTerm = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().trim() : '';
const explicitTerms = value => {
    if (typeof value === 'string') return [normalizeTerm(value)].filter(Boolean);
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => explicitTerms(item)).filter(Boolean);
};

/**
 * Read optional, explicit synonym groups without turning arbitrary prose into
 * a hidden dictionary. The normal settings object has no such field yet; this
 * accepts a future host-provided map/array and keeps the default path unchanged.
 */
export function recallSynonymGroups(value) {
    const groups = [];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, aliases] of Object.entries(value)) {
            const group = [...new Set([key, ...explicitTerms(aliases)].map(normalizeTerm).filter(Boolean))];
            if (group.length > 1) groups.push(group);
        }
    } else if (Array.isArray(value)) {
        for (const aliases of value) {
            const group = [...new Set(explicitTerms(aliases))];
            if (group.length > 1) groups.push(group);
        }
    }
    return groups;
}

function sceneText(entry) {
    return (entry?.scenes || []).flatMap(scene => [
        scene?.world, scene?.timeline, scene?.date, scene?.period, scene?.place,
        scene?.event, ...(Array.isArray(scene?.characters) ? scene.characters : []),
    ]).filter(value => typeof value === 'string').join(' ');
}

function entryMetadataTerms(entry, groups) {
    const terms = expandedTerms([entry?.title, sceneText(entry)].filter(Boolean).join(' '), groups);
    for (const value of [entry?.aliases, entry?.synonyms, entry?.tags]) for (const term of explicitTerms(value)) terms.add(term);
    return terms;
}

function expandedTerms(text, groups) {
    const normalized = normalizeTerm(text);
    const terms = narrativeTerms(text);
    for (const group of groups) if (group.some(term => normalized.includes(term))) for (const term of group) terms.add(term);
    return terms;
}

/** Exposed for contract tests and future retrieval providers. */
export function recallCandidateScore(entry, queryText, settings = {}) {
    const groups = recallSynonymGroups(settings.recallSynonyms);
    const queryTerms = expandedTerms(queryText, groups);
    const bodyTerms = expandedTerms(entry?.text || '', groups);
    const metadataTerms = entryMetadataTerms(entry, groups);
    const timelineTerms = expandedTerms((entry?.scenes || []).flatMap(scene => [scene?.world, scene?.timeline, scene?.date, scene?.period, scene?.place]).filter(Boolean).join(' '), groups);
    const bodyHits = [...bodyTerms].filter(term => queryTerms.has(term));
    const metadataHits = [...metadataTerms].filter(term => queryTerms.has(term));
    const timelineHits = [...timelineTerms].filter(term => queryTerms.has(term));
    const score = bodyHits.length + metadataHits.length * 2 + timelineHits.length * 2;
    const reasons = [];
    if (bodyHits.length) reasons.push('关键词');
    if (metadataHits.some(term => !bodyTerms.has(term))) reasons.push('别名／同义词');
    if (timelineHits.length) reasons.push('时空线索');
    return { score, reasons, hits: { body: bodyHits, metadata: metadataHits, timeline: timelineHits } };
}

// This catalog is a bounded hint for the normal summary call, not a separate
// paid retrieval request or a second corpus of originals.
export function recallCandidates(document, settings, messages, batch, hashes = []) {
    if (settings.recall === false || recallBlockReason(document)) return [];
    const queryText = messages.slice(batch.start - 1, batch.end).map(m => m.mes || '').join('\n');
    const eligible = document.entries.filter(entry => !entry.origin && entry.kind === 'summary' && !recallBlockReason(document, entry)
        && sourceMatches(entry.source, hashes)
        && entry.source.end < batch.start && entry.source.end <= messages.length - settings.recent
        && new Set(excerptRecords(document, entry.id).map(item => item.id)).size < 2);
    const scored = eligible.map(entry => ({ entry, match: recallCandidateScore(entry, queryText, settings) }));
    scored.sort((a, b) => b.match.score - a.match.score || b.entry.source.end - a.entry.source.end);
    const result = []; let tokens = 0;
    for (const { entry, match } of scored) {
        const value = { id: entry.id, revision: entry.revision, start: entry.source.start, end: entry.source.end, title: entry.title || '记忆切片', text: entry.text,
            ...(match.reasons.length ? { reason: `${match.reasons.join('／')}命中 · 仅作候选，未写入记忆` } : { reason: '时间近邻候选 · 仅作候选，未写入记忆' }) };
        const size = estimateTokens(JSON.stringify(value));
        if (tokens + size > Math.min(1200, settings.batch / 5)) continue;
        tokens += size; result.push(value);
        if (result.length === 6) break;
    }
    return result;
}

export function parseRecallRequest(response, candidates) {
    const requests = parse(response)?.recallRequests;
    if (!Array.isArray(requests) || requests.length !== 1) return null;
    const value = requests[0], parent = candidates.find(item => item.id === value?.parentId);
    if (!parent || typeof value.question !== 'string' || value.question.trim().length < 4 || value.question.length > 180) return null;
    return { parentId: parent.id, parentRevision: parent.revision, question: value.question.trim() };
}

export function recallPrompt(source, request, document, newSlices, settings = {}) {
    const parent = document.entries.find(entry => entry.id === request.parentId);
    const stages = document.entries.filter(entry => entry.kind === 'stage' && entry.status === 'active'
        && entry.source.parents.some(ref => ref.id === request.parentId));
    return composePrompt(settings, 'recall', { protocol: '成功只输出JSON：{"floor":原文楼层整数,"quote":"逐字完整自然段（不超过1200字符）","compatible":true}；不采用时输出{"quote":null}。范围限本次限定原文，不跨楼拼接；不输出其他格式。', data: `本次具体问题：${JSON.stringify(request.question)}
现有来源细摘要：${JSON.stringify(parent?.text || '')}
相关阶段摘要：${JSON.stringify(stages.map(entry => entry.text))}
本次新整理的叙事：${JSON.stringify(newSlices.map(entry => entry.text))}
已删除的手动内容（仅作排除提醒，不作为事实，不能换说法补回）：${JSON.stringify(document.entries.filter(entry => entry.kind === 'manual' && entry.status === 'deleted').map(entry => entry.text))}
限定原文：${JSON.stringify(source.messages)}` });
}

export function parseRecallQuote(response, source) {
    const value = parse(response);
    if (!value || value.quote === null) return null;
    if (value.compatible !== true || !Number.isSafeInteger(value.floor) || typeof value.quote !== 'string'
        || !value.quote.trim() || value.quote.length > 1200) return null;
    const message = source.messages.find(item => item.floor === value.floor);
    const offset = message?.mes.indexOf(value.quote) ?? -1;
    if (offset < 0 || message.mes.indexOf(value.quote, offset + 1) !== -1) return null;
    if (offset !== 0 && message.mes[offset - 1] !== '\n'
        || offset + value.quote.length !== message.mes.length && message.mes[offset + value.quote.length] !== '\n') return null;
    return { floor: value.floor, text: value.quote };
}

export function recallFits(prompt, settings, snapshot) {
    // Independent connection context is not exposed by all ST versions: retain
    // the user's bounded batch setting instead of guessing that provider window.
    const reserve = Number(snapshot.maxResponse) > 0 ? Number(snapshot.maxResponse) : 2048;
    const limit = settings.profileId ? settings.batch : Math.min(settings.batch, (snapshot.maxContext || 0) - reserve - 512);
    return limit > 0 && estimateTokens(prompt) <= limit;
}
