import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,COMFY_SCENE_NATIVE_SCHEMA as inlineSchema,sceneBytes,sceneLeaves} from '../qianmu-comfy-scene-native-contract.js';
import {COMFY_SCENE_DIRECTORY_SCHEMA as pagedSchema,COMFY_SCENE_HYBRID_SCHEMA as schema,COMFY_SCENE_HISTORY_SCHEMA as pageSchema,COMFY_SCENE_HISTORY_SLOT as pageSlot,
  validateSceneDirectory,readSceneDirectory} from '../qianmu-comfy-scene-directory.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {completedComfySceneSource} from './helpers/comfy-scene-source-fixture.mjs';
const historyRead=call=>call.request.method==='GET'&&call.path.includes('-'+pageSlot+'-');
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
let longSeed;
async function fixture(t,{long=false,count=8,batch=true}={}){
  const f=await characterNativeFixture(t),source=completedComfySceneSource(namespace,count),old=comfySceneIdbFixture(long?undefined:source),scope=source.rows[0].value.record.scope;
  const open=(legacy=old,log=comfySceneJournalFixture())=>{
    const createStorage=batch?f.createStorage:async options=>({...await f.createStorage(options),readImmutableBatch:undefined});
    const journal=log.open(),store=createNativeComfySceneStore({legacy:legacy.open(),journal,createStorage,now:()=>100});t.after(()=>store.close());return {store,journal,old:legacy,log};
  },a=open();
  const reserve=async(target=scope,id='next')=>{const state=await a.store.inspect(target);return a.store.reserve(target,{lock:{...source.rows[0].value.record.lock,scope:target},expectedRevision:state.revision,expectedGeneration:state.generation,attemptId:id,ownerId:'page',token:'token-'+id});};
  const complete=async(target,id)=>{const result=await reserve(target,id);await a.store.begin(result.receipt);await a.store.settle(result.receipt,'succeeded');};
  if(long){if(longSeed)for(const [name,body]of longSeed)f.files.set(name,body);else{for(let i=0;i<22;i++)await complete(scope,'seed-'+i);longSeed=new Map(f.files);}}
  else await a.store.review(namespace,'chat');
  const root=async()=>f.storage.read(slot),write=async value=>{const before=await root();return f.storage.write(slot,value,{expectedFingerprint:before.fingerprint});};
  const forcePaged=async(pageSize=64)=>{
    const before=await root(),expanded=await readSceneDirectory(before.value,{namespace,scope:f.storage.scope,readImmutable:ref=>f.storage.readImmutable(ref)}),value={...expanded.index,schema:pagedSchema,entries:[]};
    for(const entry of expanded.index.entries){let previous=null;for(let start=0;start<entry.versions.length;start+=pageSize){const versions=entry.versions.slice(start,start+pageSize),page={schema:pageSchema,namespace,scope:entry.scope,start,previous,versions};
      const saved=await f.storage.preserveImmutable(pageSlot,page);previous={reference:saved.reference,count:start+versions.length};}
      value.entries.push({scope:entry.scope,blocked:entry.blocked,heads:sceneLeaves(entry),history:previous});}
    await write(value);return value;
  };
  return Object.assign(f,{a,scope,source,old,open,reserve,complete,root,write,forcePaged});
}
const immutableRetained=(before,after)=>{for(const [name,body]of before)if(JSON.parse(body).schema!=='qianmu.st-account-head.v1')assert.equal(after.get(name),body);};

