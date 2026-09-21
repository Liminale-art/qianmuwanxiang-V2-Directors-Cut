import {galleryDiscoveryRequest,galleryDiscoveryResponse,GALLERY_DISCOVERY_LIMITS as LIMIT} from './qianmu-gallery-discovery-contract.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {galleryCatalogAccount} from './qianmu-gallery-catalog-contract.js';
import {parseBoundedJson} from './qianmu-json-input.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const BASE='/api/plugins/qianmu-tts/gallery-archive/versions';
const fail=(message,serviceCode='')=>Object.assign(Error(message),{code:'gallery_discovery_client',serviceCode,retryable:false});
const unsupported=()=>fail('当前后端尚未提供图库版本发现，请更新千幕配套后端；原作品未修改','gallery_discovery_unsupported');
const messages={
  gallery_discovery_account:'ST 登录或账户已变化，请重新打开图库',
  gallery_discovery_stale:'图库目录在翻页期间已变化，请刷新列表',
  gallery_discovery_changed:'图库目录读取已停止或来源发生变化，请重新核对',
  gallery_discovery_busy:'图库目录正在读取，请稍后重试',
  gallery_discovery_capacity:'账户文件数量超过本次发现范围，未将部分结果当成完整图库',
  gallery_discovery_missing:'图库目录文件不存在或已移动，未当作空库',
  gallery_discovery_content:'图库目录文件损坏或校验不符，请保留原件',
  gallery_discovery_path:'图库目录路径不受支持，请核对 ST 文件存储',
};
// Constructing a client performs no I/O. Account resolution is inside every
// request's deadline, including the first open; no active chat is required.
export function createGalleryDiscoveryClient({account,headers,guard=()=>true,fetchImpl=globalThis.fetch,timeoutMs=12000}={}){
  if(typeof account!=='function'||typeof headers!=='function'||typeof guard!=='function'||typeof fetchImpl!=='function'
    ||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw fail('图库发现客户端尚未接入当前 ST 账户');
  let namespace,closed=false;const pending=new Set();
  function close(){closed=true;for(const abort of pending)abort();}
  async function list(raw={}, {signal}={}){
    if(closed)throw fail('图库发现会话已结束');if(pending.size>=LIMIT.pending)throw fail('图库目录正在读取，请稍后重试');
    const options=captureGalleryArchiveJson(raw,4096);
    if(!options||Array.isArray(options)||Object.keys(options).some(key=>!['limit','cursor'].includes(key)))throw fail('图库分页选项无效');
    let rejectStop;const stopped=new Promise((_,reject)=>{rejectStop=reject;}),controller=new AbortController();
    const abort=()=>{controller.abort();rejectStop(fail('图库发现已取消或超时'));};
    const invalidateAccount=()=>{closed=true;for(const other of pending)if(other!==abort)other();};
    pending.add(abort);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,timeoutMs);
    const current=()=>{if(closed||controller.signal.aborted)throw fail('图库发现已取消或会话结束');};
    async function check(){
      current();if(await guard()!==true)throw fail('图库页面来源已变化');current();
      const owner=galleryCatalogAccount(await account());current();
      if(namespace!==undefined&&namespace!==owner){invalidateAccount();throw fail(messages.gallery_discovery_account,'gallery_discovery_account');}
      namespace??=owner;if(await guard()!==true)throw fail('图库页面来源已变化');current();return owner;
    }
    const work=(async()=>{
      const owner=await check(),expectedAccount=`st-user:${await vibeDigest(owner.slice(8))}`;current();
      const request=galleryDiscoveryRequest({version:2,expectedAccount,limit:options.limit??24,cursor:options.cursor??null});
      const supplied=new Headers(await headers());current();const requestHeaders={Accept:'application/json','Content-Type':'application/json'};
      if(supplied.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=supplied.get('x-csrf-token');await check();
      let response,reader,cancelReader;
      try{
        response=await fetchImpl(BASE,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:requestHeaders,body:JSON.stringify(request)});
        await check();
        if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400)throw fail('图库接口发生跳转，未采用返回');
        if(response.url){const url=new URL(response.url);if(!['http:','https:'].includes(url.protocol)||url.pathname!==BASE||url.search||url.hash||url.username||url.password
          ||globalThis.location?.origin&&url.origin!==globalThis.location.origin)throw fail('图库接口返回了不同地址');}
        if(response.status===401||response.status===403){invalidateAccount();throw fail(messages.gallery_discovery_account,'gallery_discovery_account');}
        if(!/^application\/json\b/i.test(response.headers?.get?.('content-type')||'')||Number(response.headers.get('content-length'))>LIMIT.responseBytes){if(response.status===404)throw unsupported();throw fail('图库目录返回格式或大小不兼容');}
        reader=response.body?.getReader?.();if(!reader)throw fail('图库目录返回不完整');
        cancelReader=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancelReader,{once:true});
        let text='',length=0;const decoder=new TextDecoder('utf-8',{fatal:true});
        while(true){const part=await reader.read();await check();if(part.done)break;length+=part.value.byteLength;
          if(length>LIMIT.responseBytes)throw fail('图库目录返回超过读取上限');text+=decoder.decode(part.value,{stream:true});}
        text+=decoder.decode();const value=parseBoundedJson(text,{maxBytes:LIMIT.responseBytes,maxDepth:16,maxNodes:10000,label:'图库版本发现'});
        if(!response.ok||value?.ok!==true){const serviceCode=typeof value?.code==='string'&&Object.hasOwn(messages,value.code)?value.code:'';
          if(response.status===400&&value?.code==='gallery_discovery_contract')throw unsupported();
          if(response.status===404&&!serviceCode)throw unsupported();
          throw fail(messages[serviceCode]||'图库目录暂不可读取，未当作空库',serviceCode);}
        const result=await galleryDiscoveryResponse(value,{namespace:owner,request});await check();return result;
      }finally{
        if(reader){controller.signal.removeEventListener('abort',cancelReader);cancelReader();reader.releaseLock();}
        else try{void response?.body?.cancel?.().catch(()=>{});}catch{}
      }
    })();
    // Keep the slot until late/uncooperative work actually settles.
    void work.finally(()=>pending.delete(abort)).catch(()=>{});
    try{return await Promise.race([work,stopped]);}
    catch(error){if(error?.code==='gallery_discovery_client')throw error;throw fail('图库连接、内容或账户校验未通过，原作品未修改');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
  }
  return Object.freeze({list,close});
}
