// Request-local world expression diagnostics. No storage, retries or submission
// authority of its own; the host supplies guarded storage after a failed attempt.
export function createWorldPromptAttempt({call,guard,uid,sanitize,startedAt,model='',now=Date.now}) {
  const stages=[];let reported=false;
  const clean=value=>sanitize(value),text=value=>String(value??'');
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  function responseInfo(value={}) {
    const usage={};
    for(const key of ['total_tokens','prompt_tokens','completion_tokens','input_tokens','output_tokens','totalTokenCount','promptTokenCount','candidatesTokenCount']) {
      if(count(value.usage?.[key]))usage[key]=value.usage[key];
    }
    const raw=text(value.text),bounded=raw.slice(0,96*1024);
    return {text:bounded,...(raw.length>bounded.length?{truncated:true,reason:'diagnostic_response_limit'}:{}),
      finishReason:text(value.finishReason).slice(0,80),complete:typeof value.complete==='boolean'?value.complete:null,
      interrupted:value.interrupted===true,...(Object.keys(usage).length?{usage}:{}),
      ...(count(value.receivedBytes)?{receivedBytes:value.receivedBytes}:{}),
      ...(value.compatibility?{compatibility:text(value.compatibility).slice(0,300)}:{})};
  }
  async function request(input,profileId,parse,{repairAttempt=0}={}) {
    await guard();
    const stage={id:uid('stage-world-expression'),type:'world_prompt_rendering',status:'running',startedAt:now(),finishedAt:0,
      input:clean({messages:input.messages,formats:input.formats,schema:input.schemaId,repairAttempt,maxOutputTokens:input.maxTokens}),output:{requestState:'started'},decisions:[],error:''};
    let response;
    try {
      const raw=await call(input.messages,profileId,{promptFormats:input.formats,maxTokens:input.maxTokens,jsonSchema:input.schema,
        jsonSchemaName:input.schemaId,jsonSchemaStrict:true,guard,onResponse:value=>{response=responseInfo(value);}});
      await guard();
      stage.output=clean({requestState:'returned',response:{...response,...responseInfo({...response,text:raw}),
        ...(!response?{compatibility:'此接口未提供原始结束原因或 token 用量，未推算。'}:{})}});
      const result=await parse(raw);await guard();stage.status='success';return result;
    } catch(error) {
      stage.status='failed';stage.error=clean(text(error?.message||'画面提示整理失败')).slice(0,1600);
      stage.output=clean({...stage.output,code:text(error?.code).slice(0,80),
        ...(stage.output.requestState==='started'?{requestState:'failed',...(response?{response}:{})}:{}),
        notice:'本次提示整理失败；未提交此镜生图'});
      throw Object.assign(new Error(clean(text(error?.message||'画面提示整理失败')).slice(0,240)),{code:error?.code});
    } finally {
      stage.finishedAt=now();stages.push(clean(stage));if(stages.length>4)stages.shift();
    }
  }
  function failure(error) {
    const finishedAt=now(),id=uid('world-prompt-log'),reason=clean(text(error?.message||'画面提示整理失败')).slice(0,1600);
    const pipeline={id:uid('world-prompt-pipeline'),taskId:id,status:'failed',providerId:'',model,startedAt,finishedAt,
      durationMs:Math.max(0,finishedAt-startedAt),stages:[...clean(stages),{id:uid('world-prompt-result'),type:'world_prompt_rendering',status:'failed',startedAt:finishedAt,finishedAt,
        input:{},output:{code:text(error?.code).slice(0,80),notice:'本次世界画面未入队；未改动正文草稿、原图或角色档案。'},decisions:[],error:reason}],migrated:false};
    const log={id,kind:'prompt_compiler',promptOrigin:'world',status:'failed',source:'compiler',model,floor:null,queuedAt:startedAt,startedAt,finishedAt,
      durationMs:pipeline.durationMs,submissionState:'not_submitted',snapshot:null,params:{},error:reason,pipelineId:pipeline.id,recordId:'',recordIds:[],attempt:1};
    return {log,pipeline};
  }
  async function fail(error,{store,archive}) {
    if(reported)return false;reported=true;
    try {
      await guard();const {log,pipeline}=failure(error);await store(log,pipeline);
      await guard();void Promise.resolve(archive(log)).catch(()=>{});return true;
    } catch(_) {return false;}
  }
  return Object.freeze({request,failure,fail,get stages(){return clean(stages);}});
}
