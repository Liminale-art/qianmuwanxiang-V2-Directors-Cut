import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createNotesSyncRuntime } from '../qianmu-notes-sync-runtime.js';
import { emptyNotesLocalState, summarizeNotesLocalState, validateNotesLocalState } from '../qianmu-notes-sync-store.js';
import { renderStorageBackupSection, runStorageInventoryJobs } from '../qianmu-storage-backup-view.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:inventory';
function memory(){const states=new Map();let writes=0;return {states,get writes(){return writes;},
  read:async ns=>structuredClone(states.get(ns)||emptyNotesLocalState(ns)),
  update:async(ns,change)=>{const state=structuredClone(states.get(ns)||emptyNotesLocalState(ns));change(state);validateNotesLocalState(state,ns);states.set(ns,state);writes++;return structuredClone(state);},close(){}};}
const note=(id,body,pinned=false)=>({id,title:'private title',body,pinned,createdAt:1,updatedAt:1});

test('account summary includes unpinned content and sync metadata once without returning prose or IDs',async()=>{
  const store=memory(),client={list:()=>assert.fail('no HTTP list'),write:()=>assert.fail('no HTTP write')},runtime=createNotesSyncRuntime({namespace,store,client});
  assert.equal((await runtime.summary()).bytes,0);assert.equal(store.writes,0);
  const a=await runtime.save(note('a','中文😀\nprivate original')),b=await runtime.save(note('b','other original',true));
  await runtime.remove(a.id,{localRevision:a.localRevision});
  const before=structuredClone(store.states.get(namespace)),writes=store.writes,summary=await runtime.summary();
  assert.equal(summary.count,1);assert.equal(summary.pinned,1);assert.equal(summary.deleted,1);assert.equal(summary.pending,1);
  assert.equal(summary.bytes,new TextEncoder().encode(JSON.stringify(before)).byteLength);assert.equal(summary.estimated,true);
  assert.deepEqual(store.states.get(namespace),before);assert.equal(store.writes,writes);
  assert.doesNotMatch(JSON.stringify(summary),/private|original|title|"body"|"id"/);
  const other=createNotesSyncRuntime({namespace:'st-user:other',store,client});assert.equal((await other.summary()).count,0);
  const updated=await runtime.save({...b,pinned:false});assert.equal(updated.body,'other original');assert.equal((await runtime.summary()).count,1);assert.equal((await runtime.summary()).pinned,0);
  runtime.close();other.close();
});

test('inventory is not an editing observation and cannot authorize an unversioned overwrite',async()=>{
  const store=memory(),a=createNotesSyncRuntime({namespace,store}),b=createNotesSyncRuntime({namespace,store});
  await a.save(note('original','keep version'));await b.summary();await b.save(note('original','unversioned edit'));
  assert.deepEqual((await a.list()).map(n=>n.body).sort(),['keep version','unversioned edit']);a.close();b.close();
});

test('malformed or failed local reads reject rather than manufacture zero storage',async()=>{
  assert.throws(()=>summarizeNotesLocalState({...emptyNotesLocalState(namespace),rows:[{}]}));
  const runtime=createNotesSyncRuntime({namespace,store:{read:async()=>{throw Error('broken database');}}});
  await assert.rejects(runtime.summary(),/broken database/);runtime.close();
});

