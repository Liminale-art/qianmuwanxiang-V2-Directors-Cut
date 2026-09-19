import {createAccountLocalStore} from './qianmu-account-local-store.js';
import {textCollectionSyncMutation,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';
import {textCollectionRecord,textCollectionRecordAccount} from './qianmu-text-collection.js';

export const TEXT_COLLECTION_OUTBOX_LIMITS=Object.freeze({rows:10000,bytes:64*1024*1024});
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const fail=message=>{throw error('local_storage',message,503);};
export function textCollectionOutboxAccount(value){
  if(typeof value!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value))throw error('account','尚未确认收藏待存账户',401);return value;
}

// Only explicitly saved content, not deferred destructive operations. An edited
// base keeps provenance for conflict recovery; neither request nor base is rebased.
export function textCollectionOutboxEntry(value,namespace){
  textCollectionOutboxAccount(namespace);
  if(!exact(value,['request','base','queuedAt','started','state'])||!Number.isSafeInteger(value.queuedAt)||value.queuedAt<0||value.queuedAt>253402214400000
    ||typeof value.started!=='boolean'||!['pending','conflict'].includes(value.state)||value.state==='conflict'&&!value.started)fail('收藏待存记录格式无效，未覆盖');
  const request=textCollectionSyncMutation(value.request);
  if(request.expectedAccount!==namespace||!['create','edit','restore'].includes(request.operation))fail('收藏待存账户或操作不一致；不排队执行删除');
  let base=null;
  if(request.operation==='edit'){
    base=textCollectionRecord(value.base);
    if(base.id!==request.id||base.revision!==request.baseRevision||textCollectionRecordAccount(base)!==namespace)fail('收藏待存编辑与原版本不一致');
  }else if(value.base!==null)fail('新增收藏不得混入其他原版本');
  return Object.freeze({request,base,queuedAt:value.queuedAt,started:value.started,state:value.state});
}
export function createTextCollectionOutboxEntry(request,{base=null,queuedAt=Date.now()}={}){
  return textCollectionOutboxEntry({request,base,queuedAt,started:false,state:'pending'},request?.expectedAccount);
}
export function emptyTextCollectionOutbox(namespace){return {version:1,namespace:textCollectionOutboxAccount(namespace),entries:[]};}
export function validateTextCollectionOutbox(value,namespace){
  textCollectionOutboxAccount(namespace);
  if(!exact(value,['version','namespace','entries'])||value.version!==1||value.namespace!==namespace||!Array.isArray(value.entries)||value.entries.length>TEXT_COLLECTION_OUTBOX_LIMITS.rows)fail('收藏本机待存库格式或账户不一致，未覆盖');
  const ids=new Set();for(const raw of value.entries){const entry=textCollectionOutboxEntry(raw,namespace);if(ids.has(entry.request.mutationId))fail('收藏待存操作编号重复，未覆盖');ids.add(entry.request.mutationId);}
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>TEXT_COLLECTION_OUTBOX_LIMITS.bytes)throw error('local_capacity','收藏本机待存达到安全上限，请保留内容并导出整理；未截断原文',507);
  return value;
}
export function summarizeTextCollectionOutbox(value){
  const state=validateTextCollectionOutbox(value,value?.namespace),conflicts=state.entries.filter(row=>row.state==='conflict').length;
  return Object.freeze({namespace:state.namespace,status:'ready',scope:'current-account-local',count:state.entries.length,pending:state.entries.length-conflicts,conflicts,
    bytes:state.entries.length?new TextEncoder().encode(JSON.stringify(state)).byteLength:0,estimated:true});
}
export function createTextCollectionOutboxStore({indexedDB=globalThis.indexedDB,dbName='qianmu-text-collection-outbox',timeoutMs=8000}={}){
  return createAccountLocalStore({indexedDB,dbName,timeoutMs,validateNamespace:textCollectionOutboxAccount,validate:validateTextCollectionOutbox,empty:emptyTextCollectionOutbox,error,label:'收藏待存'});
}
