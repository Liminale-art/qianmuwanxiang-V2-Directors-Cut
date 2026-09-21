import test from 'node:test';
import assert from 'node:assert/strict';
import {ensembleSelectionStages} from '../qianmu-ensemble-diagnostics.js';
import {normalizeStoryboardState,sanitizeStoryboardDiagnosticData} from '../qianmu-storyboard.js';
const fixture=()=>({receipt:{executionAuthorized:false,namespace:'st-user:private',assignments:[
  {shotId:'S1',schemeId:'ink',reason:'以留白强调眼前人物的静谧',bindingKey:'not-for-models'},
  {shotId:'S2',schemeId:'current',reason:''},{shotId:'S3',schemeId:'cg',reason:'空间层次更清晰'}]},
  catalogue:[{id:'current',name:'当前方案'},{id:'ink',name:'水墨',description:'not-for-this-shot'},{id:'cg',name:'真实 CG',apiKey:'must-not-copy',workflow:'must-not-copy'}]});

test('selection diagnostics follow exact kept shot ids and include only human names/reasons, not bindings or other styles',()=>{
  const f=fixture(),stages=ensembleSelectionStages(f.receipt,f.catalogue,['S2','S3']);
  assert.deepEqual(stages.map(row=>row.input.shot),['S2','S3']);assert.deepEqual(stages.map(row=>row.output.name),['当前方案','真实 CG']);
  assert.equal(stages[0].output.reason,'沿用当前方案');assert.equal(stages[1].decisions[1],'选择理由：空间层次更清晰');
  assert.doesNotMatch(JSON.stringify(stages),/st-user|bindingKey|apiKey|workflow|not-for|must-not|水墨/);
  assert.ok(Object.isFrozen(stages));assert.ok(Object.isFrozen(stages[0].output));assert.ok(Object.isFrozen(stages[0].decisions));
});

test('renaming or deleting a library later cannot change an already captured readable stage',()=>{
  const f=fixture(),stages=ensembleSelectionStages(f.receipt,f.catalogue,['S1']),before=JSON.stringify(stages);
  f.catalogue[1].name='后来改名';f.catalogue.splice(0);f.receipt.assignments[0].reason='后来改动';
  assert.equal(JSON.stringify(stages),before);assert.equal(stages[0].output.name,'水墨');
});

test('descriptive stages survive existing ST pipeline normalization without becoming execution authority',()=>{
  const f=fixture(),stages=ensembleSelectionStages(f.receipt,f.catalogue,['S1']);
  const state=normalizeStoryboardState({pipelineLogs:[{id:'p',taskId:'t',status:'queued',stages}]});
  const saved=state.pipelineLogs[0].stages[0];assert.equal(saved.type,'ensemble_style');assert.deepEqual(saved.output,stages[0].output);
  assert.deepEqual(saved.decisions,stages[0].decisions);assert.equal(saved.executionAuthorized,undefined);
  const scrubbed=sanitizeStoryboardDiagnosticData({...saved,output:{...saved.output,apiKey:'must-not-export'}});
  assert.doesNotMatch(JSON.stringify(scrubbed),/must-not-export/);
});
