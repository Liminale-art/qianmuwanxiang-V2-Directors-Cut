import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {hashText} from '../qianmu-storyboard-utils.js';
import {createImageHistorySeeds,createImageAdmissionIdentity} from '../qianmu-image-admission.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
async function fixture(){
  const e=await compilerEnvironment(),chat=e.context.ctx().chat,reference=core.createStoryboardMessageReference({message:chat[0],chatKey:'chat-a',floor:0});
  const plan=core.createStoryboardWorkflowTicket({messageRef:reference,chatKey:'chat-a',floor:0});
  e.state.shotPlans=[plan];e.state.source='novel';e.state.routing.enabled=false;e.state.target='floor';e.state.floor='0';e.state.connections.novel.draft.baseUrl='https://image.test';
  for(const shot of e.response.shots)delete shot.prompt_renderings; // No Comfy route negotiates dual renderings in this fixture.
  let attempts=0,fail=true,postAdmission=()=>{};
  Object.assign(e.context,{hashText,STORYBOARD_PIPELINE_LOG_LIMIT:40,storyboardPipelineArchiveCache:new Map(),blobStore:{deleteStoryboardPipelineLogs:async()=>{}},
    storyboardArchivePipelineLog:async()=>{},storyboardPipelineForLog:log=>e.state.pipelineLogs.find(p=>p.id===log.pipelineId),storyboardPlanIsTerminal:()=>false,
    storyboardValidatedAnchor:()=>({valid:true}),storyboardPumpQueue:()=>{},storyboardSettleImageAdmission:async()=>{},
    storyboardImageAdmissionRuntime:async()=>({admit:async(job)=>{attempts++;if(fail&&job.inlineOrder.shotIndex===1)throw Error('node service unavailable');postAdmission(job);}})});
  vm.runInContext(['storyboardStoreLog','storyboardStartLog','storyboardFinishLog','storyboardRecordPreparedJobFailure','storyboardPlanForJob','storyboardSyncTaskState','storyboardSetPlanStatus',
    'storyboardQueueJob','storyboardJobFromLog','storyboardRetryLog'].map(section).join('\n'),e.context);
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify({errors:e.errors,notices:e.notices,plan}));
  return {...e,plan,chat,attempts:()=>attempts,repair:()=>{fail=false;},afterAdmission:fn=>postAdmission=fn};
}

test('real preparation/queue stores a failed unsubmitted middle mirror and retry uses only its frozen request and original slot',async()=>{
  const e=await fixture();
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true,JSON.stringify(e.notices));
  const queue=e.context.storyboardQueue;assert.equal(queue.length,2);assert.equal(e.attempts(),3);assert.equal(e.plan.generationStarted,true);
  assert.deepEqual(queue.map(job=>job.inlineOrder.shotIndex),[0,2]);assert.deepEqual(e.plan.shots.map(s=>s.status),['queued','failed','queued']);
  const failed=e.state.logs.find(log=>log.status==='failed');assert.equal(failed.submissionState,'not_submitted');assert.equal(failed.startedAt,0);
  const pipeline=e.state.pipelineLogs.find(row=>row.id===failed.pipelineId);assert.equal(pipeline.status,'failed');assert.ok(pipeline.stages.some(s=>s.type==='queue_preparation'&&s.output.submissionState==='not_submitted'));
  const entries=core.buildStoryboardInlineTasks(e.state.taskStates,{chatKey:'chat-a',chat:e.chat,logs:e.state.logs,waitingIds:new Set(queue.map(j=>j.id))});
  const failure=entries.find(row=>row.status==='failed');assert.equal(failure.label,'本镜尚未提交');assert.equal(failure.action,'retry-task');assert.equal(failure.inlineOrder.shotIndex,1);
  const retryIdentity=await createImageAdmissionIdentity({...failed.snapshot},'st-user:test');
  assert.deepEqual(await createImageHistorySeeds([failed],retryIdentity),[],'a preparation log is not an executed-image history seed');
  for(const job of [...queue]){e.context.storyboardFinishLog(e.state.logs.find(log=>log.id===job.logId),'success',{recordIds:['image-'+job.inlineOrder.shotIndex]});e.context.storyboardSetPlanStatus(e.plan,'completed',{job,resultIds:['image-'+job.inlineOrder.shotIndex]});}
  queue.splice(0);const saved=JSON.stringify(e.plan.shots),count=e.state.logs.length;
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),false);assert.equal(e.state.logs.length,count);assert.equal(JSON.stringify(e.plan.shots),saved);assert.equal(e.attempts(),3);
  e.repair();const original=JSON.stringify(failed.snapshot);e.state.profiles.novel.model='a-totally-different-current-model';
  assert.equal(await e.context.storyboardRetryLog(failed),true);assert.equal(queue.length,1);assert.equal(e.attempts(),4);
  const retry=queue[0];assert.deepEqual(retry.inlineOrder,failed.snapshot.inlineOrder);assert.equal(retry.attempt,2);assert.equal(retry.profile.model,failed.snapshot.profile.model);
  assert.equal(JSON.stringify(failed.snapshot),original);assert.equal(e.plan.shots[0].resultIds[0],'image-0');assert.equal(e.plan.shots[2].resultIds[0],'image-2');
  assert.doesNotMatch(JSON.stringify(retry),/queueAccepted/);
  e.context.storyboardSetPlanStatus(e.plan,'completed',{job:retry,resultIds:['recovered-image']});
  assert.equal(e.plan.shots[1].partialFailureCount,0);assert.equal(e.plan.shots[1].error,'');assert.equal(e.plan.status,'completed');
});

