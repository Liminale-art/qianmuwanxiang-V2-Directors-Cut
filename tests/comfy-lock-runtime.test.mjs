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
import {captureComfySceneStyleLink,copyComfySceneStyleRecord} from '../qianmu-comfy-scene-lock.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
import {normalizeComfySceneOrigin,retainComfySceneOrigin} from '../qianmu-comfy-route-contract.js';
const copy=value=>JSON.parse(JSON.stringify(value)),scope={namespace,chatKey:'chat',continuityId:'program-confirmed-scene',narrativeLayer:'present'};
function memoryStore(){
  const records=new Map(),calls=[];let afterWrite=()=>{};
  const inspect=async scope=>({...inspectComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,100),generation:0});
  const write=async(scope,action)=>{calls.push(action.type);const result=changeComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,action,100);records.set(comfySceneScopeKey(scope),result.row);afterWrite(action.type);return {view:await inspect(scope),receipt:result.receipt};};
  return {records,calls,inspect,setAfterWrite:value=>afterWrite=value,
    linkStyle:async(sourceScope,targetScope,request)=>{const result=copyComfySceneStyleRecord(records.get(comfySceneScopeKey(sourceScope)),records.get(comfySceneScopeKey(targetScope)),captureComfySceneStyleLink(sourceScope,targetScope,request),100);records.set(comfySceneScopeKey(targetScope),result.row);return {view:await inspect(targetScope)};},
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

test('historical provenance survives snapshot normalization but restores a fresh claim and never a historical receipt',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
  try{
    const shot=await e.makeShot(),choice=await batch.choose(shot,scope),original=e.makeJob(choice,shot,'original');await batch.attach(original,choice);
    await e.manager.reserve(original);await e.manager.beforeSubmit(original);await e.manager.settle(original,'succeeded');
    const saved=core.sanitizeStoryboardSnapshot(original),before=JSON.stringify(saved);
    assert.deepEqual(saved.comfySceneOrigin,original.comfySceneOrigin);assert.equal(saved.comfySceneClaim,undefined);
    const job={...copy(saved),id:'retry',automatic:false};assert.equal(await e.manager.restore(job), 'linked');
    await assert.rejects(()=>e.manager.beforeSubmit(job),/尚未取得/);
    await e.manager.reserve(job);await e.manager.beforeSubmit(job);await e.manager.settle(job,'succeeded');
    assert.equal((await e.manager.inspect(scope)).pending,0);assert.equal(JSON.stringify(saved),before);
    assert.equal(e.store.calls.filter(x=>x==='reserve').length,2);assert.equal(job.comfySceneClaim,true);
  }finally{batch.close();await e.close();}
});

test('released scene requires explicit independent redraw confirmation and never silently relocks or changes the original',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
  try{
    const shot=await e.makeShot(),choice=await batch.choose(shot,scope),original=e.makeJob(choice,shot,'original');await batch.attach(original,choice);
    const saved=core.sanitizeStoryboardSnapshot(original),before=JSON.stringify(saved),calls=e.store.calls.length;
    const cancelled={...copy(saved),id:'cancelled',automatic:false};let confirmations=0;
    assert.equal(await e.manager.restore(cancelled,{confirmIndependent:async()=>{confirmations++;return false;}}),'cancelled');
    assert.equal(cancelled.comfySceneOrigin.mode,'scene');assert.equal(cancelled.comfySceneClaim,undefined);
    const variant={...copy(saved),id:'variant',automatic:false};
    assert.equal(await e.manager.restore(variant,{confirmIndependent:async()=>{confirmations++;return true;}}),'independent');
    assert.equal(variant.comfySceneOrigin.mode,'independent');assert.equal(variant.comfySceneClaim,undefined);assert.equal(e.store.calls.length,calls);
    assert.equal((await e.manager.inspect(scope)).lock,null);assert.equal(JSON.stringify(saved),before);assert.equal(confirmations,2);
    const repeat={...core.sanitizeStoryboardSnapshot(variant),id:'repeat',automatic:false};
    assert.equal(await e.manager.restore(repeat,{confirmIndependent:async()=>{throw Error('already independent');}}),'independent');
    await assert.rejects(()=>e.manager.reserve(repeat),/预留已失效/);
  }finally{batch.close();await e.close();}
});

test('confirmation races and historical account, narrative, fact or recipe mismatches never acquire a scene claim',async()=>{
  for(const mutation of ['account','layer','facts','recipe','source','automatic','metadata','confirmation-race']){
    const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
    try{
      const shot=await e.makeShot(),choice=await batch.choose(shot,scope),original=e.makeJob(choice,shot,'original');await batch.attach(original,choice);
      const job={...core.sanitizeStoryboardSnapshot(original),id:'retry',automatic:false};
      if(mutation==='account')e.setAccount('st-user:other');if(mutation==='layer')job.shotSpec.narrativeLayer='memory';
      if(mutation==='facts')job.shotSpec.subject='changed';if(mutation==='recipe')job.profile.comfyRouteBinding.namespace='st-user:other';
      if(mutation==='source')job.source='novel';if(mutation==='automatic')job.automatic=true;if(mutation==='metadata')job.comfySceneOrigin=null;
      await assert.rejects(()=>e.manager.restore(job,{confirmIndependent:async()=>{
        if(mutation==='confirmation-race')await e.manager.unlock(scope,await e.manager.inspect(scope));return true;
      }}),undefined,mutation);
      assert.equal(job.comfySceneClaim,undefined);assert.equal(e.store.calls.filter(x=>x==='reserve').length,0);
    }finally{batch.close();await e.close();}
  }
});

