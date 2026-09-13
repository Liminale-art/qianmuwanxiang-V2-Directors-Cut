// Explicit cancellation of one owned task. Not submission, retry, archive or deletion.
import { bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { createComfyCloudServerTransport } from './qianmu-comfy-server-transport.js';
import { readComfyCloudJsonResponse, readComfyCloudTaskStatus } from './qianmu-comfy-cloud-response.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

export function readComfyCloudCancellation(rawTask, body) {
  const task=bindComfyCloudTask(rawTask,rawTask?.taskId,rawTask?.links);
  if(task.provider==='runninghub') {
    if(!body||body.code!==0||body.data!==null)throw new Error('云端未确认取消请求，请核查原任务');
    // RH acknowledges the request without returning execution state or a refund.
    return Object.freeze({task,requestAccepted:true,status:'cancel_requested',terminal:false});
  }
  return Object.freeze({...readComfyCloudTaskStatus(task,body),requestAccepted:true});
}

export async function cancelComfyCloudTask(req, rawTask, { apiKey, confirmed=false, authorizeCancellation, authorizeTarget,
  timeoutMs=15000, signal, resolveHost, requestImpl }={}) {
  const task=bindComfyCloudTask(rawTask,rawTask?.taskId,rawTask?.links);
  const fail=(code,message)=>Object.assign(new Error(message),{code:`comfy_cloud_cancel_${code}`,submissionState:'accepted',upstreamId:task.taskId,retryable:false});
  const account=imageServiceAccount(req);
  if(confirmed!==true||typeof authorizeCancellation!=='function'||typeof authorizeTarget!=='function')throw fail('authorization','请确认取消原任务；未发送取消请求');
  if(typeof apiKey!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(apiKey)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw fail('options','请核对原连接的 Key 和等待时间');
  const controller=new AbortController(),deadline=performance.now()+timeoutMs;let timer,onAbort,response,interruption;
  const check=()=>{
    if(interruption)throw interruption;
    if(!imageServiceAccountStillMatches(req,account))throw fail('account','ST账户已变化，请核查原任务取消状态');
  };
  const stopped=new Promise((_,reject)=>{
    const stop=error=>{interruption ||= error;controller.abort();reject(interruption);};
    timer=setTimeout(()=>stop(fail('timeout','取消结果未确认，请核查原任务；没有重新生成')),timeoutMs);
    onAbort=()=>stop(fail('stopped','已停止等待，取消结果请从原任务核查'));
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  });
  const work=async()=>{
    check();const original=await authorizeCancellation(req,task,account);check();
    if(typeof original!=='function')throw fail('authorization','原任务缺少取消授权');
    const verify=async()=>{check();await original();check();};await verify();
    const transport=await createComfyCloudServerTransport(req,{binding:task,operation:'cancel',task},{signal:controller.signal,resolveHost,requestImpl,
      authorizeTarget:async(...args)=>{await verify();const target=await authorizeTarget(...args);check();
        if(typeof target!=='function')throw fail('authorization','原连接缺少取消授权');
        return async()=>{await verify();await target();check();};}});
    await verify();
    response=await transport.fetchImpl(transport.plan.url,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json',
      ...(task.provider==='runninghub'?{'Content-Type':'application/json'}:{})},
      ...(task.provider==='runninghub'?{body:JSON.stringify({...transport.plan.body,apiKey})}:{}),signal:controller.signal});
    check();const body=await readComfyCloudJsonResponse(response,{task,maxBytes:1024*1024,timeoutMs:Math.max(1,Math.ceil(deadline-performance.now())),signal:controller.signal});
    await transport.verify();check();return readComfyCloudCancellation(task,body);
  };
  try{return await Promise.race([work(),stopped]);}
  catch(_){throw interruption||fail('unconfirmed','取消结果未确认，请核查原任务；没有重新生成');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.abort();try{Promise.resolve(response?.body?.cancel?.()).catch(()=>{});}catch(_){/* Transport owns remaining bytes. */}}
}
