// Independent story snapshots; raw chat stays in ST's original files.
const clone = value => structuredClone(value);
const fail = message => { throw Object.assign(new Error(message), {status: 409, statusCode: 409}); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function storyBinding(value) {
    if (!value || typeof value !== 'object') fail('故事来源身份无效');
    const binding = {};
    for (const key of ['avatar', 'file', 'integrity']) {
        const text = value[key];
        if (typeof text !== 'string' || !text || text.length > 240 || text !== text.trim() || /[\x00-\x1f/\\:]/.test(text) || ['.', '..'].includes(text)) fail('故事来源身份无效');
        binding[key] = text;
    }
    return binding;
}
export function validateOrigin(value) {
    if (!integer(value?.offset)) fail('继承记忆的叙事位置无效');
    if (value.unresolved !== undefined && typeof value.unresolved !== 'boolean') fail('继承记忆的来源核验状态无效');
    return {binding: storyBinding(value.binding), offset: value.offset, ...(value.unresolved ? {unresolved: true} : {})};
}
export function validateLineage(value) {
    if (!integer(value?.cutoff) || value.cutoff < 1 || !integer(value.offset) || !integer(value.bridgeCount) || value.bridgeCount < 1
        || value.bridgeCount > value.cutoff || !Array.isArray(value.bridgeHashes) || value.bridgeHashes.length !== value.bridgeCount
        || !value.bridgeHashes.every(hash => /^[a-f0-9]{64}$/.test(hash))) fail('故事衔接记录无效');
    if (value.unresolved !== undefined && typeof value.unresolved !== 'boolean') fail('故事衔接来源核验状态无效');
    return {sourceBinding: storyBinding(value.sourceBinding), cutoff: value.cutoff, offset: value.offset,
        bridgeCount: value.bridgeCount, bridgeHashes: [...value.bridgeHashes], ...(value.unresolved ? {unresolved: true} : {})};
}
export function validateCreation(value) {
    if (typeof value?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)
        || !/^[a-f0-9]{64}$/.test(value.requestHash) || !/^[a-f0-9]{64}$/.test(value.planId)
        || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) || !integer(value.sourceRevision) || !integer(value.defaultsRevision)
        || !['pending', 'complete', 'failed'].includes(value.status)) fail('故事创建回执无效');
    return value;
}
export const storyOffset = document => document?.lineage?.offset || 0;
export const entryOrigin = (entry, document) => entry.origin || {binding: document.binding, offset: storyOffset(document)};
export const sameOrigin = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
const ranges = entry => entry.source ? entry.source.ranges || [entry.source] : entry.placement
    ? [{start:entry.placement.fromFloor,end:entry.placement.fromFloor,hashes:[entry.placement.hash]}] : [];
export function bridgeSourceValid(entry, document, hashes) {
    if (entry.origin?.unresolved) return false;
    if (!entry.origin || !document.lineage) return true;
    const {offset, bridgeHashes} = document.lineage;
    const windows = [...ranges(entry), ...(entry.kind === 'stage' ? (entry.source?.parents || []).flatMap(ref => {
        const parent=document.entries.find(value=>value.id===ref.id);return parent?.kind==='manual'?ranges(parent):[];
    }) : [])];
    return bridgeHashes.every((hash, index) => hashes[index] === hash || !windows.some(range => {
        const position = offset + index + 1;
        return entry.origin.offset + range.start <= position && entry.origin.offset + range.end >= position;
    }));
}
export function selectStoryEntries(document, cutoff, validIds, {total = cutoff, placementValidIds = validIds} = {}) {
    const limit = storyOffset(document) + cutoff;
    const active = document.entries.filter(entry => entry.status === 'active' && (!entry.source || validIds.has(entry.id)));
    const windows = entry => [...ranges(entry), ...(entry.kind === 'stage' ? (entry.source?.parents || []).flatMap(ref => {
        const parent=document.entries.find(value=>value.id===ref.id);return parent?.kind==='manual'?ranges(parent):[];
    }) : [])];
    const fullyBefore = entry => windows(entry).every(range => entryOrigin(entry, document).offset + range.end <= limit);
    const crossing = entry => windows(entry).some(range => entryOrigin(entry, document).offset + range.start <= limit) && !fullyBefore(entry);
    const protectedParents = new Set(document.entries.filter(entry => entry.kind === 'stage' && !entry.replacedBy
        && (['excluded', 'deleted'].includes(entry.status) || entry.edited && (entry.status !== 'active' || !validIds.has(entry.id) || crossing(entry))))
        .flatMap(entry => entry.source.parents.map(ref => ref.id)));
    const manualChoices = [], boundaries = [], entries = [];
    let skippedManualCount = 0;
    for (const entry of active) {
        if (entry.kind === 'excerpt') continue;
        if (protectedParents.has(entry.id)) continue;
        if (entry.kind === 'manual' && !entry.source) {
            const placement = entry.placement, from = entryOrigin(entry, document);
            const located = placement && placementValidIds.has(entry.id) && !entry.origin?.unresolved
                && JSON.stringify(placement.binding) === JSON.stringify(from.binding) && from.offset + placement.fromFloor <= limit;
            if (located || !placement && !entry.origin?.unresolved && cutoff === total) entries.push(clone(entry));
            else skippedManualCount++;
        } else if (entry.edited && crossing(entry)) {
            skippedManualCount++;
        } else if (entry.source && fullyBefore(entry)) entries.push(clone(entry));
        else if (entry.kind === 'summary' && !entry.edited && crossing(entry)) {
            const from = entryOrigin(entry, document), end = limit - from.offset;
            boundaries.push({id: entry.id, origin: clone(from), source: {start: entry.source.start, end,
                hashes: entry.source.hashes.slice(0, end - entry.source.start + 1)}});
        }
    }
    const fine = new Set(entries.filter(entry => ['summary','manual'].includes(entry.kind)).map(entry => entry.id));
    return {entries: entries.filter(entry => entry.kind !== 'stage' || entry.source.parents.every(ref => fine.has(ref.id))),
        boundaries, manualChoices, skippedManualCount, skippedExcerptCount: active.filter(entry => entry.kind === 'excerpt').length};
}