test('actual activation followed by 1/8/32 scenes has constant single-scene history request count without caching',async t=>{
  const f=await fixture(t,{long:true}),rows=[];
  for(let count=1;count<=32;count++){
    if(count>1)await f.complete({...f.scope,continuityId:'short-'+count},'short-'+count);
    if(![1,8,32].includes(count))continue;const root=(await f.root()).value;assert.equal(root.schema,schema);assert.equal(root.entries.filter(entry=>entry.history).length,1);
    const cost={};for(const action of ['inspect','review']){f.reset();const result=await (action==='inspect'?f.a.store.inspect(f.scope):f.a.store.review(namespace,'chat'));
      assert.equal(action==='inspect'?result.established:result.rows.length,action==='inspect'?true:count);const gets=f.calls.filter(call=>call.request.method==='GET');
      cost[action]={fileGets:gets.length,historyGets:f.calls.filter(historyRead).length,responseBytes:gets.reduce((sum,call)=>sum+Buffer.byteLength(f.files.get(call.path.split('/').at(-1))),0)};
      assert.equal(cost[action].historyGets,2);assert.equal(cost[action].fileGets,action==='inspect'?7:count+6);assert.equal(f.uploads,0);
    }
    rows.push({scenes:count,cost});
  }
  const other=f.open(comfySceneIdbFixture());f.reset();assert.equal((await other.store.inspect(f.scope)).established,true);assert.equal(f.calls.filter(historyRead).length,2);
  t.diagnostic(JSON.stringify({scope:'actual native writer and cold reads over synthetic ST/IDB; no cache or VPS timing claim',rows}));
});

test('v2 short histories become complete inline entries on ordinary save, with old pages retained',async t=>{
  const f=await fixture(t,{long:true});for(let i=0;i<7;i++)await f.complete({...f.scope,continuityId:'short-'+i},'short-'+i);
  const before=await f.a.store.exportAll(namespace);await f.forcePaged();const originals=new Map(f.files);f.reset();assert.deepEqual(await f.a.store.exportAll(namespace),before);
  const reserved=await f.reserve(f.scope,'append');const root=(await f.root()).value;assert.equal(root.schema,schema);assert.equal(root.entries.filter(entry=>entry.versions).length,7);immutableRetained(originals,f.files);
  const packet=await f.a.store.exportAll(namespace);assert.equal(packet.entries[0].versions.length,before.entries[0].versions.length+1);
  for(let i=1;i<packet.entries.length;i++)assert.deepEqual(packet.entries[i],before.entries[i]);await f.a.store.begin(reserved.receipt);
});

test('an inline scene crossing its own threshold pages only itself and reuses the other long-scene references',async t=>{
  const f=await fixture(t,{long:true}),target={...f.scope,continuityId:'growing'},before=(await f.root()).value.entries[0].history;
  for(let i=0;i<21;i++)await f.complete(target,'growth-'+i);let root=(await f.root()).value;assert.equal(root.entries[1].versions.length,63);
  const reserved=await f.reserve(target,'boundary');root=(await f.root()).value;assert.equal(root.entries[1].history.count,64);assert.deepEqual(root.entries[0].history,before);
  assert.equal((await f.a.store.exportScene(target)).versions.length,64);await f.a.store.begin(reserved.receipt);assert.equal((await f.root()).value.entries[1].history.count,65);
});

for(const step of ['page','head','ack'])test(`inline-to-paged ${step} interruption retains intent and recovers the exact operation`,async t=>{
  const f=await fixture(t,{long:true}),target={...f.scope,continuityId:'growing'};for(let i=0;i<21;i++)await f.complete(target,'growth-'+i);const before=await f.root();let failed=false;
  f.hook(call=>{if(call.path!=='/api/files/upload')return;const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);
    if(!failed&&(step==='page'?value.slot===pageSlot:value.schema==='qianmu.st-account-head.v1'&&value.slot===slot)){failed=true;if(step==='ack')f.files.set(name,body);throw Error('interrupted');}});
  await assert.rejects(f.reserve(target,'boundary'));f.hook(null);assert.ok((await f.a.journal.read(namespace)).pending);if(step!=='ack')assert.deepEqual(await f.root(),before);
  f.reset();assert.equal((await f.a.store.inspect(target)).pending,1);assert.equal((await f.a.journal.read(namespace)).pending,null);assert.equal((await f.a.store.exportScene(target)).versions.length,64);
  if(step==='ack')assert.equal(f.uploads,0);
});

