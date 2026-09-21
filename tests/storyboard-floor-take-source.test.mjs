import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardMessageReference as reference} from '../qianmu-storyboard.js';
import {captureStoryboardContinuation,saveStoryboardContinuation} from '../qianmu-storyboard-continuation.js';
import {stageStoryboardContinuationLinks} from '../qianmu-storyboard-continuation-proof.js?v=1.59.287';
import {readStoryboardFloorTakeSourceKeys as read} from '../qianmu-storyboard-floor-take-source.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve};};
async function fixture(count=1){
  const message={mes:'Alice cooks.\n\n',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0};
  const host={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],chatMetadata:{story_director_liminale:{}},chat:[message]};
  const namespace='st-user:retake',refs=[reference({message,chatKey:'chat',floor:0})];
  const options={type:'continue',getContext:()=>host,epoch:()=>0,createReference:reference};
  for(let index=0;index<count;index++){
    const handle=captureStoryboardContinuation(options);
    message.mes+=`Bob brings bowl ${index}.\n\n`;message.send_date=`day-${index+2}`;message.gen_started=`generation-${index+2}`;
    message.swipe_info=[{send_date:message.send_date,gen_started:message.gen_started,extra:{}}];
    try{await saveStoryboardContinuation(handle,async()=>namespace,host.chatMetadata.story_director_liminale,async()=>{});}finally{handle.close();}
    refs.push(reference({message,chatKey:'chat',floor:0}));
  }
  let current=true;
  const api={chatKey:()=>host.chatId,metadata:()=>host.chatMetadata,namespace:async()=>namespace};
  return {host,message,refs,api,namespace,invalidate(){current=false;},read:()=>read(0,message,api,namespace,()=>current)};
}

test('ordinary retake source needs no extra account query or metadata write; corrupt persisted history is not reset',async()=>{
  const f=await fixture(0),before=copy(f.host);f.api.namespace=()=>assert.fail('ordinary source must not add account I/O');
  assert.deepEqual(await f.read(),[f.refs[0].messageKey]);assert.deepEqual(f.host,before);
  f.host.chatMetadata.story_director_liminale.storyboardContinuations={version:99};
  await assert.rejects(f.read());assert.deepEqual(f.host.chatMetadata.story_director_liminale.storyboardContinuations,{version:99});
});

test('multiple saved continuations return detached current-first keys after JSON restoration without rewriting sources',async()=>{
  const f=await fixture(2);f.host.chatMetadata=copy(f.host.chatMetadata);const before=copy(f.host);
  const keys=await f.read();assert.deepEqual(keys,[f.refs[2].messageKey,f.refs[0].messageKey,f.refs[1].messageKey]);
  keys[0]='caller edit';assert.deepEqual(await f.read(),[f.refs[2].messageKey,f.refs[0].messageKey,f.refs[1].messageKey]);assert.deepEqual(f.host,before);
});

test('a pending continuation save cannot be treated as an unrelated ordinary key, whether or not old links exist',async()=>{
  for(const count of [0,1]){
    const f=await fixture(count),store=f.host.chatMetadata.story_director_liminale,before=copy(store);
    const finish=stageStoryboardContinuationLinks(store,store.storyboardContinuations||[]);
    try{await assert.rejects(f.read(),{code:'storyboard_retake_source'});}finally{finish(false);}
    assert.deepEqual(store,before);assert.ok((await f.read()).length>0);
  }
});

test('account, source, generation, metadata or ownership changing during final identity lookup cancels without writes',async()=>{
  for(const change of ['account','text','generation','metadata','links','current']){
    const f=await fixture(),started=deferred(),gate=deferred();
    f.api.namespace=async()=>{started.resolve();return gate.promise;};
    const pending=f.read(),rejection=assert.rejects(pending,{code:'storyboard_retake_source'});await started.promise;
    if(change==='text')f.message.mes+='new content';
    if(change==='generation')f.message.gen_started='another';
    if(change==='metadata')f.host.chatMetadata=copy(f.host.chatMetadata);
    if(change==='links')f.host.chatMetadata.story_director_liminale.storyboardContinuations=[];
    if(change==='current')f.invalidate();
    const before=copy(f.host);gate.resolve(change==='account'?'st-user:other':f.namespace);await rejection;assert.deepEqual(f.host,before);
  }
});

test('a new provisional save appearing during source verification cannot broaden a retake',async()=>{
  const f=await fixture(),started=deferred(),gate=deferred();f.api.namespace=async()=>{started.resolve();return gate.promise;};
  const pending=f.read(),rejection=assert.rejects(pending,{code:'storyboard_retake_source'});await started.promise;
  const store=f.host.chatMetadata.story_director_liminale,finish=stageStoryboardContinuationLinks(store,copy(store.storyboardContinuations));
  gate.resolve(f.namespace);try{await rejection;}finally{finish(false);}
  assert.equal((await f.read()).length,2);
});

test('prefix edits and forged SHA or bridge identity fail before final account I/O',async()=>{
  for(const field of ['text','hash','digest','id']){
    const f=await fixture(),link=f.host.chatMetadata.story_director_liminale.storyboardContinuations[0];
    f.api.namespace=()=>assert.fail('bad proof must fail first');
    if(field==='text')f.message.mes=f.message.mes.replace('Alice','Carol');else link[field]='a'.repeat(field==='hash'?8:64);
    await assert.rejects(f.read(),{code:field==='hash'?'storyboard_continuation':'storyboard_retake_source'});
  }
});
