import {textCollectionSyncError as error,textCollectionSyncMutation,textCollectionSyncQuery,textCollectionSyncResponse} from './qianmu-text-collection-sync-contract.js';
import {TEXT_COLLECTION_BACKUP_LIMITS} from './qianmu-text-collection-backup.js';
import {parseBoundedJson} from './qianmu-json-input.js';

const base='/api/plugins/qianmu-tts/text-collections';
// Same transport boundaries as notes sync; reuse the collection contracts, never the notes database.
// expectedAccount is a consistency fence, not authentication; ST authenticates every request.
export function createTextCollectionClient({expectedAccount,guard,headers=()=>({}),fetchImpl=globalThis.fetch,timeoutMs=15000}={}){
  if(!/^st-user:[a-f0-9]{64}$/.test(expectedAccount||'')||typeof guard!=='function'||typeof headers!=='function'||typeof fetchImpl!=='function'||!Number.isFinite(timeoutMs))throw error('setup','收藏连接环境未就绪',503);
  const origin=globalThis.location?.origin,pending=new Set();let closed=false;
  if(origin!==undefined&&!/^https?:\/\//.test(origin))throw error('setup','请在当前 ST 站点中使用收藏',503);
  async function call(method,input,{signal}={}){
    const payload=method==='write'?textCollectionSyncMutation(input):textCollectionSyncQuery({version:1,expectedAccount,...input},method);
    if(payload.expectedAccount!==expectedAccount)throw error('account','收藏请求与当前账户不一致',401);
    const path=`${base}/${method}`,controller=new AbortController();let reader,response,started=false,rejectCancellation;
    const writeState=()=>method==='write'&&started?'unconfirmed':'not_started';
    const cancellation=new Promise((_,reject)=>{rejectCancellation=reject;});
    const cancel=message=>{controller.abort();rejectCancellation(error('cancelled',message));};
    const abort=()=>cancel('收藏操作已取消；未确认的内容请保留');
    const check=async()=>{
      if(closed||controller.signal.aborted)throw error('cancelled','收藏会话已结束，未采用返回内容');
      if(await guard()===false)throw error('account','收藏账户已变化，未采用返回内容',401);
      if(closed||controller.signal.aborted)throw error('cancelled','收藏会话已结束，未采用返回内容');
    };
    pending.add(abort);signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>cancel('收藏请求超时；保存尚未确认，请保留当前内容'),Math.max(100,Math.min(30000,timeoutMs)));
    try{
      if(signal?.aborted)abort();
      return await Promise.race([(async()=>{
        await check();const supplied=new Headers(await headers()),requestHeaders={Accept:'application/json','Content-Type':'application/json'};
        if(supplied.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=supplied.get('x-csrf-token');
        await check();started=true;
        response=await fetchImpl(origin?new URL(path,origin).href:path,{method:'POST',headers:requestHeaders,body:JSON.stringify(payload),credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        await check();
        if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400)throw error('response','收藏接口发生跳转，未采用返回内容',502);
        if(response.url){const actual=new URL(response.url);if(actual.pathname!==path||actual.search||actual.hash||origin&&actual.origin!==origin)throw error('response','收藏返回不是当前 ST 接口',502);}
        if([404,405,501].includes(response.status))throw error('unavailable','请安装或更新千幕后端并重启 ST；本次收藏尚未确认保存',503);
        if([401,403].includes(response.status))throw error('account','收藏登录或校验已失效，请刷新 ST 后重试',401);
        const limit=method==='snapshot'?TEXT_COLLECTION_BACKUP_LIMITS.bytes+1024:method==='get'?2*1024*1024:256*1024;
        if(!/^application\/json\b/i.test(response.headers?.get?.('content-type')||'')||Number(response.headers.get('content-length'))>limit)throw error('response','收藏返回格式不兼容或过大，未采用部分内容',502);
        reader=response.body?.getReader?.();if(!reader)throw error('response','收藏返回不完整',502);
        const decoder=new TextDecoder('utf-8',{fatal:true});let body='',bytes=0;
        while(true){const part=await reader.read();await check();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw error('response','收藏返回超过安全读取上限',502);body+=decoder.decode(part.value,{stream:true});}
        body+=decoder.decode();const value=method==='snapshot'?parseBoundedJson(body,{maxBytes:limit,maxDepth:16,maxNodes:500000,label:'收藏快照'}):JSON.parse(body);
        if(!response.ok||value?.ok!==true){
          const known=value?.ok===false&&value.version===1&&/^text_collection_sync_[a-z_]+$/.test(value.code||'')&&typeof value.message==='string'&&value.message.length<=240;
          throw error(known?value.code.slice('text_collection_sync_'.length):'service',known?value.message:'收藏服务暂不可用，请保留当前内容',response.status);
        }
        const parsed=textCollectionSyncResponse(value,method,payload);await check();return parsed;
      })(),cancellation]);
    }catch(cause){
      const known=String(cause?.code||'').startsWith('text_collection_sync_')?cause:error('connection','收藏连接中断或返回损坏，请保留内容并核对原操作',503);
      known.writeState=writeState();throw known;
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(abort);controller.abort();
      try{void(reader?reader.cancel():response?.body?.cancel?.())?.catch(()=>{});}catch{}
      try{reader?.releaseLock();}catch{}
    }
  }
  return Object.freeze({list:(input={cursor:null,limit:50},options)=>call('list',input,options),get:(id,options)=>call('get',{id},options),write:(input,options)=>call('write',input,options),
    snapshot:options=>call('snapshot',{},options),
    inventory:options=>call('inventory',{},options),
    restoreInfo:options=>call('restore-info',{},options),
    close(){closed=true;for(const abort of pending)abort();pending.clear();}});
}
