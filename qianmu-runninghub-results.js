// RH v2 is the task/status authority. Its current result schema omits node IDs;
// the documented (deprecated) outputs endpoint supplies ONLY supplemental node
// evidence. Never fall back to it for status, invent node IDs or sum per-file costs.
import { normalizeComfyCloudReceipt } from './qianmu-comfy-cloud-receipt.js';
import { readComfyCloudTaskStatus } from './qianmu-comfy-cloud-response.js';
const mime=type=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'})[type];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

export function collectRunningHubStillResults(rawReceipt,body,nodeEvidence) {
  const receipt=normalizeComfyCloudReceipt(rawReceipt),{task,stillOutput}=receipt;
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code:`runninghub_results_${code}`,submissionState:'accepted',upstreamId:task.taskId,retryable:false});};
  if(task.provider!=='runninghub')fail('provider','此输出不属于 RunningHub 原任务');
  const state=readComfyCloudTaskStatus(task,body);
  if(!state.terminal)return null;
  if(state.status!=='succeeded')fail('state','原任务未成功完成，未收片');
  if(!Array.isArray(body.results)||!body.results.length||body.results.length>64
    ||!object(nodeEvidence)||nodeEvidence.code!==0||!Array.isArray(nodeEvidence.data)||nodeEvidence.data.length>64)
    fail('evidence','平台输出节点信息未就绪，请核查原任务，未猜测图片归属');
  if(nodeEvidence.taskId!=null&&nodeEvidence.taskId!==task.taskId)fail('identity','平台返回了其他任务的输出信息');
  const nodes=new Map();
  for(const row of nodeEvidence.data){
    if(!object(row)||typeof row.fileUrl!=='string'||row.fileUrl.length>4096||typeof row.nodeId!=='string'||!/^[a-zA-Z0-9_:-]{1,120}$/.test(row.nodeId)
      ||typeof row.fileType!=='string'||nodes.has(row.fileUrl))fail('evidence','平台输出节点信息缺失或重复');
    if(row.taskId!=null&&row.taskId!==task.taskId)fail('identity','平台混入其他任务的输出');
    nodes.set(row.fileUrl,row);
  }
  const selected=new Set(stillOutput.execution.outputNodeIds),previews=new Set(stillOutput.previewNodeIds),seen=new Set(),outputs=[];
  let finalImages=0;
  for(let index=0;index<body.results.length;index++){
    const row=body.results[index];
    if(!object(row)||typeof row.url!=='string'||row.url.length>4096||!/^https:\/\//.test(row.url)||/[\u0000-\u0020\u007f\\]/.test(row.url))fail('url','平台输出地址无效');
    let url;try{url=new URL(row.url);}catch(_){fail('url','平台输出地址无效');}
    if(url.href!==row.url||url.username||url.password||url.port||url.hash)fail('url','平台输出地址含不允许的字段');
    if(seen.has(row.url))fail('duplicate','平台结果重复，未猜测多图顺序');seen.add(row.url);
    if(row.taskId!=null&&row.taskId!==task.taskId)fail('identity','平台混入其他任务结果');
    const evidence=nodes.get(row.url);
    if(!evidence||evidence.fileType!==row.outputType)fail('match','平台两份输出信息不一致，请刷新原任务');
    if(previews.has(evidence.nodeId))continue;
    if(mime(row.outputType)&&++finalImages>8)fail('count','原任务实际输出超过八张，未截断收片');
    if(!selected.has(evidence.nodeId))continue;
    if(!mime(row.outputType))fail('type','所选节点未返回支持的静帧图片');
    outputs.push(Object.freeze({nodeId:evidence.nodeId,outputIndex:index,mime:mime(row.outputType),sourceUrl:row.url}));
  }
  if(nodes.size!==seen.size)fail('match','平台两份结果数量不一致，未混合归档');
  const {execution}=stillOutput;
  if(!outputs.length||outputs.length>execution.maxImages||execution.expectedImages!=null&&outputs.length!==execution.expectedImages
    ||execution.automatic&&finalImages!==1)fail('count','原任务静帧数量与约定不一致');
  // Ephemeral descriptors only. URLs are NOT UUID asset identities or cache
  // proofs; the bounded downloader must verify ownership, DNS and bytes.
  return Object.freeze({version:1,provider:'runninghub',task,requestDigest:receipt.requestDigest,outputs:Object.freeze(outputs)});
}
