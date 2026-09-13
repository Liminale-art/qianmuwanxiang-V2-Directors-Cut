// Browser-safe projection of an already prepared storyboard gateway request.
// No credentials, routing guesses, network or workflow topology edits.
import {bindComfyCloudProtocol,RUNNINGHUB_INSTANCE_TYPES} from './qianmu-comfy-cloud-protocol.js';
import {normalizeComfyExecution,auditComfyWorkflow,requireComfyExecution} from './qianmu-comfy-audit.js';
import {prepareComfyWorkflow} from './qianmu-comfy-workflow.js';
import {normalizeComfyRouteBinding} from './qianmu-comfy-route-contract.js';
import {normalizeComfyWorkbenchBinding} from './qianmu-comfy-workbench-binding.js';
import {parseBoundedJson} from './qianmu-json-input.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'comfy_cloud_request',submissionState:'not_submitted',retryable:false});};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function buildComfyCloudRequest(job,gateway,connection){
  if(job?.source!=='comfy'||gateway?.provider!=='comfy'||job.imageAdmission?.version!==1||job.imageAdmission.attemptId!==job.id
    ||typeof job.imageAdmission.namespace!=='string'||!/^st-user:.+/.test(job.imageAdmission.namespace))fail('原分镜任务身份未确认');
  const binding=bindComfyCloudProtocol(connection?.origin,connection?.protocol);
  if(connection.version!==binding.version||connection.provider!==binding.provider
    ||bindComfyCloudProtocol(job.connection?.baseUrl,binding.protocol).origin!==binding.origin
    ||bindComfyCloudProtocol(gateway.baseUrl,binding.protocol).origin!==binding.origin)fail('云工作流与原连接不一致');
  for(const field of ['referenceImages','references','vibes'])if(gateway[field]!=null&&(!Array.isArray(gateway[field])||gateway[field].length))fail('此云通道的参考素材上传尚未接通，未丢弃素材或提交生成');
  const execution=normalizeComfyExecution(gateway.comfyExecution);
  if(execution.automatic!==Boolean(job.automatic||job.comfyAutoSelected))fail('工作流的自动取景保护已变化，请重新确认');
  const route=job.profile?.comfyRouteBinding,workbench=job.profile?.comfyWorkbenchBinding;
  if(route&&workbench)fail('固定分工与当前工作台来源冲突，请重新选择');
  const sourceBinding=route||(workbench?normalizeComfyWorkbenchBinding(workbench).binding:null);
  const workflowBinding=sourceBinding?normalizeComfyRouteBinding(sourceBinding):null;
  if(workflowBinding&&workflowBinding.namespace!==job.imageAdmission.namespace)fail('原工作流属于另一账户');
  const parameters=Object.fromEntries(['width','height','steps','count','seed','scale','cfg','sampler','scheduler']
    .filter(key=>gateway.parameters?.[key]!==undefined).map(key=>[key,gateway.parameters[key]]));
  const tier=job.profile?.comfyInstanceType;
  const runninghub=binding.provider==='runninghub'&&tier!==undefined&&tier!==''?{instanceType:tier}:undefined;
  if(runninghub&&!RUNNINGHUB_INSTANCE_TYPES.includes(tier))fail('RunningHub运行配置无效，请重新选择；未自动换档');
  const request=parseBoundedJson(JSON.stringify({connection:binding,workflow:gateway.parameters?.workflow,prompt:gateway.prompt,
    negativePrompt:gateway.negativePrompt||'',model:gateway.model||'',parameters,execution,...(runninghub?{runninghub}:{}),...(workflowBinding?{binding:workflowBinding}:{})}),
  {maxBytes:2*1024*1024,maxDepth:40,maxNodes:50000,label:'云工作流'});
  if(typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>24000||typeof request.negativePrompt!=='string'||request.negativePrompt.length>24000)fail('云工作流画面提示词无效');
  const template=prepareComfyWorkflow(request.workflow,{...request,referenceCount:0});
  const checked=requireComfyExecution(auditComfyWorkflow(template.bind([]),request.execution),request.execution);
  if(checked.expectedImages!==gateway.comfyExecution.expectedImages)fail('工作流出图数量已变化，请重新确认');
  return freeze(request);
}
