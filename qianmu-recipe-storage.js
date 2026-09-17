import {recipeArchiveStorageRequest,recipeArchiveStorageResponse} from './qianmu-recipe-archive-contract.js';

const stale=()=>Object.assign(new Error('储存账户或页面已变化，请重新盘点'),{code:'recipe_storage_stale'});
const unavailable=()=>new Error('服务器配方暂未读取；请确认配套后端可用后刷新。未读取不代表零占用。');
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),n=>n.toString(16).padStart(2,'0')).join('');

// Account-level server file observation, independent of any open chat. Never part
// of browser quota, cleanup candidates, recipe validation or an ownership graph.
export async function collectRecipeArchiveStorage({resolveNamespace,valid=()=>true,headers,fetchImpl=globalThis.fetch,timeoutMs=6000}={}){
  const controller=new AbortController();let namespace,timer;
  const alive=()=>{if(!valid())throw stale();if(controller.signal.aborted)throw unavailable();};
  const check=async()=>{alive();const current=await resolveNamespace();alive();if(!account(current)||namespace!==undefined&&namespace!==current)throw stale();namespace=current;};
  const task=async()=>{
    try{
      await check();const expectedAccount='st-user:'+await digest(namespace.slice(8));alive();
      const body=recipeArchiveStorageRequest({version:1,expectedAccount});
      const provided=new Headers(await headers?.());await check();
      const requestHeaders={'Content-Type':'application/json',Accept:'application/json'};
      if(provided.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=provided.get('x-csrf-token');
      const response=await fetchImpl('/api/plugins/qianmu-tts/chat-gallery/recipe/storage',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:requestHeaders,body:JSON.stringify(body)});
      const discard=()=>{void response.body?.cancel?.().catch(()=>{});};
      if(controller.signal.aborted||!valid()){discard();alive();}
      if(!response.ok||!/^application\/json\b/i.test(response.headers?.get?.('content-type')||'')||Number(response.headers.get('content-length'))>16384){discard();throw unavailable();}
      const reader=response.body?.getReader?.();if(!reader)throw unavailable();
      const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      let text='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
      try{while(true){alive();const part=await reader.read();alive();if(part.done)break;
        bytes+=part.value.byteLength;if(bytes>16384)throw unavailable();text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
      const result=recipeArchiveStorageResponse(JSON.parse(text));
      if(result.expectedAccount!==expectedAccount)throw unavailable();await check();
      return {namespace,status:'ready',state:result.state,files:result.files,bytes:result.bytes,limitFiles:result.limitFiles,limitBytes:result.limitBytes};
    }catch(error){if(error?.code==='recipe_storage_stale')throw error;await check();throw unavailable();}
  };
  try{return await Promise.race([task(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},Number.isFinite(timeoutMs)?Math.max(100,Math.min(30000,timeoutMs)):6000);})]);}
  catch(error){if(!valid()||error?.code==='recipe_storage_stale')throw stale();return {namespace,status:'unavailable',bytes:null,files:null,error:unavailable().message};}
  finally{clearTimeout(timer);controller.abort();}
}
