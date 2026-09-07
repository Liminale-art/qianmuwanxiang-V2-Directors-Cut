import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as auto from '../qianmu-comfy-auto-runtime.js';
import * as routes from '../qianmu-comfy-route.js';
import * as direct from '../qianmu-image-direct.js';
import * as locks from '../qianmu-comfy-lock-runtime.js';
import {hashText} from '../qianmu-storyboard-utils.js';
import {changeComfySceneRecord,inspectComfySceneRecord,comfySceneScopeKey,captureComfySceneStyleLink,copyComfySceneStyleRecord} from '../qianmu-comfy-scene-lock.js';
import {checkComfyCharacterReadiness,createComfyReadinessSession} from '../qianmu-comfy-character-readiness.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const definitions={CLIPTextEncode:{input:{required:{text:['STRING']}},output:['CONDITIONING']},
  EmptyImage:{input:{required:{width:['INT'],height:['INT'],batch_size:['INT']}},output:['IMAGE']},
  SaveImage:{input:{required:{images:['IMAGE']}},output:[],output_node:true}};
async function environment({mixed=false,styleLock=true}={}){
  const e=await compilerEnvironment(),network=[],records=new Map(),writes=[];let missing='',afterRequest=async()=>{};
  e.rows.forEach((row,index)=>Object.assign(row.document.classification,{visualKinds:[index?'environment':'character']}));
  const recipes=await Promise.all(e.rows.map(selection=>routes.pinComfyRouteWorkflow({namespace,selection,createStore:e.createStore})));
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'pool',revision:'v1',enabled:false,styleLock,
    candidates:recipes.map((recipe,index)=>({id:`candidate-${index}`,enabled:true,priority:index?0:1,target:{...e.routes[index],comfyWorkflowBinding:recipe.binding},classification:recipe.document.classification}))});
  const row={namespace,id:pool.id,revision:pool.revision,version:1,name:'QA pool',archived:false,pool};
  const createStore=()=>({list:async()=>[copy(row)],versions:async()=>[copy(row)],load:async()=>copy(row),close(){}});
  e.state.comfyPoolSelection=(await auto.pinComfyAutoPool({namespace,selection:row,createStore})).binding;
  e.state.comfyAutoEnabled=true;e.state.source='comfy';e.state.routing.enabled=mixed;
  if(mixed){e.state.routing.rules[0].target={providerId:'novel',modelId:'nai-diffusion-4-5-full',capabilityModelId:'nai-diffusion-4-5-full'};e.state.routing.rules[1].target.comfyWorkflowBinding=recipes[1].binding;}
  Object.assign(e.state.connections.comfy.draft,{baseUrl:'https://comfy.test/api'});
  e.state.connections.comfy.draft.options.comfyTransport='browser';
  const inspect=async scope=>({...inspectComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope),generation:0});
  const write=async(scope,action)=>{const result=changeComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,action);records.set(comfySceneScopeKey(scope),result.row);writes.push(action.type);return {view:await inspect(scope),receipt:result.receipt};};
  const store={inspect,reserve:(scope,request)=>write(scope,{...request,type:'reserve'}),begin:receipt=>write(receipt.scope,{type:'begin',receipt}),settle:(receipt,outcome)=>write(receipt.scope,{type:'settle',receipt,outcome}),
    unlock:(scope,request)=>write(scope,{...request,type:'unlock'}),
    linkStyle:async(from,to,request)=>{const result=copyComfySceneStyleRecord(records.get(comfySceneScopeKey(from)),records.get(comfySceneScopeKey(to)),captureComfySceneStyleLink(from,to,request));records.set(comfySceneScopeKey(to),result.row);return {view:await inspect(to)};},close(){}};
  const load=e.context.featureRuntime.load;
  const manager=locks.createComfySceneCoordinator({store,resolveNamespace:async()=>(await load('imageAdmission')).resolveImageAccountNamespace(),ownerId:'test-page',locks:fakeWebLocks()});
  e.context.featureRuntime.load=async key=>{
    if(key==='comfyAuto')return {...auto,prepareComfyAutoSession:options=>auto.prepareComfyAutoSession({...options,createStore,readRecipe:request=>routes.readPinnedComfyRouteWorkflow({...request,createStore:e.createStore})})};
    if(key==='comfyScene')return locks;
    if(key==='comfyCharacterReadiness')return {createComfyReadinessSession(){return createComfyReadinessSession({check:this.checkComfyCharacterReadiness});},checkComfyCharacterReadiness:(request,options)=>checkComfyCharacterReadiness(request,{...options,fetchImpl:async(url,init)=>{
      network.push({url,method:init.method});await afterRequest();assert.equal(init.method,'GET');const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));return new Response(JSON.stringify(name===missing?{}:{[name]:definitions[name]}));
    }})};
    return load(key);
  };
  Object.assign(e.context,{storyboardComfySceneRuntime:async()=>manager,directImageRuntime:async()=>direct,storyboardResolveApiKey:async()=>'',storyboardRequestHeaders:()=>({})});
  vm.runInContext(['storyboardChooseComfyGenerationRoutes','storyboardParseWorkflow','storyboardGatewayRequest','storyboardCheckComfyJobReadiness','storyboardConfirmComfyExecution','storyboardProbeComfyCandidate'].map(section).join('\n'),e.context);
  const queue=e.context.storyboardQueueJob;
  e.context.storyboardQueueJob=async job=>{
    if(job.source==='comfy'){
      if(job.profile.comfyRouteBinding)await e.context.storyboardVerifyComfyRouteJob(job);await e.context.storyboardPrepareComfyPromptJob(job,{prepare:true});
      await e.context.storyboardConfirmComfyExecution(job,()=>true);if(job.comfySceneClaim)await manager.reserve(job);
    }
    return queue(job);
  };
  return {...e,row,recipes,network,records,writes,manager,setMissing:value=>missing=value,setAfterRequest:value=>afterRequest=value,
    close:()=>manager.close()};
}
const plan=()=>({id:'plan',chatKey:'chat-a',status:'screening',shots:[]});

