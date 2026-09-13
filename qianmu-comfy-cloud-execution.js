// One original shot through the existing cloud client. No topology mutation,
// automatic resubmission, cross-provider fallback or background polling.
import { requireComfyCloudImageSubmission, canSubmitComfyCloudImages } from './qianmu-comfy-cloud-protocol.js';
const fail = (code,message,state='not_submitted') => Object.assign(new Error(message),{
  code:`comfy_cloud_execution_${code}`,submissionState:state,retryable:false,
});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

export async function executeComfyCloudJob(client, source, gateway, connection, {
  apiKey, beforeSubmit=async()=>{}, valid=()=>true, onPrepared=async()=>{}, onAccepted=async()=>{},
  onStatus=async()=>{}, deliver, wait=pause, now=()=>performance.now(), maxWaitMs=300000, intervalMs=2500,
}={}) {
  if (!Number.isFinite(maxWaitMs)||maxWaitMs<0||maxWaitMs>900000||!Number.isFinite(intervalMs)||intervalMs<250||intervalMs>10000
    ||typeof deliver!=='function') throw fail('options','云任务等待或收片设置无效');
  const job=structuredClone(source),requestSource=structuredClone(gateway),binding=structuredClone(connection);let state='not_submitted',record;
  if(job.automatic||job.comfyAutoSelected)throw fail('automatic','云工作流自动节点检查尚未开放，请先手动确认工作流');
  if(job.profile?.comfyReferences?.enabled||job.profile?.comfyCharacterEnabled||job.payload?.comfyCharacterPlan)
    throw fail('references','此云渠道的参考素材上传尚未开放，未忽略参考图或转至其他渠道');
  const check=()=>{if(!valid())throw fail('stopped','已停止本页等待；已受理的云任务仍保留',state);};
  try {
    requireComfyCloudImageSubmission(binding,{automatic:job.automatic||job.comfyAutoSelected});
    check();
    const capabilities=await client.cloudCapabilities({namespace:job.imageAdmission?.namespace});check();
    if(!canSubmitComfyCloudImages(capabilities,binding.provider)||!capabilities.resultRetrieval||!capabilities.resultProviders.includes(binding.provider))
      throw fail('capabilities','当前后端尚未开放此平台完整生图，请同步更新后再使用');
    const prepared=await client.prepareCloudSubmission(job,requestSource,binding);record=prepared.record;
    // Record the original identity even if an earlier page lost the acceptance.
    if(!prepared.created)state=record.cloudTask?'accepted':'unknown';
    check();await onPrepared(structuredClone(record));check();
    if(prepared.created) {
      const accepted=await client.submitCloudPrepared(prepared,apiKey,{beforeSubmit,valid});
      state='accepted';record=accepted.record;
    } else if(!record.cloudTask)throw fail('unconfirmed','原请求已存在但受理尚未确认，请核查原任务，未重新提交','unknown');
    await onAccepted(structuredClone(record));check();
    const deadline=now()+maxWaitMs;
    // Count as well as time bounds the loop, including a broken/frozen clock.
    for(let reads=0;reads<360;reads++) {
      check();
      const result=await client.retrieveCloudJob(job,record,{apiKey,deliver:async(original,data,files,checkpoint,accountGuard)=>{
        const guard=async()=>{await accountGuard();check();};await guard();
        return deliver(original,data,files,checkpoint,guard);
      }});
      check();
      if(result.archived)return {...result,record};
      if(!['queued','running','collecting','canceling'].includes(result.status))
        throw fail('result',result.warning||'原图暂不可领取，请核查原任务','accepted');
      await onStatus(result.status);check();
      if(now()>=deadline||reads===359)return {archived:false,pending:true,status:result.status,record,
        warning:'已结束本页等待，原云任务仍保留，可稍后从收片管理领取'};
      await wait(Math.min(intervalMs,Math.max(0,deadline-now())));check();
    }
  } catch(cause) {
    const error=/^(?:comfy_|image_|storyboard_)/.test(cause?.code||'')?cause:fail('interrupted','云任务处理已中断，请核查原任务记录',state);
    error.submissionState=state==='accepted'?'accepted':(cause?.submissionState||state);
    if(record?.cloudTask)error.upstreamId=record.cloudTask.taskId;
    throw error;
  }
}
