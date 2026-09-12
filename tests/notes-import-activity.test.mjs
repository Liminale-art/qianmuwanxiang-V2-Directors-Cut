import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {normalizeQianmuNote, importQianmuNotesBackup} from '../qianmu-notes.js';
const payload=JSON.stringify({type:'qianmu-notes',version:1,notes:[{id:'same',body:'first'},{id:'other',body:'second'}]});
function fixture(){
  const saved=[],notices=[];
  const view={isConnected:true,open:true,classList:{contains:()=>view.open}};
  const c=vm.createContext({document:{getElementById:()=>view},MODAL_ID:'fixture',settings:{},storyboardAdmissionEpoch:1,normalizeQianmuNote,importQianmuNotesBackup,
    confirmDialog:async()=>true,listQianmuNotes:async()=>[{id:'same'}],saveQianmuNote:async note=>saved.push(note),uid:()=> 'copy',
    notesRuntime:['original'],notesLoaded:false,notesPanelOpen:false,renderFloatingNotes(){},refreshStorageInventory:async()=>{},toast:text=>notices.push(text)});
  vm.runInContext(source('createStorageBackupCheck')+'\n'+source('importPinnedNotesBackup'),c);
  c.createCoreadImportViewGuard=()=>({check(){if(c.pageChanged)throw Error('页面变化，已写入内容保留');},release(){c.released=(c.released||0)+1;}});
  c.configRestoreActivity=(include=true,own=null)=>({active:c.otherActivity,transfer:[c.importPinnedNotesBackup,c.importTtsFavoritesBackup,c.coreadImportDataFile,c.coreadExportData,c.exportPinnedNotesBackup,c.exportTtsFavoritesBackup,c.storyboardOpenRestoreStorage].some(t=>t!==own&&t.busy)||c.storageCleanupSession.busy});
  c.importTtsFavoritesBackup={busy:false};
  c.coreadImportDataFile={busy:false};
  c.coreadExportData={busy:false};
  c.exportPinnedNotesBackup={busy:false};c.exportTtsFavoritesBackup={busy:false};
  c.storyboardOpenRestoreStorage={busy:false};
  c.saveImportedQianmuNote=(...args)=>c.saveQianmuNote(...args);
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>1,epoch:()=>c.storyboardAdmissionEpoch,activity:()=>({transfer:c.importPinnedNotesBackup.busy})});
  const input={isConnected:true,files:[{size:payload.length,text:async()=>payload}],value:'fixture'};
  return {c,input,view,saved,notices,run:()=>c.importPinnedNotesBackup({currentTarget:input})};
}

test('notes import cannot start while a reader export is collecting originals',async()=>{
  const e=fixture();e.c.coreadExportData.busy=true;let reads=0;e.input.files[0].text=async()=>{reads++;return payload;};
  await e.run();assert.equal(reads,0);assert.deepEqual(e.saved,[]);assert.match(e.notices.at(-1),/结束备份/);
});

test('notes import also waits for an independent restore manager without reading the chosen file',async()=>{
  const e=fixture();e.c.storyboardOpenRestoreStorage.busy=true;e.input.files[0].text=()=>{throw Error('must not read');};
  await e.run();assert.deepEqual(e.saved,[]);assert.match(e.notices.at(-1),/关闭数据管理窗口/);
});
test('a pending notes import prevents cleanup and duplicate imports before reading finishes',async()=>{
  const e=fixture();let release,reads=0;e.input.files[0].text=()=>{reads++;return new Promise(r=>release=r);};
  const pending=e.run();assert.equal(e.c.importPinnedNotesBackup.busy,true);
  assert.equal(e.c.storageCleanupSession.begin({isConnected:true}),null);
  await e.run();assert.equal(reads,1);release(payload);await pending;
  assert.equal(e.c.importPinnedNotesBackup.busy,false);assert.equal(e.saved.length,2);
  assert.deepEqual(e.saved.map(n=>n.id),['copy','other']);assert.ok(e.saved.every(n=>n.pinned&&!n.floating));
});
test('active cleanup rejects import without reading a file or changing the cleanup lock',async()=>{
  const e=fixture(),token=e.c.storageCleanupSession.begin({isConnected:true});e.input.files[0].text=()=>{throw Error('must not read');};
  await e.run();assert.equal(e.saved.length,0);assert.equal(e.c.storageCleanupSession.busy,true);token.release();
});
for(const phase of ['read','list','save'])test('notes import stops stale '+phase+' work without republishing another configuration',async()=>{
  for(const change of ['owner','epoch','closed','detached','input']){
    const e=fixture();let release;
    if(phase==='read')e.input.files[0].text=()=>new Promise(r=>release=r);
    if(phase==='list')e.c.listQianmuNotes=()=>new Promise(r=>release=r);
    if(phase==='save')e.c.saveQianmuNote=async note=>{e.saved.push(note);await new Promise(r=>release=r);};
    const pending=e.run();await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    if(change==='owner')e.c.settings={newOwner:true};
    if(change==='epoch')e.c.storyboardAdmissionEpoch++;
    if(change==='closed')e.view.open=false;
    if(change==='detached')e.view.isConnected=false;
    if(change==='input')e.input.isConnected=false;
    release(phase==='read'?payload:[]);await pending;
    assert.equal(e.saved.length,phase==='save'?1:0);assert.equal(e.c.notesLoaded,false);
    assert.equal(e.c.notesRuntime[0],'original');assert.equal(e.c.importPinnedNotesBackup.busy,false);assert.match(e.notices.at(-1),/已写入内容保留/);
    if(phase==='save')assert.match(e.notices.at(-1),/已导入 1 条/);
  }
});
test('invalid input releases import activity for the next attempt',async()=>{
  const e=fixture();e.input.files[0].text=async()=>'{';await e.run();
  assert.equal(e.c.importPinnedNotesBackup.busy,false);assert.equal(e.input.value,'');assert.equal(e.saved.length,0);
  e.input.files[0].text=async()=>payload;await e.run();assert.equal(e.saved.length,2);
});

