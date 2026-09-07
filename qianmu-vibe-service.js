import {createHash} from 'node:crypto';
import {createImageServiceStore} from './qianmu-image-service-store.js';
import {createImageServiceQueue,imageServiceChannelKey,normalizeImageServiceChannel} from './qianmu-image-service-queue.js';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {createVibeServiceCache,validateVibeServiceResult} from './qianmu-vibe-service-cache.js';
import {prepareNovelVibeEncoding} from './qianmu-vibe-encoding.js';
import {encodeGatewayNovelVibe} from './qianmu-vibe-encoding-gateway.js';
import {createNovelServiceChannel} from './qianmu-novel-service-channel.js';
const hash=value=>createHash('sha256').update(value).digest('hex'),validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=(code,message,submissionState='not_submitted',status=409)=>Object.assign(new Error(message),{code:`vibe_service_${code}`,message,submissionState,status,retryable:false});
const resource=(namespace,key)=>`vibe:${namespace}:${key}`;
export function vibeServiceErrorPayload(error){
  const known=/^(?:vibe_|image_service_|private_|invalid_|unsafe_|base_url)/.test(error?.code||'');
  return {status:[400,401,403,404,409,413,429,503].includes(error?.status)?error.status:409,body:{ok:false,version:1,
    code:known?error.code:'vibe_service_failed',message:known?String(error.message).slice(0,240):'Vibe 编码服务未完成，请核查原请求',retryable:false,
    submissionState:['not_submitted','rejected','unknown','accepted'].includes(error?.submissionState)?error.submissionState:'unknown'}};
}
export function createVibeEncodingService({dataRoot,store=createImageServiceStore({dataRoot,scope:'vibe',lockWaitMs:2000}),cache,channel=createNovelServiceChannel({dataRoot}),
  encode=encodeGatewayNovelVibe,gatewayOptions={},queueOptions={}}={}){
  const results=cache||createVibeServiceCache({dataRoot,store}),queue=createImageServiceQueue({...queueOptions,store,resourceLabel:'Vibe 编码'});
  const jobs=new Map();let closed=false,admitted=0,bytes=0;
  function binding(req,input){
    const account=imageServiceAccount(req);
    if(input?.version!==1||input.expectedAccount!==account.namespace)throw fail('account','ST 登录账户或编码协议已变化，请重新核查','not_submitted',401);
    if(!validHash(input.cacheKey))throw fail('identity','缺少有效的 Vibe 编码指纹','not_submitted',400);
    const key=input.cacheKey;return {...account,cacheKey:key,channelKey:imageServiceChannelKey(resource(account.namespace,key))};
  }
  const check=(req,value)=>{if(!imageServiceAccountStillMatches(req,value))throw fail('account','ST 账户已变化，编码保留在原账户，请切回核查','unknown',401);};
  const find=async value=>normalizeImageServiceChannel(await store.inspectChannel(value.channelKey),value.channelKey).entries
    .filter(row=>row.namespace===value.namespace&&row.requestDigest===value.cacheKey).at(-1);
  const owner=(value,row)=>({namespace:value.namespace,channelKey:value.channelKey,attemptId:row.attemptId,requestDigest:row.requestDigest,fence:row.fence});
  const packet=(result,stored=true,warning='',channelNeedsReview=false)=>({ok:true,version:1,result,stored,...(warning?{warning}:{}),...(channelNeedsReview?{channelNeedsReview:true}:{})});
  async function completed(req,value,row,result){
    let review=false;try{await channel.completeFromCache({namespace:value.namespace,kind:'vibe',attemptId:row.attemptId,requestDigest:row.requestDigest});}catch(_){review=true;}
    check(req,value);return packet(result,true,'',review);
  }
  async function retrieve(req,value,row){
    if(!row)throw fail('missing','未找到当前账户的原 Vibe 编码','not_submitted',404);
    const result=await results.load(owner(value,row));check(req,value);
    if(!result)throw fail('pending','原 Vibe 编码尚未暂存或已被清理；未重新编码','unknown');return completed(req,value,row,result);
  }
  return {
    async query(req,input){
      const value=binding(req,input),row=await find(value);check(req,value);if(!row)return {ok:true,version:1,task:null};
      const cached=await results.load(owner(value,row),{metadataOnly:true});check(req,value);
      return {ok:true,version:1,task:{cacheKey:value.cacheKey,attemptId:row.attemptId,status:cached?.available?'ready':
        ['released','rejected'].includes(row.status)?'rejected':['reserved','submitting'].includes(row.status)?'pending':'unknown',
        resultAvailable:Boolean(cached?.available),bytes:cached?.bytes||0,createdAt:row.createdAt,updatedAt:row.updatedAt}};
    },
    async result(req,input){const value=binding(req,input),row=await find(value);check(req,value);return retrieve(req,value,row);},
    async submit(req,input,{signal}={}){
      const value=binding(req,input);if(closed)throw fail('closed','编码服务正在停止');
      if(input.confirmed!==true)throw fail('consent','本次编码尚未获得明确费用确认');
      if(admitted>=8)throw fail('capacity','编码等待已满，请稍后重试','not_submitted',429);
      // Closed native request surface: no arbitrary headers, disk paths, proxy flags or undeclared encoding parameters.
      const raw=input.request,retryAttemptId=input.retryAttemptId||'';
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['version','provider','protocol','model','capabilityModelId','baseUrl','apiKey','image','information'].includes(key)))throw fail('request','Vibe 编码请求含未声明字段','not_submitted',400);
      if(typeof raw.image!=='string'||raw.image.length>24*1024*1024)throw fail('size','Vibe 编码原图大小无效','not_submitted',413);
      if(['provider','model','baseUrl','apiKey'].some(key=>typeof raw[key]!=='string'||raw[key].length>2048)
        ||['protocol','capabilityModelId'].some(key=>raw[key]!==undefined&&(typeof raw[key]!=='string'||raw[key].length>240))
        ||typeof raw.information!=='number'||raw.version!==1)throw fail('request','Vibe 编码参数类型无效','not_submitted',400);
      const captured={...raw},weight=Buffer.byteLength(raw.image);if(bytes+weight>64*1024*1024)throw fail('capacity','编码素材正在处理，请稍后重试','not_submitted',429);
      admitted++;bytes+=weight;
      try{
        const prepared=await prepareNovelVibeEncoding(captured);check(req,value);
        if(prepared.cacheKey!==value.cacheKey)throw fail('identity','Vibe 编码内容与确认指纹不符');
        const previous=await find(value);check(req,value);
        if(previous){
          const saved=await results.load(owner(value,previous));check(req,value);if(saved)return completed(req,value,previous,saved);
          if(!['rejected','released'].includes(previous.status)||retryAttemptId!==previous.attemptId)throw fail('pending','此 Vibe 原请求尚待核查；未重复编码','unknown');
        }else if(retryAttemptId)throw fail('identity','原重试记录不存在，未发起新编码');
        // Identical new/retry intents have the SAME attempt ID across devices/processes, closing the query→claim race.
        const attemptId=previous?hash(`${value.cacheKey}:${previous.attemptId}`):value.cacheKey,id=`${value.namespace}:${value.cacheKey}`;
        if(jobs.has(id))throw fail('pending','此 Vibe 编码仍在处理，请领取原结果','unknown');
        const work=queue.run({apiKey:resource(value.namespace,value.cacheKey),namespace:value.namespace,attemptId,requestDigest:value.cacheKey,requestBytes:weight,
          automatic:false,signal,valid:()=>!closed&&imageServiceAccountStillMatches(req,value)},async ticket=>{
          const identity={namespace:value.namespace,channelKey:value.channelKey,attemptId,requestDigest:value.cacheKey,fence:ticket.fence};
          try{await results.reserve(identity);}catch(_){throw fail('storage','Vibe 服务暂存无法预留，请先整理；本次尚未提交编码');}
          let authorized=false,result,channelNeedsReview=false;
          try{
            // Disconnect stops waiting/preparation, not a POST that might have charged. Completed bytes are still cached for this owner.
            result=await channel.run({apiKey:captured.apiKey,namespace:value.namespace,kind:'vibe',attemptId,requestDigest:value.cacheKey,
              signal,valid:()=>!closed&&imageServiceAccountStillMatches(req,value),onWarning:()=>{channelNeedsReview=true;}},shared=>encode(captured,{...gatewayOptions,guard:async()=>{check(req,value);if(closed||signal?.aborted)throw fail('cancelled','编码等待已取消，未继续提交');},
              authorize:async(actual,key)=>{if(key!==prepared.cacheKey||JSON.stringify(actual)!==JSON.stringify(prepared.identity))throw fail('identity','编码参数已变化');await ticket.beforeSubmit();await shared.beforeSubmit();authorized=true;return true;}}));
          }catch(error){throw fail('encode',/^(vibe_|image_service_)/.test(error?.code||'')?error.message:'Vibe 编码结果未确认，请核查原请求',
            error?.submissionState==='rejected'?'rejected':authorized?'unknown':'not_submitted');}
          try{await validateVibeServiceResult(result,identity);}catch(_){throw fail('result','编码返回不完整，请核查原请求，勿重复提交','unknown');}
          let stored=false;
          try{await results.save(identity,result);stored=true;}catch(_){try{stored=Boolean(await results.load(identity));}catch(_){} }
          return packet(result,stored,stored?'':'编码已返回；服务暂存未完成，请先保存在当前设备，勿重复提交',channelNeedsReview);
        });jobs.set(id,work);
        try{const result=await work;check(req,value);return result;}finally{if(jobs.get(id)===work)jobs.delete(id);}
      }finally{admitted--;bytes-=weight;}
    },
    async close(){closed=true;queue.close();await Promise.allSettled([...jobs.values()]);await channel.close();await store.close();},
    inspect(){return {closed,admitted,bytes,jobs:jobs.size,...queue.inspect()};},
  };
}
