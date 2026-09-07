import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as recipe from '../qianmu-style-recipe.js';
import * as core from '../qianmu-storyboard.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const model='nai-diffusion-4-5-full',all={artist:true,positive:true,negative:true,vibes:true};
const copy=value=>structuredClone(value);
function snapshot(){return {source:'novel',profile:{model,seed:123},connection:{baseUrl:'https://original.invalid',credentialId:'do-not-copy'},
  payload:{artistString:'artist:original',prompt:'artist:original, old quality, ORIGINAL SCENE',negative:'old exclude, ORIGINAL SCENE NEGATIVE',
    artistPromptLayer:{version:1,positivePrefix:'artist:original, old quality',negativePrefix:'old exclude'},
    selectedVibeIds:['original-vibe'],vibeRecipe:core.captureStoryboardVibeRecipe(['original-vibe'],[{id:'original-vibe',name:'Original',previewUrl:'/user/images/old.png',strength:0,informationExtracted:0}]),
    shotSpec:{characters:[{name:'DO NOT COPY PERSON'}]}}};}
function setup(){
  const {state,context}=createStoryboardFormFixture();Object.assign(state.profiles.novel,{model,capabilityModelId:model,seed:99});
  state.prompt='CURRENT SCENE';state.negative='CURRENT SCENE NEGATIVE';state.promptDefaults[`novel:${model}`]={positive:'current quality',negative:'current exclude'};
  state.artistPresets=[{id:'current',name:'Current',value:'artist:current',positivePrompt:'current quality',negativePrompt:'current exclude'}];state.selectedArtistPresetId='current';state.selectedArtistPoolId='pool';
  context.storyboardSelectedArtistPreset=()=>state.artistPresets.find(row=>row.id===state.selectedArtistPresetId)||null;
  context.storyboardProviderProfile=()=>state.profiles.novel;context.uniqueClean=items=>[...new Set(items.filter(Boolean))];
  vm.runInContext(['storyboardStyleTarget','storyboardApplyRecordStyle','storyboardGenerationPayload','storyboardPromptsForArtist','storyboardJoinPrompt'].map(section).join('\n'),context);
  return {state,context,target:()=>context.storyboardStyleTarget(state)};
}
const idFactory=()=>{let n=0;return prefix=>`${prefix}-${++n}`;};

test('style application distinguishes immutable assets despite both having an empty URL and retains frozen IE and zero strength',()=>{
  const e=setup(),assetRef={version:1,namespace:'st-user:one',id:'a'.repeat(64)},old={...assetRef,id:'b'.repeat(64)};
  e.state.vibeLibrary=[{id:'today',previewUrl:'',assetRef:old,strength:0,informationExtracted:.7}];
  const r={version:1,artist:'',positive:'',negative:'',warnings:[],vibes:[{id:'original',name:'Encoded',previewUrl:'',assetRef,strength:0,information:.7}]};
  const patch=recipe.planStoryboardStyleApplication(e.state,r,e.target(),{vibes:true},{uid:idFactory()});
  assert.equal(patch.vibeLibrary.length,2);assert.deepEqual(patch.vibeLibrary[1].assetRef,assetRef);assert.notEqual(patch.selectedVibeIds[0],'today');
  assetRef.id='c'.repeat(64);assert.equal(patch.vibeLibrary[1].assetRef.id,'a'.repeat(64));
  const normalized=core.normalizeStoryboardState({...e.state,...patch});assert.equal(normalized.vibeLibrary[1].informationExtracted,.7);
});

