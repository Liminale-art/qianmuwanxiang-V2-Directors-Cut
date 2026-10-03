import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as direct from '../qianmu-image-direct.js';
import * as routes from '../qianmu-comfy-route.js';
import * as prompts from '../qianmu-comfy-prompt.js';
import {bindStoryboardPromptRenderings} from '../qianmu-prompt-formats.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';
import {buildComfyCloudRequest} from '../qianmu-comfy-cloud-request.js';
import {prepareComfyCloudSubmission} from '../qianmu-comfy-cloud-prepare.js';
import {normalizeRunningHubConsoleUrl,runningHubWorkflowId} from '../qianmu-comfy-console.js';
import {createComfySceneCoordinator} from '../qianmu-comfy-lock-runtime.js';
import {comfyCandidateExecutionKey} from '../qianmu-comfy-selection.js';
import {recipesFixture,namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

// Synthetic retained prompts and recipes only. The popup's explicit choice and
// existing-log persistence are seams; route, rendering, scene and request logic
// are real. No LLM, credentials, provider request or browser storage is used.
for (const kind of ['fixed','workbench','scene']) test(`${kind} retry keeps an approved Standard tier through real downstream verification and cloud projection`,async()=>{
  const f=await recipesFixture({formats:['tags','tags']});
  const rh=bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1');
  let sequence=0,choices=0;
  const context=vm.createContext({...core,normalizeRunningHubConsoleUrl,runningHubWorkflowId,clone:structuredClone,uid:prefix=>`${prefix}-${++sequence}`,storyboardAdmissionEpoch:1,
    ctx:()=>({}),appearanceSession:{mountPortal:()=>()=>{}},directImageRuntime:async()=>direct,
    featureRuntime:{load:async key=>{
      if(key==='comfyRoutes')return routes;
      if(key==='comfyPrompt')return prompts;
      if(key==='imageAdmission')return {resolveImageAccountNamespace:async()=>namespace};
      if(key==='comfyWorkbench')return {confirmRunningHubRetryExecution:async options=>{
        assert.equal(options.isCurrent(),true);assert.equal(options.instanceType,undefined);
        assert.equal(options.consoleUrl,undefined);assert.equal(options.connection.baseUrl,rh.origin);
        choices++;return {instanceType:'default',consoleUrl:'https://www.runninghub.cn/post/2105524436618268674?source=workspace'};
      }};
      assert.fail(`Unexpected feature: ${key}`);
    }},
    confirmDialog:()=>assert.fail('No second generic confirmation'),storyboardStoreLog:log=>log,sanitizeStoryboardDiagnosticData:value=>value});
  vm.runInContext(['storyboardJobFromLog','storyboardParseWorkflow','storyboardGatewayRequest','storyboardComfyReferenceMetadata',
    'storyboardVerifyComfyRouteJob','storyboardPrepareComfyPromptJob','storyboardConfirmComfyExecution','storyboardStartLog'].map(section).join('\n'),context);
  const profile=routes.applyComfyRouteRecipe({model:'comfy-workflow',capabilityModelId:'comfy-workflow'},f.routes[0],f.recipes[0]);
  if(kind==='workbench'){
    profile.comfyWorkbenchBinding={schemaVersion:1,binding:profile.comfyRouteBinding,classification:f.recipes[0].document.classification};
    delete profile.comfyRouteBinding;delete profile.comfyRoutePromptFormat;delete profile.comfyRoutePromptLayer;
  }
  const shot=core.normalizeStoryboardShotSpec({scene:'synthetic garden',narrativeLayer:'present'});
  shot.promptRenderingPack=await bindStoryboardPromptRenderings(shot,{tags:{global:'synthetic garden',characters:[],negative:''}});
  const original={id:'old',source:'comfy',automatic:false,profile,
    connection:{baseUrl:rh.origin,credentialId:'synthetic-reference',options:{comfyTransport:'gateway'}},
    target:'gallery',chatKey:'test-chat',shotSpec:shot,
    payload:{prompt:'synthetic garden',shotSpec:structuredClone(shot),
      parameters:{workflow:JSON.parse(profile.comfyWorkflow),width:512,height:512,count:1},
      comfyWorkbenchPromptLayer:{positive:'',negative:''}}};
  await context.storyboardPrepareComfyPromptJob(original,{prepare:true});
  if(kind==='scene')original.comfySceneOrigin={version:1,mode:'scene',schema:'qianmu.comfy.selection.v1',
    scope:{namespace,chatKey:'test-chat',continuityId:'test-scene',narrativeLayer:'present'},
    poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:await comfyCandidateExecutionKey({target:f.routes[0]}),
    connectionPresetId:'',sourceHash:shot.promptRenderingPack.sourceHash};
  const log={id:'original-log',snapshot:structuredClone(original)},before=JSON.stringify(log),job=context.storyboardJobFromLog(log);
  Object.defineProperty(job,'comfyRetryReview',{value:true,enumerable:false});
  assert.equal(await context.storyboardConfirmComfyExecution(job,()=>true),true);
  assert.equal(choices,1);assert.equal(job.profile.comfyInstanceType,'default');assert.equal(JSON.stringify(log),before);
  assert.equal(job.payload.prompt,original.payload.prompt);assert.equal(job.payload.negative,original.payload.negative);
  assert.deepEqual(job.payload.promptRendering,original.payload.promptRendering);
  job.imageAdmission={version:1,namespace,attemptId:job.id};
  await context.storyboardVerifyComfyRouteJob(job);
  await context.storyboardPrepareComfyPromptJob(job);
  if(kind==='scene'){
    const {schema,scope,poolKey,candidateId,executionKey}=job.comfySceneOrigin;
    const lock={schema,scope,poolKey,candidateId,executionKey};let reads=0;
    const manager=createComfySceneCoordinator({resolveNamespace:async()=>namespace,ownerId:'test-owner',
      store:{inspect:async()=>{reads++;return {lock,generation:0,lockRevision:1};},close(){}}});
    try{
      assert.equal(await manager.restore(job,{confirmIndependent:()=>assert.fail('Same scene must not require fallback')}),'linked');
      assert.equal(reads,1);assert.equal(job.profile.comfyInstanceType,'default');
    }finally{await manager.close();}
  }
  const gateway=context.storyboardGatewayRequest(job,'synthetic-key',{references:[],vibes:[]});
  const request=buildComfyCloudRequest(job,gateway,rh),prepared=prepareComfyCloudSubmission(request);
  assert.equal(request.runninghub.instanceType,'default');assert.equal(prepared.body.instanceType,'default');
  assert.equal(request.runninghub.workflowId,'2105524436618268674');assert.equal(prepared.body.workflowId,'2105524436618268674');
  assert.equal(prepared.intent.stillOutput.execution.expectedImages,1);
  assert.doesNotMatch(JSON.stringify(request),/synthetic-key|synthetic-reference/);
  const recorded=context.storyboardStartLog(job);
  assert.equal(recorded.snapshot.profile.comfyInstanceType,'default');
  assert.equal(recorded.snapshot.profile.comfyConsoleUrl,'https://www.runninghub.cn/workflow/2105524436618268674');
  assert.equal(Object.hasOwn(recorded.snapshot,'comfyRetryReview'),false);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(job)),'comfyRetryReview'),false);
  assert.equal(JSON.stringify(log),before);
});
