import test from 'node:test';
import assert from 'node:assert/strict';
import * as selection from '../qianmu-comfy-selection.js';
import { STORYBOARD_NARRATIVE_LAYERS } from '../qianmu-storyboard.js';
import { recipesFixture, namespace } from './helpers/comfy-route-fixture.mjs';

async function fixture(){
  const f=await recipesFixture();
  const pool={schema:selection.COMFY_SELECTION_SCHEMA,namespace,id:'pool-a',revision:'pool-revision-a',enabled:true,styleLock:true,
    candidates:f.routes.map((target,index)=>({id:`candidate-${index}`,enabled:true,priority:0,target,classification:{version:1,
      visualKinds:[index?'environment':'character'],castSizes:[index?'none':'one'],narrativeLayers:['present'],contentClasses:['sfw'],promptFormat:'natural_language',maxSubjects:index?0:1}}))};
  const scope={namespace,chatKey:'chat-a',continuityId:'confirmed-scene-a',narrativeLayer:'present'};
  const requirements={version:1,visualKind:'character',visibleSubjects:1,subjectIds:['archive:alice'],narrativeLayer:'present',contentClass:'sfw',promptFormats:['natural_language']};
  const e={...f,pool,scope,requirements,namespace,preparationId:'prepared-shot-a'};
  e.eligibility=await eligible(e);return e;
}
async function eligible(e){
  const requestKey=await selection.comfySelectionRequestKey(e.requirements,e.scope,e.namespace);
  return new Map(await Promise.all(e.pool.candidates.map(async candidate=>[candidate.id,{automaticEligible:true,
    executionKey:await selection.comfyCandidateExecutionKey(candidate),requestKey,preparationId:e.preparationId}])));
}
const select=e=>selection.selectComfyWorkflow(e);

test('classification shares the existing narrative layers and cannot make an old workflow an automatic candidate',async()=>{
  assert.deepEqual(selection.COMFY_CLASSIFICATION_VALUES.narrativeLayers,STORYBOARD_NARRATIVE_LAYERS);
  const e=await fixture();delete e.pool.enabled;delete e.pool.candidates[0].enabled;
  assert.equal(selection.normalizeComfyAutoPool(e.pool).enabled,false);
  assert.equal(selection.normalizeComfyAutoPool(e.pool).candidates[0].enabled,false);
  assert.equal((await select(e)).reason,'pool_disabled');
  assert.deepEqual(selection.normalizeComfyClassification({version:1}),{version:1,visualKinds:[],castSizes:[],narrativeLayers:[],contentClasses:[],promptFormat:'',maxSubjects:null});
});

test('selection uses local classified requirements, returns an exact version, and never grants execution authority',async()=>{
  const e=await fixture(),before=JSON.stringify(e.pool),result=await select(e);
  assert.equal(result.status,'selected');assert.equal(result.candidateId,'candidate-0');assert.equal(result.executionAuthorized,false);
  assert.deepEqual(result.target.comfyWorkflowBinding,e.recipes[0].binding);assert.equal(JSON.stringify(e.pool),before);
  assert.equal(result.proposedLock.scope.continuityId,'confirmed-scene-a');assert.ok(JSON.stringify(result.proposedLock).length<1024);
  assert.doesNotMatch(JSON.stringify(result),/class_type|%qianmu_prompt%/);
});

test('visible-subject and image-category preferences improve matching without excluding legitimate backgrounds',async()=>{
  const e=await fixture();e.pool.candidates.forEach(candidate=>candidate.classification.maxSubjects=null);
  e.requirements={...e.requirements,visualKind:'environment',visibleSubjects:0,subjectIds:[]};e.eligibility=await eligible(e);
  assert.equal((await select(e)).candidateId,'candidate-1');
  e.pool.candidates[1].enabled=false;
  assert.equal((await select(e)).candidateId,'candidate-0'); // Preferences are not hidden hard constraints.
  e.pool.candidates[0].classification.maxSubjects=0;
  e.requirements={...e.requirements,visibleSubjects:1,subjectIds:['archive:alice']};e.eligibility=await eligible(e);
  assert.equal((await select(e)).reason,'no_eligible_candidate');
});

test('same-dimensional alternatives use any match; independent dimensions add explicit preference scores',async()=>{
  const e=await fixture();e.pool.candidates[0].classification.visualKinds=['object','character'];
  const result=await select(e);assert.equal(result.score,7);
  e.pool.candidates[0].classification.castSizes=['many'];assert.equal((await select(e)).score,5);
});

