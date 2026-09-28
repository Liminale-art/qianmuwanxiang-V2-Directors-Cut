import {createStAccountStorage} from './qianmu-st-account-storage.js';
import {createDocumentSession} from './qianmu-document-session.js';
import {createTextCollection} from './qianmu-text-collection.js';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.403';

const expired = () => Object.assign(new Error('收藏操作已结束，请重新打开。'), {code: 'text_collection_owner'});
const sameSource = (a, b) => !!a && !!b && a.chatId === b.chatId && a.messageId === b.messageId;

// One account document per page. Hiding a view, changing a chat, and opening the
// hive do not retire it. No outbox, directory cache, retry loop or host writes.
export function createTextCollectionOwner({resolveNamespace, isCurrent, headers,
    storeFactory = createStAccountStorage,
    viewFactory = async options => (await loadLocalChunk('./qianmu-text-collection-view.js')).createTextCollectionView(options),
    document = globalThis.document, window = document?.defaultView,
    mountPortal, onChange = () => {}, notify = () => {}, typography = () => {},
} = {}) {
    if (typeof resolveNamespace !== 'function' || typeof isCurrent !== 'function' || typeof headers !== 'function') {
        throw new TypeError('Collection owner requires the ST account and page lifetime');
    }
    let active = null, preparing = null, disposed = false, action = 0;
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
                const actual = await resolveNamespace();
                if (actual !== namespace) { retire(record); throw expired(); }
                if (!record.valid()) throw expired();
                return actual;
            };
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
                    signal: record.controller.signal, mountPortal, typography});
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
    function dispose() {
        if (disposed) return;
        disposed = true; action++; retire(active);
        window?.removeEventListener?.('pagehide', dispose);
    }
    window?.addEventListener?.('pagehide', dispose);
    return Object.freeze({warm, open, toggle, chatChanged, dispose,
        get disposed() { return disposed; },
        floorItems: () => structuredClone(active?.links || []),
        state: () => active?.snapshot ? structuredClone(active.snapshot) : null});
}
