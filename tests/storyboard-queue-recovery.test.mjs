import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {hashText} from '../qianmu-storyboard-utils.js';
import {createImageHistorySeeds,createImageAdmissionIdentity} from '../qianmu-image-admission.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {createStoryboardQueueWindow} from '../qianmu-storyboard-queue-window.js';
import {startStoryboardQueueWindowBatch} from '../qianmu-storyboard-queue-batch.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const fixtureWindows=new Set();
test.afterEach(()=>{for(const window of fixtureWindows)window.close();fixtureWindows.clear();});
async function fixture(){
  const e=await compilerEnvironment(),chat=e.context.ctx().chat,reference=core.createStoryboardMessageReference({message:chat[0],chatKey:'chat-a',floor:0});
  const plan=core.createStoryboardWorkflowTicket({messageRef:reference,chatKey:'chat-a',floor:0});
  e.state.shotPlans=[plan];e.state.source='novel';e.styleSelection.enabled=false;e.state.target='floor';e.state.floor='0';e.state.connections.novel.draft.baseUrl='https://image.test';
  for(const shot of e.response.shots){delete shot.prompt_renderings.natural_language;shot.gallery_keywords=['相伴'];} // NAI negotiates only tags; no Comfy route in this fixture.
  let attempts=0,fail=true,postAdmission=()=>{};
  Object.assign(e.context,{hashText,STORYBOARD_PIPELINE_LOG_LIMIT:40,storyboardPipelineArchiveCache:new Map(),blobStore:{deleteStoryboardPipelineLogs:async()=>{}},
    STORYBOARD_QUEUE_LIMIT:8,storyboardQueueBatches:new Set(),startStoryboardQueueWindowBatch,
    storyboardArchivePipelineLog:async()=>{},storyboardPipelineForLog:log=>e.state.pipelineLogs.find(p=>p.id===log.pipelineId),storyboardPlanIsTerminal:()=>false,
    storyboardValidatedAnchor:()=>({valid:true}),storyboardPumpQueue:()=>{},storyboardSettleImageAdmission:async()=>{},
    storyboardImageAdmissionRuntime:async()=>({admit:async(job)=>{attempts++;if(fail&&job.inlineOrder.shotIndex===1)throw Error('node service unavailable');await postAdmission(job);job.imageAdmission={namespace:job.imageAccountNamespace};}})});
  e.context.settings.enabled=true;
  e.context.storyboardQueueWindow=createStoryboardQueueWindow({limit:8,pollMs:5,
    occupied:()=>e.context.storyboardQueue.length+e.context.storyboardActiveJobs.size+e.context.storyboardQueueSettling});
  fixtureWindows.add(e.context.storyboardQueueWindow);
  e.context.storyboardQueuePendingCount=()=>[...e.context.storyboardQueueBatches].reduce((count,entry)=>count+entry.handle.pendingCount,0);
  vm.runInContext(['storyboardStoreLog','storyboardStartLog','storyboardFinishLog','storyboardRecordPreparedJobFailure','storyboardPlanForJob','storyboardSyncTaskState','storyboardSetPlanStatus',
    'storyboardQueueJob','storyboardEnqueuePreparedBatch','storyboardJobFromLog','storyboardRetryLog'].map(section).join('\n'),e.context);
  const generate=e.context.storyboardGenerate;
  e.context.storyboardGenerate=async(...args)=>{const result=await generate(...args);
    await Promise.all([...e.context.storyboardQueueBatches].map(entry=>entry.handle.done));return result;};
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify({errors:e.errors,notices:e.notices,plan}));
  return {...e,plan,chat,rawGenerate:generate,attempts:()=>attempts,repair:()=>{fail=false;},afterAdmission:fn=>postAdmission=fn};
}

