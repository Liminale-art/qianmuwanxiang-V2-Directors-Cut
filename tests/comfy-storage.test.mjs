import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {runStorageInventoryJobs} from '../qianmu-storage-backup-view.js';
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
  const context=vm.createContext({runStorageInventoryJobs,focusClockLibrary:()=>({summary:async()=>({status:"ready",bytes:0,count:0})}),storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:1000,quota:10000})}},
    notesSyncControls(){},getQianmuNotesStorage:async()=>({status:'ready',bytes:0,count:0,pinned:0}),
    settings:{},proseFloorTools:{assistantStorageSummary:async()=>({status:'unavailable',bytes:null,count:null}),collectionStorageSummary:async()=>({status:'ready',namespace,bytes:0,count:0,fingerprint:null})},
    blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:10,categories:[{category:'images',bytes:10,count:1}]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
    featureRuntime:{load:async key=>key==='comfyStorage'?{collectComfyStorage:async options=>{collects++;assert.equal(await options.resolveNamespace(),namespace);assert.equal(options.valid(),true);return comfy;}}:{manageImageAdmissionStorage:async()=>({bytes:1,count:1}),resolveImageAccountNamespace:async()=>namespace}},
    storyboardManageImageChannels:async()=>({bytes:2,count:1}),storyboardImageServiceRuntime:async()=>({manage:async()=>({bytes:3,count:1})}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>({bytes:4,count:1})}),
    storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics:()=>({}),getChatStore:()=>({}),storageDiagnosticSnapshot:()=>({}),
  });
  vm.runInContext(section('collectStorageInventory'),context);const result=await context.collectStorageInventory();
  assert.equal(collects,1);assert.equal(result.trackedBytes,620);assert.equal(result.manageableBytes,620);assert.equal(result.origin.quota,10000);
  assert.equal(result.categories.find(row=>row.category==='settings').bytes,300);assert.equal(result.categories.find(row=>row.category==='logs').bytes,310);assert.equal(result.comfyStorage.scenes.generation,2);
});