async function recoveryEnvironment(options={}){
  const e=await environment(options),chat=e.context.ctx().chat;
  const p=core.createStoryboardWorkflowTicket({messageRef:core.createStoryboardMessageReference({message:chat[0],chatKey:'chat-a',floor:0}),chatKey:'chat-a',floor:0});
  e.state.shotPlans=[p];e.state.target='floor';e.state.floor='0';let rejected=true,admissions=0;
  const probe=e.context.storyboardProbeComfyCandidate;
  if(options.sameScene)for(const shot of e.response.shots){shot.scene.location='kitchen';shot.composition.continuity_key='one-scene';}
  e.context.storyboardProbeComfyCandidate=async(...args)=>{const request=args[3];if(rejected&&request.shot.subject.includes(options.failedText||'mountain'))throw Error('temporary node unavailable');return probe(...args);};
  Object.assign(e.context,{storyboardPumpQueue(){},storyboardValidatedAnchor:()=>({valid:true}),storyboardImageAdmissionRuntime:async()=>({admit:async()=>{admissions++;}}),
    storyboardSettleImageAdmission:(job,outcome)=>e.manager.settle(job,outcome)});
  vm.runInContext(['storyboardStartLog','storyboardFinishLog','storyboardRecordPreparedJobFailure','storyboardQueueJob','storyboardJobFromLog','storyboardRetryLog','storyboardSetPlanStatus'].map(section).join('\n'),e.context);
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
  return {...e,p,repair:()=>{rejected=false;},admissions:()=>admissions};
}