test('distinct ordinary mirrors register a visible owner and reserve admission against direct competitors',async()=>{
  const e=await fixture();e.repair();
  for(let index=0;index<5;index++)e.context.storyboardActiveJobs.set(`active-${index}`,{});
  let batchJobs,enterFirst,releaseFirst;
  const firstEntered=new Promise(resolve=>{enterFirst=resolve;});
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const accepted=[],wakes=[];
  const original=e.context.storyboardEnqueuePreparedBatch;
  e.context.storyboardEnqueuePreparedBatch=(jobs,callbacks)=>{
    batchJobs=jobs;const onAccepted=callbacks.onAccepted;
    callbacks.onAccepted=(job,index)=>{accepted.push(job.id);wakes[accepted.length-1]?.();return onAccepted(job,index);};
    return original(jobs,callbacks);
  };
  e.afterAdmission(job=>{if(job.id===batchJobs?.[0]?.id){enterFirst();return firstGate;}});
  assert.equal(await e.rawGenerate(null,{plan:e.plan}),true);
  await firstEntered;
  const [entry]=e.context.storyboardQueueBatches;
  assert.ok(entry);assert.equal(entry.handle.pendingCount,3);
  assert.equal(e.context.storyboardQueuePendingCount(),3);
  assert.equal(e.context.storyboardQueueWindow.reservedCount,1);
  const rival=index=>{const job=copy(batchJobs[0]);job.id=`rival-${index}`;job.planId='';job.planShotId='';job.target='gallery';job.automatic=false;return job;};
  assert.equal(await e.context.storyboardQueueJob(rival(1)),true);
  assert.equal(await e.context.storyboardQueueJob(rival(2)),true);
  assert.equal(e.context.storyboardQueue.length+e.context.storyboardActiveJobs.size+e.context.storyboardQueueWindow.reservedCount,8);
  const firstAccepted=new Promise(resolve=>{wakes[0]=resolve;});
  releaseFirst();await firstAccepted;
  assert.equal(accepted.length,1);assert.equal(entry.handle.pendingCount,2);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(e.context.storyboardQueueWindow.waitingCount,1);
  const secondAccepted=new Promise(resolve=>{wakes[1]=resolve;});
  e.context.storyboardQueue.splice(e.context.storyboardQueue.findIndex(job=>job.id==='rival-1'),1);e.context.storyboardQueueWindow.notify();await secondAccepted;
  const thirdAccepted=new Promise(resolve=>{wakes[2]=resolve;});
  e.context.storyboardQueue.splice(e.context.storyboardQueue.findIndex(job=>job.id==='rival-2'),1);e.context.storyboardQueueWindow.notify();await thirdAccepted;
  const result=await entry.handle.done;
  assert.equal(result.acceptedCount,3);assert.equal(result.pendingCount,0);
  assert.deepEqual(accepted,Array.from(batchJobs,job=>job.id));
  assert.equal(e.context.storyboardQueuePendingCount(),0);
  assert.equal(e.context.storyboardQueueWindow.reservedCount,0);
});

test('clearing an owned ordinary batch before its first slot leaves zero admissions and no phantom work',async()=>{
  const e=await fixture();e.repair();
  for(let index=0;index<8;index++)e.context.storyboardActiveJobs.set(`active-${index}`,{});
  assert.equal(await e.rawGenerate(null,{plan:e.plan}),true);
  const [entry]=e.context.storyboardQueueBatches;
  assert.ok(entry);assert.equal(e.context.storyboardQueuePendingCount(),3);
  entry.handle.stop('用户清空等待');
  const result=await entry.handle.done;
  assert.equal(result.acceptedCount,0);assert.equal(result.pendingCount,3);
  assert.equal(e.attempts(),0);assert.equal(e.context.storyboardQueue.length,0);
  assert.equal(e.context.storyboardQueuePendingCount(),0);
  assert.deepEqual(e.plan.shots.map(shot=>shot.status),['cancelled','cancelled','cancelled']);
});

test('registration render failure keeps the batch owner and later accepts each mirror once',async()=>{
  const e=await fixture();e.repair();let renders=0;
  for(let index=0;index<8;index++)e.context.storyboardActiveJobs.set(`active-${index}`,{});
  e.context.renderModal=()=>{if(++renders===1)throw Error('synthetic render failure');};
  assert.equal(await e.rawGenerate(null,{plan:e.plan}),true);
  const [entry]=e.context.storyboardQueueBatches;
  assert.ok(entry);assert.equal(entry.handle.pendingCount,3);assert.equal(e.attempts(),0);
  e.context.storyboardActiveJobs.clear();e.context.storyboardQueueWindow.notify();
  const result=await entry.handle.done;
  assert.equal(result.acceptedCount,3);assert.equal(result.pendingCount,0);
  assert.equal(e.attempts(),3);assert.equal(e.context.storyboardQueue.length,3);
  assert.equal(new Set(e.context.storyboardQueue.map(job=>job.id)).size,3);
  assert.equal(e.context.storyboardQueuePendingCount(),0);
});

