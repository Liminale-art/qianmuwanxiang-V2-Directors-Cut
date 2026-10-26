// Data-only stage dependencies; no model, storage, or second copy of chat originals.
import { orderedEntries, validatePlacement } from './timeline.mjs';
const clone = value => structuredClone(value);
const fail = message => { throw Object.assign(new Error(message), {status: 409, statusCode: 409}); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const hasCustomParents = (entry, document) => entry?.kind === 'stage'
    && (entry.source?.parents || []).some(ref => document.entries.some(parent => parent.id === ref.id && parent.kind === 'manual'));

function range(value) {
    if (!value || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 1 || value.end < value.start
        || !Array.isArray(value.hashes) || value.hashes.length !== value.end - value.start + 1 || !value.hashes.every(hash => /^[a-f0-9]{64}$/.test(hash))) fail('阶段摘要的来源楼层或指纹无效');
    return {start: value.start, end: value.end, hashes: [...value.hashes]};
}

function references(parents) {
    if (!Array.isArray(parents) || !parents.length) fail('阶段摘要没有有效细摘要来源');
    const ids = new Set();
    return parents.map(parent => {
        if (!identifier(parent?.id) || ids.has(parent.id) || !Number.isSafeInteger(parent.revision) || parent.revision < 1) fail('阶段摘要的细摘要来源标识无效');
        ids.add(parent.id);
        return {id: parent.id, revision: parent.revision};
    });
}

export function sourceRanges(entryOrSource) {
    const source = entryOrSource && Object.hasOwn(entryOrSource, 'source') ? entryOrSource.source : entryOrSource;
    if (!source) return [];
    return Array.isArray(source.ranges) ? source.ranges.map(range) : [range(source)];
}

export function validateStageSource(source) {
    const parents = references(source?.parents);
    if (!Array.isArray(source?.ranges)) fail('阶段摘要没有来源区间');
    const ranges = source.ranges.map(range);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].start <= ranges[i - 1].end + 1) fail('阶段摘要来源区间重叠或尚未规范化');
    return {ranges, parents};
}

export function stageSourceFromParents(document, refs) {
    const parents = references(refs);
    const entries = parents.map(ref => {
        const entry = document.entries.find(item => item.id === ref.id);
        if (!entry || !['summary', 'manual'].includes(entry.kind) || entry.status !== 'active'
            || entry.kind === 'summary' && entry.edited || entry.revision !== ref.revision) {
            fail('阶段整理期间细摘要已修改、停用或失效，本次结果未采用');
        }
        if (entry.kind === 'manual') {
            if (!validatePlacement(entry.placement)) fail('自定义切片尚未确定适用位置，不能纳入阶段');
            return { entry, source: null };
        }
        return {entry, source: range(entry.source)};
    });
    if (entries.some(({entry}) => JSON.stringify(entry.origin || null) !== JSON.stringify(entries[0].entry.origin || null))) fail('阶段摘要不能混合不同聊天来源');
    const narrative = orderedEntries(document).filter(entry => ['summary', 'manual'].includes(entry.kind));
    const from = narrative.findIndex(entry => entry.id === parents[0].id);
    if (from < 0 || parents.some((ref, i) => narrative[from + i]?.id !== ref.id)) fail('阶段切片的连续叙事排列已变化，不能跨越其他切片');
    const sources = entries.map(value => value.source).filter(Boolean).sort((a, b) => a.start - b.start);
    const ranges = [];
    for (const next of sources) {
        const combined = ranges.at(-1);
        if (!combined) ranges.push(clone(next));
        else {
            if (next.start !== combined.end + 1) fail('阶段摘要只能整理连续的未手动修订细摘要');
            combined.end = next.end; combined.hashes.push(...next.hashes);
        }
    }
    return {ranges, parents};
}

export function stageDependenciesValid(entry, document) {
    if (entry?.kind !== 'stage') return true;
    try {
        const source = validateStageSource(entry.source);
        const first = document.entries.find(item => item.id === source.parents[0].id);
        return same(entry.origin || null, first?.origin || null) && same(source, stageSourceFromParents(document, source.parents));
    } catch { return false; }
}

// A modified parent never automatically resurrects an old stage, even if its text later returns.
export function invalidateDependentStages(document) {
    for (const entry of document.entries) {
        if (entry.kind !== 'stage' || entry.status !== 'active' || stageDependenciesValid(entry, document)) continue;
        const {history, conflicts, candidate, ...previous} = entry;
        entry.history.push(clone(previous));
        entry.status = 'invalid'; entry.candidate = null; entry.revision++;
    }
    return document;
}
