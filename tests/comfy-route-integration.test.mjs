import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as runtime from '../qianmu-comfy-route.js';
import * as core from '../qianmu-storyboard.js';
import { retainComfyRoutePromptLayer } from '../qianmu-comfy-route-contract.js';
import { renderComfyRoutePicker } from '../qianmu-comfy-route-view.js';
import { recipesFixture, routeEnvironment, namespace, graph } from './helpers/comfy-route-fixture.mjs';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

test('fixed recipes isolate parameters, prompt additions, role activation and references from the workbench',async()=>{
  const f=await recipesFixture(),base={comfyCharacterEnabled:true,comfyCharacterActivation:{invalid:true},comfyReferences:{invalid:true},width:'512'};
  const before=structuredClone(base),a=runtime.applyComfyRouteRecipe(base,f.routes[0],f.recipes[0]),b=runtime.applyComfyRouteRecipe(base,{...f.routes[1],comfyCharacterEnabled:true},f.recipes[1]);
  assert.deepEqual(base,before);assert.equal(a.width,'832');assert.equal(b.width,'1216');assert.equal(a.count,'4');assert.equal(a.comfyCharacterEnabled,false);
  assert.equal(a.comfyCharacterActivation,undefined);assert.equal(a.comfyReferences,null);assert.equal(b.comfyCharacterActivation.workflow.id,'landscape');
  assert.equal(b.comfyCharacterActivation.workflow.hash,f.recipes[1].binding.workflowHash);
  assert.equal(a.comfyRoutePromptLayer.positive,'portrait quality');assert.equal(b.comfyRoutePromptLayer.negative,'landscape exclusions');
});

test('fixed references require matching account and graph; malformed and legacy style combinations fail explicitly',async()=>{
  const f=await recipesFixture(),reference={version:1,enabled:true,namespace,workflowHash:f.recipes[0].binding.workflowHash,
    items:[{url:'/user/images/test/ref.png',name:'ref',mime:'image/png',bytes:8,sha256:'a'.repeat(64)}]};
  const route={...f.routes[0],comfyReferences:reference};
  assert.deepEqual(runtime.applyComfyRouteRecipe({},route,f.recipes[0]).comfyReferences,reference);
  for(const invalid of [{...reference,namespace:'st-user:foreign'},{...reference,workflowHash:'b'.repeat(64)}])assert.throws(()=>runtime.applyComfyRouteRecipe({},{...route,comfyReferences:invalid},f.recipes[0]),{code:'comfy_route_binding'});
  assert.throws(()=>runtime.applyComfyRouteRecipe({},{...route,parameterPresetId:'old-style'},f.recipes[0]),{code:'comfy_route_binding'});
  assert.throws(()=>runtime.applyComfyRouteRecipe({},route,f.recipes[1]),{code:'comfy_route_binding'});
});

test('one preparation reads each exact version once, never opens a global cache or loads another engine',async()=>{
  const f=await recipesFixture();f.calls.length=0;
  const prepared=await runtime.prepareComfyRouteRecipes({routes:[...f.routes,f.routes[0],{providerId:'novel'}],namespace,createStore:f.createStore});
  assert.equal(f.calls.filter(call=>call[0]==='load').length,2);assert.equal(f.calls.filter(call=>call[0]==='close').length,2);
  f.rows[0].document.positivePrompt='new library edit';
  assert.equal(prepared.apply(f.routes[0],{}).comfyRoutePromptLayer.positive,'portrait quality');
  await assert.rejects(runtime.prepareComfyRouteRecipes({routes:f.routes,namespace,createStore:f.createStore}),{code:'comfy_route_binding'});
});

