import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {storageCleanupOptions, runStorageInventoryJobs} from '../qianmu-storage-backup-view.js';
import {STORAGE_TRANSFER_ITEMS, detectStorageFile} from '../qianmu-storage-transfer.js';
import {createTextCollectionBackup} from '../qianmu-text-collection-backup.js';
import {renderStorageBackupSection} from './helpers/storage-card.mjs';
import {createTextCollectionOwner} from '../qianmu-text-collection-owner.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const ready = (extra = {}) => ({status: 'ready', count: 2, bytes: 1200, fingerprint: '1'.repeat(64), ...extra});
const render = (collectionStorage, options = {}) => renderStorageBackupSection(null, value => `${value} B`, {
    data: {collectionStorage, manageableBytes: 0, idb: {chatScopes: []}}, ready: true, ...options,
});

test('the collection is one item of the single export/import, recognised from its own backup file, with no row of its own', async () => {
    assert.deepEqual(STORAGE_TRANSFER_ITEMS.filter(([key]) => key === 'collection'), [['collection', '正文收藏']]);
    const stamp = '2026-09-28T00:00:00.000Z';
    const backup = createTextCollectionBackup({version: 1, items: [{id: 'one', text: '原文', charName: '角色', userName: '用户', createdAt: stamp, updatedAt: stamp, source: null}]},
        {origin: 'https://example.invalid', scope: 'a'.repeat(64), now: () => stamp});
    assert.equal(await detectStorageFile(new Blob([JSON.stringify(backup)])), 'collection');
    const html = render(ready());
    assert.doesNotMatch(html, /data-storage-|正文收藏<\/span>/);
    assert.equal((html.match(/class="sd-btn sd-storage-export"/g) || []).length, 1);
    assert.equal((html.match(/class="sd-btn sd-storage-import"/g) || []).length, 1);
});

test('unknown or unread collection inventory never creates a deletion choice or a fake zero', () => {
    for (const collection of [undefined, null, {status: 'unavailable'}, {status: 'loading', count: 3, bytes: 2000}]) {
        assert.deepEqual(storageCleanupOptions({collectionStorage: collection}), []);
    }
});

test('known collection count and logical bytes produce a single cleanup choice', () => {
    const data = {collectionStorage: ready()};
    const [choice] = storageCleanupOptions(data);
    assert.equal(storageCleanupOptions(data).length, 1);
    assert.equal(choice.id, '__text_collection__'); assert.equal(choice.label, '正文收藏');
    assert.equal(choice.count, 2); assert.equal(choice.bytes, 1200);
    assert.deepEqual(Object.keys(choice).sort(), ['bytes', 'count', 'id', 'label'], 'the choice carries no separate risk caption');
});

test('empty confirmed collection cannot be selected for deletion', () => {
    assert.deepEqual(storageCleanupOptions({collectionStorage: ready({count: 0, bytes: 24})}), []);
});

test('collection estimates never change the browser quota bar or turn into claimed VPS disk space', () => {
    const base = {origin: {usage: 1234, quota: 10000, available: true}, categories: []};
    const site = data => renderStorageBackupSection(null, value => `${value} B`, {data}).match(/<p class="sd-dm-site">[\s\S]*?<\/p>/)?.[0];
    const original = site(base);
    assert.equal(site({...base, collectionStorage: ready({bytes: 999999999})}), original);
    assert.match(original, /本设备 ST 站点已用 \/ 配额<b>1234 B \/ 10000 B<\/b>/);
    assert.doesNotMatch(original, /VPS|服务器|999999999/);
});

test('summary reports UTF-8 document bytes to the cleanup choice without scanning unrelated data', async t => {
    const stamp = '2026-09-28T00:00:00.000Z';
    const value = {version: 1, items: [{id: 'one', text: '完整中文🧭\r\n原文', charName: '角色', userName: '用户', createdAt: stamp, updatedAt: stamp, source: null}]};
    let reads = 0;
    const owner = createTextCollectionOwner({resolveNamespace: async () => 'st-user:storage-view', isCurrent: () => true,
        headers: () => ({}), window: new EventTarget(), storeFactory: async () => ({
            async read() { reads++; return {exists: true, fingerprint: '1'.repeat(64), value: structuredClone(value)}; },
            async write() { throw Error('Inventory must never write'); }, close() {},
        }),
    });
    t.after(() => owner.dispose());
    const summary = await owner.summary();
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    assert.equal(summary.bytes, bytes); assert.equal(summary.count, 1); assert.equal(reads, 1);
    assert.ok(bytes > JSON.stringify(value).length);
    assert.equal(storageCleanupOptions({collectionStorage: summary})[0].bytes, bytes);
    assert.deepEqual(owner.state().items, value.items);
});

