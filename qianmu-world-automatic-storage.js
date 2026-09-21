import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {WORLD_AUTOMATIC_APPROVAL_SCHEMA,normalizeWorldAutomaticApproval} from './qianmu-world-automatic-approval.js?v=1.59.256';

const schema='qianmu.world-automatic-attempt.v1';
const sourceFields=['schema','chatKey','revisionId','field','itemId'];
const recordFields=['version','requestId','status','updatedAt'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw Object.assign(Error(message),{code:'world_automatic_checkpoint'});};
function scopeOf(value){
  if(!exact(value,['namespace','source'])||!exact(value.source,sourceFields))fail('造物之眼保存来源无效，未开始请求');
  const approval=normalizeWorldAutomaticApproval({...value,schema:WORLD_AUTOMATIC_APPROVAL_SCHEMA,requestId:'wa-'+'0'.repeat(32)});
  if(!approval||/[\u007f]/.test(value.namespace+value.source.chatKey))fail('造物之眼保存来源无效，未开始请求');
  return {namespace:approval.namespace,source:approval.source};
}
function recordOf(value){
  if(!exact(value,recordFields)||value.version!==1||typeof value.requestId!=='string'||!/^wa-[a-f0-9]{32}$/.test(value.requestId)
    ||!['preparing','queued','failed','cancelled'].includes(value.status)||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<=0)
    fail('造物之眼尝试记录无效，原记录未覆盖');
  return Object.fromEntries(recordFields.map(key=>[key,value[key]]));
}

// Per world item, not a prose floor or a choice of engine. Any saved attempt
// blocks automatic replay, including unknown outcomes left as preparing.
// Native ST readback detects conflicts optimistically; it is NOT a device lock.
export async function createWorldAutomaticStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=scopeOf(scope);let closed=false,storage;
  if(typeof guard!=='function'||typeof createStorage!=='function')fail('造物之眼保存环境未就绪');
  const check=()=>{if(closed||guard()!==true)fail('造物之眼来源或自动设置已变化，未继续请求');return true;};
  check();if(!globalThis.crypto?.subtle?.digest)fail('造物之眼保存需要安全连接');
  const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(owner)));check();
  const slot='world-attempt-'+[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');
  try{storage=await createStorage({isCurrent:()=>{try{return check();}catch(_){return false;}},maxBytes:16384});check();
    if(storage.namespace!==owner.namespace)fail('造物之眼账户不一致，未读写记录');
  }catch(error){storage?.close();throw error;}
  function parse(value,missing=false){
    if(missing&&value===null)return null;
    if(!exact(value,['schema','scope','record'])||value.schema!==schema||!equal(scopeOf(value.scope),owner))fail('造物之眼保存记录损坏或归属不符，未重复请求');
    return recordOf(value.record);
  }
  function readReceipt(receipt){
    check();if(receipt?.persistence!=='st-account-file'||receipt.concurrency!=='optimistic-non-cas'
      ||typeof receipt.exists!=='boolean'||(receipt.exists?!/^[a-f0-9]{64}$/.test(receipt.fingerprint||''):receipt.fingerprint!==null))
      fail('造物之眼保存未确认，未继续自动请求');
    return parse(receipt.value,receipt.exists===false);
  }
  function verified(receipt,expected){
    if(!equal(readReceipt(receipt),expected))fail('造物之眼保存读回不一致，未继续自动请求');
    const approval={schema:WORLD_AUTOMATIC_APPROVAL_SCHEMA,...copy(owner),requestId:expected.requestId};
    Object.freeze(approval.source);
    return Object.freeze({record:Object.freeze(copy(expected)),approval:Object.freeze(approval),confirmation:'verified-st-file',concurrency:'optimistic-non-cas'});
  }
  return Object.freeze({
    async read(){check();const receipt=await storage.read(slot,{guard:check});check();const record=readReceipt(receipt);return record===null?null:Object.freeze(record);},
    async prepare(value){
      check();const next=recordOf(value);if(next.status!=='preparing')fail('造物之眼请求准备状态无效');
      const receipt=await storage.update(slot,(current,receipt)=>{
        check();if(parse(current,receipt?.exists===false)!==null)fail('此世界画面已有自动尝试，请手动核对；未重复请求');
        return {schema,scope:copy(owner),record:copy(next)};
      },{guard:check});return verified(receipt,next);
    },
    async settle(value,status){
      check();const started=recordOf(value);
      if(started.status!=='preparing'||!['queued','failed','cancelled'].includes(status))fail('造物之眼结束状态无效');
      const next={...started,status,updatedAt:Date.now()};
      const receipt=await storage.update(slot,current=>{
        check();if(!equal(parse(current),started))fail('造物之眼尝试记录已变化，迟到结果未覆盖');
        return {schema,scope:copy(owner),record:next};
      },{guard:check});return verified(receipt,next);
    },
    close(){if(closed)return;closed=true;storage.close();},
  });
}
