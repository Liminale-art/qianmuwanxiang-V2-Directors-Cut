import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {captureStoryboardVibeRecipe as capture,retainStoryboardVibeRecipe as retain,resolveStoryboardVibeRecipe as resolve} from '../qianmu-vibe-recipe.js';
import {sanitizeStoryboardSnapshot,normalizeStoryboardState} from '../qianmu-storyboard.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const row=(id='a')=>({id,name:'Vibe A',previewUrl:'/user/images/vibe-a.png',strength:0,informationExtracted:0});
const assetRef={version:1,namespace:'st-user:one',id:'a'.repeat(64)};

test('v2 immutable sources survive queue, snapshot, library normalization and independent mutations without embedded bytes',()=>{
  const rows=[{...row(),assetRef:{...assetRef},previewUrl:'',data:'must not retain'},row('url')],recipe=capture(['a','url'],rows);
  assert.equal(recipe.version,2);assert.deepEqual(recipe.items[0].assetRef,assetRef);assert.equal(recipe.items[0].information,0);
  rows[0].assetRef.id='b'.repeat(64);assert.equal(recipe.items[0].assetRef.id,'a'.repeat(64));
  const payload={selectedVibeIds:['a','url'],vibeRecipe:recipe};assert.deepEqual(sanitizeStoryboardSnapshot({source:'novel',payload}).payload.vibeRecipe,recipe);
  assert.deepEqual(resolve(payload),recipe.items);assert.equal(JSON.stringify(recipe).includes('must not retain'),false);
  const state=normalizeStoryboardState({vibeLibrary:rows});assert.deepEqual(state.vibeLibrary[0].assetRef,rows[0].assetRef);assert.equal(state.vibeLibrary[0].previewUrl,'');
  rows[0].assetRef.id='c'.repeat(64);assert.equal(state.vibeLibrary[0].assetRef.id,'b'.repeat(64));
});
test('v2 cannot smuggle bytes, bad account IDs or fall back to a URL from a broken immutable reference',()=>{
  const valid=capture(['a'],[{...row(),assetRef}]);
  for(const change of [v=>v.version=1,v=>v.items[0].previewUrl='/fallback.png',v=>v.items[0].assetRef.id='bad',
    v=>v.items[0].assetRef.namespace='wrong',v=>v.items[0].assetRef.data='encoded',v=>v.items[0].assetRef.version=2]){
    const broken=structuredClone(valid);change(broken);assert.equal(retain(broken).invalid,true);assert.throws(()=>resolve({selectedVibeIds:['a'],vibeRecipe:broken}));
  }
  assert.throws(()=>capture(['a'],[{...row(),assetRef:{...assetRef,id:'bad'}}]));
  const state=normalizeStoryboardState({vibeLibrary:[{...row(),assetRef:{...assetRef,id:'bad'}}]});
  assert.equal(state.vibeLibrary[0].assetRef.invalid,true);assert.equal(state.vibeLibrary[0].previewUrl,'');
});

test('Vibe source recipes are bounded plain metadata, preserve order and zeros, and do not retain library extras or bytes',()=>{
  const rows=[{...row('a'),privateNotes:'not in recipe',data:'binary',tags:['unrelated']},row('b')],recipe=capture(['b','a'],rows);
  assert.deepEqual(recipe.items.map(x=>x.id),['b','a']);assert.equal(recipe.items[0].strength,0);assert.equal(recipe.items[0].information,0);
  assert.equal(JSON.stringify(recipe).includes('binary'),false);assert.equal(JSON.stringify(recipe).includes('private'),false);
  rows[0].previewUrl='/changed.png';rows[1].strength=.9;assert.equal(recipe.items[0].strength,0);assert.equal(recipe.items[1].previewUrl,'/user/images/vibe-a.png');
  assert.deepEqual(resolve({selectedVibeIds:['b','a'],vibeRecipe:recipe}),recipe.items);
});

