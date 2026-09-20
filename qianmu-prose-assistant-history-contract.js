import {chatFileTarget} from './qianmu-chat-file-target.js';

export const PROSE_ASSISTANT_HISTORY_LIMITS=Object.freeze({turns:100,characters:1000000,question:20000,reply:200000,bytes:4*1024*1024});
const error=(code,message)=>Object.assign(new Error(message),{code:'prose_assistant_history_'+code});
const fail=()=>{throw error('invalid','助手历史格式或来源不一致，未覆盖原记录');};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const account=value=>{if(typeof value!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value))fail();return value;};

// File/owner/integrity tuple, not a minted permanent identity or a rename map.
// Each tuple is a separate local document: opening one chat never reads all chats.
export function proseAssistantHistoryKey(value,namespace){
  if(typeof value!=='string'||value.length>4096)fail();let tuple;
  try{tuple=JSON.parse(value);}catch(_){fail();}
  if(Array.isArray(tuple)&&tuple.length===2&&tuple[0]==='qianmu-prose-assistant-offstage-v1'){
    account(tuple[1]);if(namespace!==undefined&&tuple[1]!==account(namespace)||JSON.stringify(tuple)!==value)fail();return value;
  }
  if(!Array.isArray(tuple)||tuple.length!==5||tuple[0]!=='qianmu-prose-assistant-v2')fail();
  const [,ownerAccount,owner,raw,integrity]=tuple;account(ownerAccount);if(namespace!==undefined&&ownerAccount!==account(namespace))fail();
  let target;try{target=chatFileTarget(raw);}catch(_){fail();}
  if(target.kind==='character'?owner!=='char:'+target.avatar:!text(owner,518)||!/^group:.+/.test(owner)||/[\u0000-\u001f\u007f]/.test(owner))fail();
  if(integrity!==null&&(!text(integrity,512)||/[\u0000-\u001f\u007f]/.test(integrity)))fail();
  const key=JSON.stringify([tuple[0],ownerAccount,owner,target,integrity]);if(key!==value)fail();return key;
}
function rowsValid(rows){
  const limit=PROSE_ASSISTANT_HISTORY_LIMITS;if(!Array.isArray(rows)||rows.length>limit.turns)fail();let characters=0,last=0;
  for(const row of rows){
    if(!exact(row,['id','user','assistant','status','reference'])||!Number.isSafeInteger(row.id)||row.id<=last||!text(row.user,limit.question)||!row.user.trim()
      ||!text(row.assistant,limit.reply)||!['complete','failed','cancelled'].includes(row.status)||row.status==='complete'&&!row.assistant.trim())fail();
    if(row.reference!==null){const r=row.reference;
      if(!exact(r,['floor','replyId','mode','range'])||!Number.isSafeInteger(r.floor)||r.floor<0||typeof r.replyId!=='string'||!/^swipe:(0|[1-9][0-9]*)$/.test(r.replyId)||!Number.isSafeInteger(Number(r.replyId.slice(6)))
        ||!['floor','selection'].includes(r.mode)||!exact(r.range,['start','end'])||!Number.isSafeInteger(r.range.start)||!Number.isSafeInteger(r.range.end)||r.range.start<0||r.mode==='floor'&&r.range.start!==0||r.range.end<=r.range.start||r.range.end>200000)fail();
    }
    last=row.id;characters+=row.user.length+row.assistant.length;if(characters>limit.characters)throw error('capacity','助手历史达到单会话容量上限，未截断或覆盖原记录');
  }
}
export function emptyProseAssistantHistory(key){return {version:1,namespace:proseAssistantHistoryKey(key),revision:0,updatedAt:0,rows:[]};}
export function validateProseAssistantHistory(value,key){
  proseAssistantHistoryKey(key);
  if(!exact(value,['version','namespace','revision','updatedAt','rows'])||value.version!==1||value.namespace!==key||!Number.isSafeInteger(value.revision)||value.revision<0
    ||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||value.updatedAt>253402214400000)fail();
  rowsValid(value.rows);if(value.revision===0&&(value.rows.length||value.updatedAt!==0))fail();
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>PROSE_ASSISTANT_HISTORY_LIMITS.bytes)throw error('capacity','助手历史超过单会话记录上限，未截断原文');return value;
}
export function measureProseAssistantHistory(value,key,namespace){
  proseAssistantHistoryKey(key,account(namespace));const state=validateProseAssistantHistory(value,key);
  return Object.freeze({bytes:new TextEncoder().encode(JSON.stringify(state)).byteLength,count:state.rows.length,
    complete:state.rows.filter(row=>row.status==='complete').length,failed:state.rows.filter(row=>row.status==='failed').length,cancelled:state.rows.filter(row=>row.status==='cancelled').length});
}
export function validateProseAssistantCleanupPlan(value,namespace){
  account(namespace);if(!exact(value,['version','namespace','entries'])||value.version!==1||value.namespace!==namespace||!Array.isArray(value.entries)||value.entries.length>10000)fail();
  const seen=new Set();for(const entry of value.entries){
    if(!exact(entry,['key','revision','updatedAt','count','bytes']))fail();proseAssistantHistoryKey(entry.key,namespace);
    if(seen.has(entry.key)||!Number.isSafeInteger(entry.revision)||entry.revision<1||entry.revision>=Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(entry.updatedAt)||entry.updatedAt<0||entry.updatedAt>253402214400000
      ||!Number.isSafeInteger(entry.count)||entry.count<1||entry.count>PROSE_ASSISTANT_HISTORY_LIMITS.turns||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>PROSE_ASSISTANT_HISTORY_LIMITS.bytes)fail();seen.add(entry.key);
  }return value;
}
export {error as proseAssistantHistoryError,account as proseAssistantHistoryAccount};
