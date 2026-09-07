import test from 'node:test';
import assert from 'node:assert/strict';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {captureComfySceneStyleLink as capture,copyComfySceneStyleRecord as link,changeComfySceneRecord as change,
  inspectComfySceneRecord as inspect,normalizeComfySceneRecord as normalize} from '../qianmu-comfy-scene-lock.js';
import {createComfySceneLockStore} from '../qianmu-comfy-lock-store.js';
import {createComfySceneCoordinator} from '../qianmu-comfy-lock-runtime.js';
const namespace='st-user:link',from={namespace,chatKey:'chat',continuityId:'source',narrativeLayer:'present'},to={...from,continuityId:'target'};
const style={schema:COMFY_SELECTION_SCHEMA,scope:from,poolKey:'a'.repeat(64),candidateId:'portrait',executionKey:'b'.repeat(64)};
const copy=value=>JSON.parse(JSON.stringify(value));
function source(){
  const claim=change(null,from,{type:'reserve',expectedRevision:0,lock:style,label:{planId:'p1',floor:1,workflowName:'原人物风格'},attemptId:'a',ownerId:'page',token:'secret'},100);
  return change(claim.row,from,{type:'settle',receipt:claim.receipt,outcome:'succeeded'},101).row;
}
const request=(row=source(),extra={})=>capture(from,to,{expectedSourceRevision:row.revision,expectedRevision:0,expectedGeneration:0,label:{planId:'p2',floor:2,workflowName:'not authoritative'},...extra});

