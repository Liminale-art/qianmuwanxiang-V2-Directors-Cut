import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {proseAssistantAccountForNamespace} from './qianmu-prose-assistant-source.js';
import {proseAssistantHistoryKey,proseAssistantHistoryAccount,proseAssistantOwnerKey,createProseAssistantThreadKey} from './qianmu-prose-assistant-history-contract.js';

export const PROSE_ASSISTANT_CONVERSATIONS_LIMITS=Object.freeze({entries:2048,bytes:2*1024*1024,title:240});
const SLOT='assistant-conversations',LIMIT=PROSE_ASSISTANT_CONVERSATIONS_LIMITS;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>structuredClone(value);
const error=(code,message)=>Object.assign(new Error(message),{code:'prose_assistant_conversations_'+code});
const fail=(code,message)=>{throw error(code,message);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const time=value=>Number.isSafeInteger(value)&&value>=0&&value<=253402214400000;
const validText=value=>typeof value==='string'&&value.trim().length>0&&value.length<=LIMIT.title&&!/[\u0000-\u001f\u007f]/.test(value)&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const invalid=()=>fail('invalid','最近对话记录格式异常，未覆盖原内容');
const safe=cause=>String(cause?.code||'').startsWith('prose_assistant_conversations_')?cause:
 error(cause?.code==='st_account_storage_conflict'?'conflict':'storage',cause?.code==='st_account_storage_conflict'?'最近对话已变化，请刷新后再试':'最近对话保存未确认，请重试');

function historyKey(key,account){try{return proseAssistantHistoryKey(key,account);}catch{invalid();}}
function ownerKey(key,account){historyKey(key,account);if(proseAssistantOwnerKey(key)!==key)invalid();return key;}
function validate(value,account){
 if(!exact(value,['version','account','revision','entries','defaults'])||value.version!==1||value.account!==account||!Number.isSafeInteger(value.revision)||value.revision<0
  ||!Array.isArray(value.entries)||value.entries.length>LIMIT.entries||!Array.isArray(value.defaults)||value.defaults.length>LIMIT.entries)invalid();
 const entries=new Map();
 for(const entry of value.entries){
  if(!exact(entry,['key','ownerKey','title','createdAt','updatedAt','lastUsedAt','deleted'])||!validText(entry.title)
   ||![entry.createdAt,entry.updatedAt,entry.lastUsedAt].every(time)||typeof entry.deleted!=='boolean')invalid();
  historyKey(entry.key,account);ownerKey(entry.ownerKey,account);if(entries.has(entry.key))invalid();entries.set(entry.key,entry);
 }
 const owners=new Set();
 for(const entry of value.defaults){
  if(!exact(entry,['ownerKey','key']))invalid();ownerKey(entry.ownerKey,account);historyKey(entry.key,account);
  const target=entries.get(entry.key);if(owners.has(entry.ownerKey)||!target||target.deleted||target.ownerKey!==entry.ownerKey)invalid();owners.add(entry.ownerKey);
 }
 if(value.revision===0&&(value.entries.length||value.defaults.length))invalid();
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>LIMIT.bytes)fail('capacity','最近对话目录已满，请先保留所需记录');
 return value;
}

// This is only an account-scoped list of known conversation keys. Opening or
// searching it never enumerates ST files or reads any conversation's messages.
// Removed entries remain tombstones: a later legacy read must not restore them.
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
 function register(state,{key,ownerKey:owner,title,createdAt,updatedAt}={}){
  historyKey(key,account);owner??=proseAssistantOwnerKey(key);ownerKey(owner,account);const prior=find(state,key);if(prior)return prior.deleted?null:prior;
  const at=currentTime(),entry=add(state,{key,ownerKey:owner,title,createdAt:createdAt??updatedAt??at,updatedAt:updatedAt??at});
  if(!state.defaults.some(item=>item.ownerKey===owner))setDefault(state,owner,key);return entry;
 }
 return Object.freeze({
  view(){check();return snapshot();},
  status(){return {busy:!!active,dirty:!!pending,closed,code:lastError?.code||'',canRetry:!closed&&!active&&!!pending};},
  ensure(metadata){return mutate(state=>register(state,metadata));},
  create({ownerKey:owner,title,id,remember}={}){return mutate(state=>{
   if(remember)register(state,remember);
   ownerKey(owner,account);const key=createProseAssistantThreadKey(owner,id??cryptoImpl.randomUUID());if(find(state,key))fail('duplicate','此对话编号已存在，未覆盖记录');
   const at=currentTime(),entry=add(state,{key,ownerKey:owner,title,createdAt:at,updatedAt:at});setDefault(state,owner,key);return entry;
  });},
  activate(key,{defaultForCurrent,remember}={}){return mutate(state=>{
   if(remember)register(state,remember);
   const entry=live(state,key);if(defaultForCurrent!==undefined){ownerKey(defaultForCurrent,account);if(entry.ownerKey!==defaultForCurrent)fail('scope','此对话不属于当前聊天');setDefault(state,defaultForCurrent,key);}
   entry.lastUsedAt=currentTime();return entry;
  });},
  saved(key,updatedAt){return mutate(state=>{const entry=live(state,key);if(!time(updatedAt))invalid();entry.updatedAt=updatedAt;entry.lastUsedAt=currentTime();return entry;});},
  delete(keys,{remember}={}){return mutate(state=>{
   if(remember)register(state,remember);
   if(!Array.isArray(keys)||!keys.length||keys.length>LIMIT.entries||new Set(keys).size!==keys.length)invalid();
   const entries=keys.map(key=>{historyKey(key,account);const entry=find(state,key);if(!entry)fail('deleted','所选对话已变化，请刷新');return entry;});
   const at=currentTime(),removed=[];for(const entry of entries)if(!entry.deleted){entry.deleted=true;entry.updatedAt=at;removed.push(entry.key);}
   const selected=new Set(keys);state.defaults=state.defaults.filter(entry=>!selected.has(entry.key));return {deleted:removed};
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
