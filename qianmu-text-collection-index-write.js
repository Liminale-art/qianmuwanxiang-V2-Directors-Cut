import {applyTextCollectionMutation,TEXT_COLLECTION_SYNC_LIMITS as limits,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';
import {createTextCollectionOriginalStore} from './qianmu-text-collection-original.js';

// Publish one lightweight index only after every changed complete original is
// durable. A conflicting/failed head leaves the old library and new bodies intact.
// Native ST remains optimistic, not CAS or simultaneous-device linearizability.
export async function writeIndexedCollection({store,expectedAccount,inputs,hashes,validate,check,now,options}={}){
  const before=await store.read('collections',options);await check();const state=validate(before.value);
  if(state.version!==2)throw error('changed','收藏目录格式已变化，请按最新目录重试');
  const originals=createTextCollectionOriginalStore({storage:store,expectedAccount}),next=structuredClone(state),acks=[],pending=[];
  const base=()=>({ok:true,version:1,expectedAccount,libraryRevision:next.revision});
  // Validate the entire bounded request before preserving any new body.
  for(let index=0;index<inputs.length;index++){
    await check();const input=inputs[index],fingerprint=hashes[index],prior=next.receipts.find(row=>row.mutationId===input.mutationId);
    if(prior){if(prior.hash!==fingerprint)throw error('mutation_conflict','收藏操作编号已对应其他内容');const {hash:ignored,...ack}=prior;acks.push(ack);continue;}
    const at=next.entries.findIndex(row=>row.id===input.id),row=at<0?null:next.entries[at];
    if(at<0&&next.entries.length>=limits.records||next.revision>=limits.mutations)throw error('capacity','收藏容量已满，原文未截断',507);
    if((row?.revision||0)!==input.baseRevision||row?.deleted)throw error('conflict','收藏已在其他设备变更，请重新载入；本机内容仍保留');
    const previous=row?await originals.read(row,options):null;await check();
    const entry=applyTextCollectionMutation(previous,input,now());
    // Temporary complete entries stay in this bounded preparation, never in a
    // published v2 index. They are replaced with verified descriptors below.
    const target=at<0?next.entries.length:at;if(at<0)next.entries.push(entry);else next.entries[at]=entry;
    pending.push({target,entry,previous:row});next.revision++;
    const ack={...base(),mutationId:input.mutationId,id:entry.id,revision:entry.revision,updatedAt:entry.updatedAt};next.receipts.push({...ack,hash:fingerprint});acks.push(ack);
  }
  if(!pending.length)return {verified:before,acknowledgements:{...base(),results:acks}};
  for(const item of pending){await check();next.entries[item.target]=item.entry.deleted?item.entry:await originals.preserve(item.entry,options);await check();}
  validate(next);await check();let acknowledgements;
  const prepared=new Map(pending.map(item=>[item.entry.id,{...item,descriptor:next.entries[item.target]}]));
  const verified=await store.update('collections',value=>{
    const current=validate(value);if(current.version!==2)throw error('changed','收藏目录格式已变化，未覆盖');
    const merged=structuredClone(current),results=[],common=()=>({ok:true,version:1,expectedAccount,libraryRevision:merged.revision});
    for(let i=0;i<inputs.length;i++){
      const input=inputs[i],fingerprint=hashes[i],receipt=merged.receipts.find(row=>row.mutationId===input.mutationId);
      if(receipt){if(receipt.hash!==fingerprint)throw error('mutation_conflict','收藏操作编号已对应其他内容');const {hash:ignored,...ack}=receipt;results.push(ack);continue;}
      const item=prepared.get(input.id),at=merged.entries.findIndex(row=>row.id===input.id),previous=at<0?null:merged.entries[at];
      if(!item||JSON.stringify(previous)!==JSON.stringify(item.previous))throw error('conflict','收藏已在其他设备变更，请重新载入；本机内容仍保留');
      if(at<0&&merged.entries.length>=limits.records||merged.revision>=limits.mutations)throw error('capacity','收藏容量已满，原文未截断',507);
      if(at<0)merged.entries.push(item.descriptor);else merged.entries[at]=item.descriptor;merged.revision++;
      const ack={...common(),mutationId:input.mutationId,id:item.entry.id,revision:item.entry.revision,updatedAt:item.entry.updatedAt};
      merged.receipts.push({...ack,hash:fingerprint});results.push(ack);
    }
    acknowledgements={...common(),results};return validate(merged);
  },options);await check();validate(verified.value);
  return {verified,acknowledgements};
}