test('real frozen history retry restores current scene protection, then an unlocked scene offers independent single-mirror redraw',async()=>{
  const e=await recoveryEnvironment();
  try{
    e.repair();assert.equal(await e.context.storyboardGenerate(null,{plan:e.p,automatic:true}),true,JSON.stringify(e.notices));
    const first=e.context.storyboardQueue[0],scope=first.comfySceneOrigin.scope;
    await e.manager.beforeSubmit(first);await e.manager.settle(first,'succeeded');
    const initial=e.state.logs.find(row=>row.id===first.logId);e.context.storyboardFinishLog(initial,'success',{recordIds:['first-image']});
    e.state.logs=core.normalizeStoryboardState(copy(e.state)).logs;
    const log=e.state.logs.find(row=>row.id===first.logId),original=JSON.stringify(log.snapshot),calls=e.llmCalls.length;
    e.context.storyboardQueue.splice(0,1);e.state.source='novel';e.state.comfyAutoEnabled=false;
    assert.equal(await e.context.storyboardRetryLog(log),true,JSON.stringify(e.notices));
    const retry=e.context.storyboardQueue.at(-1);assert.equal(retry.comfySceneClaim,true);assert.equal(retry.comfySceneOrigin.mode,'scene');
    assert.equal(retry.profile.comfyRouteBinding.id,first.profile.comfyRouteBinding.id);assert.deepEqual(retry.inlineOrder,first.inlineOrder);
    assert.equal(e.state.logs.find(row=>row.id===retry.logId).params.sceneStyle,'沿用原续场');
    await e.manager.beforeSubmit(retry);await e.manager.settle(retry,'succeeded');
    await e.manager.unlock(scope,await e.manager.inspect(scope));
    let confirms=0;const count=e.context.storyboardQueue.length;e.context.confirmDialog=async()=>{confirms++;return false;};
    assert.equal(await e.context.storyboardRetryLog(log),false);assert.equal(e.context.storyboardQueue.length,count);assert.equal(confirms,1);
    e.context.confirmDialog=async()=>{confirms++;return true;};
    assert.equal(await e.context.storyboardRetryLog(log),true,JSON.stringify(e.notices));
    const detached=e.context.storyboardQueue.at(-1);assert.equal(detached.comfySceneClaim,undefined);assert.equal(detached.comfySceneOrigin.mode,'independent');
    assert.deepEqual(detached.inlineOrder,first.inlineOrder);assert.equal((await e.manager.inspect(scope)).lock,null);
    assert.equal(e.state.logs.find(row=>row.id===detached.logId).params.sceneStyle,'独立重绘（原续场来源）');
    assert.equal(JSON.stringify(log.snapshot),original);assert.equal(e.llmCalls.length,calls);assert.equal(e.admissions(),5);assert.equal(e.state.source,'novel');
  }finally{await e.close();}
});

test('one unselectable mirror preserves a distinct draft and actual independent re-preparation queues only that original slot',async()=>{
  const e=await recoveryEnvironment();
  try{
    assert.equal(await e.context.storyboardGenerate(null,{plan:e.p,automatic:true}),true,JSON.stringify(e.notices));
    assert.deepEqual(e.context.storyboardQueue.map(job=>job.inlineOrder.shotIndex),[0,2]);assert.equal(e.admissions(),2);
    const log=e.state.logs.find(row=>row.kind==='comfy_preparation');assert.equal(log.status,'failed');assert.equal(log.snapshot,null);assert.equal(e.context.storyboardJobFromLog(log),null);
    assert.deepEqual(e.p.shots.map(shot=>shot.status),['queued','failed','queued']);
    const saved=core.normalizeStoryboardState(copy(e.state)),persisted=saved.logs.find(row=>row.id===log.id);
    assert.equal(persisted.snapshot,null);assert.deepEqual(persisted.preparation,copy(log.preparation));
    const entry=core.buildStoryboardInlineTasks(e.state.taskStates,{chatKey:'chat-a',chat:e.context.ctx().chat,logs:e.state.logs,waitingIds:new Set(e.context.storyboardQueue.map(job=>job.id))}).find(row=>row.status==='failed');
    assert.equal(entry.label,'本镜待选工作流');assert.equal(entry.action,'reprepare-task');
    const original=JSON.stringify(log.preparation),before=e.context.storyboardQueue.map(job=>job.id);
    e.repair();e.state.connections.comfy.draft.baseUrl='https://new-comfy.test/api';e.state.source='novel';e.state.comfyAutoEnabled=false;
    assert.equal(await e.context.storyboardRetryLog(log),true,JSON.stringify(e.notices));
    assert.equal(e.llmCalls.length,1);assert.equal(e.admissions(),3);assert.equal(e.context.storyboardQueue.length,3);
    assert.deepEqual(e.context.storyboardQueue.slice(0,2).map(job=>job.id),before);
    const retry=e.context.storyboardQueue[2];assert.equal(retry.inlineOrder.shotIndex,1);assert.deepEqual(retry.inlineOrder,log.preparation.inlineOrder);
    assert.equal(retry.connection.baseUrl,'https://new-comfy.test/api');assert.equal(retry.profile.comfyRouteBinding.id,'landscape');assert.equal(retry.profile.count,'1');
    assert.equal(retry.attempt,2);assert.equal(log.status,'success');assert.equal(JSON.stringify(log.preparation),original);
    assert.equal(e.state.source,'novel');assert.equal(e.state.comfyAutoEnabled,false,'explicit recovery must not toggle the workbench mode');
    assert.equal(await e.context.storyboardRetryLog(log),false);assert.equal(e.admissions(),3);
  }finally{await e.close();}
});

