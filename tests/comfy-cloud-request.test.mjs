import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {buildComfyCloudRequest} from '../qianmu-comfy-cloud-request.js';
import {prepareComfyCloudSubmission} from '../qianmu-comfy-cloud-prepare.js';
import {createComfyRecoveryClient} from '../qianmu-comfy-recovery-client.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';
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
