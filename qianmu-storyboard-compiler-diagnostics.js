// Safe summaries for preparation/stale-input exits use the existing log store.
// Never copy an Error, configuration value, message, prompt or response into them.
const interruptionReasons=Object.freeze({
  preparation_input_event:'准备期间修改了输入，请按当前设置重新提取',
  preparation_disposed:'本次准备已结束，请重新打开取景',preparation_stream_aborted:'本次取景已停止，需要时重新提取',
  preparation_upstream_changed:'上游准备已变化，请重新提取',preparation_state_changed:'工作状态已变化，请重新打开取景',
  preparation_plan_changed:'取景计划已变化，请从当前楼层重新提取',preparation_chat_changed:'聊天已切换，请在目标聊天重新提取',
  preparation_plan_cancelled:'本次取景已取消',preparation_message_replaced:'目标楼层已替换，请重新选择正文',
  preparation_profile_changed:'生图配置已变化，请核对当前配置后重新提取',
  preparation_connection_changed:'连接设置已变化，请核对连接后重新提取',
  preparation_credentials_changed:'连接凭据已变化，请确认连接后重新提取',
  preparation_compiler_changed:'取景设置已变化，请确认取景 API 与预设后重新提取',
  preparation_world_selection_changed:'世界书选择已变化，请确认参考内容后重新提取',
  preparation_messages_changed:'参考正文已变化，请重新选择并提取',preparation_context_changed:'角色或参考上下文已变化，请重新提取',
  preparation_config_changed:'准备设置已变化，请按当前设置重新提取',
  compiler_sources_changed:'取景来源已变化，请重新选择正文',
  compiler_source_message_changed:'取景正文已变化，请重新选择正文',
  compiler_source_context_changed:'取景上下文已变化，请重新提取',
  compiler_source_account_changed:'账户已变化，请确认当前账户后重新提取',
  preparation_stream_changed:'当前正文仍在变化，请等待回复结束后重新提取',
  workflow_not_ready:'工作流未就绪，请检查连接、工作流与输出节点',
  context_unavailable:'参考内容未能完整读取，请检查角色或世界书选择后重新提取',
  preparation_failed:'取景准备未完成，请检查取景 API 与当前生图配置后重试',
});
const interruptionStages=Object.freeze({preparation:'取景准备',workflow:'工作流检查',context:'上下文读取',compiler:'取景请求',validation:'取景校验'});
export async function createStoryboardCompilerInterruptionRecorder({ownsContext,resolveNamespace,store,uid,startedAt,floor,now=Date.now}) {
  let namespace,recorded=false,pending;
  try {
    if(!ownsContext())return async()=>false;
    namespace=await resolveNamespace();
    if(!ownsContext()||typeof namespace!=='string'||!/^st-user:.{1,504}$/.test(namespace))return async()=>false;
  } catch {return async()=>false;}
  async function write({stage='preparation',reason,error,cancelled=false}={}) {
    try {
      if(recorded||!ownsContext()||namespace!==await resolveNamespace()||!ownsContext())return false;
      const stageName=Object.hasOwn(interruptionStages,stage)?stage:'preparation';
      const code=Object.hasOwn(interruptionReasons,reason)?reason:cancelled?'preparation_config_changed':error?.comfyPreflight?'workflow_not_ready':error?.code==='storyboard_context_unavailable'?'context_unavailable':'preparation_failed';
      const message=`${interruptionStages[stageName]}：${interruptionReasons[code]}`;
      const finishedAt=now(),id=uid('compiler-log'),status=cancelled?'cancelled':'failed';
      const pipeline={id:uid('compiler-pipeline'),taskId:id,status,providerId:'',model:'',startedAt,finishedAt,durationMs:Math.max(0,finishedAt-startedAt),migrated:false,
        stages:[{id:uid('compiler-result'),type:'compiler_validation',status,startedAt,finishedAt,input:{},output:{stage:stageName,reason:code,notice:'本次取景未提交生图；旧草稿保留，未自动重试。'},decisions:[],error:message}]};
      const log={id,kind:'prompt_compiler',status,source:'compiler',model:'',floor,queuedAt:startedAt,startedAt,finishedAt,durationMs:pipeline.durationMs,
        submissionState:'not_submitted',snapshot:null,params:{},error:message,pipelineId:pipeline.id,recordId:'',recordIds:[],attempt:1};
      recorded=true;store(log,pipeline);return true;
    } catch {return false;}
  }
  return details=>pending||(pending=write(details));
}

