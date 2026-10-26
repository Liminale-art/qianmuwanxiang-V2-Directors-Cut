// Narrative order is presentation/applicability, never a replacement for source evidence.
const clone = value => structuredClone(value);
export const MEMORY_TITLE_LIMIT = 8;
export function validateMemoryTitle(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || /[\x00-\x1f]/.test(value) || Array.from(value.trim()).length > MEMORY_TITLE_LIMIT) {
        throw Object.assign(new Error(`切片名称最多 ${MEMORY_TITLE_LIMIT} 字`), { status: 400, statusCode: 400 });
    }
    return value.trim();
}
// Old records get a display-only extract, not an invented model title or a write migration.
export function memoryTitle(entry) {
    const explicit = typeof entry?.title === 'string' ? entry.title.trim() : '';
    const fallback = entry?.kind === 'manual' ? '自定义切片' : entry?.kind === 'stage' ? '阶段总结'
        : String(entry?.text || '').trim().split(/[\r\n。！？!?]/u)[0].replace(/^\s*[#>*\-]+\s*/u, '') || '记忆切片';
    return Array.from(explicit || fallback).slice(0, MEMORY_TITLE_LIMIT).join('');
}
const fail = message => { throw Object.assign(new Error(message), { status: 409, statusCode: 409 }); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const binding = value => {
    if (!value || typeof value !== 'object') fail('自定义切片缺少聊天锚点');
    const result = {};
    for (const key of ['avatar', 'file', 'integrity']) {
        if (typeof value[key] !== 'string' || !value[key].trim() || value[key].trim() !== value[key]
            || value[key].length > 240 || /[\x00-\x1f/\\:]/.test(value[key]) || ['.', '..'].includes(value[key])) fail('自定义切片聊天锚点无效');
        result[key] = value[key];
    }
    return result;
};

export function validatePlacement(value, { binding: expected } = {}) {
    if (value == null) return null; // Old source-free notes stay preserved, not assigned an invented floor.
    const result = { binding: binding(value.binding), fromFloor: value.fromFloor, hash: value.hash };
    if (!Number.isSafeInteger(result.fromFloor) || result.fromFloor < 1 || !/^[a-f0-9]{64}$/.test(result.hash)) fail('自定义切片楼层锚点无效');
    if (expected && JSON.stringify(result.binding) !== JSON.stringify(binding(expected))) fail('自定义切片锚点不属于当前聊天');
    return result;
}

const firstFloor = entry => entry.source?.start ?? entry.source?.ranges?.[0]?.start ?? entry.placement?.fromFloor ?? Infinity;
export function normalizeEntryOrder(document, { strict = false } = {}) {
    const entries = document.entries || [], ids = new Set(entries.map(entry => entry.id));
    const supplied = document.entryOrder;
    if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some(value => !id(value) || !ids.has(value)) || new Set(supplied).size !== supplied.length)) fail('切片排列无效，请刷新后重试');
    if (strict && (!supplied || supplied.length !== ids.size)) fail('切片列表已变化，请刷新后重新排列');
    const order = supplied ? [...supplied] : [];
    const missing = entries.filter(entry => !order.includes(entry.id)).slice().sort((a, b) => firstFloor(a) - firstFloor(b)
        || Number(b.kind === 'stage') - Number(a.kind === 'stage'));
    // Append missing records to a retained explicit order. Initialization alone uses source order.
    return [...order, ...missing.map(entry => entry.id)];
}

export function orderedEntries(document, entries = document.entries || []) {
    if (Array.isArray(document)) {
        const input = document, entryOrder = Array.isArray(entries) && entries.every(value => typeof value === 'string') ? entries : [];
        const ids = new Set(input.map(entry => entry.id));
        return orderedEntries({ entries: input, entryOrder: entryOrder.filter(value => ids.has(value)) }, input);
    }
    const order = normalizeEntryOrder(document), positions = new Map(order.map((value, index) => [value, index]));
    return entries.slice().sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}

/** Add only the new record. Never sort existing records and erase a human arrangement. */
export function insertEntryOrder(document, entry, afterId) {
    const previous = document.entryOrder || [];
    const order = previous.filter(value => value !== entry.id);
    let index = afterId === null ? 0 : typeof afterId === 'string' ? order.indexOf(afterId) + 1 : -1;
    if (typeof afterId === 'string' && index === 0) fail('插入位置已变化，请刷新后重试');
    const anchor = typeof afterId === 'string' ? document.entries.find(item => item.id === afterId) : null;
    if (anchor?.kind === 'stage' && anchor.status === 'active') {
        const group = new Set([anchor.id, ...(anchor.source?.parents || []).map(ref => ref.id)]);
        for (const item of document.entries) if (item.kind === 'excerpt' && group.has(item.parent?.id)) group.add(item.id);
        index = Math.max(index, ...order.map((value, position) => group.has(value) ? position + 1 : 0));
    }
    if (index < 0) {
        const parents = new Set(entry.source?.parents?.map(parent => parent.id) || []);
        const parentIndex = order.findIndex(value => parents.has(value));
        if (parentIndex >= 0) index = parentIndex;
        else {
            const end = entry.source?.start ?? entry.placement?.fromFloor ?? Infinity;
            index = order.findIndex(value => {
                const other = document.entries.find(item => item.id === value);
                return other && !other.origin && firstFloor(other) > end;
            });
            if (index < 0) index = order.length;
        }
    }
    order.splice(index, 0, entry.id);
    document.entryOrder = order;
    return order;
}

/** Priority chooses membership; this order alone determines the emitted narrative sequence. */
export function orderForInjection(entries, entryOrder = []) {
    const positions = new Map(entryOrder.map((value, index) => [value, index]));
    const root = entries.filter(entry => entry.kind !== 'excerpt');
    const rank = entry => positions.get(entry.id) ?? Math.min(Infinity,
        ...(entry.kind === 'stage' ? (entry.source?.parents || []).map(ref => positions.get(ref.id) ?? Infinity) : []));
    root.sort((a, b) => rank(a) - rank(b));
    const used = new Set(), result = [];
    for (const entry of root) {
        result.push(entry); used.add(entry.id);
        const parents = new Set([entry.id, ...(entry.source?.parents || []).map(ref => ref.id)]);
        for (const quote of entries.filter(item => item.kind === 'excerpt' && parents.has(item.parent?.id))) {
            if (!used.has(quote.id)) { result.push(quote); used.add(quote.id); }
        }
    }
    return result;
}

export function placementMatches(entry, document, hashes, cutoff = Infinity) {
    if (!entry.placement) return true; // Legacy notes remain explicitly unlocated at branch selection.
    try {
        const value = validatePlacement(entry.placement);
        const expected = entry.origin?.binding || document.binding;
        return JSON.stringify(value.binding) === JSON.stringify(binding(expected))
            && value.fromFloor + (entry.origin?.offset || 0) <= cutoff + (entry.origin ? document.lineage?.offset || 0 : 0)
            && entry.placementVerified !== false
            && (!entry.origin ? hashes[value.fromFloor - 1] === value.hash : entry.placementVerified === true);
    } catch { return false; }
}
