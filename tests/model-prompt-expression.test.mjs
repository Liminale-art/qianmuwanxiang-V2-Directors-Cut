import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {bindStoryboardPromptRenderings} from '../qianmu-prompt-formats.js';
import {prepareCharacterShotEdit} from '../qianmu-character-shot-edit.js';
import {adaptStoryboardSafetyContract,STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID} from '../qianmu-storyboard-contract.js';
import {generateDirectImage} from '../qianmu-image-direct.js';
import {generateImage} from '../qianmu-image-gateway.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
const copy=value=>structuredClone(value);
async function setup(source='novel'){
  const {state,context}=createStoryboardFormFixture({family:source});
  const shot=core.normalizeStoryboardShotSpec({id:'s',subject:'厨房',scene:'原场景',promptAtoms:{global:['两人做饭'],negative:['旧排除']},composition:{ratioId:'3:2'},
    characters:[{id:'a',name:'Alice',identity:['蓝发'],action:['搅汤'],negative:'A incorrect face',spatial:{center:[.2,.5]}},
      {id:'b',name:'Bob',identity:['棕发'],action:['看信'],negative:'B incorrect face',spatial:{center:[.8,.5]}}]});
  const values=Object.fromEntries(['tags','natural_language'].map(format=>[format,{global:'kitchen, soft light',negative:'blurred frame',characters:[
    {character_id:'b',positive:'brown hair, reads a letter'},{character_id:'a',positive:'blue hair, stirs soup'}]}]));
  shot.promptRenderingPack=await bindStoryboardPromptRenderings(shot,values);
  context.storyboardSelectedArtistPreset=()=>({id:'artist',value:'artist:tester',positivePrompt:'artist positive',negativePrompt:'artist negative'});
  context.storyboardProviderPromptDefaults=()=>({positive:'model positive',negative:'model negative'});
  vm.runInContext(['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardGenerationPayload'].map(section).join('\n'),context);
  const profile=context.storyboardProviderProfile(state,source),connection={...state.connections[source].draft,credentialId:'test-reference',baseUrl:core.STORYBOARD_PROVIDER_REGISTRY[source].defaultBaseUrl};
  const payload=context.storyboardGenerationPayload(state,profile,{sourceId:source,shot:{shotSpec:shot},connection});
  const job={id:'model-test',source,profile,connection,shotSpec:shot,payload,target:'gallery',automatic:false,chatKey:'chat-a'};
  return {state,context,shot,values,profile,connection,payload,job};
}

test('NAI expressions preserve front artist defaults, native per-person captions/centers and own exclusions without translated/raw duplication',async()=>{
  const e=await setup();await core.verifyStoryboardModelPromptJob(e.job);
  assert.equal(e.payload.prompt,'artist:tester, artist positive, kitchen, soft light');assert.doesNotMatch(e.payload.prompt,/蓝发|blue hair|原场景/);
  const p=e.payload.parameters.providerOptions;
  assert.equal(p.v4_prompt.caption.char_captions[0].char_caption,'"Alice": blue hair, stirs soup');
  assert.equal(p.v4_prompt.caption.char_captions[1].char_caption,'"Bob": brown hair, reads a letter');
  assert.deepEqual(copy(p.v4_prompt.caption.char_captions[0].centers),[{x:.2,y:.5}]);
  assert.match(e.payload.negative,/^artist negative, blurred frame/);assert.doesNotMatch(e.payload.negative,/A incorrect|旧排除/);
  assert.equal(p.v4_negative_prompt.caption.char_captions[0].char_caption,'A incorrect face');
});

test('natural-language model families consume separate descriptions, exclude unsupported artist syntax and retain scoped exclusions',async()=>{
  for(const source of ['banana','openai','seedream']){
    const e=await setup(source);await core.verifyStoryboardModelPromptJob(e.job);
    assert.equal(e.payload.compiledPrompt.promptFormat,'natural_language');assert.match(e.payload.prompt,/^model positive\n\nkitchen, soft light\n\n"Alice": blue hair/);
    assert.match(e.payload.prompt,/Undesired traits for "Bob" only: B incorrect face/);
    assert.doesNotMatch(e.payload.prompt,/artist:tester|蓝发|原场景/);assert.equal(e.payload.parameters.providerOptions.v4_prompt,undefined);
    assert.match(e.payload.negative,/^model negative\n\nblurred frame/);
  }
});

