import test from 'node:test';
import assert from 'node:assert/strict';
import * as board from '../qianmu-storyboard.js';
import {captureStoryboardRelationData,assertStoryboardRelationsRetained} from '../qianmu-storyboard-package-relations.js';
import {prepareStoryboardPackageDraft} from '../qianmu-storyboard-package-draft.js';
import {createStoryboardMutation,applyStoryboardMutation} from '../qianmu-storyboard-package-mutation.js';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {captureStoryboardPackageSettings} from '../qianmu-storyboard-package-fields.js';
const clone=structuredClone,state=()=>board.normalizeStoryboardState(board.createStoryboardDefaults());
const modern=value=>({schemaVersion:board.STORYBOARD_SCHEMA_VERSION,...value});
const prepare=(local,incoming)=>prepareStoryboardPackageDraft({settings:local,chat:{},incoming,images:[],collections:[],chatKey:'chat'});
function relations(){
  const local=state();
  local.tagLibrary=[{id:'sky',name:'Sky group',content:'blue sky, clouds',aliases:['cloudy'],renderings:{novel:'blue sky'},conflictIds:['night']},{id:'night',content:'night',positive:false,conflictIds:['sky']}];
  local.promptPresets=[{id:'scenic',name:'Scenic',items:[{id:'shot',name:'Shot',instruction:'Original instruction'}],tagIds:['sky']}];
  local.promptCompiler.instructionPresetId='scenic';local.promptCompiler.worldBookNames=['Book'];local.promptCompiler.worldEntryIds=['Book::entry'];
  local.vibeLibrary=[{id:'vibe',name:'Clouds',providerIds:['novel'],modelIds:['nai-diffusion-3'],strength:0,informationExtracted:0,tags:['sky'],previewUrl:'/local-clouds.png',notes:'original'}];local.selectedVibeIds=['vibe'];
  local.artistPresets=[{id:'artist',name:'A',value:'line art'}];local.artistPools=[{id:'pool',name:'P',members:[{artistId:'artist',weight:1}]}];local.selectedArtistPresetId='artist';local.selectedArtistPoolId='pool';
  local.parameterPresets=[{id:'style',name:'Style',source:'novel',profile:local.profiles.novel}];local.parameterPresetSelection.novel='style';
  local.compositionPolicy={...local.compositionPolicy,allowedRatioIds:['3:2','2:3'],preferredRatioId:'2:3',ruleOverride:'Custom composition',userEdited:true};
  local.routing={...local.routing,enabled:true,rules:[{id:'wide',name:'Wide',shotTypes:['landscape'],priority:2,target:{providerId:'novel',modelId:'nai-diffusion-3',connectionPresetId:'repairable-missing-connection',parameterPresetId:'style'}},{id:'detail',name:'Detail',shotTypes:['detail'],priority:1,target:{providerId:'openai',modelId:'relay',capabilityModelId:'gpt-image-2'}}]};
  return board.normalizeStoryboardState(local);
}

test('modern routing-only restore does not rewrite count or concurrency policy; old routing still migrates',()=>{
  const local=state();local.generationPolicy={version:1,minImages:2,maxImages:4,concurrency:3};const before=clone(local);
  const result=prepare(local,modern({routing:{enabled:false}}));assert.equal(Object.hasOwn(result.settings,'generationPolicy'),false);
  assert.deepEqual(board.normalizeStoryboardState({...clone(local),...result.settings}).generationPolicy,before.generationPolicy);assert.deepEqual(local,before);
  const old=prepare(local,{schemaVersion:2,routing:{mode:'ensemble',maxShotsPerFloor:2,providerConcurrency:2}});assert.equal(old.settings.generationPolicy.maxImages,2);assert.equal(old.settings.generationPolicy.concurrency,2);
});

test('generation policy validates original values before migration can clamp them, while explicit valid counts restore',()=>{
  for(const generationPolicy of [{version:1,minImages:3,maxImages:2,concurrency:1},{maxImages:9},{concurrency:0},{futureBudget:10},null])assert.throws(()=>prepare(state(),modern({generationPolicy})),/generationPolicy.*完整保留/);
  assert.deepEqual(prepare(state(),modern({generationPolicy:{minImages:2,maxImages:4,concurrency:3}})).settings.generationPolicy,{version:1,minImages:2,maxImages:4,concurrency:3});
});

