import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';

test('floor busy state follows actual compiler/queue ownership, never saved stale plan status',()=>{
  const state={shotPlans:[{chatKey:'chat',floor:9,status:'compiling'}]},options=[];
  const context=vm.createContext({getChatKey:()=> 'chat',storyboardState:()=>state,storyboardQueue:[],storyboardActiveJobs:new Map(),
    storyboardQueueBatches:new Set(),storyboardCompilerBusy:false,storyboardCompilerFloor:null,storyboardAdmissionEpoch:1,
    injectStoryboardMessageButtons:(_root,api)=>options.push(api),storyboardMessageFloor(){},ctx(){},storyboardPlanForMessage(){},applyQianmuIcons(){}});
  vm.runInContext(section('storyboardInjectMessageButtons'),context);
  const busy=()=>{context.storyboardInjectMessageButtons({});return [...Array(10).keys()].filter(options.at(-1).isBusy);};
  assert.deepEqual(busy(),[]);
  context.storyboardCompilerBusy=true;context.storyboardCompilerFloor={chatKey:'chat',floor:2,state,epoch:1};
  assert.deepEqual(busy(),[2]);
  context.storyboardCompilerFloor.chatKey='foreign';assert.deepEqual(busy(),[]);
  context.storyboardCompilerFloor.chatKey='chat';context.storyboardCompilerFloor.epoch=0;assert.deepEqual(busy(),[]);
  context.storyboardCompilerBusy={worldLease:true};context.storyboardCompilerFloor.epoch=1;assert.deepEqual(busy(),[]);
  context.storyboardQueue.push({chatKey:'chat',floor:3},{chatKey:'chat',floor:4,discardRequested:true},{chatKey:'other',floor:5},
    {chatKey:'chat',floor:6,imageOwnerState:{}});
  context.storyboardActiveJobs.set('a',{chatKey:'chat',floor:7,imageOwnerState:state});
  context.storyboardQueueBatches.add({chatKey:'chat',plan:{floor:8},complete:false});
  assert.deepEqual(busy(),[3,7,8]);
  context.storyboardQueue.length=0;context.storyboardActiveJobs.clear();context.storyboardQueueBatches.clear();assert.deepEqual(busy(),[]);
});

test('compiler refreshes prose at start and always clears the indicator after early preparation failure or disposal error',async()=>{
  for(const disposeError of [false,true]){
    const e=await compilerEnvironment(),changes=[];
    const make=e.context.storyboardCreatePreparationGuard;
    e.context.storyboardCreatePreparationGuard=(...args)=>{const guard=make(...args);const dispose=guard.dispose;
      guard.dispose=()=>{dispose();if(disposeError)throw Error('synthetic dispose');};return guard;};
    e.context.storyboardPrepareWorldContext=async()=>{throw Error('synthetic preparation failure');};
    e.context.storyboardScheduleInlineRender=(delay,floor)=>changes.push({delay,floor,busy:e.context.storyboardCompilerBusy,owner:e.context.storyboardCompilerFloor});
    const pending=e.context.storyboardCompilePrompt(null);
    if(disposeError)await assert.rejects(pending,/synthetic dispose/);else assert.equal(await pending,false);
    assert.equal(changes[0].busy,true);assert.equal(changes[0].owner.floor,0);assert.equal(changes[0].floor,0);
    assert.equal(changes.at(-1).busy,false);assert.equal(changes.at(-1).owner,null);assert.equal(changes.at(-1).delay,0);
    assert.equal(e.context.storyboardCompilerBusy,false);assert.equal(e.context.storyboardCompilerFloor,null);
  }
});

test('queued-job finally refreshes prose after success, failure and owner rejection, even with closed main panel',async()=>{
  for(const outcome of ['success','failure','foreign']){
    const owner={logs:[]},job={id:'job',imageAccountNamespace:'account',imageOwnerState:owner},active=new Map([['job',job]]),calls=[];
    const context=vm.createContext({storyboardState:()=>outcome==='foreign'?{}:owner,resolveImageAccountNamespace:async()=> 'account',
      storyboardSettleImageAdmission:async()=>{},storyboardRunJob:async()=>{if(outcome==='failure')throw Error('synthetic request');},
      storyboardActiveJobs:active,storyboardRecoverOriginalTasks(){},storyboardQueueWindow:{notify(){}},storyboardBusy:true,
      storyboardQueue:[],renderModal(){},storyboardScheduleInlineRender:()=>calls.push(active.size),console});
    vm.runInContext(section('storyboardRunQueuedJob'),context);
    if(outcome==='failure')await assert.rejects(context.storyboardRunQueuedJob(job),/synthetic request/);else await context.storyboardRunQueuedJob(job);
    assert.deepEqual(calls,[0]);assert.equal(context.storyboardBusy,false);
  }
});

test('batch lifecycle and cancellation explicitly refresh prose without relying on main-modal rendering',()=>{
  const batch=section('storyboardEnqueuePreparedBatch');
  assert.match(batch,/storyboardQueueBatches.add\(entry\);\s*if[^\n]+storyboardScheduleInlineRender\(0\)/);
  assert.match(batch,/storyboardQueueBatches.delete\(entry\);\s*if[^\n]+storyboardScheduleInlineRender\(0\)/);
  for(const name of ['storyboardDiscardActive','storyboardRemoveQueuedLog'])assert.match(section(name),/storyboardScheduleInlineRender\(0\)/);
  const changed=section('storyboardHandleChatChanged');
  assert.ok(changed.indexOf('storyboardScheduleInlineRender(0)')<changed.indexOf('await storyboardDrainPendingDeliveries'));
  const handler=section('bindEvents').split('const rerenderHandler = async () => {')[1].split('const appReadyHandler')[0];
  assert.ok(handler.indexOf('storyboardScheduleInlineRender(0)')<handler.indexOf('await refreshCoreadPersonaAvatar()'),
    'a slow avatar lookup must not retain the previous chat busy appearance');
});