for(const [change,reason] of [
  [e=>e.requirements.contentClass='unknown','content_unknown'],
  [e=>{e.requirements.contentClass='adult';e.adultAllowed=false;},'content_not_authorized'],
  [e=>e.requirements.promptFormats=['tags'],'no_eligible_candidate'],
  [e=>e.requirements.visibleSubjects=null,'no_eligible_candidate'],
  [e=>e.pool.candidates.forEach(candidate=>candidate.classification.contentClasses=[]),'no_eligible_candidate'],
])test(`content/format/subject gate: ${reason}`,async()=>{
  const e=await fixture();change(e);e.eligibility=await eligible(e);const result=await select(e);
  assert.equal(result.reason,reason);assert.notEqual(result.status,'selected');assert.equal(result.executionAuthorized,false);
});

test('adult classification is only usable with separate current permission, never by the LLM label alone',async()=>{
  const e=await fixture();e.requirements.contentClass='adult';e.pool.candidates[0].classification.contentClasses=['sfw','adult'];e.eligibility=await eligible(e);
  assert.equal((await select(e)).reason,'content_not_authorized');e.adultAllowed=true;assert.equal((await select(e)).candidateId,'candidate-0');
  assert.equal((await select(e)).executionAuthorized,false);
});

for(const kind of ['missing','stale-execution','stale-request','stale-preparation','not-eligible'])test(`independent per-shot technical gate cannot be bypassed: ${kind}`,async()=>{
  const e=await fixture(),check=e.eligibility.get('candidate-0');
  if(kind==='missing')e.eligibility.delete('candidate-0');
  if(kind==='stale-execution')check.executionKey='bad';if(kind==='stale-request')check.requestKey='bad';
  if(kind==='stale-preparation')check.preparationId='old';if(kind==='not-eligible')check.automaticEligible=false;
  const result=await select(e);assert.equal(result.reason,'no_eligible_candidate');assert.equal(result.excluded.find(row=>row.id==='candidate-0').reason,'technical_gate');
});

test('changing a subject with the same count does not reuse the previous subject’s technical eligibility',async()=>{
  const e=await fixture();e.requirements.subjectIds=['archive:bob'];assert.equal((await select(e)).reason,'no_eligible_candidate');
  e.eligibility=await eligible(e);assert.equal((await select(e)).status,'selected');
});

test('ambiguous equally-ranked execution configurations ask for a choice instead of random selection',async()=>{
  const e=await fixture();e.pool.candidates[1].classification=structuredClone(e.pool.candidates[0].classification);e.eligibility=await eligible(e);
  assert.equal((await select(e)).reason,'ambiguous_match');
  e.pool.candidates.reverse();assert.equal((await select(e)).reason,'ambiguous_match');
  e.pool.candidates.find(row=>row.id==='candidate-1').priority=1;assert.equal((await select(e)).candidateId,'candidate-1');
});

test('identical duplicate choices do not create ambiguity or change selection with list order',async()=>{
  const e=await fixture();e.pool.candidates[1]={...structuredClone(e.pool.candidates[0]),id:'candidate-1'};e.eligibility=await eligible(e);
  assert.equal((await select(e)).candidateId,'candidate-0');e.pool.candidates.reverse();assert.equal((await select(e)).candidateId,'candidate-0');
});

test('continuous-scene lock preserves the exact previous workflow despite a changed shot preference',async()=>{
  const e=await fixture();e.pool.candidates.forEach(candidate=>candidate.classification.maxSubjects=null);
  e.lock=(await select(e)).proposedLock;
  e.requirements={...e.requirements,visualKind:'environment',visibleSubjects:0,subjectIds:[]};e.preparationId='prepared-shot-b';e.eligibility=await eligible(e);
  const result=await select(e);assert.equal(result.reason,'scene_locked');assert.equal(result.candidateId,'candidate-0');
  e.lock=null;assert.equal((await select(e)).candidateId,'candidate-1'); // Explicit release, not an automatic style change.
});

test('a locked but no longer eligible graph stops; it cannot fall back to another healthy pool member',async()=>{
  const e=await fixture();e.pool.candidates.forEach(candidate=>candidate.classification.maxSubjects=null);e.lock=(await select(e)).proposedLock;
  e.eligibility.get('candidate-0').automaticEligible=false;
  assert.equal((await select(e)).reason,'locked_route_unavailable');
});

