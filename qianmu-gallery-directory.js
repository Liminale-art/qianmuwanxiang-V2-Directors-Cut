import { createGalleryCatalogStore } from './qianmu-gallery-catalog-store.js';
import { projectGalleryCatalogEntry, galleryCatalogSource, galleryCatalogAccount } from './qianmu-gallery-catalog-contract.js';
import { createCurrentChatGalleryReceiptClient, createChatGalleryReceiptClient, createChatGalleryRecordClient, createChatGalleryDetailsClient } from './qianmu-chat-character-receipt-client.js';
import { loadGalleryPreviewImage } from './qianmu-gallery-preview-media.js';
import { scanChatGallery, galleryDigestRow } from './qianmu-chat-gallery-digest.js';
import { chatFileTarget } from './qianmu-chat-file-target.js';

// Only the existing still-record family is projected. Unknown/invalid metadata
// stays in its original chat; no fallback timestamp, truncated tags or URL inference.
export async function projectGalleryDirectorySnapshot(namespace, source, records, options = {}) {
    namespace = galleryCatalogAccount(namespace); source = galleryCatalogSource(source);
    const entries = [], fingerprints = new Map();
    let skipped = 0;
    const snapshot = records === undefined ? null : await scanChatGallery(records, { ...options, visit(record, index) {
        const row = record.value;
        let entry;
        try { entry = projectGalleryCatalogEntry(namespace, source, { id: row.id, kind: 'still', createdAt: row.createdAt, tags: row.tags }); }
        catch (_) { skipped++; return; }
        if (fingerprints.has(entry.recordId)) throw Error('静帧编号重复，请先核对原聊天；本次未更新目录');
        fingerprints.set(entry.recordId, { index, sha256: record.sha256 });
        entries.push({ id: entry.recordId, kind: entry.kind, createdAt: entry.createdAt, tags: entry.tags });
    } });
    return { snapshot, entries, skipped, fingerprints };
}

const sameSummary = (left, right) => left === null || right === null ? left === right
    : ['count', 'bytes', 'sha256'].every(key => left?.[key] === right?.[key]);

export function galleryDirectoryTarget(source) {
    const value = galleryCatalogSource(source);
    return chatFileTarget(value.ownerKey.startsWith('char:')
        ? { kind: 'character', avatar: value.ownerKey.slice(5), chatId: value.chatKey }
        : { kind: 'group', chatId: value.chatKey });
}

