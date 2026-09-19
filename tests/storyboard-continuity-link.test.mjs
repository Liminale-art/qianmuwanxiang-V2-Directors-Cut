import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardMessageReference} from '../qianmu-storyboard.js';
import {linkStoryboardContinuity as join} from '../qianmu-storyboard-continuity-link.js';
function source(floor,text,subjectId,events){return {events,options:{chatKey:'chat',messageRef:createStoryboardMessageReference({chatKey:'chat',floor,message:{mes:text,name:'A',send_date:'floor-'+floor},now:1}),paragraphs:[{id:'P1',text}],branches:[{id:'now',layer:'present'},{id:'memory',layer:'memory'}],subjectIds:[subjectId]}};}
const event=(id,value,evidence,extra={})=>({id,branchId:'now',paragraphId:'P1',subjectId:'old-A',category:'outfit',key:'coat',value,persistence:'persistent',evidence,...extra});
function fixture(){
 const previous=source(1,'A穿着外套。A脱下外套。A拿起杯子。','old-A',[event('on','on','A穿着外套。'),event('off','off','A脱下外套。'),event('cup','cup','A拿起杯子。',{category:'prop',key:'held'}),event('lifting','lifting','A拿起杯子。',{category:'action',key:'gesture',persistence:'momentary'})]);
 const current=source(2,'A继续刚才的谈话。A重新穿上外套。','new-A',[event('new-on','on','A重新穿上外套。',{subjectId:'new-A'})]);
 const target={branchId:'now',paragraphId:'P1',evidence:'A继续刚才的谈话。'};
 const link={relation:'continuous',fromRevisionId:previous.options.messageRef.revisionId,toRevisionId:current.options.messageRef.revisionId,fromBranchId:'now',toBranchId:'now',evidence:{paragraphId:'P1',quote:'A继续刚才的谈话。'},facts:[{eventId:'off',subjectId:'new-A'},{eventId:'cup',subjectId:'new-A'}]};
 return {previous,current,target,link};
}
test('explicit continuity carries end-state clothing and held props, without repeating lift actions or using earlier coat-on',()=>{
 const f=fixture(),result=join(f);assert.deepEqual(result.carriedFacts.map(row=>[row.fact.subject,row.fact.value]),[['new-A','off'],['new-A','cup']]);
 assert.equal(result.carriedFacts[0].source.subjectId,'old-A');assert.equal(result.carriedFacts[0].fact.sourceFloor,1);assert.ok(Object.isFrozen(result.carriedFacts[0]));
 for(const eventId of ['on','lifting','missing'])assert.throws(()=>join({...f,link:{...f.link,facts:[{eventId,subjectId:'new-A'}]}}),{code:'storyboard_continuity_link'});
});
test('later current facts override inherited state only after their source instant, with complete original provenance retained',()=>{
 const f=fixture(),result=join({...f,target:{...f.target,evidence:'A重新穿上外套。'}});
 assert.deepEqual(result.carriedFacts.map(row=>row.fact.id),['cup']);assert.equal(result.effectiveFacts.find(row=>row.fact.key==='coat').source.kind,'current');
 assert.equal(join({...f,link:null}).carriedFacts.length,0,'same branch names do not implicitly inherit');
});
test('foreign, stale, future, uncertain and cross-layer links cannot authorize inheritance',()=>{
 const f=fixture();for(const patch of [{fromRevisionId:'stale'},{toRevisionId:'stale'},{relation:'uncertain'},{fromBranchId:'memory'},{toBranchId:'memory'},{evidence:{paragraphId:'P1',quote:'A重新穿上外套。'}}])assert.throws(()=>join({...f,link:{...f.link,...patch}}));
 const foreign=fixture();foreign.previous.options.chatKey='other';foreign.previous.options.messageRef.chatKey='other';assert.throws(()=>join(foreign));
 const future=fixture();future.previous.options.messageRef.lastKnownFloor=3;assert.throws(()=>join(future));
});
test('unknown or colliding character mappings reject rather than silently mixing identities',()=>{
 const f=fixture();assert.throws(()=>join({...f,link:{...f.link,facts:[{eventId:'off',subjectId:'unknown'}]}}));
 assert.throws(()=>join({...f,link:{...f.link,facts:[f.link.facts[0],f.link.facts[0]]}}));
 f.previous.events.push(event('other','other coat','A脱下外套。',{subjectId:'other'}));f.previous.options.subjectIds.push('other');f.link.facts.push({eventId:'other',subjectId:'new-A'});assert.throws(()=>join(f),/状态槽/);
});
test('pure linking does not mutate source facts or silently restore old state after a current momentary assignment expires',()=>{
 const f=fixture();f.current.events=[event('moment','brief pose','A继续刚才的谈话。',{subjectId:'new-A',persistence:'momentary'})];f.target.evidence='A重新穿上外套。';const before=structuredClone(f),result=join(f);
 assert.equal(result.effectiveFacts.some(row=>row.fact.key==='coat'),false);assert.deepEqual(f,before);
});
