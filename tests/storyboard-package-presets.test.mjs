import test from 'node:test';
import assert from 'node:assert/strict';
import * as board from '../qianmu-storyboard.js';
import {mergeStoryboardParameterMemory,mergeStoryboardPromptDefaults,assertStoryboardPresetDataRetained,assertStoryboardMemoryIdentitiesRetained} from '../qianmu-storyboard-package-presets.js';
import {prepareStoryboardPackageDraft} from '../qianmu-storyboard-package-draft.js';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {createStoryboardMutation,applyStoryboardMutation} from '../qianmu-storyboard-package-mutation.js';
const clone=structuredClone;
const state=()=>board.normalizeStoryboardState(board.createStoryboardDefaults());
const profile=(model,steps,capabilityModelId='')=>board.normalizeStoryboardParameterProfile({model,steps,...(capabilityModelId?{capabilityModelId}:{})},'openai');
function memory(rows){const value={};for(const row of rows)assert.equal(board.rememberStoryboardModelProfile(value,'openai',row),true);return value;}
const prepare=(local,incoming)=>prepareStoryboardPackageDraft({settings:local,chat:{},incoming,images:[],collections:[],chatKey:'chat'});
const modern=value=>({schemaVersion:board.STORYBOARD_SCHEMA_VERSION,...value});

test('parameter memory merges exact model identities while keeping other local and incoming model settings',()=>{
  const local=memory([profile('local-only','11'),profile('shared','12')]),incoming=memory([profile('remote-only','21'),profile('shared','22')]),before=JSON.stringify({local,incoming});
  const result=mergeStoryboardParameterMemory(local,incoming);assert.equal(result.openai['local-only'].steps,'11');assert.equal(result.openai.shared.steps,'22');assert.equal(result.openai['remote-only'].steps,'21');
  assert.equal(JSON.stringify({local,incoming}),before);result.openai.shared.steps='44';assert.equal(incoming.openai.shared.steps,'22');
});

test('same remote name with different capability families never collapses into a single remembered profile',()=>{
  const local={},incoming={};
  for(const [target,capabilityModelId,steps] of [[local,'nai-diffusion-3','11'],[incoming,'nai-diffusion-4-5-full','21']])assert.equal(board.rememberStoryboardModelProfile(target,'novel',{model:'relay',capabilityModelId,steps}),true);
  const result=mergeStoryboardParameterMemory(local,incoming),normalized=board.normalizeStoryboardState({...state(),modelProfiles:result});
  assert.equal(board.getStoryboardRememberedProfile(normalized.modelProfiles,'novel','relay','nai-diffusion-3').steps,'11');
  assert.equal(board.getStoryboardRememberedProfile(normalized.modelProfiles,'novel','relay','nai-diffusion-4-5-full').steps,'21');
  assertStoryboardMemoryIdentitiesRetained(result,normalized.modelProfiles);
});

test('memory capacity is checked over the merged catalogue and normalization cannot silently evict for the active model',()=>{
  const local=state();local.modelProfiles=memory(Array.from({length:80},(_,i)=>profile(`local-${i}`,'12')));
  const before=JSON.stringify(local);assert.throws(()=>prepare(local,modern({modelProfiles:memory([profile('incoming','20')])})),/超过 80/);
  local.profiles.openai=profile('active-not-cached','30');
  assert.throws(()=>prepare(local,modern({modelProfiles:{openai:{}}})),/完整保留/);
  assert.equal(JSON.stringify({...local,profiles:JSON.parse(before).profiles}),before);
});

test('null, malformed, conflicting and duplicate memory identities fail instead of becoming empty memories',()=>{
  const row=profile('relay','20','gpt-image-1');
  for(const value of [null,{openai:null},{bindings:{openai:null}},{unknown:{}},{openai:{id:{model:'different'}}},{bindings:{openai:[row,row]}},{bindings:{unknown:[]}}])assert.throws(()=>mergeStoryboardParameterMemory({},value));
  assert.deepEqual(mergeStoryboardParameterMemory({openai:{old:profile('old','10')}},{openai:{}}).openai.old.steps,'10');
});