test('two NAI requests for one shot keep the direct path when slots exist, without replay after a changed input',async()=>{
  const e=await fixture();e.repair();
  e.state.promptDraft.shots=e.state.promptDraft.shots.slice(0,1);e.state.profiles.novel.count='2';e.state.profiles.novel.loaded=true;
  let changed=false;const queue=e.context.storyboardQueueJob;
  e.context.storyboardQueueJob=async(...args)=>{const accepted=await queue(...args);if(accepted&&!changed){changed=true;e.state.negative='changed after first admission';}return accepted;};
  assert.equal(await e.rawGenerate(null,{plan:e.plan}),true);
  assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.attempts(),1);
  assert.equal(e.plan.shots.length,1);assert.equal(e.context.storyboardQueue[0].requestTotal,2);
  assert.equal(e.context.storyboardQueueBatches.size,0);assert.equal(e.context.storyboardQueuePendingCount(),0);
  assert.ok(e.notices.some(message=>message.includes('1 个请求已进入队列')));
});

test('real preparation/queue stores a failed unsubmitted middle mirror and retry uses only its frozen request and original slot',async()=>{
  const e=await fixture();
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true,JSON.stringify(e.notices));
  const queue=e.context.storyboardQueue;assert.equal(queue.length,2);assert.equal(e.attempts(),3);assert.equal(e.plan.generationStarted,true);
  assert.deepEqual(queue.map(job=>job.inlineOrder.shotIndex),[0,2]);assert.deepEqual(e.plan.shots.map(s=>s.status),['queued','failed','queued']);
  const failed=e.state.logs.find(log=>log.status==='failed');assert.equal(failed.submissionState,'not_submitted');assert.equal(failed.startedAt,0);
  assert.equal(failed.snapshot.imageAccountNamespace,'st-user:route-test');
  assert.equal(core.normalizeStoryboardState(copy(e.state)).logs.find(log=>log.id===failed.id).snapshot.imageAccountNamespace,'st-user:route-test');
  const pipeline=e.state.pipelineLogs.find(row=>row.id===failed.pipelineId);assert.equal(pipeline.status,'failed');assert.ok(pipeline.stages.some(s=>s.type==='queue_preparation'&&s.output.submissionState==='not_submitted'));
  const entries=core.buildStoryboardInlineTasks(e.state.taskStates,{chatKey:'chat-a',chat:e.chat,logs:e.state.logs,waitingIds:new Set(queue.map(j=>j.id))});
  const failure=entries.find(row=>row.status==='failed');assert.equal(failure.label,'本镜尚未提交');assert.equal(failure.action,'retry-task');assert.equal(failure.inlineOrder.shotIndex,1);
  const retryIdentity=await createImageAdmissionIdentity({...failed.snapshot},'st-user:route-test');
  assert.deepEqual(await createImageHistorySeeds([failed],retryIdentity),[],'a preparation log is not an executed-image history seed');
  for(const job of [...queue]){e.context.storyboardFinishLog(e.state.logs.find(log=>log.id===job.logId),'success',{recordIds:['image-'+job.inlineOrder.shotIndex]});e.context.storyboardSetPlanStatus(e.plan,'completed',{job,resultIds:['image-'+job.inlineOrder.shotIndex]});}
  assert.equal(e.plan.status,'completed','persisted legacy status stays compatible with existing images');
  assert.equal(core.storyboardPartialCompletion(e.plan)?.incompleteCount,1);
  assert.equal(e.notices.filter(text=>text==='部分完成 · 1 镜未完成').length,1,'the settled batch is announced once');
  queue.splice(0);const saved=JSON.stringify(e.plan.shots),count=e.state.logs.length;
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),false);assert.equal(e.state.logs.length,count);assert.equal(JSON.stringify(e.plan.shots),saved);assert.equal(e.attempts(),3);
  e.repair();const original=JSON.stringify(failed.snapshot);e.state.profiles.novel.model='a-totally-different-current-model';
  assert.equal(await e.context.storyboardRetryLog(failed),true);assert.equal(queue.length,1);assert.equal(e.attempts(),4);
  const retry=queue[0];assert.deepEqual(retry.inlineOrder,failed.snapshot.inlineOrder);assert.equal(retry.attempt,2);assert.equal(retry.profile.model,failed.snapshot.profile.model);
  assert.deepEqual(copy(failed.snapshot.tags),['相伴']);assert.deepEqual(copy(retry.tags),['相伴']);
  assert.deepEqual(copy(e.state.logs.find(row=>row.id===retry.logId).snapshot.tags),['相伴']);
  assert.equal(JSON.stringify(failed.snapshot),original);assert.equal(e.plan.shots[0].resultIds[0],'image-0');assert.equal(e.plan.shots[2].resultIds[0],'image-2');
  assert.doesNotMatch(JSON.stringify(retry),/queueAccepted/);
  e.context.storyboardSetPlanStatus(e.plan,'completed',{job:retry,resultIds:['recovered-image']});
  assert.equal(e.plan.shots[1].partialFailureCount,0);assert.equal(e.plan.shots[1].error,'');assert.equal(e.plan.status,'completed');
  assert.equal(core.storyboardPartialCompletion(e.plan),null,'successful retry clears only the derived partial badge');
});