test('native-expression markers survive log normalization and original retry while manual overrides and legacy history retain frozen text',async()=>{
  const e=await setup(),snapshot={...e.job,payload:copy(e.payload),compiledPrompt:copy(e.payload.compiledPrompt)};
  const normalized=core.normalizeStoryboardState({...core.createStoryboardDefaults(),logs:[{id:'log',source:'novel',status:'success',snapshot}]}).logs[0].snapshot;
  await core.verifyStoryboardModelPromptJob({...normalized,payload:normalized.payload});
  vm.runInContext(section('storyboardJobFromLog'),e.context);
  const retried=e.context.storyboardJobFromLog({id:'log',source:'novel',status:'failed',snapshot:normalized});assert.ok(retried);await core.verifyStoryboardModelPromptJob(retried);
  const manual={...retried,promptLocked:true};manual.payload.shotSpec.subject='manual changed facts';manual.payload.prompt='my exact text';
  assert.equal(await core.verifyStoryboardModelPromptJob(manual),null);assert.equal(manual.payload.prompt,'my exact text');
  const legacy=copy(manual);legacy.promptLocked=false;delete legacy.payload.compiledPrompt.promptFormat;
  assert.equal(await core.verifyStoryboardModelPromptJob(legacy),null);
});

test('new expression proof refuses changed facts, missing format, safety rewrites, pending cancellation and mutation during verification',async()=>{
  for(const change of [e=>{e.job.payload.shotSpec.characters[0].action=['different'];},e=>{e.job.payload.compiledPrompt.promptFormat='natural_language';},e=>{e.job.safetyAdapted=true;}]){
    const e=await setup();change(e);await assert.rejects(()=>core.verifyStoryboardModelPromptJob(e.job));
  }
  const e=await setup();await assert.rejects(()=>core.verifyStoryboardModelPromptJob(e.job,{guard:()=>{throw Error('cancelled');}}),/cancelled/);
  await assert.rejects(()=>core.verifyStoryboardModelPromptJob(e.job,{guard:()=>{e.job.payload.prompt='changed during hashing';}}),/已变化/);
  const missing=copy(e.shot);delete missing.promptRenderingPack.renderings.natural_language;
  assert.throws(()=>core.compileStoryboardPrompt({providerId:'banana',shot:missing}),/缺少/);
});

test('editing one native character rebuilds that person only, preserves others translated captions and retires old automatic expressions',async()=>{
  const e=await setup(),snapshot={...e.job,payload:copy(e.payload),compiledPrompt:copy(e.payload.compiledPrompt)},characters=copy(e.shot.characters);
  characters[0].identity=['green hair'];
  const result=await prepareCharacterShotEdit(snapshot,characters,{namespace:'st-user:test'});
  const after=result.snapshot.payload.parameters.providerOptions;
  assert.match(after.v4_prompt.caption.char_captions[0].char_caption,/green hair/);assert.doesNotMatch(after.v4_prompt.caption.char_captions[0].char_caption,/blue hair/);
  assert.deepEqual(after.v4_prompt.caption.char_captions[1],copy(e.payload.parameters.providerOptions.v4_prompt.caption.char_captions[1]));
  assert.equal(result.snapshot.payload.prompt,e.payload.prompt);assert.equal(result.snapshot.payload.shotSpec.promptRenderingPack,undefined);
  assert.equal(result.snapshot.payload.compiledPrompt.promptFormat,undefined);assert.equal(result.snapshot.promptLocked,true);
});

test('actual admission and last submission boundary check expressions before acquiring paid execution eligibility',async()=>{
  const e=await setup(),events=[];
  Object.assign(e.context,{storyboardAdmissionEpoch:1,storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:10,
    getChatKey:()=> 'chat-a',storyboardImageAdmissionRuntime:async()=>({admit:async()=>events.push('admit')}),
    storyboardGalleryRecords:()=>[],storyboardStartLog:()=>({id:'log'}),storyboardPlanForJob:()=>null,storyboardSetPlanStatus(){},saveSettings(){},renderModal(){},storyboardPumpQueue(){},
    storyboardScheduleInlineRender(){},toast:message=>events.push(message),storyboardValidatedAnchor:()=>({valid:true})});
  vm.runInContext(section('storyboardQueueJob'),e.context);
  const bad=copy(e.job);bad.payload.shotSpec.subject='changed';assert.equal(await e.context.storyboardQueueJob(bad),false);assert.equal(events.includes('admit'),false);
  assert.equal(await e.context.storyboardQueueJob(e.job),true,events.join(';'));assert.equal(events.filter(x=>x==='admit').length,1);
  const source=section('storyboardRunJob'),start=source.indexOf('  const beforeSubmit ='),end=source.indexOf('\n  };',start)+5;
  Object.assign(e.context,{job:e.job,log:null,channelTicket:null,admissionOutcome:'not_submitted',storyboardAdmission:{beforeSubmit:async()=>events.push('submit')}});
  vm.runInContext(source.slice(start,end)+'\n globalThis.lastSubmit=beforeSubmit;',e.context);
  await e.context.lastSubmit();assert.equal(events.filter(x=>x==='submit').length,1);
  e.job.payload.shotSpec.subject='changed after admission';await assert.rejects(()=>e.context.lastSubmit());assert.equal(events.filter(x=>x==='submit').length,1);
});