test('partial parameter selections merge by provider, including explicit clearing without erasing other channels',()=>{
  const local=relations(),other=board.normalizeStoryboardParameterProfile({model:'relay'},'openai');local.parameterPresets.push({id:'other',name:'Other',source:'openai',profile:other});
  const result=prepare(local,modern({parameterPresetSelection:{openai:'other'}}));assert.equal(result.settings.parameterPresetSelection.novel,'style');assert.equal(result.settings.parameterPresetSelection.openai,'other');
  const cleared=prepare({...local,...result.settings},modern({parameterPresetSelection:{openai:''}}));assert.equal(cleared.settings.parameterPresetSelection.novel,'style');assert.equal(cleared.settings.parameterPresetSelection.openai,'');
  for(const parameterPresetSelection of [null,{unknown:'style'},{novel:'missing'}])assert.throws(()=>prepare(local,modern({parameterPresetSelection})),/关联/);
});

test('partial library replacement cannot invalidate an untouched local selected parameter style',()=>{
  const local=relations(),before=clone(local),profile=board.normalizeStoryboardParameterProfile({model:'relay'},'openai');
  assert.throws(()=>prepare(local,modern({parameterPresets:[{id:'style',name:'Changed channel',source:'openai',profile}]})),/parameterPresetSelection.*完整保留/);assert.deepEqual(local,before);
});

test('all linked creative libraries retain source fields and current selections across normalize and JSON reload',()=>{
  const source=relations(),before=clone(source),local=state();local.tagLibrary=[{id:'local',name:'Local',content:'local tag'}];board.normalizeStoryboardState(local);
  const incoming=modern({...captureStoryboardRelationData(source),promptPresets:source.promptPresets,artistPresets:source.artistPresets,artistPools:source.artistPools,parameterPresets:source.parameterPresets});
  const result=prepare(local,incoming),reloaded=board.normalizeStoryboardState(JSON.parse(JSON.stringify({...local,...result.settings})));
  assert.equal(reloaded.tagLibrary.length,3);assert.equal(reloaded.promptCompiler.instructionPresetId,'scenic');assert.deepEqual(reloaded.vibeLibrary[0].tags,['sky']);assert.deepEqual(reloaded.selectedVibeIds,['vibe']);
  assert.equal(reloaded.vibeLibrary[0].strength,0);assert.equal(reloaded.vibeLibrary[0].informationExtracted,0);assert.equal(reloaded.routing.rules[0].target.parameterPresetId,'style');assert.equal(reloaded.compositionPolicy.ruleOverride,'Custom composition');assert.deepEqual(source,before);
});

test('routing priority reordering and compiler derived summaries are allowed but rule values and identities cannot vanish',()=>{
  const original=relations(),before=captureStoryboardRelationData(original);before.routing.rules.reverse();before.routing.mode='single';before.promptCompiler.excludedTags='stale derived value';
  assertStoryboardRelationsRetained(before,original);
  for(const mutate of [s=>s.routing.rules.pop(),s=>s.routing.rules[0].target.parameterPresetId='',s=>s.routing.rules[0].shotTypes=[],s=>s.routing.rules.push(clone(s.routing.rules[0]))]){
    const after=clone(original);mutate(after);assert.throws(()=>assertStoryboardRelationsRetained(before,after),/routing.*完整保留/);
  }
});

test('dangling incoming library selections fail instead of silently becoming another default after refresh',()=>{
  for(const incoming of [{selectedVibeIds:['missing']},{selectedArtistPresetId:'missing'},{selectedArtistPoolId:'missing'},{promptCompiler:{instructionPresetId:'missing'}}])assert.throws(()=>prepare(state(),modern(incoming)),/完整保留/);
  const source=relations();assert.doesNotThrow(()=>prepare(state(),modern({selectedVibeIds:[],selectedArtistPresetId:'',selectedArtistPoolId:'',promptCompiler:{instructionPresetId:''}})));
  assert.doesNotThrow(()=>prepare(source,modern({selectedVibeIds:['vibe'],selectedArtistPresetId:'artist',selectedArtistPoolId:'pool',promptCompiler:{instructionPresetId:'scenic'}})));
});

test('Tag content, provider renderings, aliases and conflict references cannot be silently truncated or removed',()=>{
  for(const mutate of [s=>s.tagLibrary[0].content='x'.repeat(6001),s=>s.tagLibrary[0].renderings.unknown='original',s=>s.tagLibrary[0].aliases.push('x'.repeat(101)),s=>s.tagLibrary[0].conflictIds.push('missing'),s=>s.tagLibrary[0].future='original']){
    const source=relations();mutate(source);const before=clone(source);assert.throws(()=>prepare(state(),source),/tagLibrary.*完整保留/);assert.deepEqual(source,before);
  }
});

