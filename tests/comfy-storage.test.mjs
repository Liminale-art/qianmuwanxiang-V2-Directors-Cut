import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {collectComfyStorage,clearComfySceneStorage} from '../qianmu-comfy-storage.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:storage-test';
const summary=(key,bytes,count=1)=>({status:'ready',bytes,count,documentBytes:bytes,indexBytes:0,...(key==='scenes'?{generation:2}:{archived:0,versions:count})});

test('Comfy inventory reads only validated storage summaries, sums each database once and closes all handles',async()=>{
  const calls=[],createStores=Object.fromEntries(['workflows','pools','scenes'].map((key,index)=>[key,async()=>({
    storageSummary:async ns=>{calls.push([key,ns]);return summary(key,(index+1)*100,index+1);},close:()=>calls.push([key,'close']),
    usage:()=>assert.fail('quota is not a full inventory'),
    load:()=>assert.fail('no workflow graph load'),list:()=>assert.fail('no scene or gallery scan'),
  })]));
  assert.equal(calls.length,0);const result=await collectComfyStorage({resolveNamespace:async()=>namespace,createStores});
  assert.equal(result.bytes,600);assert.equal(result.count,6);assert.equal(result.scenes.generation,2);assert.deepEqual(result.errors,[]);
  assert.equal(calls.length,6);assert.equal(calls.filter(([,op])=>op==='close').length,3);assert.equal(result.namespace,namespace);
});

test('one unavailable store reports a partial inventory; account changes do not publish mixed-account totals',async()=>{
  let closes=0,account=namespace;
  const createStores={workflows:async()=>({storageSummary:async()=>{throw Error('blocked');},close:()=>closes++}),
    pools:async()=>({storageSummary:async()=>summary('pools',5),close:()=>closes++}),scenes:async()=>({storageSummary:async()=>summary('scenes',7),close:()=>closes++})};
  const result=await collectComfyStorage({resolveNamespace:async()=>account,createStores});assert.equal(result.bytes,12);assert.equal(result.errors.length,1);assert.match(result.errors[0],/工作流库.*blocked/);assert.equal(closes,3);
  assert.equal(result.workflows.bytes,null);assert.equal(result.workflows.count,null);assert.equal(result.status,'partial');
  createStores.scenes=async()=>({storageSummary:async()=>{account='st-user:other';return summary('scenes',100);},close:()=>closes++});
  await assert.rejects(()=>collectComfyStorage({resolveNamespace:async()=>account,createStores}),/账户/);assert.equal(closes,6);
});

test('cleanup requires the exact inventoried account and generation and cannot delete other stores',async()=>{
  const calls=[];const options={resolveNamespace:async()=>namespace,expectedNamespace:namespace,expectedGeneration:3,
    createStore:async()=>({clearAccount:async(ns,request)=>{calls.push([ns,request.expectedGeneration,request.valid()]);return {removed:2,bytes:80,generation:4};},close:()=>calls.push('closed')})};
  for(const patch of [{expectedNamespace:'st-user:other'},{expectedGeneration:undefined},{valid:()=>false}])await assert.rejects(()=>clearComfySceneStorage({...options,...patch}));
  assert.equal(calls.length,0);const result=await clearComfySceneStorage(options);assert.equal(result.removed,2);assert.deepEqual(calls,[[namespace,3,true],'closed']);
  let account=namespace;await assert.rejects(()=>clearComfySceneStorage({...options,resolveNamespace:async()=>account,createStore:async()=>{
    account='st-user:other';return {clearAccount:()=>assert.fail('stale account delete'),close:()=>calls.push('closed')};
  }}),/账户/);assert.equal(calls.at(-1),'closed');
});

