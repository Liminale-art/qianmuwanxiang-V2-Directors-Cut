import test from 'node:test';
import assert from 'node:assert/strict';
import {configureEnsembleSceneContinuation as configure,captureEnsembleSceneAnchor as capture} from '../qianmu-ensemble-continuation.js';
import {ENSEMBLE_STYLE_ORIGIN_SCHEMA} from '../qianmu-ensemble-origin.js';
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  let live=true;const check=()=>{if(!live)throw Error('stale');};
  const origin={schema:ENSEMBLE_STYLE_ORIGIN_SCHEMA,namespace:'st-user:test',chatKey:'chat-a',preparationId:'old',selectionRevision:'r1',shotId:'S1',schemeId:'ink',revision:'v1',bindingKey:'a'.repeat(64),executionAuthorized:false};
  const paragraphs=[{id:'P1',text:'Alice is in the kitchen.'},{id:'P2',text:'A cup on the kitchen table.'}];
  const moment={version:1,paragraphId:'P1',branchId:'present',layer:'present',quote:paragraphs[0].text,start:0,end:paragraphs[0].text.length,subject:'Alice',insertAfter:'P1',sourceIds:['P1']};
  const job={ensembleStyleOrigin:origin,shotSpec:{sceneFingerprint:{location:'kitchen'},continuityUpdates:{time:'day'}}};
  const history={namespace:'st-user:test',rows:[{id:'a'.repeat(64),anchor:capture(job,moment)}]};
  const session={enabled:true,styleLock:true,assertCurrent:check,verifyOrigin(value){check();assert.deepEqual(value,origin);return 'ink';}};
  const window={assertCurrent:check,current:{messageRef:{chatKey:'chat-a'},paragraphs}};
  const schema={properties:{shots:{items:{properties:{},required:[]}}}},payload={};
  const shot={scene_predecessor:'E1',state_point:{branchId:'present',paragraphId:'P2',evidence:paragraphs[1].text},narrative_layer:'present',source_paragraph_ids:['P2'],insert_after:'P2',subject:'cup',scene:{location:'kitchen',time:'day'},composition:{continuity_key:'new-scene-label'}};
  return {origin,history,session,window,schema,payload,shot,job,moment,open:()=>configure({history,session,window,schema,payload}),stop:()=>{live=false;}};
}

test('only bounded narrative anchor data reaches the director; explicit inheritance resolves its exact scheme',()=>{
  const f=fixture(),control=f.open();assert.deepEqual(f.schema.properties.shots.items.properties.scene_predecessor.enum,['','E1']);
  assert.doesNotMatch(JSON.stringify(f.payload),/st-user|schemeId|bindingKey|selectionRevision|ink/);
  assert.equal(control.validate({shots:[f.shot]}),true);assert.deepEqual(control.resolve({shots:[f.shot]}),[{shotId:'S1',schemeId:'ink'}]);
});

test('six distinct prior logical shots fit a floor while a seventh remains outside the narrative cap',()=>{
  const f=fixture(),row=copy(f.history.rows[0]);
  f.history.rows=Array.from({length:6},(_,i)=>({...copy(row),id:String(i+1).repeat(64)}));
  f.open();assert.equal(f.payload.prior_scene_anchors.length,6);
  f.history.rows.push({...copy(row),id:'7'.repeat(64)});assert.throws(f.open,{code:'ensemble_scene_continuation'});
});

test('a similar scene name without an explicit predecessor never inherits style',()=>{
  const f=fixture(),control=f.open();f.shot.scene_predecessor='';assert.deepEqual(control.resolve({shots:[f.shot]}),[]);
});

test('unknown, future, cross-branch, cross-layer, changed-place and time-jump anchors cannot be inherited',()=>{
  for(const change of [f=>f.shot.scene_predecessor='E99',f=>f.shot.state_point.branchId='past',f=>f.shot.narrative_layer='memory',f=>f.shot.scene.location='street',f=>f.shot.scene.time='tomorrow',
    f=>{f.history.rows[0].anchor=copy(f.history.rows[0].anchor);f.history.rows[0].anchor.moment.paragraphId='P2';f.shot.state_point={branchId:'present',paragraphId:'P1',evidence:f.window.current.paragraphs[0].text};f.shot.source_paragraph_ids=['P1'];f.shot.insert_after='P1';}]){
    const f=fixture();change(f);assert.throws(()=>f.open().validate({shots:[f.shot]}),{code:'ensemble_scene_continuation'});
  }
});

test('scope mismatch, malformed origins and conflicting duplicate historical slots stop before exposing an anchor',()=>{
  for(const change of [f=>f.history.namespace='st-user:other',f=>f.window.current.messageRef.chatKey='other',f=>f.history.rows[0].anchor={invalid:true},
    f=>{const row=copy(f.history.rows[0]);row.anchor.scene.time='night';f.history.rows.push(row);}]){const f=fixture();change(f);assert.throws(f.open,{code:'ensemble_scene_continuation'});}
});

test('disabled and empty history do not add a schema field, style dependency or prompt section',()=>{
  assert.equal(configure({session:{enabled:false,styleLock:true,assertCurrent(){assert.fail();}}}),null);
  const f=fixture();f.history.rows=[];assert.equal(f.open(),null);assert.deepEqual(f.payload,{});assert.deepEqual(f.schema.properties.shots.items.required,[]);
  assert.equal(capture({},f.moment),null);assert.deepEqual(capture({...f.job,safetyAdapted:true},f.moment),{invalid:true});
});

test('late source or style changes invalidate a continuation rather than falling back to current',()=>{
  const f=fixture(),control=f.open();f.stop();assert.throws(()=>control.resolve({shots:[f.shot]}),/stale/);
  const g=fixture(),next=g.open();g.session.verifyOrigin=()=>{throw Error('style changed');};assert.throws(()=>next.resolve({shots:[g.shot]}),/style changed/);
});
