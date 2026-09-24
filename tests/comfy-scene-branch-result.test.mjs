import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {createComfySceneCoordinator} from '../qianmu-comfy-lock-runtime.js';
import {issueComfySceneArchiveProof} from '../qianmu-comfy-scene-result.js';
import {mountComfySceneReview} from '../qianmu-comfy-scene-view.js';
import {changeComfySceneRecord,comfySceneScopeKey} from '../qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,validateSceneProposal,validateSceneEvent} from '../qianmu-comfy-scene-native-contract.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA,comfySceneSnapshotBytes} from '../qianmu-comfy-scene-backup.js';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
const scope={namespace,chatKey:'chat',continuityId:'scene',narrativeLayer:'present'};
const lock=scope=>({schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)});
const request=(id,scope)=>({lock:lock(scope),expectedRevision:0,expectedGeneration:0,attemptId:id,ownerId:'page-'+id,token:'token-'+id,label:{planId:'plan',floor:1,workflowName:id}});
async function fixture(t,{fork=true,differentLock=false}={}){
  const f=await characterNativeFixture(t),open=(old=comfySceneIdbFixture(),log=comfySceneJournalFixture())=>{
    const journal=log.open(),store=createNativeComfySceneStore({legacy:old.open(),journal,createStorage:f.createStorage,now:()=>100});t.after(()=>store.close());return {store,journal,old,log};
  };
  const a=open(),reserved=await a.store.reserve(scope,request('A',scope));await a.store.begin(reserved.receipt);let b,bReceipt;
  if(fork){const original=(await a.store.exportScene(scope)).versions.at(-1).record,copy=structuredClone(original);copy.label.sceneTitle='Older source branch';
    const added=changeComfySceneRecord(copy,scope,{type:'reserve',...request('B',scope),expectedRevision:copy.revision},100);bReceipt=added.receipt;
    const record=changeComfySceneRecord(added.row,scope,{type:'begin',receipt:bReceipt},100).row;if(differentLock)record.lock.candidateId='different-candidate';const bytes=comfySceneSnapshotBytes(record);
    const old=comfySceneIdbFixture({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count:1,bytes,generation:0},rows:[{key:comfySceneScopeKey(scope),value:{namespace,chatKey:scope.chatKey,bytes,record}}]});
    b=open(old);await b.store.review(namespace,'chat');
  }
  return Object.assign(f,{open,a,b,receipt:reserved.receipt,bReceipt});
}
function archiveProof(id){
  const job={id,source:'comfy',chatKey:'chat',imageAdmission:{version:1,namespace,attemptId:id},connection:{baseUrl:'https://comfy.test'},comfySceneOrigin:{...lock(scope),version:1,mode:'scene',connectionPresetId:'',sourceHash:'c'.repeat(64)}};
  const row={version:1,namespace,attemptId:id,baseUrl:'https://comfy.test',chatKey:'chat',createdAt:1,status:'archived',receipt:'d'.repeat(64),imageCount:1,files:[{imageIndex:0,url:'/user/images/result.png'}]};
  return {job,row,proof:issueComfySceneArchiveProof(job,row,async()=>row,{origin:'https://st.test'})};
}

test('an actual local late result updates all and only exact-receipt branches without selecting a source',async t=>{
  const f=await fixture(t),before=(await f.a.store.review(namespace,'chat')).rows[0];assert.equal(before.branches.length,2);
  const result=await f.a.store.settle(f.receipt,'succeeded');assert.equal(result.view.conflicted,true);assert.equal(result.view.lock,null);
  const row=(await f.a.store.review(namespace,'chat')).rows[0];assert.equal(row.branches.length,2);assert.ok(row.branches.every(branch=>!branch.record.holders.some(holder=>holder.attemptId==='A')));
  assert.equal(row.branches.reduce((n,branch)=>n+branch.record.holders.filter(holder=>holder.attemptId==='B').length,0),1);await assert.rejects(f.a.store.inspect(scope),/分叉/);
  const packet=await f.a.store.exportScene(scope),updates=packet.versions.filter(event=>event.action?.type==='branch_result');assert.equal(updates.length,2);assert.ok(updates.every(event=>event.parents.length===1&&event.action.heads.length===2));
  assert.equal((await f.a.journal.read(namespace)).claims.length,0);assert.ok(f.calls.every(call=>call.path==='/api/files/upload'||call.path.startsWith('/user/files/')));
});

