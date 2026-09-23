import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {COMFY_SCENE_NATIVE_SLOT as slot} from '../qianmu-comfy-scene-native-contract.js';
import {comfySceneSnapshotBytes} from '../qianmu-comfy-scene-backup.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {completedComfySceneSource} from './helpers/comfy-scene-source-fixture.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const isBody=call=>call.request.method==='GET'&&call.path.includes('-comfy-scene-transition-');
async function fixture(t,count=8,{batch=true}={}){
  const f=await characterNativeFixture(t),source=completedComfySceneSource(namespace,count),old=comfySceneIdbFixture(source);
  const createStorage=batch?f.createStorage:async options=>({...await f.createStorage(options),readImmutableBatch:undefined});
  const store=createNativeComfySceneStore({legacy:old.open(),journal:comfySceneJournalFixture().open(),createStorage,now:()=>100});t.after(()=>store.close());
  await store.review(namespace,'chat');f.reset();return Object.assign(f,{source,old,store});
}

for(const count of [1,32,128])test(`real native scene review reads ${count} complete scenes with bounded transport concurrency`,async t=>{
  const modes=[];for(const batch of [false,true]){
    const f=await fixture(t,count,{batch});let active=0,peak=0,bodyReads=0;
    f.hook(async call=>{if(isBody(call)){bodyReads++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;}});
    const start=performance.now(),result=await f.store.review(namespace,'chat');
    const measurement={batch,peak,bodyReads,fileGets:f.calls.filter(call=>call.request.method==='GET').length,elapsedMs:Math.round(performance.now()-start)};
    assert.equal(result.rows.length,count);assert.ok(result.rows.every(row=>row.error===''&&row.branches.length===1));assert.equal(peak,batch?Math.min(4,count):1);
    assert.equal(bodyReads,count);assert.equal(measurement.fileGets,count+4);assert.equal(f.uploads,0);assert.equal(f.old.state.writes.length,0);modes.push({measurement,result});
  }
  assert.deepEqual(modes[0].result,modes[1].result);t.diagnostic(JSON.stringify({count,modes:modes.map(row=>row.measurement),latency:'configured 5ms timer per transition GET; host scheduling applies, not VPS timing'}));
});

test('a failed original stays a per-scene review error while lists and space accounting reject incomplete totals',async t=>{
  const f=await fixture(t),index=(await f.storage.read(slot)).value,ref=index.entries[1].versions.at(-1).reference;
  const name=[...f.files.keys()].find(key=>key.endsWith('-'+ref.fingerprint+'.json'));assert.equal(f.files.delete(name),true);f.reset();
  const review=await f.store.review(namespace,'chat');assert.equal(review.rows.length,8);assert.ok(review.rows[1].error);assert.deepEqual(review.rows[1].branches,[]);
  assert.ok(review.rows.filter((_,i)=>i!==1).every(row=>!row.error&&row.branches.length===1));await assert.rejects(f.store.list(namespace,'chat'));await assert.rejects(f.store.storageSummary(namespace));assert.equal(f.uploads,0);
});

test('one unavailable fork branch cannot leave a seemingly complete winner in the reviewed scene',async t=>{
  const f=await fixture(t,5),source=structuredClone(f.source),changed=source.rows[0].value,before=changed.bytes;changed.record.label.workflowName='Other preserved source';changed.bytes=comfySceneSnapshotBytes(changed.record);source.usage.bytes+=changed.bytes-before;
  const other=createNativeComfySceneStore({legacy:comfySceneIdbFixture(source).open(),journal:comfySceneJournalFixture().open(),createStorage:f.createStorage,now:()=>100});t.after(()=>other.close());await other.review(namespace,'chat');
  const initial=await f.store.review(namespace,'chat');assert.equal(initial.rows[0].branches.length,2);
  const index=(await f.storage.read(slot)).value,ref=index.entries[0].versions.at(-1).reference,name=[...f.files.keys()].find(key=>key.endsWith('-'+ref.fingerprint+'.json'));assert.equal(f.files.delete(name),true);f.reset();
  const result=await f.store.review(namespace,'chat');assert.ok(result.rows[0].error);assert.equal(result.rows[0].heads.length,2);assert.deepEqual(result.rows[0].branches,[]);assert.ok(result.rows.slice(1).every(row=>!row.error&&row.branches.length===1));assert.equal(f.uploads,0);
});

test('list and inventory use the batch reader and never publish or alter original state',async t=>{
  const f=await fixture(t),before=structuredClone(f.old.state.tables);for(const action of ['list','storageSummary']){
    f.reset();let active=0,peak=0;f.hook(async call=>{if(isBody(call)){active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;}});
    const result=await f.store[action](namespace,action==='list'?'chat':{});assert.equal(action==='list'?result.length:result.count,8);assert.equal(peak,4);assert.equal(f.uploads,0);
  }assert.deepEqual(f.old.state.tables,before);
});

for(const mode of ['account','page'])test(`scene ${mode} change during the first batch prevents the next batch and all returned rows`,async t=>{
  const f=await fixture(t),entered=gate(),release=gate();let reads=0,current=true;
  f.hook(async call=>{if(isBody(call)){if(++reads===4)entered.resolve();await release.promise;}});
  const reading=f.store.review(namespace,'chat',{isCurrent:()=>current});await entered.promise;if(mode==='account')f.account('st-user:other');else current=false;release.resolve();
  await assert.rejects(reading);assert.equal(reads,4);assert.equal(f.uploads,0);
});

test('complete old-source revalidation still detects a valid legacy edit during parallel remote reads',async t=>{
  const f=await fixture(t),entered=gate(),release=gate();let reads=0;
  f.hook(async call=>{if(isBody(call)&&++reads<=4){if(reads===4)entered.resolve();await release.promise;}});
  const reading=f.store.review(namespace,'chat');await entered.promise;
  const row=f.old.state.tables.scopes.get(f.source.rows[0].key),before=row.bytes;row.record.label.workflowName='Changed in old page';row.bytes=comfySceneSnapshotBytes(row.record);f.old.state.tables.usage.get(namespace).bytes+=row.bytes-before;
  release.resolve();await assert.rejects(reading,/本机续场原件.*变化/);assert.equal(f.uploads,0);
});

test('a native directory revision changing during a read batch prevents stale rows from returning',async t=>{
  const f=await fixture(t),before=await f.storage.read(slot),entered=gate(),release=gate();let reads=0;
  f.hook(async call=>{if(isBody(call)&&++reads<=4){if(reads===4)entered.resolve();await release.promise;}});
  const reading=f.store.review(namespace,'chat');await entered.promise;const changed={...before.value,revision:before.value.revision+1};
  await f.storage.write(slot,changed,{expectedFingerprint:before.fingerprint});release.resolve();await assert.rejects(reading,/目录在核对期间变化/);assert.deepEqual((await f.storage.read(slot)).value,changed);
});
