import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStoryboardState, normalizeStoryboardShotSpec, compileStoryboardPrompt, sanitizeStoryboardSnapshot } from '../qianmu-storyboard.js';
import { CHARACTER_CASTING_SCHEMA } from '../qianmu-character-casting.js';
import { planCharacterReference } from '../qianmu-character-reference.js';
import { getStoryboardCapabilities } from '../qianmu-storyboard.js';

const receipt={url:'/user/images/Qianmu-References/a.png',name:'Alice',mime:'image/png',bytes:70,sha256:'a'.repeat(64)};
const spec=()=>normalizeStoryboardShotSpec({id:'one',subject:'Alice passes a letter to Bob',scene:'kitchen',sourceParagraphIds:['P1'],insertAfter:'P1',primarySubjectId:'archive:alice',
  characters:[{id:'archive:alice',name:'Alice',identity:['silver hair'],outfit:['coat removed'],expression:['hesitant'],action:['passes a letter'],props:['letter'],spatial:{center:[0.3,0.5],crop:'waist'},
    archiveSnapshot:{schema:CHARACTER_CASTING_SCHEMA,archiveId:'alice',archiveVersion:1,subjectId:'archive:alice',category:'char',match:'alias',sourceCharacterId:'A',name:'Alice',negativeScope:'model_interface',negative:'Alice-specific unwanted trait',
      imageReference:{version:1,namespace:'st-user:test',reference:receipt,strength:0.4,fidelity:0},comfyImplementation:{version:1,namespace:'st-user:test',implementations:[],reference:null}}},
  {id:'B',name:'Bob',identity:['black hair'],outfit:['apron'],action:['receives the letter'],spatial:{center:[0.7,0.5]}}],
  composition:{ratioId:'3:2',framing:['two people facing each other'],focus:'letter'},promptAtoms:{global:['kitchen'],camera:['eye-level'],negative:['extra people']},
  continuityUpdates:{facts:[{category:'outfit',subject:'archive:alice',key:'outerwear',value:'coat removed',persistence:'persistent',sourceParagraphIds:['P1'],evidence:'Alice has removed her coat.'}]},
});
const draft=()=>({id:'one',prompt:'Alice passes a letter to Bob',negative:'extra people',title:'handover',role:'action',shotType:'group',paragraphIndex:1,userEdited:false,shotSpec:spec()});
const state=()=>({prompt:'Alice passes a letter to Bob',promptDraft:{compiled:'visible preview',userEditedCompiled:false,sourceSummary:['floor 1'],shots:[draft()]}});
const roundtrip=value=>normalizeStoryboardState(JSON.parse(JSON.stringify(value)));

