import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_PROMPT_FORMATS, STORYBOARD_RENDERINGS_MAX_BYTES,
  normalizeStoryboardPromptFormats, negotiateStoryboardPromptFormats, storyboardPromptRenderingsSchema,
  validateStoryboardPromptRenderings, bindStoryboardPromptRenderings, resolveStoryboardPromptRendering,
} from '../qianmu-prompt-formats.js';
import { normalizeStoryboardShotSpec } from '../qianmu-storyboard.js';
import { CHARACTER_CASTING_SCHEMA } from '../qianmu-character-casting.js';
import {
  STORYBOARD_PLAN_RESPONSE_SCHEMA, buildStoryboardPlanContractRequest, parseStoryboardContractResponse,
  adaptStoryboardPlanContract, repairStoryboardContractOnce,
} from '../qianmu-storyboard-contract.js';

const shot = () => normalizeStoryboardShotSpec({ subject: 'A hands a letter to B', scene: 'kitchen', sensitive: false,
  sourceParagraphIds: ['P1'], insertAfter: 'P1', sharedRelations: ['A faces B'],
  characters: [ { id: 'A', name: 'Alice', identity: ['silver hair'], action: ['giving a letter'], spatial: { center: [0.3, 0.5] } },
    { id: 'B', name: 'Bob', identity: ['black hair'], action: ['receiving the letter'], spatial: { center: [0.7, 0.5] } } ],
  composition: {ratioId:'3:2', focus:'letter'}, promptAtoms: {global:['kitchen'], negative:['extra people']},
});
const forms = () => ({
  tags: { global: 'kitchen, soft light', characters: [{character_id:'B',positive:'black hair, receiving a letter, right'}, {character_id:'A',positive:'silver hair, giving a letter, left'}], negative: 'extra people' },
  natural_language: { global:'A softly lit kitchen.', characters:[{character_id:'A',positive:'Alice with silver hair hands over a letter from the left.'},{character_id:'B',positive:'Bob with black hair receives the letter on the right.'}], negative:'No extra people.' },
  character_blocks: { global:'Scene: a kitchen with soft light.', characters:[{character_id:'A',positive:'Alice: silver hair; giving a letter; left.'},{character_id:'B',positive:'Bob: black hair; receiving the letter; right.'}], negative:'No extra people.' },
});
const check = value => validateStoryboardPromptRenderings(value, {formats:[...STORYBOARD_PROMPT_FORMATS],characterIds:['A','B']});
const plan = () => ({ schema:'qianmu.storyboard.plan.v1',should_generate:true,skip_reason:'',decisions:[],continuity_updates:[],shots:[{
  source_paragraph_ids:['P1'],insert_after:'P1',narrative_layer:'present',narrative_purpose:'handing over a letter',shot_role:'action',shot_scale:'medium_shot',subject:'A gives B a letter',
  scene:{location:'kitchen',time:'day',lighting:['soft light'],environment:[]},
  characters:['A','B'].map((id,index)=>({character_id:id,name:id,fixed_identity:[],
    current_state:{outfit:[],expression:[],pose:[],action:[],gaze:[],props:[]},
    spatial:{order:index+1,region:index?'right':'left',center:{x:index?0.7:0.3,y:0.5},visible_crop:'full'}})),
  shared_relations:[],composition:{ratio_id:'3:2',orientation:'landscape',camera_side:'axis-neutral',angle:'eye-level',focus:'letter',negative_space:'',intent:'handover',continuity_key:'kitchen'},
  prompt_atoms:{global:['kitchen'],character_ids:['A','B'],scene_negative:[]},sensitive:false,safety_notes:[],
}]});

