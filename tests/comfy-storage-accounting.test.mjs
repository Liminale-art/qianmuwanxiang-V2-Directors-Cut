import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {summarizeComfyLibraryStorage,validateComfyStorageSummary} from '../qianmu-comfy-storage-accounting.js';
import {collectComfyStorage} from '../qianmu-comfy-storage.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:comfy-accounting',size=value=>Buffer.byteLength(JSON.stringify(value));
function library(kind){
  const key=JSON.stringify([namespace,'one']),documents=[],versions=[];let total=0;
  for(let i=1;i<=2;i++){
    const revision=`r${i}`,document={prompt:'private workflow',revision},bytes=size(document),docKey=JSON.stringify([namespace,'one',revision]);total+=bytes;
    const meta={key:docKey,namespace,id:'one',revision,version:i,name:'方案',archived:false,bytes,totalBytes:total,[kind==='workflows'?'workflowKey':'poolKey']:key,...(kind==='workflows'?{parentRevision:i===1?'':'r1'}:{})};versions.push(meta);
    documents.push(kind==='workflows'?{key:docKey,namespace,id:'one',revision,document}:{key:docKey,namespace,id:'one',revision,version:i,name:meta.name,pool:document,bytes});
  }
  const head={...versions[1],key,archived:true};delete head.workflowKey;delete head.poolKey;delete head.parentRevision;
  return {heads:[head],versions,documentKeys:documents.map(row=>row.key),documents};
}
function complete(){
  const workflows=summarizeComfyLibraryStorage('workflows',namespace,library('workflows')),pools=summarizeComfyLibraryStorage('pools',namespace,library('pools'));
  const scenes={status:'ready',count:1,bytes:21,documentBytes:10,indexBytes:11,generation:3};
  return {version:1,status:'ready',namespace,workflows,pools,scenes,bytes:workflows.bytes+pools.bytes+scenes.bytes,count:3,errors:[]};
}
test('Comfy accounting includes every immutable version, archived heads, index rows and actual document wrappers exactly once',()=>{
  for(const kind of ['workflows','pools']){
    const rows=library(kind),summary=summarizeComfyLibraryStorage(kind,namespace,rows);
    assert.equal(summary.bytes,[...rows.heads,...rows.versions,...rows.documents].reduce((sum,row)=>sum+size(row),0));
    assert.equal(summary.documentBytes,rows.heads[0].totalBytes);assert.equal(summary.archived,1);assert.equal(summary.versions,2);assert.doesNotMatch(JSON.stringify(summary),/private|方案|r1|one/);
    assert.equal(summarizeComfyLibraryStorage(kind,namespace,{heads:[],versions:[],documentKeys:[]}).bytes,0);
  }
});
test('incomplete keys, orphan versions, corrupt history chains, quota drift and alien accounts do not publish a full tally',()=>{
  for(const kind of ['workflows','pools'])for(const change of [r=>r.documentKeys.pop(),r=>r.documentKeys.push('orphan'),r=>r.versions.pop(),r=>r.versions[0].namespace='other',r=>r.versions[0].bytes++,r=>r.heads[0].totalBytes++,r=>r.heads[0].revision='changed',r=>r.versions[0].version=2,r=>r.heads.push(r.heads[0]),r=>r.versions.push(r.versions[0])]){
    const rows=library(kind);change(rows);assert.throws(()=>summarizeComfyLibraryStorage(kind,namespace,rows));
  }
  const rows=library('workflows');rows.versions[1].parentRevision='alien';assert.throws(()=>summarizeComfyLibraryStorage('workflows',namespace,rows));
});
test('summary validation rejects raw metadata and distinguishes unavailable stores from measured empty stores',()=>{
  const value=complete();assert.deepEqual(validateComfyStorageSummary(value,namespace),value);
  for(const patch of [v=>v.workflows.document={},v=>v.namespace='st-user:other',v=>v.bytes++,v=>v.scenes.generation=undefined,v=>v.pools.versions=0,v=>v.status='partial']){
    const copy=structuredClone(value);patch(copy);assert.throws(()=>validateComfyStorageSummary(copy,namespace));
  }
  value.bytes-=value.workflows.bytes;value.count--;value.workflows={status:'unavailable',bytes:null,count:null,error:'blocked'};value.errors=['blocked'];value.status='partial';
  assert.deepEqual(validateComfyStorageSummary(value,namespace),value);value.workflows.bytes=0;assert.throws(()=>validateComfyStorageSummary(value,namespace));
});
test('the default collector uses a scoped Worker call and never silently falls back to reading large libraries on the main page',async()=>{
  let current=namespace,calls=0;const result=complete(),options={resolveNamespace:async()=>current,call:async(action,args)=>{calls++;assert.equal(action,'comfy');assert.equal(args.namespace,namespace);await args.guard();return result;}};
  assert.deepEqual(await collectComfyStorage(options),result);assert.equal(calls,1);
  const unavailable=await collectComfyStorage({...options,call:async()=>{throw Error('Worker unavailable');}});
  assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.workflows.bytes,null);assert.equal(unavailable.pools.count,null);
  await assert.rejects(collectComfyStorage({...options,call:async()=>{current='st-user:changed';return result;}}),/账户/);
});
test('Comfy Worker results are compact, schema checked, bound to the operation and terminated on success and invalid payload',async()=>{
  let closed=0,payload,result=complete();
  class Worker{addEventListener(type,fn){if(type==='message')this.receive=fn;}postMessage(value){payload=value;queueMicrotask(()=>this.receive({data:{id:value.id,result}}));}terminate(){closed++;}}
  assert.deepEqual(await runRestoreStorage('comfy',{namespace,guard:async()=>{},WorkerClass:Worker}),result);assert.equal(closed,1);assert.deepEqual(Object.keys(payload).sort(),['action','id','namespace']);
  result={...result,workflow:'must not cross'};await assert.rejects(runRestoreStorage('comfy',{namespace,guard:async()=>{},WorkerClass:Worker}));assert.equal(closed,2);
});
test('actual storage card keeps failed Comfy library links, labels unknown space and renders real version and metadata counts',()=>{
  const comfy=complete();comfy.workflows={status:'unavailable',bytes:null,count:null,error:'unreadable <data>'};comfy.status='partial';comfy.errors=[comfy.workflows.error];
  const context=vm.createContext({storageInventoryState:{status:'ready',data:{sampledAt:1,origin:{available:true,usage:99999,quota:999999},trackedBytes:comfy.bytes,categories:[],idb:{stores:[]},comfyStorage:comfy}},STORAGE_CATEGORY_LABELS:{},STORAGE_CATEGORY_COLORS:{},htmlEscape:x=>String(x??'').replaceAll('<','&lt;'),formatStorageBytes:x=>`${x} B`});
  context.storageInventoryState.data.origin.pressure={};vm.runInContext(section('renderStorageManagementCard'),context);const html=context.renderStorageManagementCard();
  assert.match(html,/Comfy 工作流库 · 当前账户 · 未盘点，总计未包含/);assert.doesNotMatch(html,/Comfy 工作流库 · 当前账户 · 0 项/);assert.match(html,/data-storage-comfy-library="workflows"/);assert.match(html,/含 2 个版本、1 项归档/);assert.match(html,/未盘点站点数据/);assert.match(html,/unreadable &lt;data>/);
});
