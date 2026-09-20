import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../qianmu-storyboard.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const ids=rows=>rows.map(row=>row.id);
function fixture(){
  const root=core.createStoryboardMessageReference({chatKey:'chat',floor:0,now:1,message:{mes:'Original text',name:'Alice',send_date:'before',gen_started:'before',swipe_id:0}});
  const current=core.createStoryboardMessageReference({chatKey:'chat',floor:0,now:2,message:{mes:'Original text\n\nNew text',name:'Alice',send_date:'after',gen_started:'after',swipe_id:0}});
  const moment=(paragraph,start=0)=>({version:1,paragraphId:`P${paragraph}`,branchId:'present',layer:'present',quote:'a',subject:'subject',start,end:start+1,insertAfter:`P${paragraph}`,sourceIds:[`P${paragraph}`]});
  const proof={version:3,generation:{sentAt:'after',startedAt:'after',id:'',activeSentAt:'',activeId:''},generationKey:'a'.repeat(64),prefixLength:100,prefixHash:'12345678',prefixDigest:'b'.repeat(64),family:{version:2,namespace:'st-user:test',reference:root}};
  const record=(id,shotIndex,paragraph,ordinary=false,start=0)=>({id,chatKey:'chat',floor:0,swipeId:0,planId:'original-plan',planShotId:`shot-${shotIndex}`,createdAt:10,
    messageRef:ordinary?copy(root):{...copy(current),revisionHash:'12345678',revisionId:`stream:${proof.generationKey}`,stream:{...copy(proof),moment:moment(paragraph,start)}},
    ...(ordinary?{narrativeMoment:moment(paragraph,start)}:{}),
    inlineOrder:{version:1,batchId:ordinary?'legacy-batch':'original-plan',batchStartedAt:ordinary?150:100,shotIndex,requestIndex:1}});
  const old=record('old',0,2,true),early=record('early',1,1),late=record('late',2,3);
  const plan={id:'original-plan',chatKey:'chat',origin:'automatic',revisionId:root.revisionId,messageRef:copy(root),shots:[{id:'shot-0',narrativeMoment:moment(2)}]};
  return {root,record,old,early,late,plan,moment};
}

test('mixed ordinary and continued records sort by narrative across their different historical batch IDs without rewriting them',()=>{
  const f=fixture(),rows=[f.late,f.old,f.early],before=copy(rows);
  assert.deepEqual(ids(core.sortStoryboardInlineRecords(rows)),['early','old','late']);assert.deepEqual(rows,before);
  const numbers=core.storyboardInlineDisplayIndexes(rows);assert.deepEqual([f.early,f.old,f.late].map(row=>numbers.get(row)),[0,1,2]);
});

test('same-paragraph positions and redraw variants retain narrative order and original durable retry slots',()=>{
  const f=fixture(),old=f.record('old',0,1,true,15),early=f.record('early',1,1,false,0),late=f.record('late',2,1,false,30),variant=copy(old);
  variant.id='variant';variant.inlineOrder.requestIndex=2;const before=copy(variant.inlineOrder);
  assert.deepEqual(ids(core.sortStoryboardInlineRecords([late,variant,early,old])),['early','old','variant','late']);assert.deepEqual(variant.inlineOrder,before);
});

test('a legacy compact record may use a uniquely matching verified plan position without opening heavy snapshots',()=>{
  const f=fixture();delete f.old.narrativeMoment;
  for(const row of [f.old,f.early,f.late])for(const key of ['shotSpec','snapshot','profile','prompt'])Object.defineProperty(row,key,{get(){assert.fail('heavy read');}});
  assert.deepEqual(ids(core.sortStoryboardInlineRecords([f.late,f.old,f.early],{plans:[f.plan]})),['early','old','late']);
});

test('a legacy record does not borrow a moment from a foreign plan, different shot or invalid explicit position',()=>{
  for(const mutate of [f=>f.plan.messageRef.messageKey='other',f=>f.plan.messageRef.swipeId=1,f=>f.plan.origin='manual',
    f=>f.plan.shots[0].id='other',f=>f.old.narrativeMoment={version:1,invalid:true}]){
    const f=fixture();delete f.old.narrativeMoment;mutate(f);
    const numbers=core.storyboardInlineDisplayIndexes([f.early,f.old,f.late],{plans:[f.plan]});assert.equal(numbers.has(f.old),false);
  }
});

test('inconsistent continued family or batch metadata disables mixed-family projection rather than inventing an ordering',()=>{
  for(const mutate of [f=>f.late.messageRef.stream.family.reference.revisionId='87654321',f=>f.late.inlineOrder.batchStartedAt++]){
    const f=fixture();mutate(f);assert.equal(core.storyboardInlineDisplayIndexes([f.old,f.early,f.late],{plans:[f.plan]}).size,0);
  }
});

test('ordinary-only rows keep their existing order and never consult source positions or the plan list',()=>{
  const f=fixture(),rows=[f.old,{...copy(f.old),id:'other',inlineOrder:{...f.old.inlineOrder,shotIndex:1}}];
  for(const row of rows)Object.defineProperty(row,'narrativeMoment',{get(){assert.fail('ordinary-only position read');}});
  const plans=[{get id(){assert.fail('ordinary-only plan scan');}}];assert.deepEqual(ids(core.sortStoryboardInlineRecords(rows,{plans})),['old','other']);
});
