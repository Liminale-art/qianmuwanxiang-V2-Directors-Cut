import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as auto from '../qianmu-comfy-auto-runtime.js';
import * as routes from '../qianmu-comfy-route.js';
import * as direct from '../qianmu-image-direct.js';
import * as locks from '../qianmu-comfy-lock-runtime.js';
import {changeComfySceneRecord,inspectComfySceneRecord,comfySceneScopeKey} from '../qianmu-comfy-scene-lock.js';
import {checkComfyCharacterReadiness} from '../qianmu-comfy-character-readiness.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const definitions={CLIPTextEncode:{input:{required:{text:['STRING']}},output:['CONDITIONING']},
  EmptyImage:{input:{required:{width:['INT'],height:['INT'],batch_size:['INT']}},output:['IMAGE']},
  SaveImage:{input:{required:{images:['IMAGE']}},output:[],output_node:true}};
async function environment({mixed=false,styleLock=true}={}){
  const e=await compilerEnvironment(),network=[],records=new Map(),writes=[];let missing='',afterRequest=async()=>{};
  e.rows.forEach((row,index)=>Object.assign(row.document.classification,{visualKinds:[index?'environment':'character']}));
  const recipes=await Promise.all(e.rows.map(selection=>routes.pinComfyRouteWorkflow({namespace,selection,createStore:e.createStore})));
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'pool',revision:'v1',enabled:false,styleLock,
    candidates:recipes.map((recipe,index)=>({id:`candidate-${index}`,enabled:true,priority:index?0:1,target:{...e.routes[index],comfyWorkflowBinding:recipe.binding},classification:recipe.document.classification}))});
  const row={namespace,id:pool.id,revision:pool.revision,version:1,name:'QA pool',archived:false,pool};
  const createStore=()=>({list:async()=>[copy(row)],versions:async()=>[copy(row)],load:async()=>copy(row),close(){}});
  e.state.comfyPoolSelection=(await auto.pinComfyAutoPool({namespace,selection:row,createStore})).binding;
  e.state.comfyAutoEnabled=true;e.state.source='comfy';e.state.routing.enabled=mixed;
  if(mixed){e.state.routing.rules[0].target={providerId:'novel',modelId:'nai-diffusion-4-5-full',capabilityModelId:'nai-diffusion-4-5-full'};e.state.routing.rules[1].target.comfyWorkflowBinding=recipes[1].binding;}
  Object.assign(e.state.connections.comfy.draft,{baseUrl:'https://comfy.test/api'});
  e.state.connections.comfy.draft.options.comfyTransport='browser';
  const inspect=async scope=>({...inspectComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope),generation:0});
  const write=async(scope,action)=>{const result=changeComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,action);records.set(comfySceneScopeKey(scope),result.row);writes.push(action.type);return {view:await inspect(scope),receipt:result.receipt};};
  const store={inspect,reserve:(scope,request)=>write(scope,{...request,type:'reserve'}),begin:receipt=>write(receipt.scope,{type:'begin',receipt}),settle:(receipt,outcome)=>write(receipt.scope,{type:'settle',receipt,outcome}),close(){}};
  const load=e.context.featureRuntime.load;
  const manager=locks.createComfySceneCoordinator({store,resolveNamespace:async()=>(await load('imageAdmission')).resolveImageAccountNamespace(),ownerId:'test-page',locks:fakeWebLocks()});
  e.context.featureRuntime.load=async key=>{
    if(key==='comfyAuto')return {...auto,prepareComfyAutoSession:options=>auto.prepareComfyAutoSession({...options,createStore,readRecipe:request=>routes.readPinnedComfyRouteWorkflow({...request,createStore:e.createStore})})};
    if(key==='comfyScene')return locks;
    if(key==='comfyCharacterReadiness')return {checkComfyCharacterReadiness:(request,options)=>checkComfyCharacterReadiness(request,{...options,fetchImpl:async(url,init)=>{
      network.push({url,method:init.method});await afterRequest();assert.equal(init.method,'GET');const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));return new Response(JSON.stringify(name===missing?{}:{[name]:definitions[name]}));
    }})};
    return load(key);
  };
  Object.assign(e.context,{storyboardComfySceneRuntime:async()=>manager,directImageRuntime:async()=>direct,storyboardResolveApiKey:async()=>'',storyboardRequestHeaders:()=>({})});
  vm.runInContext(['storyboardChooseComfyGenerationRoutes','storyboardParseWorkflow','storyboardGatewayRequest','storyboardCheckComfyJobReadiness','storyboardConfirmComfyExecution','storyboardProbeComfyCandidate'].map(section).join('\n'),e.context);
  const queue=e.context.storyboardQueueJob;
  e.context.storyboardQueueJob=async job=>{
    if(job.source==='comfy'){
      if(job.profile.comfyRouteBinding)await e.context.storyboardVerifyComfyRouteJob(job);await e.context.storyboardPrepareComfyPromptJob(job,{prepare:true});
      await e.context.storyboardConfirmComfyExecution(job,()=>true);if(job.comfySceneClaim)await manager.reserve(job);
    }
    return queue(job);
  };
  return {...e,row,recipes,network,records,writes,manager,setMissing:value=>missing=value,setAfterRequest:value=>afterRequest=value,
    close:()=>manager.close()};
}
const plan=()=>({id:'plan',chatKey:'chat-a',status:'screening',shots:[]});

