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
