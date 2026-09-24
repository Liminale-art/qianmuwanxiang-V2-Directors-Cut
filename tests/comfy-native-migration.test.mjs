import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfyWorkflowStore,normalizeComfyLibraryDocument} from '../qianmu-comfy-library.js';
import {createNativeComfyWorkflowStore} from '../qianmu-comfy-native-store.js';
import {COMFY_NATIVE_SLOT} from '../qianmu-comfy-native-contract.js';
import {prepareComfyLegacy,estimateComfyMigrationIndexBytes} from '../qianmu-comfy-native-migration.js';
import {comfyLibraryBackupDigest} from '../qianmu-comfy-library-backup.js';
import {pinComfyRouteWorkflow,readPinnedComfyRouteWorkflow} from '../qianmu-comfy-route.js';
import {renderComfyLibrary,createComfyLibraryController} from '../qianmu-comfy-library-view.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfyLibraryIdbFixture} from './helpers/comfy-library-idb-fixture.mjs';
const document=(text='source')=>({workflow:JSON.stringify({prompt:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%',style:text}},image:{class_type:'SaveImage',inputs:{images:['prompt',0]}}}),outputNodeId:'image',parameters:{seed:0},positivePrompt:'original positive',negativePrompt:'original negative'});
const options=f=>({indexedDB:f.indexedDB,keyRange:f.keyRange});
function property(t,key,value){const prior=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key];});}
async function legacy(t){const f=comfyLibraryIdbFixture(),store=f.open();t.after(()=>store.close());const first=await store.save(namespace,{name:'Old',document:document()}),second=await store.save(namespace,{id:first.id,expectedRevision:first.revision,name:'New',document:document('second')});return {...f,store,first,second,packet:await store.backup(namespace)};}
const open=(t,native,local)=>{const store=createComfyWorkflowStore({...options(local),native:{createStorage:native.createStorage}});t.after(()=>store.close());return store;};

test('actual local three-table census/backup migrates complete histories without changing source, then only rechecks metadata',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),before=JSON.stringify(local.state.tables),store=open(t,f,local);
  assert.equal(f.uploads,0);const view=await store.view(namespace);assert.equal(view.rows[0].id,local.first.id);assert.equal(view.usage.persistence,'st-account-file');assert.equal(view.recovery.sources.length,1);
  assert.deepEqual(await store.backup(namespace),local.packet);assert.equal(JSON.stringify(local.state.tables),before);
  local.state.reads.length=0;local.state.transactions.length=0;f.reset();await store.view(namespace);
  assert.ok(local.state.transactions.every(row=>row.mode==='readonly'&&row.names.length===3));assert.ok(!local.state.reads.some(row=>row.name==='documents'&&row.kind==='get'));assert.equal(f.uploads,0);
  const other=open(t,f,comfyLibraryIdbFixture());assert.deepEqual(await other.load(namespace,local.first.id,local.first.revision),normalizeComfyLibraryDocument(document()));
});

test('configured default factory and actual pinned-route consumers read the same older revision on another empty device',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t);f.configure();property(t,'indexedDB',local.indexedDB);property(t,'IDBKeyRange',local.keyRange);
  const store=createComfyWorkflowStore();t.after(()=>store.close());assert.equal(store.persistence,'st-account-file');await store.list(namespace);
  const pinned=await pinComfyRouteWorkflow({namespace,selection:{id:local.first.id,revision:local.first.revision,version:1}});
  const empty=comfyLibraryIdbFixture();globalThis.indexedDB=empty.indexedDB;globalThis.IDBKeyRange=empty.keyRange;
  f.reset();const result=await readPinnedComfyRouteWorkflow({namespace,binding:pinned.binding});assert.deepEqual(result.document,pinned.document);assert.equal(result.document.positivePrompt,'original positive');
  assert.equal(f.calls.filter(row=>row.request.method==='GET').length,7);assert.equal(f.uploads,0);
  assert.equal(f.calls.filter(row=>row.path.endsWith(`-${COMFY_NATIVE_SLOT}.json`)).length,4);
  assert.equal(f.calls.filter(row=>new RegExp(`-${COMFY_NATIVE_SLOT}-[a-f0-9]{64}\\.json$`).test(row.path)).length,2);
  assert.equal(f.calls.filter(row=>/-comfy-workflow-version-[a-f0-9]{64}\.json$/.test(row.path)).length,1);
});