test('explicit link copies only an exact style into a later same-layer scope without a claim or image',()=>{
  const a=source(),input=request(a),before=JSON.stringify([a,input]),b=link(a,null,input,110).row;
  assert.equal(JSON.stringify([a,input]),before);assert.deepEqual(b.lock,{...style,scope:to});assert.deepEqual(b.holders,[]);
  assert.equal(b.established,true);assert.equal(b.label.workflowName,a.label.workflowName);assert.equal(b.label.planId,'p2');
  assert.deepEqual(b.styleOrigin,{kind:'explicit_link',sourceScope:from,sourceRevision:2,sourceFloor:1,targetFloor:2,linkedAt:110});
  assert.equal(inspect(b,to,110).pending,0);assert.deepEqual(normalize(copy(b),to),b);
  assert.doesNotMatch(JSON.stringify(b),/secret|executionAuthorized|automaticEligible|"workflow"|"apiKey"/);
});
test('source and target scopes and revisions cannot be widened, guessed, or reused after an unlock',()=>{
  const a=source();
  for(const patch of [{namespace:'st-user:other'},{chatKey:'other'},{narrativeLayer:'memory'},{continuityId:'source'}])assert.throws(()=>capture(from,{...to,...patch},request(a)));
  for(const field of ['expectedSourceRevision','expectedRevision','expectedGeneration'])assert.throws(()=>request(a,{[field]:-1}));
  assert.throws(()=>request(a,{label:{floor:2}}),/先提取/);
  const cleared=change(a,from,{type:'unlock',expectedRevision:a.revision},102).row;
  assert.throws(()=>link(cleared,null,request(a),110),/已变化/);
  assert.throws(()=>link(cleared,null,request(cleared),110),/结果明确/);
});
test('pending, unknown, expired unestablished and missing sources cannot supply style',()=>{
  for(const status of ['reserved','submitting','uncertain']){
    const a=source();a.holders=[{attemptId:'pending',ownerId:'page',token:'p',status,expiresAt:status==='reserved'?500:0}];
    assert.throws(()=>link(a,null,request(a),110),/结果明确/);
  }
  const expired=source();expired.established=false;expired.holders=[{attemptId:'old',ownerId:'page',token:'p',status:'reserved',expiresAt:100}];
  assert.throws(()=>link(expired,null,request(expired),110),/结果明确/);
  assert.throws(()=>link(null,null,request(),110),/已变化/);
});
test('a target is never overwritten even if the workflow matches; unlock then a fresh explicit selection is required',()=>{
  const a=source(),b=link(a,null,request(a),110).row;
  assert.throws(()=>link(a,b,request(a),111),/已变化/);
  assert.throws(()=>link(a,b,request(a,{expectedRevision:b.revision}),111),/已有风格/);
  const cleared=change(b,to,{type:'unlock',expectedRevision:b.revision},112).row;
  assert.equal(cleared.styleOrigin,undefined);assert.equal(cleared.lock,null);
  const renewed=link(a,cleared,request(a,{expectedRevision:cleared.revision}),113).row;
  assert.equal(renewed.lockRevision,cleared.revision+1);
});
test('explicit copies are independent snapshots; later source clearing does not recurse into the target',()=>{
  const a=source(),b=link(a,null,request(a),110).row;
  change(a,from,{type:'unlock',expectedRevision:a.revision},111);
  assert.deepEqual(inspect(b,to,112).lock,{...style,scope:to});
  const third={...to,continuityId:'third'},c=link(b,null,capture(to,third,{expectedSourceRevision:b.revision,expectedRevision:0,expectedGeneration:0,label:{planId:'p3',floor:3}}),113).row;
  assert.deepEqual(c.styleOrigin.sourceScope,to);assert.equal(c.styleOrigin.sourceRevision,b.revision);
  assert.equal(JSON.stringify(c).includes('"sourceScope":{"namespace":"st-user:link","chatKey":"chat","continuityId":"source"'),false);
  assert.ok(JSON.stringify(c).length<1800);
});
test('unknown floor, backwards or equal-floor references and malformed provenance are rejected',()=>{
  const a=source();
  for(const floor of [0,1])assert.throws(()=>link(a,null,request(a,{label:{planId:'p2',floor}}),110),/之前/);
  a.label.floor=null;assert.throws(()=>link(a,null,request(a),110),/之前/);
  const b=link(source(),null,request(),110).row;
  for(const patch of [{sourceRevision:0},{sourceFloor:2},{linkedAt:-1},{kind:'automatic_guess'},{sourceScope:{...from,narrativeLayer:'dream'}}]){
    assert.throws(()=>normalize({...b,styleOrigin:{...b.styleOrigin,...patch}},to));
  }
  assert.throws(()=>normalize({...b,lock:null,established:false},to),/残留/);
});
test('a subsequent rejected job preserves an explicit chosen style and its provenance, without granting submission',()=>{
  const a=source(),b=link(a,null,request(a),110).row;
  const claim=change(b,to,{type:'reserve',expectedRevision:b.revision,lock:b.lock,attemptId:'new',ownerId:'page',token:'new'},111);
  const done=change(claim.row,to,{type:'settle',receipt:claim.receipt,outcome:'not_submitted'},112).row;
  assert.equal(done.established,true);assert.deepEqual(done.styleOrigin,b.styleOrigin);assert.deepEqual(done.lock,b.lock);assert.equal(done.holders.length,0);
});
test('link validation runs before opening storage; closed stores do not revive',async()=>{
  let opens=0;const store=createComfySceneLockStore({indexedDB:{open(){opens++;throw Error('denied');}}});
  await assert.rejects(()=>store.linkStyle(from,{...to,chatKey:'other'},request()));assert.equal(opens,0);
  await assert.rejects(()=>store.linkStyle(from,to,request()),/存储空间/);assert.equal(opens,1);
  store.close();await assert.rejects(()=>store.linkStyle(from,to,request()),/已结束/);assert.equal(opens,1);
});
test('coordinator freezes link input before asynchronous identity reads, and refuses account or page changes',async()=>{
  for(const mode of ['normal','mutate','account','page','late']){
    let account=namespace,valid=true,calls=0,reads=0,input=request();
    const manager=createComfySceneCoordinator({ownerId:'page',resolveNamespace:async()=>{
      reads++;if(mode==='mutate')input.label.floor=100;if(mode==='account')account='st-user:other';return account;
    },store:{linkStyle:async(sourceScope,targetScope,captured)=>{calls++;assert.equal(captured.label.floor,2);if(mode==='late')valid=false;return {view:inspect(link(source(),null,captured,110).row,to,110)};},close(){}}});
    if(mode==='page')valid=false;
    const action=()=>manager.linkStyle(from,to,input,{valid:()=>valid});
    if(['normal','mutate'].includes(mode)){const view=await action();assert.equal(view.styleOrigin.targetFloor,2);assert.equal(calls,1);}
    else{await assert.rejects(action);assert.equal(calls,mode==='late'?1:0);}
    await manager.close();await assert.rejects(action);assert.ok(reads<=3);
  }
});