test('draft reload preserves typed visible state, ownership, spatial arrays, atoms and continuity facts',()=>{
  const original=state(),result=roundtrip(original),row=result.promptDraft.shots[0];
  assert.deepEqual(row.shotSpec,original.promptDraft.shots[0].shotSpec);
  assert.equal(row.shotSpec.characters.length,2);assert.deepEqual(row.shotSpec.characters[0].outfit,['coat removed']);assert.deepEqual(row.shotSpec.characters[1].outfit,['apron']);
  assert.equal(row.shotSpec.continuityUpdates.facts[0].value,'coat removed');assert.equal(row.paragraphIndex,1);assert.equal(row.title,'handover');assert.equal(result.promptDraft.compiled,'visible preview');
});
test('repeated settings normalization is idempotent and does not progressively erase characters',()=>{
  let saved=state();const before=JSON.stringify(saved.promptDraft.shots[0].shotSpec);
  for(let index=0;index<10;index++)saved=roundtrip(saved);
  assert.equal(JSON.stringify(saved.promptDraft.shots[0].shotSpec),before);
  assert.equal(saved.promptDraft.shots[0].shotSpec.characters[0].archiveSnapshot.archiveVersion,1);
});
test('actual NAI recompile and character reference planning after reload match before reload',()=>{
  const original=state().promptDraft.shots[0].shotSpec,loaded=roundtrip(state()).promptDraft.shots[0].shotSpec;
  const compile=shot=>compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-4-5-full',shot});
  assert.deepEqual(compile(loaded),compile(original));assert.equal(compile(loaded).providerOptions.v4_prompt.caption.char_captions.length,2);
  assert.match(compile(loaded).providerOptions.v4_prompt.caption.char_captions[0].char_caption,/silver hair.*coat removed.*passes a letter/);
  const reference=shot=>planCharacterReference({source:'novel',enabled:true,capabilities:getStoryboardCapabilities('novel','nai-diffusion-4-5-full'),shot});
  assert.deepEqual(reference(loaded),reference(original));assert.equal(loaded.characters[0].archiveSnapshot.imageReference.reference.sha256,receipt.sha256);
  assert.deepEqual(loaded.characters[0].archiveSnapshot.comfyImplementation,{version:1,namespace:'st-user:test',implementations:[],reference:null});
});
test('draft, plan and frozen snapshot use the same normalized visual facts',()=>{
  const value=state();value.shotPlans=[{id:'plan',shots:[draft()]}];const loaded=roundtrip(value);
  assert.deepEqual(loaded.promptDraft.shots[0].shotSpec,loaded.shotPlans[0].shots[0].shotSpec);
  const snapshot=sanitizeStoryboardSnapshot({source:'novel',shotSpec:spec(),payload:{prompt:'handover',shotSpec:spec()}});
  assert.deepEqual(snapshot.shotSpec,loaded.promptDraft.shots[0].shotSpec);
  assert.deepEqual(snapshot.payload.shotSpec.continuityUpdates.facts,loaded.promptDraft.shots[0].shotSpec.continuityUpdates.facts);
});
test('typed restoration does not revive arbitrary secrets, binary blobs or unrelated deep objects',()=>{
  const value=state(),row=value.promptDraft.shots[0];value.promptDraft.apiKey='private';row.token='private';row.base64='a'.repeat(1000);
  row.shotSpec.apiKey='private';row.shotSpec.characters[0].apiKey='private';row.shotSpec.characters[0].archiveSnapshot.apiKey='private';
  row.shotSpec.characters[0].archiveSnapshot.imageReference.reference.apiKey='private';row.unknown={one:{two:{three:{four:'too deep'}}}};
  const loaded=roundtrip(value);assert.doesNotMatch(JSON.stringify(loaded.promptDraft),/private|too deep|"base64"/);
  assert.equal(loaded.promptDraft.shots[0].shotSpec.characters[0].archiveSnapshot.imageReference.reference.sha256,receipt.sha256);
});
test('invalid archive identity is retained as invalid and still blocks generation after reload',()=>{
  const value=state();value.promptDraft.shots[0].shotSpec.characters[0].archiveSnapshot.archiveVersion=-1;
  const loaded=roundtrip(value).promptDraft.shots[0].shotSpec;assert.equal(loaded.characters[0].archiveSnapshot.invalid,true);
  assert.throws(()=>compileStoryboardPrompt({providerId:'novel',modelId:'nai-diffusion-4-5-full',shot:loaded}),/人物档案快照无效/);
});
test('restoring a continuity fact key never opens generic credential fields in a frozen snapshot',()=>{
  const shot=spec();shot.continuityUpdates.facts[0].apiKey='private';shot.continuityUpdates.facts[0].headers={Authorization:'private'};
  const frozen=sanitizeStoryboardSnapshot({source:'novel',key:'private',shotSpec:shot,payload:{shotSpec:shot,parameters:{apiKey:'private'}}});
  assert.equal(frozen.shotSpec.continuityUpdates.facts[0].key,'outerwear');assert.equal(frozen.payload.shotSpec.continuityUpdates.facts[0].key,'outerwear');
  assert.doesNotMatch(JSON.stringify(frozen),/private|Authorization|apiKey/);
});
test('legacy flat manual drafts and missing/invalid shot collections keep safe behavior without invented facts',()=>{
  const result=roundtrip({promptDraft:{userEditedCompiled:true,shots:[null,5,{id:'flat',prompt:'user exact words',userEdited:true,promptLocked:true}]}});
  assert.equal(result.promptDraft.userEditedCompiled,true);assert.deepEqual(result.promptDraft.shots,[{id:'flat',prompt:'user exact words',userEdited:true,promptLocked:true}]);
  assert.equal(roundtrip({promptDraft:{shots:'invalid'}}).promptDraft.shots,undefined);assert.equal(roundtrip({}).promptDraft.shots,undefined);
});
test('existing draft item ceiling is retained and typed limits do not expand on restoration',()=>{
  const value=state();value.promptDraft.shots=Array.from({length:110},(_,index)=>({id:String(index),prompt:'legacy'}));assert.equal(roundtrip(value).promptDraft.shots.length,100);
  const raw=state();raw.promptDraft.shots[0].shotSpec.characters[0].identity=Array(50).fill(0).map((_,index)=>`trait ${index}`);assert.equal(roundtrip(raw).promptDraft.shots[0].shotSpec.characters[0].identity.length,30);
});
