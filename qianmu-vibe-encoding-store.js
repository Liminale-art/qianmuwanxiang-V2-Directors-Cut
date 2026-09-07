import {VIBE_ENCODING_MODELS,retainVibeAssetRef} from './qianmu-vibe-asset-ref.js';
import {novelVibeEncodeEndpoint} from './qianmu-vibe-encoding.js';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const attempt=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(value);
const fail=(code,message)=>Object.assign(new Error(message),{code:`vibe_encoding_cache_${code}`,submissionState:'not_submitted'});
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const key=(namespace,cacheKey)=>{if(!account(namespace)||!hash(cacheKey))throw fail('identity','编码缓存账户或编号无效');return JSON.stringify([namespace,cacheKey]);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export const VIBE_ENCODING_RECEIPT_LIMIT=2048;

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
    if(Object.keys(row).some(name=>!['key','namespace','cacheKey','identity','attemptId','status','revision','createdAt','updatedAt','assetRef'].includes(name))
      ||row.key!==key(namespace,cacheKey)||row.namespace!==namespace||row.cacheKey!==cacheKey||!attempt(row.attemptId)
      ||!['reserved','submitting','ready','rejected','unknown'].includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<1
      ||![row.createdAt,row.updatedAt].every(value=>Number.isFinite(value)&&value>=0)||row.updatedAt<row.createdAt||!object(row.identity))throw fail('corrupt','编码记录不完整，请先保全数据');
    if(row.status==='ready'&&(retainVibeAssetRef(row.assetRef).invalid||row.assetRef.namespace!==namespace))throw fail('corrupt','编码原资产引用失效');
    if(row.status!=='ready'&&row.assetRef)throw fail('corrupt','未完成编码含错误资产引用');return row;
  }
  async function checked(row,namespace,cacheKey){if(!row)return null;normalize(row,namespace,cacheKey);await validateVibeEncodingIdentity(row.identity,cacheKey);return row;}
  const sameIdentity=(row,identity)=>{if(JSON.stringify(row.identity)!==JSON.stringify(identity))throw fail('corrupt','编码记录参数不一致，请先保全数据');};
  return Object.freeze({
    async get(namespace,cacheKey){const id=key(namespace,cacheKey);return checked(await transaction('readonly',(table,read,set)=>read(table.get(id),set)),namespace,cacheKey);},
    async list(namespace){if(!account(namespace))throw fail('identity','编码缓存账户无效');const rows=await transaction('readonly',(table,read,set)=>read(table.index('namespace').getAll(keyRange.only(namespace),VIBE_ENCODING_RECEIPT_LIMIT+1),set));
      if(rows.length>VIBE_ENCODING_RECEIPT_LIMIT)throw fail('capacity','编码记录过多，请先整理');for(const row of rows)await checked(row,namespace,row.cacheKey);return rows;},
    async reserve(namespace,cacheKey,identity,attemptId,{retryAttemptId=''}={}){
      const id=key(namespace,cacheKey);if(!attempt(attemptId)||retryAttemptId&&!attempt(retryAttemptId))throw fail('identity','编码请求编号无效');const canonical=await validateVibeEncodingIdentity(identity,cacheKey);
      return transaction('readwrite',(table,read,set)=>read(table.get(id),existing=>{
        if(existing){normalize(existing,namespace,cacheKey);sameIdentity(existing,canonical);
          if(existing.status!=='rejected'||!retryAttemptId||existing.attemptId!==retryAttemptId){set({owned:false,receipt:existing});return;}
          if(existing.attemptId===attemptId)throw fail('identity','重试必须建立新编码请求');
        }
        const create=()=>{const timestamp=now(),row={key:id,namespace,cacheKey,identity:canonical,attemptId,status:'reserved',revision:(existing?.revision||0)+1,createdAt:existing?.createdAt??timestamp,updatedAt:Math.max(timestamp,existing?.updatedAt||0)};
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
    close(){closed=true;for(const tx of transactions)try{tx.abort();}catch(_){}db?.close();db=null;opening=null;},
  });
}
