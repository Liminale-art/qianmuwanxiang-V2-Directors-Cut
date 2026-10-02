import {createStAccountStorage} from './qianmu-st-account-storage.js';
import {createDocumentSession} from './qianmu-document-session.js';
import {createTextCollection, documentFromTextCollectionState} from './qianmu-text-collection.js';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.425';
import {createTextCollectionBackup, readTextCollectionBackup, prepareTextCollectionRestore} from './qianmu-text-collection-backup.js';

const expired = () => Object.assign(new Error('收藏操作已结束，请重新打开。'), {code: 'text_collection_owner'});
const sameSource = (a, b) => !!a && !!b && a.chatId === b.chatId && a.messageId === b.messageId;

// One account document per page. Hiding a view, changing a chat, and opening the
// hive do not retire it. No outbox, directory cache, retry loop or host writes.
export function createTextCollectionOwner({resolveNamespace, isCurrent, headers,
    storeFactory = createStAccountStorage,
    viewFactory = async options => (await loadLocalChunk('./qianmu-text-collection-view.js?v=1.59.419')).createTextCollectionView(options),
    document = globalThis.document, window = document?.defaultView,
    mountPortal, onChange = () => {}, notify = () => {}, typography = () => {},
    origin = globalThis.location?.origin, confirm, download,
} = {}) {
    if (typeof resolveNamespace !== 'function' || typeof isCurrent !== 'function' || typeof headers !== 'function') {
        throw new TypeError('Collection owner requires the ST account and page lifetime');
    }
    let active = null, preparing = null, disposed = false, action = 0, transferring = false;
    const live = () => !disposed && isCurrent() === true;
    const check = () => { if (!live()) throw expired(); };
    const publish = () => { try { onChange(active?.snapshot ?? null); } catch (error) { console.error('Collection presentation failed', error); } };
    function retire(record) {
        if (!record || record.closed) return;
        record.closed = true; record.controller.abort(); record.unsubscribe?.();
        record.view?.dispose(); record.session?.dispose(); record.store?.close();
        if (active === record) { active = null; publish(); }
    }
    async function ensure() {
        check();
        if (preparing) return preparing;
        const pending = (async () => {
            const namespace = await resolveNamespace(); check();
            if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace)) throw expired();
            if (active && active.namespace !== namespace) retire(active);
            if (active) return active;
            const record = {namespace, closed: false, controller: new AbortController(), snapshot: null};
            active = record;
            record.valid = () => live() && active === record && !record.closed;
            const resolveOwned = async () => {
                if (!record.valid()) throw expired();
                record.transferCheck?.();
                const actual = await resolveNamespace();
                if (actual !== namespace) { retire(record); throw expired(); }
                if (!record.valid()) throw expired();
                record.transferCheck?.();
                return actual;
            };
            record.verifyAccount = resolveOwned;
            try {
                record.store = await storeFactory({resolveNamespace: resolveOwned, isCurrent: record.valid, headers, documentLayout: 'snapshot'});
                if (!record.valid()) { record.store.close(); throw expired(); }
                record.session = createDocumentSession({store: record.store, slot: 'text-collection', isCurrent: record.valid});
                record.collection = createTextCollection({session: record.session});
                record.unsubscribe = record.collection.subscribe(value => {
                    if (!record.valid()) return;
                    record.snapshot = value;
                    // Floor controls need only confirmed IDs and weak links, not
                    // a fresh clone of every passage on each host render.
                    if (value.loaded && (!record.links || record.linkFingerprint !== value.fingerprint)) {
                        record.links = value.items.map(({id, source}) => ({id, source}));
                        record.linkFingerprint = value.fingerprint; publish();
                    }
                });
                return record;
            } catch (error) { retire(record); throw error; }
        })();
        preparing = pending;
        try { return await pending; } finally { if (preparing === pending) preparing = null; }
    }
    async function viewFor(record) {
        if (!record.valid()) throw expired();
        if (record.view) { typography(record.view.parent); return record.view; }
        if (!record.viewPromise) {
            record.viewPromise = (async () => {
                const view = await viewFactory({document, collection: record.collection, isCurrent: record.valid,
                    signal: record.controller.signal, mountPortal, typography, verifyAccount: record.verifyAccount, download});
                if (!record.valid()) { view.dispose(); throw expired(); }
                record.view = view; return view;
            })().finally(() => { record.viewPromise = null; });
        }
        return record.viewPromise;
    }
    function report(error) {
        if (live() && error?.code !== 'text_collection_owner') notify('收藏未能完成，请重试。', 'warning');
    }
    async function warm() {
        try { const record = await ensure(); await record.collection.open(); return record.valid(); }
        catch { return false; } // A silent pre-read never announces an empty or saved library.
    }
    async function open() {
        const request = ++action;
        try {
            const record = await ensure();
            const view = await viewFor(record);
            if (!record.valid() || request !== action) return false;
            view.capture.close();
            return await view.panel.open();
        } catch (error) { report(error); return false; }
    }
    async function toggle(input, validCapture = () => true, intent = 'collect') {
        // Freeze the visible text and names at the explicit click, not after I/O.
        const captured = structuredClone(input), request = ++action, expectedNamespace = active?.namespace;
        try {
            if (transferring) throw busyError();
            if (!['collect', 'remove'].includes(intent)) throw new TypeError('Collection intent is required');
            const record = await ensure();
            if (expectedNamespace && record.namespace !== expectedNamespace) return false;
            await record.collection.open();
            if (!record.valid() || request !== action || !validCapture()) return false;
            const snapshot = record.collection.state();
            if (snapshot.needsRefresh) {
                // Unknown acknowledgement is reconciled only on this explicit
                // action. Never replay the old write automatically.
                await record.collection.refresh();
                if (!record.valid() || request !== action || !validCapture()) return false;
            }
            const current = record.collection.state();
            const ids = current.items.filter(item => sameSource(item.source, captured.source)).map(item => item.id);
            if (intent === 'remove') {
                if (ids.length) await record.collection.remove(ids, {expectedFingerprint: current.fingerprint});
                return record.valid();
            }
            // Reconciliation confirms a previous add, never turns an empty-star
            // click into a deletion. Likewise, an already-completed removal
            // above cannot reopen the capture chooser.
            if (snapshot.needsRefresh && ids.length) return record.valid();
            const view = await viewFor(record);
            if (!record.valid() || request !== action || !validCapture()) return false;
            return view.capture.open(captured);
        } catch (error) { report(error); return false; }
    }
    function chatChanged() { action++; active?.view?.capture.close(); }
    const busy = () => transferring || ['loading', 'refreshing', 'saving'].includes(active?.snapshot?.phase);
    const busyError = () => Object.assign(new Error('请等待当前收藏操作完成。'), {code: 'text_collection_busy'});
    function preserveDraft(record, value) {
        const draft = record.session.state().draft;
        if (draft && JSON.stringify(draft.value) !== JSON.stringify(value)) {
            throw Object.assign(new Error('尚有未保存的收藏，请先保留或完成保存。'), {code: 'text_collection_pending'});
        }
    }
    async function transfer(run, externalCheck = () => {}) {
        if (busy()) throw busyError();
        check(); externalCheck(); transferring = true;
        const expectedNamespace = active?.namespace;
        let record;
        try {
            record = await ensure(); externalCheck();
            if (expectedNamespace && record.namespace !== expectedNamespace) throw expired();
            record.transferCheck = externalCheck;
            const verify = async () => { check(); externalCheck(); await record.verifyAccount(); check(); externalCheck(); };
            await verify();
            if (['loading', 'refreshing', 'saving'].includes(record.collection.state().phase)) throw busyError();
            return await run(record, verify);
        } finally { if (record) record.transferCheck = null; transferring = false; }
    }
    async function exportBackup() {
        return transfer(async (record, verify) => {
            if (typeof download !== 'function') throw new TypeError('Collection download is unavailable');
            const current = await record.collection.refresh(); await verify();
            const payload = createTextCollectionBackup(documentFromTextCollectionState(current), {origin, scope: record.store.scope});
            const blob = new Blob([JSON.stringify(payload)], {type: 'application/json'});
            await verify();
            await download(blob, `qianmu-text-collection-${payload.exportedAt.replaceAll(':', '-')}.json`);
            notify(`已导出 ${current.items.length} 条正文收藏。`, 'success');
            return {status: 'exported', count: current.items.length};
        });
    }
    async function importBackup(file) {
        return transfer(async (record, verify) => {
            const payload = await readTextCollectionBackup(file); await verify();
            const current = await record.collection.refresh(); await verify();
            const restored = await prepareTextCollectionRestore(payload, documentFromTextCollectionState(current), {origin, scope: record.store.scope});
            await verify();
            if (!restored.changed) { notify('这些收藏已存在，无需重复导入。', 'info'); return {status: 'imported', count: 0, skipped: restored.skipped}; }
            preserveDraft(record, restored.combined);
            if (typeof confirm !== 'function') throw new TypeError('Collection confirmation is unavailable');
            const accepted = await confirm('导入正文收藏', `将导入 ${restored.count} 条收藏及文件夹，不覆盖已有内容。是否继续？`);
            await verify(); if (accepted !== true) return {status: 'cancelled'};
            // A different edit can fail while confirmation/account checks wait.
            // Recheck immediately before mutation, without replacing its draft.
            preserveDraft(record, restored.combined);
            await record.collection.restore(restored.document, {expectedFingerprint: current.fingerprint});
            await verify();
            notify(`已导入 ${restored.count} 条正文收藏。`, 'success');
            return {status: 'imported', count: restored.count, skipped: restored.skipped};
        });
    }
    async function clear({expectedFingerprint, confirmed = false, check: externalCheck = () => {}} = {}) {
        return transfer(async (record, verify) => {
            const current = await record.collection.refresh(); await verify();
            if (expectedFingerprint !== undefined && expectedFingerprint !== current.fingerprint) {
                throw Object.assign(new Error('收藏已有更新，请重新选择。'), {code: 'text_collection_conflict'});
            }
            if (!current.items.length && !current.organization.folders.length) return {status: 'cleared', count: 0};
            const cleared = current.version === 1 ? {version: 1, items: []} : {version: 2, items: [], organization: {folders: [], entries: []}};
            preserveDraft(record, cleared);
            if (confirmed !== true) {
                if (typeof confirm !== 'function') throw new TypeError('Collection confirmation is unavailable');
                const accepted = await confirm('清空正文收藏', `将删除当前账户的 ${current.items.length} 条收藏及全部文件夹，无法撤回。是否继续？`);
                await verify(); if (accepted !== true) return {status: 'cancelled'};
            }
            await verify();
            preserveDraft(record, cleared);
            await record.collection.clear({expectedFingerprint: current.fingerprint});
            await verify();
            notify('正文收藏已清空。', 'success');
            return {status: 'cleared', count: current.items.length};
        }, externalCheck);
    }
    async function summary(valid = () => true) {
        return transfer(async (record, verify) => {
            const current = await record.collection.refresh(); await verify();
            return {status: 'ready', namespace: record.namespace, count: current.items.length,
                bytes: new TextEncoder().encode(JSON.stringify(documentFromTextCollectionState(current))).length,
                fingerprint: current.fingerprint};
        }, () => { if (valid() !== true) throw expired(); });
    }
    function dispose() {
        if (disposed) return;
        disposed = true; action++; retire(active);
        window?.removeEventListener?.('pagehide', dispose);
    }
    window?.addEventListener?.('pagehide', dispose);
    return Object.freeze({warm, open, toggle, chatChanged, dispose, exportBackup, importBackup, clear, summary,
        get busy() { return busy(); },
        get disposed() { return disposed; },
        floorItems: () => structuredClone(active?.links || []),
        state: () => active?.snapshot ? structuredClone(active.snapshot) : null});
}