test('re-preparation cancellation, source edit, account change and changed style-lock policy cannot queue a replacement',async()=>{
  for(const kind of ['cancel','body','account','style']){
    const e=await recoveryEnvironment();
    try{
      await e.context.storyboardGenerate(null,{plan:e.p,automatic:true});const log=e.state.logs.find(row=>row.kind==='comfy_preparation');e.repair();
      e.context.confirmDialog=async()=>{if(kind==='body')e.context.ctx().chat[0].mes+=' edited';if(kind==='account')e.setAccount('st-user:other');return kind!=='cancel';};
      if(kind==='style'){
        const load=e.context.featureRuntime.load;
        e.context.featureRuntime.load=async key=>{const module=await load(key);return key==='comfyAuto'?{...module,prepareComfyAutoSession:async args=>{const result=await module.prepareComfyAutoSession(args);return {...result,styleLock:false};}}:module;};
      }
      assert.equal(await e.context.storyboardRetryLog(log),false,kind);assert.equal(e.admissions(),2);assert.equal(e.context.storyboardQueue.length,2);assert.equal(log.status,'failed');
      assert.equal(e.context.storyboardPreparationRetries.size,0);
    }finally{await e.close();}
  }
});

test('preparation drafts survive normalization without execution fields; corrupt, cross-layer and oversized drafts stay non-executable',async()=>{
  const e=await recoveryEnvironment();
  try{
    await e.context.storyboardGenerate(null,{plan:e.p,automatic:true});const log=e.state.logs.find(row=>row.kind==='comfy_preparation');
    const raw={...copy(log.preparation),apiKey:'not-a-real-key',workflow:{secret:'not-a-real-secret'},imageAdmission:{version:1},permit:true};
    const clean=core.normalizeStoryboardComfyPreparation(raw);assert.ok(clean);assert.equal(clean.permit,undefined);assert.equal(clean.apiKey,undefined);assert.equal(clean.workflow,undefined);assert.equal(clean.imageAdmission,undefined);
    for(const bad of [{...raw,version:2},{...raw,scope:null},{...raw,scope:{...raw.scope,narrativeLayer:'memory'}},
      {...raw,pool:{...raw.pool,namespace:'another-user'}},{...raw,prompt:'长'.repeat(45000)},{...raw,shotSpec:{...raw.shotSpec,promptRenderingPack:null}}]){
      assert.equal(core.normalizeStoryboardComfyPreparation(bad),null);
      const normalized=core.normalizeStoryboardState({...copy(e.state),logs:[{...log,preparation:bad,snapshot:{source:'comfy',profile:{},payload:{prompt:'malicious fallback'},connection:{baseUrl:'https://example.test'}}}]}).logs[0];
      assert.equal(normalized.kind,'comfy_preparation');assert.equal(normalized.preparation,null);assert.equal(normalized.snapshot,null);assert.equal(e.context.storyboardJobFromLog(normalized),null);
    }
  }finally{await e.close();}
});

test('double-click while confirming prepares only one mirror; same-scene retry consumes the surviving original scene lock',async()=>{
  const e=await recoveryEnvironment({sameScene:true});
  try{
    await e.context.storyboardGenerate(null,{plan:e.p,automatic:true});const log=e.state.logs.find(row=>row.kind==='comfy_preparation');e.repair();
    assert.equal(e.records.size,1);const scope=copy([...e.records.values()][0].scope);
    let release;const confirmation=new Promise(resolve=>{release=resolve;});e.context.confirmDialog=()=>confirmation;
    const first=e.context.storyboardRetryLog(log);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(await e.context.storyboardRetryLog(log),false);release(true);assert.equal(await first,true,JSON.stringify(e.notices));
    assert.equal(e.admissions(),3);assert.equal(e.records.size,1);assert.deepEqual(log.preparation.scope,scope);
    assert.equal(e.context.storyboardQueue[2].profile.comfyRouteBinding.id,'portrait','landscape preference may not override the established same-scene style');
  }finally{await e.close();}
});

