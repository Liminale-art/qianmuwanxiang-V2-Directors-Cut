import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {proseAssistantAccountForNamespace} from './qianmu-prose-assistant-source.js';
import {proseAssistantHistoryKey,proseAssistantHistoryAccount,proseAssistantOwnerKey,createProseAssistantThreadKey,validateProseAssistantHistory,PROSE_ASSISTANT_HISTORY_LIMITS} from './qianmu-prose-assistant-history-contract.js';

export const PROSE_ASSISTANT_CONVERSATIONS_LIMITS=Object.freeze({entries:2048,bytes:2*1024*1024,title:240,namedTitle:40});
const SLOT='assistant-conversations',LIMIT=PROSE_ASSISTANT_CONVERSATIONS_LIMITS;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>structuredClone(value);
const error=(code,message)=>Object.assign(new Error(message),{code:'prose_assistant_conversations_'+code});
const fail=(code,message)=>{throw error(code,message);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const time=value=>Number.isSafeInteger(value)&&value>=0&&value<=253402214400000;
const validText=value=>typeof value==='string'&&value.trim().length>0&&value.length<=LIMIT.title&&!/[\u0000-\u001f\u007f]/.test(value)&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const namedTitle=value=>validText(value)&&Array.from(value.trim()).length<=LIMIT.namedTitle&&!/[\p{Cc}\p{Cf}\u2028\u2029<>]/u.test(value)?value.trim():null;
const invalid=()=>fail('invalid','最近对话记录格式异常，未覆盖原内容');
const safe=cause=>String(cause?.code||'').startsWith('prose_assistant_conversations_')?cause:
 error(cause?.code==='st_account_storage_conflict'?'conflict':'storage',cause?.code==='st_account_storage_conflict'?'最近对话已变化，请刷新后再试':'最近对话保存未确认，请重试');

function historyKey(key,account){try{return proseAssistantHistoryKey(key,account);}catch{invalid();}}
function ownerKey(key,account){historyKey(key,account);if(proseAssistantOwnerKey(key)!==key)invalid();return key;}
export function canAutoNameProseAssistantConversation(entry){
 if(!entry||entry.deleted||entry.titleSource!==undefined||!['独立对话','特助对话'].includes(entry.title))return false;
 try{return JSON.parse(proseAssistantOwnerKey(entry.ownerKey))[0]==='qianmu-prose-assistant-offstage-v1';}catch{return false;}
}
function validate(value,account){
 if(!exact(value,['version','account','revision','entries','defaults'])||![1,2,3].includes(value.version)||value.account!==account||!Number.isSafeInteger(value.revision)||value.revision<0
  ||!Array.isArray(value.entries)||value.entries.length>LIMIT.entries||!Array.isArray(value.defaults)||value.defaults.length>LIMIT.entries)invalid();
 const entries=new Map();
 for(const entry of value.entries){
  const fields=['key','ownerKey','title','createdAt','updatedAt','lastUsedAt','deleted'],named=Object.hasOwn(entry||{},'titleSource');
  if(named){if(value.version<2||!['manual','auto'].includes(entry.titleSource)||namedTitle(entry.title)!==entry.title)invalid();fields.push('titleSource');}
  if(Object.hasOwn(entry||{},'archived')){if(value.version!==3||entry.archived!==true||entry.deleted!==false)invalid();fields.push('archived');}
  if(!exact(entry,fields)||!validText(entry.title)
   ||![entry.createdAt,entry.updatedAt,entry.lastUsedAt].every(time)||typeof entry.deleted!=='boolean')invalid();
  historyKey(entry.key,account);ownerKey(entry.ownerKey,account);if(entries.has(entry.key))invalid();entries.set(entry.key,entry);
 }
 const owners=new Set();
 for(const entry of value.defaults){
  if(!exact(entry,['ownerKey','key']))invalid();ownerKey(entry.ownerKey,account);historyKey(entry.key,account);
  const target=entries.get(entry.key);if(owners.has(entry.ownerKey)||!target||target.deleted||target.archived||target.ownerKey!==entry.ownerKey)invalid();owners.add(entry.ownerKey);
 }
 if(value.revision===0&&(value.entries.length||value.defaults.length))invalid();
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>LIMIT.bytes)fail('capacity','最近对话目录已满，请先保留所需记录');
 return value;
}
// Shared with the whole-library backup: the same contract, never a looser one.
export {validate as validateProseAssistantConversationIndex};

