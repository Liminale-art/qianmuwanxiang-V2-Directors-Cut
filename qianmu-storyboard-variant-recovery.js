import {aggregateStoryboardShotTasks,normalizeStoryboardInlineOrder,sanitizeStoryboardDiagnosticData} from './qianmu-storyboard.js?v=1.59.394';

export async function recordPreparedJobFailure(job,message,isCurrent,{state,chat,account,queue,active,uid,startLog,finishLog,setPlanStatus,planForJob,syncTaskState,save},{suppressPlanStatus=false}={}) {
  const owner=job?.imageOwnerState,origin=job?.imageAccountNamespace||job?.imageAdmission?.namespace;
  if(!origin||!owner||!isCurrent()||owner!==state()||job.chatKey!==String(chat()||''))return null;
  try{if(await account()!==origin)return null;}catch(_){return null;}
  if(!isCurrent()||owner!==state()||job.chatKey!==String(chat()||'')||!job.id||job.logId||job.queueAccepted
    ||queue.some(item=>item.id===job.id)||active.has(job.id))return null;
  if(job.planId&&(!job.imageOwnerPlan||!owner.shotPlans.includes(job.imageOwnerPlan)
    ||!job.imageOwnerPlan.shots?.some(shot=>shot===job.imageOwnerShot&&shot.id===job.planShotId)))return null;
  const error=String(sanitizeStoryboardDiagnosticData(String(message||'本镜未能入队，请核对连接与工作流'))).slice(0,1600);
  job.compilerStages=[...(job.compilerStages||[]),{id:uid('stage-queue-preparation'),type:'queue_preparation',status:'failed',startedAt:Date.now(),finishedAt:Date.now(),
    input:{shotIndex:job.inlineOrder?.shotIndex},output:{submissionState:'not_submitted'},decisions:['未进入执行队列，未发送生图请求'],error}];
  const log=startLog(job,{preparationError:error});job.logId=log.id;
  finishLog(log,'failed',{error,submissionState:'not_submitted'});
  const plan=planForJob(job);
  if(suppressPlanStatus&&plan?.status==='cancelled'){
    syncTaskState(job,'failed',{error,stage:'queue',plan});
    const shot=plan.shots?.find(item=>item.id===job.planShotId);
    if(shot?.status==='completed'){
      const siblings=(state().taskStates||[]).filter(item=>item.planId===plan.id&&item.shotId===shot.id);
      const aggregate=aggregateStoryboardShotTasks(siblings,'completed');
      shot.partialFailureCount=aggregate.partialFailureCount;shot.error=aggregate.error;
    }
    plan.updatedAt=Date.now();save();
  }else setPlanStatus(plan,'failed',{job,error,stage:'queue'});
  return log;
}

export function preparedShotSource(plan,shot) {
  return JSON.stringify([plan?.id,plan?.chatKey,plan?.revisionId,plan?.messageRef?.messageKey,plan?.messageRef?.swipeId,
    shot?.id,shot?.prompt,shot?.safePrompt,shot?.negative,shot?.shotSpec]);
}

// A prepared NAI variant is not an accepted request. Reuse the existing
// not_submitted log/task only when an independently accepted sibling exists.
export function createUnsubmittedNovelVariantRecorder({owner,chatKey,plan,jobs,refusedReasons,state,chat,record,onError=()=>{}}) {
  const acceptedSibling=job=>{
    const order=normalizeStoryboardInlineOrder(job.inlineOrder);
    return order&&jobs.find(other=>other!==job&&other.queueAccepted===true&&other.source==='novel'
      &&other.planId===job.planId&&other.planShotId===job.planShotId&&other.chatKey===job.chatKey
      &&other.inlineOrder?.batchId===order.batchId&&other.inlineOrder?.shotIndex===order.shotIndex
      &&Number(other.requestIndex)!==Number(job.requestIndex));
  };
  const stillOwned=(job,sibling)=>{
    const shot=job?.imageOwnerShot;
    try{return owner===state()&&String(chat()||'')===chatKey&&job.chatKey===chatKey
      &&job.imageOwnerState===owner&&sibling?.imageOwnerState===owner&&sibling?.queueAccepted===true
      &&sibling?.imageAccountNamespace===job.imageAccountNamespace
      &&(plan?(job.imageOwnerPlan===plan&&owner.shotPlans.includes(plan)
        &&plan.id===job.planId&&plan.chatKey===chatKey
        &&shot&&plan.shots?.includes(shot)&&shot.id===job.planShotId
        &&job.imageOwnerSource===preparedShotSource(plan,shot))
        :(job.target==='gallery'&&sibling.target==='gallery'
          &&!job.planId&&!job.planShotId&&!job.imageOwnerPlan&&!job.imageOwnerShot));}
    catch(_){return false;}
  };
  return async(items,message)=>{
    let saved=0;
    for(const job of items){
      if(job?.source!=='novel'||Number(job.requestTotal)<=1||(plan?!job.planShotId:(job.planId||job.planShotId))||job.logId||job.queueAccepted)continue;
      const sibling=acceptedSibling(job);if(!sibling||!stillOwned(job,sibling))continue;
      try{if(await record(job,refusedReasons.get(job)||message,()=>stillOwned(job,sibling),
        {suppressPlanStatus:true}))saved++;}
      catch(error){onError(error);}
    }
    return saved;
  };
}

export async function currentVariantBatchOwner({owner,chatKey,namespace,plan,shotArray,shots,planSource,shotSource,state,chat,account}) {
  const owned=()=>owner===state()&&chatKey===String(chat()||'')
    &&(!plan||owner.shotPlans.includes(plan)&&plan.status!=='cancelled'&&plan.shots===shotArray
      &&plan.shots?.length===shots.length&&plan.shots.every((shot,index)=>shot===shots[index])
      &&JSON.stringify([plan.floor,plan.revisionId,plan.messageRef?.messageKey])===planSource
      &&JSON.stringify(plan.shots.map(shot=>[shot.id,shot.prompt,shot.safePrompt,shot.negative,shot.shotSpec]))===shotSource);
  if(!owned())return false;
  try{if(await account()!==namespace)return false;}catch(_){return false;}
  return owned();
}

export async function finishStoppedVariantBatch(result,{owner,chatKey,namespace,plan,jobs,queued,current,record,state,chat,account,save,schedule,partial,toast}) {
  const message='后续请求未提交';
  if(!await current()){
    let sameAccount=false;try{sameAccount=await account()===namespace;}catch(_){}
    if(sameAccount&&owner===state()&&chatKey===String(chat()||'')&&result.acceptedCount>0)
      toast(`生图请求已入队 ${queued}/${jobs.length}；余下未提交，请勿整批重试`,'warning');
    return;
  }
  if(result.acceptedCount>0)await record(result.remainingJobs,result.reason?.message||message);
  if(!await current())return;
  for(const job of result.remainingJobs){const shot=plan?.shots?.find(item=>item.id===job.planShotId);
    if(shot&&!(owner.taskStates||[]).some(task=>task.planId===plan.id&&task.shotId===shot.id&&['queued','generating','completed'].includes(task.status))){shot.status='cancelled';shot.error=message;}}
  if(plan){if(!queued)plan.status='cancelled';else if(plan.status==='prompt_ready'&&partial({...plan,status:'completed'}))plan.status='completed';
    plan.error=`已入队 ${queued}/${jobs.length}；余下请求未提交`;plan.updatedAt=Date.now();save();schedule(30,plan.floor);}
  toast(partial(plan)?.label||`生图请求已入队 ${queued}/${jobs.length}；余下未提交，请勿整批重试`,'warning');
}
