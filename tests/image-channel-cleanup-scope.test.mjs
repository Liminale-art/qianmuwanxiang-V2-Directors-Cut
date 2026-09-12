import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as source} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const f={namespace:'account-a',created:0,closed:0,calls:[]};
  const modules={imageAdmission:{resolveImageAccountNamespace:async()=>f.namespace},imageChannel:{createBrowserImageChannel(){f.created++;return {manage:async(...args)=>{f.calls.push(args);return {bytes:4,count:2};},close(){f.closed++;}};}}};
  const c=vm.createContext({featureRuntime:{load:async name=>f.load?f.load(name,modules[name]):modules[name]}});
  vm.runInContext(source('storyboardManageImageChannels'),c);f.run=options=>c.storyboardManageImageChannels(options);return f;
}

test('inventory carries the exact scanned account for later cleanup instead of resolving a new selected target',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.namespace,'account-a');assert.equal(result.count,2);assert.equal(f.closed,1);
  for(const expectedNamespace of [undefined,'account-b']){await assert.rejects(f.run({remove:true,expectedNamespace}),/账户已变化或尚未盘点/);assert.equal(f.created,1);}
});

test('cleanup checks after module and identity waits, passes its live guard into the store and always closes handles',async()=>{
  for(const phase of ['modules','identity','scan','success']){
    const f=fixture();let valid=true;
    f.load=async(name,value)=>{if(phase==='modules')valid=false;if(name==='imageAdmission'&&phase==='identity')return {resolveImageAccountNamespace:async()=>{valid=false;return f.namespace;}};
      if(name==='imageChannel'&&phase==='scan')return {createBrowserImageChannel(){f.created++;return {manage:async(_namespace,options)=>{valid=false;options.check();},close(){f.closed++;}};}};return value;};
    const check=()=>{if(!valid)throw Error('stale page');},pending=f.run({remove:true,expectedNamespace:'account-a',check});
    if(phase==='success'){await pending;assert.equal(f.calls[0][1].check,check);}else await assert.rejects(pending,/stale page/);
    assert.equal(f.created,['scan','success'].includes(phase)?1:0);assert.equal(f.closed,f.created);
  }
});