for(const count of [1,8,32])test(`old v2 compatibility advances ${count} independent history chains with at most four reads in flight`,async t=>{
  const f=await fixture(t,{count});const before=await f.a.store.review(namespace,'chat');await f.forcePaged();let active=0,peak=0,reads=0;f.reset();
  f.hook(async call=>{if(historyRead(call)){reads++;active++;peak=Math.max(peak,active);await new Promise(done=>setTimeout(done,4));active--;}});
  assert.deepEqual(await f.a.store.review(namespace,'chat'),before);assert.equal(reads,count);assert.equal(peak,Math.min(count,4));assert.equal(f.uploads,0);
});

test('storage adapters without batch capability remain compatible and serialize through their original slot queue',async t=>{
  const f=await fixture(t,{batch:false});const before=await f.a.store.review(namespace,'chat');await f.forcePaged();let active=0,peak=0;
  f.hook(async call=>{if(historyRead(call)){active++;peak=Math.max(peak,active);await new Promise(done=>setTimeout(done,2));active--;}});
  assert.deepEqual(await f.a.store.review(namespace,'chat'),before);assert.equal(peak,1);
});

for(const failure of ['missing','tampered','account','abort'])test(`${failure} in a history batch stops without a partial result or a following batch`,async t=>{
  const f=await fixture(t),root=await f.forcePaged(),entered=gate(),release=gate(),controller=new AbortController();let reads=0;
  if(['missing','tampered'].includes(failure)){
    const reference=root.entries[1].history.reference,[name,body]=[...f.files].find(([key])=>key.endsWith('-'+reference.fingerprint+'.json'));
    if(failure==='missing')f.files.delete(name);else{const value=JSON.parse(body);value.value.versions[0].stateBytes++;f.files.set(name,JSON.stringify(value));}
  }
  f.reset();f.hook(async call=>{if(historyRead(call)){if(++reads===4)entered.resolve();await release.promise;}});
  const reading=f.a.store.review(namespace,'chat',{signal:controller.signal});const rejected=assert.rejects(reading);await entered.promise;
  if(failure==='account')f.account('st-user:other');if(failure==='abort')controller.abort();release.resolve();await rejected;assert.equal(reads,4);assert.equal(f.uploads,0);
});

test('inline corruption is not hidden by healthy paged data, including corruption in another scene',async t=>{
  const f=await fixture(t,{long:true}),other={...f.scope,continuityId:'other'};await f.complete(other,'other');const root=(await f.root()).value;root.entries[1].versions.at(-1).parents=['f'.repeat(64)];await f.write(root);f.reset();
  await assert.rejects(f.a.store.inspect(f.scope));assert.equal(f.calls.filter(historyRead).length,0);assert.equal(f.uploads,0);
});

for(const failure of ['duplicate','ambiguous','live-count','combined-bytes'])test(`hybrid header rejects ${failure} across its inline and paged partitions`,async t=>{
  const f=await fixture(t,{long:true}),target={...f.scope,continuityId:'short'};await f.complete(target,'short');const root=(await f.root()).value;
  if(failure==='duplicate')root.entries[1].scope=root.entries[0].scope;
  if(failure==='ambiguous')root.entries[1].heads=root.entries[0].heads;
  if(['live-count','combined-bytes'].includes(failure)){
    const count=failure==='live-count'?600:65,bytes=failure==='live-count'?1:32768;
    root.entries=Array.from({length:count*2},(_,i)=>{const row=structuredClone(root.entries[i%2]);row.scope.continuityId='item-'+i;for(const meta of row.versions||row.heads)meta.stateBytes=bytes;return row;});
  }
  assert.throws(()=>validateSceneDirectory(root,namespace,f.storage.scope));let reads=0;
  await assert.rejects(readSceneDirectory(root,{namespace,scope:f.storage.scope,readImmutable:async()=>{reads++;throw Error('must not read');}}));assert.equal(reads,0);
});

