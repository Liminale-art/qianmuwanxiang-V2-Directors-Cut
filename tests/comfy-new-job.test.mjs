import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNewComfyExecution} from '../qianmu-comfy-new-execution.js';
import {prepareComfyRouteRecipes} from '../qianmu-comfy-route.js';
import {routeEnvironment,namespace} from './helpers/comfy-route-fixture.mjs';
const plain=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

for(const fixed of [false,true])for(const manual of [false,true]){
  test(`${fixed?'fixed':'workbench'} ${manual?'manual':'extracted'} fresh job omits retired additions while legacy creation remains unchanged`,async()=>{
    const e=await routeEnvironment();e.context.projectNewComfyExecution=projectNewComfyExecution;
    e.state.promptDraft.userEditedCompiled=manual;
    e.state.promptDefaults['comfy:comfy-workflow']={positive:'global quality',negative:'global negative'};
    e.state.profiles.comfy.comfyCharacterEnabled=true;
    e.state.profiles.comfy.comfyCharacterActivation={namespace,workflow:{id:'legacy'}};
    e.routes[0].comfyCharacterEnabled=true;
    const prepared=await prepareComfyRouteRecipes({routes:e.routes,namespace,createStore:e.createStore});
    const original=JSON.stringify([e.state,e.rows]);
    const options={sourceId:'comfy',profileSourceId:'comfy',shot:e.state.promptDraft.shots[0],
      ...(fixed?{routeTarget:e.routes[0],preparedRoutes:prepared}:{})};
    const fresh=e.context.storyboardCreateJob(e.state,e.state.profiles.comfy,{...options,freshComfy:true});
    assert.equal(fresh.profile.comfyCharacterEnabled,false);assert.equal(fresh.profile.comfyCharacterActivation,undefined);
    assert.doesNotMatch(fresh.payload.prompt,/portrait quality|global quality/);
    assert.doesNotMatch(fresh.payload.negative,/portrait exclusions|global negative/);
    assert.match(fresh.payload.prompt,/woman reading a letter/);
    if(manual)assert.equal(fresh.payload.prompt,'woman reading a letter');
    const legacy=e.context.storyboardCreateJob(e.state,e.state.profiles.comfy,options);
    assert.equal(legacy.profile.comfyCharacterEnabled,true);
    assert.match(legacy.payload.prompt,fixed?/portrait quality/:/global quality/);
    assert.equal(fresh.profile.comfyWorkflow,legacy.profile.comfyWorkflow);
    assert.deepEqual(plain(fresh.profile.comfyRouteBinding),plain(legacy.profile.comfyRouteBinding));
    assert.equal(JSON.stringify([e.state,e.rows]),original);
  });
}

test('fresh Comfy preparation cannot change another model family or its artist/default layers',async()=>{
  const e=await routeEnvironment();e.context.projectNewComfyExecution=()=>{throw Error('wrong family');};
  const options={sourceId:'novel',profileSourceId:'novel',shot:e.state.promptDraft.shots[2]};
  const legacy=e.context.storyboardCreateJob(e.state,e.state.profiles.novel,options);
  const fresh=e.context.storyboardCreateJob(e.state,e.state.profiles.novel,{...options,freshComfy:true});
  assert.deepEqual(plain(fresh.profile),plain(legacy.profile));assert.deepEqual(plain(fresh.payload),plain(legacy.payload));
});