test('origin contract whitelists bounded metadata and keeps malformed-present data distinct from legacy absence',async()=>{
  const origin={version:1,mode:'scene',scope,poolKey:'a'.repeat(64),candidateId:'first',executionKey:'b'.repeat(64),connectionPresetId:'',sourceHash:'c'.repeat(64)};
  const dirty={...origin,ownerId:'secret-owner',receipt:{token:'permit'},workflow:'huge graph',scope:{...scope,token:'scope permit'}};
  assert.deepEqual(normalizeComfySceneOrigin(dirty),origin);
  assert.deepEqual(core.sanitizeStoryboardSnapshot({source:'comfy',comfySceneOrigin:dirty,comfySceneClaim:true}).comfySceneOrigin,origin);
  for(const bad of [null,{}, {...origin,version:2},{...origin,sourceHash:''},{...origin,scope:{...scope,chatKey:'x'.repeat(513)}},{...origin,mode:'automatic'}]){
    assert.deepEqual(retainComfySceneOrigin(bad),{invalid:true});assert.deepEqual(core.sanitizeStoryboardSnapshot({comfySceneOrigin:bad}).comfySceneOrigin,{invalid:true});
  }
  const e=await fixture();try{assert.equal(await e.manager.restore({source:'comfy'}),'legacy');assert.equal(e.store.calls.length,0);}finally{await e.close();}
});

test('valid edited character facts or implementation can be independently redrawn without overwriting the original scene style',async()=>{
  for(const change of ['facts','implementation']){
    const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
    try{
      const shot=await e.makeShot(),choice=await batch.choose(shot,scope),original=e.makeJob(choice,shot,'original');await batch.attach(original,choice);
      await e.manager.reserve(original);await e.manager.beforeSubmit(original);await e.manager.settle(original,'succeeded');
      const job={...core.sanitizeStoryboardSnapshot(original),id:'edit',automatic:false},before=JSON.stringify(await e.manager.inspect(scope));
      if(change==='facts'){
        job.shotSpec.subject='revised composition';job.shotSpec.promptRenderingPack=await bindStoryboardPromptRenderings(job.shotSpec,
          {tags:{global:'revised',characters:[],negative:''},natural_language:{global:'Revised composition.',characters:[],negative:''}});
      }else job.profile.comfyCharacterEnabled=true;
      let confirmed=0;assert.equal(await e.manager.restore(job,{confirmIndependent:async()=>{confirmed++;return true;}}),'independent');
      assert.equal(confirmed,1);assert.equal(job.comfySceneClaim,undefined);assert.equal(JSON.stringify(await e.manager.inspect(scope)),before);
      assert.equal(original.comfySceneOrigin.mode,'scene');assert.equal(job.comfySceneOrigin.sourceHash,original.comfySceneOrigin.sourceHash);
    }finally{batch.close();await e.close();}
  }
});

test('a restored claim rechecks current revision and origin at reservation instead of trusting the displayed source',async()=>{
  for(const change of ['unlock','origin']){
    const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe});
    try{
      const shot=await e.makeShot(),choice=await batch.choose(shot,scope),first=e.makeJob(choice,shot,'first');await batch.attach(first,choice);
      await e.manager.reserve(first);await e.manager.beforeSubmit(first);await e.manager.settle(first,'succeeded');
      const job={...core.sanitizeStoryboardSnapshot(first),id:'retry',automatic:false};assert.equal(await e.manager.restore(job),'linked');
      if(change==='unlock')await e.manager.unlock(scope,await e.manager.inspect(scope));else job.comfySceneOrigin.mode='independent';
      await assert.rejects(()=>e.manager.reserve(job));assert.equal(e.store.calls.filter(x=>x==='reserve').length,1);
    }finally{batch.close();await e.close();}
  }
});
test('explicit cross-floor style is consumed by the actual selector and claims, not treated as a passed technical check',async()=>{
  const e=await fixture(),batch=e.manager.createBatch({prepared:e.prepared,probe:e.probe}),targetScope={...scope,continuityId:'next-floor'};
  try{
    const firstShot=await e.makeShot(),choice=await batch.choose(firstShot,scope),first=e.makeJob(choice,firstShot,'source');first.floor=1;
    await batch.attach(first,choice);await e.manager.reserve(first);await e.manager.beforeSubmit(first);await e.manager.settle(first,'succeeded');
    const from=await e.manager.inspect(scope),to=await e.manager.inspect(targetScope);
    await e.manager.linkStyle(scope,targetScope,{expectedSourceRevision:from.revision,expectedRevision:to.revision,expectedGeneration:to.generation,label:{planId:'next-plan',floor:2}});
    let probes=0;const later=e.manager.createBatch({prepared:e.prepared,probe:async options=>{probes++;return e.probe(options);}});
    const scene=await e.makeShot('environment'),next=await later.choose(scene,targetScope);
    assert.equal(next.candidateId,choice.candidateId);assert.equal(next.reason,'scene_locked');assert.equal(next.executionAuthorized,false);assert.ok(probes>0);
    const job=e.makeJob(next,scene,'later');job.planId='next-plan';job.floor=2;await later.attach(job,next);await e.manager.reserve(job);await e.manager.beforeSubmit(job);await e.manager.settle(job,'succeeded');
    assert.equal((await e.manager.inspect(targetScope)).styleOrigin.sourceFloor,1);later.close();
    const unavailable=e.manager.createBatch({prepared:e.prepared,probe:async()=>({automaticEligible:false})});
    const refused=await unavailable.choose(scene,targetScope);assert.equal(refused.status,'review');assert.equal(refused.reason,'locked_route_unavailable');unavailable.close();
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
