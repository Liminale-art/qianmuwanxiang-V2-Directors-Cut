// Host-only, read-only Cloud main-site catalog inspection. It is not execution
// authority, proof of actual generation or permission to follow remote options.
import { prepareComfyReadiness, inspectComfyDefinitions, isDeferredComfyReferenceIssue } from './qianmu-comfy-readiness.js';
import { planComfyCloudReadiness } from './qianmu-comfy-cloud-protocol.js';
import { createComfyCloudReadinessTransport } from './qianmu-comfy-server-transport.js';
import { readComfyCloudDefinitionsResponse } from './qianmu-comfy-cloud-response.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { describeImageServiceRequest } from './qianmu-image-service-queue.js';
import { parseBoundedJson } from './qianmu-json-input.js';

const fail=message=>Object.assign(new Error(message),{code:'comfy_cloud_readiness',submissionState:'not_submitted',retryable:false});
export async function checkComfyCloudReadiness(req,raw,{apiKey,authorizeTarget,timeoutMs=20000,maxBytes,signal,resolveHost,requestImpl}={}) {
  const started=performance.now(),account=imageServiceAccount(req);
  let prepared,plan,sourceGraph;
  try {
    if(describeImageServiceRequest({input:raw}).requestBytes>2*1024*1024)throw Error();
    const input=parseBoundedJson(JSON.stringify(raw),{maxBytes:2*1024*1024,maxDepth:40,maxNodes:50000,label:'云节点检查'});
    if(Object.keys(input).some(key=>!['connection','workflow','parameters','model','referenceCount','outputNodeId'].includes(key)))throw Error();
    plan=planComfyCloudReadiness(input.connection);
    if(!plan)throw Error();
    prepared=prepareComfyReadiness(input);
    sourceGraph=typeof input.workflow==='string'?JSON.parse(input.workflow):input.workflow;
  } catch (_) {throw fail('当前平台或工作流不能进行节点清单检查，请手动确认；未提交生图');}
  if(typeof apiKey!=='string'||!/^[\x21-\x7e]{1,2048}$/.test(apiKey)||typeof authorizeTarget!=='function'
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw fail('节点检查缺少有效连接授权或等待配置');
  const controller=new AbortController(),deadline=started+timeoutMs;let timer,onAbort,interruption,response;
  const check=()=>{
    if(interruption)throw interruption;
    if(performance.now()>=deadline)throw fail('节点清单读取超时，请手动确认；未提交生图');
    if(!imageServiceAccountStillMatches(req,account))throw fail('ST账户已变化，未继续节点检查');
  };
  const stopped=new Promise((_,reject)=>{
    const stop=message=>{interruption ||= fail(message);controller.abort();reject(interruption);};
    timer=setTimeout(()=>stop('节点清单读取超时，请手动确认；未提交生图'),Math.max(1,Math.ceil(deadline-performance.now())));
    onAbort=()=>stop('节点检查已停止，未提交生图');signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  });
  const work=async()=>{
    check();const transport=await createComfyCloudReadinessTransport(req,plan,{signal:controller.signal,authorizeTarget,resolveHost,requestImpl});check();
    response=await transport.fetchImpl(plan.url,{method:'GET',headers:{Accept:'application/json','X-API-Key':apiKey},signal:controller.signal});check();
    const definitions=await readComfyCloudDefinitionsResponse(response,{maxBytes,signal:controller.signal,timeoutMs:Math.max(1,Math.ceil(deadline-performance.now()))});check();
    await transport.verify();check();
    const report=inspectComfyDefinitions(prepared.graph,definitions,{referenceInputs:prepared.referenceInputs});check();
    // Only a standard LoadImage scalar slot has deferred file validation.
    // A reference in a model-name/custom input is NOT verified by uploading it.
    const pendingReferenceUploads=new Set(report.issues.filter(issue=>isDeferredComfyReferenceIssue(sourceGraph,issue))
      .map(issue=>JSON.stringify([issue.nodeId,issue.field]))).size;
    return {...report,definitionsChecked:true,executionAuthorized:false,pendingReferenceUploads,
      unverifiedWarnings:report.warnings-pendingReferenceUploads};
  };
  try {return await Promise.race([work(),stopped]);}
  catch (error) {throw error?.code==='comfy_cloud_readiness'?error:fail('无法核对云端节点或模型清单，请手动确认；未提交生图');}
  finally {
    clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.abort();
    try{Promise.resolve(response?.body?.cancel?.()).catch(()=>{});}catch(_){/* The bounded reader owns its stream. */}
  }
}
