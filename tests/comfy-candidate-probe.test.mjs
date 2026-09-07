import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as auto from '../qianmu-comfy-auto-runtime.js';
import * as routes from '../qianmu-comfy-route.js';
import * as prompts from '../qianmu-comfy-prompt.js';
import * as direct from '../qianmu-image-direct.js';
import {checkComfyCharacterReadiness} from '../qianmu-comfy-character-readiness.js';
import {bindStoryboardPromptRenderings} from '../qianmu-prompt-formats.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {routeEnvironment,namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const definitions={
  CLIPTextEncode:{input:{required:{text:['STRING']}},output:['CONDITIONING']},
  EmptyImage:{input:{required:{width:['INT'],height:['INT'],batch_size:['INT']}},output:['IMAGE']},
  SaveImage:{input:{required:{images:['IMAGE']}},output:[],output_node:true},
  CheckpointLoaderSimple:{input:{required:{ckpt_name:[['installed.safetensors']]}},output:['MODEL','CLIP','VAE']},
};
async function environment(){
  const e=await routeEnvironment({formats:['tags','natural_language']}),network=[],keys=[],jobs=[],trust=[];
  let missing='',warning=false,trustError='',afterRequest=async()=>{};
  e.rows.forEach((row,index)=>Object.assign(row.document.classification,{visualKinds:[index?'environment':'character']}));
  const recipes=await Promise.all(e.rows.map(selection=>routes.pinComfyRouteWorkflow({namespace,selection,createStore:e.createStore})));
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'pool',revision:'v1',enabled:false,styleLock:true,
    candidates:recipes.map((recipe,index)=>({id:`candidate-${index}`,enabled:true,priority:0,target:{...e.routes[index],comfyWorkflowBinding:recipe.binding},classification:recipe.document.classification}))});
  const row={namespace,id:pool.id,revision:pool.revision,version:1,name:'QA pool',archived:false,pool};
  const createStore=()=>({list:async()=>[copy(row)],versions:async()=>[copy(row)],load:async()=>copy(row),close(){}});
  e.state.comfyPoolSelection=(await auto.pinComfyAutoPool({namespace,selection:row,createStore})).binding;
  e.state.connections.comfy.draft.baseUrl='https://comfy.test/api';
  e.state.connections.comfy.draft.options.comfyTransport='browser';
  const load=e.context.featureRuntime.load;
  Object.assign(e.context,{directImageRuntime:async()=>direct,storyboardResolveApiKey:async(...args)=>{keys.push(args);return 'SECRET';},storyboardRequestHeaders:()=>({'x-csrf-token':'CSRF'}),
    featureRuntime:{load:async key=>{
      if(key==='comfyPrompt')return prompts;
      if(key==='comfyTargets')return {requireTrustedComfyConnection:async(connection,options)=>{trust.push(copy(connection));options.assertCurrent();if(trustError)throw Error(trustError);}};
      if(key==='comfyCharacterReadiness')return {checkComfyCharacterReadiness:(request,options)=>checkComfyCharacterReadiness(request,{...options,fetchImpl:async(url,init)=>{
        network.push({url,method:init.method});await afterRequest();
        if(init.method==='POST')return new Response(JSON.stringify({ok:true,schemaVersion:1,errors:0,warnings:warning?1:0,ready:!warning,actualGenerationVerified:false,issues:[]}));
        const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1)),value=copy(definitions[name]);
        if(warning&&name==='EmptyImage')value.input.required.width=[['dynamic',{}]];
        return new Response(JSON.stringify(name===missing?{}:{[name]:value}));
      }})};
      return load(key);
    }}});
  vm.runInContext(['storyboardParseWorkflow','storyboardGatewayRequest','storyboardPrepareComfyPromptJob','storyboardCheckComfyJobReadiness','storyboardConfirmComfyExecution','storyboardProbeComfyCandidate'].map(section).join('\n'),e.context);
  const create=e.context.storyboardCreateJob;e.context.storyboardCreateJob=(...args)=>{const job=create(...args);jobs.push(job);return job;};
  const inputGuard=e.context.storyboardCreatePreparationGuard(e.state);
  const session=await auto.prepareComfyAutoSession({namespace,binding:e.state.comfyPoolSelection,createStore,guard:async()=>inputGuard.assertCurrent(),
    readRecipe:options=>routes.readPinnedComfyRouteWorkflow({...options,createStore:e.createStore})});
  const shot=core.normalizeStoryboardShotSpec({id:'shot',subject:'Alice reads',subjectKind:'character',characters:[{id:'alice',name:'Alice',identity:['silver hair']}],sensitive:false});
  shot.promptRenderingPack=await bindStoryboardPromptRenderings(shot,{tags:{global:'morning light',characters:[{character_id:'alice',positive:'silver hair, reading'}],negative:''},natural_language:{global:'Morning light.',characters:[{character_id:'alice',positive:'Alice has silver hair and reads.'}],negative:''}});
  return {...e,session,shot,recipes,network,keys,jobs,trust,inputGuard,pool,
    probe:options=>e.context.storyboardProbeComfyCandidate(e.state,session,inputGuard,options),
    setMissing:value=>missing=value,setWarning:value=>warning=value,setAfterRequest:value=>afterRequest=value,
    setTrustError:value=>trustError=value,
    close:()=>{session.close();inputGuard.dispose();}};
}