test('actual one-shot extraction negotiates candidates, then routes, freezes and reserves each shot in narrative order',async()=>{
  const e=await environment(),p=plan(),original=JSON.stringify(e.state.profiles);
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.deepEqual(e.llmCalls[0].options.promptFormats,['tags','natural_language']);core.normalizeStoryboardState(e.state);
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify({notices:e.notices,errors:e.errors}));
    assert.equal(e.llmCalls.length,1);assert.equal(e.jobs.length,3);assert.deepEqual(e.jobs.map(job=>job.inlineOrder.shotIndex),[0,1,2]);
    assert.deepEqual(e.jobs.map(job=>job.profile.comfyRouteBinding.id),['portrait','landscape','portrait']);
    assert.ok(e.jobs.every(job=>job.comfyAutoSelected&&job.comfySceneClaim&&job.comfyExecution.automatic&&job.profile.count==='1'));
    assert.match(e.jobs[0].payload.prompt,/portrait quality, tag-scene-0/);assert.match(e.jobs[1].payload.prompt,/landscape quality\n\nNatural scene 1/);
    assert.equal(e.writes.filter(type=>type==='reserve').length,3);assert.equal(JSON.stringify(e.state.profiles),original);
    for(const job of e.jobs){await e.manager.beforeSubmit(job);await e.manager.settle(job,'succeeded');}
    assert.ok([...e.records.values()].every(row=>row.established&&!row.holders.length));assert.ok(e.network.every(request=>request.method==='GET'));
  }finally{await e.close();}
});

test('explicit fixed mirrors and closed providers have priority over automatic workbench selection',async()=>{
  const e=await environment({mixed:true}),p=plan();
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify(e.notices));
    assert.deepEqual(e.jobs.map(job=>job.source),['novel','comfy','comfy']);
    assert.deepEqual(e.jobs.map(job=>Boolean(job.comfyAutoSelected)),[false,false,true]);
    assert.equal(e.jobs[1].profile.comfyRouteBinding.id,'landscape');assert.equal(e.writes.filter(type=>type==='reserve').length,1);
  }finally{await e.close();}
});

test('manual trigger still subjects automatic workflow selection to strict one-image eligibility',async()=>{
  const e=await environment({styleLock:false});
  try{
    await e.context.storyboardCompilePrompt(null);assert.equal(await e.context.storyboardGenerate(null,{automatic:false}),true,JSON.stringify(e.notices));
    assert.equal(e.jobs.length,3);assert.ok(e.jobs.every(job=>!job.automatic&&job.comfyAutoSelected&&job.comfyExecution.automatic&&job.profile.count==='1'));
    assert.equal(e.writes.length,0);assert.ok(e.jobs.every(job=>!job.comfySceneClaim));
  }finally{await e.close();}
});

test('actual adjacent shots in a single confirmed batch scene keep their first workflow despite later visual-category preference',async()=>{
  const e=await environment(),p=plan();
  for(const shot of e.response.shots){shot.scene.location='kitchen';shot.composition.continuity_key='one-scene';}
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify(e.notices));
    assert.equal(e.jobs.length,3);assert.deepEqual(e.jobs.map(job=>job.profile.comfyRouteBinding.id),['portrait','portrait','portrait']);assert.equal(e.records.size,1);
    assert.equal([...e.records.values()][0].holders.length,3);
  }finally{await e.close();}
});

test('lost nodes or scope changes stop actual preparation without queued images or persistent claims',async()=>{
  for(const failure of ['nodes','account','mode']){
    const e=await environment(),p=plan();
    try{
      assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
      if(failure==='nodes')e.setMissing('EmptyImage');else e.setAfterRequest(async()=>{if(failure==='account')e.setAccount('st-user:other');else e.state.comfyAutoEnabled=false;});
      assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),false);assert.equal(e.jobs.length,0);assert.equal(e.writes.length,0);
      assert.ok(e.notices.length||e.errors.length);assert.equal(e.llmCalls.length,1);
    }finally{await e.close();}
  }
});

test('invalid candidate binding fails before compiler request; disabling automatic mode preserves legacy workbench',async()=>{
  const e=await environment();
  try{
    e.state.comfyPoolSelection={invalid:true};assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.llmCalls.length,0);
    e.state.comfyAutoEnabled=false;for(const shot of e.response.shots)delete shot.prompt_renderings;
    assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,1);
    assert.equal(await e.context.storyboardGenerate(null),true,JSON.stringify(e.notices));assert.ok(e.jobs.every(job=>!job.comfyAutoSelected));assert.equal(e.writes.length,0);
  }finally{await e.close();}
});