test('format normalization is bounded, deterministic and never accepts guessed labels', () => {
  assert.deepEqual(normalizeStoryboardPromptFormats(['natural_language','tags','tags']),['tags','natural_language']);
  assert.deepEqual(normalizeStoryboardPromptFormats(),[]);
  for (const input of ['tags',null,['flux'],['tags','tags','tags','tags']]) assert.throws(()=>normalizeStoryboardPromptFormats(input),{code:'storyboard_prompt_format'});
});
test('negotiation unions actual families/declarations and leaves unknown Comfy unknown', () => {
  const result=negotiateStoryboardPromptFormats([{providerId:'novel'},{providerId:'openai'}, {providerId:'comfy',promptFormat:'character_blocks'},
    {providerId:'comfy',model:'flux',classification:{promptFormat:'tags'}},{providerId:'banana'},{providerId:'seedream'}]);
  assert.deepEqual(result.formats,[...STORYBOARD_PROMPT_FORMATS]);assert.deepEqual(result.unclassified,[3]);assert.equal(result.executionAuthorized,false);assert.ok(Object.isFrozen(result.formats));
  for(const value of [[{providerId:'comfy',promptFormat:'auto'}],[{providerId:'guess'}],Array(65).fill({providerId:'novel'}),[null]]) assert.throws(()=>negotiateStoryboardPromptFormats(value));
});
test('response schema requests only exact representations with separately identified characters', () => {
  const schema=storyboardPromptRenderingsSchema(['natural_language','tags']);
  assert.deepEqual(schema.required,['tags','natural_language']);assert.equal(schema.additionalProperties,false);
  for(const row of Object.values(schema.properties)) {assert.equal(row.additionalProperties,false);assert.equal(row.properties.characters.maxItems,12);assert.equal(row.properties.characters.items.additionalProperties,false);}
  assert.equal(schema.properties.character_blocks,undefined);
});
test('validation binds by ID, not array position, and preserves each representation without translation', () => {
  const input=forms(), result=check(input);assert.equal(result.ok,true);
  assert.equal(result.data.tags.characters[0].character_id,'A');assert.match(result.data.tags.characters[0].positive,/giving/);
  assert.match(result.data.tags.characters[1].positive,/receiving/);assert.equal(result.data.natural_language.global,'A softly lit kitchen.');
  assert.equal(input.tags.characters[0].character_id,'B');result.data.tags.global='changed';assert.notEqual(input.tags.global,'changed');
});
test('missing, duplicate or invented subjects are rejected, not silently reindexed', () => {
  for(const edit of [value=>value.tags.characters.pop(),value=>value.tags.characters.push(value.tags.characters[0]),value=>value.tags.characters[0].character_id='C']) {
    const input=forms();edit(input);const result=check(input);assert.equal(result.ok,false);assert.equal(result.data,null);assert.ok(result.errors.some(error=>/character/.test(error.code)));
  }
});
test('unrequested format, missing format and fabricated routing/content fields are rejected', () => {
  for(const edit of [value=>delete value.tags,value=>value.unknown=value.tags,value=>value.tags.workflow='x',value=>value.tags.characters[0].adultAllowed=true]) {
    const input=forms();edit(input);assert.equal(check(input).ok,false);
  }
  assert.equal(validateStoryboardPromptRenderings(forms(),{formats:['tags'],characterIds:['A','B']}).ok,false);
});
test('empty shots require a shared visual rendering and never add a phantom person', () => {
  assert.equal(validateStoryboardPromptRenderings({tags:{global:'empty kitchen',characters:[],negative:''}},{formats:['tags']}).ok,true);
  assert.equal(validateStoryboardPromptRenderings({tags:{global:' ',characters:[],negative:''}},{formats:['tags']}).ok,false);
  assert.equal(validateStoryboardPromptRenderings({tags:{global:'kitchen',characters:[{character_id:'A',positive:'person'}],negative:''}},{formats:['tags']}).ok,false);
});
test('text, control characters, cast and aggregate byte limits fail without truncating', () => {
  for(const edit of [value=>value.tags.global='x'.repeat(4001),value=>value.tags.characters[0].positive=' ',value=>value.tags.negative='x\0y']) {
    const input=forms();edit(input);assert.equal(check(input).ok,false);
  }
  const huge=Object.fromEntries(STORYBOARD_PROMPT_FORMATS.map(format=>[format,{global:'景'.repeat(4000),characters:Array.from({length:12},(_,i)=>({character_id:`C${i}`,positive:'人'.repeat(1600)})),negative:'词'.repeat(2000)}]));
  assert.ok(new TextEncoder().encode(JSON.stringify(huge)).byteLength>STORYBOARD_RENDERINGS_MAX_BYTES);
  assert.equal(validateStoryboardPromptRenderings(huge,{formats:[...STORYBOARD_PROMPT_FORMATS],characterIds:Array.from({length:12},(_,i)=>`C${i}`)}).errors[0].code,'max_bytes');
  for(const ids of [['A','A'],Array(13).fill('A'),[0]]) assert.equal(validateStoryboardPromptRenderings(forms(),{formats:['tags'],characterIds:ids}).ok,false);
  const cycle={};cycle.tags=cycle;assert.equal(check(cycle).ok,false);
});
test('binding and resolving use real SHA-256 and immutable detached text without execution authority', async () => {
  const spec=shot(), input=forms(), before=JSON.stringify(spec), pack=await bindStoryboardPromptRenderings(spec,input);
  assert.match(pack.sourceHash,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(pack.renderings.tags.characters));input.tags.global='mutated';
  const result=await resolveStoryboardPromptRendering(spec,pack,'tags');assert.equal(result.global,'kitchen, soft light');assert.equal(result.executionAuthorized,false);assert.ok(Object.isFrozen(result));assert.equal(JSON.stringify(spec),before);
});
test('visual, ownership and safety edits invalidate old renderings; insertion/job status do not', async () => {
  const spec=shot(),pack=await bindStoryboardPromptRenderings(spec,forms());
  for(const edit of [s=>s.sensitive=true,s=>s.characters[0].identity=['black hair'],s=>s.characters.reverse(),s=>s.characters[0].action=['eating'],s=>s.composition.focus='window',s=>s.scene='garden',s=>s.promptAtoms.global.push('rain')]) {
    const changed=structuredClone(spec);edit(changed);await assert.rejects(resolveStoryboardPromptRendering(changed,pack,'tags'),{code:'storyboard_prompt_format'});
  }
  spec.sourceParagraphIds=['P2'];spec.insertAfter='P2';spec.jobStatus='running';spec.characters[0].archiveSnapshot={private:'must not enter format snapshot'};
  assert.equal((await resolveStoryboardPromptRendering(spec,pack,'tags')).sourceHash,pack.sourceHash);assert.doesNotMatch(JSON.stringify(pack),/private|archiveSnapshot/);
});
test('missing/stale packs and missing format never fall back to a legacy comma string', async () => {
  const spec=shot(),pack=await bindStoryboardPromptRenderings(spec,{tags:forms().tags});
  await assert.rejects(resolveStoryboardPromptRendering(spec,pack,'natural_language'),/缺少/);
  for(const value of [null,{...pack,schema:'v999'},{...pack,sourceHash:'bad'},{...pack,sourceHash:'0'.repeat(64)}]) await assert.rejects(resolveStoryboardPromptRendering(spec,value,'tags'));
});
test('in-flight fact changes and scope guards abort both preparation and consumption', async () => {
  const spec=shot();await assert.rejects(bindStoryboardPromptRenderings(spec,forms(),{guard:async()=>{spec.scene='changed';}}),/事实已变化/);
  const stable=shot(),pack=await bindStoryboardPromptRenderings(stable,forms());
  await assert.rejects(resolveStoryboardPromptRendering(stable,pack,'tags',{guard:async()=>{stable.scene='changed';}}),/事实已变化/);
  await assert.rejects(bindStoryboardPromptRenderings(shot(),forms(),{guard:async()=>{throw Error('scope changed');}}),/scope changed/);
});
test('no WebCrypto yields a concise failure, not an unverified hash substitute', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});
  try {await assert.rejects(bindStoryboardPromptRenderings(shot(),forms()),/无法核对/);} finally {if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
});
test('legacy plan request/response and shared schema are unchanged unless formats are explicitly requested', () => {
  const request=buildStoryboardPlanContractRequest({paragraphs:['text']},{providerId:'novel'});
  assert.equal(request.schema,STORYBOARD_PLAN_RESPONSE_SCHEMA);assert.equal(request.promptFormats,undefined);assert.equal(JSON.parse(request.messages[1].content).constraints.prompt_formats,undefined);
  assert.equal(parseStoryboardContractResponse(JSON.stringify(plan())).ok,true);
  assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.items.properties.prompt_renderings,undefined);
});
test('one extraction schema can request the exact union alongside primary-character selection', () => {
  const request=buildStoryboardPlanContractRequest({paragraphs:['text'],characterCasting:{schema:CHARACTER_CASTING_SCHEMA,referenceMode:'novel-primary',entries:[]}},{providerId:'novel',promptFormats:['tags','natural_language']});
  assert.equal(request.messages.length,2);assert.deepEqual(request.promptFormats,['tags','natural_language']);assert.deepEqual(JSON.parse(request.messages[1].content).constraints.prompt_formats,request.promptFormats);
  assert.ok(request.schema.properties.shots.items.required.includes('primary_subject_id'));assert.ok(request.schema.properties.shots.items.required.includes('prompt_renderings'));
  assert.deepEqual(request.schema.properties.shots.items.properties.prompt_renderings.required,request.promptFormats);
  assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.items.properties.prompt_renderings,undefined);
});
test('actual plan parser enforces requested representations and adapters preserve them separately from authoritative facts', () => {
  const value=plan();value.shots[0].prompt_renderings=forms();const options={promptFormats:[...STORYBOARD_PROMPT_FORMATS],allowedParagraphIds:['P1']};
  const result=parseStoryboardContractResponse(JSON.stringify(value),options);assert.equal(result.ok,true,JSON.stringify(result.errors));
  const adapted=adaptStoryboardPlanContract(result.data,options);assert.equal(adapted.shots[0].promptRenderings.tags.characters[0].character_id,'A');
  assert.equal(adapted.shots[0].shotSpec.promptRenderings,undefined);assert.equal(adapted.shots[0].shotSpec.characters.length,2);assert.equal(adapted.shots[0].paragraph_index,0);
  assert.equal(parseStoryboardContractResponse(JSON.stringify(value)).ok,false);
  delete value.shots[0].prompt_renderings;assert.equal(parseStoryboardContractResponse(JSON.stringify(value),options).ok,false);
});
test('skip decisions need no fake renderings, and invalid IDs cannot pass the direct adapter', () => {
  const skipped={...plan(),should_generate:false,skip_reason:'no new visual facts',shots:[]};assert.equal(parseStoryboardContractResponse(JSON.stringify(skipped),{promptFormats:['tags']}).ok,true);
  const value=plan();value.shots[0].prompt_renderings={tags:forms().tags};value.shots[0].prompt_renderings.tags.characters[0].character_id='C';assert.throws(()=>adaptStoryboardPlanContract(value),/未出镜/);
});
test('existing one-shot repair retains format requirements and cannot silently drop them', async () => {
  const value=plan();value.shots[0].prompt_renderings={tags:forms().tags};value.shots[0].prompt_renderings.tags.characters[0].character_id='C';let calls=0;
  const result=await repairStoryboardContractOnce({raw:JSON.stringify(value),options:{kind:'plan',promptFormats:['tags']},request:async messages=>{
    calls++;assert.deepEqual(JSON.parse(messages[1].content).prompt_formats,['tags']);return JSON.stringify(plan());
  }});assert.equal(calls,1);assert.equal(result.ok,false);assert.equal(result.repairCalls,1);
  const fixed=plan();fixed.shots[0].prompt_renderings={tags:forms().tags};
  const success=await repairStoryboardContractOnce({raw:JSON.stringify(value),options:{kind:'plan',promptFormats:['tags']},request:async()=>JSON.stringify(fixed)});assert.equal(success.ok,true);
});
test('format contract has no network, workflow mutation, provider queue or startup activation', async () => {
  const source=await readFile(new URL('../qianmu-prompt-formats.js',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(fetch|XMLHttpRequest|WebSocket|indexedDB)\b/);
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.doesNotMatch(index,/promptFormats:\s*negotiateStoryboardPromptFormats/);
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));assert.ok(release.files.includes('qianmu-prompt-formats.js'));
});
