import {parseBoundedJson} from './qianmu-json-input.js';
import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {createProseAssistantHistoryStore} from './qianmu-prose-assistant-history.js';
import {proseAssistantHistoryKey,validateProseAssistantHistory,PROSE_ASSISTANT_HISTORY_LIMITS as LIMIT} from './qianmu-prose-assistant-history-contract.js';

export const ASSISTANT_BACKUP_LIMIT=48*1024*1024;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>{throw Object.assign(Error(message),{code:'assistant_history_transfer_'+code});};
const sha=async text=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.getOwnPropertyDescriptor(value,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value'));
const escaped=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const title=key=>{const tuple=JSON.parse(key);return tuple.length===2?'场外独立会话':tuple[3].chatId;};

// Checks integrity, not authorship. An explicitly chosen local file is never a
// trusted source of paths, credentials, HTML, account authority or chat identity.
export async function validateAssistantHistoryBackup(text,{account,scope,guard=async()=>true}={}){
 try{
  await guard();const value=parseBoundedJson(text,{maxBytes:ASSISTANT_BACKUP_LIMIT,maxDepth:12,maxNodes:40000,label:'助手备份'});
  if(!exact(value,['schema','account','createdAt','items'])||value.schema!=='qianmu.assistant-history-backup.v1'||value.account!==account||!Number.isSafeInteger(value.createdAt)||value.createdAt<0||value.createdAt>253402214400000
   ||!Array.isArray(value.items)||value.items.length<1||value.items.length>8)fail('invalid','备份格式或账户不一致，请选择当前账户的完整助手备份');
  const seen=new Set();
  for(const item of value.items){
   if(!exact(item,['reference','history']))fail('invalid','备份条目不完整');
   const reference=stAccountImmutableReference(item.reference,{scope,maxBytes:LIMIT.bytes+3072}),key=proseAssistantHistoryKey(item.history?.namespace,account);
   validateProseAssistantHistory(item.history,key);if(seen.has(reference.slot)||reference.slot!=='assistant-'+await sha(key))fail('invalid','备份记录重复或来源不一致');seen.add(reference.slot);
   const body=JSON.stringify({schema:'qianmu.st-account-document.v1',scope,slot:reference.slot,value:item.history});
   if(new TextEncoder().encode(body).byteLength!==reference.bytes||await sha(body)!==reference.fingerprint)fail('invalid','备份内容与完整性记录不符，未导入修改或截断的记录');await guard();
  }
  return value;
 }catch(cause){await guard();if(String(cause?.code||'').startsWith('assistant_history_transfer_'))throw cause;fail('invalid','助手备份格式或完整性校验未通过，未修改原件');}
}

// Serialized by the enclosing manager. Only absent destinations are written;
// existing clear markers and old local records are also protected destinations.
export function createAssistantHistoryTransfer({store,account,guard,assertCurrent,signal,describe,captureDestination,legacyFactory=createProseAssistantHistoryStore}={}){
 let review=null,pending=null,closed=false,local=null;
 const check=async(source)=>{if(closed)fail('scope','助手恢复页面已关闭');await guard();if(source&&(source.assertCurrent()!==true||await source.guard()!==true))fail('scope','助手恢复目标已变化');if(closed)fail('scope','助手恢复页面已关闭');return true;};
 const options=source=>({guard:()=>check(source),signal});
 const close=()=>{if(closed)return;closed=true;pending?.source?.close();pending=null;review=null;local?.close();local=null;};
 const progress=()=>pending?{operation:pending.operation,total:pending.items.length,confirmed:pending.items.filter(row=>row.done).length,uncertain:pending.items.some(row=>row.attempted&&!row.done)}:null;
 const idle=()=>{if(pending)fail('pending','请先重试原恢复范围，或关闭后重新核对');};
 function selected(ids){
  if(!review||!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)fail('selection','请先完整预览并选择本份备份中的记录');
  const found=ids.map(id=>review.items.get(id));if(found.some(row=>!row))fail('selection','所选条目不属于当前备份');return found;
 }
 async function legacy(key,source){
  await check(source);local??=legacyFactory();
  const state=validateProseAssistantHistory(await local.read(account,key,{guard:()=>{try{return !closed&&assertCurrent()===true&&(!source||source.assertCurrent()===true);}catch{return false;}}}),key);await check(source);return state;
 }
 async function occupancy(item,source){
  const found=await store.read(item.slot,options(source));await check(source);
  if(found.exists){validateProseAssistantHistory(found.value,item.next.namespace);return same(found.value,item.next)?'already':'existing';}
  return (await legacy(item.next.namespace,source)).revision>0?'local':'absent';
 }
 async function originalUnchanged(item,source){
  if(!item.original)return;const found=await store.read(item.original.reference.slot,options(source));await check(source);
  if(!found.exists||found.fingerprint!==item.original.reference.fingerprint||!same(found.value,item.original.state))fail('changed','所选原助手会话已变化，请重新读取后核对；原件未删除');
 }
 const outcome=batch=>({status:'complete',operation:batch.operation,copied:batch.items.length,already:batch.already,skipped:batch.skipped,total:batch.total,retainedOriginals:true});
 async function continueBatch(){
  const batch=pending;await check(batch.source);
  for(const item of batch.items){
   if(item.done)continue;const state=await occupancy(item,batch.source);
   if(item.attempted&&state==='already'){item.done=true;continue;}
   if(state!=='absent')fail('changed','目标助手会话已经存在或发生变化，未覆盖；已确认部分保留');await originalUnchanged(item,batch.source);item.attempted=true;
   try{
    const saved=await store.write(item.slot,item.next,{expectedFingerprint:null,...options(batch.source)});await check(batch.source);
    if(!same(saved.value,item.next))fail('receipt','助手恢复保存回执未确认，请保留窗口重试');item.done=true;
   }catch(cause){await check(batch.source);const found=await store.read(item.slot,options(batch.source));await check(batch.source);
    if(found.exists&&same(found.value,item.next))item.done=true;else throw cause;
   }
  }
  const result=outcome(batch);batch.source?.close();pending=null;return result;
 }
 async function begin(operation,ids,items,confirm,source=null,fromBackup=false){
  let transferred=false;
  try{
   if(typeof confirm!=='function')fail('confirmation','恢复需要明确确认');
   const available=[];let already=0,skipped=0;
   for(const item of items){await originalUnchanged(item,source);const state=await occupancy(item,source);if(state==='absent')available.push({...item,done:false,attempted:false});else if(state==='already')already++;else skipped++;}
   if(!available.length)return {status:'existing',operation,copied:0,already,skipped,total:items.length,retainedOriginals:true};
   const message=operation==='reassociate'?`来源：${escaped(title(items[0].originKey))}<br>当前目标：${escaped(title(source.key))}<br>请仅在确认它们是同一聊天时接回。原问答和旧楼层引用原样保留，不复制正文、不重新定位楼层。旧记录不删除，已有目标（含清空记录）不替换。ST为乐观冲突检测，请避免多端同时编辑。确定接回？`:
    `将把选中的 ${available.length} 份完整助手记录恢复至备份中的原归属；${already} 份已一致、${skipped} 份已有其他记录将保留不动。不会创建或修改ST聊天，不覆盖已有版本（含清空记录）或旧本机记录，不自动接到当前聊天。ST为乐观冲突检测，请避免多端同时编辑。确定恢复？`;
   if(await confirm(operation==='reassociate'?'接回当前聊天':'恢复助手备份',message)!==true){await check(source);return {status:'cancelled'};}
   await check(source);for(const item of available){await originalUnchanged(item,source);if(await occupancy(item,source)!=='absent')fail('changed','确认期间目标助手记录已变化，未开始恢复；请重新预览');}
   pending={operation,ids:[...ids],items:available,total:items.length,already,skipped,source,fromBackup};transferred=true;return await continueBatch();
  }finally{if(!transferred)source?.close();}
 }
 return Object.freeze({close,progress,
  async reviewBackup(text){idle();const value=await validateAssistantHistoryBackup(text,{account,scope:store.scope,guard:()=>check()});await check();
   review={createdAt:value.createdAt,items:new Map(value.items.map(item=>[item.reference.slot,{reference:item.reference,state:item.history,status:'ready'}]))};
   return {offset:0,nextOffset:null,total:review.items.size,createdAt:review.createdAt,rows:[...review.items.values()].map(describe)};
  },
  async viewBackup(id){await check();return structuredClone(selected([id])[0].state);},
  async discardBackup(){idle();await check();review=null;},
  async restoreBackup(ids,confirm){await check();
   if(pending){if(pending.operation!=='restore'||!same(pending.ids,ids))fail('pending','只能重试原恢复范围');return continueBatch();}
   const items=selected(ids).map(row=>({slot:row.reference.slot,next:structuredClone(row.state),original:null}));return begin('restore',ids,items,confirm);
  },
  async reassociate(id,{row,fromBackup=false,confirm}={}){await check();
   if(pending){if(pending.operation!=='reassociate'||pending.fromBackup!==fromBackup||!same(pending.ids,[id]))fail('pending','只能重试原接续范围');return continueBatch();}
   if(typeof captureDestination!=='function')fail('target','请先进入需要接回的聊天');
   const original=fromBackup?selected([id])[0]:row;if(!original||original.status!=='ready'||original.reference.slot!==id)fail('selection','请先选择一份完整会话');
   const source=await captureDestination({signal});let delegated=false;
   try{
    await check(source);const key=proseAssistantHistoryKey(source?.key,account),old=JSON.parse(original.state.namespace),target=JSON.parse(key);
    if(old.length!==5||target.length!==5||old[2]!==target[2]||old[3].kind!==target[3].kind||old[4]!==target[4])fail('target','来源与当前聊天的角色/群组或身份标记不一致，未猜测接续；仍可查阅和保留备份');
    if(key===original.state.namespace)fail('target','所选记录已经属于当前聊天，无需重新接续');
    const next=validateProseAssistantHistory({...structuredClone(original.state),namespace:key},key),item={slot:'assistant-'+await sha(key),next,originKey:original.state.namespace,original:fromBackup?null:structuredClone(original)};
    delegated=true;return await begin('reassociate',[id],[item],confirm,source,fromBackup);
   }finally{if(!delegated)source?.close();}
  }
 });
}
