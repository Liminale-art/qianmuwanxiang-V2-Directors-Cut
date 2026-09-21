import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {normalizeEnsembleRecoveryScope,normalizeEnsembleRecoveryRecord} from './qianmu-ensemble-record.js';

const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_plan_storage',writeState:'not_started',submissionState:'not_submitted'});};
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');

// One deterministic, same-account ST record per exact plan/source revision.
// No model, file-list scan, background restoration, local fallback or deletion.
// Reopening a plan does not grant execution: the recovery consumer must still
// verify this record and prepare new technical bindings before normal admission.
export async function createEnsemblePlanStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=normalizeEnsembleRecoveryScope(scope);
  if(typeof guard!=='function'||typeof createStorage!=='function'||!globalThis.crypto?.subtle)fail('镜组计划保存环境未就绪');
  let closed=false,storage,writing=false;
  function check(){
    if(closed)fail('镜组计划保存会话已结束');
    let valid=false;
    try{const value=guard();if(value&&typeof value.then==='function')void Promise.resolve(value).catch(()=>{});else valid=value===true;
      valid=valid&&equal(normalizeEnsembleRecoveryScope(scope),owner);
    }catch{valid=false;}
    if(!valid){closed=true;storage?.close();fail('镜组计划来源已变化');}return true;
  }
  check();const slot='ensemble-plan-'+await digest(JSON.stringify(owner));check();
  try{
    storage=await createStorage({isCurrent:()=>{try{return check();}catch{return false;}},maxBytes:65536});check();
    if(storage.namespace!==owner.namespace)fail('镜组计划保存账户不一致');
  }catch(error){closed=true;storage?.close();throw error;}
  const issued=new WeakMap();
  function recordOf(value){const record=normalizeEnsembleRecoveryRecord(value);if(!equal(record.scope,owner))fail('镜组计划记录不属于当前楼层');return record;}
  function view(receipt){
    check();
    if(receipt?.persistence!=='st-account-file'||receipt.concurrency!=='optimistic-non-cas'||typeof receipt.exists!=='boolean'
      ||(receipt.exists?!/^[a-f0-9]{64}$/.test(receipt.fingerprint||''):receipt.fingerprint!==null||receipt.value!==null))fail('镜组计划读回尚未确认');
    const result=Object.freeze({record:receipt.exists?recordOf(receipt.value):null,exists:receipt.exists,
      persistence:'st-account-file',concurrency:'optimistic-non-cas'});
    issued.set(result,receipt.fingerprint);return result;
  }
  const read=async()=>{check();if(writing)fail('镜组计划正在保存');const receipt=await storage.read(slot,{guard:check});check();return view(receipt);};
  return Object.freeze({scope:Object.freeze({...owner}),persistence:'st-account-file',concurrency:'optimistic-non-cas',read,
    async save(value,expected){
      check();const record=recordOf(value);
      if(!issued.has(expected))fail('请先核对当前镜组计划保存版本');
      if(writing)fail('镜组计划正在保存，请勿重复提交');writing=true;
      try{
        const receipt=await storage.write(slot,record,{expectedFingerprint:issued.get(expected),guard:check});
        try{check();const result=view(receipt);if(!result.exists||!equal(result.record,record))fail('镜组计划保存后内容不一致，未确认成功');return result;}
        catch(error){error.writeState='unconfirmed';throw error;}
      }finally{writing=false;}
    },
    async verify(value){const record=recordOf(value),current=await read();check();if(!current.exists||!equal(current.record,record))fail('镜组方案尚未确认保存在当前ST楼层计划');return true;},
    close(){if(closed)return;closed=true;storage.close();},
  });
}
