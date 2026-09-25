import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {renderStorageBackupSection,bindStoragePackageActions,storageOverviewSegments,STORAGE_CATEGORY_LABELS,STORAGE_CATEGORY_COLORS} from '../qianmu-storage-backup-view.js';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function fixture(data = null, status = 'ready') {
  const context = vm.createContext({renderStorageBackupSection,storageOverviewSegments,VERSION:'1.59.387',STORAGE_CATEGORY_LABELS,STORAGE_CATEGORY_COLORS, storageInventoryState: { data, status, error: '<unavailable>' },
    optionalServiceState: {status: 'idle'},
    htmlEscape: x => String(x ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatStorageBytes: x => `${Number(x) || 0} B`, blobStore: { classifyStoragePressure: () => ({ level: 'normal' }) } });
  vm.runInContext(['optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'renderStorageServiceStatus', 'renderStorageManagementCard'].map(section).join('\n'), context);
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
  assert.equal((html.match(/<span>图片配置<\/span>/g)||[]).length,1);assert.match(html,/<span>图片配置<\/span><span>12345678 B<\/span>/);
  assert.doesNotMatch(html,/不代表可恢复配方数量|归档文件 ·/);assert.match(html,/千幕资料已盘点<b>1000 B/);
  assert.doesNotMatch(html,/<em>其他 ST 数据<\/em>/);assert.match(html,/本机浏览器站点已用 4000 B/);assert.match(html,/可用空间 6000 B/);
  const row=html.match(/<div[^>]*><span>图片配置<\/span>[\s\S]*?<\/div>/)?.[0];assert.ok(row);assert.doesNotMatch(row,/<button|<input/);
});

test('server missing, unavailable and above-limit states keep distinct meanings',()=>{
  const snapshot=data();snapshot.recipeStorage={status:'ready',state:'absent',files:0,bytes:0,limitFiles:4096,limitBytes:268435456};
  assert.match(fixture(snapshot).renderStorageManagementCard(),/<span>图片配置<\/span><span>0 B<\/span>/);
  snapshot.recipeStorage={status:'unavailable',bytes:null,files:null,error:'<private>'};let html=fixture(snapshot).renderStorageManagementCard();
  const row=html.match(/<div[^>]*><span>图片配置<\/span>[\s\S]*?<\/div>/)?.[0];assert.ok(row);
  assert.match(row,/暂未读取/);assert.doesNotMatch(row,/<private>|&lt;private&gt;|0 B|0 个归档/);
  snapshot.recipeStorage={status:'ready',state:'present',files:4096,bytes:268435500,limitFiles:4096,limitBytes:268435456};
  const before=structuredClone(snapshot);html=fixture(snapshot).renderStorageManagementCard();assert.match(html,/268435500 B/);assert.match(html,/role="status">图片配置存储已满，请先备份再清理/);assert.deepEqual(snapshot,before);assert.doesNotMatch(html,/data-storage-(?:export|pick)="recipes"/);
});

test('storage backup remains accessible before inventory and after inventory failure', () => {
  for (const status of ['loading', 'error']) {
    const html = fixture(null, status).renderStorageManagementCard();
    assert.match(html, /sd-storage-backup-section/);
    assert.match(html, /sd-import-config-file/);
    assert.match(html, /sd-storage-service[\s\S]*后端服务[\s\S]*重新检测/);
    for (const name of ['storyboard', 'reader', 'favorites', 'notes']) assert.match(html, new RegExp(`data-storage-import="${name}"`));
    if(status==='loading'){
      assert.match(html,/准备扫描/);
      assert.match(html,/sd-storage-clean" disabled/);
      assert.match(html,/sd-storage-chat-clean" disabled/);
    }else assert.doesNotMatch(html, /sd-storage-clean"|sd-storage-chat-clean"/);
    if (status === 'error') { assert.match(html, /&lt;unavailable&gt;/); assert.doesNotMatch(html, /<unavailable>/); }
  }
});

test('backup and cleanup keep one compact read-only inventory instead of duplicate module navigation', () => {
  const snapshot = data(), before = structuredClone(snapshot), html = fixture(snapshot).renderStorageManagementCard();
  const details = html.indexOf('class="sd-storage-disclosure sd-storage-backup-section"');
  assert.ok(details > 0);
  assert.ok(html.indexOf('Vibe 素材') > details);
  assert.doesNotMatch(html,/Comfy 本机领取记录|迁移映射凭据|来源记录 ·/);
  assert.ok(html.indexOf('sd-storage-clean"') > details);
  assert.equal((html.match(/<details\b/g)||[]).length,3);
  assert.doesNotMatch(html,/占用明细与维护|sd-storage-details/);
  assert.ok(html.indexOf('data-storage-export="notes"') < html.indexOf('data-storage-export="storyboard"'));
  assert.ok(html.indexOf('sd-storage-clean"') < html.lastIndexOf('</details>'));
  for (const key of ['characters','vibes','restores','mappings','comfy-receipts','focus-library']) assert.equal((html.match(new RegExp(`class="sd-btn sd-storage-${key}"`,'g'))||[]).length,0,key);
  assert.match(html, /<em>参考素材<\/em>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/);
  assert.match(html, /千幕资料已盘点<b>1000 B/);
  assert.match(html, /不代表 VPS 总容量/);
  for(const name of ['notes','storyboard','collections'])assert.match(html,new RegExp(`data-storage-export="${name}"`));
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
  assert.match(html.slice(split), /暂未读取/);
  assert.doesNotMatch(html, /bad <index>|bad &lt;index&gt;/);
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
  assert.match(html, /class="sd-storage-hero">千幕资料已盘点<b>1000 B<\/b>/);
  assert.match(html, /本设备 ST 站点已用 \/ 配额<b>4000 B \/ 10000 B<\/b>/);
  for (const [category, bytes] of [['参考素材', 1000]]) {
    assert.match(html, new RegExp(`<em>${category}</em><b>${bytes} B</b>`));
  }
  assert.equal((html.match(/class="sd-btn sd-primary sd-storage-clean"/g) || []).length, 1);
  assert.equal((html.match(/class="sd-btn sd-storage-chat-clean"/g) || []).length, 1);
  assert.equal((html.match(/fa-arrow-right" aria-hidden="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /fa-arrow-up-right|↗|2\.46 GB/);
});

test('incomplete inventory never promotes unaccounted bytes to the large Qianmu total', () => {
  const snapshot = data(); snapshot.vibeStorage = {status: 'unavailable', error: '<not read>'};
  const html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /class="sd-storage-hero">千幕资料已盘点<b>1000 B<\/b>/);
  assert.doesNotMatch(html, /<em>未盘点站点数据<\/em>/);
  assert.match(html, /未读取的部分不会按零占用处理/);
  assert.match(html, /<span>Vibe 素材<\/span><span>暂未读取<\/span>/);assert.doesNotMatch(html, /<not read>|<span>Vibe 素材<\/span><span>0 B/);
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

test('opening data management keeps backups usable until an explicit scan and reports measured scan progress',()=>{
  const idle=fixture(null,'idle').renderStorageManagementCard();
  assert.match(idle,/扫描资料/);assert.match(idle,/备份可直接使用/);assert.match(idle,/data-storage-export="storyboard"/);
  assert.doesNotMatch(idle,/资料扫描进度|sd-storage-clean"/);
  const context=fixture(data(),'loading');context.storageInventoryState.progress={done:5,total:20};
  const scanning=context.renderStorageManagementCard();
  assert.match(scanning,/已检查 5\/20 项 · 25%/);assert.match(scanning,/<progress max="20" value="5"/);
  assert.match(scanning,/sd-storage-clean" disabled/);assert.match(scanning,/sd-storage-chat-clean" disabled/);
  assert.match(scanning,/data-storage-export="storyboard"/);
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
