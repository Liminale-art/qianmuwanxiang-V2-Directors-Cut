import test from 'node:test';
import assert from 'node:assert/strict';
import {compareStoryboardSceneFingerprints,buildStoryboardSceneCoverageMap,prepareStoryboardShotGroup,normalizeStoryboardShotSpec,normalizeStoryboardState,createStoryboardWorkflowTicket} from '../qianmu-storyboard.js';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const shot=(id,layer,overrides={})=>({id,sourceParagraphIds:[id],narrativeLayer:layer,sceneId:'same-id',location:'kitchen',scene:'Alice in the kitchen',subject:'Alice',narrativePurpose:'Alice reads a letter',shotRole:'action',shotScale:'medium_shot',characters:[],composition:{},promptAtoms:{},...overrides});

test('same explicit scene ID never overrides a change between present, memory, fantasy, dream or imagined',()=>{
  for(const a of ['present','memory','fantasy','dream','imagined'])for(const b of ['present','memory','fantasy','dream','imagined']){
    const compared=compareStoryboardSceneFingerprints({sceneId:'one',narrativeLayer:a},{sceneId:'one',narrativeLayer:b});
    assert.equal(compared.sameScene,a===b);if(a!==b)assert.deepEqual(compared.reasons,['narrative_layer_changed']);
  }
  assert.equal(compareStoryboardSceneFingerprints({sceneId:'a'},{sceneId:'b'}).sameScene,false);
});

test('duplicated visual framing in a memory is not discarded as a duplicate of the present frame',()=>{
  const output=prepareStoryboardShotGroup({shots:[shot('present','present'),shot('memory','memory')],maxShots:2});
  assert.equal(output.shots.length,2,JSON.stringify(output.skipped));assert.equal(output.sceneGroups.length,2);assert.equal(output.coverageMap[1].transition,true);
  assert.deepEqual(output.sceneGroups.map(group=>group.sceneFingerprint.narrativeLayer),['present','memory']);
});

test('a stale nested fingerprint cannot move an edited shot into another narrative layer or alter its original stored rendering facts',()=>{
  const a=normalizeStoryboardShotSpec(shot('a','present')),b=structuredClone(a);b.id='b';b.narrativeLayer='memory';
  const before=JSON.stringify([a,b]),coverage=buildStoryboardSceneCoverageMap([a,b]);
  assert.equal(coverage[1].transition,true);assert.equal(coverage[1].sceneFingerprint.narrativeLayer,'memory');assert.equal(JSON.stringify([a,b]),before);
});

test('non-present outfits and actions remain on their shots without overwriting or aging the present-world ledger',()=>{
  const facts=[{id:'off',category:'outfit',subject:'Alice',key:'coat',value:'removed',persistence:'persistent'},
    {id:'glance',category:'action',subject:'Alice',key:'gaze',value:'looks at Bob',persistence:'momentary'}];
  const present=shot('now','present',{continuityUpdates:{outfit:{Alice:'coat removed'},time:'evening',facts}});
  for(const layer of ['memory','fantasy','dream','imagined']){
    const flash=shot('other',layer,{continuityUpdates:{outfit:{Alice:'coat worn'},time:'yesterday',facts:[{id:'on',category:'outfit',subject:'Alice',key:'coat',value:'worn'}]}});
    const output=prepareStoryboardShotGroup({manual:true,shots:[present,flash]});
    assert.equal(output.continuityLedger.outfit.Alice,'coat removed');assert.equal(output.continuityLedger.time,'evening');
    assert.equal(output.continuityLedger.facts.find(row=>row.id==='glance').status,'active');assert.equal(output.continuityLedger.facts.some(row=>row.id==='on'),false);
    assert.equal(output.shots[1].continuityUpdates.facts[0].id,'on');
    const returned=prepareStoryboardShotGroup({manual:true,shots:[present,flash,shot('return','present')]});
    assert.equal(returned.continuityLedger.facts.find(row=>row.id==='glance').status,'expired');
  }
});

test('a memory-only batch retains its own continuity; an explicitly different prior layer is not inherited',()=>{
  const memory=shot('memory','memory',{continuityUpdates:{axis:'memory axis',props:{letter:'Alice'}}});
  const output=prepareStoryboardShotGroup({manual:true,shots:[memory,shot('memory-2','memory',{continuityUpdates:{actionState:{Alice:'reading'}}})]});
  assert.equal(output.continuityLedgerLayer,'memory');assert.equal(output.continuityLedger.axis,'memory axis');assert.equal(output.continuityLedger.props.letter,'Alice');assert.equal(output.continuityLedger.actionState.Alice,'reading');
  const restored=prepareStoryboardShotGroup({manual:true,shots:[shot('now','present')],continuityLedger:output.continuityLedger,continuityLedgerLayer:output.continuityLedgerLayer});
  assert.equal(restored.continuityLedgerLayer,'present');assert.equal(restored.continuityLedger.props.letter,undefined);assert.equal(restored.continuityLedger.axis,'');
  const mixed=prepareStoryboardShotGroup({manual:true,shots:[memory,shot('now','present',{continuityUpdates:{axis:'present axis'}})]});
  assert.equal(mixed.continuityLedger.axis,'present axis');assert.equal(mixed.continuityLedger.props.letter,undefined);assert.equal(mixed.shots[0].continuityUpdates.props.letter,'Alice');
});

test('aggregate-layer identity survives ticket creation, JSON normalization and lightweight archive summaries',()=>{
  const context=vm.createContext({clone:structuredClone});vm.runInContext(section('storyboardPlanLightweightSummary'),context);
  const ticket=createStoryboardWorkflowTicket({continuityLedgerLayer:'memory',continuityLedger:{props:{letter:'Alice'}}});
  const state=normalizeStoryboardState({shotPlans:[{...ticket,id:'memory-plan'},{id:'legacy'},{id:'bad',continuityLedgerLayer:'untrusted-layer',continuityLedger:{axis:'wrong'}}]});
  assert.deepEqual(state.shotPlans.map(plan=>plan.continuityLedgerLayer),['memory','','[invalid]']);
  const compact=context.storyboardPlanLightweightSummary(state.shotPlans[0],'archive-key');assert.equal(compact.continuityLedgerLayer,'memory');assert.equal(compact.continuityLedger,null);
  assert.equal(normalizeStoryboardState(JSON.parse(JSON.stringify({shotPlans:[compact]}))).shotPlans[0].continuityLedgerLayer,'memory');
  const ignored=prepareStoryboardShotGroup({shots:[shot('now','present')],continuityLedgerLayer:'[invalid]',continuityLedger:{axis:'wrong'}});assert.equal(ignored.continuityLedger.axis,'');
});
