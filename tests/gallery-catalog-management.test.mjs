import test from 'node:test';
import assert from 'node:assert/strict';
import { createGalleryCatalogManagement, collectGalleryCatalogStorage } from '../qianmu-gallery-catalog-management.js';
import { galleryCatalogMaintenanceQuery as query } from '../qianmu-gallery-catalog-contract.js';
import { renderStorageBackupSection } from '../qianmu-storage-backup-view.js';
import vm from 'node:vm';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const ns = 'st-user:fixture', source = { ownerKey: 'char:A.png', chatKey: 'same' };
function fixture(overrides = {}) {
    let current = ns, valid = true, closed = 0, writes = 0;
    const store = { close() { closed++; }, async usage() { return { namespace: ns, count: 2, bytes: 20, revision: 1 }; },
        async inspectPage() { return { count: 2, bytes: 20, revision: 1, nextCursor: null }; },
        async clearScopeBatch() { writes++; return { namespace: ns, removed: 2, bytes: 20, revision: 2, more: false }; }, ...overrides };
    return { store, options: { resolveNamespace: async () => current, isCurrent: () => valid, createStore: () => store, yieldTask: async () => {} },
        account(value) { current = value; }, invalidate() { valid = false; }, get writes() { return writes; }, get closed() { return closed; } };
}
test('maintenance scope accepts only exact account/owner/chat, includes both kinds and binds cursors', () => {
    assert.deepEqual(query(ns).prefix, [ns]); assert.deepEqual(query(ns, source).prefix, [ns, source.ownerKey, source.chatKey]);
    const q = query(ns, source), cursor = { version: 1, signature: q.signature, revision: 1, after: [...q.prefix, 'id'] };
    assert.deepEqual(query(ns, { ...source, cursor }).cursor, cursor);
    for (const input of [{ chatKey: 'same' }, { ownerKey: 'A' }, { kind: 'still' }, { ownerKey: 'char:../x' }, { ...source, cursor: { ...cursor, after: [ns,'char:B.png','same','id'] } }, { ...source, cursor: { ...cursor, revision: -1 } }]) assert.throws(() => query(ns, input));
    assert.throws(() => query('st-user:other', { ...source, cursor }));
});
test('inventory releases its store and returns exact account metadata only', async () => {
    const f = fixture(); assert.deepEqual(await collectGalleryCatalogStorage(f.options), { namespace: ns, count: 2, bytes: 20, revision: 1, status: 'ready' }); assert.equal(f.closed, 1); assert.equal(f.writes, 0);
});
test('inspection yields between bounded pages and checks final counts and revision', async () => {
    let calls = 0, yields = 0; const updates = [];
    const f = fixture({ async inspectPage(_ns, input) { calls++; return calls === 1 ? { count: 1, bytes: 10, revision: 1, nextCursor: { next: true } } : (assert.ok(input.cursor), { count: 1, bytes: 10, revision: 1, nextCursor: null }); } });
    const session = await createGalleryCatalogManagement({ ...f.options, yieldTask: async () => { yields++; } });
    const plan = await session.inspect({}, value => updates.push(value.count));
    assert.equal(plan.count, 2); assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.scope)); assert.deepEqual(updates, [1,2]); assert.equal(yields, 1); session.close();
});
test('clear requires the exact session-issued plan, explicit consent and one-time use', async () => {
    const f = fixture(), session = await createGalleryCatalogManagement(f.options), plan = await session.inspect(source);
    await assert.rejects(session.clear(plan)); await assert.rejects(session.clear({ ...plan }, { confirmed: true })); assert.equal(f.writes, 0);
    assert.deepEqual(await session.clear(plan, { confirmed: true }), { removed: 2, bytes: 20, complete: true });
    await assert.rejects(session.clear(plan, { confirmed: true })); assert.equal(f.writes, 1); session.close();
});
test('account and view changes reject prior plans without starting deletion', async () => {
    for (const change of [f => f.account('st-user:other'), f => f.invalidate()]) {
        const f = fixture(), session = await createGalleryCatalogManagement(f.options), plan = await session.inspect(); change(f);
        await assert.rejects(session.clear(plan, { confirmed: true }), /已中止/); assert.equal(f.writes, 0); session.close();
    }
});
test('header mismatch, changing revision and corrupt totals never issue a deletion plan', async () => {
    for (const patch of [{ count: 3 }, { bytes: 19 }, { revision: 2 }]) {
        const f = fixture({ async usage() { return { namespace: ns, count: 2, bytes: 20, revision: 1, ...patch }; } }), session = await createGalleryCatalogManagement(f.options);
        await assert.rejects(session.inspect(), /计值或版本/); assert.equal(f.writes, 0); session.close();
    }
});
test('partial batches report confirmed progress and do not silently retry conflicts', async () => {
    let calls = 0; const f = fixture({ async clearScopeBatch(_ns, selected, options) {
        assert.deepEqual(selected, source); assert.equal(options.confirmed, true); calls++;
        if (calls === 1) { assert.equal(options.expectedRevision, 1); return { removed: 1, bytes: 10, revision: 2, more: true }; }
        assert.equal(options.expectedRevision, 2); throw Error('concurrent update');
    } });
    const session = await createGalleryCatalogManagement(f.options), plan = await session.inspect(source), updates = [];
    await assert.rejects(session.clear(plan, { confirmed: true, onProgress: p => updates.push(p.removed) }), error => error.removed === 1 && /不会撤回/.test(error.message));
    assert.deepEqual(updates, [1]); assert.equal(calls, 2); await assert.rejects(session.clear(plan, { confirmed: true })); session.close();
});
test('cancellation between batches keeps committed count and stops future writes', async () => {
    let calls = 0; const f = fixture({ async clearScopeBatch() { calls++; return { removed: 1, bytes: 10, revision: 2, more: true }; } });
    const session = await createGalleryCatalogManagement({ ...f.options, yieldTask: async () => session.close() }), plan = await session.inspect();
    await assert.rejects(session.clear(plan, { confirmed: true }), error => error.removed === 1); assert.equal(calls, 1);
});
test('busy inspection prevents overlapping deletion and second inspection', async () => {
    let release; const f = fixture({ inspectPage: () => new Promise(resolve => release = resolve) }), session = await createGalleryCatalogManagement(f.options);
    const pending = session.inspect(); await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(session.inspect(), /正在处理/); await assert.rejects(session.clear({}, { confirmed: true }));
    release({ count: 2, bytes: 20, revision: 1, nextCursor: null }); await pending; session.close();
});
test('data manager lists catalog once, does not pretend it contains media and preserves unavailable state', () => {
    const html = renderStorageBackupSection(null, n => `${n} B`, { data: { galleryCatalogStorage: { status: 'ready', count: 3, bytes: 90 } } });
    assert.equal((html.match(/sd-storage-gallery-catalog/g) || []).length, 1); assert.match(html, /3 条引用/); assert.match(html, /不含图片、影片原件/);
    const missing = renderStorageBackupSection(null, String, { data: { galleryCatalogStorage: { status: 'unavailable', bytes: null, error: '<script>unavailable</script>' } } });
    assert.match(missing, /当前总计不含此部分/); assert.doesNotMatch(missing, /<script>/);
});
test('actual inventory counts catalog once, preserves unavailable status and rechecks account', async () => {
    const code = section('collectStorageInventory');
    const empty = () => ({ status: 'ready', count: 0, bytes: 0, documents: { count: 0, bytes: 0 }, bindings: { count: 0, bytes: 0 }, assets: { count: 0, bytes: 0 }, previews: { count: 0, bytes: 0 }, records: { count: 0, bytes: 0 }, metadata: { assetBytes: 0, ledgerBytes: 0 } });
    for (const unavailable of [false, true]) {
        let calls = 0;
        const module = new Proxy({}, { get: (_target, name) => name === 'then' ? undefined : name === 'resolveImageAccountNamespace' ? async () => ns : name === 'collectGalleryCatalogStorage' ? async options => {
            calls++; assert.equal(await options.resolveNamespace(), ns); assert.equal(options.isCurrent(), true);
            if (unavailable) throw Error('fixture unavailable'); return { namespace: ns, status: 'ready', count: 3, bytes: 90 };
        } : name === 'collectRecipeArchiveStorage' ? async () => ({namespace:ns,status:'ready',files:2,bytes:12345678}) : async () => empty() });
        const context = vm.createContext({ settings: {}, storyboardAdmissionEpoch: 0, navigator: {},
            featureRuntime: { load: async () => module }, blobStore: { estimateBlobStoreUsage: async () => ({ totalBytes: 0, categories: [] }), auditOrphanedReaderBlobs: async () => ({}), classifyStoragePressure: () => ({}) },
            storyboardManageImageChannels: async () => empty(), storyboardImageServiceRuntime: async () => ({ manage: async () => empty() }), storyboardComfyRecoveryRuntime: async () => ({ usage: async () => empty() }),
            focusClockLibrary: () => ({ summary: async () => empty() }), notesSyncControls: () => {}, getQianmuNotesStorage: () => empty(), storageJsonBytes: () => 0,
    collectionFloorTools:{storageSummary:async valid=>{assert.equal(valid(),true);return {namespace:ns,status:'ready',bytes:7654321,count:2};}},
            storageSettingsSnapshotWithoutDiagnostics: () => ({}), storageDiagnosticSnapshot: () => ({}), getChatStore: () => ({}) });
        vm.runInContext(code, context); const inventory = await context.collectStorageInventory();
        assert.equal(calls, 1); assert.equal(inventory.trackedBytes, unavailable ? 0 : 90); assert.equal(inventory.manageableBytes, 0, 'catalog is not silently added to generic deletion');
        assert.equal(inventory.galleryCatalogStorage.status, unavailable ? 'unavailable' : 'ready');
        assert.equal(inventory.recipeStorage.bytes,12345678);assert.equal(inventory.recoverableBytes,0,'server files never become local cleanup candidates');
        assert.ok(inventory.categories.every(row=>row.bytes<12345678),'server bytes are not browser categories');
        assert.equal(inventory.collectionStorage.bytes,7654321);assert.ok(inventory.categories.every(row=>row.bytes<7654321),'collection originals are not local cache');
    }
});
test('actual manager entry binds once, locks duplicate opens and rejects a lazy-load context switch', async () => {
    const button = { isConnected: true, disabled: false, listeners: [], addEventListener(_type, fn) { this.listeners.push(fn); } };
    const root = { querySelector: selector => selector === '.sd-storage-gallery-catalog' ? button : null, querySelectorAll: () => [] };
    let release, opens = 0, refreshes = 0;
    const download=()=>{};
    const module = { openGalleryCatalogManagement(options) { opens++; assert.equal(options.anchor, button); assert.equal(options.save,download); return { finished: Promise.resolve() }; } };
    const context = vm.createContext({ storyboardAdmissionEpoch: 1, ctx: () => ({}), featureRuntime: { load: async () => ({ resolveImageAccountNamespace: async () => ns }) },
        loadLocalChunk: () => new Promise(resolve => release = resolve), refreshStorageInventory: () => refreshes++, ttsDownloadBlob:download, toast: () => assert.fail('unexpected toast') });
    vm.runInContext(section('bindStorageManagementEvents'), context); context.bindStorageManagementEvents(root); context.bindStorageManagementEvents(root);
    assert.equal(button.listeners.length, 1);
    const pending = button.listeners[0]({ currentTarget: button }); await button.listeners[0]({ currentTarget: button }); assert.equal(button.disabled, true);
    context.storyboardAdmissionEpoch++; release(module); await pending; assert.equal(opens, 0); assert.equal(button.disabled, false);
    context.loadLocalChunk = async () => module; await button.listeners[0]({ currentTarget: button }); assert.equal(opens, 1); assert.equal(refreshes, 1);
});
