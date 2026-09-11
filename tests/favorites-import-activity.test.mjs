import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {FAVORITES_BACKUP_LIMITS,FAVORITE_TEXT_LIMITS} from '../qianmu-library-backup.js';
const payload=JSON.stringify({type:'qianmu-tts-favorites',version:1,entries:[{id:'one',data:'AA=='},{id:'two',data:'AA=='}]});
function fixture(){
  const saved=[],notices=[],view={isConnected:true,open:true,classList:{contains:()=>view.open}};
  const c=vm.createContext({FAVORITES_BACKUP_LIMITS,FAVORITE_TEXT_LIMITS,settings:{},storyboardAdmissionEpoch:1,document:{getElementById:()=>view},MODAL_ID:'fixture',activeTab:'api',
    toast:m=>notices.push(m),uid:()=> 'copy',base64ToBlob:()=>({size:1}),storageSafeFavoriteMeta:x=>x,refreshStorageInventory:async()=>{},
    blobStore:{hasFavorite:async()=>false,addFavorite:async id=>saved.push(id)}});
  vm.runInContext(source('importTtsFavoritesBackup'),c);
  vm.runInContext(source('importPinnedNotesBackup'),c);
  c.blobStore.importFavorite=(...args)=>c.blobStore.addFavorite(...args);
  c.coreadImportDataFile={busy:false};
  c.coreadExportData={busy:false};
  c.exportPinnedNotesBackup={busy:false};c.exportTtsFavoritesBackup={busy:false};
  c.storyboardOpenRestoreStorage={busy:false};
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>1,epoch:()=>c.storyboardAdmissionEpoch,
    activity:()=>({transfer:c.importTtsFavoritesBackup.busy||c.importPinnedNotesBackup.busy})});
  const input={isConnected:true,value:'fixture',files:[{size:1,text:async()=>payload}]};
  return {c,view,input,saved,notices,run:()=>c.importTtsFavoritesBackup({currentTarget:input})};
}

test('favorite import cannot overlap a reader export',async()=>{
  const e=fixture();e.c.coreadExportData.busy=true;let reads=0;e.input.files[0].text=async()=>{reads++;return payload;};
  await e.run();assert.equal(reads,0);assert.deepEqual(e.saved,[]);assert.match(e.notices.at(-1),/结束备份/);
});

test('favorite import waits for an independent restore manager instead of starting another data writer',async()=>{
  const e=fixture();e.c.storyboardOpenRestoreStorage.busy=true;e.input.files[0].text=()=>{throw Error('must not read');};
  await e.run();assert.deepEqual(e.saved,[]);assert.match(e.notices.at(-1),/关闭数据管理窗口/);
});
test('pending favorite imports exclude cleanup, duplicates and notes without reading another file',async()=>{
  const e=fixture();let release,reads=0;e.input.files[0].text=()=>{reads++;return new Promise(r=>release=r);};
  const pending=e.run();assert.equal(e.c.importTtsFavoritesBackup.busy,true);
  assert.equal(e.c.storageCleanupSession.begin({isConnected:true}),null);
  await e.run();await e.c.importPinnedNotesBackup({currentTarget:e.input});assert.equal(reads,1);
  release(payload);await pending;assert.deepEqual(e.saved,['one','two']);assert.equal(e.c.importTtsFavoritesBackup.busy,false);
});
test('cleanup and notes each block favorite imports without stealing their activity',async()=>{
  for(const lane of ['cleanup','notes']){
    const e=fixture(),token=lane==='cleanup'?e.c.storageCleanupSession.begin({isConnected:true}):null;
    if(lane==='notes')e.c.importPinnedNotesBackup.busy=true;
    e.input.files[0].text=()=>{throw Error('must not read');};await e.run();assert.deepEqual(e.saved,[]);
    assert.equal(lane==='notes'?e.c.importPinnedNotesBackup.busy:e.c.storageCleanupSession.busy,true);token?.release();
  }
});
for(const phase of ['read','lookup','write'])test('favorite '+phase+' waits cannot resume writes into a changed view or owner',async()=>{
  for(const change of ['owner','epoch','closed','detached','input']){
    const e=fixture();let release;
    if(phase==='read')e.input.files[0].text=()=>new Promise(r=>release=r);
    if(phase==='lookup')e.c.blobStore.hasFavorite=()=>new Promise(r=>release=r);
    if(phase==='write')e.c.blobStore.addFavorite=async id=>{e.saved.push(id);await new Promise(r=>release=r);};
    const pending=e.run();await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    if(change==='owner')e.c.settings={};if(change==='epoch')e.c.storyboardAdmissionEpoch++;
    if(change==='closed')e.view.open=false;if(change==='detached')e.view.isConnected=false;if(change==='input')e.input.isConnected=false;
    release(phase==='read'?payload:false);await pending;
    assert.equal(e.saved.length,phase==='write'?1:0);assert.match(e.notices.at(-1),/未完成/);
    if(phase==='write')assert.match(e.notices.at(-1),/已导入 1 条/);
    assert.equal(e.c.importTtsFavoritesBackup.busy,false);
  }
});
test('oversized lists are rejected before lookup, and invalid input releases the lock for retry',async()=>{
  const e=fixture();e.input.files[0].text=async()=>JSON.stringify({type:'qianmu-tts-favorites',version:1,entries:Array(2001).fill({})});
  e.c.blobStore.hasFavorite=()=>{throw Error('must not look up');};await e.run();assert.match(e.notices.at(-1),/超过 2000 条/);assert.deepEqual(e.saved,[]);
  e.input.files[0].text=async()=>'{';await e.run();assert.equal(e.c.importTtsFavoritesBackup.busy,false);
  e.input.files[0].text=async()=>payload;e.c.blobStore.hasFavorite=async()=>false;await e.run();assert.deepEqual(e.saved,['one','two']);
});
test('final inventory errors report completed work without calling the whole import a success',async()=>{
  const e=fixture();e.c.refreshStorageInventory=async()=>{throw Error('synthetic inventory failure');};await e.run();
  assert.deepEqual(e.saved,['one','two']);assert.match(e.notices.at(-1),/未完成：已导入 2 条/);assert.equal(e.c.importTtsFavoritesBackup.busy,false);
});

test('the dedicated import receives its guard; rejected writes never count as imported',async()=>{
  const e=fixture();e.c.blobStore.importFavorite=async(id,blob,meta,label,{check})=>{
    assert.equal(typeof check,'function');check();if(id==='one')throw Error('transaction aborted');e.saved.push(id);
  };await e.run();assert.deepEqual(e.saved,['two']);assert.match(e.notices.at(-1),/已导入 1 条语音收藏，1 条失败/);
});
