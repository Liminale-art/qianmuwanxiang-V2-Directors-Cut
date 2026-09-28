import {parseBoundedJson} from './qianmu-json-input.js';
import {ST_ACCOUNT_STORAGE_LIMITS} from './qianmu-st-account-storage.js';
import {validateTextCollectionDocument, sameTextCollectionItem} from './qianmu-text-collection.js';

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
    const existing = new Map(current.items.map(item => [item.id, item])), additions = [];
    const samePlace = payload.origin === origin && payload.scope === scope;
    let skipped = 0;
    for (const original of payload.document.items) {
        const item = canonical(original);
        if (!samePlace) item.source = null;
        let previous = existing.get(item.id);
        if (previous && sameTextCollectionItem(previous, item)) { skipped++; continue; }
        if (previous) {
            if (!crypto?.subtle) fail('当前环境无法安全导入收藏，未写入内容。');
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([payload.origin, payload.scope, canonical(original)])));
            item.id = `import-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
            previous = existing.get(item.id);
            if (previous && !sameTextCollectionItem(previous, item)) fail('备份副本已被修改，未覆盖当前内容；请保留原文件。');
            if (previous) { skipped++; continue; }
        }
        additions.push(item); existing.set(item.id, item);
    }
    const combined = validateTextCollectionDocument({version: 1, items: [...current.items, ...additions]});
    if (encodedBytes(combined) > ST_ACCOUNT_STORAGE_LIMITS.bytes) fail('导入后超过存储上限，未写入内容；请保留原文件。');
    return {document: {version: 1, items: additions}, count: additions.length, skipped};
}