test('actual global inventory attributes all Comfy databases without double counting and keeps browser quota separate',async()=>{
  let collects=0;const comfy={namespace,bytes:600,count:6,workflows:{bytes:100,count:1},pools:{bytes:200,count:2},scenes:{bytes:300,count:3,generation:2},errors:[]};
  const context=vm.createContext({storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:1000,quota:10000})}},
    blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:10,categories:[{category:'images',bytes:10,count:1}]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
    featureRuntime:{load:async key=>key==='comfyStorage'?{collectComfyStorage:async options=>{collects++;assert.equal(await options.resolveNamespace(),namespace);assert.equal(options.valid(),true);return comfy;}}:{manageImageAdmissionStorage:async()=>({bytes:1,count:1}),resolveImageAccountNamespace:async()=>namespace}},
    storyboardManageImageChannels:async()=>({bytes:2,count:1}),storyboardImageServiceRuntime:async()=>({manage:async()=>({bytes:3,count:1})}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>({bytes:4,count:1})}),
    storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics:()=>({}),getChatStore:()=>({}),storageDiagnosticSnapshot:()=>({}),
  });
  vm.runInContext(section('collectStorageInventory'),context);const result=await context.collectStorageInventory();
  assert.equal(collects,1);assert.equal(result.trackedBytes,620);assert.equal(result.manageableBytes,620);assert.equal(result.origin.quota,10000);
  assert.equal(result.categories.find(row=>row.category==='settings').bytes,300);assert.equal(result.categories.find(row=>row.category==='logs').bytes,310);assert.equal(result.comfyStorage.scenes.generation,2);
});

test('actual cleanup handler requires explicit scene selection and refuses a switched account before any other deletion',async()=>{
  for(const mode of ['cancel','unselected','selected','switched','busy']){
    let account=namespace,clears=0,generic=0,closes=0;const events={},notices=[],root={isConnected:true,
      querySelectorAll:()=>[],querySelector:selector=>({addEventListener:(_name,fn)=>events[selector]=fn})};
    const module={clearComfySceneStorage:options=>clearComfySceneStorage({...options,createStore:async()=>({
      clearAccount:async(ns,request)=>{assert.equal(ns,namespace);assert.equal(request.expectedGeneration,2);assert.equal(request.valid(),true);if(mode==='busy')throw Error('在途或结果未明');clears++;return {removed:2};},close:()=>closes++,
    })})};
    const context=vm.createContext({storyboardAdmissionEpoch:1,storageInventoryState:{data:{comfyStorage:{namespace,scenes:{bytes:100,count:2,generation:2}}}},
      openStorageCleanupDialog:async()=>{if(mode==='switched')account='st-user:other';return mode==='cancel'?null:mode==='unselected'?['__diagnostics__']:['__comfy_scenes__'];},
      featureRuntime:{load:async key=>key==='comfyStorage'?module:{resolveImageAccountNamespace:async()=>account}},
      blobStore:{clearStorageItems:async rows=>{generic++;assert.equal(rows.length,0);return {cleared:[],failed:[]};}},
      reconcileClearedStorageItems:()=>({}),saveSettings:()=>{},refreshStorageInventory:async()=>{},toast:message=>notices.push(message),settings:{},storyboardState:()=>({}),
    });
    vm.runInContext(section('bindStorageManagementEvents'),context);context.bindStorageManagementEvents(root);await events['.sd-storage-clean']();
    assert.equal(clears,mode==='selected'?1:0);assert.equal(generic,['selected','unselected'].includes(mode)?1:0);
    if(mode==='busy')assert.ok(notices.some(text=>text.includes('结果未明')));if(mode==='switched')assert.ok(notices.some(text=>text.includes('账户')));
    assert.equal(closes,['selected','busy'].includes(mode)?1:0);
  }
});

test('storage library shortcuts open the independent Comfy library without overwriting model configuration',()=>{
  for(const target of ['workflows','pools']){
    const state={source:'novel',view:'create',profiles:{novel:{model:'unchanged'},comfy:{workflow:'unchanged'}}},before=JSON.stringify(state.profiles);
    let click,opened=0;const root={querySelectorAll:()=>[{dataset:{storageComfyLibrary:target},addEventListener:(_name,fn)=>click=fn}],querySelector:()=>null};
    const context=vm.createContext({activeTab:'plug',storyboardState:()=>state,storyboardBeginSession:()=>opened++});
    vm.runInContext([section('storyboardApplyRoute'),section('bindStorageManagementEvents')].join('\n'),context);
    context.storyboardNavigate=(_root,patch)=>context.storyboardApplyRoute(patch);
    context.bindStorageManagementEvents(root);click();assert.equal(opened,1);assert.equal(state.source,'comfy');assert.equal(state.lastModelSource,'novel');
    assert.equal(state.view,target==='pools'?'comfy-pools':'workflows');assert.equal(JSON.stringify(state.profiles),before);assert.equal(context.activeTab,'imagegen');
  }
});
