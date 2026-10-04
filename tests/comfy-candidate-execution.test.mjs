import test from 'node:test';
import assert from 'node:assert/strict';
import { auditComfyWorkflow, requireComfyExecution } from '../qianmu-comfy-audit.js';
import { normalizeComfyReceipt } from '../qianmu-comfy-receipt.js';
import { prepareComfyCloudSubmission } from '../qianmu-comfy-cloud-prepare.js';
import { normalizeComfyCloudReceipt } from '../qianmu-comfy-cloud-receipt.js';
import { collectRunningHubStillResults } from '../qianmu-runninghub-results.js';
import { collectComfyCloudStillResults } from '../qianmu-comfy-cloud-results.js';
import { normalizeComfyCloudStage, RUNNINGHUB_STAGE_SCHEMA } from '../qianmu-comfy-cloud-stage-contract.js';
import { normalizeComfyCloudChannel, COMFY_CLOUD_CHANNEL_SCHEMA } from '../qianmu-comfy-cloud-channel-state.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { imageGatewayCapabilities, generateImage } from '../qianmu-image-gateway.js';
import { generateDirectImage } from '../qianmu-image-direct.js';
import { probeQianmuImageCapabilities, checkQianmuComfyExecutionBinding } from '../qianmu-service-capabilities.js';
import { planStoryboardProviderRequests, buildStoryboardProviderPlan } from '../qianmu-storyboard.js';
import { prepareComfyWorkflow } from '../qianmu-comfy-workflow.js';
import { stillInput } from './helpers/runninghub-validation-fixture.mjs';

const policy = () => ({version:2,automatic:true,maxImages:8,outputNodeIds:['save'],allowUnverified:false});
const input = (batch=3) => {
  const value=stillInput();value.workflow.latent.inputs.batch_size=batch;value.execution=policy();
  value.runninghub={workflowId:'2105524436618268674',instanceType:'default'};return value;
};
const graph = batch => {const value=input(batch).workflow;value.latent.inputs.width=512;return value;};
const execution = batch => requireComfyExecution(auditComfyWorkflow(graph(batch),policy()),policy());
const image = number => ({filename:`candidate-${number}.png`,type:'output'});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const receipt = () => {
  const {intent}=prepareComfyCloudSubmission(input());
  return normalizeComfyCloudReceipt({schema:'qianmu.comfy-cloud-receipt.v1',task:bindComfyCloudTask(intent.connection,'123456'),
    requestDigest:intent.requestDigest,workflow:intent.workflow,stillOutput:intent.stillOutput});
};

test('v2 single-shot candidates bind one final output and exact count without rewriting the workflow',()=>{
  for(const count of [1,3,8]){
    const request=input(count),before=structuredClone(request),prepared=prepareComfyCloudSubmission(request);
    assert.deepEqual(request,before);assert.equal(JSON.parse(prepared.body.workflow).latent.inputs.batch_size,count);
    assert.deepEqual(prepared.intent.stillOutput.execution,{version:2,automatic:true,maxImages:count,outputNodeIds:['save'],expectedImages:count});
    assert.equal(prepared.body.workflowId,request.runninghub.workflowId);assert.equal(prepared.body.instanceType,'default');
    assert.equal(planStoryboardProviderRequests('comfy',count).length,1,'candidate count must never multiply provider requests');
    assert.equal(planStoryboardProviderRequests('comfy',count)[0].imageCount,count);
  }
});

test('count slots accept eight candidates only for Comfy, preserving other provider bounds and rejecting invalid configured counts',()=>{
  const workflow=input().workflow;workflow.latent.inputs.batch_size='%qianmu_count%';
  const plan=buildStoryboardProviderPlan({providerId:'comfy',modelId:'comfy-workflow',prompt:'scene',params:{count:8,workflow}});
  assert.equal(plan.gatewayRequest.parameters.count,8);
  assert.equal(prepareComfyWorkflow(workflow,{prompt:'scene',model:'fixture.safetensors',parameters:{count:8,width:512}}).bind([]).latent.inputs.batch_size,8);
  assert.equal(planStoryboardProviderRequests('openai',8)[0].imageCount,4);assert.equal(planStoryboardProviderRequests('novel',8).length,4);
  for(const count of [0,9,1.5,'bad'])assert.throws(()=>planStoryboardProviderRequests('comfy',count),{code:'comfy_invalid_parameter'});
});

