// 书摘成图稿的备份：当前账户的成图稿、插图与背景原图，加上设置里的方案与自建模板（它们引用同一批图）。
// 文件是 zip：manifest.json（第一个条目，不压缩，带类型标记）、drafts/<n>.json、images/<n>、studio.json。
// 恢复按条合并：同键的稿只有备份里更新（savedAt 更晚）才替换；图按编号补缺；方案与模板补进本机没有的。
import {buildZip, readZipDirectory, zipEntryBlob} from './qianmu-storage-transfer.js?v=1.59.630';
import {parseBoundedJson} from './qianmu-json-input.js';
import {createExcerptStore} from './features/excerpt/qianmu-excerpt-store.js';

export const EXCERPT_BACKUP_TYPE = 'qianmu-excerpt-studio';
const LIMITS = Object.freeze({json: 16 * 1048576, image: 64 * 1048576, depth: 40, nodes: 2000000});
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const json = value => new Blob([JSON.stringify(value)], {type: 'application/json'});
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const imageExt = type => ({'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'})[type] || 'bin';
const fail = message => { throw new Error(message); };

// 删笔记、删书、删收藏时一并删掉对应的稿。失败只记一笔，不打断删除本身。
export async function dropExcerptDrafts({namespace, keys = [], startsWith = '', createStore = createExcerptStore} = {}) {
    if (!namespace || (!keys.length && !startsWith)) return 0;
    const store = createStore({namespace});
    try { return await store.deleteDrafts({keys, startsWith}); }
    finally { store.close(); }
}

export async function exportExcerptBackup({store, studio = null, guard = async () => {}, now = () => new Date()}) {
    const files = [], drafts = [], images = [];
    for await (const {id, blob, w, h} of store.exportImages()) {
        await guard();
        const file = `images/${images.length + 1}.${imageExt(blob.type)}`;
        images.push({id, file, mime: blob.type || 'image/png', w: Number(w) || 0, h: Number(h) || 0});
        files.push({name: file, blob});
    }
    for await (const {key, value} of store.exportDrafts()) {
        await guard();
        const file = `drafts/${drafts.length + 1}.json`;
        drafts.push({key, file});
        files.push({name: file, blob: json(value), deflate: true});
    }
    const settings = record(studio) ? studio : null;
    const hasSettings = !!settings && ['last', 'lastReader'].some(key => settings[key]) || ['schemes', 'templates'].some(key => settings?.[key]?.length);
    if (!drafts.length && !images.length && !hasSettings) return null;
    if (hasSettings) files.push({name: 'studio.json', blob: json(settings), deflate: true});
    const manifest = {type: EXCERPT_BACKUP_TYPE, version: 1, exportedAt: now().toISOString(), studio: hasSettings ? 'studio.json' : null, drafts, images};
    await guard();
    return {blob: await buildZip([{name: 'manifest.json', blob: json(manifest)}, ...files]), drafts: drafts.length, images: images.length};
}

// 只读目录与 manifest，核对每个条目都在、编号不重复。稿和图在恢复时逐条读。
export async function readExcerptBackup(file) {
    if (!file || typeof file.slice !== 'function') fail('不是书摘成图稿的备份。');
    const entries = new Map((await readZipDirectory(file, {invalid: '不是书摘成图稿的备份。', broken: '书摘成图稿备份已损坏。', incomplete: '书摘成图稿备份不完整。'})).map(entry => [entry.name, entry]));
    const read = async (name, label) => {
        const entry = entries.get(name);
        if (!entry) fail(`书摘成图稿备份缺少${label}。`);
        return parseBoundedJson(await (await zipEntryBlob(file, entry, {maxBytes: LIMITS.json})).text(), {maxBytes: LIMITS.json, maxDepth: LIMITS.depth, maxNodes: LIMITS.nodes, label});
    };
    const manifest = await read('manifest.json', '目录');
    if (!record(manifest) || manifest.type !== EXCERPT_BACKUP_TYPE || manifest.version !== 1 || !Array.isArray(manifest.drafts) || !Array.isArray(manifest.images)) fail('不是书摘成图稿的备份。');
    const check = (list, field, label) => {
        const seen = new Set();
        for (const [index, item] of list.entries()) {
            if (!record(item) || !validKey(item[field]) || seen.has(item[field]) || typeof item.file !== 'string' || !entries.has(item.file)) fail(`书摘成图稿备份第 ${index + 1} 份${label}无效。`);
            seen.add(item[field]);
        }
    };
    check(manifest.drafts, 'key', '稿');
    check(manifest.images, 'id', '图');
    if (manifest.studio !== null && manifest.studio !== undefined && (typeof manifest.studio !== 'string' || !entries.has(manifest.studio))) fail('书摘成图稿备份的方案无效。');
    return {manifest, entries, file, read};
}

