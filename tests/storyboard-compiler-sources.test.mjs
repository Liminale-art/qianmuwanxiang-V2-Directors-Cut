import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureStoryboardCompilerSources as capture} from '../qianmu-storyboard-compiler-sources.js';
import {replayLiveStoryboardContinuity} from '../qianmu-storyboard-continuity-source.js';

function fixture(texts=['earlier','A脱下外套。','A继续聊天。']) {
  const emitter=new EventEmitter();emitter.setMaxListeners(200);
  const context={chatId:'chat',characterId:0,characters:[{avatar:'A.png',chat:'chat'}],chatMetadata:{story_director_liminale:{}},eventSource:emitter,
    chat:texts.map((mes,index)=>({mes,name:'A',swipe_id:0,send_date:String(index),is_user:index===1}))};
  let revision=0,account='st-user:alice',current=true,lookup=null;
  const reads=[];
  const options={floor:texts.length-1,referenceFloors:1,getContext:()=>context,epoch:()=>revision,
    resolveNamespace:async()=>lookup?lookup():account,isCurrent:()=>current,
    readText:(message,floor)=>{reads.push(floor);return message.mes;},
    readParagraphs:message=>message.mes.split('\n\n').filter(Boolean).map((text,index)=>({id:`P${index+1}`,text}))};
  return {context,emitter,options,reads,listenerCount:()=>emitter.eventNames().reduce((sum,type)=>sum+emitter.listenerCount(type),0),
    set account(value){account=value;},set current(value){current=value;},set lookup(value){lookup=value;},bump:()=>revision++};
}
function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {resolve,promise};}

test('runtime window keeps complete selected raw floors including USER and exposes authentic replay sources without writing ST',async()=>{
  const f=fixture(),before=JSON.stringify([f.context.chat,f.context.chatMetadata]),window=await capture(f.options);
  assert.deepEqual(f.reads,[1,2]);assert.deepEqual(window.messages.map(row=>[row.floor,row.role]),[[1,'user'],[2,'character']]);
  assert.deepEqual(window.paragraphs,['A继续聊天。']);assert.equal(JSON.stringify([f.context.chat,f.context.chatMetadata]),before);assert.ok(Object.isFrozen(window.messages[0]));
  const [previous,current]=window.sources,roster={branches:[{id:'now',layer:'present'}],subjectIds:['A']};
  const result=await replayLiveStoryboardContinuity([
    {source:previous,roster,branchId:'now',link:null,events:[{id:'coat',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value:'off',persistence:'persistent',evidence:'A脱下外套。'}]},
    {source:current,roster,branchId:'now',events:[],link:{relation:'continuous',fromRevisionId:previous.messageRef.revisionId,toRevisionId:current.messageRef.revisionId,
      fromBranchId:'now',toBranchId:'now',evidence:{paragraphId:'P1',quote:'A继续聊天。'},facts:[{sourceFloor:1,sourceRevisionId:previous.messageRef.revisionId,eventId:'coat',subjectId:'A'}]}},
  ],{branchId:'now',paragraphId:'P1',evidence:'A继续聊天。'},{referenceFloors:1});
  assert.equal(result.effectiveFacts[0].fact.value,'off');window.close();assert.equal(f.listenerCount(),0);await assert.rejects(window.guard(),{code:'storyboard_input_changed'});
});

test('zero reference floors never reads earlier prose; highest supported window never scans beyond 21 floors',async()=>{
  for(const count of [0,20]){
    const f=fixture(Array.from({length:300},(_,index)=>'text '+index));f.options.referenceFloors=count;
    const window=await capture(f.options);assert.equal(window.messages.length,count+1);assert.deepEqual(f.reads,Array.from({length:count+1},(_,index)=>299-count+index));window.close();assert.equal(f.listenerCount(),0);
  }
});

test('invalid ranges do not read sources or register listeners',async()=>{
  for(const value of [-1,21,1.5,'2',NaN]){const f=fixture();await assert.rejects(capture({...f.options,referenceFloors:value}),{code:'storyboard_context_unavailable'});assert.deepEqual(f.reads,[]);assert.equal(f.listenerCount(),0);}
});

test('blank/system floors retain their places but are excluded from outbound context and cannot silently become new input',async()=>{
  const f=fixture(['hidden','','visible']);f.options.referenceFloors=2;f.context.chat[0].is_system=true;
  const window=await capture(f.options);assert.deepEqual(window.messages.map(row=>row.floor),[2]);assert.deepEqual(f.reads,[1,2]);
  f.context.chat[0].is_system=false;assert.throws(window.assertCurrent,{code:'storyboard_input_changed'});assert.equal(f.listenerCount(),0);
});

