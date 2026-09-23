import test from 'node:test';
import assert from 'node:assert/strict';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,validateSceneIndex} from '../qianmu-comfy-scene-native-contract.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';

const scope={namespace,chatKey:'chat-a',continuityId:'scene-a',narrativeLayer:'present'},lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate-a',executionKey:'b'.repeat(64)};
const request=(extra={})=>({expectedGeneration:0,expectedRevision:0,lock,attemptId:'a',ownerId:'page-a',token:'ticket-a',label:{planId:'plan-a',floor:0,workflowName:'Original'},...extra});
async function fixture(t){
  const f=await characterNativeFixture(t);let at=100;const open=(old=comfySceneIdbFixture(),log=comfySceneJournalFixture(),createStorage=f.createStorage)=>{
    const legacy=old.open(),journal=log.open(),store=createNativeComfySceneStore({legacy,journal,createStorage,now:()=>at});t.after(()=>store.close());return {store,old,log,legacy,journal};
  };return Object.assign(f,{open,time:value=>{at=value;}});
}

test('actual reserve, begin and outcomes publish native scene state while legacy two-table data stay untouched',async t=>{
  const f=await fixture(t),a=f.open(),before=structuredClone(a.old.state.tables);assert.equal((await a.store.inspect(scope)).revision,0);
  const reserved=await a.store.reserve(scope,request());assert.equal(reserved.view.pending,1);assert.ok((await a.journal.read(namespace)).nativeKnown);
  await a.store.begin(reserved.receipt);const b=f.open();assert.equal((await b.store.inspect(scope)).pending,1);assert.deepEqual((await b.store.pendingOwners(scope)).owners,[]);
  await assert.rejects(b.store.begin(reserved.receipt),/没有原任务/);await a.store.settle(reserved.receipt,'unknown');assert.equal((await b.store.inspect(scope)).uncertain,1);
  await a.store.settle(reserved.receipt,'succeeded');const done=await b.store.inspect(scope);assert.equal(done.established,true);assert.equal(done.pending,0);assert.equal(done.uncertain,0);assert.deepEqual(done.lock,lock);assert.deepEqual(a.old.state.tables,before);
});

test('complete existing legacy roots are read on another device without importing their tickets or claiming their owner locks',async t=>{
  const f=await fixture(t),old=comfySceneIdbFixture(),local=old.open();t.after(()=>local.close());const reserved=await local.reserve(scope,request());await local.begin(reserved.receipt);const snapshot=await local.snapshot(namespace),a=f.open(old);
  assert.equal((await a.store.inspect(scope)).pending,1);const b=f.open();assert.equal((await b.store.inspect(scope)).pending,1);assert.deepEqual((await b.store.pendingOwners(scope)).owners,[]);
  await assert.rejects(b.store.orphan(scope,{ownerId:'page-a',expectedRevision:2,expectedGeneration:0}),/另一设备/);await assert.rejects(b.store.begin(reserved.receipt),/没有原任务/);assert.deepEqual(await local.snapshot(namespace),snapshot);
});

test('failed native reservation publication retains an atomic local pending proposal and never returns an executable receipt',async t=>{
  const f=await fixture(t),a=f.open();let uploads=0;f.hook(call=>{if(call.path==='/api/files/upload'){uploads++;throw Error('offline');}});
  await assert.rejects(a.store.reserve(scope,request()));assert.ok(uploads);const pending=await a.journal.read(namespace);assert.ok(pending.pending);assert.equal(pending.claims.length,1);assert.equal(pending.nativeKnown,false);
  f.hook(null);const restored=await a.store.inspect(scope);assert.equal(restored.pending,1);assert.equal((await a.journal.read(namespace)).pending,null);assert.equal((await a.store.pendingOwners(scope)).owners[0],'page-a');
});

test('account-switch late outcome is kept in its original journal and published only after the original account is current again',async t=>{
  const f=await fixture(t),a=f.open(),reserved=await a.store.reserve(scope,request());await a.store.begin(reserved.receipt);f.account('st-user:other');f.reset();
  await assert.rejects(a.store.settle(reserved.receipt,'succeeded'));assert.equal((await a.journal.read(namespace)).claims[0].outcomes[0].outcome,'succeeded');assert.equal(f.uploads,0);
  f.account(namespace);const done=await a.store.inspect(scope);assert.equal(done.established,true);assert.equal(done.pending,0);assert.equal((await a.journal.read(namespace)).claims.length,0);
});

