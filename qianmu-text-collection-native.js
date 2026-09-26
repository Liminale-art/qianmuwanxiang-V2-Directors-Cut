import {createConfiguredStAccountStorage,getStAccountStorageReadScope} from './qianmu-st-account-storage.js';
import {createTextCollectionClient} from './qianmu-text-collection-client.js';
import {textCollectionPreview} from './qianmu-text-collection.js';
import {validateTextCollectionBackup} from './qianmu-text-collection-backup.js';
import {TEXT_COLLECTION_SYNC_LIMITS as limits,textCollectionSyncError as error,textCollectionSyncMutation,textCollectionSyncQuery,textCollectionSyncResponse,applyTextCollectionMutation} from './qianmu-text-collection-sync-contract.js';
import {TEXT_COLLECTION_BULK_LIMITS,textCollectionBulkRequest,textCollectionBulkResponse,textCollectionBulkInfoResponse,textCollectionCleanupPlanResponse} from './qianmu-text-collection-bulk-contract.js';
import {validateNativeCollectionDocument} from './qianmu-text-collection-document.js';
import {createTextCollectionOriginalStore} from './qianmu-text-collection-original.js';
import {queryIndexedCollection} from './qianmu-text-collection-index-query.js';
import {writeIndexedCollection} from './qianmu-text-collection-index-write.js';
import {requestCollectionMigration} from './qianmu-text-collection-migration-idle.js';
import {createCollectionReadMemo} from './qianmu-text-collection-read-memo.js';

const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
const sessionSnapshots=new WeakMap();
const sourceKey=(state,row)=>JSON.stringify(state.version===2?row:[row.id,row.revision,row.record.source]);
function readSlot(scope,account){
  if(!scope)return {cache:null,epoch:0,writes:0};
  let pool=sessionSnapshots.get(scope);if(!pool){pool=new Map();sessionSnapshots.set(scope,pool);}
  // Only the currently authenticated account stays resident; switching back
  // requires reading again. No plaintext is written to browser persistence.
  if(!pool.has(account)){for(const prior of pool.values()){prior.cache=null;prior.memo?.clear();prior.sources?.clear();prior.epoch++;}pool.clear();}
  if(!pool.has(account)||pool.get(account).revoked)pool.set(account,{cache:null,epoch:0,writes:0});
  return pool.get(account);
}

