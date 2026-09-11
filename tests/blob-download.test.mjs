import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';
function fixture(failure=''){
  const calls=[],timers=[];const fail=name=>{calls.push(name);if(failure===name)throw Error(name);};
  const link={click(){fail('click');},remove(){fail('remove');}};
  const c=vm.createContext({document:{createElement(){fail('create');return link;},body:{appendChild(){fail('append');}}},
    URL:{createObjectURL(){fail('url');return 'blob:synthetic';},revokeObjectURL(value){calls.push('revoke:'+value);}},setTimeout:(fn,ms)=>timers.push({fn,ms})});
  vm.runInContext(source('ttsDownloadBlob'),c);return {calls,timers,link,run:()=>c.ttsDownloadBlob({},'千幕 备份.json')};
}
test('the shared downloader keeps the original filename and delays revocation until after handing off the click',()=>{
  const e=fixture();e.run();assert.equal(e.link.download,'千幕 备份.json');assert.equal(e.link.href,'blob:synthetic');
  assert.deepEqual(e.calls,['url','create','append','click','remove']);assert.equal(e.timers.length,1);assert.equal(e.timers[0].ms,1000);
  e.timers[0].fn();assert.equal(e.calls.at(-1),'revoke:blob:synthetic');
});
for(const failure of ['create','append','click','remove'])test('download '+failure+' failure still schedules resource cleanup and propagates the failure',()=>{
  const e=fixture(failure);assert.throws(e.run,new RegExp(failure));assert.equal(e.timers.length,1);e.timers[0].fn();
  assert.equal(e.calls.at(-1),'revoke:blob:synthetic');if(failure!=='create')assert.ok(e.calls.includes('remove'));
});
test('a failed URL allocation creates no link and attempts no nonexistent-resource cleanup',()=>{
  const e=fixture('url');assert.throws(e.run,/url/);assert.deepEqual(e.calls,['url']);assert.deepEqual(e.timers,[]);
});
