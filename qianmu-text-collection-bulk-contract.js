import {TEXT_COLLECTION_SYNC_LIMITS,textCollectionSyncError as error,textCollectionSyncMutation,textCollectionSyncQuery,textCollectionSyncResponse} from './qianmu-text-collection-sync-contract.js';

export const TEXT_COLLECTION_BULK_LIMITS=Object.freeze({items:32,bytes:2*1024*1024});
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const fail=message=>{throw error('contract',message,400);};

// Separate endpoint preserves the strict legacy restore-info contract.
export const textCollectionBulkInfoRequest=value=>textCollectionSyncQuery(value,'restore-info');
export function textCollectionBulkInfoResponse(value,input){
  if(!exact(value,['ok','version','expectedAccount','libraryRevision','maxItems','maxBytes','remainingRecords','remainingMutations'])
    ||!Number.isSafeInteger(value.maxItems)||value.maxItems<1||value.maxItems>TEXT_COLLECTION_BULK_LIMITS.items
    ||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<1||value.maxBytes>TEXT_COLLECTION_BULK_LIMITS.bytes)fail('收藏批量保存能力无效，请更新千幕后端');
  const {maxItems,maxBytes,...base}=value;textCollectionSyncResponse({...base,restoreVersion:1},'restore-info',input);
  return Object.freeze({...value});
}

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

// Count bytes once per record, including JSON escaping and separator overhead.
// Partition only before submission; a retained batch must never be regrouped on retry.
export function partitionTextCollectionMutations(mutations,{expectedAccount,maxItems,maxBytes}){
  if(!Array.isArray(mutations)||mutations.length>TEXT_COLLECTION_SYNC_LIMITS.records||!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>TEXT_COLLECTION_BULK_LIMITS.items
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>TEXT_COLLECTION_BULK_LIMITS.bytes)fail('收藏分批范围无效');
  const encode=new TextEncoder(),overhead=encode.encode(JSON.stringify({version:1,expectedAccount,mutations:[]})).byteLength;
  const batches=[],ids=new Set(),operations=new Set();let current=[],bytes=overhead;
  for(const raw of mutations){
    const item=textCollectionSyncMutation(raw),size=encode.encode(JSON.stringify(item)).byteLength;
    if(item.expectedAccount!==expectedAccount||!['restore','delete'].includes(item.operation)||ids.has(item.id)||operations.has(item.mutationId))fail('收藏分批账户或目标重复');
    ids.add(item.id);operations.add(item.mutationId);
    if(size+overhead>maxBytes)fail('单条收藏超过后端单批上限，未开始恢复，也未截断原文');
    if(current.length&&(current.length===maxItems||bytes+size+1>maxBytes)){batches.push(Object.freeze(current));current=[];bytes=overhead;}
    bytes+=size+(current.length?1:0);current.push(item);
  }
  if(current.length)batches.push(Object.freeze(current));return Object.freeze(batches);
}
