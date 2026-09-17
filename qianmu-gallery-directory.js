import { createGalleryCatalogStore } from './qianmu-gallery-catalog-store.js';
import { projectGalleryCatalogEntry, galleryCatalogSource, galleryCatalogAccount } from './qianmu-gallery-catalog-contract.js';
import { createCurrentChatGalleryReceiptClient, createChatGalleryReceiptClient, createChatGalleryRecordClient } from './qianmu-chat-character-receipt-client.js';
import { loadGalleryPreviewImage } from './qianmu-gallery-preview-media.js';
import { chatGalleryReceiptText } from './qianmu-chat-gallery-receipt.js';
import { chatFileTarget } from './qianmu-chat-file-target.js';

// Only the existing still-record family is projected. Unknown/invalid metadata
// stays in its original chat; no fallback timestamp, truncated tags or URL inference.
export function projectGalleryDirectorySnapshot(namespace, source, records) {
    namespace = galleryCatalogAccount(namespace); source = galleryCatalogSource(source);
    const snapshot = chatGalleryReceiptText(records), entries = [], ids = new Set();
    let skipped = 0;
    for (const row of snapshot ? JSON.parse(snapshot.text) : []) {
        let entry;
        try { entry = projectGalleryCatalogEntry(namespace, source, { id: row.id, kind: 'still', createdAt: row.createdAt, tags: row.tags }); }
        catch (_) { skipped++; continue; }
        if (ids.has(entry.recordId)) throw Error('静帧编号重复，请先核对原聊天；本次未更新目录');
        ids.add(entry.recordId); entries.push({ id: entry.recordId, kind: entry.kind, createdAt: entry.createdAt, tags: entry.tags });
    }
    return { snapshot, entries, skipped };
}

export function galleryDirectoryTarget(source) {
    const value = galleryCatalogSource(source);
    return chatFileTarget(value.ownerKey.startsWith('char:')
        ? { kind: 'character', avatar: value.ownerKey.slice(5), chatId: value.chatKey }
        : { kind: 'group', chatId: value.chatKey });
}

export async function createGalleryDirectorySession({ getContext, epoch, guard = async () => {},
    createClient = createCurrentChatGalleryReceiptClient, createStore = createGalleryCatalogStore,
    createHistoricalClient = createChatGalleryReceiptClient, createRecordClient = createChatGalleryRecordClient,
    loadImage = loadGalleryPreviewImage } = {}) {
    const client = await createClient({ getContext, epoch, guard });
    let closed = false, store, updating = false;
    const readers = new Set(), mediaController = new AbortController(), namespace = client.owner.namespace, source = client.source;
    const current = () => { if (closed) throw Error('图库目录已关闭'); client.assertCurrent(); return true; };
    function close() { closed = true; mediaController.abort(); client.close(); for (const reader of readers) reader.close(); readers.clear(); store?.close(); }
    const check = async () => {
        try { current(); await client.guard(); current(); await guard(); current(); }
        catch (error) { close(); throw error; }
    };
    try { await check(); store = createStore(); } catch (error) { client.close(); throw error; }
    const records = () => getContext()?.chatMetadata?.story_director_liminale?.storyboardImages;
    const same = captured => { current(); if (chatGalleryReceiptText(records())?.text !== captured?.text) throw Error('静帧记录已变化，目录仅保留先前已收录的引用，请重新更新'); };
    return {
        namespace, source, assertCurrent: current,
        async refresh() {
            if (updating) throw Error('目录正在更新'); updating = true;
            try {
                await check();
                const projected = projectGalleryDirectorySnapshot(namespace, source, records());
                const receipt = await client.verify(projected.snapshot ? JSON.parse(projected.snapshot.text) : undefined);
                await check(); same(projected.snapshot);
                if (!receipt.matches) throw Error('当前静帧尚未与服务器保存内容一致，未更新目录；请保存聊天后重试');
                let revision = (await store.page(namespace, { limit: 1 }, { isCurrent: current })).revision, changed = 0;
                for (let at = 0; at < projected.entries.length; at += 200) {
                    await check(); same(projected.snapshot);
                    const result = await store.upsert(namespace, source, projected.entries.slice(at, at + 200), { expectedRevision: revision, isCurrent: current });
                    revision = result.revision; changed += result.changed;
                    // Let the host and cancellation events run between bounded batches.
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                await check(); same(projected.snapshot);
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
                const result = await recordReader.read({ recordId: row.recordId, createdAt: row.createdAt, gallerySha256: receipt.gallery.sha256 }); await check();
                const media = await loadImage(result.record.url, { guard: check, signal: mediaController.signal }); await check();
                return { ...media, record: result.record, source: selected };
            } finally { readers.delete(receiptReader); readers.delete(recordReader); receiptReader.close(); recordReader.close(); }
        },
        close,
    };
}