test('actual archive-proof coordinator confirms an imported task branch but never imports a receipt or auto-resolves the fork',async t=>{
  const f=await fixture(t);await f.a.store.settle(f.receipt,'succeeded');const other=f.open(),manager=createComfySceneCoordinator({store:other.store,resolveNamespace:async()=>namespace,ownerId:'review',locks:fakeWebLocks()});t.after(()=>manager.close());
  const evidence=archiveProof('B');await assert.rejects(manager.confirmArchived({version:1},evidence.job),{code:'comfy_scene_archive_proof'});
  const result=await manager.confirmArchived(evidence.proof,evidence.job);assert.equal(result.conflicted,true);const row=(await manager.review(namespace,'chat')).rows[0];assert.ok(row.branches.every(branch=>branch.record.holders.length===0));
  assert.equal((await other.journal.read(namespace)).claims.length,0);assert.equal(row.branches.length,2);await assert.rejects(other.store.begin(f.bReceipt),/分叉/);
  await manager.resolveSource(scope,{heads:row.heads,generation:row.generation,selected:row.branches[0].digest,acknowledged:true});assert.equal((await manager.inspect(scope)).pending,0);
});

test('a copied imported receipt cannot become an original-account branch settlement capability',async t=>{
  const f=await fixture(t);f.reset();await assert.rejects(f.b.store.settle(f.receipt,'succeeded'),/不持有/);assert.equal(f.uploads,0);assert.equal((await f.b.store.review(namespace,'chat')).rows[0].branches[0].record.holders[0].attemptId,'A');
});

test('lost multi-branch acknowledgement recovers exactly one metadata batch without duplicating transitions',async t=>{
  const f=await fixture(t);let lost=false;f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){lost=true;f.files.set(name,body);throw Error('lost');}}});
  await assert.rejects(f.a.store.settle(f.receipt,'succeeded'));const pending=(await f.a.journal.read(namespace)).pending;assert.equal(pending.proposal.kind,'branch_result');assert.equal(pending.proposal.events.length,2);validateSceneProposal(pending.proposal);
  f.hook(null);f.reset();assert.deepEqual(await f.a.store.synchronize(namespace),{errors:[]});assert.equal(f.uploads,0);assert.equal((await f.a.store.exportScene(scope)).versions.filter(event=>event.action?.type==='branch_result').length,2);assert.equal((await f.a.journal.read(namespace)).pending,null);
});

test('branch result contracts forbid selection, begin, mixed tasks and duplicate predecessor consumption',async t=>{
  const f=await fixture(t);f.hook(call=>{if(call.path==='/api/files/upload')throw Error('offline');});await assert.rejects(f.a.store.settle(f.receipt,'succeeded'));f.hook(null);
  const proposal=(await f.a.journal.read(namespace)).pending.proposal;validateSceneProposal(proposal);
  const mixed=structuredClone(proposal);mixed.events[1].action.operation.receipt.token='foreign';assert.throws(()=>validateSceneProposal(mixed));
  const duplicated=structuredClone(proposal);duplicated.events[1]=structuredClone(duplicated.events[0]);assert.throws(()=>validateSceneProposal(duplicated),/同一任务/);
  const begin=structuredClone(proposal.events[0]);begin.action.operation={type:'begin',receipt:f.receipt};assert.throws(()=>validateSceneEvent(begin,namespace),/不得预留/);
});

