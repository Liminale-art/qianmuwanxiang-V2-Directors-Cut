import {nativeCollectionCapabilities,nativeCollectionWriteRequest,nativeCollectionWriteResponse} from './qianmu-text-collection-native-contract.js';
import {TEXT_COLLECTION_SYNC_LIMITS,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';
import {parseBoundedJson} from './qianmu-json-input.js';

const base='/api/plugins/qianmu-tts/text-collections',capabilities=new WeakMap(),unconfirmed=new WeakMap();
// Only feature support, scoped to the active native configuration/account. No
// contents, credentials, write receipt or authorization lives in this registry.
export function createNativeCollectionTransport({expectedAccount,scope,readScope,guard,headers=()=>({}),fetchImpl=globalThis.fetch,
  origin=globalThis.location?.origin,timeoutMs=15000,now=Date.now}={}){
  if(typeof guard!=='function'||typeof headers!=='function'||typeof fetchImpl!=='function'||!/^st-user:[a-f0-9]{64}$/.test(expectedAccount||'')
    ||!/^[a-f0-9]{64}$/.test(scope||'')||!Number.isFinite(timeoutMs))throw error('setup','收藏连接环境尚未就绪',503);
  let closed=false;const pending=new Set();
  // In this page/configuration lifetime, an unconfirmed operation must stay on
  // the endpoint already used, even after feature discovery expires. Keep only
  // bounded operation IDs, never the collection text or credentials.
  const keys=input=>input.mutations.map(item=>JSON.stringify([origin,scope,expectedAccount,item.mutationId]));
  const pinned=()=>{let ids=unconfirmed.get(readScope);if(!ids){ids=new Set();unconfirmed.set(readScope,ids);}return ids;};
  if(origin!==undefined){let url;try{url=new URL(origin);}catch{}
    if(!url||!['http:','https:'].includes(url.protocol)||url.origin!==origin||globalThis.location?.origin&&origin!==globalThis.location.origin)throw error('setup','收藏只能使用当前 ST 站点',503);}
  const check=async signal=>{
    if(closed||signal?.aborted)throw error('cancelled','收藏保存已停止，未确认内容仍保留');
    if(await guard()===false)throw error('account','收藏账户已变化',401);
    if(closed||signal?.aborted)throw error('cancelled','收藏保存已停止，未确认内容仍保留');
  };
  async function call(action,input,{signal}={}){
    const writing=action==='native-write',path=base+'/'+action,controller=new AbortController();let started=false,response,reader,rejectStop;
    const stopped=new Promise((_,reject)=>{rejectStop=reject;}),abort=()=>{controller.abort();rejectStop(error('cancelled','收藏操作已停止，未确认内容仍保留'));};
    pending.add(abort);signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{controller.abort();rejectStop(error('native_connection','收藏保存确认超时，请保留当前内容',503));},writing?Math.max(100,Math.min(30000,timeoutMs)):1500);
    try{
      if(signal?.aborted)abort();
      return await Promise.race([(async()=>{
        await check(controller.signal);const supplied=new Headers(await headers()),requestHeaders={Accept:'application/json'};
        if(supplied.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=supplied.get('x-csrf-token');
        if(writing)requestHeaders['Content-Type']='application/json';
        await check(controller.signal);
        if(writing){const ids=pinned(),added=keys(input).filter(key=>!ids.has(key));
          if(ids.size+added.length>1024)throw error('native_busy','尚有收藏保存未确认，请先重试未完成项',429);
          for(const key of added)ids.add(key);
        }
        started=writing;
        response=await fetchImpl(new URL(path,origin).href,{method:writing?'POST':'GET',headers:requestHeaders,...writing?{body:JSON.stringify(input)}:{},
          credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        await check(controller.signal);
        if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400
          ||response.url&&response.url!==new URL(path,origin).href)throw error('native_response','收藏服务发生跳转，未采用返回',502);
        if([401,403].includes(response.status)){
          try{(await import('./qianmu-account-identity.js')).invalidateImageAccountIdentity();}catch{}
          throw error('account','收藏登录状态已失效，请刷新 ST 后重试',401);
        }
        if(!writing&&[404,405,501].includes(response.status))return null;
        const limit=writing?TEXT_COLLECTION_SYNC_LIMITS.bytes+16384:4096;
        if(!/^application\/json\b/i.test(response.headers?.get?.('content-type')||'')||Number(response.headers.get('content-length'))>limit)throw error('native_response','收藏服务返回无效或过大',502);
        reader=response.body?.getReader?.();if(!reader)throw error('native_response','收藏服务返回不完整',502);
        const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
        while(true){const part=await reader.read();await check(controller.signal);if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw error('native_response','收藏服务返回超过上限',502);text+=decoder.decode(part.value,{stream:true});}
        text+=decoder.decode();const value=parseBoundedJson(text,{maxBytes:limit,maxDepth:36,maxNodes:500100,label:'收藏保存'});
        if(!response.ok||value?.ok!==true){
          const known=value?.ok===false&&value.version===1&&/^text_collection_sync_[a-z_]+$/.test(value.code||'')&&typeof value.message==='string'&&value.message.length<=240;
          throw error(known?value.code.slice('text_collection_sync_'.length):'native_response',known?value.message:'收藏保存未确认，请保留当前内容',response.status);
        }
        if(value.expectedAccount!==undefined&&value.expectedAccount!==expectedAccount)throw error('account','收藏服务账户已变化',401);
        const result=writing?await nativeCollectionWriteResponse(value,input,{scope}):nativeCollectionCapabilities(value,expectedAccount);
        await check(controller.signal);
        if(writing)for(const key of keys(input))pinned().delete(key);
        return result;
      })(),stopped]);
    }catch(cause){
      const known=/^text_collection_sync_/.test(cause?.code||'')?cause:error('native_connection','收藏连接中断，原内容仍保留',503);
      known.writeState=started?'unconfirmed':'not_started';throw known;
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(abort);controller.abort();
      try{void(reader?reader.cancel():response?.body?.cancel?.())?.catch(()=>{});}catch{}try{reader?.releaseLock();}catch{}
    }
  }
  return Object.freeze({
    async tryWrite(raw,options){
      await check(options?.signal);
      // A Worker or non-page caller without a verified current origin retains
      // its existing native transport; never invent a server address.
      if(!origin||!readScope)return null;
      const input=nativeCollectionWriteRequest(raw);if(input.expectedAccount!==expectedAccount)throw error('account','收藏保存账户不一致',401);
      if(keys(input).some(key=>pinned().has(key)))return call('native-write',input,options);
      const prior=capabilities.get(readScope);let available=prior?.account===expectedAccount&&prior.origin===origin&&now()>=prior.at&&now()-prior.at<60000?prior.available:undefined;
      if(available===undefined){
        try{available=Boolean(await call('native-capabilities',null,options));}
        catch(cause){
          // Only the read-only probe can fall back. Authentication/cancellation
          // still rejects; a dispatched mutation is never rerouted below.
          if(!['text_collection_sync_native_connection','text_collection_sync_native_response'].includes(cause?.code))throw cause;
          await check(options?.signal);available=false;
        }
        await check(options?.signal);capabilities.set(readScope,{account:expectedAccount,origin,at:now(),available});
      }
      if(!available)return null;
      return call('native-write',input,options);
    },
    close(){closed=true;for(const abort of pending)abort();pending.clear();},
  });
}
