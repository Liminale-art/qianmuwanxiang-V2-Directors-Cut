import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {createTextCollectionClient} from './qianmu-text-collection-client.js';
import {textCollectionPreview} from './qianmu-text-collection.js';
import {validateTextCollectionBackup} from './qianmu-text-collection-backup.js';
import {TEXT_COLLECTION_SYNC_LIMITS as limits,textCollectionSyncError as error,textCollectionSyncEntry,textCollectionSyncMutation,textCollectionSyncQuery,textCollectionSyncResponse,applyTextCollectionMutation} from './qianmu-text-collection-sync-contract.js';
import {TEXT_COLLECTION_BULK_LIMITS,textCollectionBulkRequest,textCollectionBulkResponse,textCollectionBulkInfoResponse,textCollectionCleanupPlanResponse} from './qianmu-text-collection-bulk-contract.js';

const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');

// Native ST files are optimistic documents, not a cross-device transaction server.
// The response shape is shared with the UI; the capability is explicitly weaker.
export function createNativeTextCollectionClient({expectedAccount,guard,isCurrent,headers,storageFactory=createConfiguredStAccountStorage,legacyFactory=createTextCollectionClient,now=Date.now,readCacheMs=15000}={}) {
  if(!Number.isFinite(readCacheMs)||readCacheMs<0||readCacheMs>30000)throw error('setup','收藏读取缓存配置无效',503);
  let closed=false,opening=null,storage=null,storageGuard,cache=null,cacheEpoch=0,writes=0;const legacy=legacyFactory({expectedAccount,guard,headers});
  const check=async(options)=>{
    if(options?.signal?.aborted)throw error('cancelled','收藏读取已取消');
    if(closed||await guard()===false||closed)throw error('account','收藏账户或页面已变化',401);
    if(options?.signal?.aborted)throw error('cancelled','收藏读取已取消');return true;
  };
  const invalidateReadCache=()=>{cache=null;cacheEpoch++;};
  const cached=()=>cache&&!writes&&readCacheMs>0&&now()>=cache.at&&now()-cache.at<readCacheMs;
  function remember(value,epoch){const state=validate(value);if(!closed&&epoch===cacheEpoch&&readCacheMs>0)cache={state:structuredClone(state),at:now()};return state;}
  function validate(value){
    if(!value||value.version!==1||value.expectedAccount!==expectedAccount||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>limits.mutations||!Array.isArray(value.entries)||value.entries.length>limits.records||!Array.isArray(value.receipts)||value.receipts.length>limits.mutations)throw error('corrupt','收藏资料校验失败，原件未覆盖',503);
    const ids=new Set();for(const entry of value.entries){textCollectionSyncEntry(entry,expectedAccount);if(ids.has(entry.id)||entry.revision>value.revision)throw error('corrupt','收藏编号或版本不一致',503);ids.add(entry.id);}
    const receipts=new Set();for(const row of value.receipts){if(!row||Object.keys(row).sort().join(',')!=='expectedAccount,hash,id,libraryRevision,mutationId,ok,revision,updatedAt,version'||row.ok!==true||row.version!==1
      ||!/^[A-Za-z0-9_-]{8,120}$/.test(row.mutationId)||!/^[A-Za-z0-9_-]{8,120}$/.test(row.id)||!ids.has(row.id)
      ||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.libraryRevision)||row.libraryRevision<row.revision||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<0||row.updatedAt>253402214400000
      ||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)||receipts.has(row.mutationId)||row.libraryRevision>value.revision||row.expectedAccount!==expectedAccount)throw error('corrupt','收藏保存凭据不一致',503);receipts.add(row.mutationId);}
    if(bytes(value)>limits.bytes)throw error('capacity','收藏超过当前储存容量，未截断原文',507);return value;
  }
  async function open(options){
    await check(options);if(storage)return storage;if(opening)return opening;
    const epoch=cacheEpoch;
    opening=(async()=>{
      const candidate=await storageFactory({maxBytes:limits.bytes,isCurrent:()=>!closed&&(!isCurrent||isCurrent()===true)});
      try{
        let candidateGuard=()=>check();
        if(typeof isCurrent==='function'&&typeof candidate.namespace==='string'){
          // Native storage already rechecks its captured account at every transport
          // boundary. Verify that account once before using a lifecycle-only guard,
          // rather than nesting the same asynchronous account resolver three times.
          if(!candidate.namespace.startsWith('st-user:'))throw error('account','收藏储存账户不一致',401);
          const owner='st-user:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(candidate.namespace.slice(8)))),byte=>byte.toString(16).padStart(2,'0')).join('');
          if(owner!==expectedAccount)throw error('account','收藏储存账户不一致',401);
          await check(options);candidateGuard=()=>!closed&&isCurrent()===true;
        }
        let current=await candidate.read('collections',{...options,guard:candidateGuard});await check(options);
        if(!current.exists){
          let prior=null;try{prior=(await legacy.snapshot(options)).backup;}catch(cause){if(cause?.code!=='text_collection_sync_unavailable'||cause.upstreamStatus!==404)throw cause;}
          await check(options);
          if(prior)validateTextCollectionBackup(prior);
          const initial={version:1,expectedAccount,revision:prior?.libraryRevision||0,entries:(prior?.records||[]).map(record=>({id:record.id,revision:record.revision,updatedAt:record.updatedAt,deleted:false,record})),receipts:[],migration:{source:'qianmu-backend-v1',checkedAt:now(),records:prior?.records.length||0}};
          current=await candidate.write('collections',validate(initial),{...options,expectedFingerprint:null,guard:candidateGuard});
        }
        await check(options);remember(current.value,epoch);storageGuard=candidateGuard;storage=candidate;return storage;
      }catch(cause){candidate.close();throw cause;}
    })();try{return await opening;}finally{opening=null;}
  }
  const base=state=>({ok:true,version:1,expectedAccount,libraryRevision:state.revision});
  async function read(options){
    if(options?.forceRefresh===true)invalidateReadCache();
    await check(options);if(cached())return cache.state;
    const epoch=cacheEpoch,wasOpen=storage!==null,store=await open(options);
    await check(options);
    // Initial open has just verified this exact document; don't download it twice.
    if(!wasOpen&&cached())return cache.state;
    const result=await store.read('collections',{...options,guard:storageGuard});await check(options);
    if(!result.exists){invalidateReadCache();throw error('missing','收藏资料已变化，请重新打开');}
    return remember(result.value,epoch);
  }
  async function mutate(inputs,options){
    inputs=inputs.map(input=>structuredClone(textCollectionSyncMutation(input)));
    for(const input of inputs){if(input.expectedAccount!==expectedAccount)throw error('account','收藏保存账户不一致',401);}
    invalidateReadCache();const epoch=cacheEpoch;writes++;
    try{
    const hashes=await Promise.all(inputs.map(hash)),store=await open(options);let acknowledgements;
    const verified=await store.update('collections',value=>{
      const state=validate(value),next=structuredClone(state),acks=[];
      for(let index=0;index<inputs.length;index++){
        const input=inputs[index],fingerprint=hashes[index],prior=next.receipts.find(row=>row.mutationId===input.mutationId);
        if(prior){if(prior.hash!==fingerprint)throw error('mutation_conflict','收藏操作编号已对应其他内容');const {hash:ignored,...ack}=prior;acks.push(ack);continue;}
        const at=next.entries.findIndex(row=>row.id===input.id),previous=at<0?null:next.entries[at];
        if(at<0&&next.entries.length>=limits.records||next.revision>=limits.mutations)throw error('capacity','收藏容量已满，原文未截断',507);
        const entry=applyTextCollectionMutation(previous,input,now());if(at<0)next.entries.push(entry);else next.entries[at]=entry;next.revision++;
        const ack={...base(next),mutationId:input.mutationId,id:entry.id,revision:entry.revision,updatedAt:entry.updatedAt};next.receipts.push({...ack,hash:fingerprint});acks.push(ack);
      }
      acknowledgements={...base(next),results:acks};return validate(next);
    },{...options,guard:storageGuard});await check(options);remember(verified.value,epoch);return acknowledgements;
    }catch(cause){invalidateReadCache();throw cause;}finally{writes--;}
  }
  async function query(method,input={},options){
    input=structuredClone(input);
    const request={version:1,expectedAccount,...input};if(!['batch-info','cleanup-plan'].includes(method))textCollectionSyncQuery(request,method);
    const state=await read(['list','get'].includes(method)?options:{...options,forceRefresh:true}),common=base(state),remainingRecords=limits.records-state.entries.length,remainingMutations=limits.mutations-state.revision;let response;
    if(method==='get')response={...common,record:state.entries.find(row=>row.id===input.id&&!row.deleted)?.record||null};
    else if(method==='snapshot')response={...common,backup:validateTextCollectionBackup({type:'qianmu-text-collections',version:1,sourceAccount:expectedAccount,exportedAt:now(),libraryRevision:state.revision,records:state.entries.filter(row=>!row.deleted).map(row=>row.record)})};
    else if(method==='inventory'){const live=state.entries.filter(row=>!row.deleted);response={...common,state:'present',count:live.length,deletedCount:state.entries.length-live.length,bytes:bytes(state),textBytes:live.reduce((sum,row)=>sum+new TextEncoder().encode(row.record.text).byteLength,0)};}
    else if(method==='restore-info')response={...common,restoreVersion:1,remainingRecords,remainingMutations};
    else if(method==='batch-info')return textCollectionBulkInfoResponse({...common,maxItems:TEXT_COLLECTION_BULK_LIMITS.items,maxBytes:TEXT_COLLECTION_BULK_LIMITS.bytes,remainingRecords,remainingMutations},request);
    else if(method==='cleanup-plan'){const items=state.entries.filter(row=>!row.deleted).map(({id,revision})=>({id,revision}));return textCollectionCleanupPlanResponse({...common,total:items.length,items},request);}
    else{
      if(input.cursor&&input.cursor.revision!==state.revision)throw error('changed','收藏目录已更新，请重新载入');
      const term=(input.search||'').trim().toLowerCase(),filtered=Object.hasOwn(input,'search')?{search:input.search.trim()}:{};
      const rows=state.entries.filter(row=>!row.deleted&&(!term||[row.record.text,row.record.source.charName,row.record.source.userName].some(value=>value.toLowerCase().includes(term)))).sort((a,b)=>b.record.createdAt-a.record.createdAt||a.id.localeCompare(b.id));
      const offset=input.cursor?.offset||0,items=rows.slice(offset,offset+input.limit).map(({record})=>({id:record.id,revision:record.revision,createdAt:record.createdAt,updatedAt:record.updatedAt,charName:record.source.charName,userName:record.source.userName,mode:record.mode,preview:textCollectionPreview(record)}));
      const next=offset+items.length;response={...common,...filtered,items,total:rows.length,nextCursor:next<rows.length?{revision:state.revision,offset:next,...filtered}:null};
    }
    return textCollectionSyncResponse(response,method,request);
  }
  return Object.freeze({persistence:'st-account-file',concurrency:'optimistic-non-cas',invalidateReadCache,
    list:(input={cursor:null,limit:50},options)=>query('list',input,options),get:(id,options)=>query('get',{id},options),
    snapshot:options=>query('snapshot',{},options),inventory:options=>query('inventory',{},options),restoreInfo:options=>query('restore-info',{},options),batchInfo:options=>query('batch-info',{},options),cleanupPlan:options=>query('cleanup-plan',{},options),
    async write(input,options){return textCollectionSyncResponse((await mutate([input],options)).results[0],'write',input);},
    async writeBatch(input,options){const request=textCollectionBulkRequest(input);return textCollectionBulkResponse(await mutate(request.mutations,options),request);},
    close(){closed=true;invalidateReadCache();legacy.close();storage?.close();}});
}
