// A rebuildable search index, not an asset/identity ledger or an original-file receipt.
// Callers supply an authenticated ST namespace and an already established chat owner.
// No chat discovery, source repair, network, media bytes or automatic migration here.
export const GALLERY_CATALOG_VERSION = 1;
export const GALLERY_CATALOG_LIMITS = Object.freeze({ batch: 200, page: 60, scan: 512, entries: 100000, bytes: 96 * 1048576 });
export const galleryCatalogError = (code, message) => Object.assign(new Error(message), { code: `gallery_catalog_${code}` });
const fail = (code, message) => { throw galleryCatalogError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, empty = false) => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function galleryCatalogAccount(value) {
    if (!text(value, 512) || !/^st-user:.+/.test(value)) fail('account', '尚未确认当前 ST 账户，未读取跨聊天目录');
    return value;
}
export function galleryCatalogOwner(value) {
    // Reuse character avatar-file identity and ST group ID, never a display name or array position.
    if (!text(value, 1024) || !/^(char|group):.+/.test(value) || /[\/\\]/.test(value) || /^(char|group):\.{1,2}$/.test(value)) fail('source', '缺少明确的角色文件或群聊标识');
    return value;
}
export function galleryCatalogSource(value) {
    if (!exact(value, ['ownerKey', 'chatKey']) || !text(value.chatKey, 1024)) fail('source', '聊天来源标识无效');
    return { ownerKey: galleryCatalogOwner(value.ownerKey), chatKey: value.chatKey };
}
export function galleryCatalogTags(value = []) {
    if (!Array.isArray(value) || value.length > 30 || Array.from(value).some(tag => !text(tag, 80) || tag.trim() !== tag)) fail('tags', '图库关键词无效或过多');
    return [...new Set(value)].sort(); // Exact existing keywords; no inferred or normalized narrative facts.
}
export function projectGalleryCatalogEntry(namespace, source, value) {
    namespace = galleryCatalogAccount(namespace); source = galleryCatalogSource(source);
    if (!object(value) || !text(value.id, 240) || !['still', 'motion'].includes(value.kind)
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !text(value.label ?? '', 240, true)) fail('entry', '图库轻量记录无效，未截断或猜测来源');
    // An explicit allowlist: no URL, prompt, snapshot, credentials, arbitrary extensions, or original bytes.
    return { namespace, ...source, recordId: value.id, kind: value.kind, createdAt: value.createdAt,
        label: value.label ?? '', tags: galleryCatalogTags(value.tags) };
}
export const galleryCatalogKey = row => [row.namespace, row.ownerKey, row.chatKey, row.recordId];
// Logical serialized metadata budget only, not browser disk usage, quota, or original-file capacity.
export const galleryCatalogBytes = row => new TextEncoder().encode(JSON.stringify(row)).byteLength;
// Maintenance scopes include both media kinds, but only derived references in
// this exact account / owner / chat. They never describe original-file ownership.
export function galleryCatalogMaintenanceQuery(namespace, input = {}) {
    namespace = galleryCatalogAccount(namespace);
    if (!object(input) || Object.keys(input).some(key => !['ownerKey', 'chatKey', 'cursor'].includes(key))) fail('query', '目录整理范围无效');
    const ownerKey = input.ownerKey ?? '', chatKey = input.chatKey ?? '', cursor = input.cursor ?? null;
    if (!text(ownerKey, 1024, true) || !text(chatKey, 1024, true) || chatKey && !ownerKey) fail('query', '目录整理须先选择准确角色');
    if (ownerKey) galleryCatalogOwner(ownerKey);
    const prefix = [namespace, ...(ownerKey ? [ownerKey] : []), ...(chatKey ? [chatKey] : [])];
    const signature = JSON.stringify({ namespace, ownerKey, chatKey, maintenance: true });
    if (cursor !== null) {
        if (!exact(cursor, ['version', 'signature', 'revision', 'after']) || cursor.version !== 1 || cursor.signature !== signature
            || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0 || !Array.isArray(cursor.after) || cursor.after.length !== 4
            || prefix.some((part, i) => cursor.after[i] !== part)) fail('cursor', '目录整理范围已变化，请重新盘点');
        projectGalleryCatalogEntry(namespace, { ownerKey: cursor.after[1], chatKey: cursor.after[2] }, { id: cursor.after[3], kind: 'still', createdAt: 0 });
    }
    return { namespace, ownerKey, chatKey, prefix, signature, cursor };
}
// Hierarchical directory pages jump over complete primary-key prefixes. No full
// scan, display-name grouping, schema upgrade or additional identity store.
export function galleryCatalogScopeQuery(namespace, input = {}) {
    namespace = galleryCatalogAccount(namespace);
    if (!object(input) || Object.keys(input).some(key => !['ownerKey', 'limit', 'cursor'].includes(key))) fail('query', '角色聊天目录条件无效');
    const ownerKey = input.ownerKey ?? '', limit = input.limit ?? 24, cursor = input.cursor ?? null;
    if (ownerKey !== '') galleryCatalogOwner(ownerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > GALLERY_CATALOG_LIMITS.page) fail('query', '角色聊天目录页大小无效');
    const prefix = ownerKey ? [namespace, ownerKey] : [namespace], signature = JSON.stringify({ namespace, ownerKey, scope: true });
    if (cursor !== null) {
        if (!exact(cursor, ['version', 'signature', 'revision', 'after']) || cursor.version !== 1 || cursor.signature !== signature
            || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0 || !Array.isArray(cursor.after)
            || cursor.after.length !== prefix.length + 1 || prefix.some((part, i) => cursor.after[i] !== part)) fail('cursor', '角色聊天目录已变化，请返回第一页');
        if (ownerKey) galleryCatalogSource({ ownerKey, chatKey: cursor.after[2] });
        else galleryCatalogOwner(cursor.after[1]);
    }
    return { namespace, ownerKey, limit, cursor, prefix, signature };
}
export function galleryCatalogStoredEntry(row, namespace) {
    if (!exact(row, ['namespace', 'ownerKey', 'chatKey', 'recordId', 'kind', 'createdAt', 'label', 'tags', 'key', 'tagKeys', 'bytes'])) fail('index', '图库索引结构异常，请保留原资料');
    const entry = projectGalleryCatalogEntry(namespace, { ownerKey: row.ownerKey, chatKey: row.chatKey }, { ...row, id: row.recordId });
    const expected = galleryCatalogStoredRow(entry);
    if (JSON.stringify(row.key) !== JSON.stringify(expected.key) || row.namespace !== namespace || row.bytes !== expected.bytes
        || JSON.stringify(row.tags) !== JSON.stringify(expected.tags) || JSON.stringify(row.tagKeys) !== JSON.stringify(expected.tagKeys)) fail('index', '图库索引归属或计值不符');
    return entry;
}
export function galleryCatalogStoredRow(entry) {
    const key = galleryCatalogKey(entry), tagKeys = entry.tags.map(tag => [entry.namespace, entry.kind, tag, entry.createdAt, entry.ownerKey, entry.chatKey, entry.recordId]);
    const row = { ...entry, key, tagKeys }; return { ...row, bytes: galleryCatalogBytes(row) };
}
export function galleryCatalogQuery(namespace, input = {}) {
    namespace = galleryCatalogAccount(namespace);
    if (!object(input) || Object.keys(input).some(key => !['kind', 'ownerKey', 'chatKey', 'tags', 'limit', 'cursor'].includes(key))) fail('query', '图库分页条件无效');
    const kind = input.kind ?? 'still', ownerKey = input.ownerKey ?? '', chatKey = input.chatKey ?? '', tags = galleryCatalogTags(input.tags), limit = input.limit ?? 24;
    if (!['still', 'motion'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > GALLERY_CATALOG_LIMITS.page
        || !text(ownerKey, 1024, true) || !text(chatKey, 1024, true) || chatKey && !ownerKey) fail('query', '图库分页范围或页大小无效');
    if (ownerKey) galleryCatalogOwner(ownerKey);
    const filter = { namespace, kind, ownerKey, chatKey, tags };
    const index = tags.length ? 'tag' : chatKey ? 'chat' : ownerKey ? 'owner' : 'time';
    const prefix = tags.length ? [namespace, kind, tags[0]] : chatKey ? [namespace, kind, ownerKey, chatKey] : ownerKey ? [namespace, kind, ownerKey] : [namespace, kind];
    const signature = JSON.stringify(filter), cursor = input.cursor ?? null;
    if (cursor !== null) {
        if (!exact(cursor, ['version', 'signature', 'revision', 'after']) || cursor.version !== GALLERY_CATALOG_VERSION || cursor.signature !== signature
            || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0 || !Array.isArray(cursor.after)
            || cursor.after.length !== (index === 'tag' ? 7 : 6) || prefix.some((part, i) => cursor.after[i] !== part)) fail('cursor', '图库续页条件已变化，请重新载入第一页');
        const tail = Array.from(cursor.after.slice(prefix.length));
        if (!Number.isSafeInteger(tail[0]) || tail[0] < 0 || tail.slice(1).some(value => !text(value, 1024))) fail('cursor', '图库续页位置无效');
    }
    return { ...filter, limit, index, prefix, signature, cursor };
}
export const galleryCatalogMatches = (row, query) => row.namespace === query.namespace && row.kind === query.kind
    && (!query.ownerKey || row.ownerKey === query.ownerKey) && (!query.chatKey || row.chatKey === query.chatKey) && query.tags.every(tag => row.tags.includes(tag));