function inventory(summary,collectionStorage={status:'unavailable',bytes:null,count:null}) {
  let initialized=0,account=namespace;
  const zero=()=>({status:'ready',bytes:0,count:0});
  const context=vm.createContext({runStorageInventoryJobs,notesSyncControls:()=>initialized++,getQianmuNotesStorage:async()=>{assert.equal(initialized,1);if(summary instanceof Error)throw summary;return summary;},
    settings:{},collectionFloorTools:{assistantStorageSummary:async()=>({status:'unavailable',bytes:null,count:null}),storageSummary:async()=>collectionStorage},
    focusClockLibrary:()=>({summary:async()=>zero()}),storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:100000,quota:200000})}},
    blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:50,recoverableBytes:0,categories:[{category:'notes',bytes:50,count:2}],stores:[{name:'notes',label:'旧版便笺（本机）',count:2,bytes:50}]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
    featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>account,manageImageAdmissionStorage:async()=>zero(),collectComfyStorage:async()=>zero(),collectVibeStorage:async()=>({status:'unavailable',bytes:null}),collectCharacterStorage:async()=>({status:'unavailable',bytes:null}),collectStoryboardRestoreStorage:async()=>zero(),collectStoryboardMappingStorage:async()=>zero(),collectStoryboardCarrierStorage:async()=>({...zero(),originalCount:0})})},
    storyboardManageImageChannels:async()=>zero(),storyboardImageServiceRuntime:async()=>({manage:async()=>zero()}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>zero()}),
    storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics:()=>({}),getChatStore:()=>({}),storageDiagnosticSnapshot:()=>({}),
  });vm.runInContext(section('collectStorageInventory'),context);return {context,setAccount:value=>{account=value;}};
}

test('actual global inventory adds account notes alongside legacy bytes without offering them to old cleanup',async()=>{
  const summary={status:'ready',namespace,bytes:700,count:3,pinned:1};const {context}=inventory(summary),result=await context.collectStorageInventory();
  assert.equal(result.trackedBytes,750);assert.equal(result.manageableBytes,50);assert.equal(result.recoverableBytes,0);
  assert.equal(result.categories.find(row=>row.category==='notes').bytes,750);assert.equal(result.categories.find(row=>row.category==='notes').count,5);
  assert.equal(result.origin.usage,100000);assert.equal(result.origin.quota,200000);assert.equal(result.notesStorage,summary);
  assert.deepEqual(Array.from(result.idb.stores,row=>row.name),['notes']);
});

test('actual inventory counts pending originals once, excludes server bytes and never calls them recoverable cache',async()=>{
  const collectionStorage={status:'ready',namespace,bytes:9000,count:4,pending:{status:'ready',bytes:321,count:2}};
  const {context}=inventory({status:'ready',namespace,bytes:0,count:0},collectionStorage),result=await context.collectStorageInventory();
  assert.equal(result.trackedBytes,371);assert.equal(result.categories.find(row=>row.category==='collections').bytes,321);assert.equal(result.recoverableBytes,0);assert.equal(result.manageableBytes,50);
  collectionStorage.pending={status:'unavailable',bytes:null,count:null};const failed=await context.collectStorageInventory();assert.equal(failed.trackedBytes,50);
});

test('unreadable account notes remain uncounted and a foreign-account snapshot is never mixed into totals',async()=>{
  const {context}=inventory(Error('not read')),result=await context.collectStorageInventory();
  assert.equal(result.trackedBytes,50);assert.equal(result.notesStorage.status,'unavailable');assert.equal(result.notesStorage.bytes,null);
  const other=inventory({status:'ready',namespace,bytes:700,count:3});other.setAccount('st-user:another');await assert.rejects(other.context.collectStorageInventory(),/账户已变化/);
});

test('notes backup stays direct and compact while legacy cleanup risk remains at the destructive boundary',async()=>{
  const html=renderStorageBackupSection({status:'ready',count:3,pinned:1,bytes:700},bytes=>`${bytes} B`);
  assert.doesNotMatch(html,/内容及同步记录估算|不含其他设备尚未同步|旧版清理/);assert.equal((html.match(/data-storage-export="notes"/g)||[]).length,1);assert.equal((html.match(/data-storage-import="notes"/g)||[]).length,1);
  const failed=renderStorageBackupSection({status:'unavailable',error:'bad <img src=x onerror=alert(1)>'});assert.match(failed,/data-storage-export="notes"/);assert.doesNotMatch(failed,/<img|已保存 0/);
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(source,/notes: \['不可恢复 · 仅旧版本机原件，不删除账户便笺'/);
  assert.doesNotMatch(section('collectStorageInventory'),/syncQianmuNotes\(|deleteQianmuNote\(/);
});
