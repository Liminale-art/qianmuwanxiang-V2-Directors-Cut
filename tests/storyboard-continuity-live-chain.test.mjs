import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureStoryboardContinuitySource as capture,replayLiveStoryboardContinuity as replay} from '../qianmu-storyboard-continuity-source.js';
const roster={branches:[{id:'now',layer:'present'}],subjectIds:['A']};
const target={branchId:'now',paragraphId:'P1',evidence:'A继续聊天。'};
async function fixture(){
 const emitter=new EventEmitter(),context={chatId:'chat',characterId:0,characters:[{avatar:'A.png',chat:'chat'}],chatMetadata:{},eventSource:emitter,
  chat:[{mes:'A脱下外套。',name:'A',send_date:'one'},{mes:'A继续聊天。',name:'A',send_date:'two'}]};
 let account='st-user:alice',resolveHook=null,calls=0;
 const options={getContext:()=>context,epoch:()=>0,resolveNamespace:async()=>{calls++;return resolveHook?resolveHook():account;},isCurrent:()=>true,readParagraphs:message=>[{id:'P1',text:message.mes}]};
 const sources=[await capture({...options,floor:0}),await capture({...options,floor:1})];
 const steps=sources.map(source=>({source,roster,branchId:'now',link:null,events:[]}));
 steps[0].events=[{id:'coat',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value:'off',persistence:'persistent',evidence:'A脱下外套。'}];
 steps[1].link={relation:'continuous',fromRevisionId:sources[0].messageRef.revisionId,toRevisionId:sources[1].messageRef.revisionId,fromBranchId:'now',toBranchId:'now',evidence:{paragraphId:'P1',quote:'A继续聊天。'},facts:[{sourceFloor:0,sourceRevisionId:sources[0].messageRef.revisionId,eventId:'coat',subjectId:'A'}]};
 return {context,steps,sources,set account(value){account=value;},set hook(value){resolveHook=value;},get calls(){return calls;},close:()=>sources.forEach(source=>source.close()),listeners:()=>emitter.eventNames().reduce((n,key)=>n+emitter.listenerCount(key),0)};
}
test('live handoff verifies common owner and exact selected reference window without re-reading other floors or exposing account',async()=>{
 const f=await fixture(),before=JSON.stringify([f.context.chat,f.context.chatMetadata]),calls=f.calls;
 const result=await replay(f.steps,target,{referenceFloors:1});assert.equal(result.effectiveFacts[0].fact.value,'off');assert.equal(f.calls-calls,1,'same account resolver checked once at handoff');
 assert.equal(JSON.stringify([f.context.chat,f.context.chatMetadata]),before);assert.doesNotMatch(JSON.stringify(result),/st-user:alice/);f.close();assert.equal(f.listeners(),0);
});
test('same-named foreign chats, forged handles and out-of-window sources cannot be composed',async()=>{
 const a=await fixture(),b=await fixture();
 await assert.rejects(replay([a.steps[0],b.steps[1]],target,{referenceFloors:1}),/同一账户/);
 await assert.rejects(replay([{...a.steps[0],source:{...a.sources[0]}},a.steps[1]],target,{referenceFloors:1}),/未经过/);
 for(const referenceFloors of [0,-1,21,1.5,'1'])await assert.rejects(replay(a.steps,target,{referenceFloors}));
 a.close();b.close();assert.equal(a.listeners()+b.listeners(),0);
});
test('changing an early dependency while the last account check waits invalidates and releases the complete chain',async()=>{
 const f=await fixture();f.hook=async()=>{f.context.chat[0].mes='edited';return 'st-user:alice';};
 await assert.rejects(replay(f.steps,target,{referenceFloors:1}));assert.equal(f.listeners(),0);for(const source of f.sources)assert.throws(source.assertCurrent);
});
test('account switch cancels every borrowed source, and returning to the prior account cannot revive it',async()=>{
 const f=await fixture();f.account='st-user:bob';await assert.rejects(replay(f.steps,target,{referenceFloors:1}));f.account='st-user:alice';assert.equal(f.listeners(),0);for(const source of f.sources)assert.throws(source.assertCurrent);
});

test('a dependency closed before composition also releases the remaining known handles without calling a forged close method',async()=>{
 const f=await fixture();f.sources[0].close();await assert.rejects(replay(f.steps,target,{referenceFloors:1}));assert.equal(f.listeners(),0);
 const g=await fixture();g.steps[0].source={close:()=>assert.fail('unregistered object is not a source')};await assert.rejects(replay(g.steps,target,{referenceFloors:1}));g.close();assert.equal(g.listeners(),0);
});
test('model input is detached before asynchronous checks, while malformed links leave valid scopes available for repair',async()=>{
 const f=await fixture();f.hook=async()=>{f.steps[0].events[0].value='caller edit';return 'st-user:alice';};const result=await replay(f.steps,target,{referenceFloors:1});assert.equal(result.effectiveFacts[0].fact.value,'off');f.close();
 const g=await fixture(),link=g.steps[1].link;g.steps[1].link={...link,toRevisionId:'wrong'};await assert.rejects(replay(g.steps,target,{referenceFloors:1}));assert.equal(g.sources[0].assertCurrent(),true);g.steps[1].link=link;assert.equal((await replay(g.steps,target,{referenceFloors:1})).effectiveFacts.length,1);g.close();
});
