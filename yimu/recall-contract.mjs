// Pointer-only excerpts. Quoted text is materialized by the server, never persisted here.
import {sourceRanges} from './stage-contract.mjs';
const clone = value => structuredClone(value);
const fail = message => { throw Object.assign(new Error(message), {status: 409, statusCode: 409}); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export function validateExcerpt(entry) {
    const source = entry?.source, parent = entry?.parent, quote = entry?.quote;
    if (entry?.kind !== 'excerpt' || entry.text !== '原文补充' || !id(parent?.id) || !Number.isSafeInteger(parent.revision) || parent.revision < 1
        || !Number.isSafeInteger(source?.start) || source.start < 1 || source.end !== source.start
        || !Array.isArray(source.hashes) || source.hashes.length !== 1 || !/^[a-f0-9]{64}$/.test(source.hashes[0])
        || !Number.isSafeInteger(quote?.start) || !Number.isSafeInteger(quote?.end) || quote.start < 0 || quote.end <= quote.start || quote.end - quote.start > 1200) fail('原文补充的来源定位无效');
    return {kind: 'excerpt', text: '原文补充', parent: {id: parent.id, revision: parent.revision},
        source: {start: source.start, end: source.end, hashes: [...source.hashes]}, quote: {start: quote.start, end: quote.end}};
}

export function recallBlockReason(document, parent = null) {
    const entries = document?.entries || [];
    if (entries.some(entry => entry.edited && entry.status !== 'deleted' || entry.conflicts?.length || entry.kind === 'manual' && entry.status === 'active' && !entry.source)) return '此聊天存在人工修订或待处理冲突，暂不自动补充原文';
    if (!parent) return '';
    const entry = entries.find(item => item.id === parent.id);
    if (!entry || entry.kind !== 'summary' || entry.status !== 'active' || entry.edited
        || parent.revision !== undefined && parent.revision !== entry.revision) return '回查所依据的细摘要已修改、停用或失效';
    if (entries.some(item => item.kind === 'stage' && (item.edited || ['excluded', 'deleted'].includes(item.status))
        && item.source?.parents?.some(ref => ref.id === entry.id))) return '相关阶段已被删除或暂不使用，不自动补回';
    if (entries.some(item => item.edited && item.source && sourceRanges(item).some(range => range.start <= entry.source.end && range.end >= entry.source.start))) return '此来源包含人工修订范围，不自动补回';
    return '';
}

export function excerptDependenciesValid(entry, document) {
    if (entry?.kind !== 'excerpt') return true;
    try {
        validateExcerpt(entry);
        if (recallBlockReason(document, entry.parent)) return false;
        const parent = document.entries.find(item => item.id === entry.parent.id);
        return entry.source.start >= parent.source.start && entry.source.end <= parent.source.end
            && entry.source.hashes[0] === parent.source.hashes[entry.source.start - parent.source.start];
    } catch { return false; }
}

export function excerptRecords(document, parentId) {
    return document.entries.flatMap(entry => [entry, ...entry.history].filter(version => version.kind === 'excerpt' && version.parent?.id === parentId));
}

export function invalidateDependentExcerpts(document) {
    for (const entry of document.entries) {
        if (entry.kind !== 'excerpt' || entry.status !== 'active' || excerptDependenciesValid(entry, document)) continue;
        const {history, conflicts, candidate, quoteText, quoteSpeaker, ...previous} = entry;
        entry.history.push(clone(previous)); entry.status = 'invalid'; entry.candidate = null; entry.revision++;
        delete entry.quoteText; delete entry.quoteSpeaker;
    }
    return document;
}
