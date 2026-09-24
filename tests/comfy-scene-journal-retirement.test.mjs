import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {createComfySceneCoordinator} from '../qianmu-comfy-lock-runtime.js';
import {issueComfySceneArchiveProof} from '../qianmu-comfy-scene-result.js';
import {COMFY_SCENE_NATIVE_SLOT as slot} from '../qianmu-comfy-scene-native-contract.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {completedComfySceneSource} from './helpers/comfy-scene-source-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';

async function fixture(t){
  const f=await characterNativeFixture(t),sample=completedComfySceneSource(namespace,1).rows[0].value.record;
  const open=(old=comfySceneIdbFixture(),log=comfySceneJournalFixture())=>{
    const base=log.open(),hooks={},selected=[],staged=[],retirements=[];
    const journal={...base,
      select:async(ns,q)=>{const value=await base.select(ns,q);selected.push(q.kind);await hooks.selected?.(q,value);return value;},
      stage:async(ns,p)=>{staged.push(structuredClone(p));return base.stage(ns,p);},
      retire:async(ns,receipts)=>{retirements.push(structuredClone(receipts));await hooks.retire?.(receipts);return base.retire(ns,receipts);},
    };
    const store=createNativeComfySceneStore({legacy:old.open(),journal,createStorage:f.createStorage,now:()=>100});t.after(()=>store.close());return {store,base,old,log,hooks,selected,staged,retirements};
  },a=open(),scope=sample.scope;
  const reserve=async(target=scope,id='one')=>{const current=await a.store.inspect(target);return a.store.reserve(target,{lock:{...sample.lock,scope:target},expectedRevision:current.revision,expectedGeneration:current.generation,attemptId:id,ownerId:'page',token:'synthetic-'+id});};
  return Object.assign(f,{a,open,scope,sample,reserve});
}
const retained=(before,after)=>{for(const [name,body]of before)if(JSON.parse(body).schema!=='qianmu.st-account-head.v1')assert.equal(after.get(name),body);};

test('actual completion of 1/8/32 distinct scenes no longer accumulates runtime tickets, while all transitions remain exportable',async t=>{
  const f=await fixture(t),rows=[];let previous=new Map(f.files);
  for(let n=1;n<=32;n++){
    const scope={...f.scope,continuityId:'finished-'+n},r=await f.reserve(scope,'task-'+n);await f.a.store.begin(r.receipt);await f.a.store.settle(r.receipt,'succeeded');
    retained(previous,f.files);previous=new Map(f.files);
    if(![1,8,32].includes(n))continue;const local=await f.a.base.read(namespace);assert.equal(local.claims.length,0);assert.equal(local.pending,null);assert.equal(local.conflicts.length,0);
    const values=[];f.a.log.state.reads.length=0;f.a.log.state.beforeTransaction=()=>values.push(Buffer.byteLength(JSON.stringify(f.a.log.state.tables.accounts.get(namespace))));
    await f.a.store.inspect({...f.scope,continuityId:'unused'});f.a.log.state.beforeTransaction=null;
    rows.push({scenes:n,claims:0,journalBytes:Buffer.byteLength(JSON.stringify(local)),nextInspectGets:f.a.log.state.reads.filter(r=>r.kind==='get').length,nextInspectReadJsonBytes:values.reduce((a,b)=>a+b,0)});
  }
  const exported=await f.a.store.exportAll(namespace);assert.equal(exported.entries.length,32);
  for(const entry of exported.entries){assert.equal(entry.versions.length,3);assert.deepEqual(entry.versions.map(row=>row.action.type),['reserve','begin','settle']);assert.equal(entry.versions.at(-1).action.outcome,'succeeded');}
  assert.ok(rows.every(row=>row.journalBytes<180&&row.nextInspectGets===3));
  t.diagnostic(JSON.stringify({scope:'actual completed native lifecycle over isolated ST/IDB; JSON bodies, not disk or latency measurement',rows}));
});

