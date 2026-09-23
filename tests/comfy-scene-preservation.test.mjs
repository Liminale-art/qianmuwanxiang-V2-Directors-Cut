import test from 'node:test';
import assert from 'node:assert/strict';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {COMFY_SCENE_RESERVATION_MS,comfySceneScopeKey} from '../qianmu-comfy-scene-lock.js';
import {validateComfySceneSnapshot,comfySceneSnapshotBytes,comfySceneSnapshotDigest} from '../qianmu-comfy-scene-backup.js';
import {createComfyScenePreservation,COMFY_SCENE_SOURCE_SLOT as slot,COMFY_SCENE_ORIGINAL_SLOT} from '../qianmu-comfy-scene-preservation.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture} from './helpers/comfy-scene-idb-fixture.mjs';

const scope={namespace,chatKey:'chat-a',continuityId:'scene-a',narrativeLayer:'present'};
const lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate-a',executionKey:'b'.repeat(64)};
const request=(extra={})=>({expectedGeneration:0,expectedRevision:0,lock,attemptId:'attempt-a',ownerId:'page-a',token:'ticket-a',label:{planId:'plan-a',floor:0,workflowName:'Original',sceneTitle:'Kitchen'},...extra});
async function fixture(t){
  const transport=await characterNativeFixture(t),idb=comfySceneIdbFixture(),local=idb.open(),archive=createComfyScenePreservation({local,createStorage:transport.createStorage});
  t.after(()=>{archive.close();local.close();});return Object.assign(transport,{idb,local,archive});
}
const filename=reference=>`qianmu-v2-${reference.scope}-${reference.slot}-${reference.fingerprint}.json`;

test('atomic snapshot includes exact raw receipts, expired reservations, styles, keys and generation without changing two tables',async t=>{
  const f=await fixture(t),a=await f.local.reserve(scope,request()),second={...scope,continuityId:'scene-b'};
  await f.local.reserve(second,request({lock:{...lock,scope:second},attemptId:'b',token:'b'}));await f.local.begin(a.receipt);
  const before=structuredClone(f.idb.state.tables);f.idb.state.transactions.length=0;const snapshot=await f.local.snapshot(namespace);
  assert.deepEqual(f.idb.state.tables,before);assert.equal(snapshot.rows.length,2);assert.equal(snapshot.usage.count,2);assert.equal(snapshot.rows[0].value.record.holders[0].token,'ticket-a');
  assert.equal(snapshot.rows[1].value.record.holders[0].expiresAt,100+COMFY_SCENE_RESERVATION_MS);assert.deepEqual(snapshot.rows[0].value.record.lock,lock);
  assert.deepEqual(f.idb.state.transactions,[{names:['scopes','usage'],mode:'readonly'}]);assert.equal(validateComfySceneSnapshot(snapshot).count,2);
  const later=f.idb.open({now:()=>10*COMFY_SCENE_RESERVATION_MS});t.after(()=>later.close());assert.equal((await later.inspect(second)).lock,null);assert.deepEqual(await later.snapshot(namespace),snapshot);
});

test('missing usage, corrupt byte counts, unknown fields and damaged index cannot masquerade as an empty or normalized source',async t=>{
  for(const corrupt of [state=>state.tables.usage.delete(namespace),state=>state.tables.usage.get(namespace).bytes++,state=>state.tables.scopes.get(comfySceneScopeKey(scope)).record.extra='retain locally',state=>state.tables.scopes.get(comfySceneScopeKey(scope)).namespace='st-user:foreign']){
    const f=await fixture(t);await f.local.reserve(scope,request());corrupt(f.idb.state);f.reset();const before=structuredClone(f.idb.state.tables);
    await assert.rejects(f.archive.preserve(namespace));assert.equal(f.uploads,0);assert.deepEqual(f.idb.state.tables,before);
  }
  const f=await fixture(t);await f.local.reserve(scope,request());f.idb.state.tables.scopes.get(comfySceneScopeKey(scope)).namespace='st-user:foreign';f.idb.state.tables.usage.delete(namespace);
  await assert.rejects(f.local.snapshot(namespace),/主键与聊天索引/);
});

test('snapshot comparison detects a second local page atomic reservation and refuses stale evidence',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const old=await f.local.snapshot(namespace),other=f.idb.open();t.after(()=>other.close());
  await other.reserve(scope,request({expectedRevision:1,attemptId:'other',token:'other'}));await assert.rejects(f.local.assertSnapshot(old),/保全期间变化/);
  const fresh=await f.local.snapshot(namespace);assert.equal(await f.local.assertSnapshot(fresh),true);assert.equal(fresh.rows[0].value.record.holders.length,2);
});

