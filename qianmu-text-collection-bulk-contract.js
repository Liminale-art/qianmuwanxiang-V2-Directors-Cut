import {TEXT_COLLECTION_SYNC_LIMITS,textCollectionSyncError as error,textCollectionSyncMutation,textCollectionSyncResponse} from './qianmu-text-collection-sync-contract.js';

export const TEXT_COLLECTION_BULK_LIMITS=Object.freeze({items:32,bytes:2*1024*1024});
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const fail=message=>{throw error('contract',message,400);};

// A bounded atomic batch of distinct records. Per-record mutation IDs and durable
// receipts remain the identity for retries; no second batch journal/file format.
export function textCollectionBulkRequest(value){
  if(!exact(value,['version','expectedAccount','mutations'])||value.version!==1||!Array.isArray(value.mutations)
    ||value.mutations.length<1||value.mutations.length>TEXT_COLLECTION_BULK_LIMITS.items)fail('收藏批量请求为空或超过单批上限');
  const ids=new Set(),operations=new Set();
  const mutations=Array.from(value.mutations,input=>{
    const item=textCollectionSyncMutation(input);
    if(item.expectedAccount!==value.expectedAccount||!['restore','delete'].includes(item.operation)||ids.has(item.id)||operations.has(item.mutationId))fail('收藏批量账户、目标或操作编号不一致');
    ids.add(item.id);operations.add(item.mutationId);return item;
  });
  const result={version:1,expectedAccount:value.expectedAccount,mutations:Object.freeze(mutations)};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>TEXT_COLLECTION_BULK_LIMITS.bytes)fail('收藏单批内容超过上限，请缩小批次；未截断原文');
  return Object.freeze(result);
}

export function textCollectionBulkResponse(value,input){
  const request=textCollectionBulkRequest(input);
  if(!exact(value,['ok','version','expectedAccount','libraryRevision','results'])||value.ok!==true||value.version!==1||value.expectedAccount!==request.expectedAccount
    ||!Number.isSafeInteger(value.libraryRevision)||value.libraryRevision<1||value.libraryRevision>TEXT_COLLECTION_SYNC_LIMITS.mutations
    ||!Array.isArray(value.results)||value.results.length!==request.mutations.length)fail('收藏批量回执不完整或账户不一致');
  const results=Array.from(value.results,(row,index)=>{
    const checked=textCollectionSyncResponse(row,'write',request.mutations[index]);
    if(checked.libraryRevision>value.libraryRevision)fail('收藏批量回执版本不一致');return checked;
  });
  return Object.freeze({...value,results:Object.freeze(results)});
}
