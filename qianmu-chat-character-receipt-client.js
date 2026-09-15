import {CHAT_CHARACTER_RECEIPT_LIMITS as LIMIT,chatCharacterReceiptError,chatCharacterReceiptTarget,
  chatCharacterReceiptResponse,chatCharacterCollectionReceiptText} from './qianmu-chat-character-receipt.js';

const fail=message=>chatCharacterReceiptError('client',message);
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export function createChatCharacterReceiptClient({namespace,target,headers=()=>({}),fetchImpl=globalThis.fetch,guard=async()=>{},timeoutMs=10000}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||!Number.isFinite(timeoutMs))throw fail('聊天核验账户或等待时间无效');
  const selected=chatCharacterReceiptTarget(target),owner={namespace,chatKey:selected.chatId},expected=digest(namespace.slice(8)).then(value=>`st-user:${value}`);
  async function inspect({signal}={}){
    const controller=new AbortController();let rejectCancellation;
    const cancellation=new Promise((_,reject)=>{rejectCancellation=reject;});
    const abort=()=>{controller.abort();rejectCancellation(fail('聊天核验已取消，不能确认保存'));};
    signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(100,Math.min(30000,timeoutMs)));
    const check=()=>{if(controller.signal.aborted)throw fail('聊天核验已取消，不能确认保存');};
    try{
      if(signal?.aborted)abort();
      return await Promise.race([(async()=>{
        await guard();check();const expectedAccount=await expected,provided=new Headers(await headers());
        const requestHeaders={'Content-Type':'application/json',Accept:'application/json'};
        if(provided.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=provided.get('x-csrf-token');
        await guard();check();
        const response=await fetchImpl('/api/plugins/qianmu-tts/chat-characters/receipt',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
          headers:requestHeaders,body:JSON.stringify({version:1,expectedAccount,target:selected})});
        check();if(!/^application\/json\b/i.test(response.headers?.get?.('content-type')||'')||Number(response.headers.get('content-length'))>LIMIT.responseBytes)throw fail('聊天核验服务返回不兼容');
        const reader=response.body?.getReader?.();if(!reader)throw fail('聊天核验返回不完整');
        const cancelReader=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancelReader,{once:true});
        let text='',length=0;const decoder=new TextDecoder('utf-8',{fatal:true});
        try{while(true){check();const part=await reader.read();check();if(part.done)break;
          length+=part.value.byteLength;if(length>LIMIT.responseBytes)throw fail('聊天核验返回过大');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
        finally{controller.signal.removeEventListener('abort',cancelReader);cancelReader();reader.releaseLock();}
        const value=JSON.parse(text);
        if(!response.ok||value?.ok!==true)throw fail('聊天记录尚未核验，请保留现有资料后重试');
        const receipt=chatCharacterReceiptResponse(value);
        if(receipt.expectedAccount!==expectedAccount||JSON.stringify(receipt.target)!==JSON.stringify(selected))throw fail('聊天核验返回另一账户或聊天');
        await guard();check();return receipt;
      })(),cancellation]);
    }catch(error){if(error?.code==='chat_character_receipt_client')throw error;throw fail('聊天核验失败或当前页面已变化，不能确认保存');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
  }
  return Object.freeze({inspect,async verify(collection,options){
    await guard();const wanted=chatCharacterCollectionReceiptText(collection,owner),sha256=await digest(wanted.text),receipt=await inspect(options);await guard();
    if(options?.signal?.aborted)throw fail('聊天核验已取消，不能确认保存');
    // Observed equality only: never a lock, an authorization, or a substitute for a successful host save.
    return {...receipt,matches:receipt.state==='present'&&['revision','count','bytes'].every(key=>receipt.collection[key]===wanted[key])&&receipt.collection.sha256===sha256};
  }});
}
