import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { summarizeCharacterStorage, validateCharacterStorageSummary, collectCharacterStorage } from '../qianmu-character-storage.js';
import { runRestoreStorage } from '../qianmu-storyboard-restore-storage-runtime.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:character-storage',clone=structuredClone,size=value=>Buffer.byteLength(JSON.stringify(value));
function fixture(){
  const document={name:'艾莉',appearance:'private contents'},key=JSON.stringify([namespace,'alice']);
  const head={namespace,key,id:'alice',revision:'r1',category:'char',name:'艾莉',bytes:size(document)};
  const target={category:'char',subjectKey:'char:Alice.png',scope:'chat',chatKey:'original'};
  const binding={namespace,key:JSON.stringify([namespace,...Object.values(target)]),...target,archiveId:'alice',revision:'bind1'};
  const usage={key:namespace,count:1,bytes:head.bytes,bindings:1};
  return {rows:{heads:[head],bindings:[binding],usage,documentKeys:[key]},document};
}
test('character storage counts actual JSON records, including wrappers, without counting image URL targets or revealing documents',()=>{
  const {rows,document}=fixture(),summary=summarizeCharacterStorage(namespace,rows);
  const record={key:rows.heads[0].key,namespace,revision:'r1',document};
  assert.equal(summary.bytes,size(record)+size(rows.heads[0])+size(rows.bindings[0])+size(rows.usage));
  assert.equal(summary.documents.bytes,size(document));assert.equal(summary.bindings.count,1);assert.equal(summary.filesIncluded,false);
  assert.doesNotMatch(JSON.stringify(summary),/private contents|艾莉|Alice.png|original/);
  assert.deepEqual(validateCharacterStorageSummary(summary,namespace),summary);
});
test('fresh stores remain zero while an emptied existing usage record retains its actual metadata cost',()=>{
  const rows={heads:[],bindings:[],usage:undefined,documentKeys:[]};assert.equal(summarizeCharacterStorage(namespace,rows).bytes,0);
  rows.usage={key:namespace,count:0,bytes:0,bindings:0};assert.equal(summarizeCharacterStorage(namespace,rows).bytes,size(rows.usage));
});
test('missing counters, missing or stray document keys, wrong account and dangling bindings refuse a false complete count',()=>{
  for(const change of [rows=>rows.usage=null,rows=>rows.usage.bytes++,rows=>rows.usage.count++,rows=>rows.documentKeys=[],rows=>rows.documentKeys.push('unexpected'),
    rows=>rows.heads[0].namespace='st-user:other',rows=>rows.bindings[0].namespace='st-user:other',rows=>rows.bindings[0].archiveId='missing',rows=>rows.bindings.push(clone(rows.bindings[0]))]){
    const {rows}=fixture();change(rows);assert.throws(()=>summarizeCharacterStorage(namespace,rows));
  }
});
test('explicit unbound chat overrides are metadata, not broken archive references',()=>{
  const {rows}=fixture();rows.bindings[0].archiveId='';assert.equal(summarizeCharacterStorage(namespace,rows).bindings.count,1);
});
test('summary bridge is lazy, scopes both success and failures, and never manufactures zero on unreadable metadata',async()=>{
  const {rows}=fixture(),summary=summarizeCharacterStorage(namespace,rows);let calls=0,current=namespace;
  const options={resolveNamespace:async()=>current,call:async(type,args)=>{calls++;assert.equal(type,'characters');assert.equal(args.namespace,namespace);return summary;}};
  assert.equal(calls,0);assert.deepEqual(await collectCharacterStorage(options),summary);assert.equal(calls,1);
  const failed=await collectCharacterStorage({...options,call:async()=>{throw Error('index mismatch');}});assert.equal(failed.bytes,null);assert.equal(failed.status,'unavailable');
  await assert.rejects(collectCharacterStorage({...options,call:async()=>{current='st-user:other';return summary;}}),/账户/);
  assert.throws(()=>validateCharacterStorageSummary({...summary,heads:rows.heads},namespace),/摘要/);
});
test('short-lived worker character operation returns only the validated summary and closes',async()=>{
  const {rows}=fixture(),summary=summarizeCharacterStorage(namespace,rows);let closed=0,sent;
  class Worker{addEventListener(type,fn){if(type==='message')this.receive=fn;}postMessage(value){sent=value;queueMicrotask(()=>this.receive({data:{id:value.id,result:summary}}));}terminate(){closed++;}}
  assert.deepEqual(await runRestoreStorage('characters',{namespace,guard:async()=>{},WorkerClass:Worker}),summary);assert.equal(closed,1);assert.deepEqual(Object.keys(sent).sort(),['action','id','namespace']);
});
function globalFixture(summary){return vm.createContext({focusClockLibrary:()=>({summary:async()=>({status:"ready",bytes:0,count:0})}),storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:99999,quota:999999})}},blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:10,categories:[]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
  featureRuntime:{load:async key=>key==='characterStorage'?{collectCharacterStorage:async()=>summary}:key==='comfyStorage'?{collectComfyStorage:async()=>({bytes:0,errors:[]})}:key==='vibeStorageSummary'?{collectVibeStorage:async()=>({status:'unavailable',bytes:null})}:key==='storyboardRestoreStorage'?{collectStoryboardRestoreStorage:async()=>({status:'unavailable',bytes:null})}:{resolveImageAccountNamespace:async()=>namespace,manageImageAdmissionStorage:async()=>({bytes:0})}},
  storyboardManageImageChannels:async()=>({bytes:0}),storyboardImageServiceRuntime:async()=>({manage:async()=>({bytes:0})}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>({bytes:0})}),storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics:()=>({}),getChatStore:()=>({}),storageDiagnosticSnapshot:()=>({}),
  htmlEscape:value=>String(value??'').replaceAll('<','&lt;'),formatStorageBytes:value=>`${value} B`,STORAGE_CATEGORY_LABELS:{},STORAGE_CATEGORY_COLORS:{other:'#777'},storageInventoryState:{status:'ready'},});}
