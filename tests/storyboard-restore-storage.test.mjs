import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {renderStorageBackupSection} from '../qianmu-storage-backup-view.js';
import { collectRestoreStorage, clearRestoreStorage, validateRestoreStorageSummary } from '../qianmu-storyboard-restore-storage.js';
import { runRestoreStorage, collectStoryboardRestoreStorage } from '../qianmu-storyboard-restore-storage-runtime.js';
import { renderRestoreStorageReview } from '../qianmu-storyboard-restore-storage-view.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:storage',chatHash='a'.repeat(64),fileHash='b'.repeat(64),clone=structuredClone;
const pick=row=>({kind:row.kind,key:row.key,fingerprint:row.fingerprint});
function fixture(){
  const common={version:1,namespace,revision:1,createdAt:1};
  const mutation={...common,chatHash,fileHash,phase:'uncertain',patch:[{area:'settings',key:'promptDefaults',before:{exists:true,value:{text:'private old text'}},after:{exists:true,value:{text:'private new text'}}}]};
  const checkpoint={...common,sourceNamespace:namespace,chatHash,fileHash,fileBytes:12000000,assetIds:['c'.repeat(64)],phase:'assets_ready',updatedAt:1,key:JSON.stringify([namespace,chatHash,fileHash])};
  const e={rows:new Map([['configuration',mutation],['vibes',checkpoint],...['characters','bundle'].map(kind=>[kind,{...common,kind,key:JSON.stringify([namespace,kind]),sourceDigest:fileHash,planDigest:'c'.repeat(64),phase:'verified',updatedAt:1,...(kind==='bundle'?{chatHash:'d'.repeat(64)}:{})}])]),removed:[],locks:[],live:true};
  const get=kind=>clone(e.rows.get(kind)||null);
  const dismiss=(kind,input,options)=>{assert.equal(options.confirmed,true);assert.equal(options.isCurrent(),true);assert.deepEqual(input,e.rows.get(kind));e.rows.delete(kind);e.removed.push(kind);e.afterRemove?.(kind);};
  const journal={list:async ns=>{assert.equal(ns,namespace);return e.rows.has('vibes')?[get('vibes')]:[];},loadMutation:async()=>get('configuration'),loadResource:async(_ns,kind)=>get(kind),
    dismissMutation:async(...args)=>dismiss('configuration',...args),dismissCheckpoint:async(...args)=>dismiss('vibes',...args),dismissResource:async(row,...args)=>dismiss(row.kind,row,...args)};
  const options={journal,namespace,guard:async()=>{if(!e.live)throw Error('scope');},isCurrent:()=>e.live,locks:{request:async(name,options,fn)=>{e.locks.push(name);return fn(e.locked?null:{});}}};
  return {e,options};
}
const consent={confirmed:true,recoveryLossAccepted:true};

test('restore inventory counts stored journal bodies once, not referenced media, and exposes only bounded metadata',async()=>{
  const {e,options}=fixture(),summary=await collectRestoreStorage(options);
  assert.equal(summary.count,4);assert.equal(summary.bytes,[...e.rows.values()].reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row)),0));
  assert.ok(summary.bytes<12000000);assert.doesNotMatch(JSON.stringify(summary),/private old text|private new text|assetIds|patch/);
  assert.deepEqual(validateRestoreStorageSummary(summary,namespace),summary);assert.deepEqual(e.removed,[]);
});

test('only separately confirmed selected journal rows are cleared under both restore locks',async()=>{
  const {e,options}=fixture(),summary=await collectRestoreStorage(options),selected=summary.items.filter(row=>['configuration','characters'].includes(row.kind)).map(pick);
  const result=await clearRestoreStorage({...options,...consent,selected});
  assert.equal(result.complete,true);assert.deepEqual(e.removed,['configuration','characters']);assert.equal(e.rows.has('vibes'),true);assert.equal(e.rows.has('bundle'),true);
  assert.deepEqual(e.locks,[`qianmu:package-import:${namespace}`,`qianmu:character-restore:${namespace}`]);
  assert.equal(result.bytes,summary.items.filter(row=>selected.some(x=>x.kind===row.kind)).reduce((sum,row)=>sum+row.bytes,0));
});