test('Vibe scope, strengths, Tag links and unsupported provider models fail before any lossy library write',()=>{
  for(const mutate of [s=>s.vibeLibrary[0].notes='x'.repeat(4001),s=>s.vibeLibrary[0].strength=-1,s=>s.vibeLibrary[0].tags.push('missing'),s=>s.vibeLibrary[0].providerIds.push('openai'),s=>s.vibeLibrary[0].modelIds.push('unknown-model')]){
    const source=relations();mutate(source);assert.throws(()=>prepare(state(),source),/vibeLibrary.*完整保留/);
  }
});

test('composition and compiler manual rules must survive exactly, not get shorter or return to defaults',()=>{
  for(const incoming of [{compositionPolicy:{allowedRatioIds:['unknown']}},{compositionPolicy:{ruleOverride:'x'.repeat(12001)}},{compositionPolicy:{mode:'future'}},{promptCompiler:{includeRecentFloors:21}},{promptCompiler:{tagRules:[{name:'think',action:'unknown'}]}},{promptCompiler:{worldBookNames:['x'.repeat(201)]}}])assert.throws(()=>prepare(state(),modern(incoming)),/完整保留/);
});

test('routing cannot discard disabled rules or change invalid channels, remote capability bindings and extra rule fields',()=>{
  for(const mutate of [r=>r.rules[0].target.providerId='unknown',r=>r.rules[0].priority=2000,r=>r.rules[0].future='original',r=>r.rules[0].target.capabilityModelId='x'.repeat(241),r=>r.rules[0].shotTypes=Array.from({length:31},(_,i)=>`type-${i}`)]){
    const source=relations();mutate(source.routing);source.routing.rules[0].enabled=false;assert.throws(()=>prepare(state(),source),/routing.*完整保留/);
  }
});

test('relation capture is detached and deep or cyclic malformed content has a bounded failure',()=>{
  const source=relations(),captured=captureStoryboardRelationData(source);captured.tagLibrary[0].content='changed';assert.notEqual(source.tagLibrary[0].content,'changed');
  const a={};a.loop=a;const b={};b.loop=b;assert.throws(()=>assertStoryboardRelationsRetained({routing:a},{routing:b}),/routing.*完整保留/);
});

test('selected resources and rules restore reversibly and concurrent edits remain protected',async()=>{
  const local=state(),before=clone(local),source=relations(),draft=prepare(local,source),targets={settings:local,chat:{}};
  const record=await createStoryboardMutation({namespace:'st-user:test',chatKey:'chat',fileHash:'a'.repeat(64),...targets,draft});
  applyStoryboardMutation(record,targets);assert.equal(local.selectedVibeIds[0],'vibe');applyStoryboardMutation(record,targets,'before');assert.deepEqual(local,before);
  local.compositionPolicy.ruleOverride='new local composition';assert.throws(()=>applyStoryboardMutation(record,targets),/已被修改/);assert.equal(local.selectedVibeIds.length,0);
});

test('actual v7 entry restores linked libraries, retains local-only Tags, and returns to the exact prior configuration',async()=>{
  const f=createPackageImportFixture();f.e.state=state();f.e.state.tagLibrary=[{id:'local',name:'Local',content:'local tag'}];board.normalizeStoryboardState(f.e.state);const before=clone(f.e.state),source=relations();
  const {file}=await buildStoryboardVibePackage({type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:captureStoryboardPackageSettings(source),chat:{images:[],collections:[]}},{namespace:f.e.namespace,load:()=>assert.fail('no original')});
  await f.import(file);assert.ok(f.e.pending,JSON.stringify(f.e.notices));const reloaded=board.normalizeStoryboardState(JSON.parse(JSON.stringify(f.e.state)));
  assert.equal(reloaded.promptCompiler.instructionPresetId,'scenic');assert.equal(reloaded.tagLibrary.length,3);assert.equal(reloaded.vibeLibrary[0].tags[0],'sky');assert.equal(reloaded.routing.rules[0].target.parameterPresetId,'style');
  f.e.choice='2';await f.recover();assert.deepEqual(f.e.state,before);
});
