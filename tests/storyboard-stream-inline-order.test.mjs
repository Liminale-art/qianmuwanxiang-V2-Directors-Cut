import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../qianmu-storyboard.js';
import {storyboardStreamGeneration,storyboardStreamGenerationInput,storyboardStreamDigest,storyboardStreamFingerprint} from '../qianmu-storyboard-stream-reference.js?v=1.59.373';

const copy=value=>JSON.parse(JSON.stringify(value));
const ids=rows=>rows.map(row=>row.id);
const sort=core.sortStoryboardInlineRecords;
async function fixture(){
  const message={mes:'Alice arrives. Bob pours tea.\n\nThey remember the old house.\n\nThe kettle sings.',
    name:'Alice',send_date:'2026-09-21T03:00:00Z',gen_started:'generation-a',swipe_id:0};
  const chat=[message],chatKey='chat-a';
  const base=core.createStoryboardMessageReference({message,chatKey,floor:0,now:1});
  const generation=storyboardStreamGeneration(message),generationKey=await storyboardStreamDigest(storyboardStreamGenerationInput(base,generation));
  const text=message.mes,prefixHash=storyboardStreamFingerprint(text);
  const reference={...base,revisionId:`stream:${generationKey}`,revisionHash:prefixHash,stream:{version:1,generation,generationKey,
    prefixLength:text.length,prefixHash,prefixDigest:await storyboardStreamDigest(text)}};
  const record=(id,shotIndex,{paragraph=1,start=0,end=start+1,...extra}={})=>{
    const quote=text.split('\n\n')[paragraph-1]?.slice(start,end)||'x';
    const messageRef={...copy(reference),stream:{...copy(reference.stream),moment:{version:1,paragraphId:`P${paragraph}`,branchId:'present',layer:'present',
      quote,subject:`subject-${shotIndex}`,start,end:start+quote.length,insertAfter:`P${paragraph}`,sourceIds:[`P${paragraph}`]}}};
    return {id,chatKey,floor:0,swipeId:0,messageHash:`completion-${id}`,messageRef,createdAt:1000,imageIndex:0,
      inlineOrder:{version:1,batchId:`stream-${generationKey}`,batchStartedAt:100,shotIndex,requestIndex:1},...extra};
  };
  return {message,chat,chatKey,reference,record};
}

test('terminal supplements return to prose positions across paragraphs and within a paragraph, regardless of arrival order',async()=>{
  const f=await fixture(),middle=f.record('middle',0,{start:15}),last=f.record('last',1,{paragraph:3}),first=f.record('first',2),flashback=f.record('flashback',3,{paragraph:2});
  flashback.messageRef.stream.moment.layer='flashback';flashback.messageRef.stream.moment.branchId='past';
  const rows=Object.freeze([Object.freeze(last),Object.freeze(middle),Object.freeze(first),Object.freeze(flashback)]);
  assert.deepEqual(ids(sort(rows)),['first','middle','flashback','last']);
  assert.deepEqual(ids(sort([...rows].reverse())),['first','middle','flashback','last']);
  assert.deepEqual(ids(rows),['last','middle','first','flashback']);
});

test('stream retry and redraw variants remain adjacent despite different whole-message hashes at delivery',async()=>{
  const f=await fixture(),later=f.record('later',0,{start:15}),earlier=f.record('earlier',1),retry=copy(earlier);
  retry.id='retry';retry.messageHash='longer-final-text';retry.createdAt=2000;
  assert.deepEqual(ids(sort([retry,later,earlier])),['earlier','retry','later']);
  const variant=copy(earlier);variant.id='variant';variant.inlineOrder.requestIndex=2;
  assert.deepEqual(ids(sort([later,variant,retry,earlier])),['earlier','retry','variant','later']);
});

test('same-position subjects use frozen shot order and keep multiple outputs with their subject',async()=>{
  const f=await fixture(),a=f.record('a',0),b=f.record('b',1),second={...copy(a),id:'a-output-2',imageIndex:1};
  assert.deepEqual(ids(sort([b,second,a])),['a','a-output-2','b']);
});

