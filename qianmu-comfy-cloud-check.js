// Explicit, bounded account/queue probe. Never submits, lists model graphs,
// mutates cloud state, returns upstream account details, or falls back to native.
import { resolveStoryboardComfyCloud, planComfyCloudConnectionCheck } from './qianmu-comfy-cloud-protocol.js';
import { authorizeComfyCloudTarget } from './qianmu-comfy-cloud-access.js';
import { createComfyCloudCheckTransport } from './qianmu-comfy-server-transport.js';
import { readComfyCloudJsonResponse } from './qianmu-comfy-cloud-response.js';
import { ImageGatewayError } from './qianmu-image-gateway.js';

const fail=(code,message,status=400)=>Object.assign(new ImageGatewayError(status,`comfy_cloud_check_${code}`,message),{submissionState:'not_submitted',retryable:false});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export async function checkComfyCloudConnection(req,input,{policy,transportOptions={},signal,timeoutMs=20000}={}) {
  let binding;try { binding=resolveStoryboardComfyCloud(input); } catch (_) { throw fail('address','请填写有效的官方云平台 API 根地址'); }
  if (!binding) throw fail('address','此连接不是支持的官方云平台');
  const verify=await authorizeComfyCloudTarget(req,{baseUrl:binding.origin,allowPrivateNetwork:false},{policy});
  const apiKey=typeof input?.apiKey==='string'?input.apiKey.trim():'';
  if (!apiKey || apiKey.length>2048 || /[\u0000-\u0020\u007f]/.test(apiKey)) throw fail('key','请填写有效的 API Key');
  if (!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000) throw fail('timeout','连接检查时限无效');
  const result={ok:true,provider:'comfy',cloudProvider:binding.provider,verified:false,actualGenerationVerified:false};
  if (!planComfyCloudConnectionCheck(binding)) {
    signal?.throwIfAborted();await verify();
    return {...result,transport:'configured',message:'此部署地址未执行连接探测，请以生图验证'};
  }
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let timer,response;
  // Bound DNS, headers and stalled streams together; rejection leaves no retry.
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('timeout','连接检查超时，请稍后重试',504));},timeoutMs);});
  try {
    return await Promise.race([deadline,(async()=>{
      const transport=await createComfyCloudCheckTransport(req,binding,{...transportOptions,signal:combined,
        authorizeTarget:(request,target)=>authorizeComfyCloudTarget(request,target,{policy})});
      combined.throwIfAborted();await verify();
      const rh=binding.provider==='runninghub';
      response=await transport.fetchImpl(transport.plan.url,{method:transport.plan.method,redirect:'error',signal:combined,
        headers:rh?{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'}:{'X-API-Key':apiKey},
        ...(rh?{body:JSON.stringify({apikey:apiKey})}:{})});
      const status=response.status;
      if (!response.ok) {
        if ([401,403].includes(status)) throw fail('authentication','API Key 无效或没有访问此平台的权限',status);
        if (status===429) throw fail('rate_limit','平台请求频繁，请稍后再试',429);
        throw fail('http',`平台连接检查未通过（HTTP ${status}）`,502);
      }
      const data=await readComfyCloudJsonResponse(response,{maxBytes:1024*1024,signal:combined,timeoutMs});
      combined.throwIfAborted();await transport.verify();await verify();combined.throwIfAborted();
      if (rh) {
        if (data.code!==0) throw fail('platform','平台未通过账户检查，请核对 Key 与账户状态',502);
        if (!object(data.data)||typeof data.data.remainCoins!=='string'||typeof data.data.currentTaskCounts!=='string') throw fail('format','平台返回的账户信息格式不兼容',502);
      } else if (!Array.isArray(data.queue_running)||!Array.isArray(data.queue_pending)) throw fail('format','平台返回的队列信息格式不兼容',502);
      return {...result,message:'地址可达，请以生图验证'};
    })()]);
  } catch (error) {
    if (error instanceof ImageGatewayError && error.code.startsWith('comfy_cloud_check_')) throw error;
    if (combined.aborted) throw fail('cancelled','连接检查已停止，未提交生成');
    throw fail('unavailable','云连接检查失败，请核对地址、Key 与网络后重试',502);
  } finally {
    clearTimeout(timer);controller.abort();try { Promise.resolve(response?.body?.cancel()).catch(()=>{}); } catch (_) { /* reader owns cleanup */ }
  }
}