test('new compatible local revisions extend the complete native chain once, with no silent rebinding',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);await store.list(namespace);
  const next=await local.store.save(namespace,{id:local.first.id,expectedRevision:local.second.revision,name:'Third',document:document('third')});
  assert.equal((await store.list(namespace))[0].revision,next.revision);assert.equal((await store.recoverySources(namespace)).sources.length,2);
  assert.equal((await store.versions(namespace,next.id)).length,3);assert.deepEqual(await store.load(namespace,next.id,local.first.revision),normalizeComfyLibraryDocument(document()));
});

test('a divergent source stays fully exportable; approved copy preserves every version without replacing current selection',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);await store.list(namespace);
  const remote=await store.save(namespace,{id:local.first.id,expectedRevision:local.second.revision,name:'ST branch',document:document('ST branch')});
  await local.store.save(namespace,{id:local.first.id,expectedRevision:local.second.revision,name:'Local branch',document:document('local branch')});
  const view=await store.view(namespace),source=view.recovery.sources.find(row=>row.pending.length);assert.equal(view.rows[0].revision,remote.revision);assert.equal(source.pending[0].id,local.first.id);
  assert.deepEqual(await store.exportLegacy(namespace,source.census),await local.store.backup(namespace));
  await assert.rejects(store.resolveLegacy(namespace,{census:source.census,id:local.first.id,choice:'copy',expectedRevision:view.recovery.revision}),/核对/);
  await store.resolveLegacy(namespace,{census:source.census,id:local.first.id,choice:'copy',expectedRevision:view.recovery.revision,confirmed:true});
  const rows=await store.list(namespace),copy=rows.find(row=>row.id!==remote.id);assert.equal(rows.find(row=>row.id===remote.id).revision,remote.revision);assert.equal(copy.version,3);
  const copied=await store.versions(namespace,copy.id);assert.deepEqual(await store.load(namespace,copy.id,copied.at(-1).revision),normalizeComfyLibraryDocument(document()));assert.equal((await store.recoverySources(namespace)).sources.at(-1).pending.length,0);
});

test('archived or removed native workflows are not resurrected by another old device; retained originals can recover explicitly',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);await store.list(namespace);await store.archive(namespace,local.first.id,local.second.revision,true);
  await local.store.save(namespace,{id:local.first.id,expectedRevision:local.second.revision,name:'Stale device',document:document('stale')});assert.deepEqual(await store.list(namespace),[]);
  await store.purge(namespace,local.first.id,local.second.revision);assert.deepEqual(await store.list(namespace),[]);
  const state=await store.recoverySources(namespace),source=state.sources.find(row=>row.pending.length);await store.resolveLegacy(namespace,{census:source.census,id:local.first.id,choice:'keep',expectedRevision:state.revision,confirmed:true});
  const approved=await store.recoverySources(namespace);await store.restoreRetired(namespace,local.first.id,{expectedRevision:approved.revision,confirmed:true});
  assert.deepEqual(await store.list(namespace),[]);assert.equal((await store.list(namespace,{archived:true}))[0].version,2);assert.equal((await store.exportLegacy(namespace,source.census)).workflows[0].versions.length,3);
});

test('read-only accounting refuses unregistered legacy data instead of uploading or claiming an empty library',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);await assert.rejects(store.storageSummary(namespace),/尚有未接入/);assert.equal(f.uploads,0);
  await store.view(namespace);f.reset();const summary=await store.storageSummary(namespace);assert.equal(summary.versions,2);assert.equal(f.uploads,0);
});

test('damaged or unavailable legacy sources cannot become an empty native library',async t=>{
  for(const damage of [f=>f.state.tables.documents.pop(),f=>f.state.failOpen=true,f=>f.state.tables.documents[0].document.workflow='broken']){
    const local=await legacy(t),f=await characterNativeFixture(t);damage(local);const store=open(t,f,local);await assert.rejects(store.list(namespace));assert.equal(f.uploads,0);
  }
});

test('local source changes during upload preserve originals but do not commit a stale migration head',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);let changed=false;
  f.hook(call=>{if(!changed&&call.path==='/api/files/upload'){changed=true;local.state.tables.workflows[0].archived=true;}});
  await assert.rejects(store.list(namespace),/期间变化/);assert.equal((await f.storage.read(COMFY_NATIVE_SLOT)).exists,false);assert.ok(f.files.size>0);assert.equal(local.state.tables.workflows[0].archived,true);
});

test('lost migration acknowledgement is not retried; next verified read reuses registered source without duplicate versions',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);let lost=false;
  f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);if(!lost&&value.schema==='qianmu.st-account-head.v1'){lost=true;f.files.set(name,body);throw Error('lost ack');}}});
  await assert.rejects(store.list(namespace));f.hook(null);f.reset();assert.equal((await store.list(namespace))[0].version,2);assert.equal(f.uploads,0);assert.equal((await store.recoverySources(namespace)).sources.length,1);
});