test('actual mixed pipeline freezes two independent Comfy graphs and one NAI job in narrative order, without multiplying count',async()=>{
  const e=await routeEnvironment();e.state.profiles.comfy.comfyCharacterEnabled=true;e.routes.forEach(route=>route.comfyCharacterEnabled=true);
  const globalBefore=structuredClone(e.state.profiles.comfy);
  assert.equal(await e.context.storyboardGenerate(null,{automatic:true}),true);assert.deepEqual(e.jobs.map(job=>job.source),['comfy','comfy','novel']);
  for(const [index,job] of e.jobs.entries()){
    assert.equal(job.inlineOrder.shotIndex,index);assert.equal(job.payload.parameters.count,1);
    assert.equal(job.profile.count,'1');assert.equal(job.automatic,true);
    if(index<2){assert.equal(job.profile.comfyRouteBinding.id,e.routes[index].comfyWorkflowBinding.id);
      assert.equal(job.profile.comfyWorkflow,e.recipes[index].document.workflow);assert.equal(job.payload.parameters.workflow,e.recipes[index].document.workflow);
      assert.doesNotMatch(job.payload.prompt,new RegExp(e.recipes[index].document.positivePrompt));
      assert.doesNotMatch(job.payload.negative,new RegExp(e.recipes[index].document.negativePrompt));assert.doesNotMatch(job.payload.prompt,/global quality/);
      assert.equal(job.profile.comfyCharacterEnabled,false);
    }
  }
  assert.deepEqual(e.state.profiles.comfy,globalBefore);assert.equal(e.context.storyboardGenerationPreparing.size,0);
  assert.equal(e.calls.includes('comfyCharacters'),false);
});

test('manual locked text keeps user text and fixed graph identity without retired extra prompt layers',async()=>{
  const e=await routeEnvironment();e.state.promptDraft.userEditedCompiled=true;
  e.state.promptDraft.shots=e.state.promptDraft.shots.slice(0,1);e.state.generationPolicy.maxImages=1;
  assert.equal(await e.context.storyboardGenerate(null,{automatic:false}),true);
  assert.equal(e.jobs.length,1);const job=e.jobs[0];assert.equal(job.profile.count,'4');assert.equal(job.requestTotal,1);
  assert.equal(job.payload.prompt,'woman reading a letter');
  const restored=core.normalizeStoryboardParameterProfile(job.profile,'comfy');
  assert.deepEqual(restored.comfyRouteBinding,e.recipes[0].binding);assert.deepEqual(restored.comfyRoutePromptLayer,{positive:'',negative:''});
  const clear=e.context.storyboardResolveRoutingProfile(e.state,{providerId:'comfy',modelId:'comfy-workflow'},restored);
  assert.equal(clear.comfyRouteBinding,undefined);assert.equal(clear.comfyRoutePromptLayer,undefined);
  assert.deepEqual(retainComfyRoutePromptLayer({positive:'',negative:'x'.repeat(12001)}),{invalid:true});
});

test('all reachable pinned routes are preflighted before LLM; distinct workflows are not conflated by model name',async()=>{
  const e=await routeEnvironment(),guard=e.context.storyboardCreatePreparationGuard(e.state);
  await e.context.storyboardPrepareComfyRoutes(e.state,guard);
  assert.equal(e.context.storyboardCertainCompilerRoute(e.state,e.state.profiles.novel),null);
  const reports=await e.context.storyboardPreflightComfyForCompiler(e.state,e.state.profiles.novel,null,guard,true);
  assert.equal(reports.length,2);assert.ok(reports.every(report=>report.localConfigurationReady&&!report.remoteExecutionVerified));
  e.state.routing.rules.unshift({id:'all',enabled:true,priority:100,shotTypes:[],target:{providerId:'novel',modelId:'nai-diffusion-5-full'}});
  const clean=e.context.storyboardCreatePreparationGuard(e.state);e.calls.length=0;
  assert.equal(await e.context.storyboardPrepareComfyRoutes(e.state,clean),null);assert.equal(e.calls.length,0);
  guard.dispose();clean.dispose();
});

