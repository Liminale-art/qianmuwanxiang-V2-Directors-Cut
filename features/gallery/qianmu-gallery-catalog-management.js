import { createGalleryCatalogStore } from './qianmu-gallery-catalog-store.js';
import { galleryCatalogAccount, galleryCatalogSource, galleryCatalogMaintenanceQuery, GALLERY_CATALOG_LIMITS } from './qianmu-gallery-catalog-contract.js';

const fail = message => Object.assign(new Error(message), { code: 'gallery_catalog_management' });
// Inspection/cleanup only touches derived references. Historical source reads
// require the separate, explicit single-chat export confirmation below.
export async function createGalleryCatalogManagement({ resolveNamespace, isCurrent = () => true, createStore = createGalleryCatalogStore,
    yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)), headers = () => ({}) } = {}) {
    let closed = false, busy = false, store;
    const exportLifetime = new AbortController();
    const plans = new WeakSet();
    const valid = () => !closed && isCurrent() === true;
    if (!valid()) throw fail('资料页面已变化');
    const namespace = galleryCatalogAccount(await resolveNamespace());
    const check = async () => {
        try { if (!valid() || namespace !== await resolveNamespace() || !valid()) throw fail('目录整理账户或页面已变化，请重新打开'); }
        catch (error) { close(); throw error; }
    };
    function close() { closed = true; exportLifetime.abort(); store?.close(); }
    await check(); store = createStore();
    const progress = (callback, value) => { if (callback) callback(Object.freeze({ ...value })); };
    return {
        namespace, close,
        get closed() { return closed; },
        async usage() { await check(); const result = await store.usage(namespace, { isCurrent: valid }); await check(); return result; },
        async scopes(input = {}) { await check(); const result = await store.scopes(namespace, input, { isCurrent: valid }); await check(); return result; },
        async exportHistory(source,save,options={}) {
            if (busy) throw fail('资料正在处理，请稍候');
            const selected=galleryCatalogSource(source),captured={...options}; busy = true;
            try {
                const { exportGalleryHistory } = await import('./qianmu-gallery-history-export.js');
                return await exportGalleryHistory({...captured,namespace,source:selected,save,resolveNamespace,headers,guard:check,parentSignal:exportLifetime.signal});
            } finally { busy = false; }
        },
        async inspect(input = {}, onProgress) {
            if (busy) throw fail('目录整理正在处理，请稍候');
            const query = galleryCatalogMaintenanceQuery(namespace, input);
            if (query.cursor) throw fail('请从完整范围重新盘点');
            const scope = Object.freeze({ ...(query.ownerKey ? { ownerKey: query.ownerKey } : {}), ...(query.chatKey ? { chatKey: query.chatKey } : {}) });
            busy = true;
            try {
                let cursor = null, revision, count = 0, bytes = 0;
                do {
                    await check(); const page = await store.inspectPage(namespace, { ...scope, cursor }, { isCurrent: valid }); await check();
                    if (revision !== undefined && revision !== page.revision) throw fail('目录在盘点期间已变化，请重试');
                    revision = page.revision; count += page.count; bytes += page.bytes; cursor = page.nextCursor;
                    if (count > GALLERY_CATALOG_LIMITS.entries || bytes > GALLERY_CATALOG_LIMITS.bytes) throw fail('目录计值超过边界，请保留资料核对');
                    progress(onProgress, { count, bytes }); if (cursor) await yieldTask();
                } while (cursor);
                const header = await store.usage(namespace, { isCurrent: valid }); await check();
                if (header.revision !== revision || count > header.count || bytes > header.bytes
                    || !query.ownerKey && (count !== header.count || bytes !== header.bytes)) throw fail('目录计值或版本不一致，未允许清理');
                const plan = Object.freeze({ namespace, scope, revision, count, bytes }); plans.add(plan); return plan;
            } finally { busy = false; }
        },
        async clear(plan, { confirmed = false, onProgress } = {}) {
            if (busy || confirmed !== true || !plans.has(plan)) throw fail('请先盘点当前范围并明确确认清除目录引用');
            plans.delete(plan); busy = true;
            let removed = 0, bytes = 0, revision = plan.revision;
            try {
                do {
                    await check();
                    const result = await store.clearScopeBatch(namespace, plan.scope, { expectedRevision: revision, confirmed: true, isCurrent: valid });
                    removed += result.removed; bytes += result.bytes; revision = result.revision;
                    progress(onProgress, { removed, bytes, total: plan.count }); await check();
                    if (removed > plan.count || bytes > plan.bytes || !result.more && (removed !== plan.count || bytes !== plan.bytes)) throw fail('清理计值未确认，请重新盘点');
                    if (!result.more) return { removed, bytes, complete: true };
                    if (!result.removed) throw fail('目录清理没有继续推进，请重新盘点');
                    await yieldTask();
                } while (true);
            } catch (error) {
                throw Object.assign(fail(`清理已中止，已确认移除 ${removed} 条目录引用；最后一批如未确认，请重新盘点。已完成部分不会撤回，原聊天与媒体未修改。${error?.message || ''}`), { removed, bytes });
            } finally { busy = false; }
        },
    };
}

export async function collectGalleryCatalogStorage(options) {
    let session;
    try {
        session = await createGalleryCatalogManagement(options);
        const usage = await session.usage(); return { ...usage, status: 'ready' };
    } finally { session?.close(); }
}
