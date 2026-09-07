import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {COMFY_SCENE_LOCK_SCHEMA,COMFY_SCENE_RESERVATION_MS as TTL,normalizeComfySceneRecord,normalizeComfySceneReceipt,
  comfySceneScopeKey,changeComfySceneRecord as change,inspectComfySceneRecord as inspect} from '../qianmu-comfy-scene-lock.js';
import {createComfySceneLockStore,COMFY_SCENE_STORE_LIMITS} from '../qianmu-comfy-lock-store.js';
const namespace='st-user:scene-test',scope={namespace,chatKey:'chat-a',continuityId:'confirmed-scene-a',narrativeLayer:'present'};
const lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate-a',executionKey:'b'.repeat(64)};
const request=(overrides={})=>({type:'reserve',expectedRevision:0,lock,attemptId:'attempt-a',ownerId:'page-a',token:'token-a',...overrides});
const reserve=()=>change(null,scope,request(),100);
const next=(row,type,receipt,extra={})=>change(row,scope,{type,receipt,...extra},101).row;

test('first reservation pins the exact pool/route with metadata only and leaves original inputs unchanged',()=>{
  const input=request(),before=JSON.stringify(input),result=change(null,scope,input,100);
  assert.equal(result.row.revision,1);assert.equal(result.row.established,false);assert.deepEqual(result.row.lock,lock);
  assert.equal(result.row.holders[0].expiresAt,100+TTL);assert.equal(JSON.stringify(input),before);
  assert.deepEqual(inspect(result.row,scope,100),{revision:1,lockRevision:1,lock,established:false,pending:1,uncertain:0,scope,label:{planId:'',floor:null,workflowName:''},updatedAt:100});
  assert.doesNotMatch(JSON.stringify(result),/"(?:workflow|credential|prompt|apiKey|automaticEligible)":/);
});
test('only exact revisions may extend a scene; conflicting candidates and stale revisions cannot overwrite it',()=>{
  const a=reserve();assert.throws(()=>change(a.row,scope,request({attemptId:'b',token:'b'}),101),/另一任务/);
  assert.throws(()=>change(a.row,scope,request({attemptId:'b',token:'b',expectedRevision:1,lock:{...lock,candidateId:'other'}}),101),/锁定另一/);
  const b=change(a.row,scope,request({attemptId:'b',token:'b',expectedRevision:1}),101);
  assert.equal(b.row.holders.length,2);assert.equal(b.row.revision,2);
});
test('retrying an uncertain reservation write is idempotent only for its original owner and same route',()=>{
  const a=reserve(),again=change(a.row,scope,request({token:'new-token'}),101);
  assert.equal(again.row.revision,1);assert.deepEqual(again.receipt,a.receipt);assert.equal(again.row.holders.length,1);
  assert.throws(()=>change(a.row,scope,request({ownerId:'other'}),101),/变化/);
  assert.throws(()=>change(a.row,scope,request(),100+TTL),/变化/);
});
test('expired never-submitted claims may be replaced but old tickets cannot begin',()=>{
  const a=reserve();assert.equal(inspect(a.row,scope,100+TTL).lock,null);
  assert.throws(()=>change(a.row,scope,{type:'begin',receipt:a.receipt},100+TTL),/过期/);
  const b=change(a.row,scope,request({attemptId:'new',token:'new',expectedRevision:1,lock:{...lock,candidateId:'new'}}),100+TTL);
  assert.equal(b.row.lock.candidateId,'new');assert.equal(b.row.holders.length,1);
  assert.throws(()=>change(b.row,scope,{type:'begin',receipt:a.receipt},100+TTL),/失效/);
});
test('submission never times out into a free new route; begin is idempotent for the same ticket',()=>{
  const a=reserve(),row=next(a.row,'begin',a.receipt),again=next(row,'begin',a.receipt);
  assert.equal(row.holders[0].expiresAt,0);assert.equal(row.holders[0].status,'submitting');assert.equal(again.revision,row.revision);
  assert.equal(inspect(row,scope,10*TTL).pending,1);
  assert.throws(()=>change(row,scope,{type:'unlock',expectedRevision:row.revision},10*TTL),/在途任务/);
});
test('known pre-submission cancellation releases only that claim and retains a revision tombstone',()=>{
  const a=reserve(),b=change(a.row,scope,request({attemptId:'b',token:'b',expectedRevision:1}),101);
  const row=next(b.row,'settle',a.receipt,{outcome:'not_submitted'});assert.equal(row.holders.length,1);assert.deepEqual(row.lock,lock);
  const cleared=next(row,'settle',b.receipt,{outcome:'not_submitted'});assert.equal(cleared.lock,null);assert.ok(cleared.revision>row.revision);
  assert.throws(()=>change(cleared,scope,request(),102),/另一任务/);
});
test('unknown results remain occupied, cannot regress to not-submitted, and require explicit acknowledgement before unlock',()=>{
  const a=reserve(),row=next(next(a.row,'begin',a.receipt),'settle',a.receipt,{outcome:'unknown'});
  assert.equal(inspect(row,scope,100*TTL).uncertain,1);assert.equal(row.established,true);
  assert.throws(()=>next(row,'settle',a.receipt,{outcome:'not_submitted'}),/结果未明/);
  assert.throws(()=>change(row,scope,{type:'unlock',expectedRevision:row.revision},102),/结果未明/);
  const unlocked=change(row,scope,{type:'unlock',expectedRevision:row.revision,acknowledgeUncertain:true},102).row;
  assert.equal(unlocked.lock,null);assert.equal(unlocked.holders.length,0);assert.ok(unlocked.revision>row.revision);
  assert.throws(()=>next(unlocked,'settle',a.receipt,{outcome:'succeeded'}),/失效/);
});
test('finished or confirmed successful scenes keep their style even after new claims fail',()=>{
  const a=reserve(),row=next(next(a.row,'begin',a.receipt),'settle',a.receipt,{outcome:'succeeded'});
  assert.equal(row.established,true);assert.equal(row.holders.length,0);assert.deepEqual(inspect(row,scope,99*TTL).lock,lock);
  const b=change(row,scope,request({expectedRevision:row.revision,attemptId:'b',token:'b'}),102);
  const failed=next(b.row,'settle',b.receipt,{outcome:'rejected'});assert.equal(failed.established,true);assert.deepEqual(failed.lock,lock);
});
test('account, chat, scene and narrative-layer isolation also applies to every old receipt',()=>{
  const a=reserve();
  for(const changed of [{namespace:'st-user:other'},{chatKey:'chat-b'},{continuityId:'b'},{narrativeLayer:'memory'}]){
    const other={...scope,...changed};assert.notEqual(comfySceneScopeKey(other),comfySceneScopeKey(scope));
    assert.throws(()=>normalizeComfySceneRecord(a.row,other),/记录损坏|范围/);
    assert.throws(()=>change(null,other,{type:'begin',receipt:a.receipt},101),/不属于/);
  }
});
test('malformed histories fail closed; unknown imported fields never become authority',()=>{
  const a=reserve();
  for(const mutate of [r=>r.holders.push({...r.holders[0]}),r=>r.holders[0].status='approved',r=>r.lock.scope.chatKey='b',r=>r.revision=-1,r=>r.established='yes']){
    const row=structuredClone(a.row);mutate(row);assert.throws(()=>normalizeComfySceneRecord(row,scope));
  }
  const imported=normalizeComfySceneRecord({...a.row,apiKey:'secret',approved:true},scope);assert.doesNotMatch(JSON.stringify(imported),/secret|approved/);
  assert.deepEqual(normalizeComfySceneReceipt({...a.receipt,workflow:'do not store'}),a.receipt);
});
test('pending holder count is bounded and invalid outcomes cannot release a claim',()=>{
  let a=reserve();for(let i=1;i<32;i++)a=change(a.row,scope,request({expectedRevision:a.row.revision,attemptId:`a${i}`,token:`t${i}`}),101);
  assert.throws(()=>change(a.row,scope,request({expectedRevision:a.row.revision,attemptId:'overflow',token:'overflow'}),102),/过多/);
  assert.throws(()=>change(a.row,scope,{type:'settle',receipt:a.receipt,outcome:'cancel-anyway'},102),/结果无效/);
});
test('store is lazy, invalid scope/request fails before opening, and storage failure never creates permission',async()=>{
  let opens=0;const store=createComfySceneLockStore({indexedDB:{open(){opens++;throw Error('denied');}}});assert.equal(opens,0);
  await assert.rejects(()=>store.inspect({...scope,namespace:''}));await assert.rejects(()=>store.reserve(scope,request({token:''})));assert.equal(opens,0);
  await assert.rejects(()=>store.reserve(scope,request()),/存储空间/);assert.equal(opens,1);await assert.rejects(()=>store.inspect(scope),/存储空间/);assert.equal(opens,2);
  store.close();await assert.rejects(()=>store.inspect(scope),/已结束/);
});
test('blocked and expired opens close late handles and do not revive a cancelled store',async()=>{
  for(const mode of ['blocked','timeout','close']){
    const request={};let closes=0;const store=createComfySceneLockStore({indexedDB:{open:()=>request},timeoutMs:100});
    const promise=store.inspect(scope);if(mode==='blocked')request.onblocked();if(mode==='close'){store.close();request.result={close:()=>closes++};request.onsuccess();}
    await assert.rejects(promise,/占用|超时|已结束/);
    if(mode!=='close'){request.result={close:()=>closes++};request.onsuccess();}assert.equal(closes,1);store.close();
  }
});
test('capacity configuration cannot remove hard bounds; lifecycle code has no network or timer-based unlocking',async()=>{
  assert.throws(()=>createComfySceneLockStore({limits:{scopes:COMFY_SCENE_STORE_LIMITS.scopes+1}}));
  const pure=await readFile(new URL('../qianmu-comfy-scene-lock.js',import.meta.url),'utf8');assert.doesNotMatch(pure,/fetch\(|indexedDB|setInterval|setTimeout/);
  assert.equal(COMFY_SCENE_LOCK_SCHEMA,'qianmu.comfy.scene-lock.v1');
});
