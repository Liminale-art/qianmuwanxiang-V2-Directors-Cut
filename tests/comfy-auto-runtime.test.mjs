import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from '../qianmu-storyboard.js';
import * as runtime from '../qianmu-comfy-auto-runtime.js';
import {retainComfyAutoBinding} from '../qianmu-comfy-auto-binding.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {pinComfyRouteWorkflow,readPinnedComfyRouteWorkflow,applyComfyRouteRecipe} from '../qianmu-comfy-route.js';
import {bindStoryboardPromptRenderings} from '../qianmu-prompt-formats.js';
import {prepareComfyPromptJob} from '../qianmu-comfy-prompt.js';
import {checkComfyConfiguration} from '../qianmu-comfy-preflight.js';
import {prepareComfyWorkflow} from '../qianmu-comfy-workflow.js';
import {recipesFixture,namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture(){
  const f=await recipesFixture({formats:['tags','natural_language']});
  f.rows.forEach((row,index)=>Object.assign(row.document.classification,{visualKinds:[index?'environment':'character'],castSizes:[index?'none':'one']}));
  const recipes=await Promise.all(f.rows.map(selection=>pinComfyRouteWorkflow({namespace,selection,createStore:f.createStore})));
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'pool',revision:'pool-v1',enabled:false,styleLock:true,
    candidates:recipes.map((recipe,index)=>({id:`candidate-${index}`,enabled:true,priority:0,target:{...f.routes[index],comfyWorkflowBinding:recipe.binding},classification:recipe.document.classification}))});
  const rows=[{namespace,id:pool.id,revision:pool.revision,version:1,name:'Saved candidates',archived:false,pool}],calls=[];
  const createStore=()=>({list:async ns=>{calls.push('list');return copy(rows.filter(row=>row.namespace===ns).slice(-1).map(({pool,...rest})=>rest));},
    versions:async()=>{calls.push('versions');return copy(rows.map(({pool,...rest})=>rest));},
    load:async(ns,id,revision)=>{calls.push('load');const row=rows.find(row=>row.namespace===ns&&row.id===id&&row.revision===revision);return row?copy(row):null;},close:()=>calls.push('close')});
  const pinned=await runtime.pinComfyAutoPool({namespace,selection:rows[0],createStore});
  const readRecipe=options=>readPinnedComfyRouteWorkflow({...options,createStore:f.createStore});
  const options={namespace,binding:pinned.binding,createStore,readRecipe};
  return {...f,workflowRows:f.rows,recipes,pool,rows,poolCalls:calls,createPoolStore:createStore,options,pinned};
}
async function shot(kind='character'){
  const spec=core.normalizeStoryboardShotSpec({subject:kind==='character'?'Alice by the window':'mountain valley',subjectKind:kind,scene:'morning scene',narrativeLayer:'present',sensitive:false,
    characters:kind==='character'?[{id:'alice',name:'Alice',identity:['silver hair'],action:['reads']}]:[],promptAtoms:{global:['soft light']}});
  const forms=Object.fromEntries(['tags','natural_language'].map(format=>[format,{global:format==='tags'?'window, soft light':'Morning light reaches the window.',characters:spec.characters.map(character=>({character_id:character.id,positive:format==='tags'?'silver hair, reading':'Alice with silver hair reads.'})),negative:'extra people'}]));
  spec.promptRenderingPack=await bindStoryboardPromptRenderings(spec,forms);return spec;
}
async function actualProbe({candidate,recipe,guard}){
  await guard();const profile=applyComfyRouteRecipe({},candidate.target,recipe);
  const checked=checkComfyConfiguration({workflow:profile.comfyWorkflow,parameters:{...recipe.document.parameters,count:1},model:'comfy-workflow',outputNodeId:profile.comfyOutputNodeId,automatic:true});
  return {automaticEligible:checked.localConfigurationReady&&!checked.requiresManualQuantityReview};
}

