import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {createProseAssistantHistoryStore} from './qianmu-prose-assistant-history.js';
import {openProseAssistantHistory} from './qianmu-prose-assistant-history-runtime.js';
import {proseAssistantAccountForNamespace} from './qianmu-prose-assistant-source.js';
import {PROSE_ASSISTANT_HISTORY_LIMITS,proseAssistantHistoryKey,validateProseAssistantHistory,emptyProseAssistantHistory,proseAssistantHistoryError as error} from './qianmu-prose-assistant-history-contract.js';

// One chat per native ST document. Immutable ST file bodies are retained by the
// shared store; its cross-device conflict detection is optimistic, not CAS.
export async function createNativeProseAssistantHistoryStore({source,isCurrent,storageFactory=createConfiguredStAccountStorage,legacyFactory=createProseAssistantHistoryStore,cryptoImpl=globalThis.crypto,now=Date.now}={}){
 const namespace=source?.scope?.namespace,key=proseAssistantHistoryKey(source?.key,namespace);let closed=false;
 const check=async()=>{if(closed||isCurrent()!==true||source.assertCurrent()!==true||await source.guard()!==true||closed||isCurrent()!==true)throw error('scope','助手聊天或账户已变化');return true;};
 await check();const store=await storageFactory({maxBytes:PROSE_ASSISTANT_HISTORY_LIMITS.bytes+2048,isCurrent:()=>!closed&&isCurrent()===true});
 let slot;
 try{
  if(await proseAssistantAccountForNamespace(store.namespace,{cryptoImpl})!==namespace)throw error('scope','助手储存账户不一致');
  slot='assistant-'+Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(key))),byte=>byte.toString(16).padStart(2,'0')).join('');await check();
 }catch(cause){store.close();throw cause;}
 const close=()=>{closed=true;store.close();};
 const safe=cause=>cause?.code==='st_account_storage_conflict'?error('conflict','助手对话已在其他设备更新，请重新打开'):String(cause?.code||'').startsWith('prose_assistant_history_')?cause:error('storage','ST 未能确认保存助手对话，请保留本页内容后重试');
 async function guard(options){await check();if(options?.guard&&await options.guard()!==true)throw error('scope','助手操作来源已变化');return true;}
 function identity(account,requested){if(account!==namespace||requested!==key)throw error('scope','助手对话不属于当前聊天');}
 async function readRecord(options){
  const result=await store.read(slot,{guard:()=>guard(options)});await guard(options);
  if(result.exists)return {state:structuredClone(validateProseAssistantHistory(result.value,key)),fingerprint:result.fingerprint};
  const legacy=legacyFactory();let prior;
  try{prior=validateProseAssistantHistory(await legacy.read(namespace,key,{guard:()=>!closed&&isCurrent()===true&&source.assertCurrent()===true}),key);await guard(options);}
  finally{legacy.close();}
  // Preserve old local records, including an explicit local clear revision. A
  // remote record always wins; never merge or resurrect local data over it.
  if(prior.revision>0){
   try{const migrated=await store.write(slot,prior,{expectedFingerprint:null,guard:()=>guard(options)});await guard(options);return {state:structuredClone(validateProseAssistantHistory(migrated.value,key)),fingerprint:migrated.fingerprint};}
   catch(cause){if(cause?.code!=='st_account_storage_conflict')throw cause;const current=await store.read(slot,{guard:()=>guard(options)});if(!current.exists)throw cause;return {state:structuredClone(validateProseAssistantHistory(current.value,key)),fingerprint:current.fingerprint};}
  }
  return {state:emptyProseAssistantHistory(key),fingerprint:null};
 }
 return Object.freeze({persistence:'st-account-file',concurrency:'optimistic-non-cas',
  async read(account,requested,options={}){try{identity(account,requested);return (await readRecord(options)).state;}catch(cause){throw safe(cause);}},
  async write(account,requested,revision,rows,options={}){
   try{
    identity(account,requested);if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw error('invalid','助手历史版本无效');
    const next=structuredClone(validateProseAssistantHistory({version:1,namespace:key,revision:revision+1,updatedAt:now(),rows},key));
    const current=await readRecord(options);if(current.state.revision!==revision)throw error('conflict','助手历史已更新');
    const saved=await store.write(slot,next,{expectedFingerprint:current.fingerprint,guard:()=>guard(options)});await guard(options);
    const state=validateProseAssistantHistory(saved.value,key);if(JSON.stringify(state)!==JSON.stringify(next))throw error('invalid','助手保存回执不一致');return structuredClone(state);
   }catch(cause){throw safe(cause);}
  },close,
 });
}