test('focus originals join the space meter exactly once and are not recoverable temporary cache',async()=>{
  const context=globalFixture({status:'unavailable',bytes:null});context.focusClockLibrary=()=>({summary:async()=>({status:'ready',count:2,bytes:1234})});
  vm.runInContext(section('collectStorageInventory'),context);const data=await context.collectStorageInventory();
  assert.equal(data.trackedBytes,1244);assert.equal(data.manageableBytes,1244);assert.equal(data.recoverableBytes,0);
  assert.equal(data.categories.find(row=>row.category==='audio').bytes,1234);assert.equal(data.origin.quota,999999);
});
test('actual global card includes role metadata once, not as recoverable cache, and explains server image exclusion',async()=>{
  const {rows}=fixture(),summary=summarizeCharacterStorage(namespace,rows),context=globalFixture(summary);vm.runInContext([section('collectStorageInventory'),section('renderStorageManagementCard')].join('\n'),context);
  const data=await context.collectStorageInventory();context.storageInventoryState.data=data;assert.equal(data.trackedBytes,10+summary.bytes);assert.equal(data.manageableBytes,10+summary.bytes);assert.equal(data.recoverableBytes,0);assert.equal(data.categories.find(row=>row.category==='characters').bytes,summary.bytes);
  const html=context.renderStorageManagementCard();assert.match(html,/角色库 · 1 份档案/);assert.match(html,/绑定 1 项/);assert.match(html,/不含服务器参考图/);assert.match(html,/sd-storage-characters/);
});
test('unavailable role summary remains explicitly uncounted and keeps the existing management route',async()=>{
  const context=globalFixture({status:'unavailable',namespace,bytes:null,error:'broken <index>'});vm.runInContext([section('collectStorageInventory'),section('renderStorageManagementCard')].join('\n'),context);const data=await context.collectStorageInventory();context.storageInventoryState.data=data;
  assert.equal(data.trackedBytes,10);const html=context.renderStorageManagementCard();assert.match(html,/角色库占用暂不可读取/);assert.match(html,/broken &lt;index>/);assert.doesNotMatch(html,/角色库 · 0 份档案/);
});
test('actual role management shortcut changes only the view and never rewrites engine, prompts or bindings',()=>{
  let click;const routes=[],state={source:'comfy',prompt:'unchanged',bindings:['bound']},before=clone(state);
  const root={querySelector:selector=>selector==='button.sd-storage-characters'?{addEventListener:(_name,fn)=>click=fn}:null,querySelectorAll:()=>[]};
  const context=vm.createContext({activeTab:'plug',storageInventoryState:{sampledAt:1},storyboardBeginSession:()=>{},storyboardNavigate:(_root,route)=>routes.push(route)});vm.runInContext(section('bindStorageManagementEvents'),context);context.bindStorageManagementEvents(root);click();
  assert.deepEqual(JSON.parse(JSON.stringify(routes)),[{view:'characters'}]);assert.equal(context.activeTab,'imagegen');assert.equal(context.storageInventoryState.sampledAt,0);assert.deepEqual(state,before);
});