export async function createGalleryDirectorySession({ getContext, epoch, guard = async () => {},
    createClient = createCurrentChatGalleryReceiptClient, createStore = createGalleryCatalogStore,
    createHistoricalClient = createChatGalleryReceiptClient, createRecordClient = createChatGalleryRecordClient,
    createDetailsClient = createChatGalleryDetailsClient, loadImage = loadGalleryPreviewImage } = {}) {
    const client = await createClient({ getContext, epoch, guard });
    let closed = false, store, updating = false, exporting = false, previews = new WeakMap();
    const saving = new WeakSet();
    const readers = new Set(), mediaController = new AbortController(), namespace = client.owner.namespace, source = client.source;
    const current = () => { if (closed) throw Error('图库目录已关闭'); client.assertCurrent(); return true; };
    function close() { closed = true; previews = new WeakMap(); mediaController.abort(); client.close(); for (const reader of readers) reader.close(); readers.clear(); store?.close(); }
    const check = async () => {
        try { current(); await client.guard(); current(); await guard(); current(); }
        catch (error) { close(); throw error; }
    };
    try { await check(); store = createStore(); } catch (error) { client.close(); throw error; }
    const records = () => getContext()?.chatMetadata?.story_director_liminale?.storyboardImages;
    return {
        namespace, source, assertCurrent: current,
        async refresh() {
            if (updating) throw Error('目录正在更新'); updating = true;
            try {
                await check();
                const captured = records(), length = captured?.length;
                const changedSource = () => { throw Error('静帧记录已变化，目录仅保留先前已收录的引用，请重新更新'); };
                const scope = () => { current(); if (records() !== captured || captured?.length !== length) changedSource(); return true; };
                const projected = await projectGalleryDirectorySnapshot(namespace, source, captured, { guard: scope });
                const same = async () => {
                    scope(); const summary = captured === undefined ? null : await scanChatGallery(captured, { guard: scope });
                    await check(); scope(); if (!sameSummary(summary, projected.snapshot)) changedSource();
                };
                const saved = async () => {
                    const receipt = await client.inspect(); await check(); scope();
                    if (!(projected.snapshot === null ? receipt.state === 'absent' : receipt.state === 'present' && sameSummary(receipt.gallery, projected.snapshot)))
                        throw Error('当前静帧尚未与服务器保存内容一致，目录只保留已收录引用；请保存聊天后重试');
                };
                await saved(); await same();
                let revision = (await store.page(namespace, { limit: 1 }, { isCurrent: current })).revision, changed = 0;
                for (let at = 0; at < projected.entries.length; at += 200) {
                    await check(); scope();
                    const batch = projected.entries.slice(at, at + 200), expected = batch.map(row => projected.fingerprints.get(row.id));
                    const selected = expected.map(item => galleryDigestRow(captured, item.index));
                    const batchScope = () => { scope(); if (expected.some((item, index) => galleryDigestRow(captured, item.index) !== selected[index])) changedSource(); return true; };
                    // Only this batch is rehashed, not the complete library for every write.
                    // A final complete scan catches edits to rows outside or behind it.
                    await scanChatGallery(selected, { guard: batchScope, visit(record, index) { if (record.sha256 !== expected[index].sha256) changedSource(); } });
                    await check(); batchScope();
                    const result = await store.upsert(namespace, source, batch, { expectedRevision: revision, isCurrent: batchScope });
                    revision = result.revision; changed += result.changed;
                    // Let the host and cancellation events run between bounded batches.
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                await saved(); await same();
                return { indexed: projected.entries.length, skipped: projected.skipped, changed, revision };
            } finally { updating = false; }
        },
        async scopes(input = {}) { await check(); const result = await store.scopes(namespace, input, { isCurrent: current }); await check(); return result; },
        async page(input = {}) { await check(); const result = await store.page(namespace, input, { isCurrent: current }); await check(); return result; },
        async inspectSource(selected) {
            await check(); const target = galleryDirectoryTarget(selected);
            const reader = createHistoricalClient({ namespace, target, headers: () => getContext().getRequestHeaders?.() || {}, guard: check });
            readers.add(reader);
            try { const receipt = await reader.inspect(); await check(); return receipt; }
            finally { readers.delete(reader); reader.close(); }
        },
        async locate(row) {
            await check();
            if (row.namespace !== namespace || row.ownerKey !== source.ownerKey || row.chatKey !== source.chatKey) throw Error('请先在 ST 打开这个角色的对应聊天，再查看原画面');
            const matches = (records() || []).filter(item => item?.id === row.recordId);
            if (matches.length !== 1 || matches[0].createdAt !== row.createdAt) throw Error('原画面记录已变化或不存在；历史目录引用保留，未自动删除');
            return matches[0];
        },
        async preview(row) {
            await check();
            if (row.namespace !== namespace || row.kind !== 'still') throw Error('画面属于另一账户或不支持此类型');
            const selected = { ownerKey: row.ownerKey, chatKey: row.chatKey }, target = galleryDirectoryTarget(selected);
            const receiptReader = createHistoricalClient({ namespace, target, headers: () => getContext().getRequestHeaders?.() || {}, guard: check });
            const recordReader = createRecordClient({ namespace, target, headers: () => getContext().getRequestHeaders?.() || {}, guard: check });
            readers.add(receiptReader); readers.add(recordReader);
            try {
                const receipt = await receiptReader.inspect(); await check();
                if (receipt.state !== 'present') throw Error('原聊天没有静帧记录；历史目录引用保留');
                const selection = { recordId: row.recordId, createdAt: row.createdAt, gallerySha256: receipt.gallery.sha256 };
                const result = await recordReader.read(selection); await check();
                const media = await loadImage(result.record.url, { guard: check, signal: mediaController.signal }); await check();
                const record = Object.freeze({ ...result.record, tags: Object.freeze([...result.record.tags]) });
                const preview = Object.freeze({ ...media, record, source: Object.freeze(selected) });
                previews.set(preview, { target, selection, recordText: JSON.stringify(record), blob: media.blob });
                return preview;
            } finally { readers.delete(receiptReader); readers.delete(recordReader); receiptReader.close(); recordReader.close(); }
        },
        releasePreview(preview) { previews.delete(preview); },
        async previewDetails(preview, { signal } = {}) {
            const captured = previews.get(preview);
            if (!captured) throw Error('此预览已关闭或不是本次读取的原图，请重新打开');
            const verify = async () => { await check(); if (signal?.aborted || previews.get(preview) !== captured) throw Error('画面详情读取已取消'); };
            await verify();
            const reader = createDetailsClient({ namespace, target: captured.target, headers: () => getContext().getRequestHeaders?.() || {}, guard: verify });
            readers.add(reader);
            try { const result = await reader.read(captured.selection, { signal }); await verify(); return result.record.generation; }
            finally { readers.delete(reader); reader.close(); }
        },
        async exportOriginals(rows, save, options = {}) {
            if (exporting) throw Error('正在导出所选原图，请稍候'); exporting = true;
            try {
                await check(); const { exportGalleryOriginals } = await import('./qianmu-gallery-original-export.js'); await check();
                return await exportGalleryOriginals({ ...options, namespace, rows, target: galleryDirectoryTarget, save, guard: check,
                    headers: () => getContext().getRequestHeaders?.() || {}, parentSignal: mediaController.signal,
                    createHistoricalClient, createRecordClient, loadImage });
            } finally { exporting = false; }
        },
        async savePreview(preview, save) {
            const captured = previews.get(preview);
            if (!captured || typeof save !== 'function') throw Error('此预览已关闭或不是当前会话读取的原图，请重新打开');
            if (saving.has(preview)) throw Error('正在核对并保存这张原图，请稍候');
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[captured.blob?.type];
            if (!extension || !captured.blob.size) throw Error('预览原图格式不完整，未保存');
            const verify = async () => { await check(); if (previews.get(preview) !== captured) throw Error('原图预览已关闭，未继续保存'); };
            saving.add(preview); let reader;
            try {
                await verify();
                reader = createRecordClient({ namespace, target: captured.target, headers: () => getContext().getRequestHeaders?.() || {}, guard: verify });
                readers.add(reader);
                const result = await reader.read(captured.selection); await verify();
                if (JSON.stringify(result.record) !== captured.recordText) throw Error('原画面来源已变化，请重新打开后保存');
                // Save the exact bytes already decoded for this preview, not a screenshot,
                // a second media response, or a supposedly restorable chat/configuration pack.
                const filename = `qianmu-still-${captured.selection.createdAt}.${extension}`;
                await save(captured.blob, filename);
                return { filename, bytes: captured.blob.size };
            } finally { saving.delete(preview); if (reader) { readers.delete(reader); reader.close(); } }
        },
        close,
    };
}
