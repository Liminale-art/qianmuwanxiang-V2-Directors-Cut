import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardMessageReference} from '../qianmu-storyboard.js';
import {bindStoryboardContinuityEvents as bind,STORYBOARD_CONTINUITY_EVENT_LIMITS as limits} from '../qianmu-storyboard-continuity-events.js';
const paragraphs=[{id:'P1',text:'A穿着外套。'},{id:'P2',text:'A拿起杯子。随后A脱下外套。'},{id:'P3',text:'A想起旧日穿蓝外套的自己。'}];
const options=()=>({chatKey:'chat-a',messageRef:createStoryboardMessageReference({chatKey:'chat-a',floor:2,message:{mes:paragraphs.map(p=>p.text).join('\n'),name:'A',swipe_id:0},now:10}),paragraphs:structuredClone(paragraphs),branches:[{id:'now',layer:'present'},{id:'memory-1',layer:'memory'}],subjectIds:['A']});
const event=(extra={})=>({id:'coat-off',branchId:'now',paragraphId:'P2',subjectId:'A',category:'outfit',key:'outerwear',value:'coat removed',persistence:'persistent',evidence:'A脱下外套。',...extra});
test('all-paragraph events bind independent of shots and locate exact source order without asking a model to count offsets',()=>{
 const raw=[event(),event({id:'cup',category:'prop',key:'held',value:'cup',evidence:'A拿起杯子。'}),event({id:'memory-coat',branchId:'memory-1',paragraphId:'P3',value:'blue coat',evidence:'旧日穿蓝外套的自己'})],before=structuredClone(raw),scope=options();
 const result=bind(raw,scope);assert.deepEqual(result.events.map(e=>e.id),['cup','coat-off','memory-coat']);assert.equal(result.events[1].point.offset,paragraphs[1].text.length);assert.equal(result.events[0].fact.sourceFloor,2);assert.equal(result.events[2].narrativeLayer,'memory');assert.deepEqual(result.events[0].fact.sourceParagraphIds,['P2']);
 assert.ok(Object.isFrozen(result.events[0].fact));assert.equal('paragraphs' in result,false);assert.doesNotMatch(JSON.stringify(result),/A穿着外套。/);assert.deepEqual(raw,before);scope.messageRef.revisionId='changed';scope.paragraphs[1].text='revised';assert.notEqual(result.messageRef.revisionId,'changed');
});
test('ambiguous or absent quotes, untrusted fields and unknown subject/branch/paragraph fail rather than silently dropping facts',()=>{
 for(const change of [{evidence:'not present'},{paragraphId:'missing'},{subjectId:'invented'},{branchId:'imagined'},{apiKey:'private'},{value:'\ud800'},{evidence:' A脱下外套。'}])assert.throws(()=>bind([event(change)],options()));
 const scope=options();scope.paragraphs[1].text='A脱下外套。A脱下外套。';assert.throws(()=>bind([event()],scope),{code:'storyboard_continuity_grounding'});
});
test('no coercion of source revision, unknown floor, active chat, duplicate roster or over-budget event set',()=>{
 for(const change of [{chatKey:'other'},{messageRef:{...options().messageRef,lastKnownFloor:null}},{messageRef:{...options().messageRef,revisionId:''}},{messageRef:{...options().messageRef,role:'system'}},{subjectIds:['A','A']},{paragraphs:[...paragraphs,paragraphs[0]]},{branches:[{id:'now',layer:'unknown'}]}])assert.throws(()=>bind([event()],{...options(),...change}));
 assert.throws(()=>bind(Array.from({length:limits.events+1},(_,i)=>event({id:'event-'+i})),options()),{code:'storyboard_continuity_scope'});assert.equal(bind([],options()).events.length,0);
});
test('same-instant conflicting slots reject but different subjects or isolated memory branches remain independent',()=>{
 assert.throws(()=>bind([event(),event({id:'other',value:'coat on'})],options()),{code:'storyboard_continuity_conflict'});
 assert.throws(()=>bind([event(),event({id:'other',key:'OUTERWEAR',value:'coat on'})],options()),{code:'storyboard_continuity_conflict'});
 const isolated=bind([event(),event({id:'remembered',branchId:'memory-1',value:'coat on'})],options());assert.equal(isolated.events.length,2);
 const held=bind([event({id:'gesture',category:'action',key:'hand',value:'lifting cup',persistence:'momentary',evidence:'A拿起杯子。'}),event({id:'holding',category:'prop',key:'held',value:'cup',evidence:'A拿起杯子。'})],options());assert.deepEqual(held.events.map(e=>e.fact.persistence),['momentary','persistent']);
});

test('Unicode quote endpoints preserve exact source positions and limit excess is never silently truncated',()=>{
 const scope=options();scope.paragraphs[1].text='😀 A脱下外套。';
 assert.equal(bind([event()],scope).events[0].point.offset,scope.paragraphs[1].text.length);
 for(const change of [{key:'x'.repeat(121)},{value:'x'.repeat(1001)},{id:'x'.repeat(161)}])assert.throws(()=>bind([event(change)],options()));
 const overflow=options();overflow.paragraphs=[{id:'P1',text:'a'.repeat(100001)},{id:'P2',text:'b'.repeat(100000)}];
 assert.throws(()=>bind([],overflow),{code:'storyboard_continuity_scope'});
 const overlap=options();overlap.paragraphs[1].text='aaa';assert.throws(()=>bind([event({evidence:'aa'})],overlap),{code:'storyboard_continuity_grounding'});
});
