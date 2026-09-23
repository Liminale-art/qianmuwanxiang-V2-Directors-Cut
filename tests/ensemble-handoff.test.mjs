import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import {attachEnsembleCompilerResult,sealEnsembleCompilerResult,resolveEnsembleCompiledRoutes} from '../qianmu-ensemble-handoff.js?v=1.59.338';
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  let live=true,hook=null;const calls=[];
  const result={shouldGenerate:true,shots:Array.from({length:3},(_,i)=>({id:'draft-'+i,prompt:'scene '+i,negative:'',paragraphIndex:i,shotType:'environment',sensitive:false,
    shotSpec:normalizeStoryboardShotSpec({id:'spec-'+i,subject:'scene '+i,scene:'room',characters:[],composition:{ratioId:'3:2'},promptAtoms:{global:['scene '+i]}})}))};
  const receipt={namespace:'st-user:fixture',chatKey:'chat-a',preparationId:'prep-1',selectionRevision:'selection-1',executionAuthorized:false,
    assignments:result.shots.map((_,i)=>({shotId:'S'+(i+1),schemeId:'S'+(i+1),revision:'r1',bindingKey:String(i+1).repeat(64)}))};
  const session={assertCurrent(){if(!live)throw Error('expired');},async resolveAssignment(value,id){this.assertCurrent();assert.equal(value,receipt);calls.push(id);if(hook)await hook();this.assertCurrent();return {...receipt.assignments.find(row=>row.shotId===id),route:{providerId:'novel',modelId:id},artistPresetId:'artist-'+id};}};
  const bind=()=>attachEnsembleCompilerResult(result,{session,receipt});
  return {result,receipt,session,calls,bind,seal:()=>sealEnsembleCompilerResult(result,async()=>{session.assertCurrent();}),resolve:planned=>resolveEnsembleCompiledRoutes(result,planned,{guard:async()=>{session.assertCurrent();}}),stop:()=>{live=false;},set hook(value){hook=value;}};
}
test('legacy results do not acquire a style marker, resolver calls or additional scope requirements',async()=>{
  const result={shouldGenerate:true,shots:[]};assert.equal(await sealEnsembleCompilerResult(result),false);assert.equal(await resolveEnsembleCompiledRoutes(result,[]),null);assert.equal(result.ensembleRequired,undefined);
});
test('model S ids bind to exact newly minted draft ids; coverage may drop earlier shots without renumbering their style',async()=>{
  const f=fixture();f.bind();await f.seal();const planned=copy(f.result.shots.slice(1)),resolved=await f.resolve(planned);
  assert.deepEqual(resolved.routes.map(r=>r.modelId),['S2','S3']);assert.deepEqual(resolved.artistPresetIds,['artist-S2','artist-S3']);assert.equal(resolved.executionAuthorized,false);assert.ok(Object.isFrozen(resolved.routes[0]));
  await resolved.assertCurrent();assert.deepEqual(f.calls,['S1','S2','S3','S2','S3']);
  assert.deepEqual(resolved.origins.map(row=>[row.shotId,row.schemeId,row.revision,row.bindingKey]),[['S2','S2','r1','2'.repeat(64)],['S3','S3','r1','3'.repeat(64)]]);
  assert.ok(Object.isFrozen(resolved.origins[0]));assert.equal(resolved.origins[0].executionAuthorized,false);
  assert.deepEqual(resolved.stages.map(row=>row.input.shot),['S2','S3']);assert.deepEqual(resolved.stages.map(row=>row.output.schemeId),['S2','S3']);
});
test('serialized, cloned and forged marked results cannot be promoted to a live handoff',async()=>{
  const f=fixture();f.bind();await f.seal();for(const result of [copy(f.result),{...f.result},{shouldGenerate:true,shots:f.result.shots,ensembleRequired:true}]){
    await assert.rejects(sealEnsembleCompilerResult(result,async()=>{}),{code:'ensemble_handoff'});await assert.rejects(resolveEnsembleCompiledRoutes(result,result.shots,{guard:async()=>{}}),{code:'ensemble_handoff'});
  }
});
test('an unsealed, duplicated or mismatched compiler attachment is rejected',async()=>{
  const f=fixture();f.bind();assert.throws(f.bind,{code:'ensemble_handoff'});await assert.rejects(f.resolve(f.result.shots),{code:'ensemble_handoff'});
  for(const change of [g=>g.receipt.assignments.pop(),g=>g.receipt.assignments.reverse(),g=>g.result.shots[1].id=g.result.shots[0].id,g=>g.receipt.executionAuthorized=true]){const g=fixture();change(g);assert.throws(g.bind,{code:'ensemble_handoff'});}
});
test('casting changes before sealing are retained but later visual or prompt edits retire the old selection',async()=>{
  const f=fixture();f.bind();f.result.shots[0].prompt='verified cast remap';await f.seal();assert.equal((await f.resolve(copy(f.result.shots))).routes.length,3);
  f.result.shots[0].shotSpec.subject='different scene';await assert.rejects(f.resolve(f.result.shots),{code:'ensemble_handoff'});
});
test('reordered, invented, duplicated or changed planned shots cannot consume original style choices',async()=>{
  for(const change of [p=>p.reverse(),p=>p.push(copy(p[0])),p=>p[0].id='new',p=>p[0].prompt='different',p=>p[0].paragraphIndex=99,p=>p[0].shotSpec.scene='elsewhere']){
    const f=fixture();f.bind();await f.seal();const planned=copy(f.result.shots);change(planned);await assert.rejects(f.resolve(planned),{code:'ensemble_handoff'});
  }
});
test('program-controlled output ratio changes do not invent narrative changes or select a different style',async()=>{
  const f=fixture();f.bind();await f.seal();const planned=copy(f.result.shots);planned[0].shotSpec.composition.ratioId='1:1';planned[0].shotSpec.composition.ratioLocked=true;
  assert.deepEqual((await f.resolve(planned)).routes.map(r=>r.modelId),['S1','S2','S3']);
});
test('replacement or reordering of actual compiler shot objects is not accepted as a cast remap',async()=>{
  for(const change of [r=>r.shots.reverse(),r=>r.shots[0]=copy(r.shots[0]),r=>r.shots[0].id='changed']){const f=fixture();f.bind();change(f.result);await assert.rejects(f.seal(),{code:'ensemble_handoff'});}
});
test('seal captures content across asynchronous binding checks and cannot be doubled',async()=>{
  const f=fixture();f.bind();f.hook=async()=>{f.result.shots[0].prompt='late edit';};await assert.rejects(f.seal(),{code:'ensemble_handoff'});
  const g=fixture();g.bind();let release,reached;const started=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});g.hook=async()=>{reached();await gate;};
  const sealing=g.seal();await started;await assert.rejects(g.seal(),{code:'ensemble_handoff'});release();await sealing;await assert.rejects(g.seal(),{code:'ensemble_handoff'});
});
test('source failure or a closed binding cannot be hidden by copied results or re-resolving a route',async()=>{
  const f=fixture();f.bind();await f.seal();const result=await f.resolve(copy(f.result.shots));f.stop();await assert.rejects(result.assertCurrent(),/expired/);await assert.rejects(f.resolve(f.result.shots),/expired/);
});
test('late planned-list changes are checked before returning a batch or accepting its later current check',async()=>{
  const f=fixture();f.bind();await f.seal();const planned=copy(f.result.shots);f.hook=async()=>{planned.pop();};await assert.rejects(f.resolve(planned),{code:'ensemble_handoff'});
  const g=fixture();g.bind();await g.seal();const next=copy(g.result.shots),batch=await g.resolve(next);next[0].negative='new';await assert.rejects(batch.assertCurrent(),{code:'ensemble_handoff'});
});
test('missing binding resolver and a false source guard cannot seal purported style results',async()=>{
  const f=fixture();assert.throws(()=>attachEnsembleCompilerResult(f.result,{session:{assertCurrent(){}},receipt:f.receipt}),{code:'ensemble_handoff'});
  f.bind();await assert.rejects(sealEnsembleCompilerResult(f.result,async()=>false),{code:'ensemble_handoff'});
});