function removeOriginal(f,reference){let removed=0;for(const [name,body]of f.files)if(name.includes('-'+reference.slot+'-')&&name.endsWith('-'+reference.fingerprint+'.json')){f.files.delete(name);removed++;return {name,body};}assert.fail('original not removed: '+removed);}
test('a missing branch result does not block unrelated scene execution, another chat list or that chat cleanup',async t=>{
  const f=await fixture(t),index=(await f.storage.read(slot)).value,reference=index.entries[0].versions.at(-1).reference,removed=removeOriginal(f,reference);
  await assert.rejects(f.a.store.settle(f.receipt,'succeeded'));assert.equal((await f.a.journal.read(namespace)).pending,null);
  const next={...scope,chatKey:'other-chat',continuityId:'healthy'},reserved=await f.a.store.reserve(next,request('healthy',next));await f.a.store.begin(reserved.receipt);await f.a.store.settle(reserved.receipt,'succeeded');
  assert.equal((await f.a.store.list(namespace,'other-chat')).length,1);const manager=createComfySceneCoordinator({store:f.a.store,resolveNamespace:async()=>namespace,ownerId:'cleanup',locks:fakeWebLocks()});t.after(()=>manager.close());
  assert.equal((await manager.clearChat(namespace,'other-chat')).removed,1);assert.equal((await f.a.journal.read(namespace)).claims.find(row=>row.receipt.attemptId==='A').outcomes.length,1);
  f.files.set(removed.name,removed.body);assert.deepEqual(await f.a.store.synchronize(namespace),{errors:[]});assert.ok(!(await f.a.journal.read(namespace)).claims.some(row=>row.receipt.attemptId==='A'));
});

test('explicit synchronization reports a damaged scene but saves healthy queued results and keeps unresolved originals',async t=>{
  const f=await fixture(t),next={...scope,continuityId:'healthy'},second=await f.a.store.reserve(next,request('healthy',next));await f.a.store.begin(second.receipt);
  const index=(await f.storage.read(slot)).value;removeOriginal(f,index.entries.find(row=>row.scope.continuityId==='scene').versions.at(-1).reference);
  await f.a.journal.remember(f.receipt,'succeeded');await f.a.journal.remember(second.receipt,'succeeded');const result=await f.a.store.synchronize(namespace);
  assert.equal(result.errors.length,1);assert.deepEqual(result.errors[0].scope,scope);assert.equal((await f.a.store.inspect(next)).established,true);
  const claims=(await f.a.journal.read(namespace)).claims;assert.equal(claims.find(row=>row.receipt.attemptId==='A').outcomes.length,1);assert.ok(!claims.some(row=>row.receipt.attemptId==='healthy'));
});

test('archive evidence changes during branch preparation block all confirmation writes',async t=>{
  const f=await fixture(t),manager=createComfySceneCoordinator({store:f.a.store,resolveNamespace:async()=>namespace,ownerId:'review',locks:fakeWebLocks()});t.after(()=>manager.close());
  const {job,row}=archiveProof('B');let reads=0;const proof=issueComfySceneArchiveProof(job,row,async()=>{reads++;return reads===1?row:{...row,receipt:'e'.repeat(64)};},{origin:'https://st.test'});
  f.reset();await assert.rejects(manager.confirmArchived(proof,job),{code:'comfy_scene_archive_proof'});assert.equal(f.uploads,0);
});

test('the same ticket under incompatible branch styles remains unresolved with its original result retained',async t=>{
  const f=await fixture(t,{differentLock:true});f.reset();await assert.rejects(f.a.store.settle(f.receipt,'succeeded'),/不同风格来源/);assert.equal(f.uploads,0);
  assert.equal((await f.a.journal.read(namespace)).claims[0].outcomes.length,1);assert.ok((await f.a.store.review(namespace,'chat')).rows[0].branches.every(branch=>branch.record.holders.some(holder=>holder.attemptId==='A')));
});