test('an incomplete, inconsistent or malformed stream bucket keeps stable submission order without comparator cycles',async()=>{
  const f=await fixture();
  const mutations=[row=>delete row.messageRef,row=>delete row.messageRef.stream.moment,row=>row.messageRef.stream.prefixDigest='bad',
    row=>row.messageRef.stream.moment.paragraphId='P01',row=>row.messageRef.stream.moment.paragraphId='model-guessed',
    row=>row.messageRef.messageKey='another-message',row=>row.messageRef.chatKey='other',row=>row.messageRef.swipeId=1];
  for(const mutate of mutations){
    const a=f.record('first-submission',0,{paragraph:3}),b=f.record('second-submission',1,{paragraph:2}),c=f.record('last-submission',2);
    mutate(b);
    assert.deepEqual(ids(sort([c,a,b])),['first-submission','second-submission','last-submission']);
    assert.deepEqual(ids(sort([b,a,c])),['first-submission','second-submission','last-submission']);
  }
  const later=f.record('later',0,{start:15}),early=f.record('early',1),contradictory=f.record('conflicting-redraw',1,{paragraph:2,createdAt:2000});
  assert.deepEqual(ids(sort([early,later,contradictory])),['later','early','conflicting-redraw']);
});

test('different generations, imported batches and ordinary/manual images never receive invented narrative positions',async()=>{
  const f=await fixture(),later=f.record('later',0,{start:15}),early=f.record('early',1);
  const ordinary={...copy(early),id:'manual',messageRef:null,inlineOrder:{...early.inlineOrder,batchId:'manual-batch',batchStartedAt:90}};
  const legacy={...ordinary,id:'legacy',inlineOrder:null};
  const foreign=f.record('foreign',0,{paragraph:3});foreign.inlineOrder={...foreign.inlineOrder,batchId:'foreign-batch',batchStartedAt:200};
  assert.deepEqual(ids(sort([foreign,later,legacy,ordinary,early])),['legacy','manual','early','later','foreign']);
  const old=f.record('old-generation',0,{paragraph:3});old.messageRef.stream.generationKey='b'.repeat(64);old.messageRef.revisionId=`stream:${'b'.repeat(64)}`;
  old.inlineOrder.batchId=`stream-${'b'.repeat(64)}`;old.inlineOrder.batchStartedAt=50;
  assert.deepEqual(ids(sort([early,later,old])),['old-generation','early','later']);
});

test('stream ordering reads compact source metadata without snapshot, model recipe or prose reads',async()=>{
  const f=await fixture(),rows=[f.record('later',0,{start:15}),f.record('early',1)];
  for(const row of rows)for(const key of ['snapshot','url','shotSpec','compiledPrompt','profile','prompt'])Object.defineProperty(row,key,{get(){throw Error('heavy read');}});
  assert.deepEqual(ids(sort(rows)),['early','later']);
});

test('visible stream shot numbers follow narrative order without changing durable shot or retry slot identities',async()=>{
  const f=await fixture(),late=f.record('late',0,{paragraph:3}),early=f.record('early',1),middle=f.record('middle',2,{paragraph:2});
  const variant=copy(early);variant.id='variant';variant.inlineOrder.requestIndex=2;
  const ordinary={...copy(early),id:'ordinary',messageRef:null};
  const rows=[late,variant,early,middle],before=copy(rows),positions=core.storyboardInlineDisplayIndexes(rows);
  assert.deepEqual(rows.map(row=>positions.get(row)),[2,0,0,1]);assert.deepEqual(rows,before);
  assert.equal(core.storyboardInlineDisplayIndexes([ordinary]).has(ordinary),false);
});