test('re-extraction explicitly retires pending preparation drafts without replaying or removing accepted jobs',async()=>{
  const e=await recoveryEnvironment();
  try{
    await e.context.storyboardGenerate(null,{plan:e.p,automatic:true});const log=e.state.logs.find(row=>row.kind==='comfy_preparation'),ids=e.context.storyboardQueue.map(job=>job.id);
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.p}),true);assert.equal(log.status,'cancelled');
    assert.equal(e.state.taskStates.find(task=>task.logId===log.id).status,'cancelled');assert.deepEqual(e.context.storyboardQueue.map(job=>job.id),ids);
    assert.equal(await e.context.storyboardRetryLog(log),false);assert.equal(e.admissions(),2);
  }finally{await e.close();}
});

test('re-preparation that reaches a complete request but fails admission hands recovery over to the frozen single-request log',async()=>{
  const e=await recoveryEnvironment();
  try{
    await e.context.storyboardGenerate(null,{plan:e.p,automatic:true});const log=e.state.logs.find(row=>row.kind==='comfy_preparation');e.repair();
    e.context.storyboardImageAdmissionRuntime=async()=>({admit:async()=>{throw Error('local permission unavailable');}});
    assert.equal(await e.context.storyboardRetryLog(log),false);assert.equal(log.status,'success');assert.equal(e.context.storyboardQueue.length,2);
    const failed=e.state.logs.find(row=>row.kind!=='comfy_preparation'&&row.status==='failed');assert.equal(failed.submissionState,'not_submitted');assert.ok(failed.snapshot.profile.comfyRouteBinding);
    const entries=core.buildStoryboardInlineTasks(e.state.taskStates,{chatKey:'chat-a',chat:e.context.ctx().chat,logs:e.state.logs,waitingIds:new Set(e.context.storyboardQueue.map(job=>job.id))});
    assert.equal(entries.find(row=>row.inlineOrder.shotIndex===1).action,'retry-task');assert.equal(failed.snapshot.inlineOrder.shotIndex,1);
  }finally{await e.close();}
});

test('mixed closed/fixed-Comfy routes continue while an automatic mirror is unselectable; recovery does not replace their jobs',async()=>{
  const e=await recoveryEnvironment({mixed:true,failedText:'cup'});
  try{
    assert.equal(await e.context.storyboardGenerate(null,{plan:e.p,automatic:true}),true,JSON.stringify(e.notices));
    const before=e.context.storyboardQueue.map(job=>({id:job.id,source:job.source,profile:copy(job.profile)}));
    assert.deepEqual(before.map(job=>job.source),['novel','comfy']);assert.equal(before[1].profile.comfyRouteBinding.id,'landscape');
    const log=e.state.logs.find(row=>row.kind==='comfy_preparation');assert.equal(log.preparation.inlineOrder.shotIndex,2);e.repair();
    assert.equal(await e.context.storyboardRetryLog(log),true,JSON.stringify(e.notices));
    assert.deepEqual(e.context.storyboardQueue.slice(0,2).map(job=>({id:job.id,source:job.source,profile:copy(job.profile)})),before);
    assert.equal(e.context.storyboardQueue[2].inlineOrder.shotIndex,2);assert.equal(e.llmCalls.length,1);
  }finally{await e.close();}
});

test('all-unselectable rounds retain three recoverable drafts across reload and refuse whole-batch replay until re-extraction',async()=>{
  const e=await recoveryEnvironment();
  try{
    e.setMissing('EmptyImage');assert.equal(await e.context.storyboardGenerate(null,{plan:e.p,automatic:true}),false);
    assert.equal(e.admissions(),0);assert.equal(e.state.logs.filter(log=>log.kind==='comfy_preparation').length,3);
    const count=e.network.length;assert.equal(await e.context.storyboardGenerate(null,{plan:e.p,automatic:true}),false);assert.equal(e.network.length,count);
    Object.assign(e.state,core.normalizeStoryboardState(copy(e.state)));
    e.setMissing('');e.repair();const log=e.state.logs.find(row=>row.preparation?.inlineOrder.shotIndex===1);
    assert.equal(await e.context.storyboardRetryLog(log),true,JSON.stringify(e.notices));assert.equal(e.admissions(),1);
    assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.context.storyboardQueue[0].inlineOrder.shotIndex,1);
    assert.equal(e.state.logs.filter(row=>row.kind==='comfy_preparation'&&row.status==='failed').length,2);
  }finally{await e.close();}
});