test('saved pool binding pins exact content and version, never pool enablement or head upgrades',async()=>{
  const f=await fixture(),selection=copy(f.pinned.binding);assert.equal(selection.version,1);assert.ok(Object.isFrozen(f.pinned));assert.ok(JSON.stringify(selection).length<500);
  f.rows.push({...copy(f.rows[0]),revision:'pool-v2',version:2,pool:{...copy(f.pool),revision:'pool-v2',candidates:[]}});
  const old=await runtime.readPinnedComfyAutoPool(f.options);assert.equal(old.pool.candidates.length,2);assert.equal(old.pool.enabled,false);assert.deepEqual(old.binding,selection);
  assert.equal(f.poolCalls.filter(call=>call==='close').length,2);assert.doesNotMatch(JSON.stringify(selection),/"(?:candidates|class_type|enabled)":/);
});
test('changed, archived, missing or foreign pool references stop with no workflow reads',async()=>{
  for(const change of [f=>{f.rows[0].pool.candidates[0].priority=1;},f=>{f.rows[0].archived=true;},f=>{f.rows.length=0;},f=>{f.options.namespace='st-user:foreign';}]){
    const f=await fixture();change(f);f.calls.length=0;
    await assert.rejects(()=>runtime.prepareComfyAutoSession(f.options),/不符|归档|另一账户/);assert.equal(f.calls.length,0);
  }
});
test('session reads only enabled candidate fixed recipes and gathers the format union before any per-shot probe',async()=>{
  const f=await fixture();f.calls.length=0;
  const session=await runtime.prepareComfyAutoSession(f.options);assert.deepEqual(session.promptFormats,['tags','natural_language']);assert.equal(session.executionAuthorized,false);
  assert.equal(f.calls.filter(call=>call[0]==='load').length,2);assert.ok(Object.isFrozen(session.promptFormats));
  const before=JSON.stringify(f.pool);session.close();assert.equal(JSON.stringify(f.pool),before);assert.equal(f.pool.enabled,false);
  await assert.rejects(()=>session.assertCurrent(),/已结束/);
});
test('disabled and broken candidate recipes do not poison a valid independent candidate or add an unused format',async()=>{
  const f=await fixture();f.rows[0].pool.candidates[0].enabled=false;
  const pinned=await runtime.pinComfyAutoPool({namespace,selection:f.rows[0],createStore:f.createPoolStore});f.options.binding=pinned.binding;f.calls.length=0;
  const session=await runtime.prepareComfyAutoSession(f.options);assert.deepEqual(session.promptFormats,['natural_language']);assert.equal(f.calls.filter(call=>call[0]==='load').length,1);session.close();
  const g=await fixture();g.rows[0].pool.candidates[0].classification.promptFormat='natural_language';
  g.options.binding=(await runtime.pinComfyAutoPool({namespace,selection:g.rows[0],createStore:g.createPoolStore})).binding;
  const checked=await runtime.prepareComfyAutoSession(g.options);assert.equal(checked.issues[0].candidateId,'candidate-0');assert.deepEqual(checked.promptFormats,['natural_language']);checked.close();
});
test('rejected declarations do not exhaust valid preparation capacity and late pool archival cancels pinning',async()=>{
  const f=await fixture();f.rows[0].pool.candidates[0].classification.promptFormat='natural_language';
  f.options.binding=(await runtime.pinComfyAutoPool({namespace,selection:f.rows[0],createStore:f.createPoolStore})).binding;
  const maxBytes=new TextEncoder().encode(JSON.stringify(f.recipes[1].document)).byteLength;
  const session=await runtime.prepareComfyAutoSession({...f.options,maxBytes});assert.deepEqual(session.promptFormats,['natural_language']);session.close();
  const g=await fixture();let checks=0;
  await assert.rejects(()=>runtime.pinComfyAutoPool({namespace,selection:g.rows[0],createStore:g.createPoolStore,
    guard:async()=>{if(++checks===3)g.rows[0].archived=true;}}),/已变化/);
  assert.equal(g.poolCalls.filter(call=>call==='close').length,2);
});

