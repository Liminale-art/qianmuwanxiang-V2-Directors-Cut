import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEnsembleStyleBindings} from '../qianmu-ensemble-bindings.js';
import {ENSEMBLE_LIBRARY_SCHEMA,ENSEMBLE_SELECTION_SCHEMA} from '../qianmu-ensemble-selection.js';
import {attachEnsembleCompilerResult,sealEnsembleCompilerResult} from '../qianmu-ensemble-handoff.js?v=1.59.324';
import {normalizeEnsembleRecoveryRecord,createEnsembleRecoveryRecord,restoreEnsembleRecoveryRecord} from '../qianmu-ensemble-recovery.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {routeEnvironment,namespace} from './helpers/comfy-route-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createEnsemblePlanStorage} from '../qianmu-ensemble-plan-storage.js';
const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture({keepFirst=false}={}){
  const e=await routeEnvironment(),profile=e.context.storyboardProviderProfile(e.state,'novel');
  e.state.routing.rules.push({id:'nai',enabled:true,target:{providerId:'novel',modelId:profile.model,capabilityModelId:profile.capabilityModelId,connectionPresetId:'',parameterPresetId:''}});
  e.state.artistPresets.push({id:'ink',name:'Ink',value:'artist:fixture'});
  const library={schema:ENSEMBLE_LIBRARY_SCHEMA,namespace,schemes:[{id:'ink',revision:'r1',name:'Ink',description:'留白',tags:[],archived:false,binding:{routeId:'nai',artistPresetId:'ink'}}]};
  const selection={schema:ENSEMBLE_SELECTION_SCHEMA,namespace,chatKey:'chat-a',revision:'r1',enabled:true,schemeIds:['ink'],styleLock:true};
  let active=true,preparations=0,checks=0;const guard=async()=>active,open=()=>prepareEnsembleStyleBindings({library,selection,namespace,chatKey:'chat-a',preparationId:'prepare-'+(++preparations),readState:()=>e.state,
    resolveProfile:({state,route})=>e.context.storyboardResolveRoutingProfile(state,route),assertCurrent:()=>active,guard,verifyTarget:async()=>({ready:true})});
  const result={shouldGenerate:true,shots:Array.from({length:3},(_,i)=>({id:'draft-'+i,prompt:'private scene '+i,negative:'bad',paragraphIndex:i,shotType:'environment',sensitive:false,
    shotSpec:normalizeStoryboardShotSpec({subject:'private scene '+i,scene:'room',characters:[],composition:{ratioId:'3:2'},promptAtoms:{global:['scene']}})}))};
  const first=await open(),receipt=first.session.resolve(result.shots.map((_,i)=>({shot_id:'S'+(i+1),scheme_id:i===1?'current':'ink',reason:i===1?'':'静谧留白'})),['S1','S2','S3']);
  attachEnsembleCompilerResult(result,{session:first.session,receipt});await sealEnsembleCompilerResult(result,guard);
  const scope={namespace,chatKey:'chat-a',planId:'plan-a',messageKey:'message-a',revisionId:'revision-a'};
  const record=await createEnsembleRecoveryRecord(result,{scope,guard});let saved=copy(record);if(!keepFirst)first.close();
  const session=(await open()).session;
  const options={scope,planned:copy(result.shots),session,guard,verifySaved:async value=>{checks++;return JSON.stringify(value)===JSON.stringify(saved);}};
  return {...e,library,selection,result,first,scope,record,options,open,checks:()=>checks,stop:()=>{active=false;},save:value=>{saved=value;}};
}
test('sealed selection becomes descriptive hashes without prompts, keys, route payloads or execution permission',async()=>{
  const f=await fixture();assert.equal(f.record.executionAuthorized,false);assert.ok(Object.isFrozen(f.record.shots[0]));assert.equal(f.record.shots.length,3);
  assert.doesNotMatch(JSON.stringify(f.record),/private scene|artist:fixture|apiKey|baseUrl|modelId|comfyWorkflow/);assert.match(f.record.shots[0].contentHash,/^[a-f0-9]{64}$/);
  await assert.rejects(createEnsembleRecoveryRecord(copy(f.result),{scope:f.scope,guard:async()=>true}),{code:'ensemble_handoff'});
});
test('a closed compiler can be recovered only through a new actual binding session and exact saved record verification',async()=>{
  const f=await fixture(),restored=await restoreEnsembleRecoveryRecord(copy(f.record),f.options);
  assert.deepEqual(restored.artistPresetIds,['ink','','ink']);assert.equal(restored.routes.length,3);assert.ok(Object.isFrozen(restored.routes[0]));assert.equal(restored.executionAuthorized,false);
  assert.equal(f.checks(),2);await restored.assertCurrent();assert.equal(f.checks(),3);assert.equal(f.jobs.length,0);
});
test('coverage may omit a mirror without shifting its original style or narrative order',async()=>{
  const f=await fixture(),restored=await restoreEnsembleRecoveryRecord(f.record,{...f.options,planned:f.options.planned.slice(1)});
  assert.deepEqual(restored.schemes.map(row=>row.shotId),['S2','S3']);assert.deepEqual(restored.artistPresetIds,['','ink']);
  assert.deepEqual(restored.origins.map(row=>[row.shotId,row.schemeId,row.revision,row.bindingKey]),f.record.shots.slice(1).map(row=>[row.shotId,row.schemeId,row.revision,row.bindingKey]));
  assert.equal(restored.origins[0].selectionRevision,f.record.selectionRevision);assert.equal(restored.origins[0].executionAuthorized,false);
  assert.deepEqual(restored.stages.map(row=>row.input.shot),['S2','S3']);assert.deepEqual(restored.stages.map(row=>row.output.name),['当前方案','Ink']);
  assert.equal(restored.stages[1].output.reason,'静谧留白');
});
test('recovery cannot substitute another account, chat, plan, message or revision',async()=>{
  for(const key of ['namespace','chatKey','planId','messageKey','revisionId']){const f=await fixture();await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,scope:{...f.scope,[key]:key==='namespace'?'st-user:other':'other'}}),{code:'ensemble_recovery'});assert.equal(f.jobs.length,0);}
});
test('unconfirmed, absent or modified saved records never authorize recovery',async()=>{
  for(const verifySaved of [undefined,async()=>false,async()=>({confirmed:true}),async()=>undefined]){const f=await fixture();await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,verifySaved}),{code:'ensemble_recovery'});}
  const f=await fixture();f.save({...copy(f.record),selectionRevision:'new'});await assert.rejects(restoreEnsembleRecoveryRecord(f.record,f.options),{code:'ensemble_recovery'});
});
test('edited, reordered, duplicated and invented mirrors cannot recover a stored selection',async()=>{
  for(const change of [rows=>rows.reverse(),rows=>rows.push(copy(rows[0])),rows=>rows[0].id='invented',rows=>rows[0].prompt='different',rows=>rows[0].negative='other',rows=>rows[0].paragraphIndex=9,rows=>rows[0].shotSpec.scene='elsewhere']){
    const f=await fixture();change(f.options.planned);await assert.rejects(restoreEnsembleRecoveryRecord(f.record,f.options),{code:'ensemble_recovery'});
  }
});
test('program controlled output sizing does not change visual content identity',async()=>{
  const f=await fixture();f.options.planned[0].shotSpec.composition.ratioId='1:1';f.options.planned[0].shotSpec.composition.ratioLocked=true;
  assert.equal((await restoreEnsembleRecoveryRecord(f.record,f.options)).routes.length,3);
});
test('changed chat selection revision or scheme revision cannot silently reuse a former model choice',async()=>{
  for(const change of [f=>f.selection.revision='r2',f=>f.library.schemes[0].revision='r2',f=>f.selection.enabled=false]){const f=await fixture();change(f);const fresh=await f.open();
    await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,session:fresh.session}));assert.equal(f.jobs.length,0);
  }
});
test('changed artist contents, route model and connection are detected even when descriptive scheme version is unchanged',async()=>{
  for(const change of [f=>f.state.artistPresets.find(row=>row.id==='ink').value='other artist',f=>{const row=f.state.routing.rules.find(row=>row.id==='nai');row.target.modelId='nai-diffusion-3';row.target.capabilityModelId='nai-diffusion-3';},f=>f.state.connections.novel.draft.apiKey='changed-fixture-key']){
    const f=await fixture();change(f);const fresh=await f.open();await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,session:fresh.session}));assert.equal(f.jobs.length,0);
  }
});
test('a false source guard or a retired fresh session cannot recover a selection',async()=>{
  const f=await fixture();await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,guard:async()=>false}),{code:'ensemble_recovery'});f.stop();await assert.rejects(restoreEnsembleRecoveryRecord(f.record,f.options));
});
test('late edits and source changes during native saved-record verification are rejected',async()=>{
  for(const change of [f=>f.options.planned.pop(),f=>f.options.planned[0].prompt='late edit',f=>f.scope.revisionId='later']){const f=await fixture();
    await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,verifySaved:async()=>{change(f);return true;}}),{code:'ensemble_recovery'});
  }
});
test('later current checks reverify saved state and retired technical bindings before a host could submit',async()=>{
  const f=await fixture(),restored=await restoreEnsembleRecoveryRecord(f.record,f.options);f.save(null);await assert.rejects(restored.assertCurrent(),{code:'ensemble_recovery'});
  const g=await fixture(),other=await restoreEnsembleRecoveryRecord(g.record,g.options);g.state.artistPresets=[];await assert.rejects(other.assertCurrent());
});
test('malformed, future, extra-field, excessive and executable records fail closed without truncation',async()=>{
  const f=await fixture();for(const change of [r=>r.schema='future',r=>r.executionAuthorized=true,r=>r.apiKey='untrusted',r=>r.shots.push(...Array.from({length:20},()=>copy(r.shots[0]))),r=>r.shots[0].contentHash='short',r=>r.shots[0].shotId='S2',r=>r.shots[0].reason='x'.repeat(601),r=>r.shots[0].route={providerId:'comfy'}]){
    const bad=copy(f.record);change(bad);assert.throws(()=>normalizeEnsembleRecoveryRecord(bad),{code:'ensemble_recovery'});
  }
});
test('issuance checks the private receipt account and chat rather than blessing a supplied scope',async()=>{
  const f=await fixture({keepFirst:true});await assert.rejects(createEnsembleRecoveryRecord(f.result,{scope:{...f.scope,chatKey:'other'},guard:async()=>true}),{code:'ensemble_recovery'});
  await assert.rejects(createEnsembleRecoveryRecord(f.result,{scope:{...f.scope,namespace:'st-user:other'},guard:async()=>true}),{code:'ensemble_recovery'});f.first.close();
});
test('scope changes during issuance fail before a recovery record can be returned',async()=>{
  const f=await fixture({keepFirst:true});await assert.rejects(createEnsembleRecoveryRecord(f.result,{scope:f.scope,guard:async()=>{f.scope.planId='different';return true;}}),{code:'ensemble_recovery'});f.first.close();
});
test('a lost final saved-record verification rejects the prepared routes without enqueueing',async()=>{
  const f=await fixture();let reads=0;await assert.rejects(restoreEnsembleRecoveryRecord(f.record,{...f.options,verifySaved:async()=>++reads===1}),{code:'ensemble_recovery'});assert.equal(reads,2);assert.equal(f.jobs.length,0);
});
test('native ST immutable file roundtrip verifies the exact record, then login failure invalidates its later use',async()=>{
  const f=await fixture(),transport=streamCheckpointTransport(namespace),storage=await createEnsemblePlanStorage({scope:f.scope,guard:()=>true,createStorage:transport.createStorage});
  try{await storage.save(f.record,await storage.read());
    const verifySaved=record=>storage.verify(record);
    const restored=await restoreEnsembleRecoveryRecord(copy(f.record),{...f.options,verifySaved});assert.equal(restored.routes.length,3);
    transport.hook=({json})=>json({},401);await assert.rejects(restored.assertCurrent(),{code:'st_account_storage_account'});assert.equal(f.jobs.length,0);
  }finally{storage.close();}
});
test('ordinary multiline model reasons remain intact rather than failing a previously valid expression contract',async()=>{
  const f=await fixture(),value=copy(f.record);value.shots[0].reason='光线留白\n保持安静';assert.equal(normalizeEnsembleRecoveryRecord(value).shots[0].reason,value.shots[0].reason);
});
