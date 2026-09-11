import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {collectVibeStorage,validateVibeStorageSummary} from '../qianmu-vibe-storage-summary.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:summary';
const summary=()=>({version:2,status:'ready',namespace,bytes:530,assets:{bytes:400,count:2,originalCount:1,encodingCount:1},previews:{bytes:40,count:1},records:{bytes:60,count:3,archivedCount:1,pendingCount:1,reviewCount:32},metadata:{bytes:30,count:6,assetBytes:20,ledgerBytes:10}});

test('worker summary counts files, previews, ready archive and older reviews exactly once without sending file lists',async()=>{
  let reads=0;const store={inventory:async()=>{reads++;return {heads:[{assetId:'a',bytes:400,previewBytes:40,summary:{type:'image',name:'image',sourceId:'s',variants:[]}}],usage:{count:1,bytes:400,previewBytes:40,limit:999},metadata:{bytes:20,count:4}};},load:()=>assert.fail('no bodies')};
  const row={status:'unknown',identity:{sourceId:'s'}};
  const encodings={inventory:async()=>({receipts:[row],archived:{count:2,bytes:60},reviewHistory:{reviews:32,bytes:100},metadata:{bytes:10,count:2}}),reviewHistory:()=>assert.fail('no full history')};
  const run=createVibeAssetOperations(store,{encodings}),result=await run({type:'storage-summary',namespace});assert.equal(reads,1);
  const receiptBytes=Buffer.byteLength(JSON.stringify(row));assert.equal(result.bytes,400+40+60+100+receiptBytes+30);assert.equal(result.metadata.bytes,30);assert.equal(result.records.count,3);assert.equal(result.records.archivedCount,2);assert.equal(result.records.reviewCount,32);
  assert.equal(result.records.pendingCount,1);assert.equal(result.assets.originalCount,1);assert.equal(result.previews.count,1);assert.equal(Object.hasOwn(result,'items'),false);
  assert.deepEqual(validateVibeStorageSummary(result,namespace),result);
});
test('summary bridge is on demand, scoped before and after reading, and returns no fake zero on failure',async()=>{
  let calls=0;const options={resolveNamespace:async()=>namespace,call:async(type,args)=>{calls++;assert.equal(type,'storage-summary');assert.deepEqual(args,{namespace});return summary();}};
  assert.equal(calls,0);assert.deepEqual(await collectVibeStorage(options),summary());assert.equal(calls,1);
  const broken=await collectVibeStorage({...options,call:async()=>{throw Error('damaged receipt');}});assert.equal(broken.status,'unavailable');assert.equal(broken.bytes,null);assert.equal(Object.hasOwn(broken,'assets'),false);assert.match(broken.error,/damaged receipt/);
  for(const patch of [{namespace:'st-user:other'},{bytes:NaN},{bytes:499},{assets:{...summary().assets,encodingCount:-1}},{records:{...summary().records,pendingCount:3}}]){
    const bad=await collectVibeStorage({...options,call:async()=>({...summary(),...patch})});assert.equal(bad.status,'unavailable');assert.equal(bad.bytes,null);
  }
});
test('account or page changes during success and error paths reject the old summary',async()=>{
  let account=namespace,live=true;const options={resolveNamespace:async()=>account,valid:()=>live};
  await assert.rejects(()=>collectVibeStorage({...options,valid:()=>false,call:()=>assert.fail('closed page read')}),{code:'vibe_storage_stale'});
  await assert.rejects(()=>collectVibeStorage({...options,call:async()=>{account='st-user:other';return summary();}}),{code:'vibe_storage_stale'});account=namespace;
  await assert.rejects(()=>collectVibeStorage({...options,call:async()=>{live=false;throw Error('read error');}}),{code:'vibe_storage_stale'});
});
function globalContext(value=summary()){
  return vm.createContext({focusClockLibrary:()=>({summary:async()=>({status:"ready",bytes:0,count:0})}),storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:2000,quota:10000})}},
    blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:10,categories:[{category:'images',bytes:10,count:1}]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
    featureRuntime:{load:async key=>key==='vibeStorageSummary'?{collectVibeStorage:options=>collectVibeStorage({...options,call:async()=>{if(value instanceof Error)throw value;return value;}})}:key==='comfyStorage'?{collectComfyStorage:async()=>({bytes:600,workflows:{bytes:100,count:1},pools:{bytes:200,count:2},scenes:{bytes:300,count:3},errors:[]})}:{manageImageAdmissionStorage:async()=>({bytes:1,count:1}),resolveImageAccountNamespace:async()=>namespace}},
    storyboardManageImageChannels:async()=>({bytes:2,count:1}),storyboardImageServiceRuntime:async()=>({manage:async()=>({bytes:3,count:1})}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>({bytes:4,count:1})}),
    storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics:()=>({}),getChatStore:()=>({}),storageDiagnosticSnapshot:()=>({}),
    htmlEscape:value=>String(value??'').replaceAll('<','&lt;'),formatStorageBytes:value=>`${value} B`,storageInventoryState:{status:'ready'},
  });
}
test('actual global inventory includes Vibe exactly once while preserving browser quota and recoverable limits',async()=>{
  const context=globalContext();vm.runInContext(section('collectStorageInventory'),context);const data=await context.collectStorageInventory();
  assert.equal(data.trackedBytes,1150);assert.equal(data.manageableBytes,1150);assert.equal(data.recoverableBytes,0);assert.equal(data.origin.quota,10000);
  assert.equal(data.categories.find(row=>row.category==='vibes').bytes,420);assert.equal(data.categories.find(row=>row.category==='cache').bytes,40);assert.equal(data.categories.find(row=>row.category==='logs').bytes,380);
  assert.equal(data.vibeStorage.records.reviewCount,32);
});
test('actual global card reports unmeasured Vibe content without losing its management entry or implying zero',async()=>{
  const context=globalContext(Error('bad <metadata>'));vm.runInContext([section('collectStorageInventory'),section('refreshStorageInventory'),section('renderStorageManagementCard')].join('\n'),context);
  const data=await context.collectStorageInventory();context.storageInventoryState.data=data;const html=context.renderStorageManagementCard();
  assert.equal(data.trackedBytes,620);assert.equal(data.vibeStorage.bytes,null);assert.match(html,/当前总计不含此部分/);assert.match(html,/未盘点站点数据/);assert.match(html,/sd-storage-vibes/);assert.match(html,/bad &lt;metadata>/);
  assert.doesNotMatch(html,/Vibe 文件 · 0/);
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settled=()=>new Promise(resolve=>setImmediate(resolve));
function refreshContext(){let scope='A',count=0;const requests=[],context=vm.createContext({storageInventoryResolveSerial:0,storageInventoryState:{status:'idle',data:null},
  storageInventoryScope:async()=>scope,collectStorageInventory:()=>{count++;const request=deferred();requests.push(request);return request.promise;},paintStorageManagementCard:()=>{},
});vm.runInContext(section('refreshStorageInventory'),context);return {context,requests,setScope:value=>scope=value,count:()=>count};}
test('actual refresh caches only within the same account scope and discards older completion after a new account refresh',async()=>{
  const e=refreshContext(),a=e.context.refreshStorageInventory();await settled();e.setScope('B');const b=e.context.refreshStorageInventory();await settled();
  e.requests[1].resolve({sampledAt:Date.now(),owner:'B'});assert.equal((await b).owner,'B');e.requests[0].resolve({sampledAt:Date.now(),owner:'A'});assert.equal(await a,null);assert.equal(e.context.storageInventoryState.data.owner,'B');
  assert.equal((await e.context.refreshStorageInventory()).owner,'B');assert.equal(e.count(),2);
  e.setScope('C');const c=e.context.refreshStorageInventory();await settled();assert.equal(e.context.storageInventoryState.data,null);e.requests[2].reject(Error('unavailable'));assert.equal(await c,null);assert.equal(e.context.storageInventoryState.data,null);
});
test('actual refresh never publishes results after an unrefreshed account switch or a late scope-resolution failure',async()=>{
  const e=refreshContext(),pending=e.context.refreshStorageInventory();await settled();e.setScope('B');e.requests[0].resolve({sampledAt:Date.now(),owner:'A'});assert.equal(await pending,null);assert.equal(e.context.storageInventoryState.data,null);
  const old=deferred(),next=deferred();let call=0;e.context.storageInventoryScope=()=>++call===1?old.promise:next.promise;
  const a=e.context.refreshStorageInventory(),b=e.context.refreshStorageInventory();next.resolve('C');await settled();e.requests[1].resolve({sampledAt:Date.now(),owner:'C'});await b;
  old.reject(Error('old account unavailable'));assert.equal(await a,null);assert.equal(e.context.storageInventoryState.data.owner,'C');
});
test('actual Vibe storage shortcut preserves provider, prompts and selection and routes directly into the existing manager',()=>{
  const state={source:'comfy',view:'create',selectedVibeIds:['keep'],profiles:{novel:{model:'same'},comfy:{workflow:'same'}},positive:'keep'},before=JSON.stringify(state);let click;
  const root={querySelector:selector=>selector==='button.sd-storage-vibes'?{addEventListener:(_name,fn)=>click=fn}:null,querySelectorAll:()=>[]},modal={id:'panel'},routes=[],mounts=[];
  const context=vm.createContext({activeTab:'plug',storageInventoryState:{data:{},sampledAt:123},storyboardState:()=>state,storyboardBeginSession:()=>{},MODAL_ID:'panel',document:{getElementById:()=>modal},
    storyboardMountVibeLibrary:(node,options)=>mounts.push([node,{...options}])});
  vm.runInContext([section('storyboardApplyRoute'),section('bindStorageManagementEvents')].join('\n'),context);
  context.storyboardNavigate=(_root,patch)=>{routes.push({...patch});context.storyboardApplyRoute(patch);};context.bindStorageManagementEvents(root);click();
  assert.equal(context.activeTab,'imagegen');assert.deepEqual(routes,[{view:'assets',assetView:'vibes'}]);assert.deepEqual(mounts,[[modal,{manager:'storage'}]]);
  assert.deepEqual(state,{...JSON.parse(before),view:'assets',assetView:'vibes'});assert.equal(context.storageInventoryState.sampledAt,0);
});