for(const outcome of ['not_submitted','rejected','accepted','unknown','succeeded'])test(`${outcome} only retires a ticket if no verified branch still holds it`,async t=>{
  const f=await fixture(t),r=await f.reserve();if(outcome!=='not_submitted')await f.a.store.begin(r.receipt);const before=new Map(f.files);
  await f.a.store.settle(r.receipt,outcome);const local=await f.a.base.read(namespace),unfinished=['accepted','unknown'].includes(outcome);assert.equal(local.claims.length,unfinished?1:0);
  const packet=await f.a.store.exportScene(f.scope);assert.equal(packet.versions.at(-1).record.holders.length,unfinished?1:0);retained(before,f.files);
  if(unfinished){assert.equal(local.claims[0].outcomes.length,0);await f.a.store.settle(r.receipt,'succeeded');assert.equal((await f.a.base.read(namespace)).claims.length,0);}
});

test('one completed ticket does not retire another exact task, even with the same scene and page owner',async t=>{
  const f=await fixture(t),a=await f.reserve(f.scope,'A'),b=await f.reserve(f.scope,'B');await f.a.store.begin(a.receipt);await f.a.store.begin(b.receipt);
  await f.a.store.settle(a.receipt,'succeeded');const local=await f.a.base.read(namespace);assert.deepEqual(local.claims.map(row=>row.receipt),[b.receipt]);
  assert.deepEqual((await f.a.store.exportScene(f.scope)).versions.at(-1).record.holders.map(row=>row.attemptId),['B']);
});

test('a concurrently arriving outcome is retained by the atomic retire, then synchronized without provider resubmission',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);const other=f.a.log.open();t.after(()=>other.close());let injected=false;
  f.a.hooks.retire=async()=>{if(!injected){injected=true;await other.remember(r.receipt,'succeeded');}};
  await f.a.store.settle(r.receipt,'succeeded');const local=await f.a.base.read(namespace);assert.equal(local.claims.length,1);assert.equal(local.claims[0].outcomes.length,1);
  const before=await f.a.store.exportScene(f.scope);f.reset();await f.a.store.synchronize(namespace);assert.equal(f.uploads,0);assert.equal((await f.a.base.read(namespace)).claims.length,0);
  assert.deepEqual(await f.a.store.exportScene(f.scope),before);
});

test('a second page staging work during retirement preserves that intent and its original ticket',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);const other=f.a.log.open();t.after(()=>other.close());const original=structuredClone(f.a.staged[0]);
  f.a.hooks.retire=async()=>{await other.stage(namespace,original);};await assert.rejects(f.a.store.settle(r.receipt,'succeeded'),/待保存/);
  const local=await f.a.base.read(namespace);assert.deepEqual(local.pending,{id:original.id,proposal:original});assert.deepEqual(local.claims[0].receipt,r.receipt);
  assert.equal((await f.a.store.exportScene(f.scope)).versions.at(-1).action.outcome,'succeeded');
});

test('local retirement failure keeps a fully saved result and the ticket for later reconciliation',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);f.a.hooks.retire=()=>{throw Error('local transaction unavailable');};
  await assert.rejects(f.a.store.settle(r.receipt,'succeeded'),/transaction unavailable/);const local=await f.a.base.read(namespace);assert.equal(local.pending,null);assert.equal(local.claims.length,1);
  assert.equal((await f.a.store.exportScene(f.scope)).versions.at(-1).action.outcome,'succeeded');f.a.hooks.retire=null;f.reset();assert.equal((await f.a.store.inspect(f.scope)).established,true);
  assert.equal((await f.a.base.read(namespace)).claims.length,0);assert.equal(f.uploads,0);
});

test('lost publication acknowledgement recovers and retires only the confirmed ticket without a second transition',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);let lost=false;
  f.hook(call=>{if(call.path!=='/api/files/upload')return;const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);
    if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){lost=true;f.files.set(name,body);throw Error('ack lost');}});
  await assert.rejects(f.a.store.settle(r.receipt,'succeeded'));assert.ok((await f.a.base.read(namespace)).pending);f.hook(null);f.reset();
  await f.a.store.synchronize(namespace);assert.equal(f.uploads,0);assert.equal((await f.a.base.read(namespace)).claims.length,0);assert.equal((await f.a.store.exportScene(f.scope)).versions.length,3);
});

test('archive confirmation retires only local completed tickets and does not change its public result shape',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);await f.a.store.settle(r.receipt,'accepted');const state=await f.a.store.resultSnapshot(f.scope);
  const result=await f.a.store.confirmResult(f.scope,{attemptId:r.receipt.attemptId,lock:f.sample.lock,expectedRevision:state.revision,expectedGeneration:state.generation,expectedHeads:state.heads});
  assert.deepEqual(Object.keys(result),['view']);assert.equal(result.view.uncertain,0);assert.equal((await f.a.base.read(namespace)).claims.length,0);
  assert.equal((await f.a.store.exportScene(f.scope)).versions.at(-1).action.type,'confirm_result');
});