for(const key of ['chatKey','continuityId','narrativeLayer'])test(`scene locks cannot cross ${key} boundaries`,async()=>{
  const e=await fixture();e.lock=(await select(e)).proposedLock;
  if(key==='narrativeLayer'){e.scope.narrativeLayer='memory';e.requirements.narrativeLayer='memory';}
  else e.scope[key]+='-other';
  e.eligibility=await eligible(e);assert.equal((await select(e)).reason,'lock_scope_mismatch');
});

test('pool revisions, classification, connection or role changes invalidate existing style locks',async()=>{
  for(const change of [e=>e.pool.revision='other',e=>e.pool.candidates[0].classification.visualKinds=['object'],
    e=>e.pool.candidates[0].target.connectionPresetId='other-api',e=>e.pool.candidates[0].target.comfyCharacterEnabled=true]){
    const e=await fixture();e.lock=(await select(e)).proposedLock;change(e);e.eligibility=await eligible(e);assert.equal((await select(e)).reason,'lock_pool_changed');
  }
});

test('absent explicit continuous identity never manufactures a lock from prose, location or character names',async()=>{
  const e=await fixture();e.scope=null;e.requirements.location='same kitchen';e.eligibility=await eligible(e);
  assert.equal((await select(e)).proposedLock,null);e.pool.styleLock=false;assert.equal((await select(e)).proposedLock,null);
});

test('foreign pool, binding or scene lock is rejected, not matched by a familiar name',async()=>{
  const e=await fixture();await assert.rejects(select({...e,namespace:'st-user:other'}),{code:'comfy_selection_invalid'});
  e.lock=(await select(e)).proposedLock;e.lock.scope.namespace='st-user:other';await assert.rejects(select(e),{code:'comfy_selection_invalid'});
  e.pool.candidates[0].target.comfyWorkflowBinding={...e.pool.candidates[0].target.comfyWorkflowBinding,namespace:'st-user:other'};
  assert.throws(()=>selection.normalizeComfyAutoPool(e.pool),{code:'comfy_selection_invalid'});
});

test('malformed and oversized metadata cannot be truncated into an executable choice',async()=>{
  for(const change of [e=>e.pool.candidates.push({...e.pool.candidates[0]}),e=>e.pool.candidates=Array.from({length:33},(_,i)=>({...e.pool.candidates[0],id:`row-${i}`})),
    e=>e.pool.candidates[0].priority=Infinity,e=>e.pool.candidates[0].classification.contentClasses=['unknown'],e=>e.pool.candidates[0].classification.promptFormat='magic',
    e=>e.pool.candidates[0].classification.maxSubjects=-1,e=>e.pool.candidates[0].target.modelId='flux',e=>e.pool.candidates[0].target.parameterPresetId='old',
    e=>e.pool.candidates[0].enabled='yes',e=>e.pool.revision='']){
    const e=await fixture();change(e);assert.throws(()=>selection.normalizeComfyAutoPool(e.pool),{code:'comfy_selection_invalid'});
  }
});

test('normalization strips imported execution promises, full graphs and credentials',async()=>{
  const e=await fixture();Object.assign(e.pool.candidates[0],{apiKey:'SECRET',automaticEligible:true,workflow:'GRAPH',executionAuthorized:true});
  Object.assign(e.pool.candidates[0].target,{url:'https://private.example',headers:{authorization:'SECRET'}});
  const pool=selection.normalizeComfyAutoPool(e.pool);assert.doesNotMatch(JSON.stringify(pool),/SECRET|GRAPH|private\.example|automaticEligible|executionAuthorized/);
  assert.equal((await select({...e,pool,eligibility:new Map()})).reason,'no_eligible_candidate');
});

test('mutating supplied configuration or lock during hashing cannot retarget the captured selection',async()=>{
  const e=await fixture(),running=select(e);e.pool.candidates[0].enabled=false;e.eligibility.get('candidate-0').automaticEligible=false;
  const result=await running;assert.equal(result.candidateId,'candidate-0');
  const next=await fixture();next.lock=(await select(next)).proposedLock;const locked=select(next);next.lock.candidateId='candidate-1';assert.equal((await locked).candidateId,'candidate-0');
});