test('invalid fixed selection stops the real generation with a concise notice and no queued request',async()=>{
  const e=await routeEnvironment();e.rows[1].archived=true;
  assert.equal(await e.context.storyboardGenerate(null),false);assert.equal(e.jobs.length,0);assert.match(e.notices.at(-1),/归档|不存在/);
  assert.equal(e.context.storyboardGenerationPreparing.size,0);
});

test('account epoch changes while resolving identity invalidate prepared routes even if the same account returns',async()=>{
  const e=await routeEnvironment(),guard=e.context.storyboardCreatePreparationGuard(e.state);let count=0;
  const load=e.context.featureRuntime.load;
  e.context.featureRuntime.load=async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>{if(++count===2)e.context.storyboardAdmissionEpoch++;return namespace;}}:load(key);
  await assert.rejects(e.context.storyboardPrepareComfyRoutes(e.state,guard),{code:'storyboard_input_changed'});assert.equal(guard.comfyRoutes,undefined);guard.dispose();
});

test('frozen replay validates original account and graph, without reading a newer or deleted library',async()=>{
  const e=await routeEnvironment();await e.context.storyboardGenerate(null,{automatic:true});const job=e.jobs[0];e.rows.length=0;e.calls.length=0;
  await e.context.storyboardVerifyComfyRouteJob(job);assert.deepEqual(e.calls,['comfyRoutes','imageAdmission']);
  e.setAccount('st-user:other');await assert.rejects(e.context.storyboardVerifyComfyRouteJob(job),{code:'comfy_route_binding'});
  e.setAccount(namespace);job.profile.comfyWorkflow=JSON.stringify(graph('tampered'));
  await assert.rejects(e.context.storyboardVerifyComfyRouteJob(job),{code:'comfy_route_binding'});
});

test('route picker markup escapes imported names and keeps selection separate from generation or workbench model choice',async()=>{
  const e=await routeEnvironment();e.state.routing.rules[0].target.comfyWorkflowBinding={...e.routes[0].comfyWorkflowBinding,name:'<script>bad</script>'};
  const target=e.context.storyboardRoutingTargetOptions(e.state,'comfy',e.state.routing.rules[0].target);
  assert.doesNotMatch(target,/<script>|sd-storyboard-route-model|sd-storyboard-route-parameters|sd-storyboard-route-characters/);assert.match(target,/&lt;script&gt;/);
  const picker=renderComfyRoutePicker({heads:[{id:'safe',name:'<img onerror=bad>'}],selectedId:'safe',roles:true});
  assert.doesNotMatch(picker,/<img|data-comfy-route-roles|提示补充/);assert.match(picker,/确认不会生成/);assert.match(picker,/disabled/);
});

test('binding UI saves only the explicit route selection, and cancellation or late page change preserve the prior target',async()=>{
  for(const scenario of ['save','cancel','changed']){
    const e=await routeEnvironment();e.state.view='assets';e.state.assetView='routing';const rule=e.state.routing.rules[0],before=JSON.stringify(rule.target),profile=JSON.stringify(e.state.profiles.comfy);
    const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>key==='comfyRoutes'?{...runtime,openComfyRoutePicker:async()=>{
      if(scenario==='changed')e.state.assetView='tags';return scenario==='cancel'?null:{recipe:e.recipes[1],roles:true,useReferences:false};
    }}:load(key);
    const root={isConnected:true};await e.context.storyboardBindRouteWorkflow(root,rule);
    assert.equal(root._sdRouteBindingBusy,false);assert.equal(JSON.stringify(e.state.profiles.comfy),profile);assert.equal(e.jobs.length,0);
    if(scenario==='save'){assert.equal(rule.target.comfyWorkflowBinding.id,'landscape');assert.equal(rule.target.comfyCharacterEnabled,false);assert.equal(rule.target.parameterPresetId,'');}
    else assert.equal(JSON.stringify(rule.target),before);
  }
});

