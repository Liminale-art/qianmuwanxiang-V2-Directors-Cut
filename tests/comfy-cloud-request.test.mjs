import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildComfyCloudRequest} from '../qianmu-comfy-cloud-request.js';
import {prepareComfyCloudSubmission} from '../qianmu-comfy-cloud-prepare.js';
import {createComfyRecoveryClient} from '../qianmu-comfy-recovery-client.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';
import {bindComfyCloudTask} from '../qianmu-comfy-cloud-protocol.js';
import {imageChannelKey} from '../qianmu-image-channel.js';
import {executeComfyCloudJob} from '../qianmu-comfy-cloud-execution.js';
import {auditComfyWorkflow,requireComfyExecution} from '../qianmu-comfy-audit.js';
import {prepareComfyWorkflow} from '../qianmu-comfy-workflow.js';
import {resolveStoryboardJobModelIdentity,resolveStoryboardConnectionBinding} from '../qianmu-storyboard.js';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
const connection=bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2');
const workflow=()=>({model:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'fixed.safetensors'}},
  pos:{class_type:'CLIPTextEncode',inputs:{text:'fixed style, %qianmu_prompt%',clip:['model',1]}},
  neg:{class_type:'CLIPTextEncode',inputs:{text:'fixed negative',clip:['model',1]}},
  latent:{class_type:'EmptyLatentImage',inputs:{width:512,height:512,batch_size:1}},
  sample:{class_type:'KSampler',inputs:{model:['model',0],positive:['pos',0],negative:['neg',0],latent_image:['latent',0],seed:1,steps:20,cfg:6,sampler_name:'euler',scheduler:'normal',denoise:1}},
  decode:{class_type:'VAEDecode',inputs:{samples:['sample',0],vae:['model',2]}},save:{class_type:'SaveImage',inputs:{images:['decode',0]}}});
function fixture(){
  const graph=workflow(),policy={version:1,automatic:false,maxImages:8,outputNodeIds:['save'],allowUnverified:false};
  const job={id:'original',source:'comfy',chatKey:'original-chat',logId:'log',automatic:false,profile:{model:'comfy-workflow'},
    imageAdmission:{version:1,namespace:'st-user:alice',attemptId:'original'},connection:{baseUrl:connection.origin,credentialId:'original-key',options:{comfyTransport:'gateway'}},
    payload:{prompt:'a quiet garden',negative:'dynamic negative',parameters:{workflow:graph,width:512,height:512,count:1}}};
  job.comfyExecution=requireComfyExecution(auditComfyWorkflow(prepareComfyWorkflow(graph,{prompt:job.payload.prompt}).bind([]),policy),policy);
  const context=vm.createContext({resolveStoryboardJobModelIdentity,resolveStoryboardConnectionBinding,clone:structuredClone,storyboardParseWorkflow:value=>typeof value==='string'?JSON.parse(value):structuredClone(value)});
  vm.runInContext(storyboardFunctionSource('storyboardGatewayRequest'),context);
  return {job,gateway:context.storyboardGatewayRequest(job,'synthetic-key',{references:[],vibes:[]})};
}

