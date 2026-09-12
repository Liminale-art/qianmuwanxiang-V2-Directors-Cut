import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../qianmu-image-admission.js',import.meta.url),'utf8').match(/export async function manageImageAdmissionStorage[\s\S]*?(?=export async function createImageAdmissionIdentity)/)[0].replace('export ','');
function fixture(){
  const f={account:'account-a',created:0,closed:0,calls:[]};
  const c=vm.createContext({error:(_code,message)=>Error(message),resolveImageAccountNamespace:async()=>f.identity?f.identity():f.account,
    createImageAttemptStore(){f.created++;return {manage:async(...args)=>{f.calls.push(args);if(f.manage)return f.manage(...args);return {count:2,bytes:4};},close(){f.closed++;}};}});
  vm.runInContext(source,c);f.run=options=>c.manageImageAdmissionStorage(options);return f;
}
test('attempt inventory captures its account and cleanup refuses missing or different selection before opening storage',async()=>{
  const f=fixture(),data=await f.run();assert.equal(data.namespace,'account-a');assert.equal(f.closed,1);
  for(const expectedNamespace of [undefined,'account-b'])await assert.rejects(f.run({remove:true,expectedNamespace}),/账户已变化或尚未盘点/);
  assert.equal(f.created,1);
});
test('attempt cleanup checks identity waits and propagates the live guard until disposal',async()=>{
  for(const mode of ['identity','scan','success']){
    const f=fixture();let valid=true;const check=()=>{if(!valid)throw Error('stale page');};
    if(mode==='identity')f.identity=async()=>{valid=false;return f.account;};
    if(mode==='scan')f.manage=async(_namespace,options)=>{valid=false;options.check();};
    const pending=f.run({remove:true,expectedNamespace:'account-a',check});
    if(mode==='success'){await pending;assert.equal(f.calls[0][1].check,check);}else await assert.rejects(pending,/stale page/);
    assert.equal(f.created,mode==='identity'?0:1);assert.equal(f.closed,f.created);
  }
});