test('actual one-shot extraction negotiates candidates, then routes, freezes and reserves each shot in narrative order',async()=>{
  const e=await environment(),p=plan(),original=JSON.stringify(e.state.profiles);
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.deepEqual(e.llmCalls[0].options.promptFormats,['tags','natural_language']);core.normalizeStoryboardState(e.state);
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify({notices:e.notices,errors:e.errors}));
    assert.equal(e.llmCalls.length,1);assert.equal(e.jobs.length,3);assert.deepEqual(e.jobs.map(job=>job.inlineOrder.shotIndex),[0,1,2]);
    assert.deepEqual(e.jobs.map(job=>job.profile.comfyRouteBinding.id),['portrait','landscape','portrait']);
    assert.ok(e.jobs.every(job=>job.comfyAutoSelected&&job.comfySceneClaim&&job.comfyExecution.automatic&&job.profile.count==='1'));
    assert.match(e.jobs[0].payload.prompt,/portrait quality, tag-scene-0/);assert.match(e.jobs[1].payload.prompt,/landscape quality\n\nNatural scene 1/);
    assert.equal(e.writes.filter(type=>type==='reserve').length,3);assert.equal(JSON.stringify(e.state.profiles),original);
    for(const job of e.jobs){await e.manager.beforeSubmit(job);await e.manager.settle(job,'succeeded');}
    assert.ok([...e.records.values()].every(row=>row.established&&!row.holders.length));assert.ok(e.network.every(request=>request.method==='GET'));
    assert.equal(e.network.length,15,'two exact candidate reports once (6 GETs), followed by three fresh queue checks (9 GETs)');
    assert.ok(e.jobs.every(job=>!job.comfyProbeReadiness),'real jobs must not inherit exploration memo');
  }finally{await e.close();}
});

test('a current compiled draft consumes the explicitly linked previous-floor style in the actual multi-shot generation chain',async()=>{
  const e=await environment(),p=plan();
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true);assert.equal(e.state.promptDraft.planId,p.id);
    core.normalizeStoryboardState(e.state);assert.equal(e.state.promptDraft.planId,p.id);
    p.floor=1;e.context.storyboardTargetFloor=()=>1;e.context.hashText=hashText;
    e.context.ctx().chat.push({...e.context.ctx().chat[0]});e.state.target='floor';e.state.floor='1';
    p.revisionId=core.createStoryboardMessageReference({message:e.context.ctx().chat[1],chatKey:'chat-a',floor:1}).revisionId;
    const autoModule=await e.context.featureRuntime.load('comfyAuto'),prepared=await autoModule.prepareComfyAutoSession({namespace,binding:e.state.comfyPoolSelection});
    const priorScope={namespace,chatKey:'chat-a',continuityId:'previous-completed-scene',narrativeLayer:'present'};
    const choice=await prepared.select({shotSpec:e.state.promptDraft.shots[0].shotSpec,scope:priorScope,probe:async()=>({automaticEligible:true})});
    const prior=changeComfySceneRecord(null,priorScope,{type:'reserve',expectedRevision:0,lock:choice.proposedLock,label:{planId:'old-plan',floor:0,workflowName:'Portrait'},attemptId:'old',ownerId:'old-page',token:'old'});
    const finished=changeComfySceneRecord(prior.row,priorScope,{type:'settle',receipt:prior.receipt,outcome:'succeeded'}).row;e.records.set(comfySceneScopeKey(priorScope),finished);prepared.close();
    const {planned,coverage}=e.context.storyboardPrepareDraftGroup(e.state,p);
    const scopes=await e.context.storyboardComfyPlanScopes(locks,{namespace,chatKey:'chat-a',plan:p,planned,coverage,draftPlanId:p.id,guard:async()=>{}}),target=scopes.get(planned[1].id);
    const targetView=await e.manager.inspect(target);await e.manager.linkStyle(priorScope,target,{expectedSourceRevision:finished.revision,expectedRevision:targetView.revision,expectedGeneration:targetView.generation,label:{planId:p.id,floor:1}});
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:false}),true,JSON.stringify(e.notices));
    assert.equal(e.jobs.length,3);assert.equal(e.jobs[1].profile.comfyRouteBinding.id,'portrait');assert.match(e.jobs[1].payload.prompt,/tag-scene-1/);
    assert.equal((await e.manager.inspect(target)).pending,1);assert.equal((await e.manager.inspect(target)).styleOrigin.sourceFloor,0);
    assert.deepEqual(e.jobs.map(job=>job.inlineOrder.shotIndex),[0,1,2]);assert.equal(e.llmCalls.length,1);
  }finally{await e.close();}
});

