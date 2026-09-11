import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {receiveServiceImage} from '../qianmu-service-recovery-action.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};

function actionFixture() {
  let scope={owner:{},epoch:0,chat:'chat'};const calls=[],notices=[];
  const row={attemptId:'original',namespace:'st-user:fixture',channelKey:'channel',logId:'log',snapshot:{chatKey:'chat',imageAdmission:{attemptId:'original'}}};
  const service={rememberOriginal:async()=>true,retrieve:async(_id,deliver)=>{calls.push('retrieve');return {archived:await deliver({},row,async()=>{},async()=>{})};}};
  const deps={scope:()=>scope,service:async()=>service,state:()=>({logs:[{id:'log'}]}),clone:structuredClone,
    deliver:async(_job,log,_data,options)=>{await options.guard();calls.push(log?'archive-log':'archive-original');return true;},
    admission:async()=>({confirmResult:async()=>calls.push('admission')}),channel:async()=>({confirmResult:async()=>calls.push('channel')}),
    notify:(...args)=>notices.push(args),render:()=>calls.push('render')};
  return {deps,service,row,calls,notices,change(kind){scope={...scope,...(kind==='owner'?{owner:{}}:kind==='epoch'?{epoch:1}:{chat:'other'})};}};
}

test('service receipt rejects old ownership before retrieval and before final admission or rendering',async()=>{
  for(const boundary of ['service','remember','admission','channel'])for(const kind of ['owner','epoch','chat']) {
    const e=actionFixture(),target=boundary==='remember'?e.service:e.deps,key=boundary==='remember'?'rememberOriginal':boundary,original=target[key];
    target[key]=async(...args)=>{const result=await original(...args);e.change(kind);return result;};
    await receiveServiceImage('original',{},'st-user:fixture',e.deps);
    assert.equal(e.calls.includes('render'),false);assert.equal(e.calls.includes('channel'),false);
    if(['service','remember'].includes(boundary))assert.equal(e.calls.length,0);
    assert.equal(e.notices.at(-1)[1],'warning');
  }
});

test('normal full-recipe and original-only receipts keep their distinct metadata and finish in order',async()=>{
  for(const originalOnly of [false,true]) {
    const e=actionFixture();e.row.originalOnly=originalOnly;
    const result=await receiveServiceImage('original',{},'st-user:fixture',e.deps);
    assert.equal(result.archived,true);
    assert.deepEqual(e.calls,originalOnly?['retrieve','archive-original','channel','render']:['retrieve','archive-log','admission','channel','render']);
    assert.equal(e.notices.at(-1)[1],'success');
  }
});

test('actual service receipt remains active through lazy loading and original-record lookup',async()=>{
  for(const waitAt of ['load','remember','retrieve']) {
    const entered=deferred(),release=deferred();let c;
    const wait=async name=>{if(waitAt===name){entered.resolve();await release.promise;}};
    const service={rememberOriginal:async()=>{await wait('remember');return true;},retrieve:async()=>{await wait('retrieve');return {archived:true};}};
    c=vm.createContext({receiveServiceImage,settings:{},storyboardAdmissionEpoch:0,clone:structuredClone,storyboardState:()=>({logs:[]}),storyboardDeliverGatewayResult(){},storyboardImageAdmissionRuntime(){},storyboardImageChannelRuntime(){},storyboardImageServiceRuntime:async()=>{await wait('load');return service;},getChatKey:()=> 'chat',toast(){},
      renderModal(){assert.equal(c.storyboardReceiveServiceImage.pending,1);}});
    vm.runInContext(section('storyboardReceiveServiceImage'),c);
    const running=c.storyboardReceiveServiceImage('id',{});await entered.promise;assert.equal(c.storyboardReceiveServiceImage.pending,1);
    release.resolve();await running;assert.equal(c.storyboardReceiveServiceImage.pending,0);
    c.storyboardImageServiceRuntime=async()=>{throw Error('fixture offline');};
    await c.storyboardReceiveServiceImage('id',{});assert.equal(c.storyboardReceiveServiceImage.pending,0);
  }
});