test('all legacy scenes are preserved in ST and another empty local device can read the complete source without adopting or executing it',async t=>{
  const f=await fixture(t),a=await f.local.reserve(scope,request());await f.local.begin(a.receipt);await f.local.settle(a.receipt,'unknown');
  const expected=await f.local.snapshot(namespace),before=structuredClone(f.idb.state.tables);f.reset();const kept=await f.archive.preserve(namespace);
  assert.equal(kept.empty,false);assert.deepEqual(kept.snapshot,expected);assert.equal(kept.source.digest,await comfySceneSnapshotDigest(expected));assert.deepEqual(f.idb.state.tables,before);
  const remoteIdb=comfySceneIdbFixture(),remoteLocal=remoteIdb.open(),remote=createComfyScenePreservation({local:remoteLocal,createStorage:f.createStorage});t.after(()=>{remote.close();remoteLocal.close();});
  f.reset();assert.deepEqual(await remote.readSource(namespace,kept.source.digest),expected);assert.equal((await remoteLocal.snapshot(namespace)).rows.length,0);assert.equal(f.uploads,0);
  assert.equal((await remote.sources(namespace)).sources.length,1);assert.ok(!f.calls.some(call=>/generate|prompt|queue|history/.test(call.path)));
});

test('repeated unchanged preservation verifies the same complete original without uploads or duplicate source entries',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const first=await f.archive.preserve(namespace);f.reset();const again=await f.archive.preserve(namespace);
  assert.deepEqual(again,first);assert.equal(f.uploads,0);assert.equal((await f.archive.sources(namespace)).sources.length,1);assert.ok(f.calls.some(call=>call.path.includes('-comfy-scene-original-')));
});

test('divergent complete local sources both remain readable; a larger revision never chooses a winner',async t=>{
  const f=await fixture(t),a=await f.local.reserve(scope,request()),first=await f.archive.preserve(namespace);await f.local.begin(a.receipt);const submitting=await f.archive.preserve(namespace);
  const branch=comfySceneIdbFixture(first.snapshot),local=branch.open(),other=createComfyScenePreservation({local,createStorage:f.createStorage});t.after(()=>{other.close();local.close();});
  await local.settle(a.receipt,'not_submitted');const cancelled=await other.preserve(namespace),sources=await f.archive.sources(namespace);
  assert.equal(sources.sources.length,3);assert.notEqual(cancelled.source.digest,submitting.source.digest);
  assert.equal((await f.archive.readSource(namespace,submitting.source.digest)).rows[0].value.record.holders[0].status,'submitting');
  assert.equal((await f.archive.readSource(namespace,cancelled.source.digest)).rows[0].value.record.holders.length,0);
  assert.equal((await f.local.snapshot(namespace)).rows[0].value.record.holders[0].status,'submitting');
});

test('genuinely absent local metadata does not create a source, but an empty cleared-generation tombstone is preserved',async t=>{
  const f=await fixture(t);f.reset();assert.equal((await f.archive.preserve(namespace)).empty,true);assert.equal(f.uploads,0);
  const a=await f.local.reserve(scope,request());await f.local.settle(a.receipt,'not_submitted');await f.local.clearAccount(namespace,{expectedGeneration:0});
  const kept=await f.archive.preserve(namespace);assert.equal(kept.empty,false);assert.equal(kept.source.count,0);assert.equal(kept.source.generation,1);assert.deepEqual(kept.snapshot.usage,{count:0,bytes:0,generation:1});
});

test('source changed during original upload stops directory publication and preserves the actual new local record',async t=>{
  const f=await fixture(t),a=await f.local.reserve(scope,request());let changed=false;
  f.hook(async call=>{if(!changed&&call.path==='/api/files/upload'){changed=true;await f.local.begin(a.receipt);}});await assert.rejects(f.archive.preserve(namespace),/保全期间变化/);f.hook(null);
  assert.equal((await f.storage.read(slot)).exists,false);assert.equal((await f.local.snapshot(namespace)).rows[0].value.record.holders[0].status,'submitting');
});