// 方案、自建模板：补进本机没有的（模板同号时留较新的），不超过上限；「上次的版式」本机没有时才用备份的。
export function mergeExcerptStudioSettings(local, incoming, {schemes: schemeLimit = 50, templates: templateLimit = 30} = {}) {
    const base = record(local) ? structuredClone(local) : {};
    if (!record(incoming)) return base;
    for (const key of ['last', 'lastReader']) if (!base[key] && record(incoming[key])) base[key] = structuredClone(incoming[key]);
    const schemes = Array.isArray(base.schemes) ? base.schemes : [];
    const schemeIds = new Set(schemes.map(item => item?.id));
    for (const item of Array.isArray(incoming.schemes) ? incoming.schemes : []) {
        if (!record(item) || schemeIds.has(item.id) || schemes.length >= schemeLimit) continue;
        schemes.push(structuredClone(item)); schemeIds.add(item.id);
    }
    const templates = Array.isArray(base.templates) ? base.templates : [];
    for (const item of Array.isArray(incoming.templates) ? incoming.templates : []) {
        if (!record(item)) continue;
        const at = templates.findIndex(entry => entry?.id === item.id);
        if (at >= 0) { if (Number(item.updatedAt) > Number(templates[at]?.updatedAt || 0)) templates[at] = structuredClone(item); }
        else if (templates.length < templateLimit) templates.push(structuredClone(item));
    }
    return {...base, schemes, templates};
}

export async function restoreExcerptBackup(pack, {store, studio = null, guard = async () => {}, warn = () => {}}) {
    const result = {added: 0, replaced: 0, kept: 0, images: 0, failed: 0, settings: false};
    const {manifest, entries, file, read} = pack;
    for (const item of manifest.images) {
        await guard();
        try {
            const blob = await zipEntryBlob(file, entries.get(item.file), {type: typeof item.mime === 'string' && /^image\/[\w.+-]+$/.test(item.mime) ? item.mime : 'image/png', maxBytes: LIMITS.image});
            if (await store.importImage(item.id, {blob, w: item.w, h: item.h})) result.images++;
        } catch (error) { result.failed++; warn('excerpt image restore failed', error); }
    }
    for (const item of manifest.drafts) {
        await guard();
        try {
            const value = await read(item.file, '成图稿');
            if (!record(value)) throw new TypeError('draft is not an object');
            result[await store.importDraft(item.key, value)]++;
        } catch (error) { result.failed++; warn('excerpt draft restore failed', error); }
    }
    if (manifest.studio && studio) {
        await guard();
        try {
            const [incoming, {normalizeStudioSettings, SCHEME_LIMIT, TEMPLATE_LIMIT}] = await Promise.all([read(manifest.studio, '方案'), import('./features/excerpt/qianmu-excerpt-doc.js')]);
            await guard();
            studio.write(mergeExcerptStudioSettings(studio.read(), normalizeStudioSettings(incoming), {schemes: SCHEME_LIMIT, templates: TEMPLATE_LIMIT}));
            result.settings = true;
        } catch (error) { result.failed++; warn('excerpt settings restore failed', error); }
    }
    return result;
}

export function excerptRestoreText(result) {
    const drafts = result.added + result.replaced;
    return `已导入 ${drafts} 份成图稿、${result.images} 张图${result.kept ? `；${result.kept} 份本机的更新，未替换` : ''}${result.failed ? `；${result.failed} 项未能导入` : ''}。`;
}