test('the actual gateway and frozen RH profile reach the prepared provider body without affecting another cloud family',()=>{
  const rh=bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1');
  for(const tier of ['default','plus','ultra']){
    const {job,gateway}=fixture();job.connection.baseUrl=gateway.baseUrl=rh.origin;job.profile.comfyInstanceType=tier;
    const request=buildComfyCloudRequest(job,gateway,rh);job.profile.comfyInstanceType='changed';
    assert.equal(prepareComfyCloudSubmission(request).body.instanceType,tier);
    assert.ok(Object.isFrozen(request.runninghub));
  }
  const {job,gateway}=fixture();job.profile.comfyInstanceType='ultra';assert.equal(buildComfyCloudRequest(job,gateway,connection).runninghub,undefined);
  job.connection.baseUrl=gateway.baseUrl=rh.origin;job.profile.comfyInstanceType='[invalid]';
  assert.throws(()=>buildComfyCloudRequest(job,gateway,rh),{code:'comfy_cloud_request',submissionState:'not_submitted'});
});
test('actual storyboard gateway projection is accepted by the server without rewriting fixed workflow content',()=>{
  const {job,gateway}=fixture(),original=structuredClone(gateway.parameters.workflow);
  assert.equal(gateway.comfyExecution.expectedImages,1);
  const request=buildComfyCloudRequest(job,gateway,connection),prepared=prepareComfyCloudSubmission(request);
  assert.equal(request.execution.expectedImages,undefined,'computed output evidence is rechecked, not smuggled into the closed input policy');
  assert.equal(prepared.intent.stillOutput.execution.expectedImages,1);
  assert.equal(prepared.body.workflow.pos.inputs.text,'fixed style, a quiet garden');
  assert.equal(prepared.body.workflow.neg.inputs.text,'fixed negative');assert.equal(prepared.body.workflow.model.inputs.ckpt_name,'fixed.safetensors');
  assert.deepEqual(gateway.parameters.workflow,original);assert.equal(request.workflow.pos.inputs.text,'fixed style, %qianmu_prompt%');
  assert.doesNotMatch(JSON.stringify(request),/synthetic-key|credentialId|original-chat/);
  assert.ok(Object.isFrozen(request)&&Object.isFrozen(request.workflow.sample.inputs));
});
test('cloud projection rejects cross-connection, hidden reference loss, changed output count and weaker automatic policy',()=>{
  for(const mutate of [f=>{f.gateway.baseUrl='https://www.runninghub.cn';},f=>{f.gateway.referenceImages=[{url:'private.png'}];},
    f=>{f.gateway.vibes=[{id:'private'}];},f=>{f.gateway.comfyExecution={...f.gateway.comfyExecution,expectedImages:2};},
    f=>{f.job.automatic=true;},f=>{f.job.source='novel';}]){
    const f=fixture();mutate(f);assert.throws(()=>buildComfyCloudRequest(f.job,f.gateway,connection));
  }
});
test('program-selected strict output policy remains distinct from whether the user clicked manually',()=>{
  const f=fixture();f.job.comfyAutoSelected=true;
  f.gateway.comfyExecution={...f.gateway.comfyExecution,automatic:true,maxImages:1};
  const request=buildComfyCloudRequest(f.job,f.gateway,connection);
  assert.equal(request.execution.automatic,true);assert.equal(f.job.automatic,false);
  assert.equal(prepareComfyCloudSubmission(request).intent.stillOutput.execution.automatic,true);
});
test('request freezes before asynchronous preparation and never persists its workflow or Key in the journal',async()=>{
  const f=fixture(),rows=new Map();let release,entered;
  const wait=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{entered=resolve;});
  const client=createComfyRecoveryClient({origin:'https://st.test',account:async()=>{entered();await wait;return 'st-user:alice';},
    store:{get:async()=>rows.get('row')||null,put:async row=>rows.set('row',structuredClone(row)),close(){}},
    locks:{request:async(_name,_options,work)=>work({})},fetchImpl:()=>assert.fail('preflight must not call a provider')});
  const work=client.prepareCloudSubmission(f.job,f.gateway,connection);await arrived;
  f.gateway.prompt='changed after await';f.gateway.parameters.workflow.model.inputs.ckpt_name='different.safetensors';release();
  const ready=await work;assert.equal(ready.created,true);assert.equal(ready.request.prompt,'a quiet garden');
  assert.equal(ready.request.workflow.model.inputs.ckpt_name,'fixed.safetensors');assert.doesNotMatch(JSON.stringify(rows.get('row')),/safetensors|synthetic-key|garden/);
  client.close();
});

async function submissionFixture({capabilities={},reply,resultReply,prepare=true}={}){
  const f=fixture(),rows=new Map(),calls=[];let namespace='st-user:alice',writeFails=false;
  const expectedAccount=`st-user:${await imageChannelKey('alice')}`;
  const packet={ok:true,version:1,status:'accepted',task:bindComfyCloudTask(connection,'accepted',{self:'/api/v2/jobs/accepted',cancel:'/api/v2/jobs/accepted/cancel'}),
    locator:{version:1,attemptId:f.job.id,channelKey:'a'.repeat(64)}};
  const client=createComfyRecoveryClient({origin:'https://st.test',account:async()=>namespace,
    store:{get:async()=>structuredClone(rows.get('row')||null),put:async row=>{if(writeFails)throw Error('synthetic storage failure');rows.set('row',structuredClone(row));},close(){}},
    locks:{request:async(_name,_options,work)=>work({})},fetchImpl:async(url,init)=>{
      calls.push({url,...init,body:init.body?JSON.parse(init.body):undefined});
      if(url.endsWith('/capabilities'))return Response.json({ok:true,version:1,expectedAccount,accountBindingVersion:1,catalogVersion:1,
        submission:true,resultRetrieval:true,archiveConfirmation:true,cancellation:false,referenceUpload:false,automaticReplay:false,
        queryProviders:['comfy-cloud','runninghub'],resultProviders:['comfy-cloud'],...capabilities});
      if(resultReply&&(/\/(?:result|acknowledge)$/.test(url)))return resultReply(url,JSON.parse(init.body),packet);
      assert.ok(url.endsWith('/cloud/tasks/submit'));
      return reply?reply(packet,()=>{writeFails=true;}):Response.json(packet);
    }});
  return {...f,client,rows,calls,prepared:prepare?await client.prepareCloudSubmission(f.job,f.gateway,connection):null,setAccount:value=>{namespace=value;}};
}

test('switching from private native Comfy to an official cloud discards only the obsolete private-network flag',async()=>{
  const f=await submissionFixture({prepare:false});
  f.job.connection.options.allowPrivateNetwork=true;
  const prepared=await f.client.prepareCloudSubmission(f.job,f.gateway,connection);
  assert.equal(prepared.record.allowPrivateNetwork,false);
  assert.equal(prepared.record.cloudConnection.origin,connection.origin);
  assert.equal(f.job.connection.options.allowPrivateNetwork,true);
  assert.equal(f.calls.length,0);f.client.close();
});

