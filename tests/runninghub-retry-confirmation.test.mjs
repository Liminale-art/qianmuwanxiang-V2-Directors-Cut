import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as runtime from '../qianmu-image-direct.js';
import {confirmRunningHubRetryExecution} from '../qianmu-comfy-workbench.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {stillInput} from './helpers/runninghub-validation-fixture.mjs';
import {buildComfyCloudRequest} from '../qianmu-comfy-cloud-request.js';
import {prepareComfyCloudSubmission} from '../qianmu-comfy-cloud-prepare.js';
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture({tier,choice={instanceType:'default'},change,baseUrl='https://www.runninghub.cn'}={}){
  const graph=stillInput().workflow;graph.model.inputs.ckpt_name='synthetic.safetensors';
  const account='st-user:retry',profile={model:'comfy-workflow',seed:123,count:1,...(tier!==undefined?{comfyInstanceType:tier}:{})};
  const log={id:'old',source:'comfy',status:'failed',submissionState:'unknown',snapshot:{source:'comfy',target:'gallery',chatKey:'a',imageAccountNamespace:account,
    profile,payload:{prompt:'keep exact prompt',negative:'keep exact negative',parameters:{workflow:graph,seed:123,count:1,width:512,height:512}},connection:{baseUrl,comfyTransport:'browser',credentialId:'original'}}};
  const state={enabled:true,logs:[log]},e={log,state,job:null,chat:'a',account,choices:[],admissions:0,queued:[],notices:[],stored:[]};let serial=0;
  const c=vm.createContext({...core,clone:structuredClone,uid:()=>String(++serial),ctx:()=>({}),appearanceSession:{mountPortal:()=>()=>{}},
    storyboardState:()=>state,getChatKey:()=>e.chat,resolveImageAccountNamespace:async()=>e.account,storyboardGalleryRecords:()=>[],galleryMembershipSnapshot:()=>({}),
    storyboardQueue:e.queued,storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:8,storyboardQueueSettling:0,
    storyboardQueueWindow:{has:()=>false,reservedCount:0,notify:()=>{}},storyboardValidatedAnchor:()=>({valid:true}),getStoryboardGenerationPolicy:()=>({maxImages:1}),
    resolveStoryboardJobModelIdentity:()=>({modelFamily:'comfy',remoteModelId:'comfy-workflow',protocol:'comfy'}),resolveStoryboardConnectionBinding:()=>({}),
    directImageRuntime:async()=>runtime,storyboardComfyReferenceMetadata:async()=>[],storyboardParseWorkflow:value=>value,
    featureRuntime:{load:async key=>{assert.equal(key,'comfyWorkbench');return {confirmRunningHubRetryExecution:async options=>{e.choices.push(options);change?.(e,c);return choice;}};}},
    storyboardImageAdmissionRuntime:async()=>({admit:async(job,{valid})=>{e.admissions++;if(!valid()||job.imageAccountNamespace!==e.account)throw Error('账户或聊天已变化');job.imageAdmission={version:1,namespace:e.account,attemptId:job.id};}}),
    storyboardStoreLog:(log,pipeline)=>{e.stored.push(plain(log));state.logs.unshift(log);return log;},
    storyboardPlanForJob:()=>null,storyboardSetPlanStatus:()=>{},saveSettings:()=>{},renderModal:()=>{},storyboardPumpQueue:()=>{},
    storyboardSettleImageAdmission:async()=>{},toast:message=>{e.notices.push(message);return false;},confirmDialog:async()=>{throw Error('unexpected second confirmation');},
    storyboardCheckComfyJobReadiness:async()=>({}),storyboardLoadLogToWorkbench:()=>{},storyboardAdmissionEpoch:0,storyboardCredentialRevision:0});
  vm.runInContext(['storyboardJobFromLog','storyboardRetryLog','storyboardGatewayRequest','storyboardConfirmComfyExecution','storyboardQueueJob','storyboardStartLog'].map(section).join('\n'),c);
  const make=c.storyboardJobFromLog;c.storyboardJobFromLog=log=>(e.job=make(log));e.c=c;e.run=()=>c.storyboardRetryLog(log);return e;
}
for(const tier of [undefined,'','default','plus','ultra'])test(`manual retry retains original ${String(tier)} until explicit confirmation and changes only new snapshot tier`,async()=>{
  const e=fixture({tier}),before=plain(e.log);assert.equal(await e.run(),true,JSON.stringify(e.notices));
  assert.equal(e.choices.length,1);assert.equal(e.choices[0].instanceType,tier);assert.match(e.choices[0].text,/保存 1 张，接收 1 张/);
  assert.equal(e.admissions,1);assert.equal(e.queued.length,1);assert.deepEqual(plain(e.log),before);
  assert.equal(e.job.profile.comfyInstanceType,'default');assert.equal(e.stored[0].snapshot.profile.comfyInstanceType,'default');
  assert.deepEqual(plain(e.job.payload),before.snapshot.payload);assert.equal(e.job.profile.seed,123);assert.deepEqual(plain(e.job.connection),before.snapshot.connection);
  assert.equal(Object.keys(e.job).includes('comfyRetryReview'),false);assert.equal('comfyRetryReview' in e.stored[0].snapshot,false);
  const request=buildComfyCloudRequest(e.job,e.c.storyboardGatewayRequest(e.job,'synthetic',{references:[],vibes:[]}),stillInput().connection);
  assert.equal(prepareComfyCloudSubmission(request).body.instanceType,'default');
});
test('unchanged plus and unspecified platform-default are not rewritten; invalid selections and cancel never admit',async()=>{
  for(const [tier,choice] of [['plus',{instanceType:'plus'}],[undefined,{instanceType:''}],['',{instanceType:''}]]){
    const e=fixture({tier,choice});assert.equal(await e.run(),true);assert.equal(e.job.profile.comfyInstanceType,tier);assert.deepEqual(plain(e.job.profile),plain(e.log.snapshot.profile));
  }
  for(const choice of [null,false,{instanceType:'pro'},{instanceType:null},{}]){
    const e=fixture({choice}),before=plain(e.log);assert.equal(await e.run(),false);assert.equal(e.choices.length,1);assert.equal(e.admissions,0);assert.equal(e.queued.length,0);assert.deepEqual(plain(e.log),before);
  }
});
for(const [name,change] of Object.entries({prompt:e=>e.job.payload.prompt='changed',workflow:e=>e.job.payload.parameters.workflow.latent.inputs.width=2048,
  seed:e=>e.job.profile.seed=999,output:e=>e.job.profile.comfyOutputNodeId='other',connection:e=>e.job.connection.credentialId='other',automatic:e=>e.job.automatic=true,
  tier:e=>e.job.profile.comfyInstanceType='ultra',snapshot:e=>e.log.snapshot.profile.seed=3,chat:e=>e.chat='b',disabled:e=>e.state.enabled=false,
  removed:e=>e.state.logs=[],state:(e,c)=>c.storyboardState=()=>({enabled:true,logs:[e.log]})}))test(`confirmation cannot accept concurrent ${name} changes alongside an approved tier`,async()=>{
  const e=fixture({change});assert.equal(await e.run(),false);assert.equal(e.choices.length,1);assert.equal(e.admissions,0);assert.equal(e.queued.length,0);
});
test('account guard remains after the choice; foreign origins stop before choice, other providers and automatic RH do not use it',async()=>{
  const changed=fixture({change:e=>e.account='other'});assert.equal(await changed.run(),false);assert.equal(changed.queued.length,0);
  const foreign=fixture();foreign.account='other';assert.equal(await foreign.run(),false);assert.equal(foreign.choices.length,0);
  for(const baseUrl of ['https://cloud.comfy.org','https://comfy.example']){const e=fixture({baseUrl});assert.equal(await e.run(),true,JSON.stringify(e.notices));assert.equal(e.choices.length,0);}
  const auto=fixture(),job=auto.c.storyboardJobFromLog(auto.log);job.automatic=true;Object.defineProperty(job,'comfyRetryReview',{value:true});
  assert.equal(await auto.c.storyboardConfirmComfyExecution(job,()=>true),true);assert.equal(auto.choices.length,0);
});

