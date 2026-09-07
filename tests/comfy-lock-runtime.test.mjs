import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import * as auto from '../qianmu-comfy-auto-runtime.js';
import {createComfySceneCoordinator} from '../qianmu-comfy-lock-runtime.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {comfySceneScopeKey,changeComfySceneRecord,inspectComfySceneRecord} from '../qianmu-comfy-scene-lock.js';
import {pinComfyRouteWorkflow,readPinnedComfyRouteWorkflow} from '../qianmu-comfy-route.js';
import {checkComfyConfiguration} from '../qianmu-comfy-preflight.js';
import {bindStoryboardPromptRenderings} from '../qianmu-prompt-formats.js';
import {recipesFixture,namespace} from './helpers/comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value)),scope={namespace,chatKey:'chat',continuityId:'program-confirmed-scene',narrativeLayer:'present'};
function memoryStore(){
  const records=new Map(),calls=[];let afterWrite=()=>{};
  const inspect=async scope=>({...inspectComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,100),generation:0});
  const write=async(scope,action)=>{calls.push(action.type);const result=changeComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,action,100);records.set(comfySceneScopeKey(scope),result.row);afterWrite(action.type);return {view:await inspect(scope),receipt:result.receipt};};
  return {records,calls,inspect,setAfterWrite:value=>afterWrite=value,
    reserve:(scope,request)=>write(scope,{...request,type:'reserve'}),begin:receipt=>write(receipt.scope,{type:'begin',receipt}),
    settle:(receipt,outcome)=>write(receipt.scope,{type:'settle',receipt,outcome}),unlock:(scope,request)=>write(scope,{...request,type:'unlock'}),close:()=>calls.push('close')};
}
async function fixture(){
  const f=await recipesFixture({formats:['tags','natural_language']});f.rows.forEach((row,index)=>Object.assign(row.document.classification,{visualKinds:[index?'environment':'character']}));
  const recipes=await Promise.all(f.rows.map(selection=>pinComfyRouteWorkflow({namespace,selection,createStore:f.createStore})));
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'pool',revision:'v1',enabled:false,styleLock:true,candidates:recipes.map((recipe,index)=>({id:`candidate-${index}`,enabled:true,target:{...f.routes[index],comfyWorkflowBinding:recipe.binding},classification:recipe.document.classification}))});
  const row={namespace,id:pool.id,revision:pool.revision,version:1,name:'Pool',archived:false,pool},createStore=()=>({list:async()=>[copy(row)],versions:async()=>[copy(row)],load:async()=>copy(row),close(){}});
  const binding=(await auto.pinComfyAutoPool({namespace,selection:row,createStore})).binding;
  const prepared=await auto.prepareComfyAutoSession({namespace,binding,createStore,readRecipe:options=>readPinnedComfyRouteWorkflow({...options,createStore:f.createStore})});
  const store=memoryStore();let account=namespace;
  const manager=createComfySceneCoordinator({store,resolveNamespace:async()=>account,ownerId:'page-a',locks:fakeWebLocks()});
  const probe=async({recipe})=>({automaticEligible:checkComfyConfiguration({workflow:recipe.document.workflow,parameters:{...recipe.document.parameters,count:1},model:'comfy-workflow',outputNodeId:'save',automatic:true}).localConfigurationReady});
  const makeShot=async(kind='character')=>{
    const shot=core.normalizeStoryboardShotSpec({id:`shot-${kind}`,subject:kind,subjectKind:kind,sensitive:false,characters:[]});
    shot.promptRenderingPack=await bindStoryboardPromptRenderings(shot,{tags:{global:kind,characters:[],negative:''},natural_language:{global:`A ${kind} image.`,characters:[],negative:''}});return shot;
  };
  const makeJob=(choice,shot,id)=>({id,source:'comfy',chatKey:'chat',planId:'plan',planShotId:id,automatic:true,target:'gallery',
    profile:{...prepared.apply(choice.target,core.createStoryboardDefaults().profiles.comfy),model:'comfy-workflow',capabilityModelId:'comfy-workflow',count:'1'},
    connection:{baseUrl:'https://comfy.test',id:'',comfyTransport:'browser'},shotSpec:copy(shot),payload:{prompt:'preview',shotSpec:copy(shot),parameters:{count:1}}});
  return {prepared,store,manager,probe,makeShot,makeJob,setAccount:value=>account=value,close:async()=>{prepared.close();await manager.close();}};
}
test('one batch proposes one style, attaches checked original facts, then reserves only immediately before admission',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
  try{
    const a=await e.makeShot(),b=await e.makeShot('environment'),first=await batch.choose(a,scope),second=await batch.choose(b,scope);
    assert.equal(first.candidateId,'candidate-0');assert.equal(second.candidateId,'candidate-0');assert.equal(second.reason,'scene_locked');assert.equal(e.store.calls.length,0);
    const j1=e.makeJob(first,a,'j1'),j2=e.makeJob(second,b,'j2');await batch.attach(j1,first);await batch.attach(j2,second);
    assert.equal(j1.comfySceneClaim,true);assert.doesNotMatch(JSON.stringify(j1),/comfySceneClaim|token-a|ownerId/);
    await e.manager.reserve(j1);await e.manager.beforeSubmit(j1);await e.manager.reserve(j2);
    assert.equal((await e.store.inspect(scope)).pending,2);assert.equal((await e.store.inspect(scope)).lock.candidateId,'candidate-0');
    batch.close();await e.manager.beforeSubmit(j2);await e.manager.settle(j1,'succeeded');await e.manager.settle(j2,'not_submitted');
    const done=await e.store.inspect(scope);assert.equal(done.established,true);assert.equal(done.pending,0);
  }finally{batch.close();await e.close();}
});
test('closed local preparation, copied choices and altered character facts or routes cannot acquire claims',async()=>{
  for(const action of ['copy','facts','route','chat','closed']){
    const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'j');
    if(action==='facts')job.shotSpec.subject='changed';if(action==='route')job.profile.comfyCharacterEnabled=true;if(action==='chat')job.chatKey='other';if(action==='closed')batch.close();
    try{await assert.rejects(()=>batch.attach(job,action==='copy'?copy(choice):choice));assert.equal(e.store.calls.length,0);}finally{batch.close();await e.close();}
  }
});
test('an explicit unlock between selection and queueing invalidates the batch instead of relocking silently',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
  try{
    const shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'j');await batch.attach(job,choice);
    await e.manager.unlock(scope,await e.manager.inspect(scope));
    await assert.rejects(()=>e.manager.reserve(job),/已变化/);assert.equal((await e.store.inspect(scope)).lock,null);
  }finally{batch.close();await e.close();}
});
test('post-reservation cancellation can release a known unsubmitted claim but cannot regress an unknown attempt',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
  try{
    const shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'j');await batch.attach(job,choice);let valid=true;
    e.store.setAfterWrite(type=>{if(type==='reserve')valid=false;});await assert.rejects(()=>e.manager.reserve(job,()=>valid),/已结束/);e.store.setAfterWrite(()=>{});
    await e.manager.settle(job,'not_submitted');assert.equal((await e.store.inspect(scope)).lock,null);
    const second=await batch.choose(shot,scope),next=e.makeJob(second,shot,'next');await batch.attach(next,second);await e.manager.reserve(next);await e.manager.beforeSubmit(next);await e.manager.settle(next,'unknown');
    await assert.rejects(()=>e.manager.settle(next,'not_submitted'),/结果未明/);assert.equal((await e.store.inspect(scope)).uncertain,1);
  }finally{batch.close();await e.close();}
});
test('account or frozen job changes block pre-submit; disposing records a begun claim as unknown, not released',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'j');
  await batch.attach(job,choice);await e.manager.reserve(job);job.profile.steps='99';await assert.rejects(()=>e.manager.beforeSubmit(job),/已结束/);job.profile.steps=String(e.prepared.apply(choice.target,{}).steps);
  await e.manager.beforeSubmit(job);e.setAccount('st-user:other');await assert.rejects(()=>e.manager.beforeSubmit(job),/账户/);batch.close();await e.close();
  assert.equal((await e.store.inspect(scope)).uncertain,1);assert.equal(e.store.calls.at(-1),'close');
});
test('style lock off bypasses lock storage without granting execution; absent confirmed scope cannot bypass a requested lock',async()=>{
  const e=await fixture();
  try{
    const batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),shot=await e.makeShot();await assert.rejects(()=>batch.choose(shot,null));batch.close();
    const noLock={...e.prepared,styleLock:false,select:async options=>({...await e.prepared.select(options),proposedLock:null})};
    const plain=e.manager.createBatch({prepared:noLock,probe:e.probe}),choice=await plain.choose(shot,null);assert.equal(choice.executionAuthorized,false);
    assert.equal(await plain.attach(e.makeJob(choice,shot,'no-lock'),choice),false);assert.equal(e.store.calls.length,0);plain.close();
  }finally{await e.close();}
});