test('known missing directory or historical original stops without recreating empty data or reuploading lost source',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const kept=await f.archive.preserve(namespace),name=filename(kept.source.reference);f.files.delete(name);f.reset();
  await assert.rejects(f.archive.readSource(namespace,kept.source.digest));await assert.rejects(f.archive.preserve(namespace));assert.equal(f.uploads,0);
  const found=await f.storage.read(slot),head=[...f.files].find(([,body])=>{const v=JSON.parse(body);return v.schema==='qianmu.st-account-head.v1'&&v.slot===slot;});assert.ok(head);f.files.delete(head[0]);await assert.rejects(f.archive.sources(namespace));assert.ok(found.exists);
});

test('lost directory acknowledgement does not retry; explicit next access verifies the original full source once',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());let lost=false;
  f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),text=Buffer.from(data,'base64').toString('utf8'),v=JSON.parse(text);if(!lost&&v.schema==='qianmu.st-account-head.v1'&&v.slot===slot){lost=true;f.files.set(name,text);throw Error('lost ack');}}});
  await assert.rejects(f.archive.preserve(namespace));f.hook(null);f.reset();const kept=await f.archive.preserve(namespace);assert.equal(kept.source.count,1);assert.equal(f.uploads,0);assert.equal((await f.archive.sources(namespace)).sources.length,1);
});

test('another account, revoked guards, unavailable local database and close reject without uploads',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());f.reset();await assert.rejects(f.archive.preserve('st-user:other'));assert.equal(f.uploads,0);
  await assert.rejects(f.archive.preserve(namespace,{guard:()=>false}));assert.equal(f.uploads,0);f.idb.state.failOpen=true;
  const badLocal=f.idb.open(),bad=createComfyScenePreservation({local:badLocal,createStorage:f.createStorage});t.after(()=>{bad.close();badLocal.close();});await assert.rejects(bad.preserve(namespace));assert.equal(f.uploads,0);
  f.archive.close();await assert.rejects(f.archive.preserve(namespace));assert.equal(f.uploads,0);
});

test('usage accounting is checked against the complete original, not a display summary',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const snapshot=await f.local.snapshot(namespace);assert.equal(snapshot.rows[0].value.bytes,comfySceneSnapshotBytes(snapshot.rows[0].value.record));
  const truncated=structuredClone(snapshot);truncated.rows[0].value.record.holders=[];assert.throws(()=>validateComfySceneSnapshot(truncated),/计值/);
  const altered=structuredClone(snapshot);altered.usage.generation=-1;assert.throws(()=>validateComfySceneSnapshot(altered),/计值/);
  assert.throws(()=>validateComfySceneSnapshot({...snapshot,extra:true}),/格式/);
});

test('non-JSON local fields never disappear into the same preservation digest as a valid source',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const snapshot=await f.local.snapshot(namespace);
  for(const mutate of [v=>v.rows[0].value.record.extra=undefined,v=>v.rows[0].value.record.label.floor=-0,v=>v.usage.generation=NaN,v=>v.rows[0].value.record.holders[0].extra=Symbol('x'),v=>Object.defineProperty(v.usage,'hidden',{value:1})]){
    const invalid=structuredClone(snapshot);mutate(invalid);assert.throws(()=>validateComfySceneSnapshot(invalid),/无损|数值|字段/);
  }
});

test('unknown native index fields and cross-account original references are rejected without uploads',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());await f.archive.preserve(namespace);const original=await f.storage.read(slot);
  for(const edit of [v=>v.extra=true,v=>v.sources[0].reference.scope='0'.repeat(64),v=>v.sources[0].count=1025]){
    const value=structuredClone(original.value);edit(value);const old=await f.storage.read(slot);await f.storage.write(slot,value,{expectedFingerprint:old.fingerprint});f.reset();await assert.rejects(f.archive.sources(namespace));assert.equal(f.uploads,0);
  }
});

test('a native directory changed during original upload is detected and never overwritten',async t=>{
  const f=await fixture(t),a=await f.local.reserve(scope,request()),first=await f.archive.preserve(namespace);await f.local.begin(a.receipt);
  // Separate module instance models another browser's independent slot queues.
  const {createStAccountStorage}=await import('../qianmu-st-account-storage.js?scene-source-race');
  const createStorage=options=>createStAccountStorage({...options,resolveNamespace:async()=>namespace,isCurrent:options?.isCurrent||(()=>true),headers:()=>({'X-CSRF-Token':'synthetic'}),fetchImpl:f.fetchImpl,origin:'https://st.fixture.invalid'});
  const idb=comfySceneIdbFixture(first.snapshot),local=idb.open(),other=createComfyScenePreservation({local,createStorage});t.after(()=>{other.close();local.close();});await local.settle(a.receipt,'not_submitted');let changed=false,remote;
  f.hook(async call=>{if(!changed&&call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.includes('-'+COMFY_SCENE_ORIGINAL_SLOT+'-')){changed=true;remote=await other.preserve(namespace);}});
  await assert.rejects(f.archive.preserve(namespace),{code:'st_account_storage_conflict'});f.hook(null);const current=await f.archive.sources(namespace);assert.equal(current.sources.length,2);assert.ok(current.sources.some(row=>row.digest===remote.source.digest));assert.equal((await f.local.snapshot(namespace)).rows[0].value.record.holders[0].status,'submitting');
});

