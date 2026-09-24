import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderStorageBackupSection} from '../qianmu-storage-backup-view.js';
test('collection toolbar refresh runs independently before storyboard enable gate and is disposed with the owner runtime',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const render=source.slice(source.indexOf('function storyboardRenderInlineImages('),source.indexOf('function storyboardScheduleInlineRender('));
  assert.ok(render.indexOf('collectionFloorTools.refresh(chatRoot)')>=0);
  assert.ok(render.indexOf('collectionFloorTools.refresh(chatRoot)')<render.indexOf('if (!storyboardState().enabled)'));
  assert.match(source.slice(source.indexOf('function cleanupRuntime(')),/initialized = false;\s+collectionFloorTools.dispose\(\)/);
  assert.match(source,/isCurrent:\(\)=>initialized&&isRuntimeOwner\(\)/);
});
test('collection UI dependencies are shipped locally and are not loaded into the light toolbar before an explicit click',async()=>{
  const source=await readFile(new URL('../qianmu-text-collection-floor.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/^import .*from ['"]\.\/qianmu-text-collection-(capture|library|view|session)/m);assert.match(source,/await loadLocalChunk\('\.\/qianmu-text-collection-capture.js'\)/);
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  for(const file of ['floor','capture','session','client','view','library','export','backup','restore-batch','restore-view'])assert.ok(release.files.includes(`qianmu-text-collection-${file}.js`));
  assert.ok(release.files.includes('qianmu-text-collection.css'));
});
test('library belongs to the hive independently of chat; floor button only captures',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const floor=source.slice(source.indexOf('function openFloorNavigator('),source.indexOf('async function runQuickWheelCommand('));
  assert.doesNotMatch(floor,/sd-floor-collections/);
  assert.match(source,/id === 'collections'\) return collectionFloorTools.openLibrary\(document.body,confirmDialog\)/);
});

test('central collection export and restore use host page guards and the exclusive restoring owner',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),view=await readFile(new URL('../qianmu-storage-backup-view.js',import.meta.url),'utf8');
  assert.match(source,/collections:button=>collectionFloorTools.exportBackup\(button,confirmDialog,ttsDownloadBlob,\(\)=>createStorageBackupCheck\(button,null\)\)/);
  const html=renderStorageBackupSection();assert.match(html,/data-storage-export="collections"/);assert.match(html,/data-storage-import="collections"/);assert.match(html,/正文收藏/);
  assert.match(source,/collections:\(file,input\)=>collectionFloorTools.restoreBackup\(file,input,confirmDialog,\(\)=>createStorageBackupCheck\(input,collectionFloorTools.restoreBackup,'导入'\)\)/);
  assert.match(source,/transfer: \(ownTransfer!==collectionFloorTools.restoreBackup&&collectionFloorTools.restoreBusy\)/);
});
