import {VIBE_ENCODING_MODELS,retainVibeAssetRef} from './qianmu-vibe-asset-ref.js';
import {novelVibeEncodeEndpoint} from './qianmu-vibe-encoding.js';
import {validateVibeEncodingDelivery,checkReviewSource,checkReviewHistory,validateVibeReviewArchive,createVibeReviewSegment,resolveVibeReviewHistory,checkCombinedVibeReviews,VIBE_REVIEW_SEGMENT_LIMIT} from './qianmu-vibe-history.js';
export {validateVibeEncodingDelivery} from './qianmu-vibe-history.js';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const attempt=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(value);
const fail=(code,message)=>Object.assign(new Error(message),{code:`vibe_encoding_cache_${code}`,submissionState:'not_submitted'});
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const key=(namespace,cacheKey)=>{if(!account(namespace)||!hash(cacheKey))throw fail('identity','编码缓存账户或编号无效');return JSON.stringify([namespace,cacheKey]);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const equalReceipt=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const VIBE_ENCODING_RECEIPT_LIMIT=2048;
export const VIBE_ENCODING_ARCHIVE_LIMIT=16384;
const ARCHIVE_BYTES=64*1024*1024;
const receiptBytes=row=>new TextEncoder().encode(JSON.stringify(row)).byteLength;
export function validateVibeServiceDelivery(value){
  if(!object(value)||value.version!==1||!hash(value.channelKey)||!attempt(value.clientAttemptId)
    ||Object.keys(value).some(key=>!['version','channelKey','clientAttemptId'].includes(key)))throw fail('identity','服务编码原提交凭据无效');
  return {version:1,channelKey:value.channelKey,clientAttemptId:value.clientAttemptId};
}
export function matchesVibeServiceDelivery(row,serviceAttemptId,serviceDelivery){
  if(serviceDelivery!==undefined)validateVibeServiceDelivery(serviceDelivery);
  return row?.delivery?.transport==='service'&&row.delivery.serviceAttemptId===serviceAttemptId
    &&row.delivery.channelKey===serviceDelivery?.channelKey&&row.attemptId===serviceDelivery?.clientAttemptId;
}

export async function validateVibeEncodingIdentity(identity,cacheKey){
  if(!object(identity)||Object.keys(identity).some(k=>!['version','endpoint','remoteModelId','capabilityModelId','encodingModel','sourceId','parameters'].includes(k))
    ||identity.version!==1||!hash(identity.sourceId)||typeof identity.remoteModelId!=='string'||!identity.remoteModelId||identity.remoteModelId.trim()!==identity.remoteModelId||identity.remoteModelId.length>240||/[\u0000-\u001f\u007f]/.test(identity.remoteModelId)
    ||!VIBE_ENCODING_MODELS[identity.capabilityModelId]||VIBE_ENCODING_MODELS[identity.capabilityModelId]!==identity.encodingModel
    ||!object(identity.parameters)||Object.keys(identity.parameters).length!==1||typeof identity.parameters.information_extracted!=='number'||!Number.isFinite(identity.parameters.information_extracted)
    ||identity.parameters.information_extracted<0||identity.parameters.information_extracted>1||novelVibeEncodeEndpoint(identity.endpoint)!==identity.endpoint)throw fail('identity','编码缓存参数无效');
  // Canonical field order, no credentials or source bytes. This matches prepareNovelVibeEncoding.
  const value={version:1,endpoint:identity.endpoint,remoteModelId:identity.remoteModelId,capabilityModelId:identity.capabilityModelId,encodingModel:identity.encodingModel,
    sourceId:identity.sourceId,parameters:{information_extracted:identity.parameters.information_extracted}};
  if(!hash(cacheKey)||await digest(JSON.stringify(value))!==cacheKey)throw fail('identity','编码缓存指纹不匹配');return value;
}

function normalizeVibeEncodingReceipt(row,namespace,cacheKey){
  if(!row)return null;
  if(Object.keys(row).some(name=>!['key','namespace','cacheKey','identity','attemptId','status','revision','createdAt','updatedAt','assetRef','sourceAssetRef','delivery','feeReview','pastReviews','reviewArchive'].includes(name))
    ||row.key!==key(namespace,cacheKey)||row.namespace!==namespace||row.cacheKey!==cacheKey||!attempt(row.attemptId)
    ||!['reserved','submitting','ready','rejected','unknown','reviewed'].includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<1
    ||![row.createdAt,row.updatedAt].every(value=>Number.isFinite(value)&&value>=0)||row.updatedAt<row.createdAt||!object(row.identity))throw fail('corrupt','编码记录不完整，请先保全数据');
  if(row.status==='ready'&&(retainVibeAssetRef(row.assetRef).invalid||row.assetRef.namespace!==namespace))throw fail('corrupt','编码原资产引用失效');
  if(row.status!=='ready'&&row.assetRef)throw fail('corrupt','未完成编码含错误资产引用');
  if(row.sourceAssetRef&&(retainVibeAssetRef(row.sourceAssetRef).invalid||row.sourceAssetRef.namespace!==namespace))throw fail('corrupt','原图资产归属不符');
  if(row.delivery!==undefined)validateVibeEncodingDelivery(row.delivery);
  if(row.status==='reviewed')checkReviewSource(row);else if(row.feeReview!==undefined)throw fail('corrupt','费用核查状态不符');
  if(row.pastReviews!==undefined)checkReviewHistory(row.pastReviews);if(row.reviewArchive!==undefined)validateVibeReviewArchive(row.reviewArchive);return row;
}
// Shared by durable reads and audit files. Validation never restores or authorizes a request.
export async function validateVibeEncodingReceipt(row,namespace,cacheKey){
  if(!object(row))throw fail('corrupt','编码记录不完整，请先保全数据');
  normalizeVibeEncodingReceipt(row,namespace,cacheKey);await validateVibeEncodingIdentity(row.identity,cacheKey);return row;
}

// Durable metadata only, with no expiry or implicit retry. A crashed submitting receipt remains uncertain.
export function createVibeEncodingStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-vibe-encodings',timeoutMs=8000,now=Date.now}={}){
  let db=null,opening=null,closed=false;const transactions=new Set(),timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000));
  const unavailable=()=>fail('storage','编码记录暂不可用，为避免重复计费，未授权新请求');
  function open(){
    if(closed)return Promise.reject(fail('closed','编码缓存会话已结束'));if(db)return Promise.resolve(db);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{let request,done=false;
      const finish=(error,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(fail('timeout','编码记录读取超时，未授权新请求')),timeout);
      try{request=indexedDB.open(dbName,3);}catch(_){finish(unavailable());return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction.abort();return;}
        for(const name of ['receipts','archive'])if(!request.result.objectStoreNames.contains(name)){const table=request.result.createObjectStore(name,{keyPath:'key'});table.createIndex('namespace','namespace');}
        if(!request.result.objectStoreNames.contains('archiveUsage'))request.result.createObjectStore('archiveUsage',{keyPath:'namespace'});
        if(!request.result.objectStoreNames.contains('reviewSegments')){const table=request.result.createObjectStore('reviewSegments',{keyPath:'key'});table.createIndex('namespace','namespace');table.createIndex('receipt',['namespace','cacheKey']);}
        if(!request.result.objectStoreNames.contains('reviewUsage'))request.result.createObjectStore('reviewUsage',{keyPath:'namespace'});
      };
      request.onerror=()=>finish(unavailable());request.onblocked=()=>finish(fail('blocked','编码记录正在升级，请关闭旧页面后重试'));
      request.onsuccess=()=>{if(done||closed){request.result.close();finish(fail('closed','编码缓存会话已结束'));return;}db=request.result;const opened=db;
        opened.onversionchange=()=>{opened.close();if(db===opened){db=null;opening=null;}};opened.onclose=()=>{if(db===opened){db=null;opening=null;}};finish(null,db);};
    });const current=opening;void current.catch(()=>{if(opening===current)opening=null;});return current;
  }
  async function transaction(mode,work){
    const database=await open();if(closed)throw fail('closed','编码缓存会话已结束');
    return new Promise((resolve,reject)=>{let tx,result,error,done=false;
      const finish=cause=>{if(done)return;done=true;clearTimeout(timer);transactions.delete(tx);cause?reject(cause):resolve(result);};
      const abort=cause=>{error=typeof cause?.code==='string'&&cause.code.startsWith('vibe_encoding_cache_')?cause:unavailable();try{tx.abort();}catch(_){finish(error);}};
      const timer=setTimeout(()=>{error=fail('timeout','编码记录保存未确认，未授权新请求');try{tx?.abort();}catch(_){}finish(error);},timeout);
      try{tx=database.transaction(['receipts','archive','archiveUsage','reviewSegments','reviewUsage'],mode);transactions.add(tx);}catch(_){finish(unavailable());return;}
      tx.oncomplete=()=>finish(closed?fail('closed','编码缓存会话已结束'):null);tx.onabort=()=>finish(error||unavailable());tx.onerror=()=>{error||=unavailable();};
      const read=(request,next)=>{request.onsuccess=()=>{if(done)return;try{if(closed)throw fail('closed','编码缓存会话已结束');next(request.result);}catch(cause){abort(cause);}};};
      try{work(tx.objectStore('receipts'),read,value=>result=value,tx.objectStore('archive'),tx.objectStore('archiveUsage'),tx.objectStore('reviewSegments'),tx.objectStore('reviewUsage'));}catch(cause){abort(cause);}
    });
  }
  const normalize=normalizeVibeEncodingReceipt;
  async function checked(row,namespace,cacheKey){if(!row)return null;normalize(row,namespace,cacheKey);await validateVibeEncodingIdentity(row.identity,cacheKey);return row;}
  const sameIdentity=(row,identity)=>{if(JSON.stringify(row.identity)!==JSON.stringify(identity))throw fail('corrupt','编码记录参数不一致，请先保全数据');};
  const completed=row=>{if(row&&row.status!=='ready')throw fail('corrupt','历史档案含未完成编码，请先保全数据');return row;};
  const readReceipt=(table,archive,read,id,next)=>read(table.get(id),current=>read(archive.get(id),old=>{
    if(current&&old)throw fail('corrupt','当前和历史记录重复，请先保全数据');next(current||completed(old));
  }));
  function readUsage(archive,usage,read,namespace,next){
    read(usage.get(namespace),saved=>read(archive.index('namespace').count(keyRange.only(namespace)),count=>{
      const value=saved||{namespace,count:0,bytes:0};
      if(!object(value)||Object.keys(value).some(k=>!['namespace','count','bytes'].includes(k))||value.namespace!==namespace||value.count!==count
        ||!Number.isSafeInteger(count)||count<0||count>VIBE_ENCODING_ARCHIVE_LIMIT||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>ARCHIVE_BYTES
        ||(count===0)!==(value.bytes===0))throw fail('corrupt','历史编码计值不一致，请先保全数据');
      next(value,saved);
    }));
  }
  function readReviewUsage(segments,usage,read,namespace,next){
    read(usage.get(namespace),saved=>read(segments.index('namespace').count(keyRange.only(namespace)),count=>{
      const value=saved||{namespace,count:0,bytes:0,reviews:0};
      if(!object(value)||Object.keys(value).some(k=>!['namespace','count','bytes','reviews'].includes(k))||value.namespace!==namespace||value.count!==count
        ||!Number.isSafeInteger(count)||count<0||count>4096||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>ARCHIVE_BYTES
        ||!Number.isSafeInteger(value.reviews)||value.reviews<count||value.reviews>count*32||(count===0)!==(value.bytes===0))throw fail('corrupt','核查明细计值不一致，请先保全数据');next(value,saved);
    }));
  }
  async function snapshot(namespace,cacheKey){
    const id=key(namespace,cacheKey),result=await transaction('readonly',(table,read,set,archive,_usage,segments)=>readReceipt(table,archive,read,id,receipt=>{
      read(segments.index('receipt').getAll(keyRange.only([namespace,cacheKey]),VIBE_REVIEW_SEGMENT_LIMIT+1),rows=>set({receipt:receipt||null,segments:rows}));
    }));
    await checked(result.receipt,namespace,cacheKey);
    const reviews=await resolveVibeReviewHistory(namespace,cacheKey,result.receipt?.reviewArchive,result.segments);checkCombinedVibeReviews(result.receipt,reviews);
    return {...result,reviews};
  }
  return Object.freeze({
    async get(namespace,cacheKey){return (await snapshot(namespace,cacheKey)).receipt;},
    async reviewHistory(namespace,cacheKey,expected){
      const result=await snapshot(namespace,cacheKey);if(!result.receipt||!equalReceipt(result.receipt,expected))throw fail('changed','核查明细对应记录已变化，请刷新');return result;
    },
    async compactReviews(namespace,cacheKey,expected,confirmed){
      if(confirmed!==true)throw fail('identity','尚未明确确认本次核查明细整理');
      expected=structuredClone(expected);const original=await snapshot(namespace,cacheKey),row=original.receipt;
      if(!row||!equalReceipt(row,expected))throw fail('changed','核查明细对应记录已变化，请刷新');
      if((row.pastReviews?.length||0)<16)throw fail('capacity','累积至少 16 次旧核查明细后可整理');
      if(original.segments.length>=VIBE_REVIEW_SEGMENT_LIMIT)throw fail('capacity','核查明细档案已满，原记录保留');
      const segment=await createVibeReviewSegment(namespace,cacheKey,row.reviewArchive||null,row.pastReviews),bytes=receiptBytes(segment),
        next={...row,reviewArchive:{version:1,id:segment.id,count:segment.count}};delete next.pastReviews;
      return transaction('readwrite',(table,read,set,archive,_usage,segments,usage)=>readReviewUsage(segments,usage,read,namespace,previous=>{
        if(previous.count>=4096||previous.bytes+bytes>ARCHIVE_BYTES)throw fail('capacity','核查明细档案已满，原记录保留');
        read(table.get(row.key),current=>{if(!equalReceipt(current,row))throw fail('changed','当前记录已变化或移入历史档案，未整理');
          read(archive.get(row.key),old=>{if(old)throw fail('corrupt','当前和历史记录重复，未整理');
            read(segments.index('receipt').count(keyRange.only([namespace,cacheKey])),count=>{if(count!==original.segments.length)throw fail('changed','核查明细已变化，未整理');
              segments.add(segment);usage.put({namespace,count:previous.count+1,bytes:previous.bytes+bytes,reviews:previous.reviews+row.pastReviews.length});table.put(next);
              set({receipt:next,moved:row.pastReviews.length});
            });
          });
        });
      }));
    },
    async list(namespace){if(!account(namespace))throw fail('identity','编码缓存账户无效');const rows=await transaction('readonly',(table,read,set)=>read(table.index('namespace').getAll(keyRange.only(namespace),VIBE_ENCODING_RECEIPT_LIMIT+1),set));
      if(rows.length>VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码记录过多，请先整理');for(const row of rows)await checked(row,namespace,row.cacheKey);return rows;},
    async archiveUsage(namespace){
      if(!account(namespace))throw fail('identity','编码缓存账户无效');
      return transaction('readonly',(_table,read,set,archive,usage)=>readUsage(archive,usage,read,namespace,set));
    },
    async inventory(namespace){
      if(!account(namespace))throw fail('identity','编码缓存账户无效');
      const snapshot=await transaction('readonly',(table,read,set,archive,usage,segments,reviewUsage)=>read(table.index('namespace').getAll(keyRange.only(namespace),VIBE_ENCODING_RECEIPT_LIMIT+1),receipts=>{
        if(receipts.length>VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码记录过多，请先整理');
        readUsage(archive,usage,read,namespace,(archived,archiveMeta)=>readReviewUsage(segments,reviewUsage,read,namespace,(reviewHistory,reviewMeta)=>set({receipts,archived,reviewHistory,
          metadata:{count:Number(Boolean(archiveMeta))+Number(Boolean(reviewMeta)),bytes:(archiveMeta?receiptBytes(archiveMeta):0)+(reviewMeta?receiptBytes(reviewMeta):0)}})));
      }));
      for(const row of snapshot.receipts)await checked(row,namespace,row.cacheKey);return snapshot;
    },
    async archivePage(namespace,{after=''}={}){
      if(!account(namespace)||after!==''&&!hash(after))throw fail('identity','历史编码分页无效');
      const page=await transaction('readonly',(_table,read,set,archive,usage)=>readUsage(archive,usage,read,namespace,totals=>{
        if(after==='f'.repeat(64)){set({rows:[],next:'',count:totals.count,bytes:totals.bytes});return;}
        const range=keyRange.bound(key(namespace,after||'0'.repeat(64)),key(namespace,'f'.repeat(64)),!!after,false);
        read(archive.getAll(range,41),rows=>set({rows:rows.slice(0,40),next:rows.length>40?rows[39].cacheKey:'',count:totals.count,bytes:totals.bytes}));
      }));
      for(const row of page.rows){completed(row);await checked(row,namespace,row.cacheKey);}return page;
    },
    async archiveCompleted(namespace,expected,confirmed){
      if(confirmed!==true||!account(namespace)||!Array.isArray(expected)||!expected.length||expected.length>40
        ||new Set(expected.map(row=>row?.cacheKey)).size!==expected.length)throw fail('identity','请选择并确认 1～40 条已完成编码归档');
      const rows=structuredClone(expected);
      for(const row of rows){if(!row||row.status!=='ready')throw fail('identity','仅已完成编码可归档；未决费用记录保留原位');await checked(row,namespace,row.cacheKey);
        if(!equalReceipt((await snapshot(namespace,row.cacheKey)).receipt,row))throw fail('changed','待归档记录已变化，请刷新');}
      const bytes=rows.reduce((sum,row)=>sum+receiptBytes(row),0);
      return transaction('readwrite',(table,read,set,archive,usage)=>readUsage(archive,usage,read,namespace,previous=>{
        if(previous.count+rows.length>VIBE_ENCODING_ARCHIVE_LIMIT||previous.bytes+bytes>ARCHIVE_BYTES)throw fail('capacity','历史编码档案已满，请先导出保全；原记录未移动');
        let index=0;
        const move=()=>{const expectedRow=rows[index++];if(!expectedRow){usage.put({namespace,count:previous.count+rows.length,bytes:previous.bytes+bytes});set({archived:rows.length,bytes});return;}
          read(table.get(expectedRow.key),row=>{if(!equalReceipt(row,expectedRow))throw fail('changed','待归档记录已变化，请刷新；本批未移动');
            read(archive.get(row.key),old=>{if(old)throw fail('corrupt','历史编码已有同一请求，未覆盖');archive.add(row);table.delete(row.key);move();});
          });};move();
      }));
    },
    async reserve(namespace,cacheKey,identity,attemptId,{retryAttemptId='',sourceAssetRef,delivery}={}){
      const id=key(namespace,cacheKey);if(!attempt(attemptId)||retryAttemptId&&!attempt(retryAttemptId))throw fail('identity','编码请求编号无效');const canonical=await validateVibeEncodingIdentity(identity,cacheKey);
      const source=sourceAssetRef?retainVibeAssetRef(sourceAssetRef):null,sending=delivery?validateVibeEncodingDelivery(delivery):null;
      if(source&&(source.invalid||source.namespace!==namespace))throw fail('identity','编码原图不属于当前账户');
      const original=await snapshot(namespace,cacheKey);
      return transaction('readwrite',(table,read,set,archive)=>readReceipt(table,archive,read,id,existing=>{
        if(existing){normalize(existing,namespace,cacheKey);sameIdentity(existing,canonical);
          if(!['rejected','reviewed'].includes(existing.status)||!retryAttemptId||existing.attemptId!==retryAttemptId){set({owned:false,receipt:existing});return;}
          if(existing.attemptId===attemptId)throw fail('identity','重试必须建立新编码请求');
        }
        if(!equalReceipt(existing||null,original.receipt))throw fail('changed','原编码核查明细已变化，未授权新请求');
        const pastReviews=checkReviewHistory([...(existing?.pastReviews||[]),...(existing?.status==='reviewed'?[{attemptId:existing.attemptId,delivery:existing.delivery,feeReview:existing.feeReview}]:[])]);
        if(pastReviews.some(row=>row.attemptId===attemptId)||original.reviews.some(row=>row.attemptId===attemptId))throw fail('identity','新编码不能复用历史核查编号');
        const create=()=>{const timestamp=now(),row={key:id,namespace,cacheKey,identity:canonical,attemptId,status:'reserved',revision:(existing?.revision||0)+1,createdAt:existing?.createdAt??timestamp,updatedAt:Math.max(timestamp,existing?.updatedAt||0),...(source?{sourceAssetRef:source}:{}),...(sending?{delivery:sending}:{}),...(pastReviews.length?{pastReviews}:{})};
          if(existing?.reviewArchive)row.reviewArchive=existing.reviewArchive;
          table.put(row);set({owned:true,receipt:row});};
        if(existing)create();else read(table.index('namespace').count(keyRange.only(namespace)),count=>{if(count>=VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码记录已满，请先整理；未提交收费请求');create();});
      }));
    },
    async transition(namespace,cacheKey,attemptId,status,{assetRef=null}={}){
      const id=key(namespace,cacheKey);if(!attempt(attemptId)||!['submitting','ready','rejected','unknown'].includes(status))throw fail('identity','编码状态操作无效');
      const original=await this.get(namespace,cacheKey);if(!original||original.attemptId!==attemptId)throw fail('changed','编码请求归属已变化，未继续提交');
      const ref=assetRef?retainVibeAssetRef(assetRef):null;if(status==='ready'&&(!ref||ref.invalid||ref.namespace!==namespace)||status!=='ready'&&assetRef)throw fail('identity','编码结果资产引用无效');
      return transaction('readwrite',(table,read,set)=>read(table.get(id),row=>{
        normalize(row,namespace,cacheKey);if(!row||JSON.stringify(row)!==JSON.stringify(original))throw fail('changed','编码记录已变化，未继续提交');
        if(status==='submitting'&&row.status!=='reserved'||status!=='submitting'&&!['reserved','submitting'].includes(row.status)||status==='ready'&&row.status!=='submitting')throw fail('changed','编码状态不可重复执行');
        const next={...row,status,updatedAt:Math.max(now(),row.updatedAt),...(ref?{assetRef:ref}:{})};table.put(next);set(next);
      }));
    },
    async review(namespace,cacheKey,expected,proof){
      const original=await this.get(namespace,cacheKey),id=key(namespace,cacheKey);
      if(!original||!equalReceipt(original,expected))throw fail('changed','原费用记录已变化，请刷新');
      if(proof?.reviewed!==true||!hash(proof.confirmation)||proof.requestDigest!==cacheKey||!matchesVibeServiceDelivery(original,proof.attemptId,proof.serviceDelivery))throw fail('identity','服务核查凭据不属于原编码提交');
      if(original.status==='reviewed')return original;
      if(!['reserved','submitting','unknown'].includes(original.status))throw fail('changed','原费用状态不需要重新确认');
      return transaction('readwrite',(table,read,set)=>read(table.get(id),row=>{
        normalize(row,namespace,cacheKey);if(!equalReceipt(row,original))throw fail('changed','原费用记录已变化，未覆盖');
        const at=Math.max(now(),row.updatedAt),next={...row,status:'reviewed',updatedAt:at,feeReview:{version:1,confirmation:proof.confirmation,previousStatus:row.status,at}};table.put(next);set(next);
      }));
    },
    async previewLocalReview(namespace,cacheKey,expected){
      const row=await this.get(namespace,cacheKey);
      if(!row||!equalReceipt(row,expected))throw fail('changed','原费用记录已变化，请刷新');
      if(row.delivery?.transport==='service')throw fail('identity','此记录须核查原服务任务，不能用本机确认替代');
      if(!['reserved','submitting','unknown'].includes(row.status))throw fail('changed','原费用状态不需要重新确认');
      // This digest binds user consent to a snapshot. It is NOT an upstream completion/fee certificate.
      return {version:1,method:'local-user',requestDigest:cacheKey,attemptId:row.attemptId,
        confirmation:await digest(JSON.stringify(['qianmu:vibe-local-review:v1',row]))};
    },
    async reviewLocal(namespace,cacheKey,expected,proof,confirmed){
      const plan=await this.previewLocalReview(namespace,cacheKey,expected),id=key(namespace,cacheKey);
      if(confirmed!==true||!object(proof)||!equalReceipt(plan,proof))throw fail('identity','尚未确认这笔原编码的本机核查');
      return transaction('readwrite',(table,read,set)=>read(table.get(id),row=>{
        normalize(row,namespace,cacheKey);if(!equalReceipt(row,expected))throw fail('changed','原费用记录已变化，未覆盖');
        const at=Math.max(now(),row.updatedAt),next={...row,status:'reviewed',updatedAt:at,
          feeReview:{version:1,method:'local-user',confirmation:plan.confirmation,previousStatus:row.status,at}};
        table.put(next);set(next);
      }));
    },
    async recover(namespace,cacheKey,expected,assetRef,serviceAttemptId,serviceDelivery){
      const original=await this.get(namespace,cacheKey),id=key(namespace,cacheKey),ref=retainVibeAssetRef(assetRef);
      if(!original||JSON.stringify(original)!==JSON.stringify(expected))throw fail('changed','原编码记录已变化，请刷新后领取');
      if(ref.invalid||ref.namespace!==namespace)throw fail('identity','领取结果资产无效');
      if(!matchesVibeServiceDelivery(original,serviceAttemptId,serviceDelivery))return {reconciled:false,receipt:original};
      return transaction('readwrite',(table,read,set)=>read(table.get(id),row=>{
        normalize(row,namespace,cacheKey);if(JSON.stringify(row)!==JSON.stringify(original))throw fail('changed','原编码记录已变化，未覆盖');
        const next={...row,status:'ready',assetRef:ref,updatedAt:Math.max(now(),row.updatedAt)};
        if(row.feeReview){next.pastReviews=checkReviewHistory([...(row.pastReviews||[]),{attemptId:row.attemptId,delivery:row.delivery,feeReview:row.feeReview}]);delete next.feeReview;}
        table.put(next);set({reconciled:true,receipt:next});
      }));
    },
    async remember(namespace,cacheKey,identity,assetRef,{serviceAttemptId,serviceDelivery}={}){
      const id=key(namespace,cacheKey),canonical=await validateVibeEncodingIdentity(identity,cacheKey),ref=retainVibeAssetRef(assetRef);
      if(ref.invalid||ref.namespace!==namespace)throw fail('identity','服务编码缓存引用无效');
      const original=await snapshot(namespace,cacheKey);
      return transaction('readwrite',(table,read,set,archive)=>readReceipt(table,archive,read,id,existing=>{
        if(existing){normalize(existing,namespace,cacheKey);sameIdentity(existing,canonical);
          // A received service result does not settle a DIFFERENT uncertain browser fee attempt.
          if(existing.status==='unknown'&&matchesVibeServiceDelivery(existing,serviceAttemptId,serviceDelivery)){
            if(!equalReceipt(existing,original.receipt))throw fail('changed','原编码核查明细已变化，未覆盖');
            const next={...existing,status:'ready',assetRef:ref,updatedAt:Math.max(now(),existing.updatedAt)};table.put(next);set(next);return;}
          if(existing.status!=='rejected'){set(existing);return;}}
        if(!equalReceipt(existing||null,original.receipt))throw fail('changed','原编码核查明细已变化，未覆盖');
        const create=()=>{const at=now(),row={key:id,namespace,cacheKey,identity:canonical,attemptId:`cached-${crypto.randomUUID()}`,status:'ready',
          revision:(existing?.revision||0)+1,createdAt:existing?.createdAt??at,updatedAt:Math.max(at,existing?.updatedAt||0),assetRef:ref,...(existing?.pastReviews?.length?{pastReviews:existing.pastReviews}:{}),...(existing?.reviewArchive?{reviewArchive:existing.reviewArchive}:{})};table.put(row);set(row);};
        if(existing)create();else read(table.index('namespace').count(keyRange.only(namespace)),count=>{if(count>=VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码缓存已满，请先整理');create();});
      }));
    },
    close(){closed=true;for(const tx of transactions)try{tx.abort();}catch(_){}db?.close();db=null;opening=null;},
  });
}
