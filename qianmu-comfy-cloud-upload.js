// Host-internal selected-source upload. No path guessing, public route, new job,
// automatic retry or persistence. Source grants are supplied by the ST host.
import { createHash } from 'node:crypto';
import { planComfyCloudUpload, readComfyCloudUpload } from './qianmu-comfy-cloud-upload-contract.js';
import { createComfyCloudUploadTransport } from './qianmu-comfy-server-transport.js';
import { readComfyCloudJsonResponse } from './qianmu-comfy-cloud-response.js';
import { comfyReferenceStillMime } from './qianmu-comfy-results.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

export async function uploadComfyCloudReference(req, input, {apiKey,authorizeSource,authorizeTarget,timeoutMs=30000,signal,resolveHost,requestImpl}={}) {
  const fail=message=>Object.assign(new Error(message),{code:'comfy_cloud_upload_unconfirmed',submissionState:'not_submitted',retryable:false});
  const account=imageServiceAccount(req),plan=planComfyCloudUpload(input?.connection,input?.source);
  if(typeof apiKey!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(apiKey)||typeof authorizeSource!=='function'||typeof authorizeTarget!=='function'
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw fail('参考图上传缺少原连接或文件授权，未发送');
  const controller=new AbortController(),deadline=performance.now()+timeoutMs;let timer,onAbort,interruption,response;
  const check=()=>{if(!interruption&&performance.now()>=deadline)interruption=fail('参考图上传超时，结果尚待核查；未提交生图');if(interruption)throw interruption;if(!imageServiceAccountStillMatches(req,account))throw fail('ST账户已变化，未继续上传或生图');};
  const stopped=new Promise((_,reject)=>{
    const stop=message=>{interruption ||= fail(message);controller.abort();reject(interruption);};
    timer=setTimeout(()=>stop('参考图上传超时，结果尚待核查；未提交生图'),timeoutMs);
    onAbort=()=>stop('已停止等待参考图上传，未提交生图');signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  });
  const work=async()=>{
    check();const grant=await authorizeSource(req,plan,account,{signal:controller.signal});check();
    if(typeof grant?.read!=='function'||typeof grant?.verify!=='function')throw fail('参考图缺少完整文件授权');
    const verify=async()=>{check();await grant.verify();check();};await verify();
    const source=await grant.read({signal:controller.signal});check();await verify();
    if(!(source instanceof Uint8Array)||source.byteLength!==plan.source.bytes)throw fail('参考图内容已变化，请重新选择');
    // Freeze byte identity before another await or constructing the request body.
    const bytes=Buffer.from(source);
    if(comfyReferenceStillMime(bytes)!==plan.source.mime||createHash('sha256').update(bytes).digest('hex')!==plan.source.sha256)throw fail('参考图内容已变化，请重新选择');
    check();
    const form=new FormData();form.append(plan.fileField,new Blob([bytes],{type:plan.source.mime}),plan.filename);
    for(const [key,value] of Object.entries(plan.fields))form.append(key,value);
    const transport=await createComfyCloudUploadTransport(req,plan,{signal:controller.signal,resolveHost,requestImpl,authorizeTarget,authorizeSource:async()=>verify});
    await verify();response=await transport.fetchImpl(plan.url,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json'},body:form,signal:controller.signal});
    check();const body=await readComfyCloudJsonResponse(response,{maxBytes:1024*1024,timeoutMs:Math.max(1,Math.ceil(deadline-performance.now())),signal:controller.signal});
    await transport.verify();check();return readComfyCloudUpload(plan,body);
  };
  try{return await Promise.race([work(),stopped]);}
  catch(_){throw interruption||fail('参考图上传未完成或信息不匹配，请核查原连接与图片；未提交生图');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.abort();try{Promise.resolve(response?.body?.cancel?.()).catch(()=>{});}catch(_){/* Transport owns remaining bytes. */}}
}