test('missing risk consent, duplicates, alien keys and stale fingerprints all fail without deleting anything',async()=>{
  const {e,options}=fixture(),selected=(await collectRestoreStorage(options)).items.map(pick);
  for(const change of [{confirmed:false},{recoveryLossAccepted:false},{selected:[selected[0],selected[0]]},{selected:[null]},
    {selected:[{...selected[0],key:'other account'}]},{selected:[{...selected[0],fingerprint:'f'.repeat(64)}]}]){
    await assert.rejects(clearRestoreStorage({...options,...consent,selected,...change}));assert.deepEqual(e.removed,[]);
  }
  e.rows.get('configuration').patch[0].before.value.text='newer';
  await assert.rejects(clearRestoreStorage({...options,...consent,selected}),/已变化/);assert.deepEqual(e.removed,[]);
});

test('active restore locks or changed account guards stop all deletion',async()=>{
  const {e,options}=fixture(),selected=(await collectRestoreStorage(options)).items.map(pick);
  e.locked=true;await assert.rejects(clearRestoreStorage({...options,...consent,selected}),/另一页面/);
  e.locked=false;e.live=false;await assert.rejects(clearRestoreStorage({...options,...consent,selected}),/页面|scope/);assert.deepEqual(e.removed,[]);
  await assert.rejects(clearRestoreStorage({...options,...consent,selected,locks:null}),/跨页/);
});

test('a mid-clear CAS failure reports partial results and never deletes a newly changed next record',async()=>{
  const {e,options}=fixture(),selected=(await collectRestoreStorage(options)).items.map(pick);
  e.afterRemove=()=>{e.rows.get('configuration').revision++;};
  const result=await clearRestoreStorage({...options,...consent,selected});
  assert.equal(result.complete,false);assert.equal(result.removed.length,1);assert.equal(result.remaining,3);assert.equal(e.rows.get('configuration').revision,2);assert.deepEqual(e.removed,['vibes']);
});

test('corrupt/unavailable inventory is not reported as zero and late account changes invalidate successes and failures',async()=>{
  const {options}=fixture(),summary=await collectRestoreStorage(options);let current=namespace;
  const args={resolveNamespace:async()=>current,call:async()=>summary};
  assert.deepEqual(await collectStoryboardRestoreStorage(args),summary);
  const failure=await collectStoryboardRestoreStorage({...args,call:async()=>{throw Error('unavailable');}});assert.equal(failure.bytes,null);assert.equal(failure.status,'unavailable');
  await assert.rejects(collectStoryboardRestoreStorage({...args,call:async()=>{current='st-user:changed';return summary;}}),/账户/);
  assert.throws(()=>validateRestoreStorageSummary({...summary,patch:'private'},namespace),/计值/);
  const wrong=clone(summary);wrong.items[0].key=JSON.stringify(['st-user:other',chatHash,fileHash]);assert.throws(()=>validateRestoreStorageSummary(wrong,namespace),/归属/);
});

class WorkerFixture{
  static handler;static instances=[];
  constructor(){this.events={};this.sent=[];WorkerFixture.instances.push(this);}
  addEventListener(name,fn){this.events[name]=fn;}
  postMessage(value){this.sent.push(clone(value));queueMicrotask(()=>WorkerFixture.handler(this,value));}
  emit(value){this.events.message({data:value});}
  terminate(){this.closed=true;}
}
test('worker transport uses scoped guard acknowledgements and terminates after compact summaries',async()=>{
  const {options}=fixture(),summary=await collectRestoreStorage(options);let checks=0;
  WorkerFixture.handler=(w,value)=>{if(value.action){w.id=value.id;w.emit({id:'old',result:{}});w.emit({id:w.id,guard:1});}else w.emit({id:w.id,result:summary});};
  const result=await runRestoreStorage('inspect',{namespace,guard:async()=>{checks++;},WorkerClass:WorkerFixture});assert.deepEqual(result,summary);assert.ok(checks>=3);
  const worker=WorkerFixture.instances.at(-1);assert.equal(worker.closed,true);assert.deepEqual(Object.keys(worker.sent[0]).sort(),['action','id','namespace']);assert.equal(worker.sent[1].guard,1);
});