test('importing current parameters alone stages their derived cache and cannot trigger eviction on the next render',()=>{
  const local=state(),incoming=modern({profiles:{openai:profile('new-active-model','31')}});
  const prepared=prepare(local,incoming);assert.equal(prepared.settings.modelProfiles.openai['new-active-model'].steps,'31');assert.equal(local.modelProfiles.openai['new-active-model'],undefined);
  const merged={...clone(local),...prepared.settings},reloaded=board.normalizeStoryboardState(clone(merged));assert.deepEqual(reloaded.modelProfiles,merged.modelProfiles);
  local.modelProfiles=memory(Array.from({length:80},(_,i)=>profile(`local-${i}`,'12')));const before=JSON.stringify(local);
  assert.throws(()=>prepare(local,incoming),/完整保留/);assert.equal(JSON.stringify(local),before);
});

test('a newly active capability may append a cache entry without erasing or reordering an existing capability memory',()=>{
  const local=state();assert.equal(board.rememberStoryboardModelProfile(local.modelProfiles,'novel',{model:'old-relay',capabilityModelId:'nai-diffusion-3',steps:'17'}),true);
  const profile=board.normalizeStoryboardParameterProfile({model:'new-relay',capabilityModelId:'nai-diffusion-4-5-full',steps:'27'},'novel');
  const result=prepare(local,modern({profiles:{novel:profile}})).settings.modelProfiles.bindings.novel;
  assert.deepEqual(result.map(row=>[row.model,row.steps]),[['old-relay','17'],['new-relay','27']]);assert.equal(local.modelProfiles.bindings.novel.length,1);
});

test('default positive and negative layers merge independently; explicit empty clears only its own side',()=>{
  const local={local:{positive:'local'},shared:{positive:'old positive',negative:'old negative'}},incoming={remote:{negative:'new'},shared:{positive:''}},before=JSON.stringify({local,incoming});
  const merged=mergeStoryboardPromptDefaults(local,incoming);assert.deepEqual(merged,{local:{positive:'local'},shared:{positive:'',negative:'old negative'},remote:{negative:'new'}});assert.equal(JSON.stringify({local,incoming}),before);
  assert.deepEqual(mergeStoryboardPromptDefaults(local,{}),local);
});

test('default-word capacity and malformed content stop without truncating or deleting another model layer',()=>{
  const local=Object.fromEntries(Array.from({length:200},(_,i)=>[`model-${i}`,{positive:'p'}]));
  assert.throws(()=>mergeStoryboardPromptDefaults(local,{new:{negative:'n'}}),/200/);
  for(const value of [null,{model:null},{model:{positive:2}},{model:{negative:'x'.repeat(12001)}},{model:{futureField:'unknown'}}])assert.throws(()=>mergeStoryboardPromptDefaults({},value));
  assert.throws(()=>mergeStoryboardPromptDefaults({broken:null},{}));
});

test('modern preset import retains nested item text, collection memberships and role assignments or rejects the complete draft',()=>{
  const local=state();
  const incoming=modern({artistCollections:[{id:'collection',name:'Collection'}],artistPresets:[{id:'artist',name:'A',value:'line art',collectionIds:['collection']}],
    artistPools:[{id:'pool',name:'P',members:[{artistId:'artist',weight:1}],roleAssignments:{landscape:'artist'}}],
    promptPresets:[{id:'preset',name:'P',items:[{id:'entry',name:'E',instruction:'original instruction'}]}]});
  const prepared=prepare(local,incoming);assert.equal(prepared.settings.promptPresets[0].items[0].instruction,'original instruction');assert.equal(prepared.settings.artistPools[0].roleAssignments.landscape,'artist');
  for(const change of [value=>value.promptPresets[0].items[0].instruction='x'.repeat(12001),value=>value.artistPresets[0].value='x'.repeat(6001),value=>value.artistPresets[0].collectionIds.push('missing'),value=>value.artistPools[0].roleAssignments.landscape='missing',value=>value.promptPresets[0].futureRule={keep:'me'}]){
    const copy=clone(incoming);change(copy);const before=JSON.stringify(copy);assert.throws(()=>prepare(local,copy),/完整保留/);assert.equal(JSON.stringify(copy),before);
  }
});

