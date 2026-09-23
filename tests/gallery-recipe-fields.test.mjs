import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGalleryRecipeFieldRelease as prepare,prepareExternalGalleryRecipeFieldRelease as prepareExternal} from '../qianmu-gallery-recipe-fields.js';
import {storyboardProductionContext,storyboardDirectorDecisionSnapshot,storyboardProductionDeliveryPolicy} from '../qianmu-storyboard.js';
const project=record=>({production:storyboardProductionContext(record),decision:storyboardDirectorDecisionSnapshot(record)});
const decision=()=>({decisionId:'decision-a',owner:{chatKey:'chat'},status:'approved',truthMode:'speculative',
  source:{candidateId:'c',ledgerEntryId:'l',packetId:'p',eventId:'e',track:'second_camera'},approval:{mode:'explicit',approvedAt:10},
  outputs:{storyboard:true,voice:true,subtitle:true,film:true},lanes:{visual:{description:'world image'},dialogue:['完整原句'],caption:'caption'}});
const production=()=>({packetId:'p',eventId:'e',track:'second_camera',decisionId:'decision-a',decisionStatus:'approved',truthMode:'speculative'});
function row(){const snapshot={source:'comfy',prompt:'original',profile:{},payload:{},
  compiledPrompt:{prompt:'完整提示',future:['',false,0,null,{unknown:'保留'}]},compositionDecision:{ratioId:'3:2',future:'keep'},shotSpec:{id:'shot',future:'legacy consumer'}};
  return {id:'image',createdAt:1,snapshot,compiledPrompt:structuredClone(snapshot.compiledPrompt),compositionDecision:structuredClone(snapshot.compositionDecision),shotSpec:structuredClone(snapshot.shotSpec),future:{keep:true}};}