test('an issued ticket submits once despite overlapping clicks and caller mutation, then binds the original record',async()=>{
  const f=await submissionFixture();
  const duplicate=await f.client.prepareCloudSubmission(f.job,f.gateway,connection);
  assert.equal(duplicate.created,false);
  for(const invalid of [duplicate,{...f.prepared},null])await assert.rejects(f.client.submitCloudPrepared(invalid,'synthetic-key'),{submissionState:'not_submitted'});
  f.prepared.binding.attemptId='foreign';f.prepared.record.chatKey='foreign';f.prepared.request={prompt:'foreign'};
  const first=f.client.submitCloudPrepared(f.prepared,'synthetic-key');
  await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key'),{submissionState:'not_submitted'});
  const accepted=await first;assert.equal(accepted.record.chatKey,'original-chat');assert.equal(accepted.binding.attemptId,'original');
  assert.equal(accepted.record.cloudTask.taskId,'accepted');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  const body=f.calls.find(c=>c.method==='POST').body;assert.equal(body.request.prompt,'a quiet garden');assert.equal(body.attemptId,'original');
  assert.doesNotMatch(JSON.stringify(f.rows.get('row')),/synthetic-key|safetensors|garden/);f.client.close();
});

test('unavailable collection, closed capability, changed account or changed preparation stops before any POST',async()=>{
  for(const mode of ['capability','results','provider','account','record']){
    const f=await submissionFixture({capabilities:mode==='capability'?{submission:false}:mode==='results'?{resultRetrieval:false}:mode==='provider'?{resultProviders:[]}: {}});
    if(mode==='account')f.setAccount('st-user:bob');if(mode==='record')f.rows.clear();
    await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key'),{submissionState:'not_submitted'});
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);f.client.close();
  }
});

test('lost, malformed or oversized submit replies remain unknown and cannot trigger automatic resubmission',async()=>{
  for(const reply of [()=>{throw Error('network failure');},()=>new Response('not JSON'),()=>new Response('x'.repeat(17000)),
    packet=>Response.json({...packet,task:null}),()=>Response.json({ok:false,message:'ambiguous'})]){
    const f=await submissionFixture({reply});
    await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key'),{submissionState:'unknown'});
    await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key'),{submissionState:'not_submitted'});
    assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.rows.get('row').cloudTask,null);f.client.close();
  }
});

test('explicit server submission state is retained and local storage failure after acceptance never becomes unsent',async()=>{
  for(const state of ['not_submitted','unknown','accepted']){
    const f=await submissionFixture({reply:()=>Response.json({ok:false,message:'retained original state',submissionState:state},{status:409})});
    await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key'),{submissionState:state});f.client.close();
  }
  const f=await submissionFixture({reply:(packet,failWrite)=>{failWrite();return Response.json(packet);}});
  await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key'),{submissionState:'accepted'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.rows.get('row').cloudTask,null);f.client.close();
});

test('last-moment admission cancellation cannot reach the cloud POST',async()=>{
  const f=await submissionFixture();let active=true;
  await assert.rejects(f.client.submitCloudPrepared(f.prepared,'synthetic-key',{valid:()=>active,beforeSubmit:async()=>{active=false;}}),{submissionState:'not_submitted'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);f.client.close();
});

test('execution controller composes with the real client from original preparation through pending receipt and recipe-preserving archive',async()=>{
  let reads=0,time=0,delivered;
  const receipt='b'.repeat(64),delivery={state:'stored',cacheReceipt:receipt,imageCount:1};
  const f=await submissionFixture({prepare:false,resultReply:(url,body,packet)=>{
    assert.equal(body.attemptId,'original');
    if(url.endsWith('/acknowledge')){assert.equal(body.apiKey,undefined);return Response.json({ok:true,version:1,status:'archived',task:packet.task,delivery:{...delivery,state:'archived'},cleanup:'complete'});}
    reads++;return Response.json(reads===1?{ok:true,version:1,status:'running',task:packet.task}:
      {...packet,status:'ready',provider:'comfy-cloud',upstreamId:packet.task.taskId,receipt,delivery,images:[{data:'synthetic-image',mime:'image/png'}]});
  }});
  const result=await executeComfyCloudJob(f.client,f.job,f.gateway,connection,{apiKey:'synthetic-key',now:()=>time,wait:async ms=>{time+=ms;},
    deliver:async(job,_data,files,checkpoint,guard)=>{await guard();assert.equal(files.length,0);delivered=job;await checkpoint([{url:'/user/images/original.png'}]);return true;}});
  assert.equal(result.archived,true);assert.equal(delivered.payload.prompt,'a quiet garden');assert.equal(delivered.chatKey,'original-chat');
  assert.equal(f.rows.get('row').status,'confirmed');assert.equal(f.calls.filter(c=>c.url.endsWith('/submit')).length,1);assert.equal(reads,2);f.client.close();
});