test('current parameter presets and model memories cannot discard unknown parameters or truncate text',()=>{
  for(const incoming of [modern({profiles:{openai:{...profile('relay','10'),future:'keep'}}}),modern({parameterPresets:[{id:'p',name:'P',source:'openai',profile:{...profile('relay','10'),future:'keep'}}]}),modern({modelProfiles:{openai:{relay:{...profile('relay','10'),future:'keep'}}}})])assert.throws(()=>prepare(state(),incoming),/完整保留/);
});

test('format-only workflow normalization and derived preset summaries do not masquerade as creative content loss',()=>{
  const before={profiles:{comfy:{comfyWorkflow:'{ "a": { "inputs": { "text": "word" }, "class_type": "Text" } }'}},promptPresets:[{id:'p',instruction:'stale aggregate',items:[{id:'e',instruction:'actual content'}]}]},after=clone(before);
  after.profiles.comfy.comfyWorkflow='{"a":{"class_type":"Text","inputs":{"text":"word"}}}';after.promptPresets[0].instruction='actual content';assertStoryboardPresetDataRetained(before,after);
  after.promptPresets[0].items[0].instruction='cut';assert.throws(()=>assertStoryboardPresetDataRetained(before,after),/完整保留/);
});

test('future schema refuses a lossy downgrade while supported old routing conversions remain available',()=>{
  assert.throws(()=>prepare(state(),{schemaVersion:board.STORYBOARD_SCHEMA_VERSION+1,profiles:{}}),/版本尚不支持/);
  assert.throws(()=>prepare(state(),{schemaVersion:'invalid'}),/版本尚不支持/);
  const result=prepare(state(),{schemaVersion:2,routing:{mode:'ensemble',maxShotsPerFloor:2}});assert.equal(result.settings.routing.enabled,true);
});

test('merged parameter memory and prompt defaults use reversible patches and reject concurrent same-field edits',async()=>{
  const local=state();local.modelProfiles=memory([profile('local','11')]);local.promptDefaults={local:{positive:'local'}};const before=clone(local);
  const draft=prepare(local,modern({modelProfiles:memory([profile('incoming','21')]),promptDefaults:{incoming:{negative:'incoming'}}}));
  const targets={settings:local,chat:{}},row=await createStoryboardMutation({namespace:'st-user:test',chatKey:'chat',fileHash:'a'.repeat(64),...targets,draft});
  applyStoryboardMutation(row,targets);assert.equal(local.modelProfiles.openai.local.steps,'11');assert.equal(local.modelProfiles.openai.incoming.steps,'21');applyStoryboardMutation(row,targets,'before');assert.deepEqual(local,before);
  local.promptDefaults.local.positive='edited while waiting';assert.throws(()=>applyStoryboardMutation(row,targets),/已被修改/);assert.equal(local.modelProfiles.openai.incoming,undefined);
});

test('actual v7 import combines both sides, keeps model-bound defaults after serialization, and can restore the exact prior state',async()=>{
  const f=createPackageImportFixture();f.e.state=state();f.e.state.modelProfiles=memory([profile('local','11')]);f.e.state.promptDefaults={local:{positive:'local'},shared:{positive:'old',negative:'kept'}};const before=clone(f.e.state);
  const payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:modern({modelProfiles:memory([profile('incoming','21')]),promptDefaults:{incoming:{negative:'new'},shared:{positive:'incoming'}}}),chat:{images:[],collections:[]}};
  const {file}=await buildStoryboardVibePackage(payload,{namespace:f.e.namespace,load:()=>assert.fail('no original')});await f.import(file);assert.ok(f.e.pending,JSON.stringify(f.e.notices));
  const reloaded=board.normalizeStoryboardState(JSON.parse(JSON.stringify(f.e.state)));assert.equal(reloaded.modelProfiles.openai.local.steps,'11');assert.equal(reloaded.modelProfiles.openai.incoming.steps,'21');assert.equal(reloaded.promptDefaults.shared.negative,'kept');assert.equal(reloaded.promptDefaults.shared.positive,'incoming');
  f.e.choice='2';await f.recover();assert.deepEqual(f.e.state,before);
});