test('explicit fixed mirrors and closed providers have priority over automatic workbench selection',async()=>{
  const e=await environment({mixed:true}),p=plan();
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify(e.notices));
    assert.deepEqual(e.jobs.map(job=>job.source),['novel','comfy','comfy']);
    assert.deepEqual(e.jobs.map(job=>Boolean(job.comfyAutoSelected)),[false,false,true]);
    assert.equal(e.jobs[1].profile.comfyRouteBinding.id,'landscape');assert.equal(e.writes.filter(type=>type==='reserve').length,1);
  }finally{await e.close();}
});

test('manual trigger still subjects automatic workflow selection to strict one-image eligibility',async()=>{
  const e=await environment({styleLock:false});
  try{
    await e.context.storyboardCompilePrompt(null);assert.equal(await e.context.storyboardGenerate(null,{automatic:false}),true,JSON.stringify(e.notices));
    assert.equal(e.jobs.length,3);assert.ok(e.jobs.every(job=>!job.automatic&&job.comfyAutoSelected&&job.comfyExecution.automatic&&job.profile.count==='1'));
    assert.equal(e.writes.length,0);assert.ok(e.jobs.every(job=>!job.comfySceneClaim));
  }finally{await e.close();}
});

test('actual adjacent shots in a single confirmed batch scene keep their first workflow despite later visual-category preference',async()=>{
  const e=await environment(),p=plan();
  for(const shot of e.response.shots){shot.scene.location='kitchen';shot.composition.continuity_key='one-scene';}
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify(e.notices));
    assert.equal(e.jobs.length,3);assert.deepEqual(e.jobs.map(job=>job.profile.comfyRouteBinding.id),['portrait','portrait','portrait']);assert.equal(e.records.size,1);
    assert.equal([...e.records.values()][0].holders.length,3);
  }finally{await e.close();}
});

test('actual extraction with reused scene IDs keeps a memory cut out of the present scene lock',async()=>{
  const e=await environment(),p=plan();
  for(const shot of e.response.shots){shot.scene.location='kitchen';shot.composition.continuity_key='one-scene';}
  e.response.shots[1].narrative_layer='memory';
  try{
    assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
    assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),true,JSON.stringify(e.notices));
    assert.equal(e.jobs.length,3);assert.equal(e.records.size,3);
    assert.deepEqual([...e.records.values()].map(row=>row.scope.narrativeLayer),['present','memory','present']);
    assert.deepEqual(e.jobs.map(job=>job.profile.comfyRouteBinding.id),['portrait','landscape','portrait']);
  }finally{await e.close();}
});

test('lost nodes or scope changes stop actual preparation without queued images or persistent claims',async()=>{
  for(const failure of ['nodes','account','mode']){
    const e=await environment(),p=plan();
    try{
      assert.equal(await e.context.storyboardCompilePrompt(null,{plan:p}),true,JSON.stringify(e.errors));
      if(failure==='nodes')e.setMissing('EmptyImage');else e.setAfterRequest(async()=>{if(failure==='account')e.setAccount('st-user:other');else e.state.comfyAutoEnabled=false;});
      assert.equal(await e.context.storyboardGenerate(null,{plan:p,automatic:true}),false);assert.equal(e.jobs.length,0);assert.equal(e.writes.length,0);
      assert.ok(e.notices.length||e.errors.length);assert.equal(e.llmCalls.length,1);
    }finally{await e.close();}
  }
});

test('invalid candidate binding fails before compiler request; disabling automatic mode preserves legacy workbench',async()=>{
  const e=await environment();
  try{
    e.state.comfyPoolSelection={invalid:true};assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.llmCalls.length,0);
    e.state.comfyAutoEnabled=false;for(const shot of e.response.shots)delete shot.prompt_renderings;
    assert.equal(await e.context.storyboardCompilePrompt(null),true,JSON.stringify(e.errors));assert.equal(e.llmCalls.length,1);
    assert.equal(await e.context.storyboardGenerate(null),true,JSON.stringify(e.notices));assert.ok(e.jobs.every(job=>!job.comfyAutoSelected));assert.equal(e.writes.length,0);
  }finally{await e.close();}
});
