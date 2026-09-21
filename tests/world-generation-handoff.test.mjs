import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardDefaults} from '../qianmu-storyboard.js';
import {createWorldGenerationHandoff as create,consumeWorldGenerationHandoff as consume} from '../qianmu-world-shot.js';
const fixture=()=>{
  const owner=createStoryboardDefaults();Object.assign(owner,{prompt:'USER DRAFT',negative:'USER NEGATIVE',promptMode:'auto',target:'floor',floor:'50',inlineByDefault:true,
    pendingParagraphSelection:{paragraphs:[4]},pendingParagraphIndex:4,manualParagraphIndex:4});
  owner.promptDraft={...owner.promptDraft,planId:'prose-plan',shots:[{id:'old',prompt:'old prose'}],userEditedCompiled:true};
  owner.pendingCompilerStages=[{type:'prompt_compiler',input:'PRIVATE PROSE'}];
  const input={shotSpec:{id:'world-shot',productionContext:{packetId:'packet-a'},characters:[{id:'alice',identity:['silver hair']}],narrativePurpose:'rain',subjectKind:'character'},
    prompt:'rain, kitchen',negative:'',title:'world',stages:[{type:'world_confirmation',output:{approved:true}}]};
  return {owner,input};
};

test('world handoff leaves every editable workbench value intact and clears inherited prose targeting only in its private draft',()=>{
  const {owner,input}=fixture(),before=structuredClone(owner),token=create(owner,input);assert.deepEqual(owner,before);assert.equal(JSON.stringify(token),'{}');
  const draft=consume(token,owner);assert.deepEqual(owner,before);assert.notEqual(draft,owner);
  assert.equal(draft.target,'gallery');assert.equal(draft.floor,'');assert.equal(draft.inlineByDefault,false);assert.equal(draft.pendingParagraphSelection,null);
  assert.equal(draft.pendingParagraphIndex,null);assert.equal(draft.manualParagraphIndex,null);assert.equal(draft.promptDraft.planId,'');
  assert.equal(draft.prompt,'rain, kitchen');assert.equal(draft.negative,'');assert.equal(draft.promptDraft.userEditedCompiled,false);
  assert.doesNotMatch(JSON.stringify([draft.promptDraft,draft.pendingCompilerStages]),/USER DRAFT|old prose|PRIVATE PROSE|prose-plan/);
});
test('world-owned routing, shot, prompt rows and trace are isolated from the original objects',()=>{
  const {owner,input}=fixture(),token=create(owner,input);input.shotSpec.characters[0].identity=['red hair'];input.stages[0].output.approved=false;
  const draft=consume(token,owner);draft.routing.single.modelId='only-this-job';draft.promptDraft.shots[0].prompt='private edit';
  assert.notEqual(owner.routing.single.modelId,'only-this-job');assert.equal(owner.promptDraft.shots[0].prompt,'old prose');
  assert.deepEqual(draft.promptDraft.shots[0].shotSpec.characters[0].identity,['silver hair']);assert.equal(draft.pendingCompilerStages[0].output.approved,true);
});

test('world handoff cannot inherit prose ensemble recovery or unknown prose-only execution metadata',()=>{
  const {owner,input}=fixture();Object.assign(owner.promptDraft,{ensembleRequired:true,ensembleSelection:{scheme:'prose-only'},streamWindow:{floor:50},futureProseReceipt:'PRIVATE-PROSE-RECEIPT'});
  const before=structuredClone(owner.promptDraft),draft=consume(create(owner,input),owner);
  assert.deepEqual(owner.promptDraft,before);
  for(const field of ['ensembleRequired','ensembleSelection','streamWindow','futureProseReceipt'])assert.equal(Object.hasOwn(draft.promptDraft,field),false,field);
  assert.equal(draft.promptDraft.shots.length,1);assert.equal(draft.promptDraft.compiledBy,'director-work-order');
  assert.equal(draft.promptDraft.shots[0].shotSpec.productionContext.packetId,'packet-a');
});
test('handoffs are owner-bound and single-use, and serialization cannot mint a new executable draft',()=>{
  const {owner,input}=fixture(),token=create(owner,input);assert.throws(()=>consume(token,createStoryboardDefaults()),/所属设置/);
  assert.ok(consume(token,owner));assert.throws(()=>consume(token,owner),/已交接/);
  for(const value of [{},JSON.parse(JSON.stringify(token)),null,undefined])assert.throws(()=>consume(value,owner),/已交接/);
});
test('missing world identity or empty prompt cannot create a handoff, without altering the original draft',()=>{
  const {owner,input}=fixture(),before=structuredClone(owner);
  for(const value of [{...input,prompt:''},{...input,prompt:'  '},{...input,prompt:{}},{...input,shotSpec:{}}])assert.throws(()=>create(owner,value),/缺少/);
  assert.deepEqual(owner,before);
});