test('style extraction reads exact frozen front layers and excludes scene, person, seed and connection content',()=>{
  const snap=snapshot(),result=recipe.readStoryboardStyleRecipe(snap);assert.equal(result.artist,'artist:original');assert.equal(result.positive,'old quality');assert.equal(result.negative,'old exclude');assert.equal(result.vibes[0].strength,0);
  assert.doesNotMatch(JSON.stringify(result),/ORIGINAL SCENE|DO NOT COPY|do-not-copy|original.invalid/);assert.deepEqual(snap,snapshot());
});
test('legacy and altered prefixes offer only provable parts; absent Vibe metadata cannot clear current Vibe',()=>{
  const snap=snapshot();delete snap.payload.artistPromptLayer;delete snap.payload.vibeRecipe;delete snap.payload.selectedVibeIds;
  const result=recipe.readStoryboardStyleRecipe(snap);assert.equal(result.artist,'artist:original');assert.equal(result.positive,null);assert.equal(result.negative,null);assert.equal(result.vibes,null);
  const changed=recipe.readStoryboardStyleRecipe(snapshot(),{finalPrompt:'edited scene, artist:original'});assert.equal(changed.artist,null);assert.equal(changed.positive,null);assert.equal(changed.negative,null);
  assert.throws(()=>recipe.readStoryboardStyleRecipe({...snapshot(),source:'banana',profile:{model:'gemini-3-pro-image-preview'}}));
});
test('pure apply plans copy changed library entries without overwriting originals or any scene, model, people or settings outside selected style',()=>{
  const e=setup(),snap=snapshot(),r=recipe.readStoryboardStyleRecipe(snap);e.state.artistPresets.push({id:'original',name:'Edited',value:'artist:original',positivePrompt:'today',negativePrompt:'today'});
  e.state.vibeLibrary=[{id:'original-vibe',name:'Edited Vibe',previewUrl:'/user/images/today.png',strength:1,informationExtracted:1}];
  const before=copy(e.state),patch=recipe.planStoryboardStyleApplication(e.state,r,e.target(),all,{uid:idFactory(),now:1});assert.deepEqual(e.state,before);
  assert.deepEqual(Object.keys(patch).sort(),['artistPresets','promptDefaults','promptDraft','selectedArtistPoolId','selectedArtistPresetId','selectedVibeIds','vibeLibrary'].sort());
  Object.assign(e.state,patch);assert.equal(e.state.artistPresets[1].positivePrompt,'today');assert.equal(e.state.vibeLibrary[0].previewUrl,'/user/images/today.png');
  assert.equal(e.state.selectedArtistPoolId,'');assert.equal(e.state.prompt,before.prompt);assert.deepEqual(e.state.profiles,before.profiles);assert.deepEqual(e.state.connections,before.connections);
  const payload=e.context.storyboardGenerationPayload(e.state,e.state.profiles.novel,{prompt:e.state.prompt,negative:e.state.negative});
  assert.match(payload.prompt,/^artist:original, old quality, CURRENT SCENE/);assert.doesNotMatch(payload.prompt,/ORIGINAL SCENE|DO NOT COPY/);
  assert.equal(payload.vibeRecipe.items[0].previewUrl,'/user/images/old.png');assert.equal(payload.vibeRecipe.items[0].strength,0);
});
test('exact library matches are reused and duplicate source Vibe slots retain distinct selection IDs',()=>{
  const e=setup(),r=recipe.readStoryboardStyleRecipe(snapshot());
  Object.assign(e.state.artistPresets[0],{value:r.artist,positivePrompt:r.positive,negativePrompt:r.negative});
  e.state.vibeLibrary=[{id:'v',name:'V',previewUrl:r.vibes[0].previewUrl,strength:0,informationExtracted:0}];r.vibes.push({...r.vibes[0],id:'second'});
  const patch=recipe.planStoryboardStyleApplication(e.state,r,e.target(),all,{uid:idFactory()});assert.equal(patch.artistPresets,undefined);assert.equal(patch.selectedArtistPresetId,'current');
  assert.equal(patch.vibeLibrary.length,2);assert.equal(new Set(patch.selectedVibeIds).size,2);
});
test('empty style choices really clear selected layers and survive normalization without importing scene text',()=>{
  const e=setup(),r={version:1,artist:'',positive:'',negative:'',vibes:[],warnings:[]};
  Object.assign(e.state,recipe.planStoryboardStyleApplication(e.state,r,e.target(),all,{uid:idFactory()}));
  const normalized=core.normalizeStoryboardState(e.state);assert.equal(normalized.selectedArtistPresetId,'');assert.equal(normalized.promptDraft.artistString,'');
  assert.equal(normalized.promptDefaults[`novel:${model}`].positive,'');assert.equal(normalized.prompt,e.state.prompt);
  const payload=e.context.storyboardGenerationPayload(e.state,e.state.profiles.novel,{prompt:e.state.prompt});assert.match(payload.prompt,/^CURRENT SCENE(?:,|$)/);assert.doesNotMatch(payload.prompt,/artist:|current quality|old quality/);
});
test('unselected negative and artist fields retain current effective values; current preset itself is never overwritten',()=>{
  const e=setup(),r=recipe.readStoryboardStyleRecipe(snapshot()),before=copy(e.state.artistPresets[0]);
  const patch=recipe.planStoryboardStyleApplication(e.state,r,e.target(),{positive:true},{uid:idFactory()});Object.assign(e.state,patch);
  const saved=e.state.artistPresets.find(row=>row.id===e.state.selectedArtistPresetId);assert.equal(saved.value,'artist:current');assert.equal(saved.positivePrompt,'old quality');assert.equal(saved.negativePrompt,'current exclude');assert.deepEqual(e.state.artistPresets[0],before);
});
test('capacity errors are atomic and do not partially install artist fields before Vibe failure',()=>{
  const e=setup(),r=recipe.readStoryboardStyleRecipe(snapshot());e.state.vibeLibrary=Array.from({length:500},(_,i)=>({id:`v${i}`,previewUrl:`/user/images/${i}.png`}));const before=copy(e.state);
  assert.throws(()=>recipe.planStoryboardStyleApplication(e.state,r,e.target(),all,{uid:idFactory()}),/Vibe 库已满/);assert.deepEqual(e.state,before);
  e.state.artistPresets=Array.from({length:200},(_,i)=>({id:`a${i}`,value:`artist:${i}`}));assert.throws(()=>recipe.planStoryboardStyleApplication(e.state,r,e.target(),{artist:true},{uid:idFactory()}),/画师库已满/);
});
test('manual baked prompts, disabled Vibe and exact reference conflicts cannot be bypassed by forged UI selection',()=>{
  const e=setup(),r=recipe.readStoryboardStyleRecipe(snapshot());
  for(const target of [{...e.target(),baked:true},{...e.target(),referenceEnabled:true},{...e.target(),capabilities:{supportsArtistSyntax:true,supportsVibe:false}}]){
    const fields=recipe.storyboardStyleChoices(r,target).fields;assert.ok(!fields.artist||!fields.vibes);
    assert.throws(()=>recipe.planStoryboardStyleApplication(e.state,r,target,all,{uid:idFactory()}),/不再适用/);
  }
});

