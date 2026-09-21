import {normalizeStoryboardStreamReference,storyboardStreamBudgetReference,storyboardStreamDigest} from './qianmu-storyboard-stream-reference.js?v=1.59.293';
const copy=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_stream_attempt'});};
const fields=['version','requestId','sourceDigest','prefixLength','status','passes','updatedAt'];
export function normalizeStoryboardStreamAttempt(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))
    ||value.version!==1||typeof value.requestId!=='string'||!value.requestId||value.requestId.length>160||/[\u0000-\u001f\u007f]/.test(value.requestId)
    ||!/^[a-f0-9]{64}$/.test(value.sourceDigest||'')||!Number.isSafeInteger(value.prefixLength)||value.prefixLength<1||value.prefixLength>200000
    ||!['preparing','ready','waiting','failed','cancelled'].includes(value.status)||!Number.isSafeInteger(value.passes)||value.passes<1||value.passes>3
    ||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<1)return {version:1,invalid:true};
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
export function assertStoryboardStreamAttemptSettled(plan){
  if(!Object.hasOwn(plan,'streamAttempt'))return;
  const value=normalizeStoryboardStreamAttempt(plan.streamAttempt);
  if(value.invalid||!['waiting','ready'].includes(value.status))fail('上次提前取景未完成或已停止，请手动核对；未自动重新请求');
}
export async function verifyStoryboardStreamAttemptPrefix(plan,d){
  assertStoryboardStreamAttemptSettled(plan);if(!Object.hasOwn(plan,'streamAttempt'))return;
  d.guard();const original=plan.streamAttempt,value=normalizeStoryboardStreamAttempt(original),raw=d.message()?.mes;
  if(typeof raw!=='string'||raw.length<value.prefixLength)fail('已取景片段改变，未继续提前取景');
  const digest=await storyboardStreamDigest(raw.slice(0,value.prefixLength));d.guard();
  if(plan.streamAttempt!==original||JSON.stringify(original)!==JSON.stringify(value)||digest!==value.sourceDigest)fail('已取景片段或原检查点改变，未继续提前取景');
}

// Called with a source reference produced by the guarded live compiler window,
// BEFORE its first model request. This is a no-replay checkpoint, not paid-image
// authority; image admission still verifies the full source and shared ledger.
export async function beginStoryboardStreamAttempt(reference,scope,d){
  d.guard();const proof=normalizeStoryboardStreamReference(reference);
  if(proof.invalid)fail('提前取景来源无效，未请求模型');
  const state=d.state(),root=storyboardStreamBudgetReference(reference),id=root.stream?`stream-${root.stream.generationKey}`:scope?.planId;
  if(!id||scope&&(scope.chatKey!==root.chatKey||scope.messageKey!==root.messageKey||scope.revisionId!==root.revisionId))fail('提前取景原计划不一致，未请求模型');
  const matches=state.shotPlans.filter(plan=>plan.id===id);if(matches.length>1)fail('提前取景原计划重复，未请求模型');
  let plan=matches[0];
  if(plan&&(plan.origin!=='automatic'||plan.chatKey!==root.chatKey||plan.revisionId!==root.revisionId||plan.messageRef?.messageKey!==root.messageKey
    ||plan.status==='cancelled'||plan.promptLocked||plan.manualReviewRequired))fail('提前取景计划已被接管或停止，未请求模型');
  if(!plan&&(scope||proof.family))fail('提前取景原计划缺失，未另建额度');
  if(!plan&&state.shotPlans.length>=300)fail('镜头计划记录已满，未请求模型或清除旧记录');
  if(plan)assertStoryboardStreamAttemptSettled(plan);
  const previous=plan?.streamAttempt?normalizeStoryboardStreamAttempt(plan.streamAttempt):null;
  if(previous&&(previous.sourceDigest===proof.prefixDigest||previous.passes>=3))throw Object.assign(Error('等待新增内容或终稿，不重复提前取景'),{code:'storyboard_stream_wait'});
  if(previous){
    if(previous.prefixLength>proof.prefixLength)fail('已取景片段改变，未继续提前取景');
    await verifyStoryboardStreamAttemptPrefix(plan,d);
    if(d.state()!==state||!state.shotPlans.includes(plan))fail('原取景计划改变，未继续提前取景');
  }
  const record=normalizeStoryboardStreamAttempt({version:1,requestId:d.uid('stream-attempt'),sourceDigest:proof.prefixDigest,prefixLength:proof.prefixLength,
    status:'preparing',passes:(previous?.passes||0)+1,updatedAt:Date.now()});
  if(record.invalid)fail('提前取景检查点无效，未请求模型');
  if(!plan){plan=d.createPlan({id,messageRef:copy(root),chatKey:root.chatKey,floor:reference.lastKnownFloor,origin:'automatic',autoGenerate:true});plan.status='screening';state.shotPlans=[plan,...state.shotPlans];}
  plan.streamAttempt=record;
  const started=copy(record),signature=JSON.stringify(started);
  const owned=()=>{
    d.guard();
    if(d.state()!==state||!state.shotPlans.includes(plan)||plan.streamAttempt!==record||JSON.stringify(record)!==signature
      ||plan.id!==id||plan.origin!=='automatic'||plan.chatKey!==root.chatKey||plan.revisionId!==root.revisionId||plan.messageRef?.messageKey!==root.messageKey
      ||plan.status==='cancelled'||plan.promptLocked||plan.manualReviewRequired)fail('取景计划或检查点已变化，未继续请求或保存');
    return true;
  };
  let checkpoint,finished;
  const close=()=>{try{checkpoint?.close();}catch(_){}};
  const markFailed=()=>{if(plan.streamAttempt===record){record.status='failed';if(plan.status==='screening'&&!plan.shots.length)plan.status='failed';}};
  try{
    owned();d.save();owned();
    if(typeof d.openCheckpoint!=='function')fail('取景检查点确认保存未就绪，未请求模型');
    checkpoint=await d.openCheckpoint({reference:root,planId:id,guard:owned});owned();
    await checkpoint.prepare(started,previous);owned();
  }catch(error){markFailed();close();throw error;}
  return Object.freeze({plan,finish(status){
    // A report and its finally block share the same completion, including errors.
    if(finished)return finished;
    finished=(async()=>{
      try{
        try{owned();}catch(_){return 'cancelled';}
        const next=['ready','waiting','failed','cancelled'].includes(status)?status:'failed';
        const receipt=await checkpoint.settle(started,next);owned();
        Object.assign(record,receipt.attempt);
        if(plan.status==='screening'&&!plan.shots.length)plan.status=record.status==='waiting'?'idle':record.status==='ready'?'prompt_ready':record.status;
        d.save();return record.status;
      }catch(_){markFailed();return 'failed';}
      finally{close();}
    })();
    return finished;
  }});
}