test('v2 never admits unknown batch, independent branches, unselected saves or over-limit internal work automatically',()=>{
  const mutations=[g=>{g.latent.inputs.batch_size='3';},g=>{g.custom={class_type:'Unknown',inputs:{}};},
    g=>{g.latent.inputs.batch_size=9;},g=>{g.extra={class_type:'SaveImage',inputs:{images:['decode',0]}};},
    g=>{g.branch={class_type:'KSampler',inputs:{...g.sampler.inputs}};g.branchDecode={class_type:'VAEDecode',inputs:{samples:['branch',0],vae:['model',2]}};g.preview={class_type:'PreviewImage',inputs:{images:['branchDecode',0]}};},
    g=>{g.repeat={class_type:'RepeatImageBatch',inputs:{image:['decode',0],amount:3}};g.preview={class_type:'PreviewImage',inputs:{images:['repeat',0]}};}];
  for(const mutate of mutations){const value=graph(3);mutate(value);assert.throws(()=>requireComfyExecution(auditComfyWorkflow(value,policy()),policy()),error=>error.code.startsWith('comfy_'));}
  const many=graph(1);many.other={class_type:'SaveImage',inputs:{images:['decode',0]}};
  const manual={...policy(),automatic:false,allowUnverified:true,outputNodeIds:[]};
  assert.throws(()=>requireComfyExecution(auditComfyWorkflow(many,manual),manual),{code:'comfy_output_selection'});
});

test('v1 automatic policy and archived receipt remain single-image; versions are not silently promoted',()=>{
  const legacy={...policy(),version:1,maxImages:1},one=graph(1),many=graph(3);
  assert.equal(requireComfyExecution(auditComfyWorkflow(one,legacy),legacy).version,1);
  assert.throws(()=>requireComfyExecution(auditComfyWorkflow(many,legacy),legacy));
  const saved={version:1,model:'workflow',previewNodeIds:[],execution:{version:1,automatic:true,maxImages:1,expectedImages:1,outputNodeIds:['save']}};
  assert.deepEqual(normalizeComfyReceipt(saved),saved);
  assert.throws(()=>normalizeComfyReceipt({...saved,execution:{...saved.execution,maxImages:3,expectedImages:3}}));
  for(const change of [{version:3},{maxImages:8},{expectedImages:undefined},{outputNodeIds:['save','other']}]){
    const current=receipt().stillOutput;assert.throws(()=>normalizeComfyReceipt({...current,execution:{...current.execution,...change}}));
  }
});

test('old service keeps v1 compatibility but cannot admit a new v2 candidate job',async()=>{
  const body=imageGatewayCapabilities();const probe=()=>probeQianmuImageCapabilities({fetchImpl:async()=>new Response(JSON.stringify(body))});
  assert.equal(checkQianmuComfyExecutionBinding(await probe(),{executionVersion:2}).ok,true);
  delete body.comfyExecution.candidateExecutionVersion;
  assert.equal(checkQianmuComfyExecutionBinding(await probe(),{executionVersion:1}).ok,true);
  assert.equal(checkQianmuComfyExecutionBinding(await probe(),{executionVersion:2}).ok,false);
});

test('RunningHub v2 candidates preserve task/output order; missing, extra or foreign outputs remain failures',()=>{
  const saved=receipt(),results=[3,1,2].map(n=>({url:`https://files.example/${n}.png`,nodeId:'save',outputType:'png'}));
  const body={taskId:saved.task.taskId,status:'SUCCESS',errorCode:'',results};
  const result=collectRunningHubStillResults(saved,body);assert.deepEqual(result.outputs.map(row=>row.outputIndex),[0,1,2]);
  assert.deepEqual(result.outputs.map(row=>row.sourceUrl),results.map(row=>row.url));
  for(const changed of [{...body,results:results.slice(0,2)},{...body,results:[...results,{url:'https://files.example/4.png',nodeId:'other',outputType:'png'}]},
    {...body,taskId:'another'}])assert.throws(()=>collectRunningHubStillResults(saved,changed));
});

