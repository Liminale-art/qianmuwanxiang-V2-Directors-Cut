import {recipeVerificationRequest,recipeVerificationResponse} from './qianmu-recipe-restore-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const fail=message=>{throw Object.assign(Error(message),{code:'recipe_verify_client',submissionState:'not_submitted'});};
export function createRecipeVerificationClient({namespace,headers=()=>({}),guard,fetchImpl=globalThis.fetch,timeoutMs=30000}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)
    ||![headers,guard,fetchImpl].every(fn=>typeof fn==='function')||!Number.isFinite(timeoutMs)||timeoutMs<1)fail('配方文件核对缺少账户保护');
  let closed=false;const pending=new Set(),account=vibeDigest(namespace.slice(8)).then(hash=>'st-user:'+hash);
  return Object.freeze({close(){closed=true;for(const stop of pending)stop();},
    async verify(input,{signal}={}){
      if(!input||Object.keys(input).length!==2||!Object.hasOwn(input,'source')||!Object.hasOwn(input,'reference'))fail('配方文件核对不接受额外范围');
      const captured=recipeVerificationRequest({version:1,expectedAccount:'st-user:'+'0'.repeat(64),source:input.source,reference:input.reference});
      if(closed||signal?.aborted)fail('配方文件核对已结束');let reject;
      const controller=new AbortController(),cancelled=new Promise((_,no)=>reject=no),abort=()=>{controller.abort();reject(Error('配方文件核对已取消或超时'));};
      pending.add(abort);signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.min(30000,timeoutMs));
      const check=async()=>{if(closed||controller.signal.aborted||await guard()!==true||closed||controller.signal.aborted)fail('配方文件核对来源已变化');};
      try{return await Promise.race([(async()=>{
        await check();const body={...captured,expectedAccount:await account},supplied=new Headers(await headers()),requestHeaders={'Content-Type':'application/json',Accept:'application/json'};
        if(supplied.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=supplied.get('x-csrf-token');await check();
        const response=await fetchImpl('/api/plugins/qianmu-tts/chat-gallery/recipe/verify-restored',{method:'POST',body:JSON.stringify(body),headers:requestHeaders,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        const discard=()=>{void response.body?.cancel?.().catch(()=>{});};
        if(closed||controller.signal.aborted){discard();fail('配方文件核对已结束');}
        if(response.redirected||response.status>=300&&response.status<400||!/^application\/json\b/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>8192){discard();fail('配方文件核对服务不可用或回执不兼容；未重新上传');}
        const reader=response.body?.getReader?.();if(!reader)fail('配方文件核对回执缺失');let text='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
        const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
        try{while(true){if(controller.signal.aborted)fail('配方文件核对已取消');const part=await reader.read();if(controller.signal.aborted)fail('配方文件核对已取消');if(part.done)break;
          bytes+=part.value.byteLength;if(bytes>8192)fail('配方文件核对回执过大');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
        finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
        const value=JSON.parse(text);if(!response.ok)fail('原配方文件缺失、变化或服务不可用；未补造或改写引用');const receipt=recipeVerificationResponse(value);
        if(receipt.expectedAccount!==body.expectedAccount||JSON.stringify(receipt.source)!==JSON.stringify(body.source)||['id','sha256','bytes','version'].some(k=>receipt.reference[k]!==body.reference[k]))fail('配方文件核对返回另一来源');
        await check();return receipt;
      })(),cancelled]);}finally{clearTimeout(timer);pending.delete(abort);signal?.removeEventListener('abort',abort);controller.abort();}
    },
  });
}