test('worker cancellation and malformed clear results never retry or claim that all source data stayed untouched',async()=>{
  WorkerFixture.handler=()=>{};
  const {options}=fixture(),selected=(await collectRestoreStorage(options)).items.map(pick),abort=new AbortController();
  const request=runRestoreStorage('clear',{namespace,selected,...consent,guard:async()=>{},signal:abort.signal,WorkerClass:WorkerFixture});await new Promise(resolve=>setImmediate(resolve));abort.abort();
  await assert.rejects(request,/部分记录可能已结束/);assert.equal(WorkerFixture.instances.at(-1).closed,true);
  WorkerFixture.handler=(w,value)=>w.emit({id:value.id,result:{version:1,namespace,removed:[selected[0],selected[0]],bytes:1,complete:true,remaining:0}});
  await assert.rejects(runRestoreStorage('clear',{namespace,selected,...consent,guard:async()=>{},WorkerClass:WorkerFixture}),/清理结果不符/);
});

test('duplicate guards and raw configuration hidden inside a worker summary are rejected',async()=>{
  WorkerFixture.handler=(w,value)=>{if(value.action){w.emit({id:value.id,guard:1});w.emit({id:value.id,guard:1});}};
  await assert.rejects(runRestoreStorage('inspect',{namespace,guard:async()=>{},WorkerClass:WorkerFixture}),/序号/);
  const {options}=fixture(),summary=await collectRestoreStorage(options);
  WorkerFixture.handler=(w,value)=>w.emit({id:value.id,result:{...summary,patch:'private'}});
  await assert.rejects(runRestoreStorage('inspect',{namespace,guard:async()=>{},WorkerClass:WorkerFixture}),/计值/);
});

test('the record manager is unchecked by default, names destructive consequences and escapes error text',async()=>{
  const {options}=fixture(),summary=await collectRestoreStorage(options);
  const html=renderRestoreStorageReview({summary,busy:false,notice:'<script>bad</script>',selected:new Set(),accepted:false,chatHash},value=>`${value} B`);
  assert.equal((html.match(/data-restore-item=/g)||[]).length,4);assert.doesNotMatch(html,/ checked/);assert.match(html,/data-restore-storage="clear" disabled/);
  assert.match(html,/无法再通过“核对导入”/);assert.match(html,/其他聊天/);assert.match(html,/账户级角色库/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/private old text/);
});

function globalFixture(restore,mappings={status:'unavailable',bytes:null,error:'not sampled'}){
  return vm.createContext({renderStorageBackupSection,focusClockLibrary:()=>({summary:async()=>({status:"ready",bytes:0,count:0})}),storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:9999,quota:99999})}},
    blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:10,categories:[]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
    featureRuntime:{load:async key=>key==='storyboardRestoreStorage'?{collectStoryboardRestoreStorage:async()=>restore,collectStoryboardMappingStorage:async()=>mappings}:key==='vibeStorageSummary'?{collectVibeStorage:async()=>({status:'unavailable',bytes:null})}:key==='comfyStorage'?{collectComfyStorage:async()=>({bytes:0,errors:[]})}:{manageImageAdmissionStorage:async()=>({bytes:0,count:0}),resolveImageAccountNamespace:async()=>namespace}},
    storyboardManageImageChannels:async()=>({bytes:0}),storyboardImageServiceRuntime:async()=>({manage:async()=>({bytes:0})}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>({bytes:0})}),
    storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics:()=>({}),getChatStore:()=>({}),storageDiagnosticSnapshot:()=>({}),htmlEscape:value=>String(value??'').replaceAll('<','&lt;'),formatStorageBytes:value=>`${value} B`,storageInventoryState:{status:'ready'},STORAGE_CATEGORY_LABELS:{logs:'记录'},STORAGE_CATEGORY_COLORS:{logs:'#777',other:'#555'},
  });
}
test('actual space card adds journal bytes exactly once without calling them recoverable or server disk capacity',async()=>{
  const {options}=fixture(),summary=await collectRestoreStorage(options),context=globalFixture(summary);
  vm.runInContext([section('collectStorageInventory'),section('renderStorageManagementCard')].join('\n'),context);
  const data=await context.collectStorageInventory();context.storageInventoryState.data=data;
  assert.equal(data.trackedBytes,10+summary.bytes);assert.equal(data.manageableBytes,10+summary.bytes);assert.equal(data.recoverableBytes,0);assert.equal(data.origin.quota,99999);
  assert.equal(data.categories.find(row=>row.category==='logs').bytes,summary.bytes);
  const html=context.renderStorageManagementCard();assert.match(html,/分镜恢复记录 · 4 条/);assert.match(html,/sd-storage-restores/);assert.match(html,/不代表 VPS 磁盘总容量/);
});