test('cancelling notes confirmation never reads or writes the library and permits a new attempt',async()=>{
  const e=fixture();e.c.confirmDialog=async()=>false;let reads=0;e.c.listQianmuNotes=async()=>{reads++;return [];};
  await e.run();assert.equal(reads,0);assert.deepEqual(e.saved,[]);assert.deepEqual(e.notices,[]);assert.equal(e.c.notesLoaded,false);
  assert.equal(e.c.importPinnedNotesBackup.busy,false);assert.equal(e.input.value,'');
  e.c.confirmDialog=async()=>true;await e.run();assert.equal(e.saved.length,2);
});

test('pending notes confirmation keeps its exclusion lock and rejects changes before the first destination read',async()=>{
  for(const change of ['owner','epoch','closed','page','activity']){
    const e=fixture();let accept,reads=0;e.c.confirmDialog=()=>new Promise(r=>accept=r);
    e.c.listQianmuNotes=async()=>{reads++;return [];};const pending=e.run();await new Promise(r=>setImmediate(r));
    assert.equal(e.c.importPinnedNotesBackup.busy,true);assert.equal(e.c.storageCleanupSession.begin({isConnected:true}),null);
    if(change==='owner')e.c.settings={};if(change==='epoch')e.c.storyboardAdmissionEpoch++;if(change==='closed')e.view.open=false;
    if(change==='page')e.c.pageChanged=true;if(change==='activity')e.c.otherActivity=true;
    accept(true);await pending;assert.equal(reads,0);assert.deepEqual(e.saved,[]);assert.equal(e.c.importPinnedNotesBackup.busy,false);
  }
});

test('too many notes are rejected before library reads or writes, never silently clipped',async()=>{
  const e=fixture();e.input.files[0].text=async()=>JSON.stringify({type:'qianmu-notes',version:1,notes:Array.from({length:1001},()=>({body:'fixture'}))});
  e.c.listQianmuNotes=()=>{throw Error('must not read');};await e.run();
  assert.equal(e.saved.length,0);assert.match(e.notices.at(-1),/超过 1000 条/);assert.equal(e.c.importPinnedNotesBackup.busy,false);
});
test('failed final inventory reports already committed imports and does not publish an empty library',async()=>{
  const e=fixture();let reads=0;e.c.listQianmuNotes=async()=>{if(reads++)throw Error('synthetic read failure');return [];};
  await e.run();assert.equal(e.saved.length,2);assert.equal(e.c.notesRuntime[0],'original');
  assert.match(e.notices.at(-1),/已导入 2 条，已写入内容保留/);assert.match(e.notices.at(-1),/synthetic read failure/);
});
test('a failed entry remains separate from the committed count',async()=>{
  const e=fixture();e.c.saveQianmuNote=async note=>{if(note.id==='copy')throw Error('synthetic write failure');e.saved.push(note);};
  await e.run();assert.equal(e.saved.length,1);assert.match(e.notices.at(-1),/已导入 1 条固定便笺，1 条失败并跳过/);
});

test('notes import stops on late page or task changes, retaining only committed notes and releasing its watcher',async()=>{
  for(const phase of ['before','read','save'])for(const mode of ['page','activity']){
    const e=fixture();let reads=0;
    const change=()=>{if(mode==='page')e.c.pageChanged=true;else e.c.otherActivity=true;};
    e.input.files[0].text=async()=>{reads++;if(phase==='read')change();return payload;};
    if(phase==='before')change();
    if(phase==='save')e.c.saveQianmuNote=async note=>{e.saved.push(note);change();};
    await e.run();assert.equal(e.saved.length,phase==='save'?1:0);assert.equal(e.c.importPinnedNotesBackup.busy||false,false);assert.equal(e.c.released||0,phase==='before'&&mode==='activity'?0:1);
    assert.equal(reads,phase==='before'?0:1);if(phase==='save')assert.match(e.notices.at(-1),/已导入 1 条，已写入内容保留/);
    assert.equal(e.c.notesLoaded,false);
  }
});