function actualEntry({review=async()=>all,read=null,save=null}={}){
  const e=setup(),snap=snapshot(),record={id:'image',source:'novel',snapshotRef:'snapshot',finalPrompt:snap.payload.prompt},notices=[];let namespace='st-user:one',chat='chat-one',records=[record],saves=0;
  Object.assign(e.context,{getChatKey:()=>chat,storyboardAdmissionEpoch:1,storyboardGalleryRecords:()=>records,ctx:()=>({}),
    storyboardReadSnapshotForRecord:async()=>{await read?.(e);return snap;},featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:{...recipe,openStoryboardStyleReview:async(...args)=>review(e,...args)}},
    renderModal(){},saveSettings(){saves++;save?.();},toast(message){notices.push(message);return false;}});
  return Object.assign(e,{snap,record,notices,run:options=>e.context.storyboardApplyRecordStyle(record,options),saves:()=>saves,
    setAccount:value=>namespace=value,setChat:value=>chat=value,remove:()=>records=[]});
}
test('actual shared gallery action only applies checked settings and never requests generation or modifies original picture',async()=>{
  const e=actualEntry(),before=copy(e.record);assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(e.saves(),1);assert.deepEqual(e.record,before);assert.equal(e.state.prompt,'CURRENT SCENE');
  assert.match(e.notices[0],/场景与模型保持不变/);
});
test('actual shared action cancels without changes and rejects late source/account/current-style changes',async()=>{
  const cancelled=actualEntry({review:async()=>null}),before=copy(cancelled.state);assert.equal(await cancelled.run(),false);assert.deepEqual(cancelled.state,before);assert.equal(cancelled.saves(),0);
  for(const mutate of [e=>e.setAccount('other'),e=>e.setChat('other'),e=>e.remove(),e=>e.record.finalPrompt='edited',e=>e.record.source='comfy',e=>e.record.imageAdmission={namespace:'other'},e=>e.state.selectedArtistPresetId='',e=>e.state.source='comfy']){
    const e=actualEntry({review:async env=>{mutate(env);return all;}});assert.equal(await e.run(),false);assert.equal(e.saves(),0);assert.ok(e.notices.length);
  }
});
test('actual action refuses a foreign picture and rolls back a synchronous settings failure',async()=>{
  const foreign=actualEntry();foreign.snap.imageAdmission={namespace:'st-user:other'};assert.equal(await foreign.run(),false);assert.equal(foreign.saves(),0);
  const e=actualEntry({save:()=>{throw Error('save refused');}}),before=copy(e.state);assert.equal(await e.run(),false);assert.deepEqual(e.state,before);
});
test('review text is fully escaped and does not fetch original Vibe images or embed original connection metadata',()=>{
  const e=setup(),r=recipe.readStoryboardStyleRecipe(snapshot());r.positive='</pre><img src=x onerror=alert(1)>';
  const html=recipe.renderStoryboardStyleReview(r,e.target());assert.match(html,/&lt;\/pre&gt;/);assert.doesNotMatch(html,/<img|original.invalid|do-not-copy/);assert.match(html,/data-style-field="vibes"/);
});
