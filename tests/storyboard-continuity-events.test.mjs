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

test('system-role source keeps its exact identity only for explicitly admitted target scope',()=>{
 const scope=options();scope.messageRef=createStoryboardMessageReference({chatKey:scope.chatKey,floor:2,message:{mes:paragraphs.map(p=>p.text).join('\n'),is_system:true,name:'A',swipe_id:0},now:10});
 for(const value of [undefined,false,1,'true'])assert.throws(()=>bind([event()],{...scope,allowPromptExcludedTarget:value}),{code:'storyboard_continuity_source'});
 const result=bind([event()],{...scope,allowPromptExcludedTarget:true});assert.deepEqual(result.messageRef,scope.messageRef);
 assert.equal(result.messageRef.role,'system');assert.equal('allowPromptExcludedTarget' in result,false);
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

function rejected(raw,scope=options()){
 let error;assert.throws(()=>bind(raw,scope),value=>{error=value;return true;});return error;
}

test('event diagnostics use the original numeric array index and only fixed known field paths',()=>{
 for(const [change,field,reason,code='event'] of [
  [{branchId:'private-unknown-branch'},'branchId','unknown_branch'],
  [{paragraphId:'private-unknown-paragraph'},'paragraphId','unknown_paragraph'],
  [{subjectId:'private-unknown-subject'},'subjectId','unknown_subject'],
  [{category:'private-category'},'category','invalid_field'],
  [{persistence:'private-persistence'},'persistence','invalid_field'],
  [{key:' private-key '},'key','invalid_field'],
  [{value:'private-value\ud800'},'value','invalid_field'],
  [{evidence:' private-quote '},'evidence','invalid_field'],
  [{id:' private-id '},'id','invalid_field','scope'],
 ]){
  const error=rejected([event(),event({id:'second-event',...change})]);
  assert.equal(error.code,'storyboard_continuity_'+code);
  assert.deepEqual(error.continuityDiagnostic,{path:`$.events[1].${field}`,reason});
  assert.doesNotMatch(JSON.stringify(error),/private-|coat-off|second-event|chat-a|A脱下外套/);
  assert.ok(Object.isFrozen(error.continuityDiagnostic));
 }
});

test('invalid shapes never echo unknown property names and missing fields use their static path',()=>{
 for(const raw of [null,[],{...event(),['private-secret-property']:'private-secret-value'}]){
  const error=rejected([raw]);assert.equal(error.code,'storyboard_continuity_event');
  assert.deepEqual(error.continuityDiagnostic,{path:'$.events[0]',reason:'event_shape'});
  assert.doesNotMatch(JSON.stringify(error),/private-secret/);
 }
 const raw=event();delete raw.evidence;
 assert.deepEqual(rejected([raw]).continuityDiagnostic,{path:'$.events[0].evidence',reason:'event_shape'});
 const duplicate=rejected([event(),event()]);assert.equal(duplicate.code,'storyboard_continuity_scope');
 assert.deepEqual(duplicate.continuityDiagnostic,{path:'$.events[1].id',reason:'invalid_field'});
});

test('a wrong existing paragraph remains rejected but gets the sole exact unique local paragraph as a hint',()=>{
 const raw=[event({id:'private-event-name',paragraphId:'P1',key:'private-slot',value:'private-state'})],scope=options();
 const before=structuredClone([raw,scope]),error=rejected(raw,scope);
 assert.equal(error.code,'storyboard_continuity_grounding');
 assert.deepEqual(error.continuityDiagnostic,{path:'$.events[0].evidence',reason:'evidence_not_found',candidateParagraphIds:['P2']});
 assert.ok(Object.isFrozen(error.continuityDiagnostic.candidateParagraphIds));
 assert.deepEqual([raw,scope],before,'The candidate is advisory, not an automatic paragraph or event rewrite');
 assert.doesNotMatch(JSON.stringify(error),/private-|A脱下外套|chat-a|messageRef|revision/);
});

test('missing and repeated evidence remain distinguishable without echoing the quote',()=>{
 const missing=rejected([event({evidence:'not in any supplied paragraph'})]);
 assert.deepEqual(missing.continuityDiagnostic,{path:'$.events[0].evidence',reason:'evidence_not_found'});
 const scope=options();scope.paragraphs[1].text='A脱下外套。A脱下外套。';
 const repeated=rejected([event()],scope);
 assert.equal(repeated.code,'storyboard_continuity_grounding');
 assert.deepEqual(repeated.continuityDiagnostic,{path:'$.events[0].evidence',reason:'evidence_not_unique'});
 const overlap=options();overlap.paragraphs[1].text='aaa';
 assert.equal(rejected([event({evidence:'aa'})],overlap).continuityDiagnostic.reason,'evidence_not_unique');
});

test('candidate hints require exactly one containing paragraph and exactly one occurrence in it',()=>{
 for(const variant of ['two-unique','unique-plus-repeated','single-repeated','near-match','opaque-id']){
  const scope=options();
  if(variant==='two-unique')scope.paragraphs[2].text='A脱下外套。';
  if(variant==='unique-plus-repeated')scope.paragraphs[2].text='A脱下外套。A脱下外套。';
  if(variant==='single-repeated')scope.paragraphs[1].text='A脱下外套。A脱下外套。';
  if(variant==='near-match')scope.paragraphs[1].text='A 脱下外套。';
  if(variant==='opaque-id')scope.paragraphs[1].id='private-user-supplied-key';
  const error=rejected([event({paragraphId:'P1'})],scope);
  assert.deepEqual(error.continuityDiagnostic,{path:'$.events[0].evidence',reason:'evidence_not_found'},variant);
 }
 const missingParagraph=rejected([event({paragraphId:'missing'})]);
 assert.deepEqual(missingParagraph.continuityDiagnostic,{path:'$.events[0].paragraphId',reason:'unknown_paragraph'});
});

test('same-instant conflicts identify the original event position even after temporal sorting',()=>{
 const raw=[event(),event({id:'early',paragraphId:'P1',evidence:'A穿着外套。'}),event({id:'early-conflict',paragraphId:'P1',evidence:'A穿着外套。',value:'opposite'})];
 const error=rejected(raw);assert.equal(error.code,'storyboard_continuity_conflict');
 assert.deepEqual(error.continuityDiagnostic,{path:'$.events[2]',reason:'event_conflict'});
 assert.doesNotMatch(JSON.stringify(error),/early|opposite|outerwear/);
});

test('source and roster failures retain their generic semantics and valid output gains no diagnostic fields',()=>{
 for(const scope of [{...options(),chatKey:'private-foreign-chat'},{...options(),subjectIds:['A','A']}]){
  const error=rejected([event()],scope);assert.equal('continuityDiagnostic' in error,false);
 }
 const value=bind([event()],options());assert.equal('continuityDiagnostic' in value,false);
 assert.deepEqual(Object.keys(value.events[0]).sort(),['id','branchId','narrativeLayer','point','fact'].sort());
});
