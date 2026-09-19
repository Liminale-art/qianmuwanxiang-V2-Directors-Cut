import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardMessageReference} from '../qianmu-storyboard.js';
import {replayStoryboardContinuityChain as replay} from '../qianmu-storyboard-continuity-link.js';
const text=['A脱下外套。','A继续聊天。','A还在原处。A穿回外套。'];
const ref=(floor,mes)=>createStoryboardMessageReference({chatKey:'chat',floor,message:{mes,name:'A',send_date:'floor-'+floor},now:1});
const event=(value,evidence,extra={})=>({id:'state',branchId:'now',paragraphId:'P1',subjectId:'A',category:'outfit',key:'coat',value,persistence:'persistent',evidence,...extra});
function fixture(){
 const steps=text.map((body,index)=>({source:{events:index===0?[event('off',body)]:index===2?[event('on','A穿回外套。')]:[],options:{chatKey:'chat',messageRef:ref(index,body),paragraphs:[{id:'P1',text:body}],branches:[{id:'now',layer:'present'}],subjectIds:['A']}},branchId:'now',link:null}));
 for(let index=1;index<3;index++)steps[index].link={relation:'continuous',fromRevisionId:steps[index-1].source.options.messageRef.revisionId,toRevisionId:steps[index].source.options.messageRef.revisionId,fromBranchId:'now',toBranchId:'now',evidence:{paragraphId:'P1',quote:index===1?text[1]:'A还在原处。'},facts:[{sourceFloor:0,sourceRevisionId:steps[0].source.options.messageRef.revisionId,eventId:'state',subjectId:'A'}]};
 return {steps,target:{branchId:'now',paragraphId:'P1',evidence:'A还在原处。'}};
}
test('unrestated state crosses an intermediate floor while retaining original evidence and every handoff revision',()=>{
 const {steps,target}=fixture(),before=structuredClone(steps),result=replay(steps,target),row=result.effectiveFacts[0];
 assert.equal(row.fact.value,'off');assert.equal(row.fact.sourceFloor,0);assert.equal(row.source.messageRef.revisionId,steps[0].source.options.messageRef.revisionId);
 assert.deepEqual(row.source.via.map(hop=>hop.messageRef.lastKnownFloor),[1,2]);assert.ok(Object.isFrozen(row.source.via[0].evidence));assert.deepEqual(steps,before);
 const later=replay(steps,{...target,evidence:'A穿回外套。'});assert.equal(later.effectiveFacts[0].fact.value,'on');assert.equal(later.effectiveFacts[0].source.messageRef.lastKnownFloor,2);
});
test('edited intermediate revision invalidates the old dependency chain; explicit discontinuity stops inheritance',()=>{
 const {steps,target}=fixture();steps[1].source.options.messageRef=ref(1,'A离开了。');steps[1].source.options.paragraphs[0].text='A离开了。';assert.throws(()=>replay(steps,target));
 const fresh=fixture();fresh.steps[1].link=null;assert.throws(()=>replay(fresh.steps,fresh.target),'later hop cannot pull state through a broken link');fresh.steps[2].link=null;assert.equal(replay(fresh.steps,fresh.target).carriedFacts.length,0);
});
test('reused local event IDs require original revision qualification and cannot silently select a newer unrelated fact',()=>{
 const {steps,target}=fixture();steps[1].source.events=[event('cup',text[1],{category:'prop',key:'held'})];steps[2].link.facts.push({sourceFloor:1,sourceRevisionId:steps[1].source.options.messageRef.revisionId,eventId:'state',subjectId:'A'});
 assert.deepEqual(replay(steps,target).effectiveFacts.map(row=>row.fact.value),['off','cup']);delete steps[2].link.facts[0].sourceRevisionId;assert.throws(()=>replay(steps,target));
});

test('floor qualification separates repeated legacy revisions and maximum reference-depth chains retain bounded provenance',()=>{
 const {steps,target}=fixture();steps[1].source.options.messageRef.revisionId=steps[0].source.options.messageRef.revisionId;
 steps[1].link.toRevisionId=steps[1].source.options.messageRef.revisionId;steps[2].link.fromRevisionId=steps[1].source.options.messageRef.revisionId;
 steps[1].source.events=[event('cup',text[1],{category:'prop',key:'held'})];steps[2].link.facts.push({sourceFloor:1,sourceRevisionId:steps[1].source.options.messageRef.revisionId,eventId:'state',subjectId:'A'});
 assert.deepEqual(replay(steps,target).effectiveFacts.map(row=>row.fact.value),['off','cup']);
 const original=fixture(),chain=[original.steps[0]];
 for(let index=1;index<21;index++){
  const step=structuredClone(original.steps[1]);step.source.options.messageRef=ref(index,text[1]);step.link.fromRevisionId=chain[index-1].source.options.messageRef.revisionId;step.link.toRevisionId=step.source.options.messageRef.revisionId;chain.push(step);
 }
 const result=replay(chain,{branchId:'now',paragraphId:'P1',evidence:text[1]});assert.equal(result.effectiveFacts[0].source.via.length,20);
});
test('empty, oversized, out-of-order and wrong target branch chains fail without truncation',()=>{
 const {steps,target}=fixture();for(const chain of [[],Array(22).fill(steps[0]),[steps[1],steps[0]],steps.map((step,index)=>index===2?{...step,branchId:'other'}:step)])assert.throws(()=>replay(chain,target));
});