test('a valid archived result only changes its matching style branch and cannot adopt the other style',async t=>{
  const f=await fixture(t,{differentLock:true}),manager=createComfySceneCoordinator({store:f.a.store,resolveNamespace:async()=>namespace,ownerId:'review',locks:fakeWebLocks()});t.after(()=>manager.close());
  const evidence=archiveProof('A');await manager.confirmArchived(evidence.proof,evidence.job);const branches=(await f.a.store.review(namespace,'chat')).rows[0].branches;
  assert.ok(branches.find(branch=>branch.record.lock.candidateId==='different-candidate').record.holders.some(holder=>holder.attemptId==='A'));
  assert.ok(!branches.find(branch=>branch.record.lock.candidateId==='candidate').record.holders.some(holder=>holder.attemptId==='A'));
  assert.deepEqual((await f.a.journal.read(namespace)).claims.map(row=>row.receipt),[f.receipt]);
  await assert.rejects(f.a.store.inspect(scope),/分叉/);
});

test('changed branch heads invalidate a prepared archive confirmation before any write',async t=>{
  const f=await fixture(t),snapshot=await f.b.store.resultSnapshot(scope);await f.a.store.settle(f.receipt,'succeeded');f.reset();
  await assert.rejects(f.b.store.confirmResult(scope,{attemptId:'B',lock:lock(scope),expectedRevision:snapshot.revision,expectedGeneration:snapshot.generation,expectedHeads:snapshot.heads}),/来源已变化/);assert.equal(f.uploads,0);
});

test('management sync shows a partial warning without falsely declaring every source saved',async()=>{
  const element={innerHTML:'',onclick:null,contains:()=>true},notifications=[],control={disabled:false,dataset:{sceneAction:'sync'},closest:()=>null};let reviews=0;
  const manager={review:async()=>{reviews++;return {native:true,rows:[],local:{outcomes:1}};},synchronize:async()=>({errors:[{scope,error:'原件缺失'}]})};
  await mountComfySceneReview({host:element,manager,namespace,chatKey:'chat',current:()=>true,guard:async()=>{},notify:(...args)=>notifications.push(args)});
  await element.onclick({target:{closest:()=>control},preventDefault(){},stopPropagation(){}});assert.equal(reviews,2);assert.deepEqual(notifications,[['1 个场景仍待核查：原件缺失','warning']]);assert.match(element.innerHTML,/原件缺失/);
});

test('a staged single-source result survives a newly discovered fork without replaying its obsolete predecessor',async t=>{
  const f=await fixture(t,{fork:false}),record=structuredClone((await f.a.store.exportScene(scope)).versions.at(-1).record);record.label.sceneTitle='Late old source';const bytes=comfySceneSnapshotBytes(record);
  f.hook(call=>{if(call.path==='/api/files/upload')throw Error('offline');});await assert.rejects(f.a.store.settle(f.receipt,'succeeded'));f.hook(null);
  assert.equal((await f.a.journal.read(namespace)).pending.proposal.kind,'settle');
  const old=comfySceneIdbFixture({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count:1,bytes,generation:0},rows:[{key:comfySceneScopeKey(scope),value:{namespace,chatKey:scope.chatKey,bytes,record}}]});
  await f.open(old).store.review(namespace,'chat');assert.deepEqual(await f.a.store.synchronize(namespace),{errors:[]});
  const local=await f.a.journal.read(namespace);assert.equal(local.pending,null);assert.equal(local.conflicts.length,1);assert.equal(local.claims.length,0);
  const row=(await f.a.store.review(namespace,'chat')).rows[0];assert.equal(row.branches.length,2);assert.ok(row.branches.every(branch=>branch.record.holders.length===0));
  const events=(await f.a.store.exportScene(scope)).versions;assert.equal(events.filter(event=>event.action?.type==='settle').length,0);assert.equal(events.filter(event=>event.action?.type==='branch_result').length,2);
});
