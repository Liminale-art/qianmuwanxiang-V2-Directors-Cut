import test from 'node:test';
import assert from 'node:assert/strict';
import {executeComfyCloudJob} from '../qianmu-comfy-cloud-execution.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';

function setup({created=true,bound=false,states=['running','queued','ready']}={}){
  let submits=0,reads=0,time=0,active=true;const events=[];
  const task={taskId:'original-upstream'},record={attemptId:'original',cloudTask:bound?task:null};
  const source={id:'original',source:'comfy',chatKey:'original-chat',imageAdmission:{namespace:'st-user:alice'},payload:{prompt:'original'}};
  const gateway={prompt:'original',parameters:{workflow:{node:'fixed'}}},connection={...bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2')};
  const client={cloudCapabilities:async()=>({submission:true,resultRetrieval:true,resultProviders:['comfy-cloud']}),
    prepareCloudSubmission:async(job,request,binding)=>{assert.equal(job.payload.prompt,'original');assert.equal(request.prompt,'original');assert.equal(binding.provider,'comfy-cloud');return {created,record};},
    submitCloudPrepared:async(_prepared,_key,{beforeSubmit,valid})=>{await beforeSubmit();assert.equal(valid(),true);submits++;return {record:{...record,cloudTask:task}};},
    retrieveCloudJob:async(job,row,{deliver})=>{
      assert.equal(job.chatKey,'original-chat');assert.equal(row.cloudTask.taskId,task.taskId);reads++;
      const status=states[Math.min(reads-1,states.length-1)];if(status!=='ready')return {archived:false,status,warning:'original status'};
      return {archived:await deliver(job,{images:['original-image']},[],async()=>{},async()=>{}),warning:''};
    }};
  const options={apiKey:'synthetic',valid:()=>active,wait:async ms=>{time+=ms;},now:()=>time,maxWaitMs:5000,
    beforeSubmit:async()=>{events.push('before');},onPrepared:async()=>events.push('prepared'),onAccepted:async()=>events.push('accepted'),onStatus:async s=>events.push(s),
    deliver:async(job,data,_files,_checkpoint,guard)=>{await guard();assert.equal(job.payload.prompt,'original');assert.equal(data.images[0],'original-image');events.push('archive');return true;}};
  return {client,source,gateway,connection,options,events,run:extra=>executeComfyCloudJob(client,source,gateway,connection,{...options,...extra}),
    stats:()=>({submits,reads,time}),stop:()=>{active=false;}};
}

test('one frozen shot submits once, waits only for its own task and archives with original prose/configuration',async()=>{
  const f=setup();f.client.cloudCapabilities=async()=>{f.source.payload.prompt='changed';f.gateway.prompt='changed';f.connection.provider='runninghub';return {submission:true,resultRetrieval:true,resultProviders:['comfy-cloud']};};
  const result=await f.run();assert.equal(result.archived,true);assert.deepEqual(f.stats(),{submits:1,reads:3,time:5000});
  assert.deepEqual(f.events,['prepared','before','accepted','running','queued','archive']);
});

test('existing accepted tasks only collect originals, while uncertain preparation never POSTs again',async()=>{
  const f=setup({created:false,bound:true,states:['ready']});assert.equal((await f.run()).archived,true);assert.equal(f.stats().submits,0);
  const unknown=setup({created:false});await assert.rejects(unknown.run(),{submissionState:'unknown'});assert.deepEqual(unknown.stats(),{submits:0,reads:0,time:0});
});

test('pinned deployments stop before preparation rather than losing prompt edits',async()=>{
  for(const [url,protocol] of [['https://sample.run.comfy.app','comfy-cloud-v2']]){
    const f=setup();Object.assign(f.connection,bindComfyCloudProtocol(url,protocol));
    f.client.cloudCapabilities=()=>assert.fail('scope must be checked before any preparation or request');
    await assert.rejects(f.run(),{code:'comfy_cloud_submission_scope',submissionState:'not_submitted'});
    assert.equal(f.stats().submits,0);assert.equal(f.stats().reads,0);
  }
});

test('RH retrieval on an old host is not permission to submit; explicit new-host support is required',async()=>{
  const f=setup();Object.assign(f.connection,bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'));
  const capabilities={submission:true,resultRetrieval:true,resultProviders:['comfy-cloud','runninghub']};
  f.client.cloudCapabilities=async()=>capabilities;
  await assert.rejects(f.run(),{code:'comfy_cloud_execution_capabilities',submissionState:'not_submitted'});
  assert.deepEqual(f.stats(),{submits:0,reads:0,time:0});
  capabilities.submissionProviders=['comfy-cloud','runninghub'];
  f.client.prepareCloudSubmission=async()=>({created:true,record:{attemptId:'original'}});
  assert.equal((await f.run()).archived,true);assert.equal(f.stats().submits,1);
});

test('pending tasks stop at a time bound and remain collectible instead of triggering generation again',async()=>{
  const f=setup({states:['running']});const result=await f.run();assert.equal(result.pending,true);assert.equal(result.archived,false);
  assert.equal(result.record.cloudTask.taskId,'original-upstream');assert.deepEqual(f.stats(),{submits:1,reads:3,time:5000});
});

test('failed tasks, lost result replies and post-acceptance callback failure retain acceptance and never retry',async()=>{
  for(const mode of ['failed','network','callback']){
    const f=setup({states:['failed']});if(mode==='network')f.client.retrieveCloudJob=async()=>{throw Error('connection lost');};
    await assert.rejects(f.run(mode==='callback'?{onAccepted:async()=>{throw Error('storage failed');}}:{}),{submissionState:'accepted',upstreamId:'original-upstream'});
    assert.equal(f.stats().submits,1);assert.ok(f.stats().reads<=1);
  }
});

test('stopping before submission and during polling has distinct paid-task state',async()=>{
  const before=setup();before.stop();await assert.rejects(before.run(),{submissionState:'not_submitted'});assert.equal(before.stats().submits,0);
  const after=setup();await assert.rejects(after.run({wait:async()=>after.stop()}),{submissionState:'accepted'});assert.deepEqual(after.stats(),{submits:1,reads:1,time:0});
});

test('unsupported providers and invalid waiting options cannot leave prepared records or submit work',async()=>{
  const f=setup();f.client.cloudCapabilities=async()=>({submission:true,resultRetrieval:false,resultProviders:['comfy-cloud']});
  await assert.rejects(f.run(),{submissionState:'not_submitted'});assert.deepEqual(f.events,[]);
  await assert.rejects(f.run({maxWaitMs:Infinity}),{submissionState:'not_submitted'});assert.equal(f.stats().submits,0);
});

test('automatic cloud probes and unsupported reference semantics cannot silently use a native or text-only workflow',async()=>{
  for(const extra of [{automatic:true},{comfyAutoSelected:true},{profile:{comfyReferences:{enabled:true}}},{profile:{comfyCharacterEnabled:true}},{payload:{comfyCharacterPlan:{}}}]){
    const f=setup();Object.assign(f.source,extra);await assert.rejects(f.run(),{submissionState:'not_submitted'});assert.equal(f.events.length,0);assert.equal(f.stats().submits,0);
  }
});