test('only known local owners can be reconciled, and begun work becomes uncertain rather than cleared',async t=>{
  const f=await fixture(t),a=f.open(),reserved=await a.store.reserve(scope,request());await a.store.begin(reserved.receipt);const b=f.open();
  assert.deepEqual((await b.store.pendingOwners(scope)).owners,[]);const local=await a.store.pendingOwners(scope);assert.deepEqual(local.owners,['page-a']);
  await a.store.orphan(scope,{ownerId:'page-a',expectedRevision:local.revision,expectedGeneration:local.generation});assert.equal((await b.store.inspect(scope)).uncertain,1);
  await assert.rejects(b.store.unlock(scope,{expectedRevision:3,expectedGeneration:0}),/未明/);await b.store.unlock(scope,{expectedRevision:3,expectedGeneration:0,acknowledgeUncertain:true});assert.equal((await b.store.inspect(scope)).lock,null);
  await a.store.settle(reserved.receipt,'succeeded');assert.equal((await b.store.inspect(scope)).lock,null);
});

test('explicit style links, account cleanup and generation tombstones persist across empty devices without reviving old sources',async t=>{
  const f=await fixture(t),a=f.open(),reserved=await a.store.reserve(scope,request());await a.store.begin(reserved.receipt);await a.store.settle(reserved.receipt,'succeeded');const source=await a.store.inspect(scope),target={...scope,continuityId:'linked'};
  await a.store.linkStyle(scope,target,{expectedSourceRevision:source.revision,expectedRevision:0,expectedGeneration:0,label:{planId:'next',floor:1}});const b=f.open();assert.equal((await b.store.inspect(target)).styleOrigin.sourceFloor,0);
  const cleared=await b.store.clearAccount(namespace,{expectedGeneration:0});assert.equal(cleared.generation,1);assert.equal(cleared.retained,true);assert.equal((await a.store.inspect(scope)).lock,null);assert.equal((await a.store.list(namespace,'chat-a')).length,0);
  await assert.rejects(a.store.reserve(scope,request()),/代数/);const next=await a.store.reserve(scope,request({expectedGeneration:1}));assert.equal(next.view.generation,1);
});

test('readonly inventory never migrates legacy records or flushes a pending native publication',async t=>{
  const f=await fixture(t),old=comfySceneIdbFixture(),local=old.open();t.after(()=>local.close());await local.reserve(scope,request());const a=f.open(old);f.reset();await assert.rejects(a.store.storageSummary(namespace),/只读盘点/);assert.equal(f.uploads,0);
  await a.store.inspect(scope);f.reset();const summary=await a.store.storageSummary(namespace);assert.equal(summary.count,1);assert.equal(f.uploads,0);
  const b=f.open();await assert.rejects(b.store.clearAccount(namespace,{expectedGeneration:0}),/在途/);assert.equal((await b.journal.read(namespace)).pending,null);
});

test('lost native head acknowledgement is verified on the next access without a second scene transition',async t=>{
  const f=await fixture(t),a=f.open();let lost=false;f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),v=JSON.parse(body);if(!lost&&v.schema==='qianmu.st-account-head.v1'&&v.slot===slot){lost=true;f.files.set(name,body);throw Error('lost');}}});
  await assert.rejects(a.store.reserve(scope,request()));f.hook(null);f.reset();assert.equal((await a.store.inspect(scope)).revision,1);assert.equal(f.uploads,0);assert.equal((await a.journal.read(namespace)).pending,null);
});

test('independent client competition rejects the reservation, retains its exact conflict and does not freeze unrelated scenes',async t=>{
  const f=await fixture(t),a=f.open(),isolated=await import('../qianmu-st-account-storage.js?scene-independent-race');
  const b=f.open(undefined,undefined,options=>isolated.createStAccountStorage({...options,resolveNamespace:async()=>namespace,origin:'https://st.fixture.invalid',headers:()=>({'X-CSRF-Token':'synthetic'}),fetchImpl:f.fetchImpl}));
  let raced=false;f.hook(async call=>{if(call.path==='/api/files/upload'&&!raced){raced=true;await b.store.reserve(scope,request({attemptId:'b',ownerId:'page-b',token:'ticket-b'}));}});
  await assert.rejects(a.store.reserve(scope,request()),{code:'st_account_storage_conflict'});f.hook(null);
  const original=(await a.journal.read(namespace)).pending;assert.ok(original);const current=await a.store.inspect(scope);assert.equal(current.pending,1);
  const local=await a.journal.read(namespace);assert.equal(local.pending,null);assert.deepEqual(local.conflicts,[original]);assert.equal(local.claims.length,0);
  assert.deepEqual((await a.store.pendingOwners(scope)).owners,[]);const target={...scope,continuityId:'unrelated'};
  assert.equal((await a.store.reserve(target,request({lock:{...lock,scope:target},attemptId:'next'}))).view.pending,1);
  assert.deepEqual((await a.store.exportAll(namespace)).localJournal.conflicts,[original]);
});

