import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as art from '../qianmu-art-directions.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {captureStoryboardPackageSettings} from '../qianmu-storyboard-package-fields.js';
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(family='novel'){
  const f=createStoryboardFormFixture({family});f.context.uniqueClean=items=>[...new Set(items.filter(Boolean))];
  f.context.saveSettings=()=>{};f.context.renderModal=()=>{};f.context.toast=message=>{throw Error(message);};
  vm.runInContext(['storyboardJoinPrompt','storyboardPromptsForArtist','storyboardGenerationPayload','storyboardProfileSnapshot','storyboardLoadArtistPreset','storyboardLoadArtistChoice'].map(section).join('\n'),f.context);
  return {...f,payload:(options={})=>f.context.storyboardGenerationPayload(f.state,f.context.storyboardProviderProfile(f.state),{prompt:'kitchen in blue light',negative:'extra cup',...options})};
}

test('old and empty profiles never silently acquire an art direction or rewrite user defaults',()=>{
  const state=core.normalizeStoryboardState({schemaVersion:24,promptDefaults:{'novel:model':{positive:'mine',negative:''}}});
  for(const profile of Object.values(state.profiles))assert.equal(Object.hasOwn(profile,'artDirection'),false);
  assert.deepEqual(state.promptDefaults['novel:model'],{positive:'mine',negative:''});
  assert.equal(art.STORYBOARD_ART_DIRECTIONS.length,2);assert.ok(Object.isFrozen(art.STORYBOARD_ART_DIRECTIONS[0]));
});

test('explicit invalid choices stay visibly invalid while Comfy has no closed-model art control',()=>{
  for(const value of ['bogus',null,{},['anime']])assert.equal(core.normalizeStoryboardParameterProfile({artDirection:value},'novel').artDirection,'[invalid]');
  assert.equal(Object.hasOwn(core.normalizeStoryboardParameterProfile({artDirection:'cg'},'comfy'),'artDirection'),false);
  const defaults={positive:'workflow words',negative:'workflow exclusion'};
  assert.equal(art.storyboardArtDirectionDefaults(defaults,{artDirection:'bad'},'comfy'),defaults);
  assert.throws(()=>art.storyboardArtDirectionDefaults(defaults,{artDirection:'bad'},'novel'),/未更换/);
});

for(const family of ['novel','banana','seedream','openai'])test(`${family}: actual automatic and manual payloads use the right rendering and keep negative defaults`,()=>{
  const f=fixture(family),profile=f.state.profiles[family];profile.artDirection='cg';
  const effective=f.context.storyboardProviderProfile(f.state);
  f.state.promptDefaults[f.context.storyboardPromptDefaultsKey(family,effective.model)]={positive:'MY_QUALITY',negative:'MY_EXCLUSION'};
  for(const shot of [null,{userEdited:true}]){
    const payload=f.payload({shot});const prefix=family==='novel'?art.STORYBOARD_ART_DIRECTIONS[1].tags:art.STORYBOARD_ART_DIRECTIONS[1].natural;
    assert.ok(payload.prompt.startsWith(prefix));assert.ok(payload.prompt.includes('MY_QUALITY'));assert.ok(payload.prompt.includes('kitchen in blue light'));
    assert.ok(payload.negative.includes('MY_EXCLUSION'));assert.ok(payload.negative.includes('extra cup'));assert.equal(payload.artistString,'');
    if(family!=='novel'){assert.equal(Object.hasOwn(payload,'artistPromptLayer'),false);assert.equal(Object.hasOwn(payload.parameters.providerOptions,'v4_prompt'),false);assert.doesNotMatch(payload.prompt,/stylized 3d, cinematic game art/);}
  }
});

test('actual selection writes the owned profile and does not erase another family custom artist',()=>{
  const f=fixture();f.state.artistPresets=[{id:'mine',name:'Mine',value:'artist:mine'}];f.state.selectedArtistPresetId='mine';
  f.context.storyboardLoadArtistChoice('direction:anime');assert.equal(f.state.profiles.novel.artDirection,'anime');assert.equal(f.state.selectedArtistPresetId,'');
  f.context.storyboardLoadArtistChoice('artist:mine');assert.equal(f.state.profiles.novel.artDirection,'');assert.equal(f.state.selectedArtistPresetId,'mine');
  f.state.source='banana';f.context.storyboardLoadArtistChoice('direction:cg');assert.equal(f.state.profiles.banana.artDirection,'cg');assert.equal(f.state.selectedArtistPresetId,'mine');
  f.context.storyboardLoadArtistChoice('');assert.equal(f.state.profiles.banana.artDirection,'');assert.equal(f.state.selectedArtistPresetId,'mine');
  f.state.source='comfy';assert.throws(()=>art.selectStoryboardArtDirection(f.state,f.state.profiles.comfy,'anime'),/工作流/);
});

