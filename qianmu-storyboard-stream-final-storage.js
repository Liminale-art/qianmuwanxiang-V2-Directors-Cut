import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {normalizeStoryboardStreamFinalCapture,storyboardStreamDigest} from './qianmu-storyboard-stream-reference.js?v=1.59.380';

const schema='qianmu.storyboard.stream-final.v1';
const fields=['namespace','chatKey','messageKey','revisionId','planId','sourceRevisionId'];
const recordFields=['version','sourceRevisionId','requestId','status','updatedAt'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_stream_checkpoint'});};
function scopeOf(value){
  if(!exact(value,fields)||fields.some(key=>typeof value[key]!=='string'||!value[key]||value[key].length>(key==='namespace'||key==='chatKey'?512:160)||/[\u0000-\u001f\u007f]/.test(value[key]))
    ||!/^st-user:.+/.test(value.namespace)||!value.namespace.slice(8).trim())fail('终稿检查点所属信息无效，未开始保存');
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}

// One durable claim per original plan AND finished source revision. A later
// explicit continuation gets its own slot, not permission to erase/replay an
// older revision. Native ST readback is optimistic, never cross-device CAS.
export async function createStoryboardStreamFinalStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=scopeOf(scope);let closed=false,storage;
  if(typeof guard!=='function'||typeof createStorage!=='function')fail('终稿检查点保存环境未就绪');
  const check=()=>{if(closed||guard()!==true)fail('终稿来源已变化，未继续保存检查点');return true;};
  const recordOf=value=>{
    const result=normalizeStoryboardStreamFinalCapture(value);
    if(!exact(value,recordFields)||result.invalid||value.sourceRevisionId!==owner.sourceRevisionId||/[\u0000-\u001f\u007f]/.test(value.requestId))fail('终稿检查点内容无效，原记录未覆盖');
    return result;
  };
  check();const slot='stream-final-'+await storyboardStreamDigest(JSON.stringify(fields.map(key=>owner[key])));check();
  try{storage=await createStorage({isCurrent:()=>{try{return check();}catch(_){return false;}},maxBytes:16384});check();
    if(storage.namespace!==owner.namespace)fail('终稿检查点账户不一致，未读写记录');
  }catch(error){storage?.close();throw error;}
  function parse(value,missing=false){
    if(missing&&value===null)return null;
    if(!exact(value,['schema','scope','record'])||value.schema!==schema||!equal(scopeOf(value.scope),owner))fail('终稿检查点损坏或归属不符，未采用旧记录');
    return recordOf(value.record);
  }
  function verified(receipt,expected){
    check();if(receipt?.persistence!=='st-account-file'||receipt.concurrency!=='optimistic-non-cas'||receipt.exists!==true
      ||!/^[a-f0-9]{64}$/.test(receipt.fingerprint||'')||!equal(parse(receipt.value),expected))fail('终稿检查点读回未确认，不可继续自动请求');
    return Object.freeze({record:Object.freeze(copy(expected)),confirmation:'verified-st-file',concurrency:'optimistic-non-cas'});
  }
  return Object.freeze({
    async read(){check();const receipt=await storage.read(slot,{guard:check});check();return parse(receipt.value,receipt.exists===false);},
    async prepare(value){
      check();const next=recordOf(value);if(next.status!=='preparing')fail('终稿检查点准备状态无效');
      const receipt=await storage.update(slot,(current,receipt)=>{
        check();if(parse(current,receipt?.exists===false)!==null)fail('本次终稿已有取景记录，请手动核对；未重复请求');
        return {schema,scope:copy(owner),record:copy(next)};
      },{guard:check});return verified(receipt,next);
    },
    async settle(value,status){
      check();const started=recordOf(value);
      if(started.status!=='preparing'||!['complete','failed','cancelled'].includes(status))fail('终稿检查点结束状态无效');
      const next={...started,status,updatedAt:Date.now()};
      const receipt=await storage.update(slot,current=>{
        check();if(!equal(parse(current),started))fail('终稿检查点已变化，迟到结果未覆盖');
        return {schema,scope:copy(owner),record:next};
      },{guard:check});return verified(receipt,next);
    },
    close(){if(closed)return;closed=true;storage.close();},
  });
}
