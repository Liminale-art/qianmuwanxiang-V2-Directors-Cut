import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfySceneOwnerLease,createComfySceneCoordinator,createComfyBatchSceneScopes} from '../qianmu-comfy-lock-runtime.js';
import {changeComfySceneRecord as change,inspectComfySceneRecord as inspect} from '../qianmu-comfy-scene-lock.js';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
const scope={namespace:'st-user:recovery',chatKey:'chat',continuityId:'scene',narrativeLayer:'present'};
const lock={schema:'qianmu.comfy.selection.v1',scope,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)};
const group={id:'group',shotIds:['shot-a','shot-b'],sceneFingerprint:{sceneId:'same-llm-key',location:'kitchen',time:'day',narrativeLayer:'present'}};

test('program batch scope is stable only for this account/chat/batch/layer, never a free-standing LLM scene key',async()=>{
  const options={namespace:scope.namespace,chatKey:scope.chatKey,batchKey:'plan-a',groups:[group]},a=await createComfyBatchSceneScopes(options),b=await createComfyBatchSceneScopes(options);
  assert.deepEqual(a.get('shot-a'),b.get('shot-a'));assert.equal(a.get('shot-a'),a.get('shot-b'));
  for(const patch of [{namespace:'st-user:other'},{chatKey:'other'},{batchKey:'plan-b'},{groups:[{...group,sceneFingerprint:{...group.sceneFingerprint,narrativeLayer:'memory'}}]}]){
    const other=await createComfyBatchSceneScopes({...options,...patch});assert.notEqual(a.get('shot-a').continuityId,other.get('shot-a').continuityId);
  }
  await assert.rejects(()=>createComfyBatchSceneScopes({...options,groups:[group,group]}),/重复/);
  await assert.rejects(()=>createComfyBatchSceneScopes({...options,guard:async()=>{throw Error('account changed');}}),/account changed/);
  const changing=structuredClone(options);await assert.rejects(()=>createComfyBatchSceneScopes({...changing,guard:async()=>{changing.groups[0].sceneFingerprint.time='night';}}),/变化/);
});

test('active owner cannot be declared dead; closing releases the browser lifetime lock',async()=>{
  const locks=fakeWebLocks(),owner=createComfySceneOwnerLease({locks,ownerId:'page-a'}),reader=createComfySceneOwnerLease({locks,ownerId:'page-b'});let actions=0;
  await owner.hold(scope.namespace);await owner.hold(scope.namespace);assert.equal(locks.held.size,1);
  assert.equal(await reader.withVacantOwner(scope.namespace,'page-a',async()=>actions++),false);assert.equal(actions,0);
  owner.close();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await reader.withVacantOwner(scope.namespace,'page-a',async()=>actions++),true);assert.equal(actions,1);reader.close();
});

test('unsupported or denied owner protection does not degrade to time-based guesses',async()=>{
  for(const locks of [null,{request:()=>Promise.reject(Error('denied'))}]){
    const owner=createComfySceneOwnerLease({locks,ownerId:'a'});await assert.rejects(()=>owner.hold(scope.namespace),{code:'comfy_scene_owner'});owner.close();
  }
  let late;const owner=createComfySceneOwnerLease({locks:{request:(_name,_options,callback)=>{late=callback;return new Promise(()=>{});}},ownerId:'a',timeoutMs:100});
  await assert.rejects(()=>owner.hold(scope.namespace),{code:'comfy_scene_owner'});await late({name:'late'});owner.close();
});

test('actual reconciliation checks vacant owner locks and preserves an orphaned submission as unknown until explicit unlock',async()=>{
  const locks=fakeWebLocks(),original=createComfySceneOwnerLease({locks,ownerId:'page-a'});await original.hold(scope.namespace);
  let reserved=change(null,scope,{type:'reserve',expectedRevision:0,lock,ownerId:'page-a',attemptId:'job',token:'ticket'}),row=change(reserved.row,scope,{type:'begin',receipt:reserved.receipt}).row;
  const view=()=>({...inspect(row,scope),generation:0});
  const store={inspect:async()=>view(),pendingOwners:async()=>({...view(),owners:row.holders.filter(h=>h.status!=='uncertain').map(h=>h.ownerId)}),
    orphan:async(_scope,action)=>{row=change(row,scope,{...action,type:'orphan'}).row;return {view:view()};},
    unlock:async(_scope,action)=>{row=change(row,scope,{...action,type:'unlock'}).row;return {view:view()};},close(){}};
  const manager=createComfySceneCoordinator({store,resolveNamespace:async()=>scope.namespace,ownerId:'page-b',locks});
  try{
    assert.equal((await manager.reconcile(scope)).pending,1);original.close();await new Promise(resolve=>setImmediate(resolve));
    const recovered=await manager.reconcile(scope);assert.equal(recovered.pending,0);assert.equal(recovered.uncertain,1);assert.equal(recovered.established,true);assert.deepEqual(recovered.lock,lock);
    await assert.rejects(()=>manager.unlock(scope,recovered),/未明/);
    assert.equal((await manager.unlock(scope,recovered,{acknowledgeUncertain:true})).lock,null);
  }finally{original.close();await manager.close();}
});

test('orphaning never releases another owner or a changed revision; never-submitted tickets alone can be removed',()=>{
  const a=change(null,scope,{type:'reserve',expectedRevision:0,lock,ownerId:'a',attemptId:'a',token:'a'});
  const b=change(a.row,scope,{type:'reserve',expectedRevision:1,lock,ownerId:'b',attemptId:'b',token:'b'});
  const removed=change(b.row,scope,{type:'orphan',expectedRevision:2,ownerId:'a'});
  assert.deepEqual(removed.row.holders.map(h=>h.ownerId),['b']);assert.equal(removed.row.established,false);
  assert.throws(()=>change(removed.row,scope,{type:'orphan',expectedRevision:2,ownerId:'b'}),/变化/);
  assert.equal(change(removed.row,scope,{type:'orphan',expectedRevision:3,ownerId:'b'}).row.lock,null);
});
