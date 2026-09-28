import {parseBoundedJson} from './qianmu-json-input.js';
import {ST_ACCOUNT_STORAGE_LIMITS} from './qianmu-st-account-storage.js';
import {validateTextCollectionDocument, sameTextCollectionItem, mergeTextCollectionDocuments} from './qianmu-text-collection.js';

export const TEXT_COLLECTION_BACKUP_BYTES = ST_ACCOUNT_STORAGE_LIMITS.bytes + 4096;
const fail = message => { throw Object.assign(new Error(message), {code: 'text_collection_backup'}); };
const keys = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const encodedBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const validOrigin = origin => {
    try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.origin === origin; }
    catch { return false; }
};
const validatePlace = ({origin, scope}) => {
    if (!validOrigin(origin) || typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) fail('收藏备份来源无效，未导入。');
};

export function validateTextCollectionBackup(payload) {
    if (!keys(payload, ['type', 'version', 'exportedAt', 'origin', 'scope', 'document'])
        || payload.type !== 'qianmu-text-collection' || payload.version !== 1) fail('不是有效的正文收藏备份。');
    validatePlace(payload);
    const date = new Date(payload.exportedAt);
    if (typeof payload.exportedAt !== 'string' || !Number.isFinite(date.getTime()) || date.toISOString() !== payload.exportedAt) fail('收藏备份日期无效。');
    validateTextCollectionDocument(payload.document);
    if (encodedBytes(payload.document) > ST_ACCOUNT_STORAGE_LIMITS.bytes || encodedBytes(payload) > TEXT_COLLECTION_BACKUP_BYTES) fail('收藏备份超过存储上限，未导入；请保留原文件。');
    return payload;
}

export function createTextCollectionBackup(document, {origin, scope, now = () => new Date().toISOString()} = {}) {
    return structuredClone(validateTextCollectionBackup({type: 'qianmu-text-collection', version: 1,
        exportedAt: now(), origin, scope, document}));
}

export async function readTextCollectionBackup(file) {
    if (!file || typeof file.text !== 'function' || file.size !== undefined
        && (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > TEXT_COLLECTION_BACKUP_BYTES)) fail('收藏备份为空或超过读取上限，未导入。');
    const text = await file.text();
    return validateTextCollectionBackup(parseBoundedJson(text, {maxBytes: TEXT_COLLECTION_BACKUP_BYTES,
        maxDepth: 8, maxNodes: TEXT_COLLECTION_BACKUP_BYTES, label: '正文收藏备份'}));
}

function canonical(item) {
    return {id: item.id, text: item.text, charName: item.charName, userName: item.userName,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
        source: item.source === null ? null : {chatId: item.source.chatId, messageId: item.source.messageId}};
}

// One deterministic copy identity for an actual ID collision. This is import
// admission only, never another index, history, migration or persistence layer.
export async function prepareTextCollectionRestore(payload, current, {origin, scope, crypto = globalThis.crypto} = {}) {
    validateTextCollectionBackup(payload); validateTextCollectionDocument(current); validatePlace({origin, scope});
    const existing = new Map(current.items.map(item => [item.id, item])), additions = [], itemIds = new Map();
    const samePlace = payload.origin === origin && payload.scope === scope;
    const identity = async value => {
        if (!crypto?.subtle) fail('当前环境无法安全导入收藏，未写入内容。');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([payload.origin, payload.scope, value])));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    let skipped = 0;
    for (const original of payload.document.items) {
        const item = canonical(original);
        if (!samePlace) item.source = null;
        let previous = existing.get(item.id);
        if (previous && sameTextCollectionItem(previous, item)) { skipped++; continue; }
        if (previous) {
            item.id = `import-${await identity(canonical(original))}`;
            previous = existing.get(item.id);
            if (previous && !sameTextCollectionItem(previous, item)) fail('备份副本已被修改，未覆盖当前内容；请保留原文件。');
            if (previous) { skipped++; continue; }
        }
        additions.push(item); existing.set(item.id, item); itemIds.set(original.id, item.id);
    }
    let document = {version: 1, items: additions};
    if (payload.document.version === 2) {
        const known = new Map((current.organization?.folders || []).map(folder => [folder.id, {...folder}]));
        const names = new Map([...known.values()].map(folder => [folder.name.trim().toLocaleLowerCase(), folder]));
        const folderIds = new Map(), folders = [];
        for (const original of payload.document.organization.folders) {
            let folder = names.get(original.name.trim().toLocaleLowerCase());
            if (!folder) {
                folder = {...original};
                if (known.has(folder.id)) folder.id = `import-folder-${await identity(['folder', original.id, original.name])}`;
                const previous = known.get(folder.id);
                if (previous && previous.name !== folder.name) fail('备份文件夹已有变化，未覆盖当前分类；请保留原文件。');
                known.set(folder.id, folder); names.set(folder.name.trim().toLocaleLowerCase(), folder);
            }
            folderIds.set(original.id, folder.id); folders.push({...folder});
        }
        const entries = payload.document.organization.entries.filter(entry => itemIds.has(entry.itemId)).map(entry => ({
            itemId: itemIds.get(entry.itemId), folderId: entry.folderId === null ? null : folderIds.get(entry.folderId), tags: [...entry.tags],
        }));
        document = {version: 2, items: additions, organization: {folders, entries}};
    }
    const combined = mergeTextCollectionDocuments(current, document);
    if (encodedBytes(combined) > ST_ACCOUNT_STORAGE_LIMITS.bytes) fail('导入后超过存储上限，未写入内容；请保留原文件。');
    return {document, combined, changed: JSON.stringify(combined) !== JSON.stringify(current), count: additions.length, skipped};
}