test('Comfy Cloud v2 collects all three candidates and rejects unexpected saved outputs',()=>{
  const saved=structuredClone(receipt()),connection=bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2');
  saved.task=bindComfyCloudTask(connection,'original',{self:'/api/v2/jobs/original',cancel:'/api/v2/jobs/original/cancel'});
  const outputs=[1,2,3].map(n=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,node_id:'save',job_id:'original',type:'image',content_type:'image/png',size_bytes:100,hash:null}));
  const body={id:'original',status:'succeeded',urls:saved.task.links,error:null,outputs};
  assert.equal(collectComfyCloudStillResults(saved,body).outputs.length,3);
  assert.throws(()=>collectComfyCloudStillResults(saved,{...body,outputs:outputs.slice(0,2)}));
  assert.throws(()=>collectComfyCloudStillResults(saved,{...body,outputs:[...outputs,{...outputs[0],id:'00000000-0000-4000-8000-000000000004',node_id:'other'}]}));
});

test('v2 candidate staging and durable delivery retain exact count, identity, task and order',()=>{
  const saved=receipt(),owner={namespace:'st-user:test',channelKey:'a'.repeat(64),attemptId:'attempt',requestDigest:saved.requestDigest,fence:'fence'};
  const selection=[0,1,2].map(outputIndex=>({outputKey:`rh:${saved.task.taskId}:${outputIndex}:save`,outputIndex,nodeId:'save',mime:'image/png',sizeBytes:100,hash:null}));
  const stage={schema:RUNNINGHUB_STAGE_SCHEMA,identity:owner,receipt:saved,selection,images:selection.map(row=>({outputKey:row.outputKey,hash:null,
    integrity:{version:1,sizeBytes:100,sha256:'d'.repeat(64),blake3:'e'.repeat(64),platformHash:null,platformVerified:null}}))};
  assert.equal(normalizeComfyCloudStage(stage,owner).selection.length,3);
  assert.throws(()=>normalizeComfyCloudStage({...stage,images:stage.images.slice(0,2)},owner));
  const intent=prepareComfyCloudSubmission(input()).intent;
  const row={namespace:owner.namespace,attemptId:owner.attemptId,requestDigest:saved.requestDigest,ownerId:'process',fence:owner.fence,status:'succeeded',automatic:true,
    createdAt:1000,updatedAt:2000,upstreamId:saved.task.taskId,cloudIntent:intent,cloudReceipt:saved,
    cloudDelivery:{schema:'qianmu.comfy-cloud-delivery.v1',state:'archived',cacheReceipt:'c'.repeat(64),bytes:300,imageCount:3,storedAt:1500,archivedAt:1800}};
  const channel={schema:COMFY_CLOUD_CHANNEL_SCHEMA,channelKey:owner.channelKey,entries:[row]};
  assert.equal(normalizeComfyCloudChannel(channel,owner.channelKey).entries[0].cloudDelivery.imageCount,3);
  row.cloudDelivery.imageCount=2;assert.throws(()=>normalizeComfyCloudChannel(channel,owner.channelKey));
});

for(const channel of ['direct','gateway'])for(const count of [3,8])test(`${channel} submits batch ${count} once and downloads each candidate once`,async()=>{
  const source=input(count),calls=[];source.workflow.latent.inputs.batch_size='%qianmu_count%';
  const request={provider:'comfy',baseUrl:'https://comfy.example',model:'fixture.safetensors',prompt:source.prompt,negativePrompt:source.negativePrompt,
    parameters:{...source.parameters,workflow:source.workflow,count,pollIntervalMs:250,timeoutMs:15000},comfyExecution:policy()};
  const run=channel==='direct'?generateDirectImage:generateImage;
  const result=await run(request,{waitImpl:async()=>{},resolveHost:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async(url,options)=>{
    const parsed=new URL(url);calls.push(parsed.pathname);
    if(parsed.pathname==='/prompt'){assert.equal(JSON.parse(options.body).prompt.latent.inputs.batch_size,count);return new Response(JSON.stringify({prompt_id:'task'}));}
    if(parsed.pathname==='/history/task')return new Response(JSON.stringify({task:{status:{completed:true,status_str:'success'},outputs:{save:{images:Array.from({length:count},(_,index)=>image(index+1))}}}}));
    assert.equal(parsed.pathname,'/view');return new Response(Buffer.from(png,'base64'));
  }});
  assert.equal(result.images.length,count);assert.equal(calls.filter(path=>path==='/prompt').length,1);assert.equal(calls.filter(path=>path==='/view').length,count);
});
