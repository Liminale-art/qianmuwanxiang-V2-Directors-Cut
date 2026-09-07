import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as runtime from '../qianmu-comfy-lock-runtime.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const namespace='st-user:draft-scope',group={id:'scene-1',shotIds:['shot'],sceneFingerprint:{sceneId:'LLM-id',location:'kitchen',time:'day',narrativeLayer:'present'}};
const input=()=>({namespace,chatKey:'chat',planId:'plan',revisionId:'body-revision',groups:[copy(group)],shots:[{id:'shot',prompt:'a room',negative:'',shotSpec:core.normalizeStoryboardShotSpec({id:'shot',subject:'room',subjectKind:'environment',sourceParagraphIds:['p0'],scene:'kitchen',location:'kitchen',evidence:{quote:'a room'},visualDuty:'show an empty room',narrativePurpose:'establish the location'})}]});

test('the same verified draft keeps its scope after reload, but no text, fact, ordering or prose revision changes inherit it',async()=>{
  const source=input(),original=JSON.stringify(source),first=(await runtime.createComfyDraftSceneScopes(source)).get('shot');
  assert.deepEqual((await runtime.createComfyDraftSceneScopes(copy(source))).get('shot'),first);assert.equal(JSON.stringify(source),original);
  for(const mutate of [x=>x.namespace='st-user:other',x=>x.chatKey='other',x=>x.planId='other',x=>x.revisionId='changed',x=>x.shots[0].prompt='a different room',
    x=>x.shots[0].negative='new negative',x=>x.shots[0].shotSpec.subject='altered facts',x=>x.groups[0].sceneFingerprint.location='garden']){
    const changed=copy(source);mutate(changed);assert.notEqual((await runtime.createComfyDraftSceneScopes(changed)).get('shot').continuityId,first.continuityId);
  }
});
test('partial/mutating/unbounded drafts and cancellation cannot establish a program scope',async()=>{
  await assert.rejects(()=>runtime.createComfyDraftSceneScopes({...input(),revisionId:''}));
  await assert.rejects(()=>runtime.createComfyDraftSceneScopes({...input(),shots:[]}));
  await assert.rejects(()=>runtime.createComfyDraftSceneScopes({...input(),shots:[{id:'other'}]}));
  await assert.rejects(()=>runtime.createComfyDraftSceneScopes({...input(),shots:[{id:'shot',prompt:'x'.repeat(2*1024*1024)}]}),/过大/);
  const a=input();await assert.rejects(()=>runtime.createComfyDraftSceneScopes({...a,guard:async()=>{a.shots[0].prompt='changed while waiting';}}),/已变化/);
  await assert.rejects(()=>runtime.createComfyDraftSceneScopes({...input(),guard:async()=>{throw Error('closed');}}),/closed/);
});
test('index uses the exact shared prepared draft and scopes for preview and generation, and preserves legacy/gallery fallback',async()=>{
  const message={mes:'a kitchen',is_user:false},chat=[null,message],context=vm.createContext({...core,uid:()=> 'manual-shot',ctx:()=>({chat})});
  vm.runInContext(['storyboardPrepareDraftGroup','storyboardComfyPlanScopes'].map(section).join('\n'),context);
  const state=core.createStoryboardDefaults();state.promptDraft.shots=input().shots;state.prompt='room';
  const plan={id:'plan',chatKey:'chat',floor:1,revisionId:core.createStoryboardMessageReference({message,chatKey:'chat',floor:1}).revisionId},a=context.storyboardPrepareDraftGroup(state,plan);
  const options={namespace,chatKey:'chat',plan,planned:a.planned,coverage:a.coverage,draftPlanId:plan.id,guard:async()=>{}};
  const preview=await context.storyboardComfyPlanScopes(runtime,options),generation=await context.storyboardComfyPlanScopes(runtime,{...options,inlineBatch:{batchId:'irrelevant-random-id'}});
  assert.deepEqual(preview.get('shot'),generation.get('shot'));
  for(const old of [null,{id:'legacy',chatKey:'chat'}]){
    const fallback=await context.storyboardComfyPlanScopes(runtime,{...options,plan:old,inlineBatch:{batchId:'gallery-batch'}});
    assert.notEqual(fallback.get('shot').continuityId,preview.get('shot').continuityId);
  }
  message.mes='changed prose';await assert.rejects(()=>context.storyboardComfyPlanScopes(runtime,options),/正文已变化/);
});
test('linked draft source identity survives normal settings reload without copying plan bodies',()=>{
  const state=core.createStoryboardDefaults();state.promptDraft={...state.promptDraft,planId:'exact-source-plan',shots:input().shots};
  const restored=core.normalizeStoryboardState(copy(state));assert.equal(restored.promptDraft.planId,'exact-source-plan');
  assert.equal(restored.promptDraft.shots[0].id,'shot');assert.equal(restored.promptDraft.plan,undefined);
});
