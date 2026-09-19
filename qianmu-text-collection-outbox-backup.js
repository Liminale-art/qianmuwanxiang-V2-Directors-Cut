import {TEXT_COLLECTION_OUTBOX_LIMITS,textCollectionOutboxEntry,validateTextCollectionOutbox} from './qianmu-text-collection-outbox-store.js';
import {textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';
import {assertJsonInputBounds,parseBoundedJson} from './qianmu-json-input.js';

const type='qianmu-text-collection-outbox',fields=['type','version','namespace','exportedAt','entries'];
export const TEXT_COLLECTION_OUTBOX_BACKUP_BYTES=TEXT_COLLECTION_OUTBOX_LIMITS.bytes+1024;
const bounds={maxBytes:TEXT_COLLECTION_OUTBOX_BACKUP_BYTES,maxDepth:16,maxNodes:500000,label:'收藏待存备份'};
const fail=message=>{throw error('pending_backup',message+'；未截断或覆盖本机内容',400);};

// Pending requests are not confirmed originals. Preserve their operation IDs;
// importing this format never grants authority to submit or change accounts.
export function validateTextCollectionOutboxBackup(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))
    ||value.type!==type||value.version!==1||!Number.isSafeInteger(value.exportedAt)||value.exportedAt<0||value.exportedAt>253402214400000)fail('收藏待存备份格式无效');
  validateTextCollectionOutbox({version:1,namespace:value.namespace,entries:value.entries},value.namespace);
  return Object.freeze({type,version:1,namespace:value.namespace,exportedAt:value.exportedAt,entries:Object.freeze(value.entries.map(row=>textCollectionOutboxEntry(row,value.namespace)))});
}
export function prepareTextCollectionOutboxBackup(state,{exportedAt=Date.now()}={}){
  validateTextCollectionOutbox(state,state?.namespace);
  const payload=validateTextCollectionOutboxBackup({type,version:1,namespace:state.namespace,exportedAt,entries:state.entries}),json=JSON.stringify(payload);
  assertJsonInputBounds(json,bounds);return Object.freeze({payload,blob:new Blob([json],{type:'application/json'}),count:payload.entries.length});
}
export async function readTextCollectionOutboxBackupFile(file,{check}={}){
  if(typeof check!=='function')throw TypeError('收藏待存备份需要当前页面校验');check();
  if(!file||typeof file.text!=='function'||!Number.isSafeInteger(file.size)||file.size<1||file.size>TEXT_COLLECTION_OUTBOX_BACKUP_BYTES)fail('收藏待存备份为空或超出大小上限');
  const raw=await file.text();check();const payload=validateTextCollectionOutboxBackup(parseBoundedJson(raw,bounds));check();return payload;
}
export function mergeTextCollectionOutboxBackup(state,input){
  validateTextCollectionOutbox(state,state?.namespace);const backup=validateTextCollectionOutboxBackup(input);
  if(backup.namespace!==state.namespace)throw error('account','待存请求属于另一账户，未猜测归属；请切回原账户导入',401);
  const rows=state.entries.map(row=>textCollectionOutboxEntry(row,state.namespace)),index=new Map(rows.map((row,at)=>[row.request.mutationId,at]));let added=0,duplicates=0;
  for(const incoming of backup.entries){
    const at=index.get(incoming.request.mutationId);
    if(at===undefined){index.set(incoming.request.mutationId,rows.length);rows.push(incoming);added++;continue;}
    const prior=rows[at];
    if(JSON.stringify(prior.request)!==JSON.stringify(incoming.request)||JSON.stringify(prior.base)!==JSON.stringify(incoming.base))throw error('local_conflict','同一待存编号对应不同内容，整个导入未执行，请保留双方备份');
    rows[at]={...prior,started:prior.started||incoming.started,state:prior.state==='conflict'||incoming.state==='conflict'?'conflict':'pending'};duplicates++;
  }
  const merged=validateTextCollectionOutbox({version:1,namespace:state.namespace,entries:rows},state.namespace);
  return Object.freeze({state:merged,added,duplicates});
}
