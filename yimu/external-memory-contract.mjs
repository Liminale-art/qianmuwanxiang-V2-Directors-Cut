// Read-only boundary for memory supplied by other extensions.
//
// An adapter is explicitly registered by the host; arbitrary prompt/XML tags
// are never parsed here. The normalized result is deliberately not a Yimu
// document entry: it has no write operation, no source-replacement authority,
// and is only a future candidate-input shape.
export const EXTERNAL_MEMORY_SCHEMA = 1;
export const EXTERNAL_MEMORY_LIMITS = Object.freeze({
    adapters: 16,
    entries: 200,
    text: 12000,
    totalText: 500000,
    tags: 20,
});

const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400 }); };
const clean = (value, max, label, { empty = false } = {}) => {
    if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) fail(`${label}无效或过长`);
    return value.replace(/\u0000/g, '').trim();
};
const id = value => clean(value, 80, '外部记忆条目标识').replace(/\s+/g, '-');
const optional = (value, max = 160) => typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '';
const list = (value, max = 20) => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string')
    .map(item => optional(item, 80)).filter(Boolean))].slice(0, max) : [];

export function validateExternalAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') fail('外部记忆适配器无效');
    const adapterId = clean(adapter.id, 64, '外部记忆适配器标识');
    if (!/^[a-z][a-z0-9._-]*$/i.test(adapterId)) fail('外部记忆适配器标识格式无效');
    const label = clean(adapter.label || adapter.name || adapterId, 120, '外部记忆适配器名称');
    if (typeof adapter.read !== 'function') fail('外部记忆适配器缺少只读入口');
    return { id: adapterId, label, version: clean(adapter.version || '1', 40, '外部记忆适配器版本'), read: adapter.read };
}

function normalizeTags(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > EXTERNAL_MEMORY_LIMITS.tags) return [];
    return [...new Set(value.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean))]
        .slice(0, EXTERNAL_MEMORY_LIMITS.tags).map(tag => tag.slice(0, 80));
}

export function normalizeExternalEntries(raw, adapter, { scope = 'chat' } = {}) {
    const descriptor = validateExternalAdapter(adapter);
    const source = Array.isArray(raw) ? raw : raw?.entries;
    if (!Array.isArray(source)) return [];
    const seen = new Set(), normalized = [];
    let totalText = 0;
    for (const item of source) {
        if (normalized.length >= EXTERNAL_MEMORY_LIMITS.entries) break;
        if (!item || typeof item !== 'object') continue;
        let itemId, text;
        try {
            itemId = id(item.id);
            text = clean(item.text ?? item.summary, EXTERNAL_MEMORY_LIMITS.text, '外部记忆正文');
        } catch { continue; }
        if (!text) continue;
        const dedupeKey = `${descriptor.id}\u0000${itemId}\u0000${text}`;
        if (seen.has(dedupeKey)) continue;
        if (totalText + text.length > EXTERNAL_MEMORY_LIMITS.totalText) break;
        seen.add(dedupeKey); totalText += text.length;
        const title = optional(item.title, 120);
        const itemScope = optional(item.scope) || scope;
        normalized.push({
            id: `${descriptor.id}:${itemId}`,
            adapterId: descriptor.id,
            adapterLabel: descriptor.label,
            adapterVersion: descriptor.version,
            title,
            text,
            tags: normalizeTags(item.tags),
            scope: itemScope,
            storyId: optional(item.storyId),
            timeline: optional(item.timeline),
            place: optional(item.place),
            characters: list(item.characters),
            knownTo: list(item.knownTo),
            injectionBlocked: item.injectionBlocked === true,
            source: { kind: 'external', adapter: descriptor.id, ref: itemId },
            readOnly: true,
            trusted: false,
            canReplaceSource: false,
            dedupeKey,
        });
    }
    return normalized;
}

/**
 * Apply only explicit structural boundaries. Missing metadata stays eligible;
 * an external adapter must not be able to invent a hard exclusion merely by
 * omitting time, place or character fields.
 */
export function filterExternalCandidates(entries = [], context = {}) {
    const scope = optional(context.scope) || 'chat';
    const storyId = optional(context.storyId);
    const timeline = optional(context.timeline);
    const knownTo = new Set(list(context.knownTo));
    const blocked = new Set(Array.isArray(context.blockedIds) ? context.blockedIds : []);
    const adapters = context.adapterIds instanceof Set ? context.adapterIds : new Set(Array.isArray(context.adapterIds) ? context.adapterIds : []);
    return entries.filter(entry => {
        if (!entry || entry.readOnly !== true || entry.trusted !== false || entry.canReplaceSource !== false) return false;
        if (entry.scope !== scope || entry.injectionBlocked || blocked.has(entry.id)) return false;
        if (storyId && entry.storyId && entry.storyId !== storyId) return false;
        if (timeline && entry.timeline && entry.timeline !== timeline) return false;
        if (knownTo.size && Array.isArray(entry.knownTo) && entry.knownTo.length && !entry.knownTo.some(value => knownTo.has(value))) return false;
        if (adapters.size && !adapters.has(entry.adapterId)) return false;
        return true;
    });
}

export function createExternalMemoryRegistry(initial = []) {
    const adapters = new Map();
    const register = adapter => {
        if (adapters.size >= EXTERNAL_MEMORY_LIMITS.adapters && !adapters.has(adapter?.id)) fail('外部记忆适配器数量已达上限');
        const descriptor = validateExternalAdapter(adapter);
        adapters.set(descriptor.id, descriptor);
        return descriptor.id;
    };
    for (const adapter of initial) register(adapter);
    return Object.freeze({
        register,
        remove(adapterId) { return adapters.delete(adapterId); },
        list() { return [...adapters.values()].map(({ read, ...descriptor }) => descriptor); },
        async read(context = {}, options = {}) {
            const entries = [], diagnostics = [];
            for (const adapter of adapters.values()) {
                try {
                    const raw = await adapter.read(Object.freeze({ ...context }));
                    const normalized = normalizeExternalEntries(raw, adapter, options);
                    entries.push(...normalized);
                    diagnostics.push({ adapterId: adapter.id, status: 'ok', count: normalized.length });
                } catch (error) {
                    diagnostics.push({ adapterId: adapter.id, status: 'error', message: error instanceof Error ? error.message : '读取失败' });
                }
            }
            return { version: EXTERNAL_MEMORY_SCHEMA, entries, diagnostics };
        },
    });
}