test('empty legacy selections remain compatible, selected legacy data needs explicit reselection rather than a current-library guess',()=>{
  assert.deepEqual(resolve({}),[]);assert.deepEqual(resolve({selectedVibeIds:[]}),[]);
  assert.throws(()=>resolve({selectedVibeIds:['a']}),/旧图未保存原 Vibe/);
  for(const ids of [null,{},'a',['a','a'],Array(17).fill('a')])assert.throws(()=>capture(ids,[row()]));
  assert.throws(()=>capture(['gone'],[row()]),/缺失/);
  assert.throws(()=>resolve({selectedVibeIds:{}}),/选择无效/);
});

test('Vibe metadata rejects transient or embedded image sources, credentials, control characters and malformed snapshots without silent truncation',()=>{
  for(const previewUrl of ['data:image/png;base64,AAAA','blob:https://example.test/a','javascript:alert(1)','//example.test/a',
    'https://name:password@example.test/a','https://example.test/\u0000','/\\example.test/a','https://example.test/'+ 'a'.repeat(4096)]){
    assert.throws(()=>capture(['a'],[{...row(),previewUrl}]),/图源不可保存/);
  }
  const valid=capture(['a'],[row()]);
  for(const mutate of [v=>v.version=2,v=>v.secret='no',v=>v.items[0].data='bytes',v=>v.items[0].strength='0',v=>v.items[0].information=2]){
    const bad=structuredClone(valid);mutate(bad);assert.equal(retain(bad).invalid,true);
    assert.equal(sanitizeStoryboardSnapshot({source:'novel',payload:{selectedVibeIds:['a'],vibeRecipe:bad}}).payload.vibeRecipe.invalid,true);
    assert.throws(()=>resolve({selectedVibeIds:['a'],vibeRecipe:bad}),/配方无效/);
  }
});

test('new actual NAI job payload owns its Vibe recipe before queueing and keeps it through saved-log restoration',()=>{
  const {state,context}=createStoryboardFormFixture();
  state.vibeLibrary=[row()];state.selectedVibeIds=['a'];state.profiles.novel.model='nai-diffusion-4-5-full';state.profiles.novel.capabilityModelId='nai-diffusion-4-5-full';
  vm.runInContext([section('storyboardGenerationPayload'),section('storyboardJobFromLog')].join('\n'),context);
  const profile=context.storyboardProviderProfile(state,'novel'),payload=context.storyboardGenerationPayload(state,profile,{prompt:'garden'});
  assert.equal(payload.vibeRecipe.items[0].previewUrl,'/user/images/vibe-a.png');
  state.vibeLibrary[0].strength=.8;state.vibeLibrary=[];
  const snapshot=sanitizeStoryboardSnapshot({source:'novel',profile,connection:{baseUrl:'https://image.novelai.net',credentialId:'fixture-reference'},payload});
  const retry=context.storyboardJobFromLog({snapshot});assert.ok(retry);assert.equal(retry.payload.vibeRecipe.items[0].strength,0);
  assert.deepEqual(resolve(retry.payload),payload.vibeRecipe.items);
});

test('unsupported capability and protocol do not copy hidden Vibe selection into new payloads',()=>{
  for(const [family,connection] of [['novel',{}],['openai',{}],['banana',{protocol:'openai-images',imageProtocolVersion:1,compatibility:{}}]]){
    const {state,context}=createStoryboardFormFixture({family,connection});state.selectedVibeIds=['a'];state.vibeLibrary=[row()];
    vm.runInContext(section('storyboardGenerationPayload'),context);
    const payload=context.storyboardGenerationPayload(state,context.storyboardProviderProfile(state,family),{prompt:'garden'});
    assert.deepEqual(Array.from(payload.selectedVibeIds),[]);assert.equal(Object.hasOwn(payload,'vibeRecipe'),false);
    assert.equal(state.selectedVibeIds[0],'a');
  }
});
