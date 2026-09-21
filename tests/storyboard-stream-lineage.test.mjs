import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardStreamLineage as index} from '../qianmu-storyboard-stream-lineage.js?v=1.59.281';
const copy=value=>JSON.parse(JSON.stringify(value));
const generation=n=>({sentAt:`date-${n}`,startedAt:`generation-${n}`,id:'',activeSentAt:'',activeId:''});
const endpoint=n=>({messageKey:`message-${n}`,swipeId:0,generation:generation(n)});
const reference=n=>({version:1,chatKey:'chat',messageKey:`message-${n}`,swipeId:0,name:'Alice',role:'assistant',baseSendDate:`date-${n}`,baseGenerationId:'',
  revisionHash:'12345678',revisionId:`stream:${String(n).padStart(64,'0')}`,lastKnownFloor:0,createdAt:1,updatedAt:1,
  stream:{version:1,generation:generation(n),generationKey:String(n).padStart(64,'0'),prefixLength:1,prefixHash:'12345678',prefixDigest:'a'.repeat(64)}});
const message=n=>({name:'Alice',send_date:`date-${n}`,gen_started:`generation-${n}`,swipe_id:0,get mes(){assert.fail('metadata index must not read prose');}});
const link=(from,to)=>({version:1,id:String(from).padStart(64,'a'),namespace:'st-user:test',chatKey:'chat',name:'Alice',from:endpoint(from),to:endpoint(to),
  length:Math.max(1,from+1)*10,hash:'12345678',digest:'a'.repeat(64),createdAt:1});

test('a bounded reverse index selects exact ancestor generations, including changed message keys, without reading prose',()=>{
  const links=Array.from({length:32},(_,i)=>link(i,i+1)),scope=index(reference(32),message(32),links,'st-user:test');
  for(const n of [0,16,31,32])assert.equal(scope.matches(reference(n)),true);
  assert.equal(scope.matches(reference(33)),false);assert.equal(scope.namespace,'st-user:test');
  assert.equal(scope.matches({...reference(16),chatKey:'other'}),false);assert.equal(scope.matches({...reference(16),swipeId:1}),false);
  assert.equal(scope.matches({...reference(16),name:'Bob'}),false);assert.equal(scope.matches({...reference(16),role:'user'}),false);
});

test('the metadata-only candidate index is not proof of paid source validity',()=>{
  const rows=[link(0,1)],scope=index(reference(1),message(1),rows);
  assert.equal(scope.matches(reference(0)),true);assert.equal(rows[0].digest,'a'.repeat(64));
  assert.equal(Object.hasOwn(scope,'verified'),false);assert.equal(Object.hasOwn(scope,'source'),false);
});

test('a current endpoint without append history cannot adopt another generation by shared name, text or floor',()=>{
  const scope=index(reference(1),message(1),undefined,'st-user:test');
  assert.equal(scope.matches(reference(1)),true);assert.equal(scope.matches(reference(0)),false);
  const wrong=reference(1);wrong.stream.generation.startedAt='another';assert.equal(scope.matches(wrong),false);
});

test('an existing append chain from a different account is rejected rather than treated as no original budget',()=>{
  assert.throws(()=>index(reference(1),message(1),[link(0,1)],'st-user:other'),{code:'storyboard_stream_lineage'});
  const row=link(0,1);row.chatKey='other-chat';assert.equal(index(reference(1),message(1),[row],'st-user:other').matches(reference(0)),false);
});

test('ambiguous incoming branches, cycles and shrinking append lengths stop without discarding the stored chain',()=>{
  const cases=[[link(0,2),link(1,2)],[link(0,1),link(1,0)],[{...link(0,1),length:100},link(1,2)]];
  for(const rows of cases){const before=copy(rows),n=rows===cases[1]?0:2;
    assert.throws(()=>index(reference(n),message(n),rows,'st-user:test'),{code:'storyboard_stream_lineage'});assert.deepEqual(rows,before);}
});

test('more than 32 continuations and malformed/future ledgers stop instead of evicting or guessing an ancestor',()=>{
  const rows=Array.from({length:33},(_,i)=>link(i,i+1));
  assert.throws(()=>index(reference(33),message(33),rows,'st-user:test'),{code:'storyboard_stream_lineage'});assert.equal(rows.length,33);
  for(const value of [null,{},[{...link(0,1),version:99}],[link(0,1),link(0,1)]])assert.throws(()=>index(reference(1),message(1),value));
});

test('a malformed relevant reference cannot hide behind a generation mismatch, while unrelated keys remain a cheap skip',()=>{
  const scope=index(reference(1),message(1),[link(0,1)],'st-user:test');
  const bad=reference(0);bad.stream.version=99;assert.throws(()=>scope.matches(bad),{code:'storyboard_stream_lineage'});
  bad.messageKey='elsewhere';assert.equal(scope.matches(bad),false);
});

test('an ordinary unfinished generation with no stable timestamps does not acquire old stream provenance',()=>{
  const scope=index({...reference(1),stream:undefined},{name:'Alice',swipe_id:0},undefined,'st-user:test');
  assert.equal(scope.matches(reference(0)),false);assert.equal(scope.matches(reference(1)),false);
});
