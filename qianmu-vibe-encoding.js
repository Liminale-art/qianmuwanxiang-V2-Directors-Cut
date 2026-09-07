import {normalizeNovelVibeImage} from './qianmu-novel-vibe.js';
import {novelModelCapabilities} from './qianmu-image-models.js';
import {resolveImageTransportBinding} from './qianmu-image-transport.js';
import {VIBE_ENCODING_MODELS} from './qianmu-vibe-asset-ref.js';

export const VIBE_ENCODING_VERSION=1;
export const VIBE_ENCODING_LIMIT=8*1024*1024;
const fail=(code,message,submissionState='not_submitted',status=0)=>Object.assign(new Error(message),{code:`vibe_encoding_${code}`,submissionState,status,retryable:false});
const validText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value);
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');

export function novelVibeEncodeEndpoint(value){
  if(!validText(value,2048))throw fail('address','请填写完整的 Vibe 编码 API 地址');
  let url;try{url=new URL(value);}catch(_){throw fail('address','Vibe 编码地址无效');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw fail('address','Vibe 编码需使用 HTTPS，地址不能携带账号、查询参数或锚点');
  let path=url.pathname.replace(/\/+$/,'');
  if(path.endsWith('/ai/encode-vibe'))return url.toString().replace(/\/+$/,'');
  path=path.replace(/\/ai\/(?:generate-image|encode-vibe)$/,'').replace(/\/ai$/,'');
  url.pathname=`${path}/ai/encode-vibe`;return url.toString();
}

// A request is prepared/fingerprinted before authorization. Reference strength is a generation setting, not an encoding parameter.
export async function prepareNovelVibeEncoding(input){
  if(!input||input.version!==1||input.provider!=='novel'||resolveImageTransportBinding('novel',input).protocol!=='novelai')throw fail('version','Vibe 编码只支持声明完整的 NAI 原生连接');
  const capabilities=novelModelCapabilities(input.model,input.capabilityModelId),encodingModel=VIBE_ENCODING_MODELS[capabilities.capabilityModelId];
  if(!capabilities.ok||!capabilities.known||!encodingModel)throw fail('model','请选择具备 Vibe 编码能力的 V4 / V4.5 模型');
  if(!validText(input.model,240))throw fail('model','Vibe 编码模型名无效');
  if(typeof input.information!=='number'||!Number.isFinite(input.information)||input.information<0||input.information>1)throw fail('parameters','信息提取须为 0～1 的数值');
  if(['mask','focus_seed','info_extract_seed','crop_to_mask','parameters'].some(key=>Object.hasOwn(input,key)))throw fail('parameters','此编码入口不接受未声明的额外参数');
  const image=normalizeNovelVibeImage({data:input.image}),endpoint=novelVibeEncodeEndpoint(input.baseUrl),model=input.model,information=input.information;
  const body=Object.freeze({image:image.data,information_extracted:information,model});
  const sourceId=await digest(image.data);
  const identity=Object.freeze({version:1,endpoint,remoteModelId:model,capabilityModelId:capabilities.capabilityModelId,encodingModel,sourceId,parameters:Object.freeze({information_extracted:information})});
  return Object.freeze({identity,cacheKey:await digest(JSON.stringify(identity)),body});
}

async function readEncoding(response,signal){
  const type=String(response.headers?.get?.('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['application/binary','application/octet-stream','binary/octet-stream'].includes(type))throw fail('response','编码服务未返回二进制编码；请核查渠道，勿重复提交','unknown');
  const declared=Number(response.headers?.get?.('content-length')||0);
  if(declared>VIBE_ENCODING_LIMIT)throw fail('size','编码返回超过 8 MB，请核查原请求','unknown');
  const reader=response.body?.getReader?.();if(!reader)throw fail('response','编码服务未提供可读取内容','unknown');
  let length=0;const chunks=[];
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
    while(true){if(signal.aborted)throw fail('unknown','编码结果未确认，请核查渠道记录，勿重复提交','unknown');const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>VIBE_ENCODING_LIMIT)throw fail('size','编码返回超过 8 MB，请核查原请求','unknown');chunks.push(value);}
    if(signal.aborted||!length||declared>0&&declared!==length)throw fail('response','编码内容不完整，请核查原请求，勿重复提交','unknown');
    let binary='';for(const bytes of chunks)for(let at=0;at<bytes.length;at+=32768)binary+=String.fromCharCode(...bytes.subarray(at,at+32768));
    return btoa(binary);
  }finally{signal.removeEventListener('abort',cancel);try{await reader.cancel();}catch(_){}reader.releaseLock();}
}

// One explicit native POST. There is deliberately no retry, polling, image-generation call or fallback here.
export async function encodeNovelVibe(input,{fetchImpl=globalThis.fetch,authorize,guard=async()=>{},timeoutMs=180000,signal=input?.signal}={}){
  const apiKey=input?.apiKey;if(!validText(apiKey,2048))throw fail('key','请填写有效 API Key');
  if(typeof authorize!=='function'||typeof guard!=='function'||typeof fetchImpl!=='function')throw fail('authorization','此编码尚未获得明确授权');
  const prepared=await prepareNovelVibeEncoding(input);await guard();
  if(signal?.aborted||await authorize(prepared.identity,prepared.cacheKey)!==true)throw fail('cancelled','未授权本次 Vibe 编码');
  await guard();if(signal?.aborted)throw fail('cancelled','Vibe 编码已取消，尚未提交');
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  let submission='not_submitted',response,timer;const started=Date.now();
  let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(fail('unknown','编码已停止等待，结果未确认，请核查渠道记录，勿重复提交',submission));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('unknown','编码结果未确认，请核查渠道记录，勿重复提交','unknown'));},Math.max(100,Math.min(180000,Number(timeoutMs)||180000)));});
  try{
    const operation=(async()=>{
      if(controller.signal.aborted)throw fail('cancelled','Vibe 编码已取消，尚未提交');submission='unknown';
      response=await fetchImpl(prepared.identity.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
        body:JSON.stringify(prepared.body),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
      if(!response.ok){submission=[400,401,402,403,404,413,422,429].includes(response.status)?'rejected':'unknown';
        throw fail(`http_${response.status}`,`Vibe 编码未完成（${response.status}）${submission==='unknown'?'，请核查原请求，勿重复提交':''}`,submission,response.status);}
      const encoding=await readEncoding(response,controller.signal);
      return {version:1,cacheKey:prepared.cacheKey,identity:prepared.identity,encoding,durationMs:Date.now()-started};
    })();
    return await Promise.race([operation,timeout,aborted]);
  }catch(error){
    if(typeof error?.code==='string'&&error.code.startsWith('vibe_encoding_'))throw error;
    throw fail('unknown','编码结果未确认，请核查渠道记录，勿重复提交',submission);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',rejectAbort);controller.abort();try{void response?.body?.cancel?.().catch(()=>{});}catch(_){}}
}
