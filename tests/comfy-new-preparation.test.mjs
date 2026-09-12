import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNewComfyExecution} from '../qianmu-comfy-new-execution.js';
import {routeEnvironment} from './helpers/comfy-route-fixture.mjs';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';

for(const fixed of [false,true])test(`${fixed?'fixed recipe':'workbench'} fresh preparation omits retired roles but keeps original workflow preflight`,async()=>{
  const e=await routeEnvironment();e.context.projectNewComfyExecution=projectNewComfyExecution;
  e.state.source='comfy';e.state.routing.enabled=fixed;
  e.state.profiles.comfy.comfyCharacterEnabled=true;
  e.state.profiles.comfy.comfyWorkflow=e.rows[0].document.workflow;
  e.routes.forEach(route=>route.comfyCharacterEnabled=true);
  const before=JSON.stringify([e.state,e.rows]);let roleChecks=0,graphChecks=0;
  const load=e.context.featureRuntime.load;
  e.context.featureRuntime.load=async key=>{
    if(key==='comfyCharacters')return {checkComfyCharacterCandidates:async()=>{roleChecks++;return {referenceCount:0};}};
    if(key==='comfyPreflight'){
      const runtime=await load(key);return {...runtime,checkComfyConfiguration:input=>{graphChecks++;return runtime.checkComfyConfiguration(input);}};
    }
    return load(key);
  };
  for(const freshComfy of [false,true]){
    const guard=e.context.storyboardCreatePreparationGuard(e.state,{freshComfy});
    try{
      assert.equal(guard.freshComfy,freshComfy);
      assert.equal(Reflect.set(guard,'freshComfy',!freshComfy),false);
      await e.context.storyboardPrepareComfyRoutes(e.state,guard);
      assert.equal(e.context.storyboardUsesComfyCharacters(e.state,guard.comfyRoutes,guard.freshComfy),!freshComfy);
      const rolesBefore=roleChecks,graphsBefore=graphChecks;
      await e.context.storyboardPreflightComfyForCompiler(e.state,e.state.profiles.comfy,null,guard);
      assert.ok(graphChecks>graphsBefore,'fresh mode still checks the fixed graph and its declared parameters');
      if(freshComfy)assert.equal(roleChecks,rolesBefore,'no retired per-character implementation is requested');
      else assert.ok(roleChecks>rolesBefore,'legacy preparation retains its original role check');
    }finally{guard.dispose();}
  }
  assert.equal(JSON.stringify([e.state,e.rows]),before,'preparation never rewrites saved settings or recipes');
});

test('one preparation boundary supplies the same explicit policy to automatic candidate selection',async()=>{
  const e=await routeEnvironment();e.state.source='comfy';e.state.routing.enabled=false;e.state.comfyAutoEnabled=true;
  const seen=[],load=e.context.featureRuntime.load;let closed=0;
  e.context.featureRuntime.load=async key=>key==='comfyAuto'?{prepareComfyAutoSession:async options=>{
    seen.push(options.freshComfy);return {candidates:[],promptFormats:[],close(){closed++;}};
  }}:load(key);
  for(const options of [{},{freshComfy:true}]){
    const guard=e.context.storyboardCreatePreparationGuard(e.state,options);
    try{await e.context.storyboardPrepareComfyRoutes(e.state,guard);}finally{guard.dispose();}
  }
  assert.deepEqual(seen,[false,true]);assert.equal(closed,2);
});

test('fresh preparation still rejects a malformed graph before any retired role lookup',async()=>{
  const e=await routeEnvironment();e.context.projectNewComfyExecution=projectNewComfyExecution;
  e.state.source='comfy';e.state.routing.enabled=false;
  Object.assign(e.state.profiles.comfy,{comfyCharacterEnabled:true,comfyWorkflow:'[]'});
  const guard=e.context.storyboardCreatePreparationGuard(e.state,{freshComfy:true});
  try{
    await assert.rejects(()=>e.context.storyboardPreflightComfyForCompiler(e.state,e.state.profiles.comfy,null,guard),/顶层必须是 JSON 对象/);
    assert.equal(e.calls.includes('comfyCharacters'),false);
  }finally{guard.dispose();}
});

test('actual fresh extraction and mixed generation use one policy even when saved role implementations are enabled',async()=>{
  const e=await compilerEnvironment();e.state.profiles.comfy.comfyCharacterEnabled=true;
  e.routes.forEach(route=>route.comfyCharacterEnabled=true);
  const original=JSON.stringify([e.rows,e.state.profiles.comfy,e.state.routing.rules]),seen=[];
  const create=e.context.storyboardCreatePreparationGuard;
  e.context.storyboardCreatePreparationGuard=(state,options)=>{
    const guard=create(state,options);seen.push(guard.freshComfy);return guard;
  };
  assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));
  assert.equal(await e.context.storyboardGenerate(null,{automatic:true}),true,JSON.stringify(e.notices));
  assert.ok(seen.length>=2);assert.ok(seen.every(value=>value===true));
  assert.equal(e.llmCalls.length,1);assert.equal(e.calls.includes('comfyCharacters'),false);
  assert.deepEqual(e.jobs.map(job=>job.source),['comfy','comfy','novel']);
  for(const job of e.jobs.filter(job=>job.source==='comfy')){
    assert.equal(job.profile.comfyCharacterEnabled,false);
    assert.deepEqual(JSON.parse(JSON.stringify(job.profile.comfyRoutePromptLayer)),{positive:'',negative:''});
    assert.ok(job.shotSpec.characters.every(character=>!character.archiveSnapshot?.comfyImplementation));
  }
  assert.equal(JSON.stringify([e.rows,e.state.profiles.comfy,e.state.routing.rules]),original);
});
