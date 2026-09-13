import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStoryboardParameterProfile,normalizeStoryboardState,rememberStoryboardModelProfile} from '../qianmu-storyboard.js';
import {normalizeComfyLibraryDocument,importComfyLibraryDocument,exportComfyLibraryDocument} from '../qianmu-comfy-library.js';
import {applyComfyRouteRecipe} from '../qianmu-comfy-route.js';
import {renderComfyWorkbench} from '../qianmu-comfy-workbench.js';
import {recipesFixture} from './helpers/comfy-route-fixture.mjs';

test('runtime tier survives profile, parameter preset and model memory without adding defaults to old or other-provider profiles', () => {
  for (const tier of ['default','plus','ultra']) {
    const profile=normalizeStoryboardParameterProfile({model:'comfy-workflow',comfyInstanceType:tier},'comfy');
    assert.equal(profile.comfyInstanceType,tier);
    const state=normalizeStoryboardState({profiles:{comfy:profile},parameterPresets:[{id:'rh',source:'comfy',profile}]});
    assert.equal(state.profiles.comfy.comfyInstanceType,tier);assert.equal(state.parameterPresets[0].profile.comfyInstanceType,tier);
    const memory={};rememberStoryboardModelProfile(memory,'comfy',profile);assert.ok(JSON.stringify(memory).includes(`"comfyInstanceType":"${tier}"`));
  }
  assert.equal(Object.hasOwn(normalizeStoryboardParameterProfile({},'comfy'),'comfyInstanceType'),false);
  assert.equal(Object.hasOwn(normalizeStoryboardParameterProfile({comfyInstanceType:'ultra'},'novel'),'comfyInstanceType'),false);
  for(const value of [null,{},'pro','PLUS'])assert.equal(normalizeStoryboardParameterProfile({comfyInstanceType:value},'comfy').comfyInstanceType,'[invalid]');
});

test('workflow documents preserve optional RH settings and never silently replace invalid tiers with a default',async()=>{
  const f=await recipesFixture(),legacy=normalizeComfyLibraryDocument(f.rows[0].document);
  assert.equal(Object.hasOwn(legacy,'runninghubInstanceType'),false);
  for(const tier of ['default','plus','ultra']){
    const source={...legacy,runninghubInstanceType:tier},restored=importComfyLibraryDocument(JSON.stringify(exportComfyLibraryDocument('rh',source))).document;
    assert.deepEqual(restored,source);
  }
  for(const value of ['',null,'pro',{}])assert.throws(()=>normalizeComfyLibraryDocument({...legacy,runninghubInstanceType:value}),{code:'comfy_library_runtime'});
});

test('fixed shot routes use their own saved tier, while an old unspecified recipe cannot inherit a costly workbench choice',async()=>{
  const f=await recipesFixture({tiers:['plus',null]}),base={comfyInstanceType:'ultra'};
  const first=applyComfyRouteRecipe(base,f.routes[0],f.recipes[0]),second=applyComfyRouteRecipe(base,f.routes[1],f.recipes[1]);
  assert.equal(first.comfyInstanceType,'plus');assert.equal(Object.hasOwn(second,'comfyInstanceType'),false);assert.equal(base.comfyInstanceType,'ultra');
});

test('workbench offers three explicit tiers only on RH, keeps platform default and renders invalid settings repairably',()=>{
  const input={profile:{comfyInstanceType:'plus'},capabilities:{},connection:{baseUrl:'https://www.runninghub.cn'}};
  const html=renderComfyWorkbench(input);assert.match(html,/data-storyboard-field="comfyInstanceType"/);assert.match(html,/value="plus" selected/);
  assert.match(html,/平台默认/);assert.match(html,/value="ultra"/);assert.doesNotMatch(html,/retainSeconds|value="lite"|value="pro"/);
  for(const baseUrl of ['https://cloud.comfy.org','http://127.0.0.1:8188','https://unknown.test'])
    assert.doesNotMatch(renderComfyWorkbench({...input,connection:{baseUrl}}),/data-storyboard-field="comfyInstanceType"/);
  assert.match(renderComfyWorkbench({...input,profile:{comfyInstanceType:'[invalid]'}}),/运行配置待核对/);
});
