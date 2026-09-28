import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {bindStoragePackageActions, renderStorageBackupSection, storageCleanupOptions, storageOverviewSegments, runStorageInventoryJobs} from '../qianmu-storage-backup-view.js';
import {createTextCollectionOwner} from '../qianmu-text-collection-owner.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const ready = (extra = {}) => ({status: 'ready', count: 2, bytes: 1200, fingerprint: '1'.repeat(64), ...extra});
const render = (collectionStorage, options = {}) => renderStorageBackupSection(null, value => `${value} B`, {
    data: {collectionStorage, manageableBytes: 0, idb: {chatScopes: []}}, ready: true, ...options,
});

test('central backup has one collection export/import row before any scan, without starting a transfer', () => {
    const html = renderStorageBackupSection(null);
    assert.equal((html.match(/data-storage-export="collection"/g) || []).length, 1);
    assert.equal((html.match(/data-storage-pick="collection"/g) || []).length, 1);
    assert.match(html, /data-storage-import="collection" accept="application\/json,\.json" hidden/);
    assert.doesNotMatch(html, /sd-storage-clean"|查看资料占用/);
});

test('unknown or unread collection inventory never creates a deletion choice or a fake zero', () => {
    for (const collection of [undefined, null, {status: 'unavailable'}, {status: 'loading', count: 3, bytes: 2000}]) {
        assert.deepEqual(storageCleanupOptions({collectionStorage: collection}), []);
        const html = render(collection);
        assert.match(html, /<span>正文收藏<\/span><span>暂未读取<\/span>/);
        assert.doesNotMatch(html, /<span>正文收藏<\/span><span>0 B<\/span>/);
        assert.match(html, /sd-storage-clean" disabled/);
    }
});

test('known collection count and logical bytes produce a single protected cleanup choice', () => {
    const data = {collectionStorage: ready()};
    const [choice] = storageCleanupOptions(data);
    assert.equal(storageCleanupOptions(data).length, 1);
    assert.equal(choice.id, '__text_collection__'); assert.equal(choice.label, '正文收藏');
    assert.equal(choice.count, 2); assert.equal(choice.bytes, 1200); assert.equal(choice.risk[1], true);
    assert.match(choice.risk[0], /删除全部收藏正文.*先备份/);
    const html = render(ready());
    assert.match(html, /<span>正文收藏<\/span><span>1200 B<\/span>/);
    assert.match(html, /sd-storage-clean" >/);
    assert.match(html, /sd-storage-chat-clean" disabled/);
});

test('empty confirmed collection cannot be selected for deletion, and scan disables cleanup only', () => {
    assert.deepEqual(storageCleanupOptions({collectionStorage: ready({count: 0, bytes: 24})}), []);
    const empty = render(ready({count: 0, bytes: 24}));
    assert.match(empty, /<span>正文收藏<\/span><span>24 B<\/span>/);
    assert.match(empty, /sd-storage-clean" disabled/);
    const scanning = render(ready(), {ready: false, scanning: true});
    assert.match(scanning, /sd-storage-clean" disabled/);
    assert.match(scanning, /data-storage-export="collection" aria-label="导出正文收藏"/);
    assert.match(scanning, /data-storage-pick="collection" aria-label="导入正文收藏"/);
});

test('collection estimates never change the browser quota bar or turn into claimed VPS disk space', () => {
    const base = {origin: {usage: 1234, quota: 10000, available: true}, categories: []};
    const renderOverview = data => storageOverviewSegments(data, value => `${value} B`, String);
    const original = renderOverview(base);
    assert.deepEqual(renderOverview({...base, collectionStorage: ready({bytes: 999999999})}), original);
    assert.equal(original.originText, '1234 B / 10000 B');
    assert.match(original.storageBar, /本机浏览器站点已用/);
    assert.doesNotMatch(original.storageBar, /VPS|服务器|999999999/);
});

test('summary passes UTF-8 document bytes to the resource row without scanning unrelated data', async t => {
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
    assert.ok(render(summary).includes(`<span>正文收藏</span><span>${bytes} B</span>`));
    assert.deepEqual(owner.state().items, value.items);
});

test('package binding dispatches explicit collection export/import only and clears the file picker', async () => {
    const dom = textCollectionDom(), calls = [];
    const node = (tag, key, value) => {
        const result = dom.doc.createElement(tag); result.setAttribute(`data-storage-${key}`, value);
        result.dataset[`storage${key[0].toUpperCase()}${key.slice(1)}`] = value; dom.parent.append(result); return result;
    };
    const exporting = node('button', 'export', 'collection'), picking = node('button', 'pick', 'collection');
    const input = node('input', 'import', 'collection'); input.type = 'file'; input.value = 'selected';
    const file = new Blob(['{}'], {type: 'application/json'}); input.files = [file];
    let pickerClicks = 0; input.addEventListener('click', () => { pickerClicks++; });
    bindStoragePackageActions(dom.parent, {
        exports: {collection: button => calls.push(['export', button])},
        imports: {collection: async (selected, node) => { calls.push(['import', selected, node]); }},
    });
    assert.deepEqual(calls, []);
    exporting.click(); assert.deepEqual(calls, [['export', exporting]]);
    picking.click(); assert.equal(pickerClicks, 1); assert.equal(calls.length, 1);
    input.emit('change'); await dom.wait(() => input.value === '');
    assert.deepEqual(calls[1], ['import', file, input]);
    input.files = []; input.emit('change'); assert.equal(calls.length, 2);
});

test('shipped entry names the owner actions at the central backup and cleanup seam', async () => {
    const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    // Only public integration hooks are checked here; behavior is exercised above
    // and by the owner transfer tests, not duplicated as source-shape assertions.
    assert.match(entry, /exports:\{collection:proseFloorTools\.exportCollection/);
    assert.match(entry, /imports:\{collection:proseFloorTools\.importCollection/);
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
    assert.match(renderStorageBackupSection(null, value => `${value} B`, {data}), /<span>正文收藏<\/span><span>暂未读取<\/span>/);
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
