import {partitionTextCollectionMutations,TEXT_COLLECTION_BULK_LIMITS} from './qianmu-text-collection-bulk-contract.js';

// One click targets the exact, freshly read revisions on this floor. A batch
// rejects on any stale revision; it never widens its scope or rebases a retry.
export async function deleteTextCollectionFloor({session,chatId,messageId,check=()=>{},onProgress=()=>{}}={}){
  if(!session||typeof session.sources!=='function'||typeof session.prepareDelete!=='function'||typeof session.prepareBatch!=='function'
    ||typeof session.guard!=='function'||typeof check!=='function'||typeof onProgress!=='function')throw new TypeError('收藏楼层删除环境无效');
  const guard=async()=>{check();await session.guard();check();};
  await guard();
  const result=await session.sources({revalidate:true});await guard();
  if(result?.expectedAccount!==session.expectedAccount||!Array.isArray(result.items)||result.items.length>10000)
    throw Error('收藏楼层清单不完整，未执行删除');
  const rows=[],ids=new Set();
  for(const row of result.items){
    if(row?.account!==session.expectedAccount||row.chatId!==chatId||row.messageId!==messageId)continue;
    if(typeof row.id!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(row.id)||!Number.isSafeInteger(row.revision)||row.revision<1||ids.has(row.id))
      throw Error('收藏楼层清单不完整或重复，未执行删除');
    ids.add(row.id);rows.push(row);
  }
  if(!rows.length)return {total:0,confirmed:0};
  const operations=rows.map(row=>session.prepareDelete(row.id,row.revision));
  const mutations=operations.map(operation=>operation.request),handles=new Map(operations.map(operation=>[operation.request.id,operation]));
  const batches=partitionTextCollectionMutations(mutations,{expectedAccount:session.expectedAccount,maxItems:TEXT_COLLECTION_BULK_LIMITS.items,maxBytes:TEXT_COLLECTION_BULK_LIMITS.bytes})
    .map(items=>items.length===1?handles.get(items[0].id):session.prepareBatch(items));
  let confirmed=0;
  for(const batch of batches){
    await guard();await batch.submit();confirmed+=batch.request.mutations?.length||1;
    onProgress({total:rows.length,confirmed});await guard();
  }
  return {total:rows.length,confirmed};
}