export async function openNativeProseAssistantHistory(options={}){
 const store=await createNativeProseAssistantHistoryStore(options);
 try{const runtime=await openProseAssistantHistory({...options,store});return Object.freeze({...runtime,close(){runtime.close();store.close();}});}
 catch(cause){store.close();throw cause;}
}

// A successful host rename supplies the exact old filename; the live source is
// the reloaded destination. Copy forward, never move/delete the old document or
// merge with an existing destination. ST writes remain optimistic, not CAS.
export async function copyRenamedProseAssistantHistory({source,oldChatId,isCurrent,storageFactory=createConfiguredStAccountStorage,legacyFactory=createProseAssistantHistoryStore,cryptoImpl=globalThis.crypto}={}){
 const account=source?.scope?.namespace,newKey=proseAssistantHistoryKey(source?.key,account),tuple=JSON.parse(newKey);
 if(tuple.length!==5||tuple[3].chatId===oldChatId)throw error('scope','助手改名来源无效');
 const prior=structuredClone(tuple);prior[3].chatId=oldChatId;
 const oldKey=proseAssistantHistoryKey(JSON.stringify(prior),account);
 const check=async()=>{if(isCurrent()!==true||source.assertCurrent()!==true||await source.guard()!==true||isCurrent()!==true)throw error('scope','助手改名来源已变化');return true;};
 await check();const store=await storageFactory({maxBytes:PROSE_ASSISTANT_HISTORY_LIMITS.bytes+2048,isCurrent});
 try{
  if(await proseAssistantAccountForNamespace(store.namespace,{cryptoImpl})!==account)throw error('scope','助手改名账户不一致');
  const slot=async key=>'assistant-'+Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(key))),v=>v.toString(16).padStart(2,'0')).join('');
  const oldSlot=await slot(oldKey),newSlot=await slot(newKey),options={guard:check};await check();
  const destination=await store.read(newSlot,options);await check();
  if(destination.exists){validateProseAssistantHistory(destination.value,newKey);return {status:'existing'};}
  const original=await store.read(oldSlot,options);await check();let history;
  if(original.exists)history=structuredClone(validateProseAssistantHistory(original.value,oldKey));
  else history=await readLegacy();
  async function readLegacy(){
   const legacy=legacyFactory();try{const value=structuredClone(validateProseAssistantHistory(await legacy.read(account,oldKey,{guard:()=>isCurrent()===true&&source.assertCurrent()===true}),oldKey));await check();return value;}finally{legacy.close();}
  }
  if(!history.revision)return {status:'empty'};
  const next=validateProseAssistantHistory({...history,namespace:newKey},newKey);
  const before=await store.read(oldSlot,options);await check();
  if(before.fingerprint!==original.fingerprint)throw error('conflict','原助手记录已更新，未继续改名接续');
  if(!original.exists&&JSON.stringify(await readLegacy())!==JSON.stringify(history))throw error('conflict','原本机助手记录已更新，未继续改名接续');
  try{
   const result=await store.write(newSlot,next,{expectedFingerprint:null,guard:check});await check();
   if(JSON.stringify(validateProseAssistantHistory(result.value,newKey))!==JSON.stringify(next))throw error('invalid','助手改名保存回执不一致');
  }catch(cause){
   // A lost acknowledgement may already have saved the exact destination. Read
   // once to reconcile, without repeating a write or replacing competing data.
   await check();const found=await store.read(newSlot,options);await check();
   if(!found.exists||JSON.stringify(validateProseAssistantHistory(found.value,newKey))!==JSON.stringify(next))throw cause;
  }
  return {status:'copied',turns:next.rows.length};
 }finally{store.close();}
}