test('an account change still settles this runtime own frozen unsubmitted claims without granting a new operation',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'old-account');
  try{
    await batch.attach(job,choice);await e.manager.reserve(job);e.setAccount('st-user:other');
    await assert.rejects(()=>e.manager.beforeSubmit(job),/账户/);await e.manager.settle(job,'not_submitted');assert.equal((await e.store.inspect(scope)).lock,null);
    await assert.rejects(()=>e.manager.inspect(scope),/账户/);
  }finally{batch.close();await e.close();}
});

test('actual queue acquires the scene after technical confirmation and releases it if image admission fails',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'queue');await batch.attach(job,choice);
  const state=core.createStoryboardDefaults();state.enabled=true;let submitted=0,admissions=0;
  const context=vm.createContext({...core,storyboardState:()=>state,getChatKey:()=>scope.chatKey,storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:10,
    storyboardConfirmComfyExecution:async()=>{assert.equal(e.store.calls.length,0);return true;},storyboardComfySceneRuntime:async()=>e.manager,
    storyboardImageAdmissionRuntime:async()=>({admit:async()=>{admissions++;assert.equal((await e.store.inspect(scope)).pending,1);throw Error('admission denied');}}),
    storyboardSettleImageAdmission:(job,outcome)=>e.manager.settle(job,outcome),storyboardGalleryRecords:()=>[],toast:()=>false,
    storyboardPumpQueue:()=>submitted++});
  vm.runInContext([section('storyboardParseWorkflow'),section('storyboardQueueJob')].join('\n'),context);job.payload.parameters.workflow=JSON.parse(job.profile.comfyWorkflow);
  try{assert.equal(await context.storyboardQueueJob(job),false);assert.equal(admissions,1);assert.equal(submitted,0);assert.equal((await e.store.inspect(scope)).lock,null);}finally{batch.close();await e.close();}
});
test('actual final callback reaches scene begin after image and channel gates and blocks a lost claim before marking submission unknown',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),shot=await e.makeShot(),choice=await batch.choose(shot,scope),job=e.makeJob(choice,shot,'submit');await batch.attach(job,choice);await e.manager.reserve(job);
  const state=core.createStoryboardDefaults();state.enabled=true;const events=[];
  const context=vm.createContext({...core,job,log:{},admissionOutcome:'not_submitted',storyboardState:()=>state,storyboardValidatedAnchor:()=>({valid:true}),
    storyboardPrepareComfyPromptJob:async()=>{},storyboardAdmission:{beforeSubmit:async()=>events.push('image')},channelTicket:{beforeSubmit:async()=>events.push('channel')},
    storyboardComfySceneRuntime:async()=>({beforeSubmit:async(...args)=>{events.push('scene');return e.manager.beforeSubmit(...args);}}),saveSettings:()=>{}});
  const source=section('storyboardRunJob'),start=source.indexOf('  const beforeSubmit = async () => {'),end=source.indexOf('\n  };\n  try {',start)+5;
  vm.runInContext(`${source.slice(start,end)}\nglobalThis.submit=beforeSubmit;`,context);
  try{await context.submit();assert.deepEqual(events,['image','channel','scene']);assert.equal(job.submissionState,'unknown');
    await e.manager.settle(job,'not_submitted');delete job.submissionState;await assert.rejects(()=>context.submit(),/预留已失效/);assert.equal(job.submissionState,undefined);
  }finally{batch.close();await e.close();}
});
