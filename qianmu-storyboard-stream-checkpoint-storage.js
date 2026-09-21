import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {normalizeStoryboardStreamAttempt} from './qianmu-storyboard-stream-attempt.js?v=1.59.250';
import {storyboardStreamDigest} from './qianmu-storyboard-source-proof.js?v=1.59.250';

const schema='qianmu.storyboard.stream-checkpoint.v1';
const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_stream_checkpoint'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>JSON.parse(JSON.stringify(value));
const fields=['namespace','chatKey','messageKey','revisionId','planId'];
function scopeOf(value){
  if(!exact(value,fields)||fields.some(key=>typeof value[key]!=='string'||!value[key]||value[key].length>(key==='namespace'||key==='chatKey'?512:160)||/[\u0000-\u001f\u007f]/.test(value[key]))
    ||!/^st-user:.+/.test(value.namespace)||!value.namespace.slice(8).trim())fail('取景检查点所属信息无效，未开始保存');
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
function attemptOf(value){
  const result=normalizeStoryboardStreamAttempt(value);if(result.invalid)fail('取景检查点内容无效，原记录未覆盖');return result;
}

// Lazy, explicit storage seam for the guarded compiler/host adapter. This is NOT
// an event subscription or a background sync loop. ST immutable body + head
// readback confirms this operation, but is optimistic, NOT a cross-device CAS.
// No whole prose, model key, prompt or source attachment belongs in this store.
export async function createStoryboardStreamCheckpointStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=scopeOf(scope);
  if(typeof guard!=='function'||typeof createStorage!=='function')fail('取景检查点保存环境未就绪');
  let closed=false,storage;
  const check=()=>{if(closed||guard()!==true)fail('取景来源已变化，未继续保存检查点');return true;};
  check();const slot='stream-checkpoint-'+await storyboardStreamDigest(JSON.stringify(fields.map(key=>owner[key])));check();
  try{storage=await createStorage({isCurrent:()=>{try{return check();}catch(_){return false;}},maxBytes:16384});check();
    if(storage.namespace!==owner.namespace)fail('取景检查点账户不一致，未读写记录');
  }catch(error){storage?.close();throw error;}
  function parse(value,missing=false){
    if(missing&&value===null)return null;
    if(!exact(value,['schema','scope','attempt'])||value.schema!==schema||!equal(scopeOf(value.scope),owner))fail('取景检查点损坏或归属不符，未采用旧记录');
    return attemptOf(value.attempt);
  }
  function verified(receipt,expected){
    check();if(receipt?.persistence!=='st-account-file'||receipt.concurrency!=='optimistic-non-cas'||receipt.exists!==true
      ||!/^[a-f0-9]{64}$/.test(receipt.fingerprint||'')||!equal(parse(receipt.value),expected))fail('取景检查点读回未确认，不可请求模型');
    return Object.freeze({attempt:Object.freeze(copy(expected)),confirmation:'verified-st-file',concurrency:'optimistic-non-cas'});
  }
  return Object.freeze({
    async read(){check();const result=await storage.read(slot,{guard:check});check();return parse(result.value,result.exists===false);},
    async prepare(value,previous=null){
      check();const next=attemptOf(value),prior=previous===null?null:attemptOf(previous);
      if(next.status!=='preparing'||next.passes!==(prior?.passes||0)+1||prior&&(!['ready','waiting'].includes(prior.status)
        ||prior.requestId===next.requestId||prior.sourceDigest===next.sourceDigest||prior.prefixLength>=next.prefixLength))fail('取景检查点轮次或来源顺序无效，未请求模型');
      const receipt=await storage.update(slot,(current,receipt)=>{
        check();const existing=parse(current,receipt?.exists===false);
        if(!equal(existing,prior))fail('上次取景记录未核对或已变化，请手动检查，未重新请求');
        return {schema,scope:copy(owner),attempt:copy(next)};
      },{guard:check});return verified(receipt,next);
    },
    async settle(value,status){
      check();const started=attemptOf(value);
      if(started.status!=='preparing'||!['ready','waiting','failed','cancelled'].includes(status))fail('取景检查点结束状态无效');
      const next={...started,status,updatedAt:Date.now()};
      const receipt=await storage.update(slot,current=>{
        check();if(!equal(parse(current),started))fail('取景检查点已被替换，迟到结果未覆盖');
        return {schema,scope:copy(owner),attempt:next};
      },{guard:check});return verified(receipt,next);
    },
    async verify(value){check();const expected=attemptOf(value),receipt=await storage.read(slot,{guard:check});return verified(receipt,expected);},
    close(){if(closed)return;closed=true;storage.close();},
  });
}
