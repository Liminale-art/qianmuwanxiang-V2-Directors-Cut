import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptStoryboardPlanContract,STORYBOARD_PLAN_RESPONSE_SCHEMA_ID} from '../qianmu-storyboard-contract.js';
const shot=(refs,layer='present',scene='kitchen',anchor=refs.at(-1))=>({source_paragraph_ids:refs,insert_after:anchor,narrative_layer:layer,narrative_purpose:'test',shot_role:'action',shot_scale:'medium_shot',subject:'A',scene:{location:scene,time:'evening',lighting:[],environment:[]},characters:[],shared_relations:[],composition:{continuity_key:scene},prompt_atoms:{},sensitive:false,safety_notes:[]});
const fact=(refs,value)=>({category:'outfit',subject:'A',key:'outerwear',value,persistence:'persistent',source_paragraph_ids:refs,evidence:'synthetic source'});
const plan=(shots,facts)=>({schema:STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,should_generate:true,skip_reason:'',shots,continuity_updates:facts,decisions:[]});
const options={paragraphIndexById:{P1:0,P2:1,P3:2,P4:3}},values=adapted=>adapted.shots.map(s=>s.shotSpec.continuityUpdates.facts.map(f=>f.value));
test('later coat removal and flashback state cannot leak into an earlier present shot through batch-wide copying',()=>{
 const input=plan([shot(['P1']),shot(['P2'],'memory','old-kitchen'),shot(['P3'])],[fact(['P1'],'coat on'),fact(['P2'],'old blue coat'),fact(['P3'],'coat off')]),before=structuredClone(input);
 const adapted=adaptStoryboardPlanContract(input,options);assert.deepEqual(values(adapted),[['coat on'],['old blue coat'],['coat off']]);assert.deepEqual(input,before);assert.deepEqual(adapted.continuity_updates,input.continuity_updates);
});
test('full-layer updates from unillustrated prose remain preserved but are not fabricated as facts for an unrelated shot',()=>{
 const input=plan([shot(['P1']),shot(['P3'])],[fact(['P2'],'coat off')]),adapted=adaptStoryboardPlanContract(input,options);assert.deepEqual(values(adapted),[[],[]]);assert.deepEqual(adapted.continuity_updates,input.continuity_updates,'later scene-ledger stage still owns the complete source batch');
});
test('every evidence paragraph must belong to the shot and be at or before its actual anchor; fallback floor zero is not provenance',()=>{
 const input=plan([shot(['P1','P3'],'present','kitchen','P1')],[fact(['P1'],'before'),fact(['P3'],'after'),fact(['P1','P2'],'outside')]);assert.deepEqual(values(adaptStoryboardPlanContract(input,options)),[['before']]);
 for(const lookup of [undefined,{P1:-1},{P1:'0'},{P1:NaN},Object.create({P1:0})])assert.deepEqual(values(adaptStoryboardPlanContract(input,{paragraphIndexById:lookup,fallbackParagraphIndex:0})),[[]]);
 assert.deepEqual(values(adaptStoryboardPlanContract(input,{paragraphIndexById:new Map(Object.entries(options.paragraphIndexById))})),[['before']]);
});
test('one paragraph shared across different time layers or scene branches is ambiguous, not permission to clone facts into both',()=>{
 for(const other of [shot(['P1'],'memory'),shot(['P1'],'present','elsewhere')]){
  const input=plan([shot(['P1']),other],[fact(['P1'],'ambiguous')]);assert.deepEqual(values(adaptStoryboardPlanContract(input,options)),[[],[]]);assert.equal(adaptStoryboardPlanContract(input,options).continuity_updates.length,1);
 }
 assert.deepEqual(values(adaptStoryboardPlanContract(plan([shot(['P1']),shot(['P1'])],[fact(['P1'],'same known branch')]),options)),[['same known branch'],['same known branch']]);
});