test('actual space card keeps an unavailable record manager visible without manufacturing a zero-byte result',async()=>{
  const context=globalFixture({status:'unavailable',namespace,bytes:null,error:'bad <record>'});vm.runInContext([section('collectStorageInventory'),section('renderStorageManagementCard')].join('\n'),context);
  const data=await context.collectStorageInventory();context.storageInventoryState.data=data;assert.equal(data.trackedBytes,10);
  const html=context.renderStorageManagementCard();assert.match(html,/恢复记录占用暂不可读取 · 当前总计不含此部分/);assert.match(html,/bad &lt;record>/);assert.doesNotMatch(html,/分镜恢复记录 · 0 条/);
});

test('actual space card counts mapping bodies plus heads once, without advertising them as clearable cache',async()=>{
  const {options}=fixture(),summary=await collectRestoreStorage(options),mappings={version:1,status:'ready',namespace,count:2,bytes:1400,recordBytes:1000,indexBytes:400},context=globalFixture(summary,mappings);
  vm.runInContext([section('collectStorageInventory'),section('renderStorageManagementCard')].join('\n'),context);
  const data=await context.collectStorageInventory();context.storageInventoryState.data=data;
  assert.equal(data.trackedBytes,10+summary.bytes+1400);assert.equal(data.manageableBytes,10+summary.bytes);assert.equal(data.recoverableBytes,0);
  assert.equal(data.categories.find(row=>row.category==='logs').bytes,summary.bytes+1400);
  const html=context.renderStorageManagementCard();assert.match(html,/迁移映射凭据 · 2 份 · 1400 B/);assert.match(html,/sd-storage-mappings/);assert.match(html,/凭据管理/);
});

test('actual mapping entry is available when accounting fails and never routes to clearing',async()=>{
  let click,args;
  const root={isConnected:true,querySelector:selector=>selector==='button.sd-storage-mappings'?{addEventListener:(_event,fn)=>click=fn}:null,querySelectorAll:()=>[]};
  const context=vm.createContext({renderStorageBackupSection,storageInventoryState:{data:{mappingStorage:{status:'unavailable',namespace}}},storyboardOpenRestoreStorage:(...input)=>args=input});
  vm.runInContext(section('bindStorageManagementEvents'),context);context.bindStorageManagementEvents(root);click();
  assert.equal(args[0],root);assert.equal(args[1],namespace);assert.equal(args[2].mappings,true);
});

test('actual module cleanup opens per-record choices and does not clear a whole module or save settings on cancel',async()=>{
  let click,opened=0;
  const root={isConnected:true,querySelector:selector=>selector==='.sd-storage-clean'?{addEventListener:(_event,fn)=>click=fn}:null,querySelectorAll:()=>[]};
  const context=vm.createContext({renderStorageBackupSection,storyboardAdmissionEpoch:1,storageInventoryState:{data:{restoreStorage:{namespace}}},openStorageCleanupDialog:async()=>['__storyboard_restores__'],
    storyboardOpenRestoreStorage:async(target,scope)=>{assert.equal(target,root);assert.equal(scope,namespace);opened++;},
    blobStore:{clearStorageItems:()=>assert.fail('no whole-module deletion')},saveSettings:()=>assert.fail('no unrelated save'),toast:()=>assert.fail('do not claim cancelled selection was cleared')});
  context.storageCleanupSession=createStorageCleanupSession({owner:()=>context.settings,scope:()=>'',epoch:()=>context.storyboardAdmissionEpoch});
  vm.runInContext(section('bindStorageManagementEvents'),context);context.bindStorageManagementEvents(root);await click();assert.equal(opened,1);
});