test('candidate evaluation uses actual job construction, fixed prompt compilation and remote definitions without admission or state changes',async()=>{
  const e=await environment(),before=JSON.stringify(e.state),graphs=e.recipes.map(recipe=>recipe.document.workflow);
  try{
    const selected=await e.session.select({shotSpec:e.shot,probe:e.probe});
    assert.equal(selected.status,'selected',JSON.stringify(selected.diagnostics));assert.equal(selected.candidateId,'candidate-0');assert.equal(selected.executionAuthorized,false);
    assert.equal(e.jobs.length,2);assert.equal(e.network.length,6);assert.ok(e.network.every(row=>row.method==='GET'&&new URL(row.url).pathname.startsWith('/api/object_info/')));
    assert.ok(e.keys.every(args=>args[0]==='comfy'&&args[2].exact===true));
    assert.match(e.jobs[0].payload.prompt,/portrait quality.*morning light/s);assert.equal(e.jobs[0].profile.count,'1');assert.equal(e.jobs[0].target,'gallery');assert.equal(e.jobs[0].floor,null);
    assert.equal(e.jobs[0].comfyExecution.automatic,true);assert.equal(e.jobs[0].imageAdmission,undefined);assert.equal(e.jobs[0].logId,undefined);
    assert.equal(JSON.stringify(e.state),before);assert.deepEqual(e.recipes.map(recipe=>recipe.document.workflow),graphs);assert.equal(e.context.storyboardQueue.length,0);
  }finally{e.close();}
});
test('missing nodes exclude automatic candidates and do not ask for manual consent or produce jobs in the queue',async()=>{
  const e=await environment();e.setMissing('EmptyImage');let confirmations=0;e.context.confirmDialog=async()=>{confirmations++;return true;};
  try{const result=await e.session.select({shotSpec:e.shot,probe:e.probe});assert.equal(result.reason,'no_eligible_candidate');assert.match(JSON.stringify(result.diagnostics),/节点|模型/);assert.equal(confirmations,0);assert.equal(e.context.storyboardQueue.length,0);assert.ok(e.jobs.every(job=>!job.comfyExecution));}finally{e.close();}
});
test('fixed source quantity and selected outputs are audited before making any definition request',async()=>{
  const e=await environment();
  try{
    const job={source:'comfy',automatic:true,profile:{model:'comfy-workflow'},connection:{baseUrl:'https://comfy.test',comfyTransport:'browser'},payload:{prompt:'x',parameters:{workflow:{text:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},image:{class_type:'EmptyImage',inputs:{width:512,height:512,batch_size:3}},save:{class_type:'SaveImage',inputs:{images:['image',0]}}},count:1}}};
    await assert.rejects(()=>e.context.storyboardConfirmComfyExecution(job,()=>true),/超过本次约定/);assert.equal(e.network.length,0);assert.equal(e.keys.length,0);
  }finally{e.close();}
});
test('account, credential and document changes discard late definition responses',async()=>{
  for(const change of [e=>e.setAccount('st-user:other'),e=>e.context.storyboardCredentialRevision++,e=>e.state.comfyPoolSelection=null]){
    const e=await environment();let changed=false;e.setAfterRequest(async()=>{if(!changed){changed=true;change(e);}});
    try{await assert.rejects(()=>e.session.select({shotSpec:e.shot,probe:e.probe}),/变化/);assert.equal(e.network.length,1);assert.ok(e.jobs.every(job=>!job.comfyExecution));}finally{e.close();}
  }
});
test('gateway trust is checked with private-network scope before credentials or node requests',async()=>{
  const e=await environment();e.close();
  const job={source:'comfy',automatic:true,profile:{model:'comfy-workflow'},connection:{baseUrl:'http://192.168.1.2:8188',comfyTransport:'gateway',allowPrivateNetwork:true,credentialId:'key'},payload:{prompt:'x',parameters:{workflow:JSON.parse(e.recipes[0].document.workflow),width:832,height:1216,count:1}}};
  e.setTrustError('可信连接未登记');await assert.rejects(()=>e.context.storyboardConfirmComfyExecution(job,()=>true),/未登记/);
  assert.equal(e.trust.length,1);assert.equal(e.trust[0].options.allowPrivateNetwork,true);assert.equal(e.keys.length,0);assert.equal(e.network.length,0);
  e.setTrustError('');assert.equal(await e.context.storyboardConfirmComfyExecution(job,()=>true),true);
  assert.equal(e.network.length,1);assert.equal(e.network[0].url,'/api/plugins/qianmu-tts/image/comfy/readiness');assert.equal(e.network[0].method,'POST');
  assert.equal(job.comfyExecution.automatic,true);
});
test('remote uncertain warnings cannot grant automatic permission; ordinary manual graphs retain their existing path',async()=>{
  const e=await environment();e.close();e.setWarning(true);
  const job={source:'comfy',automatic:true,profile:{model:'comfy-workflow'},connection:{baseUrl:'https://comfy.test',comfyTransport:'gateway'},payload:{prompt:'x',parameters:{workflow:JSON.parse(e.recipes[0].document.workflow),width:832,height:1216,count:1}}};
  await assert.rejects(()=>e.context.storyboardConfirmComfyExecution(job,()=>true),/未验证/);assert.equal(job.comfyExecution,undefined);
  const calls=e.network.length;job.automatic=false;assert.equal(await e.context.storyboardConfirmComfyExecution(job,()=>true),true);assert.equal(e.network.length,calls);
});
test('probe bridge never enqueues, grants persistent locks, calls an LLM or rewrites state',()=>{
  const source=section('storyboardProbeComfyCandidate');assert.doesNotMatch(source,/storyboardQueueJob|storyboardCallCompiler|saveSettings|\.admit\(|\.push\(|\.proposedLock/);
  const readiness=section('storyboardCheckComfyJobReadiness');assert.doesNotMatch(readiness,/generateDirectImage|upload\/image|\/prompt/);
  assert.match(section('storyboardCreatePreparationGuard'),/comfyPoolSelection: state\.comfyPoolSelection/);
});

test('actual queue blocks missing installed nodes before durable admission and does not cache a successful check',async()=>{
  const e=await environment();e.close();let admitted=0;
  Object.assign(e.context,{storyboardImageAdmissionRuntime:async()=>({admit:async()=>{admitted++;}}),storyboardGalleryRecords:()=>[],
    storyboardStartLog:()=>({id:'log'}),storyboardPlanForJob:()=>null,storyboardSetPlanStatus:()=>{},storyboardPumpQueue:()=>{},storyboardSettleImageAdmission:async()=>{}});
  vm.runInContext(section('storyboardQueueJob'),e.context);
  const create=()=>({source:'comfy',automatic:true,target:'gallery',profile:{model:'comfy-workflow'},connection:{baseUrl:'https://comfy.test',comfyTransport:'browser'},payload:{prompt:'x',parameters:{workflow:JSON.parse(e.recipes[0].document.workflow),width:832,height:1216,count:1}}});
  assert.equal(await e.context.storyboardQueueJob(create()),true);assert.equal(admitted,1);const requests=e.network.length;
  e.setMissing('EmptyImage');assert.equal(await e.context.storyboardQueueJob(create()),false);assert.equal(admitted,1);assert.equal(e.context.storyboardQueue.length,1);assert.ok(e.network.length>requests);
});

test('available node classes cannot hide an unavailable checkpoint model',async()=>{
  const e=await environment();e.close();
  const workflow=JSON.parse(e.recipes[0].document.workflow);workflow.base={class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'missing.safetensors'}};
  const job={source:'comfy',automatic:true,profile:{model:'comfy-workflow'},connection:{baseUrl:'https://comfy.test',comfyTransport:'browser'},payload:{prompt:'x',parameters:{workflow,width:832,height:1216,count:1}}};
  await assert.rejects(()=>e.context.storyboardConfirmComfyExecution(job,()=>true),/ckpt_name|模型|清单/);assert.equal(job.comfyExecution,undefined);
  workflow.base.inputs.ckpt_name='installed.safetensors';assert.equal(await e.context.storyboardConfirmComfyExecution(job,()=>true),true);
  assert.ok(e.network.every(row=>row.method==='GET'));assert.equal(job.comfyExecution.automatic,true);
});
