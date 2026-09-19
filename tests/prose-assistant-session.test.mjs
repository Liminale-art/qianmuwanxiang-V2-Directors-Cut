import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureProseAssistantSource} from '../qianmu-prose-assistant-source.js';
import {createProseAssistantSession as create,PROSE_ASSISTANT_SESSION_LIMITS as limits} from '../qianmu-prose-assistant-session.js';

async function fixture(){
  let live=true;const emitter=new EventEmitter(),context={chatId:'A',characterId:0,characters:[{avatar:'A.png',chat:'A'}],chatMetadata:{},eventSource:emitter,chat:[{mes:'原文'}]};
  const source={getContext:()=>context,epoch:()=>0,resolveNamespace:async()=>'st-user:alice',isCurrent:()=>live,readText:m=>m.mes,floor:0};
  const seed=await captureProseAssistantSource(source),key=seed.key;seed.close();const session=create({key,isCurrent:()=>live});
  return {source,context,key,session,set live(value){live=value;},listeners:()=>emitter.eventNames().reduce((n,type)=>n+emitter.listenerCount(type),0)};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('only complete explicit questions join separate history and streaming snapshots remain read-only',async()=>{
  const f=await fixture();let requests=0;
  await f.session.run({question:'为什么？',source:f.source,request:async({onText,context})=>{requests++;assert.equal(context.history.length,0);onText('答');assert.equal(f.session.history().turns.length,0);return '答案';}});
  assert.equal(requests,1);assert.deepEqual(f.session.history().turns,[{user:'为什么？',assistant:'答案'}]);assert.ok(Object.isFrozen(f.session.view().rows[0]));
  await f.session.run({question:'继续',source:f.source,request:async({context})=>{assert.equal(context.history[0].assistant,'答案');return '第二答';}});
  assert.equal(f.session.view().rows.length,2);assert.equal(f.listeners(),0);assert.deepEqual(f.context.chat,[{mes:'原文'}]);f.session.close();
});
test('one active request, explicit stop and delayed callbacks cannot overwrite a newer reply',async()=>{
  const f=await fixture(),entered=deferred(),late=deferred();let oldText,oldSignal;
  const pending=f.session.run({question:'旧',source:f.source,request:async({onText,signal})=>{oldText=onText;oldSignal=signal;onText('部分');entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);
  await entered.promise;await assert.rejects(f.session.run({question:'busy',source:f.source,request:()=>''}),{code:'prose_assistant_busy'});
  assert.equal(f.session.stop(),true);assert.equal(oldSignal.aborted,true);assert.equal(f.session.history().turns.length,0);assert.equal(f.session.view().rows[0].assistant,'部分');
  await f.session.run({question:'新',source:f.source,request:async()=> '新回复'});assert.throws(()=>oldText('部分迟到'));late.resolve('部分迟到');await rejected;
  assert.deepEqual(f.session.history().turns,[{user:'新',assistant:'新回复'}]);assert.equal(f.listeners(),0);f.session.close();
});
test('failed responses retain partial text for copying but never request raw errors or failed pairs in history',async()=>{
  const f=await fixture();await assert.rejects(f.session.run({question:'Q',source:f.source,request:async({onText})=>{onText('半截');throw new Error('secret credential URL');}}));
  assert.equal(f.session.view().rows[0].status,'failed');assert.equal(f.session.view().rows[0].assistant,'半截');assert.doesNotMatch(JSON.stringify(f.session.view()),/secret|credential/);assert.equal(f.session.history().turns.length,0);assert.equal(f.listeners(),0);f.session.close();
});
test('source mismatch, edited references, page changes and clear during a request cannot publish a completed pair',async()=>{
  for(const change of [f=>{f.context.chat[0].mes='edited';},f=>{f.live=false;},f=>f.session.clear()]){
    const f=await fixture(),entered=deferred(),late=deferred();const pending=f.session.run({question:'Q',source:f.source,request:async()=>{entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);
    await entered.promise;change(f);late.resolve('迟到');await rejected;assert.equal(f.listeners(),0);f.session.close();
  }
  const f=await fixture(),wrong=create({key:f.key+'other',isCurrent:()=>true});let called=false;
  await assert.rejects(wrong.run({question:'Q',source:f.source,request:async()=>{called=true;return 'A';}}),{code:'prose_assistant_context'});assert.equal(called,false);assert.equal(f.listeners(),0);wrong.close();f.session.close();
});
test('reply limits, discontinuous snapshots, empty or malformed final output fail without automatic retries',async()=>{
  for(const request of [async()=>'',async()=> '\ud800',async()=> 'x'.repeat(limits.reply+1),async({onText})=>{onText('original');return 'replacement';}]){
    const f=await fixture();await assert.rejects(f.session.run({question:'Q',source:f.source,request}));assert.equal(f.session.history().turns.length,0);assert.equal(f.listeners(),0);f.session.close();
  }
  const f=await fixture();await assert.rejects(f.session.run({question:'x'.repeat(limits.question+1),source:f.source,request:async()=> 'A'}));assert.equal(f.session.view().rows.length,0);f.session.close();
});
test('closing releases pending context, aborts transport and makes private history inaccessible',async()=>{
  const f=await fixture(),entered=deferred(),late=deferred();let signal;
  const pending=f.session.run({question:'Q',source:f.source,request:async options=>{signal=options.signal;entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);
  await entered.promise;f.session.close();assert.equal(signal.aborted,true);assert.equal(f.listeners(),0);assert.throws(f.session.history);assert.throws(f.session.view);late.resolve('late');await rejected;
});

test('conversation capacity is explicit rather than silently dropping old messages, and user clear resets it',async()=>{
  const f=await fixture();for(let i=0;i<limits.turns;i++)await f.session.run({question:'Q'+i,source:f.source,request:async()=> 'A'});
  let called=false;await assert.rejects(f.session.run({question:'extra',source:f.source,request:async()=>{called=true;return 'A';}}),{code:'prose_assistant_capacity'});
  assert.equal(called,false);assert.equal(f.session.view().rows[0].user,'Q0');f.session.clear();assert.equal(f.session.view().characters,0);
  await f.session.run({question:'new',source:f.source,request:async()=> 'new'});assert.equal(f.session.history().turns.length,1);f.session.close();
});
test('invalidated page receives no old private snapshots during cancellation or delayed completion',async()=>{
  const f=await fixture(),seen=[],entered=deferred(),late=deferred();let live=true;
  const session=create({key:f.key,isCurrent:()=>live,onChange:snapshot=>seen.push(snapshot)});
  const pending=session.run({question:'private',source:f.source,request:async()=>{entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);
  await entered.promise;const before=seen.length;live=false;late.resolve('late');await rejected;assert.equal(seen.length,before);assert.throws(session.history);assert.equal(f.listeners(),0);f.session.close();
});

test('stop also releases source listeners while account resolution is still pending, before any request exists',async()=>{
  const f=await fixture(),entered=deferred(),identity=deferred();let called=false;
  const pending=f.session.run({question:'Q',source:{...f.source,resolveNamespace:()=>{entered.resolve();return identity.promise;}},request:async()=>{called=true;return 'A';}}),rejected=assert.rejects(pending);
  await entered.promise;assert.ok(f.listeners()>0);f.session.stop();assert.equal(f.listeners(),0);identity.resolve('st-user:alice');await rejected;assert.equal(called,false);f.session.close();
});