test('conflict recovery renders retained/export/copy controls without exposing graph bodies or promising disk deletion',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);await store.list(namespace);await store.archive(namespace,local.first.id,local.second.revision,true);await local.store.save(namespace,{id:local.first.id,expectedRevision:local.second.revision,name:'Changed',document:document('sensitive graph')});
  const view=await store.view(namespace,{archived:true}),html=renderComfyLibrary({...view,archived:true});for(const action of ['export-legacy','keep-legacy','copy-legacy'])assert.ok(html.includes(`data-comfy-action="${action}"`));assert.match(html,/sd-comfy-library-management/);assert.doesNotMatch(html,/ST 账户保存|当前目录正文量|永久清理|sensitive graph/);
  const snapshot=await store.backup(namespace);assert.equal(typeof await comfyLibraryBackupDigest(snapshot),'string');
});

test('actual controller uses one native metadata snapshot and dispatches explicit legacy resolution without applying a recipe',async()=>{
  const census='a'.repeat(64),calls=[],downloads=[];let views=0,applied=0;
  const buttons=Object.fromEntries(['copy-legacy','export-legacy'].map(action=>[action,{dataset:{comfyAction:action},addEventListener(_,handler){this.click=handler;},closest:()=>({dataset:{comfyId:action==='export-legacy'?census:census+':old'}})}]));
  const host={isConnected:true,innerHTML:'',closest:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-comfy-action]'?Object.values(buttons):[]};
  const value={rows:[],usage:{count:0,versions:0,bytes:0,limit:1000,persistence:'st-account-file'},recovery:{revision:5,sources:[{census,count:1,versions:2,pending:[{id:'old',name:'old',version:2}]}],retired:[]}};
  const store={view:async()=>{views++;return structuredClone(value);},list:()=>assert.fail('no redundant reads'),usage:()=>assert.fail('no redundant reads'),resolveLegacy:async(...args)=>calls.push(args),exportLegacy:async()=>({retained:true}),close(){}};
  const controller=createComfyLibraryController({store,resolveNamespace:async()=>namespace,confirm:async()=>true,download:blob=>downloads.push(blob),onApply:()=>applied++});
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
  try{controller.mount(host);await flush();assert.equal(views,1);buttons['copy-legacy'].click();await flush();assert.equal(views,2);assert.deepEqual(calls,[[namespace,{census,id:'old',choice:'copy',expectedRevision:5,confirmed:true}]]);
    buttons['export-legacy'].click();await flush();assert.equal(downloads.length,1);assert.equal(applied,0);
  }finally{controller.dispose();}
});

test('restore and conflict choices reject stale directory approvals without uploading a second branch',async t=>{
  const local=await legacy(t),f=await characterNativeFixture(t),store=open(t,f,local);await store.list(namespace);await store.archive(namespace,local.first.id,local.second.revision,true);await store.purge(namespace,local.first.id,local.second.revision);
  const state=await store.recoverySources(namespace);await store.save(namespace,{name:'independent',document:document('other')});f.reset();
  await assert.rejects(store.restoreRetired(namespace,local.first.id,{expectedRevision:state.revision,confirmed:true}),/已变化/);assert.equal(f.uploads,0);
});

test('metadata capacity preflight precedes any original upload and never puts graph bodies in the estimate',async t=>{
  const local=await legacy(t),index={schema:'qianmu.comfy.native-library.v1',namespace,revision:0,workflows:[],retired:[],sources:[]};
  const first=estimateComfyMigrationIndexBytes(index,local.packet),longer=structuredClone(local.packet);longer.workflows[0].versions[0].document.workflow+='x'.repeat(20000);
  assert.equal(estimateComfyMigrationIndexBytes(index,longer),first);
  const largerCurrent=structuredClone(index);largerCurrent.workflows.push({head:{...local.packet.workflows[0].head,name:'界'.repeat(800)},versions:[]});
  assert.ok(estimateComfyMigrationIndexBytes(largerCurrent,local.packet)>first,'a divergent but shorter incoming chain cannot shrink the projected current directory');
  // Simulate an already validated near-capacity directory at this unit boundary.
  // Full native index validation is covered separately by the transport tests.
  index.retired.push({retainedMetadata:'x'.repeat(8*1048576)});let writes=0;
  await assert.rejects(prepareComfyLegacy({legacy:local.store,namespace,current:()=>true,maxBytes:64*1048576,ctx:{index,check:async()=>{},originals:{preserve:async()=>{writes++;assert.fail('no upload');}},save:async()=>assert.fail('no directory write')}}),/预计超出/);
  assert.equal(writes,0);
});
