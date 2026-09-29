import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureProseAssistantSource} from '../qianmu-prose-assistant-source.js';
import {createProseAssistantSession as create,PROSE_ASSISTANT_SESSION_LIMITS as limits} from '../qianmu-prose-assistant-session.js';
import {validateProseAssistantHistory,PROSE_ASSISTANT_HISTORY_LIMITS} from '../qianmu-prose-assistant-history-contract.js';

async function fixture(namespace='st-user:alice'){
  let live=true;const emitter=new EventEmitter(),context={chatId:'A',characterId:0,characters:[{avatar:'A.png',chat:'A'}],chatMetadata:{},eventSource:emitter,chat:[{mes:'原文'}]};
  const source={getContext:()=>context,epoch:()=>0,resolveNamespace:async()=>namespace,isCurrent:()=>live,readText:m=>m.mes,floor:0};
  const seed=await captureProseAssistantSource(source),key=seed.key;seed.close();const session=create({key,isCurrent:()=>live});
  return {source,context,key,session,set live(value){live=value;},listeners:()=>emitter.eventNames().reduce((n,type)=>n+emitter.listenerCount(type),0)};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const saved=(key,rows)=>({version:1,namespace:key,revision:1,updatedAt:1,rows});
const archived=(id,status='complete')=>({id,user:'旧问题',assistant:status==='complete'?'旧回答':'半截',status,reference:{floor:0,replyId:'swipe:0',mode:'floor',range:{start:0,end:2}}});

test('restored terminal dialogue is detached, immutable in views and does not publish or replay any work',async()=>{
  const f=await fixture('st-user:'+'a'.repeat(64)),initial=saved(f.key,[archived(2),archived(5,'cancelled'),archived(8,'failed')]),notices=[];
  const session=create({key:f.key,isCurrent:()=>true,initialHistory:initial,onChange:value=>notices.push(value)});
  assert.equal(notices.length,0);assert.equal(session.view().busy,false);assert.deepEqual(session.history().turns,[{user:'旧问题',assistant:'旧回答'}]);
  initial.rows[0].user='外部修改';initial.rows[0].reference.range.end=1;assert.equal(session.view().rows[0].user,'旧问题');assert.equal(session.view().rows[0].reference.range.end,2);assert.ok(Object.isFrozen(session.view().rows[0].reference.range));
  let calls=0;await session.run({question:'新问',source:f.source,request:async({context})=>{calls++;assert.deepEqual(context.history,[{user:'旧问题',assistant:'旧回答'}]);return '新答';}});
  const snapshot=session.view();assert.equal(calls,1);assert.equal(snapshot.rows.at(-1).id,9);assert.equal(snapshot.characters,snapshot.rows.reduce((n,row)=>n+row.user.length+row.assistant.length,0));
  assert.deepEqual(snapshot.rows.at(-1).reference,{floor:0,replyId:'swipe:0',mode:'floor',range:{start:0,end:2}});validateProseAssistantHistory(saved(f.key,snapshot.rows),f.key);
  assert.doesNotMatch(JSON.stringify(snapshot.rows),/原文|apiKey/);session.close();f.session.close();
});
test('mismatched, running or malformed saved state is rejected rather than partially adopting another history',async()=>{
  const f=await fixture('st-user:'+'a'.repeat(64)),initial=saved(f.key,[archived(1)]);
  for(const patch of [{namespace:f.key+'wrong'},{rows:[archived(1,'running')]},{rows:[{...archived(1),apiKey:'forbidden'}]},{rows:[archived(1),archived(1)]}])assert.throws(()=>create({key:f.key,isCurrent:()=>true,initialHistory:{...initial,...patch}}));
  f.session.close();
});
test('restored capacity is counted before sending; explicit clear releases rows and exhausted row identifiers',async()=>{
  const f=await fixture('st-user:'+'a'.repeat(64));assert.deepEqual(limits,{turns:PROSE_ASSISTANT_HISTORY_LIMITS.turns,characters:PROSE_ASSISTANT_HISTORY_LIMITS.characters,question:PROSE_ASSISTANT_HISTORY_LIMITS.question,reply:PROSE_ASSISTANT_HISTORY_LIMITS.reply});
  for(const rows of [Array.from({length:limits.turns},(_,i)=>archived(i+1)),[archived(Number.MAX_SAFE_INTEGER)]]){
    const session=create({key:f.key,isCurrent:()=>true,initialHistory:saved(f.key,rows)});let calls=0;
    await assert.rejects(session.run({question:'不会发出',source:f.source,request:async()=>{calls++;return 'bad';}}),{code:'prose_assistant_capacity'});assert.equal(calls,0);
    session.clear();assert.equal(session.view().characters,0);await session.run({question:'新的开始',source:f.source,request:async()=> '新答'});assert.equal(session.view().rows[0].id,1);session.close();
  }f.session.close();
});
test('stopped and pre-request-failed rows remain valid persistence candidates without being treated as completed history',async()=>{
  const f=await fixture('st-user:'+'a'.repeat(64)),entered=deferred(),late=deferred();
  const pending=f.session.run({question:'停止',source:f.source,request:async({onText})=>{onText('部分');entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);await entered.promise;f.session.stop();
  validateProseAssistantHistory(saved(f.key,f.session.view().rows),f.key);assert.equal(f.session.view().rows[0].reference.floor,0);late.resolve('部分迟到');await rejected;
  await assert.rejects(f.session.run({question:'来源失败',source:{...f.source,readText:()=>''},request:async()=>{throw Error('not reached');}}));
  const rows=f.session.view().rows;assert.equal(rows.at(-1).reference,null);assert.equal(rows.at(-1).status,'failed');validateProseAssistantHistory(saved(f.key,rows),f.key);assert.deepEqual(f.session.history().turns,[]);f.session.close();
});
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

test('replacing a question sends only preceding completed turns and commits one replacement with no following turns',async()=>{
  const f=await fixture(),initial=saved(f.key,[archived(1),archived(2,'failed'),{...archived(3),user:'待修改',assistant:'旧第三答'},{...archived(4),user:'后续问题',assistant:'后续答'}]);
  const session=create({key:f.key,isCurrent:()=>true,initialHistory:initial});let requests=0;
  const result=await session.run({replaceId:3,question:'修改后的问题',source:f.source,request:async({context,question,onText})=>{
    requests++;assert.equal(question,'修改后的问题');assert.deepEqual(context.history,[{user:'旧问题',assistant:'旧回答'}]);
    onText('新');assert.deepEqual(session.view().rows.map(row=>row.id),[1,2,3]);assert.equal(session.view().rows.at(-1).status,'running');
    assert.throws(()=>validateProseAssistantHistory(saved(f.key,session.view().rows),f.key));return '新回答';
  }});
  assert.equal(requests,1);assert.equal(result.id,3);assert.equal(result.status,'complete');
  assert.deepEqual(session.history().turns,[{user:'旧问题',assistant:'旧回答'},{user:'修改后的问题',assistant:'新回答'}]);
  assert.equal(session.view().characters,session.view().rows.reduce((size,row)=>size+row.user.length+row.assistant.length,0));
  validateProseAssistantHistory(saved(f.key,session.view().rows),f.key);
  await session.run({question:'新的追问',source:f.source,request:async()=> '新追问答案'});assert.equal(session.view().rows.at(-1).id,5);
  assert.deepEqual(initial.rows.map(row=>row.id),[1,2,3,4]);session.close();f.session.close();
});

test('failed replacement restores the entire original conversation instead of saving a partial replacement',async()=>{
  const requests=[async({onText})=>{onText('部分');throw Error('private upstream failure');},async()=>'',async()=> '\ud800',async({onText})=>{onText('前缀');return '不连续';}];
  for(const request of requests){
    const f=await fixture(),session=create({key:f.key,isCurrent:()=>true,initialHistory:saved(f.key,[archived(1),archived(2),archived(3)])}),before=session.view();let calls=0;
    await assert.rejects(session.run({replaceId:2,question:'改问',source:f.source,request:options=>{calls++;return request(options);}}));
    assert.equal(calls,1);assert.deepEqual(session.view(),before);validateProseAssistantHistory(saved(f.key,session.view().rows),f.key);assert.equal(f.listeners(),0);session.close();f.session.close();
  }
});

test('stopping replacement restores original rows immediately and its late callback cannot overwrite a newer question',async()=>{
  const f=await fixture(),session=create({key:f.key,isCurrent:()=>true,initialHistory:saved(f.key,[archived(1),archived(2),archived(3)])}),before=session.view(),entered=deferred(),late=deferred();let oldText,oldSignal;
  const pending=session.run({replaceId:2,question:'重试此轮',source:f.source,request:async({onText,signal})=>{oldText=onText;oldSignal=signal;onText('部分重写');entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);
  await entered.promise;assert.equal(session.stop(),true);assert.equal(oldSignal.aborted,true);assert.deepEqual(session.view(),before);
  validateProseAssistantHistory(saved(f.key,session.view().rows),f.key);assert.equal(f.listeners(),0);
  await session.run({question:'继续原会话',source:f.source,request:async({context})=>{assert.equal(context.history.length,3);return '继续的回答';}});
  const current=session.view();assert.throws(()=>oldText('部分重写迟到'));late.resolve('部分重写迟到');await rejected;assert.deepEqual(session.view(),current);assert.equal(current.rows.at(-1).id,4);session.close();f.session.close();
});

test('replacement validates its target before sending and counts capacity after the chosen truncation point',async()=>{
  const f=await fixture(),rows=Array.from({length:limits.turns},(_,index)=>archived(index+1)),session=create({key:f.key,isCurrent:()=>true,initialHistory:saved(f.key,rows)}),before=session.view();let calls=0;
  for(const replaceId of [0,-1,1.5,'1',null,limits.turns+1])await assert.rejects(session.run({replaceId,question:'改问',source:f.source,request:async()=>{calls++;return '不应发送';}}),{code:'prose_assistant_input'});
  assert.equal(calls,0);assert.deepEqual(session.view(),before);
  await session.run({replaceId:limits.turns,question:'最后一轮重新生成',source:f.source,request:async()=>{calls++;return '新答';}});assert.equal(calls,1);assert.equal(session.view().rows.length,limits.turns);
  await session.run({replaceId:1,question:'重写首问',source:f.source,request:async({context})=>{assert.deepEqual(context.history,[]);return '只留新首答';}});assert.equal(session.view().rows.length,1);session.close();f.session.close();
});

test('stopped replacement before source capture restores original history without sending or leaking listeners',async()=>{
  const f=await fixture(),session=create({key:f.key,isCurrent:()=>true,initialHistory:saved(f.key,[archived(1),archived(2)])}),before=session.view(),entered=deferred(),identity=deferred();let calls=0;
  const pending=session.run({replaceId:1,question:'改问',source:{...f.source,resolveNamespace:()=>{entered.resolve();return identity.promise;}},request:async()=>{calls++;return '不应发出';}}),rejected=assert.rejects(pending);
  await entered.promise;session.stop();assert.deepEqual(session.view(),before);assert.equal(f.listeners(),0);identity.resolve('st-user:alice');await rejected;assert.equal(calls,0);assert.deepEqual(session.view(),before);session.close();f.session.close();
});

test('source invalidation during replacement publishes no rollback or late private snapshots',async()=>{
  const f=await fixture(),seen=[],entered=deferred(),late=deferred();let live=true;
  const session=create({key:f.key,isCurrent:()=>live,initialHistory:saved(f.key,[archived(1),archived(2)]),onChange:value=>seen.push(value)});
  const pending=session.run({replaceId:1,question:'改问',source:f.source,request:async()=>{entered.resolve();return late.promise;}}),rejected=assert.rejects(pending);
  await entered.promise;const before=seen.length;live=false;late.resolve('迟到');await rejected;assert.equal(seen.length,before);assert.throws(session.view);assert.equal(f.listeners(),0);f.session.close();
});

test('editing an assistant reply changes only that text and preserves later turns without a model request',async()=>{
  const f=await fixture(),session=create({key:f.key,isCurrent:()=>true,initialHistory:saved(f.key,[archived(1),archived(2),archived(3)])}),before=session.view();
  const result=session.editReply(2,'手动修改的回答');assert.equal(result.rows.length,3);assert.deepEqual(result.rows[0],before.rows[0]);assert.deepEqual(result.rows[2],before.rows[2]);
  assert.equal(result.rows[1].user,before.rows[1].user);assert.equal(result.rows[1].assistant,'手动修改的回答');assert.equal(result.characters,before.characters-'旧回答'.length+'手动修改的回答'.length);
  assert.throws(()=>session.editReply(2,''));assert.throws(()=>session.editReply(99,'未知'));validateProseAssistantHistory(saved(f.key,session.view().rows),f.key);session.close();f.session.close();
});