test('ordinary image rendering takes the no-stream fast path without an extra sort or recipe access',()=>{
  const row={id:'ordinary',messageRef:null};
  for(const key of ['inlineOrder','snapshot','url','prompt'])Object.defineProperty(row,key,{get(){throw Error('unnecessary sorting/read');}});
  assert.equal(core.storyboardInlineDisplayIndexes([row]).size,0);
  assert.equal(core.storyboardInlineDisplayIndexes(null).size,0);
});

test('normalized task placeholders retain source position and interleave with delivered images by narrative order',async()=>{
  const f=await fixture(),later=f.record('later',0,{start:15}),early=f.record('early',1);
  const task=core.createStoryboardTaskState({...early,id:'job-early',logId:'log-early',uiVisible:true,now:100,status:'queued'});
  const restored=core.normalizeStoryboardState({taskStates:[task]}).taskStates;
  const entries=core.buildStoryboardInlineTasks(restored,{chat:f.chat,chatKey:f.chatKey,waitingIds:new Set(['job-early'])});
  assert.equal(entries.length,1);assert.deepEqual(entries[0].messageRef.stream.moment,early.messageRef.stream.moment);
  assert.deepEqual(ids(sort([later,...entries])),['inline-task:job-early','later']);
  entries[0].messageRef.stream.moment.start=9;assert.equal(restored[0].messageRef.stream.moment.start,0);
});

test('one active prefix cannot validate a stale complete proof in the same task-render pass',async()=>{
  const f=await fixture(),partial=f.record('partial',0),complete=f.record('complete',1,{paragraph:2});
  complete.messageRef.stream.complete=true;
  const tasks=[partial,complete].map(row=>core.createStoryboardTaskState({...row,id:row.id,uiVisible:true,now:100,status:'queued'}));
  f.message.mes+=' More prose.';
  const options={chat:f.chat,chatKey:f.chatKey,waitingIds:new Set(['partial','complete'])};
  assert.deepEqual(ids(core.buildStoryboardInlineTasks(tasks,options)),['inline-task:partial']);
  assert.deepEqual(ids(core.buildStoryboardInlineTasks([...tasks].reverse(),options)),['inline-task:partial']);
});

test('different prefix lengths and hashes are independently validated after a later paragraph is rewritten',async()=>{
  const f=await fixture(),early=f.record('early',0),late=f.record('late',1,{paragraph:2});
  const prefix=f.message.mes.slice(0,27),hash=storyboardStreamFingerprint(prefix);
  early.messageRef.revisionHash=hash;Object.assign(early.messageRef.stream,{prefixLength:prefix.length,prefixHash:hash,prefixDigest:await storyboardStreamDigest(prefix)});
  const tasks=[early,late].map(row=>core.createStoryboardTaskState({...row,id:row.id,uiVisible:true,now:100,status:'queued'}));
  f.message.mes=f.message.mes.replace('old house','new cabin');
  const options={chat:f.chat,chatKey:f.chatKey,waitingIds:new Set(['early','late'])};
  assert.deepEqual(ids(core.buildStoryboardInlineTasks(tasks,options)),['inline-task:early']);
  assert.deepEqual(ids(core.buildStoryboardInlineTasks([...tasks].reverse(),options)),['inline-task:early']);
});

test('distinct subjects sharing one identical prefix reuse its source check without reading prose once per image',async()=>{
  const f=await fixture(),rows=[f.record('one',0),f.record('two',1,{paragraph:2}),f.record('three',2,{paragraph:3})];
  const tasks=rows.map(row=>core.createStoryboardTaskState({...row,id:row.id,uiVisible:true,now:100,status:'queued'}));
  const text=f.message.mes;let reads=0;Object.defineProperty(f.message,'mes',{get(){reads++;return text;}});
  const options={chat:f.chat,chatKey:f.chatKey,waitingIds:new Set(rows.map(row=>row.id))};
  assert.equal(core.buildStoryboardInlineTasks(tasks.slice(0,1),options).length,1);const once=reads;reads=0;
  assert.equal(core.buildStoryboardInlineTasks(tasks,options).length,3);assert.equal(reads,once);assert.ok(once>0);
});
