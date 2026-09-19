import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  assert.doesNotMatch(source,/^import /m);assert.match(source,/await import\('\.\/qianmu-text-collection-capture.js'\)/);
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  for(const file of ['floor','capture','session','client','view','library','export','backup'])assert.ok(release.files.includes(`qianmu-text-collection-${file}.js`));
  assert.ok(release.files.includes('qianmu-text-collection.css'));
});
test('library entry belongs to floor tools even with no active chat and uses the host confirmation path',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const floor=source.slice(source.indexOf('function openFloorNavigator('),source.indexOf('async function runQuickWheelCommand('));
  assert.match(floor,/class="sd-floor-collections" aria-label="正文收藏"/);
  assert.match(floor,/collectionFloorTools.openLibrary\(root,confirmDialog\)/);
});

test('central collection export reuses host page guard and downloader without advertising an unavailable restore',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),view=await readFile(new URL('../qianmu-storage-backup-view.js',import.meta.url),'utf8');
  assert.match(source,/case 'collections': void collectionFloorTools.exportBackup\(button,confirmDialog,ttsDownloadBlob,\(\)=>createStorageBackupCheck\(button,null\)\)/);
  assert.match(view,/data-storage-export="collections"/);assert.doesNotMatch(view,/data-storage-(pick|import)="collections"/);
});
