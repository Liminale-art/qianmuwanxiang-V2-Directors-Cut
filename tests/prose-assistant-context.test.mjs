import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureProseAssistantContext as capture,PROSE_ASSISTANT_CONTEXT_LIMITS as limits} from '../qianmu-prose-assistant-context.js';

function fixture(){
  const emitter=new EventEmitter(),reads=[],context={chatId:'A',characterId:0,characters:[{avatar:'A.png',chat:'A'}],chatMetadata:{},eventSource:emitter,
    chat:Array.from({length:12},(_,i)=>({mes:`正文${i}`,is_user:i%2===0}))};
  const options={getContext:()=>context,epoch:()=>0,resolveNamespace:async()=>'st-user:alice',isCurrent:()=>true,floor:8,range:{start:0,end:2},
    readText:(message,floor)=>{reads.push(floor);return message.mes;}};
  return {context,options,reads,listeners:()=>emitter.eventNames().reduce((n,type)=>n+emitter.listenerCount(type),0)};
}
test('bounded context includes only selected text, preceding window and chronological pairs; no future or world material',async()=>{
  const f=fixture(),s=await capture(f.options);assert.deepEqual(f.reads,[8,7,6]);assert.equal(s.reference.text,'正文');
  assert.deepEqual(s.previous.map(r=>[r.floor,r.role]),[[6,'user'],[7,'character']]);assert.deepEqual(s.summary.previousWindow,{start:6,end:8});
  assert.doesNotMatch(JSON.stringify(s),/正文8|正文9|正文5/);assert.ok(Object.isFrozen(s.summary.previousIncluded));s.close();assert.equal(f.listeners(),0);
});
test('system and empty floors are omitted explicitly without extending the authorized window',async()=>{
  const f=fixture();f.context.chat[7].is_system=true;f.context.chat[6].mes=' ';const s=await capture(f.options);
  assert.deepEqual(f.reads,[8,6]);assert.equal(s.previous.length,0);assert.deepEqual(s.summary.previousOmitted,[{floor:6,reason:'empty'},{floor:7,reason:'system'}]);s.close();
  const zero=await capture({...f.options,previousFloors:0});assert.equal(zero.previous.length,0);zero.close();
});
test('previous text budgets prefer nearer complete floors, report omissions, and never split source text',async()=>{
  const f=fixture();f.context.chat[7].mes='x'.repeat(limits.previousCharacters);const s=await capture(f.options);
  assert.equal(s.previous.length,1);assert.equal(s.previous[0].text.length,limits.previousCharacters);assert.deepEqual(s.summary.previousOmitted,[{floor:6,reason:'budget'}]);s.close();
});
test('history uses same-chat complete pairs, takes recent twelve messages, and retains no unrelated fields',async()=>{
  const f=fixture(),seed=await capture(f.options),key=seed.key;seed.close();
  const turns=Array.from({length:9},(_,i)=>({user:`问题${i}`,assistant:`回复${i}`,apiKey:'never-retain'}));
  const s=await capture({...f.options,history:{key,turns}});assert.equal(s.history.length,6);assert.equal(s.history[0].user,'问题3');assert.equal(s.summary.historyOmitted,3);assert.doesNotMatch(JSON.stringify(s),/never-retain|apiKey/);s.close();
  turns.at(-1).assistant='x'.repeat(limits.historyCharacters);const oversized=await capture({...f.options,history:{key,turns}});assert.equal(oversized.history.length,0);assert.equal(oversized.summary.historyOmitted,9);oversized.close();
  for(const history of [{key:'another',turns},{key,turns:[{user:'question'}]}]){await assert.rejects(capture({...f.options,history}));assert.equal(f.listeners(),0);}
});
test('editing or swapping preceding references invalidates pending work, including while account guard is awaiting',async()=>{
  for(const change of [f=>{f.context.chat[7].mes='edited';},f=>{f.context.chat[7].swipe_id=2;},f=>{f.context.chat[7].is_user=true;},f=>{f.context.chat[7].is_system=true;},f=>{f.context.chat[7]={...f.context.chat[7]};}]){
    const f=fixture(),s=await capture(f.options);change(f);await assert.rejects(s.guard());assert.equal(f.listeners(),0);assert.throws(s.assertCurrent);
  }
  const f=fixture();let resolve,delayed=false;const s=await capture({...f.options,resolveNamespace:()=>delayed?new Promise(r=>{resolve=r;}):Promise.resolve('st-user:alice')});
  delayed=true;const task=s.guard();f.context.chat[6].mes='changed';resolve('st-user:alice');await assert.rejects(task);assert.equal(f.listeners(),0);
});
test('malformed reader results and invalid bounds fail closed; snapshots survive caller history mutations',async()=>{
  for(const patch of [{previousFloors:-1},{previousFloors:9},{readText:(m,i)=>i===7?'\ud800':m.mes}]){const f=fixture();await assert.rejects(capture({...f.options,...patch}));assert.equal(f.listeners(),0);}
  const f=fixture(),seed=await capture(f.options),history={key:seed.key,turns:[{user:'Q',assistant:'A'}]};seed.close();
  const s=await capture({...f.options,history});history.turns[0].assistant='mutated';assert.equal(s.history[0].assistant,'A');s.close();
});

test('late changes to caller history cannot rewrite the already captured reference summary',async()=>{
  const f=fixture(),seed=await capture(f.options),history={key:seed.key,turns:[{user:'Q',assistant:'A'}]};seed.close();let previousRead=false;
  const s=await capture({...f.options,history,readText:(message,floor)=>{if(floor<8)previousRead=true;return f.options.readText(message,floor);},resolveNamespace:async()=>{if(previousRead)history.turns.length=0;return 'st-user:alice';}});
  assert.equal(s.history.length,1);assert.equal(s.summary.historyPairs,1);assert.equal(s.summary.historyOmitted,0);s.close();
});