// This is only an account-scoped list of known conversation keys. Opening or
// searching it never enumerates ST files or reads any conversation's messages.
// Removed entries remain tombstones: a later legacy read must not restore them.
// Only the explicit clearHistories step after a delete touches history documents.
// Archived entries stay complete and restorable; they only leave the ordinary
// list and the per-chat default until they are restored.
export async function openProseAssistantConversations({source,isCurrent,storageFactory=createConfiguredStAccountStorage,now=Date.now,cryptoImpl=globalThis.crypto}={}){
 let account;try{account=proseAssistantHistoryAccount(source?.scope?.namespace);historyKey(source?.key,account);}catch{invalid();}
 if(typeof source?.guard!=='function'||typeof source?.assertCurrent!=='function'||typeof isCurrent!=='function'||typeof storageFactory!=='function'||typeof now!=='function')invalid();
 let closed=false,store=null,committed=null,fingerprint=null,active=null,pending=null,lastError=null;
 const check=()=>{if(closed||isCurrent()!==true||source.assertCurrent()!==true)fail('scope','最近对话的账户或页面已变化');return true;};
 const guard=async()=>{check();if(await source.guard()!==true)fail('scope','最近对话的账户或页面已变化');return check();};
 // The configured store already verifies the account on every transport.
 // Keep the page/source check there without recursively repeating its request.
 const transportGuard=storageFactory===createConfiguredStAccountStorage?check:guard;
 const snapshot=()=>copy(committed);
 const currentTime=()=>{const value=now();if(!time(value))invalid();return value;};
 function close(){if(closed)return;closed=true;store?.close();pending=null;committed=null;lastError=null;}
 async function read(){
  await guard();const found=await store.read(SLOT,{guard:transportGuard});await guard();
  if(!found||typeof found.exists!=='boolean')invalid();
  if(!found.exists){if(found.fingerprint!==null||found.value!==null)invalid();return {value:{version:1,account,revision:0,entries:[],defaults:[]},fingerprint:null};}
  if(typeof found.fingerprint!=='string'||!found.fingerprint)invalid();
  return {value:copy(validate(found.value,account)),fingerprint:found.fingerprint};
 }
 function adopt(record){committed=copy(record.value);fingerprint=record.fingerprint;}
 try{
  await guard();store=await storageFactory({documentLayout:'snapshot',maxBytes:LIMIT.bytes,isCurrent:()=>!closed&&isCurrent()===true});await guard();
  if(await proseAssistantAccountForNamespace(store.namespace,{cryptoImpl})!==account)fail('scope','最近对话储存账户不一致');
  adopt(await read());
 }catch(cause){close();throw safe(cause);}

 function run(work){
  try{check();if(active)fail('busy','请等待当前对话操作完成');}catch(cause){return Promise.reject(safe(cause));}
  const token={promise:null};active=token;
  token.promise=Promise.resolve().then(work).catch(cause=>{lastError=safe(cause);throw lastError;}).finally(()=>{if(active===token)active=null;});return token.promise;
 }
 async function writeTarget(){
  const target=pending;await guard();
  const saved=await store.write(SLOT,target.value,{expectedFingerprint:target.fingerprint,guard:transportGuard});await guard();
  if(!saved||typeof saved.fingerprint!=='string'||!saved.fingerprint||!same(validate(saved.value,account),target.value))invalid();
  adopt(saved);pending=null;lastError=null;
 }
 function mutate(transform){return run(async()=>{
  await guard();if(pending)fail('pending','上次对话操作尚未确认，请重试或刷新');
  const next=snapshot(),result=transform(next);
  if(same(next,committed)){lastError=null;return copy(result);}
  if(next.revision>=Number.MAX_SAFE_INTEGER)fail('capacity','最近对话版本已达上限，未覆盖记录');
  next.revision++;validate(next,account);pending={value:next,base:snapshot(),fingerprint};
  await writeTarget();return copy(result);
 });}
 const find=(state,key)=>state.entries.find(entry=>entry.key===key);
 const live=(state,key)=>{historyKey(key,account);const entry=find(state,key);if(!entry||entry.deleted)fail('deleted','此对话已移除，请返回列表');return entry;};
 const setDefault=(state,owner,key)=>{const found=state.defaults.find(entry=>entry.ownerKey===owner);if(found)found.key=key;else state.defaults.push({ownerKey:owner,key});};
 function add(state,{key,ownerKey:owner,title,createdAt,updatedAt}){
  historyKey(key,account);ownerKey(owner,account);if(!validText(title)||!time(createdAt)||!time(updatedAt))invalid();
  if(state.entries.length>=LIMIT.entries)fail('capacity','最近对话目录已满，未丢弃已有记录');
  const entry={key,ownerKey:owner,title,createdAt,updatedAt,lastUsedAt:currentTime(),deleted:false};state.entries.push(entry);return entry;
 }
 function pick(state,keys){
  if(!Array.isArray(keys)||!keys.length||keys.length>LIMIT.entries||new Set(keys).size!==keys.length)invalid();
  return keys.map(key=>{historyKey(key,account);const entry=find(state,key);if(!entry)fail('deleted','所选对话已变化，请刷新');return entry;});
 }
 function register(state,{key,ownerKey:owner,title,createdAt,updatedAt}={}){
  historyKey(key,account);owner??=proseAssistantOwnerKey(key);ownerKey(owner,account);const prior=find(state,key);if(prior)return prior.deleted?null:prior;
  const at=currentTime(),entry=add(state,{key,ownerKey:owner,title,createdAt:createdAt??updatedAt??at,updatedAt:updatedAt??at});
  if(!state.defaults.some(item=>item.ownerKey===owner))setDefault(state,owner,key);return entry;
 }
 return Object.freeze({
  view(){check();return snapshot();},
  canAutoName(key){check();historyKey(key,account);return canAutoNameProseAssistantConversation(find(committed,key));},
  status(){return {busy:!!active,dirty:!!pending,closed,code:lastError?.code||'',canRetry:!closed&&!active&&!!pending};},
  ensure(metadata){return mutate(state=>register(state,metadata));},
  create({ownerKey:owner,title,id,remember}={}){return mutate(state=>{
   if(remember)register(state,remember);
   ownerKey(owner,account);const key=createProseAssistantThreadKey(owner,id??cryptoImpl.randomUUID());if(find(state,key))fail('duplicate','此对话编号已存在，未覆盖记录');
   const at=currentTime(),entry=add(state,{key,ownerKey:owner,title,createdAt:at,updatedAt:at});setDefault(state,owner,key);return entry;
  });},
  activate(key,{defaultForCurrent,remember}={}){return mutate(state=>{
   if(remember)register(state,remember);
   const entry=live(state,key);if(entry.archived)fail('archived','此对话已归档，请先恢复');if(defaultForCurrent!==undefined){ownerKey(defaultForCurrent,account);if(entry.ownerKey!==defaultForCurrent)fail('scope','此对话不属于当前聊天');setDefault(state,defaultForCurrent,key);}
   entry.lastUsedAt=currentTime();return entry;
  });},
  saved(key,updatedAt,{title}={}){return mutate(state=>{
   const entry=live(state,key);if(!time(updatedAt))invalid();entry.updatedAt=updatedAt;entry.lastUsedAt=currentTime();
   const name=namedTitle(title);if(name&&canAutoNameProseAssistantConversation(entry)){state.version=Math.max(state.version,2);entry.title=name;entry.titleSource='auto';}return entry;
  });},
  rename(key,title,{remember}={}){return mutate(state=>{
   const name=namedTitle(title);if(!name)fail('title','名称请使用 1–40 个字，不含换行或标签');
   if(remember)register(state,remember);const entry=live(state,key);state.version=Math.max(state.version,2);entry.title=name;entry.titleSource='manual';return entry;
  });},
  delete(keys,{remember}={}){return mutate(state=>{
   if(remember)register(state,remember);
   const entries=pick(state,keys),at=currentTime(),removed=[];for(const entry of entries)if(!entry.deleted){entry.deleted=true;delete entry.archived;entry.updatedAt=at;removed.push(entry.key);}
   const selected=new Set(keys);state.defaults=state.defaults.filter(entry=>!selected.has(entry.key));return {deleted:removed};
  });},
  // Second half of a delete: overwrite each removed conversation's saved history with an
  // empty one. The account store has no file delete, so only the current version is
  // emptied; earlier immutable versions stay on disk. Only tombstoned entries are
  // touched, so a listed or archived conversation can never be emptied from here.
  // A conversation that was never saved has nothing to empty. Failures are returned,
  // not thrown: the tombstone stays and the caller reports what is left.
  clearHistories(keys){return run(async()=>{
   await guard();if(pending)fail('pending','上次对话操作尚未确认，请重试或刷新');
   if(!Array.isArray(keys)||!keys.length||keys.length>LIMIT.entries||new Set(keys).size!==keys.length)invalid();
   for(const key of keys)historyKey(key,account);
   const outcome=new Map();let documents=null,next=0;
   async function empty(key){
    if(!find(committed,key)?.deleted)throw Error();
    const slot='assistant-'+Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(key))),byte=>byte.toString(16).padStart(2,'0')).join('');
    const options={guard:transportGuard},found=await documents.read(slot,options);await guard();
    if(!found.exists)return 'missing';
    let prior=null;try{prior=validateProseAssistantHistory(found.value,key);}catch{/* An unreadable document is replaced as well. */}
    if(prior&&!prior.rows.length)return 'cleared';
    const revision=Number.isSafeInteger(found.value?.revision)&&found.value.revision>=0&&found.value.revision<Number.MAX_SAFE_INTEGER?found.value.revision+1:1;
    const blank=validateProseAssistantHistory({version:1,namespace:key,revision,updatedAt:currentTime(),rows:[]},key);
    try{const saved=await documents.write(slot,blank,{expectedFingerprint:found.fingerprint,...options});await guard();if(!same(saved?.value,blank))throw Error();}
    catch(cause){
     // The write may have landed before its acknowledgement was lost; accept only that exact result.
     const actual=await documents.read(slot,options);await guard();if(!actual.exists||!same(actual.value,blank))throw cause;
    }
    return 'cleared';
   }
   try{
    documents=await storageFactory({maxBytes:PROSE_ASSISTANT_HISTORY_LIMITS.bytes+2048,isCurrent:()=>!closed&&isCurrent()===true});await guard();
    if(await proseAssistantAccountForNamespace(documents.namespace,{cryptoImpl})!==account)throw Error();
    const worker=async()=>{while(next<keys.length){const key=keys[next++];try{outcome.set(key,await empty(key));}catch{outcome.set(key,'failed');}}};
    await Promise.all(Array.from({length:Math.min(4,keys.length)},worker));
   }catch{/* Counted below: every key without an outcome failed. */}
   finally{documents?.close();}
   const named=name=>keys.filter(key=>(outcome.get(key)||'failed')===name);
   return {cleared:named('cleared'),missing:named('missing'),failed:named('failed')};
  });},
  // Archiving keeps the entry and its history; only delete leaves a tombstone.
  archive(keys,{remember}={}){return mutate(state=>{
   if(remember)register(state,remember);const archived=[];
   for(const entry of pick(state,keys))if(!entry.deleted&&!entry.archived){state.version=3;entry.archived=true;archived.push(entry.key);}
   const selected=new Set(archived);state.defaults=state.defaults.filter(entry=>!selected.has(entry.key));return {archived};
  });},
  unarchive(keys){return mutate(state=>{
   const restored=[];for(const entry of pick(state,keys))if(entry.archived){delete entry.archived;restored.push(entry.key);}return {restored};
  });},
  // Whole-library restore: only keys this account has never listed are added.
  // Existing entries, tombstones included, are never replaced or revived.
  adopt(entries,{defaults=[]}={}){return mutate(state=>{
   if(!Array.isArray(entries)||entries.length>LIMIT.entries||!Array.isArray(defaults)||defaults.length>LIMIT.entries)invalid();
   const adopted=[],skipped=[],at=currentTime();
   for(const item of entries){
    if(item===null||typeof item!=='object'||Array.isArray(item))invalid();historyKey(item.key,account);ownerKey(item.ownerKey,account);
    if(find(state,item.key)||adopted.includes(item.key)){skipped.push(item.key);continue;}
    if(state.entries.length>=LIMIT.entries)fail('capacity','最近对话目录已满，未丢弃已有记录');
    const entry={key:item.key,ownerKey:item.ownerKey,title:item.title,createdAt:item.createdAt,updatedAt:item.updatedAt,lastUsedAt:time(item.lastUsedAt)?item.lastUsedAt:at,deleted:false};
    if(item.titleSource!==undefined){state.version=Math.max(state.version,2);entry.titleSource=item.titleSource;}
    if(item.archived!==undefined){state.version=3;entry.archived=item.archived;}
    state.entries.push(entry);adopted.push(entry.key);
   }
   for(const item of defaults){
    const entry=adopted.includes(item?.key)?find(state,item.key):null;
    if(entry&&!entry.archived&&entry.ownerKey===item.ownerKey&&!state.defaults.some(row=>row.ownerKey===item.ownerKey))setDefault(state,item.ownerKey,item.key);
   }
   return {adopted,skipped};
  });},
  renameOwner(oldOwner,newOwner){return mutate(state=>{
   ownerKey(oldOwner,account);ownerKey(newOwner,account);if(oldOwner===newOwner)return {renamed:0};
   const oldSource=JSON.parse(oldOwner),newSource=JSON.parse(newOwner);
   if(oldSource.length!==5||newSource.length!==5||oldSource[2]!==newSource[2]||oldSource[3].kind!==newSource[3].kind||oldSource[4]!==newSource[4])fail('scope','聊天改名来源不一致，未改变对话归属');
   const oldDefault=state.defaults.find(entry=>entry.ownerKey===oldOwner),newDefault=state.defaults.find(entry=>entry.ownerKey===newOwner);let renamed=0;
   for(const entry of state.entries)if(entry.ownerKey===oldOwner){entry.ownerKey=newOwner;renamed++;}
   state.defaults=state.defaults.filter(entry=>entry.ownerKey!==oldOwner);
   if(oldDefault&&!newDefault)setDefault(state,newOwner,oldDefault.key);return {renamed};
  });},
  // One deliberate check before a history write; not a per-frame/prompt guard.
  assertEntryLive(key){return run(async()=>{
   if(pending)fail('pending','上次对话操作尚未确认，请重试或刷新');adopt(await read());lastError=null;return copy(live(committed,key));
  });},
  // Explicit refresh abandons the pending local directory edit, not messages.
  refresh(){return run(async()=>{const found=await read();adopt(found);pending=null;lastError=null;return snapshot();});},
  retry(){if(active)return active.promise;return run(async()=>{
   await guard();if(!pending)return snapshot();const actual=await read();
   if(same(actual.value,pending.value)){adopt(actual);pending=null;lastError=null;return snapshot();}
   if(actual.fingerprint!==pending.fingerprint||!same(actual.value,pending.base))fail('conflict','最近对话已变化，请刷新后再试');
   await writeTarget();return snapshot();
  });},close,
 });
}
