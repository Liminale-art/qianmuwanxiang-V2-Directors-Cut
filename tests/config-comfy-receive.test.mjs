import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { receiveComfyImage } from '../qianmu-comfy-recovery-action.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const deferred = () => { let resolve; return { promise:new Promise(r=>{resolve=r;}), resolve:()=>resolve() }; };
function fixture() {
  const calls=[],notices=[], log={id:'log',error:'old failure',snapshot:{chatKey:'chat',connection:{},imageAdmission:{attemptId:'old'}}};
  const c=vm.createContext({receiveComfyImage,settings:{},storyboardAdmissionEpoch:0,getChatKey:()=> 'chat',
    storyboardCanReceiveComfyLog:()=>true,sanitizeStoryboardSnapshot:structuredClone,
    storyboardComfyRecoveryRuntime:async()=>({retrieve:async()=>{calls.push('retrieve');return {archived:true};}}),
    storyboardResolveComfyRecoveryKey:async()=>'',storyboardDeliverGatewayResult:async()=>true,
    storyboardFinishLog:()=>calls.push('finish'),storyboardImageAdmissionRuntime:async()=>({confirmResult:async()=>calls.push('admission')}),storyboardComfySceneRuntime:async()=>({}),
    toast:(...args)=>notices.push(args),renderModal:()=>calls.push('render')});
  vm.runInContext(storyboardFunctionSource('storyboardReceiveComfyImage'),c);
  return {c,calls,notices,log};
}

test('actual receive entry remains active during loading, credentials and post-archive admission', async()=>{
  for(const boundary of ['storyboardComfyRecoveryRuntime','storyboardResolveComfyRecoveryKey','storyboardImageAdmissionRuntime']) {
    const e=fixture(),entered=deferred(),release=deferred(),original=e.c[boundary];
    e.c[boundary]=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
    const running=e.c.storyboardReceiveComfyImage(e.log);
    assert.equal(e.c.storyboardReceiveComfyImage.pending,1);
    await entered.promise;assert.equal(e.c.storyboardReceiveComfyImage.pending,1,boundary);
    release.resolve();await running;
    assert.equal(e.c.storyboardReceiveComfyImage.pending,0);
    assert.deepEqual(e.calls,['retrieve','finish','admission','render']);
  }
});

test('a late configuration owner or epoch change cannot deliver into new settings or announce old success', async()=>{
  for(const boundary of ['storyboardComfyRecoveryRuntime','storyboardResolveComfyRecoveryKey','storyboardImageAdmissionRuntime']) {
    for(const change of ['owner','epoch']) {
      const e=fixture(),entered=deferred(),release=deferred(),original=e.c[boundary];
      e.c[boundary]=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
      const running=e.c.storyboardReceiveComfyImage(e.log);await entered.promise;
      if(change==='owner')e.c.settings={};else e.c.storyboardAdmissionEpoch++;
      release.resolve();await running;
      assert.equal(e.c.storyboardReceiveComfyImage.pending,0);
      assert.deepEqual(e.calls,boundary==='storyboardImageAdmissionRuntime'?['retrieve','finish']:[]);
      assert.equal(e.notices.at(-1)[1],'warning');assert.match(e.notices.at(-1)[0],/配置已变化/);
    }
  }
});

test('concurrent manual receipts retain independent activity and invalid input always releases', async()=>{
  const e=fixture(),entered=deferred(),release=deferred();let count=0;
  e.c.storyboardResolveComfyRecoveryKey=async()=>{if(++count===1){entered.resolve();await release.promise;}return '';};
  const first=e.c.storyboardReceiveComfyImage(e.log);await entered.promise;
  await e.c.storyboardReceiveComfyImage(structuredClone(e.log));
  assert.equal(e.c.storyboardReceiveComfyImage.pending,1);
  release.resolve();await first;assert.equal(e.c.storyboardReceiveComfyImage.pending,0);
  e.c.storyboardCanReceiveComfyLog=()=>false;await e.c.storyboardReceiveComfyImage(e.log);
  assert.equal(e.c.storyboardReceiveComfyImage.pending,0);assert.match(e.notices.at(-1)[0],/原 Comfy 服务日志/);
});

test('manual receipt returns its safe failure but replaces stale chat, owner or epoch details before notifying',async()=>{
  for(const change of ['none','chat','owner','epoch']){
    const e=fixture(),entered=deferred(),release=deferred(),before=structuredClone(e.log);
    const warning='云任务处理未完成；〔输出核对：平台两份输出信息不一致；HTTP 200；平台码 901〕';
    e.c.storyboardComfyRecoveryRuntime=async()=>({retrieve:async()=>{e.calls.push('retrieve');entered.resolve();await release.promise;throw Error(warning);}});
    const running=e.c.storyboardReceiveComfyImage(e.log);await entered.promise;
    if(change==='chat')e.c.getChatKey=()=> 'other-chat';
    if(change==='owner')e.c.settings={};
    if(change==='epoch')e.c.storyboardAdmissionEpoch++;
    release.resolve();const result=await running;
    assert.equal(result.archived,false);assert.equal(result.warning,e.notices.at(-1)[0]);assert.equal(e.notices.at(-1)[1],'warning');
    if(change==='none')assert.equal(result.warning,warning);
    else {assert.doesNotMatch(result.warning,/输出核对|HTTP|901/);assert.match(result.warning,change==='chat'?/聊天已切换/:/配置已变化/);}
    assert.deepEqual(e.calls,['retrieve']);assert.deepEqual(e.log,before);assert.equal(e.c.storyboardReceiveComfyImage.pending,0);
  }
});

test('automatic receipt is silent and refuses a removed log before IO or after receipt lookup',async()=>{
  for(const boundary of ['before','after']){
    const e=fixture();let valid=boundary!=='before';
    if(boundary==='after')e.c.storyboardComfyRecoveryRuntime=async()=>{valid=false;return {retrieve:async()=>{throw Error('must not retrieve');}};};
    await e.c.storyboardReceiveComfyImage(e.log,{refresh:false,silent:true,valid:()=>valid});
    assert.deepEqual(e.calls,[]);assert.deepEqual(e.notices,[]);assert.equal(e.c.storyboardReceiveComfyImage.pending,0);
  }
});

test('confirmed upstream failure is logged as failure even when provider usage is absent',async()=>{
  const e=fixture();let finish;
  e.c.storyboardComfyRecoveryRuntime=async()=>({retrieve:async()=>({status:'failed',warning:'provider failed',archived:false})});
  e.c.storyboardFinishLog=(row,status,details)=>finish={row,status,details};
  await e.c.storyboardReceiveComfyImage(e.log,{refresh:false,silent:true});
  assert.equal(finish.status,'failed');assert.equal(finish.details.submissionState,'accepted');assert.equal(e.log.params.upstreamStatus,'failed');assert.deepEqual(e.notices,[]);
});
