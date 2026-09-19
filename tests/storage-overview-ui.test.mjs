import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {renderStorageBackupSection,bindStoragePackageActions,STORAGE_CATEGORY_LABELS,STORAGE_CATEGORY_COLORS} from '../qianmu-storage-backup-view.js';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function fixture(data = null, status = 'ready') {
  const context = vm.createContext({renderStorageBackupSection,STORAGE_CATEGORY_LABELS,STORAGE_CATEGORY_COLORS, storageInventoryState: { data, status, error: '<unavailable>' },
    optionalServiceState: {status: 'idle'},
    htmlEscape: x => String(x ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatStorageBytes: x => `${Number(x) || 0} B`, blobStore: { classifyStoragePressure: () => ({ level: 'normal' }) } });
  vm.runInContext(['optionalServiceLabel', 'optionalServiceDetail', 'renderStorageServiceStatus', 'renderStorageManagementCard'].map(section).join('\n'), context);
  return context;
}
const data = () => ({sampledAt: 1, origin: { available: true, usage: 4000, quota: 10000 }, trackedBytes: 1000, manageableBytes: 900,
  categories: [{ category: 'vibes', bytes: 1000 }], idb: { chatScopes: ['chat'] },
  vibeStorage: { status: 'ready', assets: { count: 1, bytes: 800 }, previews: { bytes: 100 }, records: { count: 0, bytes: 0 }, metadata: { bytes: 100 } },
  restoreStorage: { status: 'ready', count: 0, bytes: 0 }, mappingStorage: { status: 'ready', count: 0, bytes: 0 }, carrierStorage: { status: 'ready', count: 0, bytes: 0 },
  characterStorage: { status: 'ready', documents: { count: 0, bytes: 0 }, bindings: { count: 0, bytes: 0 }, indexes: { bytes: 0 } },
  comfyStorage: { status: 'ready', workflows: { status: 'ready', count: 0, bytes: 0 }, pools: { status: 'ready', count: 0, bytes: 0 }, scenes: { status: 'ready', count: 0, bytes: 0 } }
});

test('server recipe file sizes occupy one read-only row without changing browser totals or cleanup',()=>{
  const snapshot=data();snapshot.recipeStorage={status:'ready',state:'present',files:3,bytes:12345678,limitFiles:4096,limitBytes:268435456};
  const html=fixture(snapshot).renderStorageManagementCard();
  assert.equal((html.match(/sd-storage-server-recipes/g)||[]).length,1);assert.match(html,/3 个归档文件 · 12345678 B/);
  assert.match(html,/不计入本设备占用/);assert.match(html,/不代表可恢复配方数量/);assert.match(html,/千幕已盘点<b>1000 B/);
  assert.match(html,/<em>其他 ST 数据<\/em><b>3000 B/);assert.match(html,/<em>可用空间<\/em><b>6000 B/);
  assert.doesNotMatch(html.slice(html.indexOf('sd-storage-server-recipes'),html.indexOf('</p>',html.indexOf('sd-storage-server-recipes'))),/<button|<input/);
});

test('server missing, unavailable and above-limit states keep distinct meanings',()=>{
  const snapshot=data();snapshot.recipeStorage={status:'ready',state:'absent',files:0,bytes:0,limitFiles:4096,limitBytes:268435456};
  assert.match(fixture(snapshot).renderStorageManagementCard(),/0 个归档文件 · 0 B · 尚无服务器配方文件/);
  snapshot.recipeStorage={status:'unavailable',bytes:null,files:null,error:'<private>'};let html=fixture(snapshot).renderStorageManagementCard();
  const row=html.slice(html.indexOf('sd-storage-server-recipes'),html.indexOf('</p>',html.indexOf('sd-storage-server-recipes')));
  assert.match(row,/暂未读取/);assert.match(row,/&lt;private&gt;/);assert.doesNotMatch(row,/<private>|0 B|0 个归档/);
  snapshot.recipeStorage={status:'ready',state:'present',files:4096,bytes:268435500,limitFiles:4096,limitBytes:268435456};
  html=fixture(snapshot).renderStorageManagementCard();assert.match(html,/268435500 B/);assert.match(html,/已达到配方写入安全限额/);assert.match(html,/未自动清理原件/);
});

test('storage backup remains accessible before inventory and after inventory failure', () => {
  for (const status of ['loading', 'error']) {
    const html = fixture(null, status).renderStorageManagementCard();
    assert.match(html, /sd-storage-backup-section/);
    assert.match(html, /sd-import-config-file/);
    assert.match(html, /sd-storage-service[\s\S]*后端服务[\s\S]*重新检测/);
    for (const name of ['storyboard', 'reader', 'favorites', 'notes']) assert.match(html, new RegExp(`data-storage-import="${name}"`));
    assert.doesNotMatch(html, /sd-storage-clean"|sd-storage-chat-clean"/);
    if (status === 'error') { assert.match(html, /&lt;unavailable&gt;/); assert.doesNotMatch(html, /<unavailable>/); }
  }
});

test('one resource list contains backups, managers and cleanup with common resources first', () => {
  const snapshot = data(), before = structuredClone(snapshot), html = fixture(snapshot).renderStorageManagementCard();
  const details = html.indexOf('class="sd-storage-disclosure sd-storage-backup-section"');
  assert.ok(details > 0);
  assert.ok(html.indexOf('Vibe 文件 ·') > details);
  assert.ok(html.indexOf('Comfy 本机领取记录') > details);
  assert.ok(html.indexOf('sd-storage-clean"') > details);
  assert.equal((html.match(/<details\b/g)||[]).length,1);
  assert.doesNotMatch(html,/占用明细与维护|sd-storage-details/);
  assert.ok(html.indexOf('data-storage-export="notes"') < html.indexOf('data-storage-export="storyboard"'));
  assert.ok(html.indexOf('sd-storage-clean"') < html.indexOf('</details>'));
  for (const key of ['characters','vibes','restores','mappings','comfy-receipts','focus-library']) assert.equal((html.match(new RegExp(`class="sd-btn sd-storage-${key}"`,'g'))||[]).length,1,key);
  assert.match(html, /<em>参考素材<\/em>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/);
  assert.match(html, /千幕已盘点<b>1000 B/);
  assert.match(html, /不代表 VPS 磁盘总容量/);
  assert.match(html, /配置不包含素材原件/);
  assert.ok(html.indexOf('class="sd-storage-service"') > html.lastIndexOf('</details>'), 'service status remains at the card end outside any disclosure');
  assert.deepEqual(snapshot, before, 'render must not mutate accounting, assets, or recovery data');
});

test('partial inventory and pressure warnings remain visible before the single resource list', () => {
  const snapshot = data();
  snapshot.comfyStorage.status = 'partial'; snapshot.comfyStorage.errors = ['bad <index>'];
  snapshot.origin.pressure = { level: 'critical', ratio: .95, freeBytes: 50 };
  const html = fixture(snapshot).renderStorageManagementCard(), split = html.indexOf('class="sd-storage-disclosure sd-storage-backup-section"');
  assert.match(html.slice(0, split), /部分数据暂不可读取/);
  assert.match(html.slice(0, split), /来源空间已使用 95%/);
  assert.match(html.slice(split), /bad &lt;index&gt;/);
  assert.doesNotMatch(html, /bad <index>/);
});

test('missing browser quota does not prevent module backup or invent a device disk size', () => {
  const snapshot = data(); snapshot.origin = { available: false };
  const html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /浏览器未提供配额信息/);
  assert.match(html, /sd-storage-backup-section/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('data management promotes real accounted bytes without changing quota accounting or entry ownership', () => {
  const snapshot = data(), html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /<h3>数据管理<\/h3>/);
  assert.match(html, /class="sd-storage-hero">千幕已盘点<b>1000 B<\/b>/);
  assert.match(html, /本设备 · 站点已用 \/ 配额<b>4000 B \/ 10000 B<\/b>/);
  for (const [category, bytes] of [['参考素材', 1000], ['其他 ST 数据', 3000], ['可用空间', 6000]]) {
    assert.match(html, new RegExp(`<em>${category}</em><b>${bytes} B</b>`));
  }
  assert.equal((html.match(/class="sd-btn sd-primary sd-storage-clean"/g) || []).length, 1);
  assert.equal((html.match(/class="sd-btn sd-storage-chat-clean"/g) || []).length, 1);
  assert.equal((html.match(/fa-arrow-right" aria-hidden="true"/g) || []).length, 3);
  assert.doesNotMatch(html, /fa-arrow-up-right|↗|2\.46 GB/);
});

test('incomplete inventory never promotes unaccounted bytes to the large Qianmu total', () => {
  const snapshot = data(); snapshot.vibeStorage = {status: 'unavailable', error: '<not read>'};
  const html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /class="sd-storage-hero">千幕已盘点<b>1000 B<\/b>/);
  assert.match(html, /<em>未盘点站点数据<\/em><b>3000 B<\/b>/);
  assert.match(html, /未读取的部分不会按零占用处理/);
  assert.match(html, /&lt;not read&gt;/);
});

test('inventory refresh disables destructive entry until current results are ready', () => {
  for(const status of ['loading','error']) {
    const html=fixture(data(),status).renderStorageManagementCard();
    assert.match(html,/sd-storage-clean" disabled/);
    assert.match(html,/sd-storage-chat-clean" disabled/);
    assert.match(html,/data-storage-export="audio"/);
  }
  const html=fixture(data()).renderStorageManagementCard();
  assert.match(html,/sd-storage-clean" >/);
  assert.match(html,/sd-storage-chat-clean" >/);
});

test('resource-manager binding is idempotent without routing or starting work during render', async () => {
  const calls=[],button={listeners:[],addEventListener(_event,fn){this.listeners.push(fn);}};
  const root={querySelector:s=>s==='button.sd-storage-mappings'?button:null,querySelectorAll:()=>[]};
  const context=vm.createContext({storageInventoryState:{data:{mappingStorage:{namespace:'first'}}},storyboardOpenRestoreStorage:(_root,namespace,options)=>calls.push([namespace,options.mappings])});
  vm.runInContext(section('bindStorageManagementEvents'),context);
  context.bindStorageManagementEvents(root);context.bindStorageManagementEvents(root);
  assert.equal(button.listeners.length,1);assert.deepEqual(calls,[]);
  context.storageInventoryState.data.mappingStorage.namespace='current';await button.listeners[0]();
  assert.deepEqual(calls,[['current',true]]);
});

test('central backup entry binds once and reuses the existing export and restore boundaries', async () => {
  const calls = [], node = dataset => ({ dataset, value: 'picked', listeners: {}, files: [{ name: 'fixture' }],
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }, click() { this.clicks = (this.clicks || 0) + 1; } });
  const configExport = node({}), configImport = node({}), configFile = node({});
  const names = ['storyboard', 'reader', 'favorites', 'audio', 'notes'];
  const exports = names.map(storageExport => node({ storageExport })), picks = names.map(storagePick => node({ storagePick })), imports = names.map(storageImport => node({ storageImport }));
  exports.push(node({storageExport:'collections'}));
  picks.push(node({storagePick:'collections'}));imports.push(node({storageImport:'collections'}));
  const backup = { dataset: {}, querySelector: selector => ({ '.sd-export-config': configExport, '.sd-import-config': configImport, '.sd-import-config-file': configFile }[selector]
    || imports.find(input => selector === `input[data-storage-import="${input.dataset.storageImport}"]`)),
    querySelectorAll: selector => ({ '[data-storage-export]': exports, '[data-storage-pick]': picks, 'input[data-storage-import]': imports }[selector] || []) };
  const root = { querySelector: selector => selector === '.sd-storage-backup-section' ? backup : null, querySelectorAll: () => [] };
  const context = vm.createContext({renderStorageBackupSection, bindStoragePackageActions, exportConfig: () => calls.push('config-export'), importConfig: () => calls.push('config-import'),
    storyboardExportPackage: options => { assert.equal(options.bundle, true); calls.push('storyboard-export'); },
    storyboardImportAnyPackage: file => { assert.equal(file.name, 'fixture'); calls.push('storyboard-import'); },
    coreadExportData: () => calls.push('reader-export'), coreadImportDataFile: () => calls.push('reader-import'),
    exportTtsFavoritesBackup: button => { assert.equal(button, exports[2]); calls.push('favorites-export'); },
    importTtsFavoritesBackup: () => calls.push('favorites-import'), ttsExportAudioCache: () => calls.push('audio-export'), ttsImportAudioCache: () => calls.push('audio-import'), exportPinnedNotesBackup: () => calls.push('notes-export'), importPinnedNotesBackup: () => calls.push('notes-import') });
  vm.runInContext(section('bindStorageManagementEvents'), context);
  Object.assign(context,{confirmDialog:()=>{},ttsDownloadBlob:()=>{},createStorageBackupCheck:(button,owner)=>{assert.ok(button===exports[5]||button===imports[5]);if(button===imports[5])assert.equal(owner,context.collectionFloorTools.restoreBackup);return 'guard';},collectionFloorTools:{exportBackup:(button,confirm,download,check)=>{assert.equal(button,exports[5]);assert.equal(confirm,context.confirmDialog);assert.equal(download,context.ttsDownloadBlob);assert.equal(check(),'guard');calls.push('collections-export');},restoreBackup:(file,input,confirm,check)=>{assert.equal(file.name,'fixture');assert.equal(input,imports[5]);assert.equal(confirm,context.confirmDialog);assert.equal(check(),'guard');calls.push('collections-import');}}});
  context.bindStorageManagementEvents(root); context.bindStorageManagementEvents(root);
  assert.deepEqual(calls, [], 'binding controls must never start backup, restore, or generation');
  for (const button of [configExport, configImport, ...exports, ...picks]) assert.equal(button.listeners.click.length, 1);
  configExport.listeners.click[0](); configImport.listeners.click[0](); assert.equal(configFile.clicks, 1);
  configFile.listeners.change[0]({ target: configFile, currentTarget: configFile });
  for (const button of exports) button.listeners.click[0]();
  for (const button of picks) button.listeners.click[0]();
  for (const input of imports) { assert.equal(input.clicks, 1); await input.listeners.change[0]({ target: input, currentTarget: input }); assert.equal(input.value, ''); }
  assert.deepEqual(calls, ['config-export', 'config-import', 'storyboard-export', 'reader-export', 'favorites-export', 'audio-export', 'notes-export', 'collections-export', 'storyboard-import', 'reader-import', 'favorites-import', 'audio-import', 'notes-import', 'collections-import']);
});