test('equal complete copies leave the hot record but stay complete in the original recipe; shotSpec stays resident',()=>{
  const record=row(),source=record.snapshot,before=structuredClone(source),shot=record.shotSpec,plan=prepare(record,source,project);
  plan.apply();assert.equal(record.compiledPrompt,undefined);assert.equal(record.compositionDecision,undefined);assert.equal(record.shotSpec,shot);
  assert.deepEqual(source,before);assert.deepEqual(record.future,{keep:true});assert.equal(record.snapshot,source);
});
test('different or missing originals are not inferred from normalized, truncated or current values',()=>{
  for(const mode of ['different','missing','payload-only']){const record=row();
    if(mode==='different')record.snapshot.compiledPrompt.future.push('new original fact');
    if(mode==='missing')delete record.snapshot.compiledPrompt;
    if(mode==='payload-only'){record.snapshot.payload.compiledPrompt=record.snapshot.compiledPrompt;delete record.snapshot.compiledPrompt;}
    const saved=record.compiledPrompt;prepare(record,record.snapshot,project).apply();assert.equal(record.compiledPrompt,saved);
    assert.equal(record.compositionDecision,undefined);
  }
});
test('canonical key order can differ but every unknown field must match before release',()=>{
  const record=row();record.compiledPrompt={future:structuredClone(record.snapshot.compiledPrompt.future),prompt:'完整提示'};
  prepare(record,record.snapshot,project).apply();assert.equal(record.compiledPrompt,undefined);
  const changed=row();changed.compiledPrompt.unknown='only copy';prepare(changed,changed.snapshot,project).apply();assert.equal(changed.compiledPrompt.unknown,'only copy');
});
test('snapshot-only world identity and director approval become equivalent light metadata before inline removal',()=>{
  const record=row();delete record.shotSpec;record.snapshot.productionContext=production();record.snapshot.shotSpec={directorDecision:decision()};
  const source=record.snapshot,before=project(record),policy=storyboardProductionDeliveryPolicy(record,{target:'latest'});
  prepare(record,source,project).apply();delete record.snapshot;
  assert.deepEqual(project(record),before);assert.deepEqual(storyboardProductionDeliveryPolicy(record,{target:'latest'}),policy);
  assert.equal(record.productionContext.packetId,'p');assert.equal(record.directorDecision.decisionId,'decision-a');assert.equal(policy.target,'gallery');
  assert.deepEqual(source.shotSpec.directorDecision,decision());
});
test('compiled-only world metadata survives duplicate release and preserves complete visible approval projection',()=>{
  const record=row();record.compiledPrompt={productionContext:production(),validation:{shot:{directorDecision:decision()}},unknown:{keep:'原件'}};
  record.snapshot.compiledPrompt=structuredClone(record.compiledPrompt);const before=project(record),source=structuredClone(record.snapshot);
  prepare(record,record.snapshot,project).apply();delete record.snapshot;
  assert.equal(record.compiledPrompt,undefined);assert.deepEqual(project(record),before);assert.equal(source.compiledPrompt.unknown.keep,'原件');
  assert.deepEqual(record.directorDecision.lanes.dialogue,['完整原句']);
});
test('conflicting narrative contexts retain the same deny projection rather than becoming a permitted ordinary image',()=>{
  const record=row();record.productionContext={...production(),narrativeContext:{invalid:true}};
  record.snapshot.productionContext={...production(),narrativeContext:{invalid:true}};
  const before=project(record),policy=storyboardProductionDeliveryPolicy(record,{target:'latest',inlineByDefault:true});
  prepare(record,record.snapshot,project).apply();delete record.snapshot;
  assert.deepEqual(project(record),before);assert.deepEqual(storyboardProductionDeliveryPolicy(record,{target:'latest',inlineByDefault:true}),policy);
  assert.equal(policy.requiresExplicitInsert,true);
});
test('unrepresentable provenance keeps the inline original and never overwrites pre-existing light metadata',()=>{
  const record=row();record.productionContext=production();record.snapshot.productionContext={...production(),narrativeContext:{invalid:true}};
  const before=structuredClone(record);assert.throws(()=>prepare(record,record.snapshot,project),/来源/);assert.deepEqual(record,before);
});
test('invalid or revoked decisions stay invalid or revoked after moving an equivalent projection',()=>{
  for(const change of [d=>{d.status='revoked';},d=>{d.schema='future-unknown';},d=>{d.approval.mode='none';},d=>{d.source={};}]){
    const record=row(),d=decision();change(d);delete record.shotSpec;record.snapshot.shotSpec={directorDecision:d};
    const before=project(record);prepare(record,record.snapshot,project).apply();delete record.snapshot;assert.deepEqual(project(record),before);
  }
});
test('plain or unusual values and unmatched future fields are retained without normalization',()=>{
  for(const value of [null,0,'text',false,[]]){const record=row();record.compiledPrompt=value;record.snapshot.compiledPrompt=structuredClone(value);
    prepare(record,record.snapshot,project).apply();assert.deepEqual(record.compiledPrompt,value);}
});
test('invalid source identity, missing projector and getters are rejected without reading accessors',()=>{
  const record=row();assert.throws(()=>prepare(record,structuredClone(record.snapshot),project));assert.throws(()=>prepare(record,record.snapshot));
  let getters=0;const snapshot=record.snapshot;Object.defineProperty(record,'snapshot',{enumerable:true,configurable:true,get(){getters++;return snapshot;}});
  assert.throws(()=>prepare(record,snapshot,project));assert.equal(getters,0);
  const other=row();Object.defineProperty(other.compiledPrompt,'bad',{enumerable:true,get(){getters++;return 'bad';}});
  assert.throws(()=>prepare(other,other.snapshot,project));assert.equal(getters,0);
});
test('non-editable metadata or inline descriptors cannot start a partial release',()=>{
  for(const field of ['snapshot','chatKey','snapshotRef','snapshotServerRef','snapshotVersion']){
    const record=row();Object.defineProperty(record,field,{value:field==='snapshot'?record.snapshot:'old',enumerable:true,writable:false,configurable:false});
    const before=JSON.stringify(record);assert.throws(()=>prepare(record,record.snapshot,project));assert.equal(JSON.stringify(record),before);
  }
  const record=row();Object.preventExtensions(record);assert.throws(()=>prepare(record,record.snapshot,project));
});
test('a changed record between preparation and release cannot discard the newer content',()=>{
  for(const mode of ['compiled','snapshot','unknown','freeze']){const record=row(),plan=prepare(record,record.snapshot,project);
    if(mode==='compiled')record.compiledPrompt.future.push('edit');if(mode==='snapshot')record.snapshot.prompt='new';
    if(mode==='unknown')record.future.keep=false;if(mode==='freeze')Object.freeze(record);
    const before=JSON.stringify(record);assert.throws(()=>plan.apply());assert.equal(JSON.stringify(record),before);
  }
});
test('rollback restores only this operation and exactly restores missing-property state',()=>{
  const record=row();delete record.shotSpec;record.snapshot.shotSpec={directorDecision:decision()};record.snapshot.productionContext=production();
  const before=structuredClone(record),plan=prepare(record,record.snapshot,project);plan.apply();assert.ok(record.directorDecision);plan.rollback();plan.rollback();assert.deepEqual(record,before);
});
test('rollback does not overwrite newer duplicate fields or in-place edits to installed provenance',()=>{
  const record=row();delete record.shotSpec;record.snapshot.productionContext=production();record.snapshot.shotSpec={directorDecision:decision()};
  const plan=prepare(record,record.snapshot,project);plan.apply();record.compiledPrompt={newer:true};record.productionContext.packetId='newer';record.directorDecision.status='revoked';plan.rollback();
  assert.deepEqual(record.compiledPrompt,{newer:true});assert.equal(record.productionContext.packetId,'newer');assert.equal(record.directorDecision.status,'revoked');
  assert.deepEqual(record.compositionDecision,record.snapshot.compositionDecision);
});