test('a normal begin performs one authority read but a revocation immediately after it still blocks inside the staging transaction',async t=>{
  const f=await fixture(t),r=await f.reserve();f.a.selected.length=0;f.a.log.state.reads.length=0;await f.a.store.begin(r.receipt);assert.equal(f.a.selected.filter(kind=>kind==='authority').length,1);assert.equal(f.a.log.state.reads.filter(row=>row.kind==='get').length,6);
  const b=await f.reserve({...f.scope,continuityId:'second'},'second'),original=structuredClone(f.a.staged.find(p=>p.kind==='reserve'&&p.receipt.attemptId==='second')),other=f.a.log.open();t.after(()=>other.close());let changed=false;
  f.a.hooks.selected=async(query,value)=>{if(query.kind==='authority'&&!changed){assert.equal(value.executable,true);changed=true;await other.stage(namespace,original);await other.retainConflict(namespace,original.id);}};
  const before=new Map(f.files);f.reset();await assert.rejects(f.a.store.begin(b.receipt),/保存冲突取消/);assert.equal(f.uploads,0);assert.deepEqual(f.files,before);
  const local=await f.a.base.read(namespace);assert.equal(local.pending,null);assert.deepEqual(local.conflicts[0].proposal,original);assert.equal(local.claims.find(row=>row.receipt.attemptId==='second').outcomes[0].outcome,'not_submitted');
});

test('unrelated corrupt journal data still stops settlement and cannot be bypassed by retiring a healthy ticket',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);f.a.log.state.tables.accounts.get(namespace).extra='corrupt';f.reset();
  await assert.rejects(f.a.store.settle(r.receipt,'succeeded'));assert.equal(f.uploads,0);assert.equal(f.a.retirements.length,0);assert.equal(f.a.log.state.tables.accounts.get(namespace).claims.length,1);
});

test('actual coordinator archival proof closes the original local ticket while keeping its complete native history',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);await f.a.store.settle(r.receipt,'accepted');const before=new Map(f.files);
  const id=r.receipt.attemptId,job={id,source:'comfy',chatKey:f.scope.chatKey,imageAdmission:{version:1,namespace,attemptId:id},connection:{baseUrl:'https://comfy.test'},
    comfySceneOrigin:{...f.sample.lock,version:1,mode:'scene',connectionPresetId:'',sourceHash:'c'.repeat(64)}},row={version:1,namespace,attemptId:id,baseUrl:'https://comfy.test',chatKey:f.scope.chatKey,createdAt:1,status:'archived',receipt:'d'.repeat(64),imageCount:1,files:[{imageIndex:0,url:'/user/images/result.png'}]};
  const manager=createComfySceneCoordinator({store:f.a.store,resolveNamespace:async()=>namespace,ownerId:'review',locks:fakeWebLocks()});t.after(()=>manager.close());
  const proof=issueComfySceneArchiveProof(job,row,async()=>row,{origin:'https://st.test'}),view=await manager.confirmArchived(proof,job);
  assert.equal(view.pending,0);assert.equal(view.uncertain,0);assert.equal((await f.a.base.read(namespace)).claims.length,0);retained(before,f.files);
  assert.deepEqual((await f.a.store.exportScene(f.scope)).versions.map(event=>event.action.type),['reserve','begin','settle','confirm_result']);
});

test('read-only management, inventory and export do not become background ticket cleanup or pending replay',async t=>{
  const f=await fixture(t),r=await f.reserve();await f.a.store.begin(r.receipt);f.a.hooks.retire=()=>{throw Error('leave ticket for the read-only check');};
  await assert.rejects(f.a.store.settle(r.receipt,'succeeded'));const before=await f.a.base.read(namespace);assert.equal(before.claims.length,1);f.a.hooks.retire=null;f.reset();
  await f.a.store.review(namespace,f.scope.chatKey);await f.a.store.storageSummary(namespace);await f.a.store.exportScene(f.scope);await f.a.store.exportAll(namespace);
  assert.deepEqual(await f.a.base.read(namespace),before);assert.equal(f.uploads,0);
});
