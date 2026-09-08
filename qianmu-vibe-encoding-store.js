import {VIBE_ENCODING_MODELS,retainVibeAssetRef} from './qianmu-vibe-asset-ref.js';
import {novelVibeEncodeEndpoint} from './qianmu-vibe-encoding.js';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const attempt=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(value);
const fail=(code,message)=>Object.assign(new Error(message),{code:`vibe_encoding_cache_${code}`,submissionState:'not_submitted'});
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const key=(namespace,cacheKey)=>{if(!account(namespace)||!hash(cacheKey))throw fail('identity','编码缓存账户或编号无效');return JSON.stringify([namespace,cacheKey]);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const equalReceipt=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function checkFeeReview(value){
  if(!object(value)||value.version!==1||!hash(value.confirmation)||!['reserved','submitting','unknown'].includes(value.previousStatus)
    ||!Number.isSafeInteger(value.at)||value.at<0||(value.method!==undefined&&value.method!=='local-user')
    ||Object.keys(value).some(key=>!['version','confirmation','previousStatus','at','method'].includes(key)))throw fail('corrupt','原费用核查记录不完整');return value;
}
function checkReviewSource(row){
  checkFeeReview(row.feeReview);
  if(row.delivery!==undefined)validateVibeEncodingDelivery(row.delivery);
  // Missing old delivery is permissible only for explicitly local user evidence, never server proof.
  if(row.feeReview.method==='local-user'?row.delivery?.transport==='service':row.delivery?.transport!=='service')throw fail('corrupt','原费用核查方式与提交来源不符');
}
function checkReviewHistory(rows){
  if(!Array.isArray(rows)||rows.length>32)throw fail('capacity','原编码核查历史过多，请先导出整理');const seen=new Set();
  for(const row of rows){
    if(!object(row)||!attempt(row.attemptId)||seen.has(row.attemptId)||Object.keys(row).some(key=>!['attemptId','delivery','feeReview'].includes(key)))throw fail('corrupt','原费用核查历史不完整');
    checkReviewSource(row);seen.add(row.attemptId);
  }return rows;
}
export const VIBE_ENCODING_RECEIPT_LIMIT=2048;
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
export function validateVibeEncodingDelivery(value){
  if(!object(value)||value.version!==1||!['direct','service'].includes(value.transport)||!hash(value.channelKey)
    ||Object.keys(value).some(key=>!['version','transport','channelKey','serviceAttemptId'].includes(key))
    ||(value.transport==='service'?!hash(value.serviceAttemptId):value.serviceAttemptId!==undefined))throw fail('identity','编码发送来源无效');
  return {version:1,transport:value.transport,channelKey:value.channelKey,...(value.transport==='service'?{serviceAttemptId:value.serviceAttemptId}:{})};
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

// Durable metadata only, with no expiry or implicit retry. A crashed submitting receipt remains uncertain.
export function createVibeEncodingStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-vibe-encodings',timeoutMs=8000,now=Date.now}={}){
  let db=null,opening=null,closed=false;const transactions=new Set(),timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000));
  const unavailable=()=>fail('storage','编码记录暂不可用，为避免重复计费，未授权新请求');
  function open(){
    if(closed)return Promise.reject(fail('closed','编码缓存会话已结束'));if(db)return Promise.resolve(db);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{let request,done=false;
      const finish=(error,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(fail('timeout','编码记录读取超时，未授权新请求')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(unavailable());return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction.abort();return;}if(!request.result.objectStoreNames.contains('receipts')){const table=request.result.createObjectStore('receipts',{keyPath:'key'});table.createIndex('namespace','namespace');}};
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
      try{tx=database.transaction('receipts',mode);transactions.add(tx);}catch(_){finish(unavailable());return;}
      tx.oncomplete=()=>finish(closed?fail('closed','编码缓存会话已结束'):null);tx.onabort=()=>finish(error||unavailable());tx.onerror=()=>{error||=unavailable();};
      const read=(request,next)=>{request.onsuccess=()=>{if(done)return;try{if(closed)throw fail('closed','编码缓存会话已结束');next(request.result);}catch(cause){abort(cause);}};};
      try{work(tx.objectStore('receipts'),read,value=>result=value);}catch(cause){abort(cause);}
    });
  }
  function normalize(row,namespace,cacheKey){
    if(!row)return null;
    if(Object.keys(row).some(name=>!['key','namespace','cacheKey','identity','attemptId','status','revision','createdAt','updatedAt','assetRef','sourceAssetRef','delivery','feeReview','pastReviews'].includes(name))
      ||row.key!==key(namespace,cacheKey)||row.namespace!==namespace||row.cacheKey!==cacheKey||!attempt(row.attemptId)
      ||!['reserved','submitting','ready','rejected','unknown','reviewed'].includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<1
      ||![row.createdAt,row.updatedAt].every(value=>Number.isFinite(value)&&value>=0)||row.updatedAt<row.createdAt||!object(row.identity))throw fail('corrupt','编码记录不完整，请先保全数据');
    if(row.status==='ready'&&(retainVibeAssetRef(row.assetRef).invalid||row.assetRef.namespace!==namespace))throw fail('corrupt','编码原资产引用失效');
    if(row.status!=='ready'&&row.assetRef)throw fail('corrupt','未完成编码含错误资产引用');
    if(row.sourceAssetRef&&(retainVibeAssetRef(row.sourceAssetRef).invalid||row.sourceAssetRef.namespace!==namespace))throw fail('corrupt','原图资产归属不符');
    if(row.delivery!==undefined)validateVibeEncodingDelivery(row.delivery);
    if(row.status==='reviewed')checkReviewSource(row);else if(row.feeReview!==undefined)throw fail('corrupt','费用核查状态不符');
    if(row.pastReviews!==undefined)checkReviewHistory(row.pastReviews);return row;
  }
  async function checked(row,namespace,cacheKey){if(!row)return null;normalize(row,namespace,cacheKey);await validateVibeEncodingIdentity(row.identity,cacheKey);return row;}
  const sameIdentity=(row,identity)=>{if(JSON.stringify(row.identity)!==JSON.stringify(identity))throw fail('corrupt','编码记录参数不一致，请先保全数据');};
  return Object.freeze({
    async get(namespace,cacheKey){const id=key(namespace,cacheKey);return checked(await transaction('readonly',(table,read,set)=>read(table.get(id),set)),namespace,cacheKey);},
    async list(namespace){if(!account(namespace))throw fail('identity','编码缓存账户无效');const rows=await transaction('readonly',(table,read,set)=>read(table.index('namespace').getAll(keyRange.only(namespace),VIBE_ENCODING_RECEIPT_LIMIT+1),set));
      if(rows.length>VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码记录过多，请先整理');for(const row of rows)await checked(row,namespace,row.cacheKey);return rows;},
    async reserve(namespace,cacheKey,identity,attemptId,{retryAttemptId='',sourceAssetRef,delivery}={}){
      const id=key(namespace,cacheKey);if(!attempt(attemptId)||retryAttemptId&&!attempt(retryAttemptId))throw fail('identity','编码请求编号无效');const canonical=await validateVibeEncodingIdentity(identity,cacheKey);
      const source=sourceAssetRef?retainVibeAssetRef(sourceAssetRef):null,sending=delivery?validateVibeEncodingDelivery(delivery):null;
      if(source&&(source.invalid||source.namespace!==namespace))throw fail('identity','编码原图不属于当前账户');
      return transaction('readwrite',(table,read,set)=>read(table.get(id),existing=>{
        if(existing){normalize(existing,namespace,cacheKey);sameIdentity(existing,canonical);
          if(!['rejected','reviewed'].includes(existing.status)||!retryAttemptId||existing.attemptId!==retryAttemptId){set({owned:false,receipt:existing});return;}
          if(existing.attemptId===attemptId)throw fail('identity','重试必须建立新编码请求');
        }
        const pastReviews=checkReviewHistory([...(existing?.pastReviews||[]),...(existing?.status==='reviewed'?[{attemptId:existing.attemptId,delivery:existing.delivery,feeReview:existing.feeReview}]:[])]);
        if(pastReviews.some(row=>row.attemptId===attemptId))throw fail('identity','新编码不能复用历史核查编号');
        const create=()=>{const timestamp=now(),row={key:id,namespace,cacheKey,identity:canonical,attemptId,status:'reserved',revision:(existing?.revision||0)+1,createdAt:existing?.createdAt??timestamp,updatedAt:Math.max(timestamp,existing?.updatedAt||0),...(source?{sourceAssetRef:source}:{}),...(sending?{delivery:sending}:{}),...(pastReviews.length?{pastReviews}:{})};
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
      return transaction('readwrite',(table,read,set)=>read(table.get(id),existing=>{
        if(existing){normalize(existing,namespace,cacheKey);sameIdentity(existing,canonical);
          // A received service result does not settle a DIFFERENT uncertain browser fee attempt.
          if(existing.status==='unknown'&&matchesVibeServiceDelivery(existing,serviceAttemptId,serviceDelivery)){
            const next={...existing,status:'ready',assetRef:ref,updatedAt:Math.max(now(),existing.updatedAt)};table.put(next);set(next);return;}
          if(existing.status!=='rejected'){set(existing);return;}}
        const create=()=>{const at=now(),row={key:id,namespace,cacheKey,identity:canonical,attemptId:`cached-${crypto.randomUUID()}`,status:'ready',
          revision:(existing?.revision||0)+1,createdAt:existing?.createdAt??at,updatedAt:Math.max(at,existing?.updatedAt||0),assetRef:ref,...(existing?.pastReviews?.length?{pastReviews:existing.pastReviews}:{})};table.put(row);set(row);};
        if(existing)create();else read(table.index('namespace').count(keyRange.only(namespace)),count=>{if(count>=VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码缓存已满，请先整理');create();});
      }));
    },
    close(){closed=true;for(const tx of transactions)try{tx.abort();}catch(_){}db?.close();db=null;opening=null;},
  });
}