test('a scope change after one queue acceptance reports partial progress and cannot reset accepted plan data',async()=>{
  const e=await fixture();let observed=false;
  const old=e.context.storyboardQueueJob;
  e.context.storyboardQueueJob=async(...args)=>{const result=await old(...args);if(result&&!observed){observed=true;e.state.negative='changed while queueing';}return result;};
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true);assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.attempts(),1);
  assert.ok(e.notices.some(text=>text.includes('1 个请求已进入队列')));assert.equal(e.plan.generationStarted,true);
  assert.equal(e.state.logs.filter(log=>log.status==='failed').length,0,'global cancellation must not write a late per-mirror failure');
});

test('an exception after pushing a job is recognized as queue acceptance, not recorded as unsubmitted',async()=>{
  const e=await fixture();let pumps=0;e.context.storyboardPumpQueue=()=>{pumps++;};e.context.renderModal=()=>{throw Error('render interrupted');};
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true);assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.plan.generationStarted,true);
  assert.equal(pumps,1,'render failure must not strand an already accepted job in the waiting queue');
  assert.equal(e.state.logs.filter(log=>log.status==='failed').length,0);assert.ok(e.notices.some(text=>text.includes('render interrupted')));
});

test('generation replay marker survives plan normalization and lightweight archives; explicit re-extraction resets it',async()=>{
  const e=await fixture();await e.context.storyboardGenerate(null,{plan:e.plan});
  const normalized=core.normalizeStoryboardState(copy(e.state));assert.equal(normalized.shotPlans[0].generationStarted,true);
  vm.runInContext(section('storyboardPlanLightweightSummary'),e.context);
  assert.equal(e.context.storyboardPlanLightweightSummary(e.plan,'archive-id').generationStarted,true);
  const probe=vm.createContext({});vm.runInContext(section('storyboardPlanHasGeneration'),probe);
  assert.equal(probe.storyboardPlanHasGeneration({shots:[{attempt:1}]}),true);assert.equal(probe.storyboardPlanHasGeneration({generationStarted:false,shots:[{attempt:1}]}),false);
  e.context.storyboardQueue.splice(0);assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),true);assert.equal(e.plan.generationStarted,false);
});

test('failed records never overwrite an accepted job or an existing task log',async()=>{
  const e=await fixture();e.repair();await e.context.storyboardGenerate(null,{plan:e.plan});const count=e.state.logs.length,job=e.context.storyboardQueue[0];
  assert.equal(e.context.storyboardRecordPreparedJobFailure(job,'late error'),null);assert.equal(e.state.logs.length,count);
  assert.equal(e.state.logs.find(log=>log.id===job.logId).status,'queued');
});

test('a refused whole-plan replay does not delete its archived history',async()=>{
  const e=await fixture();e.plan.generationStarted=true;e.plan.archiveRef='saved-archive';
  e.context.storyboardReleasePlanArchive=()=>{throw Error('must not release archived history');};
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),false);assert.equal(e.plan.archiveRef,'saved-archive');assert.equal(e.attempts(),0);
});

test('a log-save exception does not leave a phantom queued record or prune old history',async()=>{
  const e=await fixture();e.repair();let once=true;
  e.context.saveSettings=()=>{if(once&&e.state.logs.some(log=>log.status==='queued')){once=false;throw Error('temporary save failure');}};
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true);
  assert.equal(e.context.storyboardQueue.length,2);assert.equal(e.state.logs.length,3);assert.equal(e.state.pipelineLogs.length,3);
  assert.equal(e.state.logs.filter(log=>log.status==='queued').length,2);
  assert.equal(e.state.logs.filter(log=>log.status==='failed'&&log.submissionState==='not_submitted').length,1);
  assert.equal(e.plan.shots[0].status,'failed');
});

test('aggregation retires only the latest same-slot attempt state, retaining every delivered image and distinct request failure',()=>{
  const order={version:1,batchId:'batch',batchStartedAt:1,shotIndex:0,requestIndex:1};
  const old={id:'old',status:'failed',error:'previous failure',inlineOrder:order,attempt:1,requestedAt:1};
  const recovered={...old,id:'retry',status:'completed',error:'',resultIds:['new-image'],attempt:2,requestedAt:2};
  const third={...old,id:'other-request',inlineOrder:{...order,requestIndex:2},error:'independent failure'};
  assert.deepEqual(core.aggregateStoryboardShotTasks([old,recovered]),{status:'completed',error:'',resultIds:['new-image'],partialFailureCount:0});
  assert.equal(core.aggregateStoryboardShotTasks([old,recovered,third]).partialFailureCount,1);
  const originalImage={...old,status:'completed',resultIds:['old-image']};
  const failedRetry={...recovered,status:'failed',error:'current failure',resultIds:[]};
  for(const list of [[originalImage,failedRetry],[failedRetry,originalImage]]){
    const aggregate=core.aggregateStoryboardShotTasks(list,'completed');
    assert.equal(aggregate.status,'failed');assert.deepEqual(aggregate.resultIds,['old-image']);assert.equal(aggregate.error,'current failure');
  }
  assert.equal(core.aggregateStoryboardShotTasks([recovered,{...third,inlineOrder:{...order,batchId:'another-batch'}}]).partialFailureCount,1);
  assert.equal(core.aggregateStoryboardShotTasks([recovered,{...third,chatKey:'another-chat',inlineOrder:order}]).partialFailureCount,1);
});