test('real local quantity checks, format validation and selection feed the exact chosen final workflow inputs',async()=>{
  const f=await fixture(),session=await runtime.prepareComfyAutoSession(f.options),spec=await shot();
  const original=f.recipes.map(recipe=>recipe.document.workflow);
  const result=await session.select({shotSpec:spec,probe:actualProbe});assert.equal(result.status,'selected');assert.equal(result.candidateId,'candidate-0');assert.equal(result.executionAuthorized,false);assert.equal(result.proposedLock,null);
  const profile=session.apply(result.target,{model:'comfy-workflow',capabilityModelId:'comfy-workflow'});
  const job={source:'comfy',profile,shotSpec:spec,payload:{shotSpec:spec,prompt:'preview',negative:'',compiledPrompt:{},parameters:{workflow:profile.comfyWorkflow}}};
  await prepareComfyPromptJob(job,{prepare:true});
  const graph=prepareComfyWorkflow(profile.comfyWorkflow,{prompt:job.payload.prompt,negativePrompt:job.payload.negative,parameters:{...f.recipes[0].document.parameters,count:1}}).bind();
  assert.match(graph.text.inputs.text,/^portrait quality, window, soft light/);assert.match(graph.negative.inputs.text,/portrait exclusions/);
  assert.deepEqual(f.recipes.map(recipe=>recipe.document.workflow),original);session.close();
});
test('a higher-affinity candidate is excluded when its current technical check fails, without using persisted eligibility',async()=>{
  const f=await fixture(),session=await runtime.prepareComfyAutoSession(f.options);
  const first=await session.select({shotSpec:await shot(),probe:async input=>input.candidate.id==='candidate-0'?{automaticEligible:false}:actualProbe(input)});
  assert.equal(first.candidateId,'candidate-1');assert.equal(first.diagnostics[0].reason,'technical_gate');
  const second=await session.select({shotSpec:await shot(),probe:actualProbe});assert.equal(second.candidateId,'candidate-0');session.close();
});
test('explicit continuous scope proposes a lock without writing it; new preferences retain the lock and stale technical checks stop',async()=>{
  const f=await fixture(),session=await runtime.prepareComfyAutoSession(f.options),scope={namespace,chatKey:'chat-a',continuityId:'confirmed-scene',narrativeLayer:'present'};
  const first=await session.select({shotSpec:await shot(),scope,probe:actualProbe});assert.ok(first.proposedLock);const calls=f.poolCalls.length;
  const probed=[];
  const second=await session.select({shotSpec:await shot('environment'),scope,lock:first.proposedLock,probe:async input=>{probed.push(input.candidate.id);return actualProbe(input);}});assert.equal(second.candidateId,first.candidateId);assert.equal(second.reason,'scene_locked');assert.deepEqual(probed,[first.candidateId]);
  const unavailable=await session.select({shotSpec:await shot('environment'),scope,lock:first.proposedLock,probe:async()=>({automaticEligible:false})});assert.equal(unavailable.reason,'locked_route_unavailable');assert.equal(f.poolCalls.length,calls);
  const other=await session.select({shotSpec:await shot(),scope:{...scope,chatKey:'chat-b'},lock:first.proposedLock,probe:async()=>assert.fail('foreign scope must not probe')});assert.equal(other.reason,'lock_scope_mismatch');session.close();
});
test('adult content without separate permission never invokes probes; subject hard limits apply before technical work',async()=>{
  const f=await fixture(),session=await runtime.prepareComfyAutoSession(f.options),spec=await shot();spec.sensitive=true;let probes=0;
  const result=await session.select({shotSpec:spec,probe:async()=>{probes++;return {automaticEligible:true};}});assert.equal(result.reason,'content_not_authorized');assert.equal(probes,0);session.close();
  const g=await fixture();
  // Matching fixed version declarations are required even for a limit, so update saved recipes and re-pin them.
  for(let index=0;index<2;index++){
    g.workflowRows[index].document.classification.maxSubjects=0;
    const recipe=await pinComfyRouteWorkflow({namespace,selection:g.workflowRows[index],createStore:g.createStore});
    g.rows[0].pool.candidates[index].target.comfyWorkflowBinding=recipe.binding;g.rows[0].pool.candidates[index].classification=recipe.document.classification;
  }
  const opts={...g.options};
  opts.binding=(await runtime.pinComfyAutoPool({namespace,selection:g.rows[0],createStore:g.createPoolStore})).binding;
  const limited=await runtime.prepareComfyAutoSession(opts);const no=await limited.select({shotSpec:await shot(),probe:async()=>{probes++;return {automaticEligible:true};}});assert.equal(no.reason,'no_eligible_candidate');assert.equal(probes,0);limited.close();
});
test('missing/stale expression blocks probes and cannot be translated or repaired by this runtime',async()=>{
  const f=await fixture(),session=await runtime.prepareComfyAutoSession(f.options),spec=await shot();spec.characters[0].action=['dances'];let probes=0;
  const result=await session.select({shotSpec:spec,probe:async()=>{probes++;return {automaticEligible:true};}});assert.equal(result.reason,'no_eligible_candidate');assert.equal(probes,0);assert.ok(result.diagnostics.every(row=>row.reason==='prompt_format_unavailable'));session.close();
});
test('changed input, closed session and departed scope discard late selection outcomes',async()=>{
  for(const change of ['shot','close','scope']){
    const f=await fixture();let live=true;const session=await runtime.prepareComfyAutoSession({...f.options,guard:async()=>{if(!live)throw Error('departed');}}),spec=await shot();
    await assert.rejects(()=>session.select({shotSpec:spec,probe:async()=>{if(change==='shot')spec.characters[0].action=['changed'];else if(change==='close')session.close();else live=false;return {automaticEligible:true};}}),/已变化|已结束|departed/);session.close();
  }
});
test('oversized preparation is refused and duplicate recipe bindings are read only once',async()=>{
  const f=await fixture();await assert.rejects(()=>runtime.prepareComfyAutoSession({...f.options,maxBytes:1}),/超过/);
  const g=await fixture();g.rows[0].pool.candidates.push({...copy(g.rows[0].pool.candidates[0]),id:'same-document-other-preference'});
  g.options.binding=(await runtime.pinComfyAutoPool({namespace,selection:g.rows[0],createStore:g.createPoolStore})).binding;g.calls.length=0;
  const session=await runtime.prepareComfyAutoSession(g.options);assert.equal(g.calls.filter(call=>call[0]==='load').length,2);session.close();
});
test('diagnostics redact provider credentials rather than saving raw error text',async()=>{
  const f=await fixture(),session=await runtime.prepareComfyAutoSession(f.options);
  const result=await session.select({shotSpec:await shot(),probe:async()=>{throw Error('Authorization: Bearer secret-one api_key=secret-two');}});
  assert.doesNotMatch(JSON.stringify(result),/secret-one|secret-two/);assert.match(JSON.stringify(result),/redacted/);session.close();
});
test('chosen binding survives settings reload; invalid references stay visibly invalid and imports cannot add enable flags',async()=>{
  const f=await fixture(),state=core.createStoryboardDefaults();state.comfyPoolSelection={...f.pinned.binding,enabled:true,pool:f.pool,apiKey:'secret'};
  const restored=core.normalizeStoryboardState(copy(state));assert.deepEqual(restored.comfyPoolSelection,copy(f.pinned.binding));assert.doesNotMatch(JSON.stringify(restored.comfyPoolSelection),/"(?:apiKey|enabled|candidates)":/);
  state.comfyPoolSelection={schemaVersion:2};assert.equal(core.normalizeStoryboardState(state).comfyPoolSelection.invalid,true);assert.equal(retainComfyAutoBinding(null),null);
});
test('actual pool choice changes only selection and is cancelled after a late page/account/selection change',async()=>{
  for(const change of [null,'page','account','selection']){
    const f=await fixture(),state=core.createStoryboardDefaults();state.source='comfy';state.view='comfy-pools';let account=namespace,saves=0;
    const oldProfiles=copy(state.profiles),root={isConnected:true};
    const context=vm.createContext({storyboardAdmissionEpoch:1,storyboardState:()=>state,getChatKey:()=> 'chat-a',saveSettings:()=>saves++,toast(){},
      featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>account}:{pinComfyAutoPool:async options=>{const result=await runtime.pinComfyAutoPool({...options,createStore:f.createPoolStore});if(change==='page')state.view='create';if(change==='account')account='st-user:other';if(change==='selection')state.comfyPoolSelection={invalid:true};return result;}}}});
    vm.runInContext(section('storyboardSelectComfyPool'),context);
    const work=context.storyboardSelectComfyPool(root,state,{...f.rows[0]});
    if(change){await assert.rejects(()=>work,/已变化/);assert.equal(saves,0);}else{await work;assert.deepEqual(copy(state.comfyPoolSelection),copy(f.pinned.binding));assert.equal(saves,1);await context.storyboardSelectComfyPool(root,state,null);assert.equal(state.comfyPoolSelection,null);}
    assert.deepEqual(state.profiles,oldProfiles);
  }
});
test('runtime has no provider submission/LLM/lock writes and is not loaded at startup',async()=>{
  const source=await readFile(new URL('../qianmu-comfy-auto-runtime.js',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(fetch|WebSocket|XMLHttpRequest)\b|store\.(save|archive|purge)\(/);
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(index,/comfyAuto:[\s\S]*?load: \(\) => import\('\.\/qianmu-comfy-auto-runtime/);
  assert.match(section('storyboardPrepareComfyRoutes'),/prepareComfyAutoSession/);assert.match(section('storyboardSetComfyAuto'),/prepareComfyAutoSession/);
  assert.doesNotMatch(index,/^import .*qianmu-comfy-auto-runtime/m);
});