test('new NAI expressions reach both real request builders with identical native character captions and no raw-source fallback',async()=>{
  const e=await setup(),requests=[],fetchImpl=async(url,options)=>{requests.push(JSON.parse(options.body));return new Response('fixture response',{status:400});};
  const request={provider:'novel',baseUrl:e.connection.baseUrl,apiKey:'fixture',model:e.profile.model,prompt:e.payload.prompt,negativePrompt:e.payload.negative,parameters:e.payload.parameters};
  await assert.rejects(()=>generateDirectImage(request,{fetchImpl,beforeSubmit:()=>core.verifyStoryboardModelPromptJob(e.job)}));
  await assert.rejects(()=>generateImage(request,{fetchImpl,resolveHost:async()=>[{address:'93.184.216.34',family:4}]}));
  assert.equal(requests.length,2);
  for(const key of ['v4_prompt','v4_negative_prompt'])assert.deepEqual(requests[0].parameters[key],requests[1].parameters[key]);
  assert.match(requests[0].parameters.v4_prompt.caption.base_caption,/^artist:tester, artist positive, kitchen/);
  assert.equal(requests[0].parameters.v4_prompt.caption.char_captions[1].char_caption,'"Bob": brown hair, reads a letter');
  assert.doesNotMatch(JSON.stringify(requests),/两人做饭|蓝发|旧排除/);
});

test('structured and local safety replacements explicitly retire old expressions so previous content cannot be compiled back in',async()=>{
  const e=await setup();
  const adapted=adaptStoryboardSafetyContract({schema:STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,replacement_visual:'safe replacement',
    prompt_atoms:{global:['safe replacement'],scene_negative:['excluded content']},character_updates:[],adaptation_note:'adapted'},e.shot);
  assert.equal(adapted.promptRenderingPack,undefined);assert.ok(e.shot.promptRenderingPack);
  assert.doesNotMatch(core.compileStoryboardPrompt({providerId:'novel',shot:adapted}).prompt,/kitchen, soft light/);
  vm.runInContext(section('storyboardSafeShotSpecFromPrompt'),e.context);
  const local=e.context.storyboardSafeShotSpecFromPrompt({shotSpec:e.shot},'safe fallback');
  assert.equal(local.promptRenderingPack,undefined);assert.equal(local.characters.length,0);
  assert.match(core.compileStoryboardPrompt({providerId:'banana',shot:local}).prompt,/safe fallback/);
});

test('real prose compiler creates one multi-format plan and mixed NAI/Comfy generation consumes each correct expression in narrative order',async()=>{
  const e=await compilerEnvironment();e.state.routing.rules[0].target={providerId:'novel',modelId:'nai-diffusion-4-5-full',capabilityModelId:'nai-diffusion-4-5-full'};
  assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));
  assert.equal(await e.context.storyboardGenerate(null),true,JSON.stringify(e.notices));assert.equal(e.llmCalls.length,1);assert.equal(e.jobs.length,3);
  assert.deepEqual(e.jobs.map(job=>job.source),['novel','comfy','novel']);
  assert.match(e.jobs[0].payload.prompt,/tag-scene-0/);assert.match(e.jobs[1].payload.prompt,/Natural scene 1/);assert.match(e.jobs[2].payload.prompt,/tag-scene-2/);
  assert.deepEqual(e.jobs.map(job=>job.inlineOrder.shotIndex),[0,1,2]);
});

test('named-model single-person edits retain the other translated block and user-added surrounding text',async()=>{
  const e=await setup('banana'),snapshot={...e.job,payload:copy(e.payload)},characters=copy(e.shot.characters);
  snapshot.payload.prompt='custom introduction\n'+snapshot.payload.prompt+'\ncustom ending';characters[0].identity=['green hair'];
  const result=await prepareCharacterShotEdit(snapshot,characters,{namespace:'st-user:test'});
  assert.match(result.snapshot.payload.prompt,/^custom introduction/);assert.match(result.snapshot.payload.prompt,/custom ending$/);
  assert.match(result.snapshot.payload.prompt,/green hair/);assert.doesNotMatch(result.snapshot.payload.prompt,/blue hair/);
  assert.match(result.snapshot.payload.prompt,/"Bob": brown hair, reads a letter/);assert.equal(result.snapshot.payload.shotSpec.promptRenderingPack,undefined);
});
