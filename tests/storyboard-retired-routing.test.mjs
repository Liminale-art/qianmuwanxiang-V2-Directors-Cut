import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {buildStoryboardPlanContractRequest} from '../qianmu-storyboard-contract.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

test('the non-focused contract cannot forward retired shot-group labels or narrative instructions',()=>{
  const request=buildStoryboardPlanContractRequest({floor:0,paragraphs:['Alice makes soup.']},{providerId:'novel',modelId:'nai-diffusion-5-full',maxShots:2,
    groupLabel:'OBSOLETE-GROUP',groupInstruction:'OBSOLETE-NARRATIVE-ORDER'});
  const payload=JSON.parse(request.messages[1].content);
  assert.equal(Object.hasOwn(payload.constraints,'shot_group'),false);
  assert.equal(Object.hasOwn(payload.constraints,'shot_group_rule'),false);
  assert.doesNotMatch(JSON.stringify(request.messages),/OBSOLETE-GROUP|OBSOLETE-NARRATIVE-ORDER/);
  assert.equal(payload.constraints.max_shots,2);
});

function sceneLinks({native=false,routes=null,failRestore=false}={}){
  const state=core.createStoryboardDefaults();state.source='comfy';state.view='create';state.comfyAutoEnabled=true;
  state.routing.enabled=true;state.routing.rules=[{id:'orphan',enabled:true,shotTypes:[],target:{providerId:'comfy',comfyWorkflowBinding:{id:'never-selected'}}}];
  const shots=[{id:'a',title:'Kitchen'},{id:'b',title:'Garden'}],groups=shots.map(shot=>({shotIds:[shot.id]}));
  const plan={id:'plan',revisionId:'rev',status:'prompt_ready',origin:'automatic',shots};state.shotPlans=[plan];
  state.promptDraft={planId:plan.id,shots,...(native?{ensembleRequired:true}:{})};
  if(native)plan.ensembleRecovery={fixture:'saved-selected-styles'};
  const counts={restored:0,verified:0,closed:0,disposed:0},inspected=[],children=[];
  const host={hidden:true,isConnected:true,textContent:'',replaceChildren(){children.length=0;},append(node){children.push(node);}};
  const root={isConnected:true,querySelector:()=>host},message={mes:'Current story',swipe_id:0};
  const manager={list:async()=>[],inspect:async scope=>{inspected.push(scope.id);return {};}};
  const context=vm.createContext({...core,storyboardState:()=>state,storyboardAdmissionEpoch:0,storyboardCaptureWorkbench(){},storyboardTargetFloor:()=>1,
    getChatKey:()=> 'chat-a',ctx:()=>({chat:[{},message]}),storyboardPlanForMessage:()=>plan,storyboardComfySceneRuntime:async()=>manager,
    storyboardPrepareDraftGroup:()=>({planned:shots,coverage:{sceneGroups:groups}}),storyboardComfyPlanScopes:async()=>new Map(shots.map(shot=>[shot.id,{id:shot.id,narrativeLayer:'present'}])),
    storyboardCreatePreparationGuard:()=>({assertCurrent(){},dispose(){counts.disposed++;}}),storyboardEnsembleHost:()=>({fixture:true}),
    featureRuntime:{load:async key=>{
      if(key==='imageAdmission')return {resolveImageAccountNamespace:async()=> 'st-user:scene'};
      if(key==='comfyScene')return {};
      if(key==='comfyAuto')return {readComfyStylePool:async()=>({styleLock:true,poolKey:'pool'})};
      if(key==='storyboardContract')return {restoreStoryboardEnsemblePlan:async(current,saved,planned)=>{
        counts.restored++;assert.equal(current,state);assert.equal(saved,plan);assert.equal(planned,shots);
        if(failRestore)throw Error('saved selected styles are stale');
        return {routes,assertCurrent:async()=>{counts.verified++;},close(){counts.closed++;}};
      }};
      assert.fail('unexpected feature '+key);
    }},htmlEscape:String,document:{createElement:()=>({innerHTML:'',querySelector:()=>({textContent:'',title:''})})},
  });
  vm.runInContext(section('storyboardShowComfySceneLinks'),context);
  return {state,host,counts,inspected,run:()=>context.storyboardShowComfySceneLinks(root)};
}

test('ordinary Comfy scene links ignore every unselected bare route and do not restore an unrelated ensemble',async()=>{
  const e=sceneLinks();await e.run();
  assert.deepEqual(e.inspected,['a','b']);assert.deepEqual(e.counts,{restored:0,verified:0,closed:0,disposed:0});
});

test('scene links use the modern frozen assignments and offer continuity only for current automatic Comfy shots',async()=>{
  const e=sceneLinks({native:true,routes:[{providerId:'comfy',comfyWorkflowBinding:{id:'fixed'}},{providerId:'comfy'}]});await e.run();
  assert.deepEqual(e.inspected,['b']);assert.deepEqual(e.counts,{restored:1,verified:1,closed:1,disposed:1});
});

test('fixed or closed-model native assignments never expose automatic Comfy continuity links',async()=>{
  const e=sceneLinks({native:true,routes:[{providerId:'comfy',comfyWorkflowBinding:{id:'fixed'}},{providerId:'novel'}]});await e.run();
  assert.deepEqual(e.inspected,[]);assert.match(e.host.textContent,/明确分工/);assert.equal(e.counts.closed,1);assert.equal(e.counts.disposed,1);
});

test('failed native scene-link restoration cannot fall back to current Comfy and releases its preparation',async()=>{
  const e=sceneLinks({native:true,failRestore:true});await e.run();
  assert.deepEqual(e.inspected,[]);assert.match(e.host.textContent,/saved selected styles are stale/);
  assert.equal(e.counts.restored,1);assert.equal(e.counts.closed,0);assert.equal(e.counts.disposed,1);
});
