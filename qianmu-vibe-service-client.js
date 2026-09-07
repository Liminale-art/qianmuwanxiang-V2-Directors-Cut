import {prepareNovelVibeEncoding,VIBE_ENCODING_LIMIT} from './qianmu-vibe-encoding.js';
import {validateVibeServiceDelivery} from './qianmu-vibe-encoding-store.js';
const BASE='/api/plugins/qianmu-tts/image/vibe',HASH=/^[a-f0-9]{64}$/;
const fail=(message,state='not_submitted')=>Object.assign(new Error(message),{code:'vibe_service_client',submissionState:state,retryable:false});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export function createVibeServiceClient({namespace,headers=()=>({}),fetchImpl=globalThis.fetch,guard=async()=>{},timeoutMs=240000}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))throw fail('Vibe 服务账户未确认');
  const account=digest(namespace.slice(8)).then(value=>`st-user:${value}`);
  async function call(action,body,{write=false,maximum=24*1024}={}){
    await guard();const controller=new AbortController();let timer;
    const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('Vibe 服务等待超时，请领取原结果，勿重复编码',write?'unknown':'not_submitted'));},Math.max(100,Math.min(240000,timeoutMs)));});
    try{
      return await Promise.race([(async()=>{
        const response=await fetchImpl(`${BASE}/${action}`,{method:body?'POST':'GET',headers:{...headers(),...(body?{'Content-Type':'application/json'}:{})},
          ...(body?{body:JSON.stringify(body)}:{}),credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        if(!/^application\/json\b/i.test(response.headers?.get?.('content-type')||''))throw fail('Vibe 服务返回格式不兼容，请更新增强服务',write?'unknown':'not_submitted');
        if(Number(response.headers.get('content-length'))>maximum)throw fail('Vibe 服务返回过大，未继续读取',write?'unknown':'not_submitted');
        const reader=response.body?.getReader?.();if(!reader)throw fail('Vibe 服务返回不完整',write?'unknown':'not_submitted');
        let bytes=0,text='';const decoder=new TextDecoder();
        try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maximum)throw fail('Vibe 服务返回过大',write?'unknown':'not_submitted');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
        finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
        let value;try{value=JSON.parse(text);}catch(_){throw fail('Vibe 服务返回内容损坏',write?'unknown':'not_submitted');}
        if(value?.version!==1)throw fail('Vibe 服务协议不兼容，请更新后端',write?'unknown':'not_submitted');
        if(!response.ok||value.ok!==true){
          const known=value.ok===false&&/^(?:vibe_|image_service_)/.test(value.code||'')&&typeof value.message==='string'&&value.message.length<=240;
          throw fail(known?value.message:'Vibe 服务请求未完成',write?(known&&['not_submitted','rejected'].includes(value.submissionState)?'rejected':'unknown'):'not_submitted');
        }return value;
      })(),expired]);
    }catch(error){if(error.code==='vibe_service_client')throw error;throw fail('Vibe 服务连接中断，请领取原结果，勿重复编码',write?'unknown':'not_submitted');}
    finally{clearTimeout(timer);controller.abort();}
  }
  const locate=async prepared=>{if(!HASH.test(prepared?.cacheKey||''))throw fail('Vibe 编码指纹无效');return {version:1,expectedAccount:await account,cacheKey:prepared.cacheKey};};
  async function capabilities(){
    const value=await call('capabilities');await guard();
    if(value.accountBindingVersion!==1||value.expectedAccount!==await account||value.nativeEncoding!==true||value.resultRetrieval!==true||value.automaticReplay!==false||value.maxEncodingBytes!==VIBE_ENCODING_LIMIT||value.sharedNativeChannelVersion!==1||value.receiptBindingVersion!==1)throw fail('增强服务尚未提供兼容的 Vibe 编码、串行与领取功能，请更新后端');
  }
  function result(value,prepared){
    const row=value.result;
    if(row?.version!==1||row.cacheKey!==prepared.cacheKey||JSON.stringify(row.identity)!==JSON.stringify(prepared.identity)||typeof row.encoding!=='string'
      ||!row.encoding||row.encoding.length>Math.ceil(VIBE_ENCODING_LIMIT/3)*4||row.encoding.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(row.encoding))throw fail('服务编码内容与原请求不符，请核查原结果','unknown');
    let decoded;try{decoded=atob(row.encoding);}catch(_){throw fail('服务编码内容损坏','unknown');}
    if(decoded.length>VIBE_ENCODING_LIMIT||btoa(decoded)!==row.encoding||!Number.isFinite(row.durationMs)||row.durationMs<0)throw fail('服务编码大小或格式无效','unknown');
    // Storage health is delivery metadata, not part of the immutable encoding or its fingerprint.
    return {version:1,cacheKey:row.cacheKey,identity:row.identity,encoding:row.encoding,durationMs:row.durationMs,
      ...(row.serviceDelivery!==undefined?{serviceDelivery:validateVibeServiceDelivery(row.serviceDelivery)}:{}),
      ...(HASH.test(value.attemptId||'')?{serviceAttemptId:value.attemptId}:{}),...(value.stored===false?{serviceStored:false}:{}),...(value.channelNeedsReview===true?{channelNeedsReview:true}:{})};
  }
  return {
    async attempt(prepared,previous){return previous?.status==='rejected'?digest(`${prepared.cacheKey}:${previous.attemptId}`):prepared.cacheKey;},
    async query(prepared){
      await capabilities();const value=await call('query',await locate(prepared));await guard();
      if(value.task===null)return null;
      const task=value.task;if(!task||task.cacheKey!==prepared.cacheKey||!HASH.test(task.attemptId||'')||!['ready','pending','unknown','rejected'].includes(task.status)||typeof task.resultAvailable!=='boolean'
        ||(task.status==='ready')!==task.resultAvailable)throw fail('服务编码状态不完整，请先核查');return task;
    },
    async result(prepared){const value=await call('result',await locate(prepared),{maximum:12*1024*1024});await guard();return result(value,prepared);},
    async encode(input,{authorize,guard:active=guard,clientAttemptId}={},retryAttemptId=''){
      const apiKey=input?.apiKey;if(typeof apiKey!=='string'||!apiKey||apiKey.length>2048||apiKey.trim()!==apiKey||/[\u0000-\u001f\u007f]/.test(apiKey))throw fail('请填写有效的编码 API Key');
      const prepared=await prepareNovelVibeEncoding(input);await active();await capabilities();
      if(typeof authorize!=='function'||await authorize(prepared.identity,prepared.cacheKey)!==true)throw fail('Vibe 服务编码未获授权');
      await active();await guard();
      const request={version:1,provider:'novel',protocol:'novelai',model:prepared.body.model,capabilityModelId:prepared.identity.capabilityModelId,baseUrl:prepared.identity.endpoint,
        apiKey,image:prepared.body.image,information:prepared.body.information_extracted};
      const value=await call('submit',{...await locate(prepared),request,confirmed:true,retryAttemptId,...(clientAttemptId!==undefined?{clientAttemptId}:{})},{write:true,maximum:12*1024*1024});
      // Caller persists completed bytes under the frozen original namespace before its next live-page guard.
      return result(value,prepared);
    },
  };
}