test('actual compiler prepares fixed routes before LLM and rejects an account change during its response',async()=>{
  for(const scenario of ['valid','missing','account']){
    const e=await routeEnvironment(),chat=[{mes:'A woman reads a letter by a river.'}],plan={id:'plan',status:'screening'};
    if(scenario==='missing')e.rows[0].archived=true;
    let llm=0;
    const load=e.context.featureRuntime.load;
    Object.assign(e.context,{storyboardCompilerBusy:false,ctx:()=>({chat}),storyboardTargetFloor:()=>0,
      storyboardSetPlanStatus:(target,status,extra={})=>Object.assign(target,{status,...extra}),
      storyboardCompilerContext:async()=>({floor:0,paragraphs:[chat[0].mes],messages:[],worldRows:[]}),
      storyboardCompilerRequestConfig:()=>({}),storyboardCompilerResult:async()=>({shouldGenerate:false,skipReason:'none'}),
      storyboardCallCompiler:async()=>{llm++;if(scenario==='account')e.setAccount('st-user:other');return '{}';},
      storyboardSchedulePlanArchive(){},storyboardScheduleInlineRender(){},storyboardScheduleAutomaticCapture(){},MODULE_NAME:'qa',console:{error(){}},
    });
    e.context.featureRuntime.load=async key=>key==='storyboardContract'?{buildStoryboardPlanContractRequest:()=>({messages:[],schema:{},schemaId:'test'})}:load(key);
    vm.runInContext(section('storyboardCompilePrompt'),e.context);
    await e.context.storyboardCompilePrompt(null,{plan});
    assert.equal(llm,scenario==='missing'?0:1);assert.equal(e.context.storyboardCompilerBusy,false);
    if(scenario==='valid'){assert.equal(plan.status,'skipped');assert.equal(e.state.prompt,'');}
    else {assert.equal(e.state.prompt,'one scene');assert.notEqual(plan.status,'skipped');}
  }
});

test('exact routing provenance survives a saved plan without copying the workflow into each plan shot',async()=>{
  const e=await routeEnvironment(),plan={id:'plan-a',chatKey:'chat-a',floor:0,status:'screening',shots:[]};
  await e.context.storyboardGenerate(null,{plan,automatic:true});
  const normalized=core.normalizeStoryboardState({...e.state,shotPlans:[plan]});
  assert.deepEqual(normalized.shotPlans[0].shots[0].comfyRouteBinding,e.recipes[0].binding);
  assert.equal(Object.hasOwn(normalized.shotPlans[0].shots[2],'comfyRouteBinding'),false);
  assert.doesNotMatch(JSON.stringify(normalized.shotPlans[0].shots[0].comfyRouteBinding),/class_type|apiKey|positivePrompt/);
});

test('reselecting a fixed workflow keeps its existing references; choosing a different graph cannot silently discard them',async()=>{
  const e=await routeEnvironment();e.state.view='assets';e.state.assetView='routing';const rule=e.state.routing.rules[0];
  rule.target.comfyReferences={version:1,enabled:true,namespace,workflowHash:e.recipes[0].binding.workflowHash,
    items:[{url:'/user/images/test/ref.png',name:'ref',mime:'image/png',bytes:8,sha256:'a'.repeat(64)}]};
  const before=structuredClone(rule.target);let selected=e.recipes[0];const load=e.context.featureRuntime.load;
  e.context.featureRuntime.load=async key=>key==='comfyRoutes'?{...runtime,openComfyRoutePicker:async()=>({recipe:selected,roles:false,useReferences:false})}:load(key);
  await e.context.storyboardBindRouteWorkflow({isConnected:true},rule);assert.deepEqual(rule.target.comfyReferences,before.comfyReferences);
  selected=e.recipes[1];await e.context.storyboardBindRouteWorkflow({isConnected:true},rule);
  assert.deepEqual(rule.target.comfyWorkflowBinding,before.comfyWorkflowBinding);assert.deepEqual(rule.target.comfyReferences,before.comfyReferences);
  assert.match(e.notices.at(-1),/参考图.*不符/);
});