// Native ST files are optimistic documents, not a cross-device transaction server.
// The response shape is shared with the UI; the capability is explicitly weaker.
export function createNativeTextCollectionClient({expectedAccount,guard,isCurrent,headers,storageFactory=createConfiguredStAccountStorage,legacyFactory=createTextCollectionClient,now=Date.now,readCacheMs=15000,readScope=storageFactory===createConfiguredStAccountStorage?getStAccountStorageReadScope():null}={}) {
  if(!Number.isFinite(readCacheMs)||readCacheMs<0||readCacheMs>30000)throw error('setup','收藏读取缓存配置无效',503);
  let closed=false,opening=null,storage=null,storageGuard,storageScope,format=1;const slot=readSlot(readScope,expectedAccount),legacy=legacyFactory({expectedAccount,guard,headers});
  slot.memo??=createCollectionReadMemo({now});
  slot.sources??=new Map();
  const check=async(options)=>{
    if(options?.signal?.aborted)throw error('cancelled','收藏读取已取消');
    const sameScope=()=>storageFactory!==createConfiguredStAccountStorage||readScope===getStAccountStorageReadScope();
    try{if(closed||slot.revoked||!sameScope()||await guard()===false||closed||slot.revoked||!sameScope())throw error('account','收藏账户或页面已变化',401);}catch(cause){if(!closed)invalidateReadCache();throw cause;}
    if(options?.signal?.aborted)throw error('cancelled','收藏读取已取消');return true;
  };
  const invalidateReadCache=()=>{slot.cache=null;slot.memo.clear();slot.sources.clear();slot.epoch++;};
  // Invalidate mutable directory/search state before a write, not every already
  // verified immutable original. The next confirmed directory selects exact
  // descriptors; writers still read their own fresh baseline from native ST.
  const invalidateDirectoryCache=()=>{slot.cache=null;slot.memo.clearSearch();slot.epoch++;};
  const rejectAccount=cause=>{if(cause?.code==='st_account_storage_account'||!closed&&cause?.code==='text_collection_sync_account'){slot.revoked=true;invalidateReadCache();}throw cause;};
  const available=()=>Boolean(slot.cache&&!slot.writes&&readCacheMs>0&&now()>=slot.cache.at&&now()-slot.cache.at<30*60*1000);
  const cached=()=>available()&&now()-slot.cache.at<readCacheMs;
  function considerMigration(state){if(state.version===1&&storageFactory===createConfiguredStAccountStorage)requestCollectionMigration({readScope,expectedAccount,slot});return state;}
  function remember(value,epoch,committed=false,fingerprint=null){
    const state=validate(value);let result=state;
    if(!closed&&epoch===slot.epoch&&(!slot.writes||committed)&&readCacheMs>0){
      slot.memo.retainOriginals(state.version===2?state.entries:[]);
      if(slot.sources.size){const live=new Set(state.entries.filter(row=>!row.deleted).map(row=>sourceKey(state,row)));
        for(const key of slot.sources.keys())if(!live.has(key))slot.sources.delete(key);}
      slot.cache=bytes(state)<=16*1024*1024?{state:structuredClone(state),at:now(),fingerprint,scope:storageScope}:null;
      result=slot.cache?.state||state;
    }return considerMigration(result);
  }
  function validate(value){
    const state=validateNativeCollectionDocument(value,{expectedAccount,scope:storageScope});format=state.version;return state;
  }
  async function open(options,writeScope=null){
    await check(options);if(storage)return storage;if(opening)return opening;
    const epoch=slot.epoch;
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
        // A reopened warm panel already knows this scope uses the v2 directory.
        // This is a format hint only: the writer's queued update still reads and
        // validates the current remote directory, including a format change.
        if(writeScope&&writeScope===candidate.scope){
          await check(options);storageScope=candidate.scope;storageGuard=candidateGuard;format=2;storage=candidate;return storage;
        }
        // A verified same-account snapshot needs only its head for a focus or
        // background recheck. A changed head still downloads the full document.
        if(options?.revalidate===true&&available()&&slot.cache.fingerprint&&slot.cache.scope===candidate.scope&&typeof candidate.readFingerprint==='function'){
          const fingerprint=await candidate.readFingerprint('collections',{...options,guard:candidateGuard});await check(options);
          if(fingerprint===slot.cache.fingerprint){storageScope=candidate.scope;storageGuard=candidateGuard;format=slot.cache.state.version;slot.cache.at=now();storage=candidate;return storage;}
        }
        let current=await candidate.read('collections',{...options,guard:candidateGuard});await check(options);
        if(!current.exists){
          let prior=null;try{prior=(await legacy.snapshot(options)).backup;}catch(cause){if(cause?.code!=='text_collection_sync_unavailable'||cause.upstreamStatus!==404)throw cause;}
          await check(options);
          if(prior)validateTextCollectionBackup(prior);
          const initial={version:prior?.records.length?1:2,expectedAccount,revision:prior?.libraryRevision||0,entries:(prior?.records||[]).map(record=>({id:record.id,revision:record.revision,updatedAt:record.updatedAt,deleted:false,record})),receipts:[],migration:{source:'qianmu-backend-v1',checkedAt:now(),records:prior?.records.length||0}};
          current=await candidate.write('collections',validate(initial),{...options,expectedFingerprint:null,guard:candidateGuard});
        }
        await check(options);storageScope=candidate.scope;remember(current.value,epoch,false,current.fingerprint);storageGuard=candidateGuard;storage=candidate;return storage;
      }catch(cause){candidate.close();throw cause;}
    })();try{return await opening;}finally{opening=null;}
  }
  const base=state=>({ok:true,version:1,expectedAccount,libraryRevision:state.revision});
  async function read(options){
    try{
    if(options?.forceRefresh===true)invalidateReadCache();
    await check(options);if(options?.revalidate!==true&&(cached()||options?.preferCache===true&&available()))return considerMigration(slot.cache.state);
    const epoch=slot.epoch,wasOpen=storage!==null,store=await open(options);
    await check(options);
    // Initial open has just verified this exact document; don't download it twice.
    if(!wasOpen&&cached())return slot.cache.state;
    if(options?.revalidate===true&&available()&&slot.cache.fingerprint&&slot.cache.scope===storageScope&&typeof store.readFingerprint==='function'){
      const fingerprint=await store.readFingerprint('collections',{...options,guard:storageGuard});await check(options);
      if(epoch!==slot.epoch){if(available())return slot.cache.state;throw error('changed','收藏目录已更新，请刷新后查看');}
      if(fingerprint===slot.cache.fingerprint){slot.cache.at=now();return considerMigration(slot.cache.state);}
    }
    const result=await store.read('collections',{...options,guard:storageGuard});await check(options);
    if(!result.exists){invalidateReadCache();throw error('missing','收藏资料已变化，请重新打开');}
    if(epoch!==slot.epoch){if(available())return slot.cache.state;throw error('changed','收藏目录已更新，请刷新后查看');}
    return remember(result.value,epoch,false,result.fingerprint);
    }catch(cause){return rejectAccount(cause);}
  }
  async function mutate(inputs,options){
    inputs=inputs.map(input=>structuredClone(textCollectionSyncMutation(input)));
    for(const input of inputs){if(input.expectedAccount!==expectedAccount)throw error('account','收藏保存账户不一致',401);}
    const writeScope=available()&&slot.cache.state.version===2?slot.cache.scope:null;
    invalidateDirectoryCache();slot.writes++;
    try{
    const hashes=await Promise.all(inputs.map(hash)),store=await open(options,writeScope);let acknowledgements;
    const legacyWrite=()=>store.update('collections',value=>{
      const state=validate(value);if(state.version===2)throw error('layout','收藏已使用轻目录');
      const next=structuredClone(state),acks=[];
      for(let index=0;index<inputs.length;index++){
        const input=inputs[index],fingerprint=hashes[index],prior=next.receipts.find(row=>row.mutationId===input.mutationId);
        if(prior){if(prior.hash!==fingerprint)throw error('mutation_conflict','收藏操作编号已对应其他内容');const {hash:ignored,...ack}=prior;acks.push(ack);continue;}
        const at=next.entries.findIndex(row=>row.id===input.id),previous=at<0?null:next.entries[at];
        if(at<0&&next.entries.length>=limits.records||next.revision>=limits.mutations)throw error('capacity','收藏容量已满，原文未截断',507);
        const entry=applyTextCollectionMutation(previous,input,now());if(at<0)next.entries.push(entry);else next.entries[at]=entry;next.revision++;
        const ack={...base(next),mutationId:input.mutationId,id:entry.id,revision:entry.revision,updatedAt:entry.updatedAt};next.receipts.push({...ack,hash:fingerprint});acks.push(ack);
      }
      acknowledgements={...base(next),results:acks};return validate(next);
    },{...options,guard:storageGuard});
    const indexedWrite=async()=>{const result=await writeIndexedCollection({store,expectedAccount,inputs,hashes,validate,check:()=>check(options),now,options:{...options,guard:storageGuard}});
      acknowledgements=result.acknowledgements;return result.verified;};
    let verified;
    if(format===2)verified=await indexedWrite();
    else try{verified=await legacyWrite();}catch(cause){if(cause?.code!=='text_collection_sync_layout')throw cause;verified=await indexedWrite();}
    await check(options);remember(verified.value,++slot.epoch,true,verified.fingerprint);return acknowledgements;
    }catch(cause){invalidateReadCache();return rejectAccount(cause);}finally{slot.writes--;}
  }
  async function query(method,input={},options){
    input=structuredClone(input);
    const request={version:1,expectedAccount,...input};if(!['batch-info','cleanup-plan'].includes(method))textCollectionSyncQuery(request,method);
    const state=await read(['list','get'].includes(method)?options:{...options,forceRefresh:true}),common=base(state),remainingRecords=limits.records-state.entries.length,remainingMutations=limits.mutations-state.revision;let response;
    if(state.version===2&&['list','get','inventory','snapshot'].includes(method)){
      const epoch=slot.epoch;
      const current=async()=>{await check(options);if(epoch!==slot.epoch)throw error('changed','收藏目录已变化，未采用旧原件');};
      try{
        let originals;const memo=readCacheMs>0&&['list','get'].includes(method)&&options?.forceRefresh!==true&&options?.revalidate!==true?slot.memo:null;
        const readEntry=async row=>{await current();const hit=memo?.getOriginal(row);if(hit){await current();return hit;}
          if(!originals)originals=createTextCollectionOriginalStore({storage:await open(options),expectedAccount});
          await current();const entry=await originals.read(row,{...options,guard:storageGuard});await current();memo?.rememberOriginal(row,entry);return entry;};
        response=await queryIndexedCollection(state,method,input,{common,expectedAccount,now,readEntry,check:current,memo});
        await current();return textCollectionSyncResponse(response,method,request);
      }catch(cause){return rejectAccount(cause);}
    }
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
  // Floor stars are a browsing index, never an export. Do not invalidate the
  // list snapshot or build a backup of every original just to paint an icon.
  async function sources(options){
    try{
    const state=await read(options),epoch=slot.epoch,items=[],liveKeys=new Set(),missing=[];let originals,index=0;
    const current=async()=>{await check(options);if(epoch!==slot.epoch)throw error('changed','收藏目录已变化，请重试');};
    const append=(row,key,provenance)=>{
      const source=Object.freeze({id:row.id,revision:row.revision,account:provenance.account,chatId:provenance.chatId,messageId:provenance.messageId});
      slot.sources.set(key,source);items.push({...source});
    };
    const flush=async()=>{
      if(!missing.length)return;
      await current();originals??=createTextCollectionOriginalStore({storage:await open(options),expectedAccount});
      const entries=await originals.readMany(missing.map(item=>item.row),{...options,guard:storageGuard});await current();
      for(let i=0;i<missing.length;i++){
        const {row,key}=missing[i],entry=entries[i];slot.memo.rememberOriginal(row,entry);append(row,key,entry.record.source);
      }
      missing.length=0;
    };
    for(const row of state.entries){
      if(row.deleted)continue;
      // Metadata-only cache hits do not each need their own HTTP identity probe.
      // Yield/check in bounded batches; original reads still check individually.
      if(index++%64===0){await new Promise(resolve=>setTimeout(resolve,0));await current();}
      const key=sourceKey(state,row);liveKeys.add(key);
      const source=slot.sources.get(key);
      if(source){await flush();items.push({...source});continue;}
      if(state.version!==2){await flush();append(row,key,row.record.source);continue;}
      const entry=slot.memo.getOriginal(row);
      if(entry){await flush();append(row,key,entry.record.source);continue;}
      missing.push({row,key});if(missing.length===4)await flush();
    }
    await flush();
    await current();for(const key of slot.sources.keys())if(!liveKeys.has(key))slot.sources.delete(key);
    return {expectedAccount,items};
    }catch(cause){return rejectAccount(cause);}
  }
  // A completed write already verified its directory. Reuse only that fresh,
  // exact in-memory directory for immediate floor feedback; missing provenance
  // remains unknown and never triggers another directory/original request.
  async function knownFloorState(chatId,messageId){
    if(typeof chatId!=='string'||!chatId||!Number.isSafeInteger(messageId)||messageId<0)return null;
    const epoch=slot.epoch;
    try{
      await check();if(epoch!==slot.epoch||!cached())return null;
      const state=slot.cache.state;let saved=false,unknown=false;
      for(const row of state.entries){
        if(row.deleted)continue;
        const provenance=slot.sources.get(sourceKey(state,row))||
          (state.version===2?slot.memo.getOriginal(row)?.record.source:row.record.source);
        if(!provenance){unknown=true;continue;}
        if(provenance.account===expectedAccount&&provenance.chatId===chatId&&provenance.messageId===messageId)saved=true;
      }
      await check();
      if(epoch!==slot.epoch||!cached()||slot.cache.state!==state)return null;
      return unknown?null:saved;
    }catch(cause){return rejectAccount(cause);}
  }
  return Object.freeze({persistence:'st-account-file',concurrency:'optimistic-non-cas',invalidateReadCache,readCacheNeedsRefresh:()=>available()&&!cached(),
    sources,knownFloorState,
    list:(input={cursor:null,limit:50},options)=>query('list',input,options),get:(id,options)=>query('get',{id},options),
    snapshot:options=>query('snapshot',{},options),inventory:options=>query('inventory',{},options),restoreInfo:options=>query('restore-info',{},options),batchInfo:options=>query('batch-info',{},options),cleanupPlan:options=>query('cleanup-plan',{},options),
    async write(input,options){return textCollectionSyncResponse((await mutate([input],options)).results[0],'write',input);},
    async writeBatch(input,options){const request=textCollectionBulkRequest(input);return textCollectionBulkResponse(await mutate(request.mutations,options),request);},
    close(){closed=true;if(!readScope)invalidateReadCache();legacy.close();storage?.close();}});
}