test('NAI custom artists and fixed shot assignments take priority without changing their unfilled default fields',()=>{
  const f=fixture();f.state.profiles.novel.artDirection='anime';
  const artist={id:'mine',value:'artist:mine',positivePrompt:'',negativePrompt:''};f.context.storyboardSelectedArtistPreset=()=>artist;
  const p=f.payload({artistAssignment:{artist}});assert.match(p.prompt,/^artist:mine/);assert.doesNotMatch(p.prompt,/anime illustration/);
  f.context.storyboardSelectedArtistPreset=()=>null;f.state.promptDraft.artistString='artist:manual';
  assert.doesNotMatch(f.payload().prompt,/anime illustration/);
  f.state.promptDraft.artistString='';f.state.promptDraft.artistPositiveBaked=true;
  assert.equal(f.payload({shot:{userEdited:true},prompt:'already approved complete text'}).prompt,'already approved complete text');
});

test('NAI native base caption and frozen replacement layer contain one matching default style',()=>{
  const f=fixture();f.state.profiles.novel.artDirection='anime';
  const p=f.payload({shot:{shotSpec:{scene:'kitchen',characters:[{id:'A',name:'Alice',identity:['silver hair']}],promptAtoms:{global:['blue light'],negative:[]}}}});
  const prefix=art.STORYBOARD_ART_DIRECTIONS[0].tags;
  assert.ok(p.prompt.startsWith(prefix));assert.ok(p.parameters.providerOptions.v4_prompt.caption.base_caption.startsWith(prefix));
  assert.equal(p.parameters.providerOptions.v4_prompt.caption.char_captions.length,1);
  const base=core.resolveStoryboardArtistPromptBase(p.artistPromptLayer,p.prompt,p.negative);assert.equal(base.needsReview,false);assert.doesNotMatch(base.prompt,/anime illustration/);assert.match(base.prompt,/blue light/);
});

test('model memory, parameter presets, actual profile snapshots and full settings backups retain explicit choices only',()=>{
  const f=fixture(),profile={...f.context.storyboardProviderProfile(f.state),artDirection:'cg'};
  core.rememberStoryboardModelProfile(f.state.modelProfiles,'novel',profile);
  assert.equal(core.getStoryboardRememberedProfile(f.state.modelProfiles,'novel',profile.model,profile.capabilityModelId).artDirection,'cg');
  f.state.profiles.novel=profile;f.state.parameterPresets=[{id:'p',name:'P',source:'novel',profile}];
  const snapshot=f.context.storyboardProfileSnapshot(profile,'novel');assert.equal(snapshot.artDirection,'cg');profile.artDirection='anime';assert.equal(snapshot.artDirection,'cg');
  const saved=core.sanitizeStoryboardSnapshot({source:'novel',profile:snapshot});assert.equal(saved.profile.artDirection,'cg');
  const restored=core.normalizeStoryboardState(plain(captureStoryboardPackageSettings(f.state)));assert.equal(restored.profiles.novel.artDirection,'anime');assert.equal(restored.parameterPresets[0].profile.artDirection,'anime');
});

test('workbench provides two choices without NAI-only controls in other model families, and escapes foreign names',()=>{
  for(const family of ['novel','banana','seedream','openai']){
    const f=fixture(family);f.state.artistPresets=[{id:'bad"',name:'<img onerror=x>',value:'artist'}];
    const html=f.context.renderStoryboardModelCreate(f.state);assert.match(html,/direction:anime/);assert.match(html,/direction:cg/);assert.doesNotMatch(html,/<img onerror/);
    if(family!=='novel'){assert.doesNotMatch(html,/sd-storyboard-open-artist-library|value="artist:/);assert.match(html,/内置画风/);}
  }
  assert.equal(art.renderStoryboardArtDirectionChoice({source:'comfy'},{},{}),'');
  const f=fixture();f.state.profiles.novel.artDirection='unknown';assert.match(f.context.renderStoryboardModelCreate(f.state),/原画风不可用/);
});

test('overlong style plus remembered defaults fail instead of truncating user text',()=>{
  const d={positive:'x'.repeat(12000),negative:'keep'},before=structuredClone(d);
  assert.throws(()=>art.storyboardArtDirectionDefaults(d,{artDirection:'anime'},'novel'),/未截断/);assert.deepEqual(d,before);
  assert.equal(art.storyboardArtDirectionDefaults(d,{artDirection:''},'novel'),d);
});

test('actual compiler to queue preserves three ordered shots and frozen styles with only the original two LLM steps',async()=>{
  const e=await compilerEnvironment();e.state.routing.enabled=false;e.state.profiles.novel.artDirection='cg';
  assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,2);
  await e.context.storyboardGenerate(null);assert.equal(e.jobs.length,3,JSON.stringify(e.notices));assert.equal(e.llmCalls.length,2);
  const prefix=art.STORYBOARD_ART_DIRECTIONS[1].tags;
  assert.deepEqual(e.jobs.map(job=>job.profile.artDirection),['cg','cg','cg']);assert.ok(e.jobs.every(job=>job.payload.prompt.startsWith(prefix)));
  e.state.profiles.novel.artDirection='anime';core.normalizeStoryboardState(e.state);
  assert.ok(e.jobs.every(job=>job.profile.artDirection==='cg'&&job.payload.prompt.startsWith(prefix)));
});