// One extraction attempt, not an image task. Owns no global state or network.
export function createStoryboardCompilerAttempt({call,guard,uid,sanitize,startedAt,floor,model='',now=Date.now}) {
  const stages=[];
  const copy=value=>sanitize(value);
  const text=value=>String(value??'');
  const label=name=>name==='expression'?'提示表达':name==='narrative'?'叙事取景':'镜头规划';
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  function responseMetadata(value={}) {
    const usage={};
    for(const key of ['total_tokens','prompt_tokens','completion_tokens','input_tokens','output_tokens','totalTokenCount','promptTokenCount','candidatesTokenCount']) {
      if(count(value.usage?.[key]))usage[key]=value.usage[key];
    }
    return {text:text(value.text),finishReason:text(value.finishReason).slice(0,80),
      complete:typeof value.complete==='boolean'?value.complete:null,interrupted:value.interrupted===true,
      ...(Object.keys(usage).length?{usage}:{}),
      ...(count(value.receivedBytes)?{receivedBytes:value.receivedBytes}:{}),
      ...(value.compatibility?{compatibility:text(value.compatibility).slice(0,300)}:{})};
  }
  async function request(messages,profileId,options={}) {
    await guard();
    const name=/\.(narrative|expression)\.v1$/.exec(options.jsonSchemaName||'')?.[1]||'legacy';
    const row={id:uid('compiler-request'),type:`compiler_${name}${options.repair?'_repair':''}`,status:'running',startedAt:now(),finishedAt:0,
      input:copy({messages,schema:options.jsonSchemaName||'',repair:options.repair===true,maxOutputTokens:options.maxTokens}),
      output:{requestState:'started'},decisions:[],error:''};
    stages.push(row);
    let response;
    try {
      const raw=await call(messages,profileId,{...options,guard,onResponse:value=>{response=responseMetadata(value);}});
      row.output=copy({requestState:'returned',response:{...response,text:text(raw),complete:response?.complete??null,
        ...(!response?{compatibility:'此接口未提供原始结束原因或 token 用量，未推算。'}:{})}});
      row.status='success';return raw;
    } catch(error) {
      row.status='failed';row.error=copy(text(error?.message||error));
      row.output=copy({requestState:'failed',code:text(error?.code).slice(0,80),...(response?{response}:{}),notice:`${label(name)}请求失败；未自动重发`});
      throw error;
    } finally {row.finishedAt=now();}
  }
  function failure(error) {
    const finishedAt=now(),id=uid('compiler-log'),stage=error?.diagnostic?.stage;
    const failed=[...stages].reverse().find(row=>row.status==='failed');
    const reason=copy(failed?`${label(stage||(/compiler_(expression|narrative)/.exec(failed.type)?.[1]))}：${failed.error}`:text(error?.message||error));
    const pipeline={id:uid('compiler-pipeline'),taskId:id,status:'failed',providerId:'',model,startedAt,finishedAt,durationMs:Math.max(0,finishedAt-startedAt),
      stages:[...stages,{id:uid('compiler-result'),type:'compiler_validation',status:'failed',startedAt:finishedAt,finishedAt,
        input:{},output:copy({code:text(error?.code),diagnostic:error?.diagnostic||{},notice:'本次提取未提交生图；未替换上一次有效草稿及其来源。'}),decisions:[],error:reason}],migrated:false};
    const log={id,kind:'prompt_compiler',status:'failed',source:'compiler',model,floor,queuedAt:startedAt,startedAt,finishedAt,durationMs:pipeline.durationMs,
      submissionState:'not_submitted',snapshot:null,params:{},error:reason,pipelineId:pipeline.id,recordId:'',recordIds:[],attempt:1};
    return {log,pipeline};
  }
  function fail(error,{store,archive}) {
    // A stale/foreign context must not acquire a diagnostic through global setters.
    guard();
    const {log,pipeline}=failure(error);
    try {store(log,pipeline);void Promise.resolve(archive(log.pipelineId)).catch(()=>{});}
    catch (_) {console.warn('[千幕] 本次提取失败日志未能保存；原有草稿未改动。');}
  }
  return {call:request,failure,fail};
}
