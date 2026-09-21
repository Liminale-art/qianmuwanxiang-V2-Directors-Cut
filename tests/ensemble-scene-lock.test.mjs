import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnsembleSceneLock as create} from '../qianmu-ensemble-scene-lock.js';
const shot=(overrides={})=>({state_point:{branchId:'now'},narrative_layer:'present',scene:{location:'kitchen',time:'evening'},composition:{continuity_key:'kitchen-now'},...overrides});
const choices=(...styles)=>styles.map((scheme_id,index)=>({shot_id:`S${index+1}`,scheme_id,reason:'visual benefit'}));
const open=shots=>create({shots},{enabled:true,assertCurrent:()=>true});

test('a verified predecessor fixes its whole current scene while unrelated scenes remain free',()=>{
  const narrative={shots:[shot(),shot(),shot({scene:{location:'street',time:'night'}})]};
  const lock=create(narrative,{enabled:true,assertCurrent:()=>true,inherited:[{shotId:'S2',schemeId:'ink'}]});
  assert.equal(lock.constraints.groups[0].scheme_id,'ink');assert.equal(lock.constraints.groups[1].scheme_id,undefined);
  assert.equal(lock.validate(choices('ink','ink','cg')),true);assert.throws(()=>lock.validate(choices('cg','cg','cg')),{code:'ensemble_scene_lock'});
});

test('contradictory or invented inherited assignments cannot create a scene lock',()=>{
  for(const inherited of [[{shotId:'S3',schemeId:'ink'}],[{shotId:'S1',schemeId:'ink'},{shotId:'S1',schemeId:'ink'}],
    [{shotId:'S1',schemeId:'ink'},{shotId:'S2',schemeId:'cg'}]])assert.throws(()=>create({shots:[shot(),shot()]},{enabled:true,assertCurrent:()=>true,inherited}),{code:'ensemble_scene_lock'});
});

test('continuous shots lock one freely chosen style without changing narrative data or depending on response order',()=>{
  const narrative={shots:[shot(),shot(),shot()]},before=JSON.stringify(narrative),lock=create(narrative,{enabled:true,assertCurrent:()=>true});
  assert.deepEqual(lock.constraints.groups,[{id:'scene-1',leader_shot_id:'S1',shot_ids:['S1','S2','S3']}]);
  assert.equal(lock.validate(choices('ink','ink','ink').reverse()),true);assert.equal(lock.validate(choices('current','current','current')),true);
  assert.throws(()=>lock.validate(choices('ink','cg','ink')),{code:'ensemble_scene_lock'});assert.equal(JSON.stringify(narrative),before);
});

test('flashback and return preserve independent scene groups, not one style for the entire floor',()=>{
  const lock=open([shot(),shot({state_point:{branchId:'past'},narrative_layer:'memory'}),shot()]);
  assert.deepEqual(lock.constraints.groups.map(row=>row.shot_ids),[['S1','S3'],['S2']]);assert.equal(lock.validate(choices('cg','ink','cg')),true);
  assert.throws(()=>lock.validate(choices('cg','ink','current')),{code:'ensemble_scene_lock'});
});

test('explicit time, place, branch, narrative layer or continuity-key changes isolate otherwise identical labels',()=>{
  for(const other of [shot({scene:{location:'street',time:'evening'}}),shot({scene:{location:'kitchen',time:'next morning'}}),
    shot({state_point:{branchId:'other'}}),shot({narrative_layer:'imagined'}),shot({composition:{continuity_key:'later'}})]){
    const lock=open([shot(),other]);assert.equal(lock.constraints.groups.length,2);assert.equal(lock.validate(choices('ink','current')),true);
  }
});

test('framing, ratio, camera, cast, subject and light changes do not accidentally unlock the scene',()=>{
  const one=shot(),two=shot();two.composition={...two.composition,ratio_id:'9:16',angle:'overhead',focus:'cup'};two.characters=[];
  two.shot_scale='extreme_close_up';two.subject='cup';two.scene.lighting=['strong backlight'];const lock=open([one,two]);
  assert.equal(lock.constraints.groups.length,1);assert.throws(()=>lock.validate(choices('ink','cg')),{code:'ensemble_scene_lock'});
});

test('nonsemantic case and spacing do not split a continuous scene; arbitrary labels never enter the model lock payload',()=>{
  const lock=open([shot(),shot({scene:{location:' KITCHEN\n  ',time:'EVENING'}})]);
  assert.equal(lock.constraints.groups.length,1);assert.doesNotMatch(JSON.stringify(lock.constraints),/kitchen|evening|branch|prompt|apiKey/);
  assert.ok(Object.isFrozen(lock.constraints.groups[0].shot_ids));
});

test('disabled lock has zero narrative and lifecycle reads, allowing independent styles',()=>{
  assert.equal(create(null,{enabled:false,assertCurrent:()=>assert.fail('not used')}),null);
  assert.deepEqual(open([]).constraints.groups,[]);
});

test('duplicate, missing and invented shot assignments cannot silently become a valid scene lock',()=>{
  const lock=open([shot(),shot()]);for(const rows of [choices('ink'),[...choices('ink','ink'),...choices('ink')],
    [choices('ink')[0],choices('ink')[0]],[choices('ink')[0],{shot_id:'S3',scheme_id:'ink'}]])assert.throws(()=>lock.validate(rows),{code:'ensemble_scene_lock'});
});

test('cancellation, late source edits, malformed scene fields and asynchronous guards retire the constraint',async()=>{
  let active=true;const narrative={shots:[shot()]},lock=create(narrative,{enabled:true,assertCurrent:()=>active});active=false;
  assert.throws(()=>lock.validate(choices('ink')),{code:'ensemble_scene_lock'});active=true;narrative.shots[0].scene.time='night';assert.throws(()=>lock.assertCurrent(),{code:'ensemble_scene_lock'});
  for(const bad of [shot({state_point:{}}),shot({scene:{location:'',time:'day'}}),shot({composition:{continuity_key:'x'.repeat(241)}})])assert.throws(()=>open([bad]),{code:'ensemble_scene_lock'});
  assert.throws(()=>create({shots:[shot()]},{enabled:true,assertCurrent:async()=>{throw Error('late');}}),{code:'ensemble_scene_lock'});await Promise.resolve();
});