test('hybrid inventory counts inline metadata once and includes every active paged body, not retired files',async t=>{
  const f=await fixture(t,{long:true});await f.complete({...f.scope,continuityId:'short'},'short');const root=(await f.root()).value;let pageBytes=0;
  for(const entry of root.entries){let locator=entry.history;while(locator){const page=(await f.storage.readImmutable(locator.reference)).value;pageBytes+=sceneBytes(page);locator=page.previous;}}
  f.reset();const summary=await f.a.store.storageSummary(namespace);assert.equal(summary.indexBytes,sceneBytes(root)+pageBytes);assert.equal(summary.count,2);assert.equal(f.uploads,0);
});

test('history batching preserves complete export order and rejects a malformed adapter result',async t=>{
  const f=await fixture(t),before=await f.a.store.exportAll(namespace);const root=await f.forcePaged();assert.deepEqual(await f.a.store.exportAll(namespace),before);
  await assert.rejects(readSceneDirectory(root,{namespace,scope:f.storage.scope,readImmutableBatch:async()=>[]}),/批次未完整/);
  const direct=await readSceneDirectory(root,{namespace,scope:f.storage.scope,readImmutableBatch:refs=>f.storage.readImmutableBatch(refs)});assert.equal(direct.index.entries.length,8);
  assert.deepEqual(direct.index.entries.map(entry=>entry.scope),before.entries.map(entry=>entry.scope));
});

test('multiple linked histories run four-wide without reading a predecessor before its descendant completes',async t=>{
  const f=await fixture(t);for(const row of f.source.rows)await f.complete(row.value.record.scope,'linked-'+row.value.record.scope.continuityId);
  const before=await f.a.store.exportAll(namespace);await f.forcePaged(1);const starts=new Map(),inFlight=new Set();let active=0,peak=0;
  f.reset();f.hook(async call=>{if(!historyRead(call))return;const page=JSON.parse(f.files.get(call.path.split('/').at(-1))).value,key=page.scope.continuityId;
    assert.equal(inFlight.has(key),false);inFlight.add(key);active++;peak=Math.max(peak,active);
    const seen=starts.get(key)||[];assert.equal(page.start,3-seen.length);seen.push(page.start);starts.set(key,seen);
    await new Promise(done=>setTimeout(done,2));active--;inFlight.delete(key);
  });
  assert.deepEqual(await f.a.store.exportAll(namespace),before);assert.equal(peak,4);assert.equal(starts.size,8);
  for(const seen of starts.values())assert.deepEqual(seen,[3,2,1,0]);assert.equal(f.uploads,0);
});

test('another device changing the shared root during a history batch prevents a stale complete result',async t=>{
  const f=await fixture(t),root=await f.forcePaged(),entered=gate(),release=gate();let reads=0;
  f.hook(async call=>{if(historyRead(call)&&++reads<=4){if(reads===4)entered.resolve();await release.promise;}});
  const reading=f.a.store.review(namespace,'chat'),rejected=assert.rejects(reading,/目录在核对期间变化/);await entered.promise;
  await f.write({...root,revision:root.revision+1});release.resolve();await rejected;assert.equal((await f.a.journal.read(namespace)).pending,null);
});

test('a successful warm read never hides a subsequently missing history page',async t=>{
  const f=await fixture(t,{long:true});assert.equal((await f.a.store.inspect(f.scope)).established,true);
  const root=(await f.root()).value,reference=root.entries[0].history.reference,[name]=[...f.files].find(([key])=>key.endsWith('-'+reference.fingerprint+'.json'));
  f.files.delete(name);f.reset();await assert.rejects(f.a.store.inspect(f.scope));assert.equal(f.calls.filter(historyRead).length,1);assert.equal(f.uploads,0);
});

test('an old v2 directory containing only short histories returns to complete v1 on ordinary save without deleting pages',async t=>{
  const f=await fixture(t),before=await f.a.store.exportAll(namespace);await f.forcePaged();const originals=new Map(f.files);await f.reserve();
  assert.equal((await f.root()).value.schema,inlineSchema);immutableRetained(originals,f.files);const after=await f.a.store.exportAll(namespace);
  assert.deepEqual(after.entries[0].versions.slice(0,-1),before.entries[0].versions);
  assert.deepEqual(after.entries.slice(1),before.entries.slice(1));
});