test('shipped entry names the owner actions at the central backup and cleanup seam', async () => {
    const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    // Only public integration hooks are checked here; behavior is exercised above
    // and by the owner transfer tests, not duplicated as source-shape assertions.
    assert.match(entry, /const exports=\{[^\n]*collection:proseFloorTools\.exportCollection/);
    assert.match(entry, /const imports=\{[^\n]*collection:proseFloorTools\.importCollection/);
    assert.match(entry, /proseFloorTools\.clearCollection\(\{confirmed:true,expectedFingerprint:inventory\.collectionStorage\.fingerprint,check:\(\)=>cleanup\.check\(\)\}\)/);
});

function inventoryFixture(collection) {
    const namespace = 'st-user:inventory';
    const zero = () => ({status: 'ready', bytes: 0, count: 0});
    const unknown = () => ({status: 'unavailable', bytes: null, count: null});
    let calls = 0;
    const context = vm.createContext({runStorageInventoryJobs, settings: {}, storyboardAdmissionEpoch: 1,
        navigator: {storage: {estimate: async () => ({usage: 1000, quota: 10000})}},
        proseFloorTools: {assistantStorageSummary: async () => unknown(),
            collectionStorageSummary: async valid => { calls++; assert.equal(valid(), true); return collection; }},
        notesSyncControls() {}, getQianmuNotesStorage: async () => zero(), focusClockLibrary: () => ({summary: async () => zero()}),
        blobStore: {estimateBlobStoreUsage: async () => ({totalBytes: 10, recoverableBytes: 2, categories: [{category: 'images', bytes: 10, count: 1}]}),
            auditOrphanedReaderBlobs: async () => ({}), classifyStoragePressure: () => ({})},
        featureRuntime: {load: async () => ({resolveImageAccountNamespace: async () => namespace, manageImageAdmissionStorage: async () => zero(),
            collectComfyStorage: async () => zero(), collectVibeStorage: async () => unknown(), collectCharacterStorage: async () => unknown(),
            collectStoryboardRestoreStorage: async () => unknown(), collectStoryboardMappingStorage: async () => unknown(), collectStoryboardCarrierStorage: async () => unknown(),
            collectGalleryCatalogStorage: async () => unknown(), collectRecipeArchiveStorage: async () => unknown()})},
        storyboardManageImageChannels: async () => zero(), storyboardImageServiceRuntime: async () => ({manage: async () => zero()}),
        storyboardComfyRecoveryRuntime: async () => ({usage: async () => zero()}),
        storageJsonBytes: () => 0, storageSettingsSnapshotWithoutDiagnostics: () => ({}), storageDiagnosticSnapshot: () => ({}), getChatStore: () => ({}),
    });
    vm.runInContext(section('collectStorageInventory'), context);
    return {context, get calls() { return calls; }};
}

test('actual global inventory counts collection once, separately from recoverable cache and browser quota', async () => {
    const summary = ready({namespace: 'st-user:inventory'}), f = inventoryFixture(summary);
    const data = await f.context.collectStorageInventory();
    assert.equal(f.calls, 1); assert.equal(data.collectionStorage, summary);
    assert.equal(data.trackedBytes, 1210); assert.equal(data.manageableBytes, 1210); assert.equal(data.recoverableBytes, 2);
    assert.equal(data.idb.totalBytes, 10, 'explicit collection cleanup is not a browser cache deletion');
    const categories = Array.from(data.categories).filter(row => row.category === 'collections');
    assert.equal(categories.length, 1); assert.equal(categories[0].count, 2); assert.equal(categories[0].bytes, 1200);
    assert.equal(data.origin.usage, 1000); assert.equal(data.origin.quota, 10000);
    assert.equal(storageCleanupOptions(data).filter(row => row.id === '__text_collection__').length, 1);
});

test('actual global inventory preserves unread collection status instead of claiming zero', async () => {
    const summary = {status: 'unavailable', namespace: 'st-user:inventory', bytes: null, count: null};
    const f = inventoryFixture(summary), data = await f.context.collectStorageInventory();
    assert.equal(f.calls, 1); assert.equal(data.collectionStorage.bytes, null); assert.equal(data.collectionStorage.status, 'unavailable');
    assert.equal(data.trackedBytes, 10); assert.equal(data.categories.some(row => row.category === 'collections'), false);
    assert.deepEqual(storageCleanupOptions(data), []);
});

test('actual inventory rejects a foreign collection account or invalidated scan rather than mixing totals', async () => {
    const foreign = inventoryFixture(ready({namespace: 'st-user:other'}));
    await assert.rejects(foreign.context.collectStorageInventory(), /账户已变化/);
    const stale = inventoryFixture(ready({namespace: 'st-user:inventory'}));
    stale.context.proseFloorTools.collectionStorageSummary = async valid => {
        assert.equal(valid(), true); stale.context.storyboardAdmissionEpoch++;
        assert.equal(valid(), false); return ready({namespace: 'st-user:inventory'});
    };
    await assert.rejects(stale.context.collectStorageInventory(), /页面已变化/);
});