function external(){const record=row(),snapshot=record.snapshot;delete record.snapshot;record.snapshotServerRef={version:1,id:'caller-verified-reference'};return {record,snapshot};}
test('external release is explicit and retains the recipe, reference and absent-inline state',()=>{
  const {record,snapshot}=external(),before=structuredClone(snapshot),ref=record.snapshotServerRef,plan=prepareExternal(record,snapshot,project);
  assert.equal(plan.changed,true);plan.apply();assert.equal(Object.hasOwn(record,'snapshot'),false);assert.equal(record.compiledPrompt,undefined);
  assert.equal(record.compositionDecision,undefined);assert.equal(record.snapshotServerRef,ref);assert.deepEqual(snapshot,before);assert.ok(record.shotSpec);
});
test('external recipe metadata repairs absent light provenance without inventing or overriding an existing field',()=>{
  const {record,snapshot}=external();delete record.shotSpec;snapshot.productionContext=production();snapshot.shotSpec={directorDecision:decision()};
  const expected=project({...record,snapshot}),plan=prepareExternal(record,snapshot,project);plan.apply();assert.deepEqual(project(record),expected);
  assert.equal(record.productionContext.packetId,'p');assert.equal(record.directorDecision.decisionId,'decision-a');plan.rollback();
  assert.equal(Object.hasOwn(record,'productionContext'),false);assert.equal(Object.hasOwn(record,'directorDecision'),false);assert.equal(Object.hasOwn(record,'snapshot'),false);
  const conflict=external();conflict.record.productionContext=production();conflict.snapshot.productionContext={...production(),narrativeContext:{invalid:true}};
  const before=structuredClone(conflict.record);assert.throws(()=>prepareExternal(conflict.record,conflict.snapshot,project));assert.deepEqual(conflict.record,before);
});
test('external release is a no-op when neither a complete duplicate nor missing provenance can move',()=>{
  const {record,snapshot}=external();record.compiledPrompt.onlyCopy=true;record.compositionDecision.onlyCopy=true;
  const before=structuredClone(record),plan=prepareExternal(record,snapshot,project);assert.equal(plan.changed,false);plan.apply();assert.deepEqual(record,before);
});
test('external recipe cannot use inline, unavailable, unreferenced or changed source data',()=>{
  for(const mode of ['inline','null-inline','unavailable','missing-ref','source-edit','ref-edit','record-edit']){
    const {record,snapshot}=external();
    if(mode==='inline')record.snapshot=snapshot;if(mode==='null-inline')record.snapshot=null;
    if(mode==='unavailable')record.recipeUnavailable=true;if(mode==='missing-ref')delete record.snapshotServerRef;
    if(['source-edit','ref-edit','record-edit'].includes(mode)){
      const plan=prepareExternal(record,snapshot,project);if(mode==='source-edit')snapshot.future='new';
      if(mode==='ref-edit')record.snapshotServerRef.id='new';if(mode==='record-edit')record.compiledPrompt.future.push('new');
      const before=structuredClone(record);assert.throws(()=>plan.apply());assert.deepEqual(record,before);
    }else assert.throws(()=>prepareExternal(record,snapshot,project));
  }
});
