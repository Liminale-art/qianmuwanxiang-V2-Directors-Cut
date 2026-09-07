import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {captureStoryboardArtistPromptLayer as capture,retainStoryboardArtistPromptLayer as retain,resolveStoryboardArtistPromptBase as resolve} from '../qianmu-artist-prompt-layer.js';
import {sanitizeStoryboardSnapshot} from '../qianmu-storyboard.js';
import {renderArtistPromptReview} from '../qianmu-artist-prompt-review.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const layer={version:1,positivePrefix:'artist:old, quality',negativePrefix:'blur'};

test('frozen layers remove only their entire starting boundary and retain repeated words inside scene text',()=>{
  assert.deepEqual(resolve(layer,'artist:old, quality, painting signed artist:old, quality flowers','blur, road named blur'),
    {prompt:'painting signed artist:old, quality flowers',negative:'road named blur',needsReview:false});
  for(const prompt of ['scene, artist:old, quality','artist:old, qualityX, scene','artist:old, quality,scene']){
    const result=resolve(layer,prompt,'blur, dust');assert.equal(result.needsReview,true);assert.equal(result.prompt,prompt);assert.equal(result.negative,'blur, dust');
  }
  assert.deepEqual(resolve(layer,'artist:old, quality','blur'),{prompt:'',negative:'',needsReview:false});
  assert.deepEqual(resolve({version:1,positivePrefix:'',negativePrefix:''},'scene','dust'),{prompt:'scene',negative:'dust',needsReview:false});
});

test('missing, invalid, oversized and altered metadata cannot silently behave as an empty known layer',()=>{
  for(const value of [undefined,null,{},[],{...layer,version:2},{...layer,unexpected:'x'},{...layer,positivePrefix:'x'.repeat(24001)},
    {...layer,negativePrefix:'\u0000'}, {...layer,invalid:true}]){
    assert.deepEqual(retain(value),{version:1,invalid:true});assert.equal(resolve(value,'scene','excluded').needsReview,true);
  }
  assert.equal(resolve(null,'scene','').reason,'missing');
  assert.throws(()=>resolve(layer,'x'.repeat(24001),''),/过长/);
  assert.deepEqual(capture({positivePrefix:'artist:old, quality',negativePrefix:'blur',prompt:'different','negative':'blur'}),{version:1,invalid:true});
});

test('snapshot normalization retains exact bounded layers and marks corrupt layers invalid instead of dropping them',()=>{
  for(const value of [layer,{...layer,positivePrefix:'x'.repeat(24000),negativePrefix:'y'.repeat(12000)},{...layer,version:99},null]){
    const snap=sanitizeStoryboardSnapshot({source:'novel',payload:{artistPromptLayer:value}});
    assert.deepEqual(snap.payload.artistPromptLayer,retain(value));
  }
  assert.equal(Object.hasOwn(sanitizeStoryboardSnapshot({source:'novel',payload:{}}).payload,'artistPromptLayer'),false);
});

test('actual payload compilation freezes automatic and hand-locked style layers, while baked hand text requires review',()=>{
  const {state,context}=createStoryboardFormFixture();
  const artist={id:'a',value:'artist:one',positivePrompt:'quality',negativePrompt:'blur'};
  context.uniqueClean=items=>[...new Set(items.filter(Boolean))];context.storyboardSelectedArtistPreset=()=>artist;
  vm.runInContext(['storyboardJoinPrompt','storyboardPromptsForArtist','storyboardGenerationPayload'].map(section).join('\n'),context);
  const profile=context.storyboardProviderProfile(state,'novel');
  for(const shot of [null,{userEdited:true}]){
    const payload=context.storyboardGenerationPayload(state,profile,{prompt:'garden, artist:one',negative:'dust',shot});
    assert.deepEqual(payload.artistPromptLayer,{version:1,positivePrefix:'artist:one, quality',negativePrefix:'blur'});
    const base=resolve(payload.artistPromptLayer,payload.prompt,payload.negative);assert.equal(base.needsReview,false);assert.match(base.prompt,/garden, artist:one/);assert.equal(base.negative,'dust');
  }
  state.promptDraft.artistPositiveBaked=true;
  const payload=context.storyboardGenerationPayload(state,profile,{prompt:'already baked scene',negative:'dust',shot:{userEdited:true}});
  assert.equal(payload.prompt,'already baked scene');assert.equal(payload.artistPromptLayer.invalid,true);
});

test('non-artist providers do not acquire a NAI style layer',()=>{
  for(const family of ['banana','seedream','openai']){
    const {state,context}=createStoryboardFormFixture({family});
    vm.runInContext(section('storyboardGenerationPayload'),context);
    const payload=context.storyboardGenerationPayload(state,context.storyboardProviderProfile(state,family),{prompt:'garden'});
    assert.equal(Object.hasOwn(payload,'artistPromptLayer'),false);
  }
});

test('legacy review displays full escaped text without hidden executable markup',()=>{
  const hostile='</textarea><img src=x onerror=alert(1)>',html=renderArtistPromptReview({prompt:hostile+'x'.repeat(23000),negative:'& " excludes',message:hostile});
  assert.ok(html.includes('x'.repeat(23000)));assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;\/textarea&gt;/);
  assert.match(html,/maxlength="24000"/);assert.match(html,/data-artist-base="negative"/);
});