function popupFixture({instanceType,result=1,selected,stale=false,reject=false}={}){
  const select={value:''},status={textContent:''};let markup='',options,mounts=0,releases=0,shown=0,current=true;
  const wrap={className:'',set innerHTML(value){markup=value;select.value=/<option value="([^"]*)" selected>/.exec(value)?.[1]??'';},querySelector:selector=>selector==='select'?select:status};
  const Popup=class{constructor(_wrap,_type,_value,opts){options=opts;this.dlg={isConnected:true,classList:{add(){}}};}async show(){shown++;if(selected!==undefined)select.value=selected;if(stale)current=false;if(reject)throw Error('cancelled');this.result=result;options.onClosing(this);return result;}};
  return {run:()=>confirmRunningHubRetryExecution({context:{Popup,POPUP_TYPE:{CONFIRM:1}},instanceType,text:'保存 1 张\n<unsafe>',document:{createElement:()=>wrap},isCurrent:()=>current,
    mountAppearance:()=>{mounts++;return()=>releases++;}}),get markup(){return markup;},get shown(){return shown;},get counts(){return [mounts,releases];},status};
}
test('real confirmation UI keeps platform-default distinct, supports explicit tiers and pairs theme mount/release',async()=>{
  for(const initial of [undefined,'','default','plus','ultra']){
    const f=popupFixture({instanceType:initial});assert.deepEqual(await f.run(),{instanceType:initial??''});assert.match(f.markup,/本次运行配置/);assert.match(f.markup,/平台默认不等于标准/);assert.doesNotMatch(f.markup,/<unsafe>/);assert.deepEqual(f.counts,[1,1]);assert.equal(f.shown,1);
  }
  const changed=popupFixture({instanceType:'',selected:'default'});assert.deepEqual(await changed.run(),{instanceType:'default'});
  for(const instanceType of [null,false,{},'[invalid]']){const f=popupFixture({instanceType});assert.equal(await f.run(),null);assert.match(f.markup,/运行配置待核对/);assert.match(f.status.textContent,/有效/);}
});
test('popup cancellation, rejected host result and stale page never fall back or return a runtime choice',async()=>{
  for(const options of [{result:0},{result:-1},{result:'unconfirmed'},{result:false},{result:null},{reject:true},{stale:true}]){
    const f=popupFixture(options);assert.equal(await f.run(),null);assert.equal(f.shown,1);assert.deepEqual(f.counts,[1,1]);
  }
});
