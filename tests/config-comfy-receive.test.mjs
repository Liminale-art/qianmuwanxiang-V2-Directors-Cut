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
    storyboardFinishLog:()=>calls.push('finish'),storyboardImageAdmissionRuntime:async()=>({confirmResult:async()=>calls.push('admission')}),
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