test('a saved failure cannot be retried from another ST account or without a verified origin',async()=>{
  const e=await fixture();await e.context.storyboardGenerate(null,{plan:e.plan});
  const failed=e.state.logs.find(log=>log.status==='failed'),before=e.attempts(),size=e.context.storyboardQueue.length;
  e.repair();e.setAccount('st-user:another');
  assert.equal(await e.context.storyboardRetryLog(failed),false);
  assert.equal(e.attempts(),before);assert.equal(e.context.storyboardQueue.length,size);
  e.setAccount('st-user:route-test');
  const legacy=copy(failed);delete legacy.snapshot.imageAccountNamespace;delete legacy.snapshot.imageAdmission;
  e.state.logs.push(legacy);
  assert.equal(await e.context.storyboardRetryLog(legacy),false);
  assert.equal(e.attempts(),before);assert.equal(e.context.storyboardQueue.length,size);
});

test('an account switch or changed owner during failure logging never writes a new task',async()=>{
  const e=await fixture();await e.context.storyboardGenerate(null,{plan:e.plan});
  const failed=e.state.logs.find(log=>log.status==='failed'),job=e.context.storyboardJobFromLog(failed);
  Object.defineProperty(job,'imageOwnerState',{value:e.state});
  const count=e.state.logs.length;
  e.setAccount('st-user:another');
  assert.equal(await e.context.storyboardRecordPreparedJobFailure(job,'refused'),null);
  assert.equal(e.state.logs.length,count);
  e.setAccount('st-user:route-test');
  let release;const wait=new Promise(resolve=>release=resolve),original=e.context.resolveImageAccountNamespace;
  e.context.resolveImageAccountNamespace=()=>wait;
  let current=true;const pending=e.context.storyboardRecordPreparedJobFailure(job,'refused',()=>current);
  current=false;release('st-user:route-test');
  assert.equal(await pending,null);assert.equal(e.state.logs.length,count);
  e.context.resolveImageAccountNamespace=original;
});

test('a scope change after one queue acceptance reports partial progress and cannot reset accepted plan data',async()=>{
  const e=await fixture();let observed=false;
  const old=e.context.storyboardQueueJob;
  e.context.storyboardQueueJob=async(...args)=>{const result=await old(...args);if(result&&!observed){observed=true;e.plan.shots[1].prompt='changed while queueing';}return result;};
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true);assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.attempts(),1);
  assert.ok(e.notices.some(text=>text.includes('已入队 1/3')));assert.equal(e.plan.generationStarted,true);
  assert.equal(e.state.logs.filter(log=>log.status==='failed').length,0,'global cancellation must not write a late per-mirror failure');
});

test('ordinary deferred stop after a saved picture ends as visibly partial without replaying accepted work',async()=>{
  const e=await fixture();e.repair();e.context.STORYBOARD_QUEUE_LIMIT=1;
  e.context.storyboardEnqueuePreparedBatch=(jobs,callbacks)=>{
    callbacks.onAccepted(jobs[0]);
    e.context.storyboardSetPlanStatus(e.plan,'completed',{job:jobs[0],resultIds:['saved-image']});
    callbacks.onStop({remainingJobs:jobs.slice(1)});
    return {pendingCount:0,done:Promise.resolve()};
  };
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true);
  assert.equal(e.plan.status,'completed');assert.deepEqual(e.plan.shots.map(shot=>shot.status),['completed','cancelled','cancelled']);
  assert.equal(core.storyboardPartialCompletion(e.plan)?.incompleteCount,2);
  assert.equal(e.notices.filter(text=>text==='部分完成 · 2 镜未完成').length,1);
  assert.equal(e.attempts(),0,'this presentation-only test never opens provider admission');
});

test('an exception after pushing a job is recognized as queue acceptance, not recorded as unsubmitted',async()=>{
  const e=await fixture();let pumps=0;e.context.storyboardPumpQueue=()=>{pumps++;};e.context.renderModal=()=>{throw Error('render interrupted');};
  assert.equal(await e.context.storyboardGenerate(null,{plan:e.plan}),true);assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.plan.generationStarted,true);
  assert.equal(pumps,1,'render failure must not strand an already accepted job in the waiting queue');
  assert.equal(e.state.logs.filter(log=>log.status==='failed').length,0);assert.equal(e.context.storyboardQueuePendingCount(),0);
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
  assert.equal(await e.context.storyboardRecordPreparedJobFailure(job,'late error'),null);assert.equal(e.state.logs.length,count);
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
