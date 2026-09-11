import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {normalizeQianmuNote, importQianmuNotesBackup} from '../qianmu-notes.js';
const payload=JSON.stringify({type:'qianmu-notes',version:1,notes:[{id:'same',body:'first'},{id:'other',body:'second'}]});
function fixture(){
  const saved=[],notices=[];
  const c=vm.createContext({settings:{},storyboardAdmissionEpoch:1,normalizeQianmuNote,importQianmuNotesBackup,
    listQianmuNotes:async()=>[{id:'same'}],saveQianmuNote:async note=>saved.push(note),uid:()=> 'copy',
    notesRuntime:['original'],notesLoaded:false,notesPanelOpen:false,renderFloatingNotes(){},refreshStorageInventory:async()=>{},toast:text=>notices.push(text)});
  vm.runInContext(source('importPinnedNotesBackup'),c);
  c.saveImportedQianmuNote=(...args)=>c.saveQianmuNote(...args);
  c.storageCleanupSession=createStorageCleanupSession({owner:()=>c.settings,scope:()=>1,epoch:()=>c.storyboardAdmissionEpoch,activity:()=>({transfer:c.importPinnedNotesBackup.busy})});
  const input={files:[{size:payload.length,text:async()=>payload}],value:'fixture'};
  return {c,input,saved,notices,run:()=>c.importPinnedNotesBackup({currentTarget:input})};
}
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
  for(const change of ['owner','epoch']){
    const e=fixture();let release;
    if(phase==='read')e.input.files[0].text=()=>new Promise(r=>release=r);
    if(phase==='list')e.c.listQianmuNotes=()=>new Promise(r=>release=r);
    if(phase==='save')e.c.saveQianmuNote=async note=>{e.saved.push(note);await new Promise(r=>release=r);};
    const pending=e.run();await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    if(change==='owner')e.c.settings={newOwner:true};else e.c.storyboardAdmissionEpoch++;
    release(phase==='read'?payload:[]);await pending;
    assert.equal(e.saved.length,phase==='save'?1:0);assert.equal(e.c.notesLoaded,false);
    assert.equal(e.c.notesRuntime[0],'original');assert.equal(e.c.importPinnedNotesBackup.busy,false);assert.match(e.notices.at(-1),/已写入内容保留/);
  }
});
test('invalid input releases import activity for the next attempt',async()=>{
  const e=fixture();e.input.files[0].text=async()=>'{';await e.run();
  assert.equal(e.c.importPinnedNotesBackup.busy,false);assert.equal(e.input.value,'');assert.equal(e.saved.length,0);
  e.input.files[0].text=async()=>payload;await e.run();assert.equal(e.saved.length,2);
});