test('the complete 1024-scene source survives and the 1025th record fails rather than being truncated',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const sample=await f.local.snapshot(namespace),snapshot=structuredClone(sample);snapshot.rows=[];
  for(let i=0;i<1024;i++){
    const value=structuredClone(sample.rows[0].value),target={...scope,continuityId:'scene-'+String(i).padStart(4,'0')};value.record.scope=target;value.record.lock.scope=target;value.bytes=comfySceneSnapshotBytes(value.record);snapshot.rows.push({key:comfySceneScopeKey(target),value});
  }
  snapshot.usage={count:1024,bytes:snapshot.rows.reduce((sum,row)=>sum+row.value.bytes,0),generation:7};
  const idb=comfySceneIdbFixture(snapshot),local=idb.open(),archive=createComfyScenePreservation({local,createStorage:f.createStorage});t.after(()=>{local.close();archive.close();});
  const saved=await archive.preserve(namespace);assert.deepEqual(await archive.readSource(namespace,saved.source.digest),snapshot);assert.equal(saved.source.count,1024);assert.equal(idb.state.writes.length,0);
  const extra=structuredClone(snapshot.rows.at(-1));extra.value.record.scope.continuityId='scene-1024';extra.value.record.lock.scope.continuityId='scene-1024';extra.key=comfySceneScopeKey(extra.value.record.scope);extra.value.bytes=comfySceneSnapshotBytes(extra.value.record);idb.state.tables.scopes.set(extra.key,extra.value);const meta=idb.state.tables.usage.get(namespace);meta.count++;meta.bytes+=extra.value.bytes;f.reset();await assert.rejects(archive.preserve(namespace),/上限|容量/);assert.equal(f.uploads,0);
});

test('revocation after an original is uploaded retains local records but cannot publish the source directory',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const before=structuredClone(f.idb.state.tables);let current=true;
  f.hook(call=>{if(call.path==='/api/files/upload')current=false;});await assert.rejects(f.archive.preserve(namespace,{isCurrent:()=>current}));f.hook(null);
  assert.equal((await f.storage.read(slot)).exists,false);assert.deepEqual(f.idb.state.tables,before);
});

test('linked-style provenance and another account stay isolated in complete atomic snapshots',async t=>{
  const f=await fixture(t),a=await f.local.reserve(scope,request());await f.local.begin(a.receipt);await f.local.settle(a.receipt,'succeeded');const before=await f.local.inspect(scope),target={...scope,continuityId:'linked'};
  await f.local.linkStyle(scope,target,{expectedSourceRevision:before.revision,expectedRevision:0,expectedGeneration:0,label:{planId:'next',floor:1,workflowName:'linked'}});
  const foreign={...scope,namespace:'st-user:foreign'};await f.local.reserve(foreign,request({lock:{...lock,scope:foreign},attemptId:'foreign'}));
  const snapshot=await f.local.snapshot(namespace),saved=await f.archive.preserve(namespace);assert.equal(snapshot.rows.length,2);assert.ok(snapshot.rows.some(row=>row.value.record.styleOrigin?.sourceFloor===0));
  assert.deepEqual(await f.archive.readSource(namespace,saved.source.digest),snapshot);assert.equal((await f.local.snapshot(foreign.namespace)).rows.length,1);assert.ok(snapshot.rows.every(row=>row.value.namespace===namespace));
});

test('a revoked cursor read never returns a partial snapshot and an injected transaction failure preserves both tables',async t=>{
  const f=await fixture(t);await f.local.reserve(scope,request());const before=structuredClone(f.idb.state.tables);let checks=0;
  await assert.rejects(f.local.snapshot(namespace,{isCurrent:()=>++checks<4}));assert.deepEqual(f.idb.state.tables,before);
  const saved=f.idb.keyRange.bound;f.idb.keyRange.bound=()=>{throw Error('index read failed');};await assert.rejects(f.local.snapshot(namespace));f.idb.keyRange.bound=saved;assert.deepEqual(f.idb.state.tables,before);
});
