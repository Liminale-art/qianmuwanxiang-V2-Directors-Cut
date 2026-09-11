import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};

test('actual service receipt remains active through lazy loading and original-record lookup',async()=>{
  for(const waitAt of ['load','remember','retrieve']) {
    const entered=deferred(),release=deferred();let c;
    const wait=async name=>{if(waitAt===name){entered.resolve();await release.promise;}};
    const service={rememberOriginal:async()=>{await wait('remember');return true;},retrieve:async()=>{await wait('retrieve');return {archived:true};}};
    c=vm.createContext({storyboardImageServiceRuntime:async()=>{await wait('load');return service;},getChatKey:()=> 'chat',toast(){},
      renderModal(){assert.equal(c.storyboardReceiveServiceImage.pending,1);}});
    vm.runInContext(section('storyboardReceiveServiceImage'),c);
    const running=c.storyboardReceiveServiceImage('id',{});await entered.promise;assert.equal(c.storyboardReceiveServiceImage.pending,1);
    release.resolve();await running;assert.equal(c.storyboardReceiveServiceImage.pending,0);
    c.storyboardImageServiceRuntime=async()=>{throw Error('fixture offline');};
    await c.storyboardReceiveServiceImage('id',{});assert.equal(c.storyboardReceiveServiceImage.pending,0);
  }
});