test('edit-and-restore invalidates any selected floor, including a blank one, but unrelated edits do not',async()=>{
  const f=fixture(['outside','','visible']),window=await capture(f.options);
  f.emitter.emit('message_edited',0);assert.equal(window.assertCurrent(),true);
  f.context.chat[1].mes='temporary';f.emitter.emit('message_edited',1);f.context.chat[1].mes='';
  assert.throws(window.assertCurrent,{code:'storyboard_input_changed'});assert.equal(f.listenerCount(),0);
});

for(const [label,change] of [
  ['prior text',f=>f.context.chat[1].mes='changed'],['prior swipe',f=>f.context.chat[1].swipe_id++],
  ['prior identity',f=>f.context.chat[1].name='someone else'],['replaced floor',f=>f.context.chat[1]={...f.context.chat[1]}],
  ['chat metadata',f=>f.context.chatMetadata={}],['source epoch',f=>f.bump()],['owner lifecycle',f=>f.current=false],
  ['changed-and-restored chat',f=>f.emitter.emit('chat_changed','another')],['delete event',f=>f.emitter.emit('message_deleted',2)],
])test(`${label} cancels the whole borrowed compiler window and releases all sources`,async()=>{
  const f=fixture(),window=await capture(f.options);change(f);assert.throws(window.assertCurrent,{code:'storyboard_input_changed'});
  assert.equal(f.listenerCount(),0);for(const source of window.sources)assert.throws(source.assertCurrent);
});

test('account change while final handoff waits cancels every source; old account cannot revive it',async()=>{
  const f=fixture(),window=await capture(f.options),wait=deferred();f.lookup=()=>wait.promise;
  const pending=window.guard();wait.resolve('st-user:bob');await assert.rejects(pending,{code:'storyboard_input_changed'});
  f.lookup=null;assert.equal(f.listenerCount(),0);await assert.rejects(window.guard());
});

test('captures cannot mix owners when simultaneous account reads disagree',async()=>{
  const f=fixture();let calls=0;f.lookup=async()=>++calls===1?'st-user:alice':'st-user:bob';
  await assert.rejects(capture(f.options),{code:'storyboard_input_changed'});assert.equal(f.listenerCount(),0);
});

test('all selected edit listeners are present before the first account lookup resolves',async()=>{
  const f=fixture(),wait=deferred();f.lookup=()=>wait.promise;
  const pending=capture(f.options);f.emitter.emit('message_edited',1);wait.resolve('st-user:alice');
  await assert.rejects(pending,{code:'storyboard_input_changed'});assert.equal(f.listenerCount(),0);
});

test('failed or cancelled capture drains late successes and leaves no temporary listeners',async()=>{
  for(const abort of [false,true]){
    const f=fixture(),wait=deferred(),controller=new AbortController();f.options.signal=controller.signal;
    f.lookup=()=>wait.promise;
    if(!abort)f.options.readParagraphs=(message,floor)=>floor===1?[]:[{id:'P1',text:message.mes}];
    const pending=capture(f.options);if(abort)controller.abort();wait.resolve('st-user:alice');
    await assert.rejects(pending);assert.equal(f.listenerCount(),0);
  }
});

test('oversize source fails visibly instead of clipping, while long allowed prose preserves its tail',async()=>{
  const f=fixture(['a','b','甲'.repeat(199990)+'末尾拿起杯子。']),window=await capture(f.options);
  assert.equal(window.messages.at(-1).text,f.context.chat[2].mes);assert.equal(window.paragraphs[0],f.context.chat[2].mes);window.close();
  const big=fixture(['a','b','x'.repeat(200001)]);await assert.rejects(capture(big.options),{code:'storyboard_input_capacity'});assert.equal(big.listenerCount(),0);
});

test('concurrent floors share only active account requests and later checks always read the account again',async()=>{
  const f=fixture(Array.from({length:21},()=> 'text'));f.options.referenceFloors=20;let calls=0;
  f.lookup=async()=>{calls++;return 'st-user:alice';};const window=await capture(f.options);
  assert.equal(calls,3,'capture, capture recheck, window handoff');await window.guard();assert.equal(calls,4);window.close();
});

test('empty target is not replaced by an older nonempty floor',async()=>{
  const f=fixture(['a','b','']);await assert.rejects(capture(f.options),{code:'storyboard_context_unavailable'});assert.deepEqual(f.reads,[1,2]);assert.equal(f.listenerCount(),0);
});