test('another device with the same page owner string cannot be orphaned from a local ticket for a different attempt',async t=>{
  const f=await fixture(t),a=f.open(),first=await a.store.reserve(scope,request()),b=f.open();
  const next=await b.store.reserve(scope,request({expectedRevision:1,attemptId:'b',token:'different-ticket'}));await b.store.begin(next.receipt);
  assert.deepEqual((await a.store.pendingOwners(scope)).owners,[]);await assert.rejects(a.store.orphan(scope,{ownerId:'page-a',expectedRevision:3,expectedGeneration:0}),/另一设备/);
  await a.store.settle(first.receipt,'not_submitted');assert.equal((await b.store.inspect(scope)).pending,1);
});

test('known native directory loss never starts an empty scene library or discards queued original-account results',async t=>{
  const f=await fixture(t),a=f.open(),reserved=await a.store.reserve(scope,request());await a.store.begin(reserved.receipt);
  for(const [name,body]of f.files){const value=JSON.parse(body);if(value.schema==='qianmu.st-account-head.v1'&&value.slot===slot)f.files.delete(name);}
  f.reset();await assert.rejects(a.store.settle(reserved.receipt,'succeeded'),/目录缺失/);assert.equal(f.uploads,0);assert.equal((await a.journal.read(namespace)).claims[0].outcomes[0].outcome,'succeeded');
});

test('a read-only new device remembers a confirmed directory across restart but storage inventory itself remains write-free',async t=>{
  const f=await fixture(t),a=f.open();await a.store.reserve(scope,request());const b=f.open();await b.store.storageSummary(namespace);assert.equal(b.log.state.writes.length,0);
  await b.store.inspect(scope);assert.equal((await b.journal.read(namespace)).nativeKnown,true);b.store.close();
  for(const [name,body]of f.files){const value=JSON.parse(body);if(value.schema==='qianmu.st-account-head.v1'&&value.slot===slot)f.files.delete(name);}
  f.reset();const restarted=f.open(b.old,b.log);await assert.rejects(restarted.store.inspect(scope),/目录缺失/);assert.equal(f.uploads,0);
});

test('native directory validation enforces live scene and byte quotas before originals are loaded',async t=>{
  const f=await fixture(t),a=f.open();await a.store.reserve(scope,request());const index=(await f.storage.read(slot)).value,entry=index.entries[0];
  const expanded=(count,bytes)=>({...index,entries:Array.from({length:count},(_,i)=>({...structuredClone(entry),scope:{...scope,continuityId:'scene-'+i},versions:entry.versions.map(v=>({...v,stateBytes:bytes}))}))});
  assert.throws(()=>validateSceneIndex(expanded(1025,1),namespace,f.storage.scope),/容量/);
  assert.throws(()=>validateSceneIndex(expanded(129,32768),namespace,f.storage.scope),/容量/);
  assert.doesNotThrow(()=>validateSceneIndex(expanded(1024,1),namespace,f.storage.scope));
});

test('journal corruption and local transaction failures stop before a native reservation upload',async t=>{
  const f=await fixture(t),a=f.open();a.log.state.failOpen=true;await assert.rejects(a.store.reserve(scope,request()));assert.equal(f.uploads,0);
  a.log.state.failOpen=false;const clean=await a.journal.read(namespace);a.log.state.tables.accounts.set(namespace,{...clean,unknown:'discarding is not allowed'});
  await assert.rejects(a.store.reserve(scope,request()),/损坏/);assert.equal(f.uploads,0);
});

test('a failed result upload survives process recreation and is replayed as metadata, never as a provider job',async t=>{
  const f=await fixture(t),a=f.open(),reserved=await a.store.reserve(scope,request());await a.store.begin(reserved.receipt);
  f.hook(call=>{if(call.path==='/api/files/upload')throw Error('offline');});await assert.rejects(a.store.settle(reserved.receipt,'succeeded'));
  const pending=(await a.journal.read(namespace)).pending;assert.equal(pending.proposal.kind,'settle');a.store.close();f.hook(null);
  const restored=f.open(a.old,a.log);assert.equal((await restored.store.inspect(scope)).established,true);assert.equal((await restored.journal.read(namespace)).pending,null);
  assert.equal((await restored.journal.read(namespace)).claims.length,0);assert.ok(f.calls.every(call=>call.path==='/api/files/upload'||call.path.startsWith('/user/files/')));
});
