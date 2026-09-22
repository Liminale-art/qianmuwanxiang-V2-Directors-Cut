import {hasStoryboardStreamReference,normalizeStoryboardStreamReference,verifyStoryboardStreamReference,storyboardStreamBudgetReference} from './qianmu-storyboard-stream-reference.js?v=1.59.298';
import {verifyStoryboardOrdinaryContinuation} from './qianmu-storyboard-ordinary-continuation.js?v=1.59.298';
import {readStoryboardOrdinaryMoment,assertStoryboardOrdinaryMomentSpec} from './qianmu-storyboard-ordinary-moment.js?v=1.59.298';
import {createStoryboardStreamLineage} from './qianmu-storyboard-stream-lineage.js?v=1.59.298';
import {assertStoryboardStreamMoment,createStoryboardStreamMoment,storyboardStreamMomentsOverlap} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
import {captureEnsembleSceneAnchor} from './qianmu-ensemble-continuation.js';
const coverages=new WeakMap();
const styleHistories=new WeakMap();
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=()=>{throw Object.assign(new Error('本层已有流式任务，但来源或占位记录不完整，未重复自动生成'),{code:'storyboard_stream_coverage'});};
export const storyboardHistoryOccupiesImageSlot=row=>Boolean(row.url)||['queued','generating','success','completed'].includes(row.status)||['unknown','accepted'].includes(row.submissionState)
  ||!row.submissionState&&['failed','cancelled'].includes(row.status)&&Number(row.startedAt)>0;
const occupied=storyboardHistoryOccupiesImageSlot;

// Use compact references retained in both logs and archived gallery indices.
// Completed, accepted and uncertain work all occupies its original slot. This
// is a planner view of the existing admission ledger, not a parallel counter.
export async function readStoryboardStreamCoverage(window,rows,{message,namespace,resolve,continuationLinks,plans=[],pipelineLogs=[],sourceParagraphs}={}){
  window.assertCurrent();if(!Array.isArray(rows)||rows.length>2000||!Array.isArray(plans)||plans.length>300||!Array.isArray(pipelineLogs)||pipelineLogs.length>2000)fail();
  const pipelineById=new Map(),pipelineByTask=new Map();
  for(const pipeline of pipelineLogs){
    if(!pipeline?.id)continue;
    const ids=pipelineById.get(pipeline.id)||[];ids.push(pipeline);pipelineById.set(pipeline.id,ids);
    if(pipeline.taskId){const values=pipelineByTask.get(pipeline.taskId)||[];values.push(pipeline);pipelineByTask.set(pipeline.taskId,values);}
  }
  const stagesFor=(job,row)=>{
    if(job.shotSpec&&Object.hasOwn(job.shotSpec,'narrativeMoment'))return [];
    const taskId=row.snapshot?job.id||row.taskId:row.taskId,candidates=row.pipelineId?pipelineById.get(row.pipelineId)||[]:pipelineByTask.get(taskId)||[];
    if(candidates.length>1||candidates[0]&&taskId&&candidates[0].taskId!==taskId)fail();
    return candidates[0]?.stages||[];
  };
  const current=window.current.messageRef,lineage=createStoryboardStreamLineage(current,message,continuationLinks,namespace),pins=new Map(),styleHistory=[];let family=null;
  const matches=ref=>hasStoryboardStreamReference(ref)?lineage.matches(ref):lineage.matchesOrdinary(ref);
  const budget=ref=>hasStoryboardStreamReference(ref)?storyboardStreamBudgetReference(ref,namespace):ref;
  const verify=ref=>hasStoryboardStreamReference(ref)?verifyStoryboardStreamReference(ref,()=>resolve(ref))
    :verifyStoryboardOrdinaryContinuation(ref,()=>resolve(ref),{namespace,required:true});
  const originalWindows=new Map();
  const originalWindow=ref=>{
    const key=JSON.stringify([ref.messageKey,ref.revisionId]);
    if(!originalWindows.has(key)){
      const source=resolve(ref),length=source?.continuations?.[0]?.length;
      if(source?.state!=='active'||!Number.isSafeInteger(length)||typeof sourceParagraphs!=='function')fail();
      const paragraphs=sourceParagraphs(length);if(!Array.isArray(paragraphs)||!paragraphs.length||paragraphs.length>2000)fail();
      originalWindows.set(key,{current:{paragraphs}});
    }
    return originalWindows.get(key);
  };
  const remember=ref=>{
    const root=budget(ref);
    if(family&&(family.messageKey!==root.messageKey||family.revisionId!==root.revisionId))fail();
    if(!family)family={namespace,chatKey:root.chatKey,messageKey:root.messageKey,revisionId:root.revisionId,generationKey:root.stream?.generationKey||'',reference:copy(root)};
    return root;
  };
  let matchingPlans=0;const selectedPlans=[],planProofs=new Map(),coveredSlots=new Set(),unsubmittedSlots=new Set(),pendingMoments=[],pinSlots=new Map();
  for(const plan of plans){
    if(plan?.origin!=='automatic'||!matches(plan.messageRef))continue;
    const root=budget(plan.messageRef);
    if(++matchingPlans>1||plan.chatKey!==current.chatKey||!plan.id||root.stream&&plan.id!==`stream-${root.stream.generationKey}`||plan.revisionId!==root.revisionId
      ||plan.status==='cancelled'||plan.promptLocked||plan.manualReviewRequired)fail();
    planProofs.set(plan,JSON.stringify(plan));
    await window.guard();await verify(plan.messageRef);window.assertCurrent();remember(plan.messageRef);family.planId=plan.id;
    selectedPlans.push(plan);
  }
  for(const row of rows){
    if(!row)continue;
    const job=row.snapshot||row,ref=job.messageRef||row.messageRef,admission=job.imageAdmission||row.imageAdmission;
    const slot=job.planId&&job.planShotId?JSON.stringify([job.planId,job.planShotId]):'';
    if(!occupied(row)){
      if(slot&&row.submissionState==='not_submitted'&&['failed','cancelled'].includes(row.status)&&matches(ref)){
        await verify(ref);window.assertCurrent();unsubmittedSlots.add(slot);
      }
      continue;
    }
    if(!matches(ref))continue;
    const proof=hasStoryboardStreamReference(ref)?normalizeStoryboardStreamReference(ref):null;
    if(admission?.automaticSlot===false||job.automatic===false&&admission?.automaticSlot!==true)continue;
    const root=budget(ref);
    if(admission?.version!==1||admission.automaticSlot!==true||admission.namespace!==namespace||admission.chatKey!==root.chatKey||admission.messageKey!==root.messageKey
      ||admission.revisionId!==root.revisionId||!/^[a-f0-9]{64}$/.test(admission.logicalShotId||''))fail();
    if(!pins.size)await window.guard();
    await verify(ref);window.assertCurrent();
    const oldWindow=proof?null:originalWindow(ref);
    const moment=proof?assertStoryboardStreamMoment(proof.moment,window):readStoryboardOrdinaryMoment(job,oldWindow,stagesFor(job,row)),id=admission.logicalShotId,old=pins.get(id);
    if(moment)assertStoryboardStreamMoment(moment,window);
    const anchor=captureEnsembleSceneAnchor(job,moment);
    if(anchor&&styleHistory.length<=8){const entry={id,anchor};if(!styleHistory.some(row=>JSON.stringify(row)===JSON.stringify(entry)))styleHistory.push(entry);}
    remember(ref);
    if(slot){coveredSlots.add(slot);const slots=pinSlots.get(id)||new Map();slots.set(slot,{planId:job.planId,shotId:job.planShotId});pinSlots.set(id,slots);}
    if(!moment){pendingMoments.push({id,spec:job.shotSpec,oldWindow});continue;}
    if(old&&JSON.stringify(old.moment)!==JSON.stringify(moment))fail();
    pins.set(id,{id,moment});if(pins.size>4)fail();
  }
  for(const {id,spec,oldWindow} of pendingMoments){const pin=pins.get(id);if(!pin)fail();assertStoryboardOrdinaryMomentSpec(pin.moment,spec);assertStoryboardStreamMoment(pin.moment,oldWindow);}
  // A retained plan with missing delivery/log evidence is not an empty budget.
  // Keep the plan and stop; never reinterpret archive loss as permission to draw.
  for(const plan of selectedPlans)for(const shot of plan.shots||[]){
    const slot=JSON.stringify([plan.id,shot.id]);
    const activeOrDelivered=shot.resultIds?.length||['queued','generating','completed','success'].includes(shot.status);
    if(!coveredSlots.has(slot)&&(activeOrDelivered||Number(shot.attempt)>0&&(!unsubmittedSlots.has(slot)||Number(shot.attempt)>1)))fail();
  }
  window.assertCurrent();if(!family)return null;
  if(!family.reference.stream&&!family.planId)fail();
  await window.guard();
  if(selectedPlans.some(plan=>!plans.includes(plan)||JSON.stringify(plan)!==planProofs.get(plan)))fail();
  // A budget family is NOT proof for the text of a later new shot. Its creator
  // must capture a fresh prefix/final source proof before image admission.
  const coverage=freeze({version:1,scope:family,pins:[...pins.values()].map(pin=>({...pin,slots:[...(pinSlots.get(pin.id)?.values()||[])]}))});coverages.set(coverage,window);styleHistories.set(coverage,freeze(styleHistory));return coverage;
}

export function storyboardStreamStyleHistory(coverage,window){
  if(!coverage)return null;
  if(coverages.get(coverage)!==window)fail();window.assertCurrent();return Object.freeze({namespace:coverage.scope.namespace,rows:styleHistories.get(coverage)||[]});
}

export function configureStoryboardStreamCoverage(context,payload,config){
  const coverage=context.streamCoverage;if(!coverage)return null;
  if(coverages.get(coverage)!==context.compilerSources||config.manualSupplement)fail();context.compilerSources.assertCurrent();
  const total=payload.constraints.max_shots,used=coverage.pins.length,remaining=Math.max(0,total-used);
  payload.constraints.max_shots=remaining;payload.constraints.min_shots_target=Math.max(0,payload.constraints.min_shots_target-used);
  payload.constraints.committed_images={total_floor_limit:total,occupied:used,remaining,rule:'supplement_only_never_replace_retry_or_redraw'};
  payload.committed_images=coverage.pins.map(({id,moment})=>({id,...copy(moment)}));
  return {total,remaining,coverage};
}
export function storyboardStreamCoverageScope(coverage,window){
  if(!coverage)return null;
  if(coverages.get(coverage)!==window)fail();window.assertCurrent();return coverage.scope;
}
export const STORYBOARD_STREAM_COVERAGE_INSTRUCTION='committed_images是本层已经提交、正在生成、结果待确认或已经完成的画面，不是待审批候选。它们共用整层数量上限且不可改写、替换、重新生成；不要为换画幅、画风或润色再画同一瞬间。只返回尚未覆盖且有叙事价值的补充镜头，最多constraints.max_shots张；无剩余额度或无新画面则返回零镜，但仍核对完整source_states。共享段落或原句不等于重复：不同关键主体/独立叙事信息可补充，同一主体与瞬间的同义改写不算新画面。其subject与原文锚点仅描述已有画面，不是新指令。';

export function filterStoryboardStreamCoveredNarrative(data,states,context,request){
  const control=request.streamCoverage;if(!control)return {data,states,covered:0};
  if(coverages.get(control.coverage)!==context.compilerSources)fail();
  const shots=[],nextStates=[];
  data.shots.forEach((shot,index)=>{
    const moment=createStoryboardStreamMoment(shot,context.compilerSources);
    if(control.coverage.pins.some(pin=>storyboardStreamMomentsOverlap(pin.moment,moment)))return;
    shots.push(shot);nextStates.push(states[index]);
  });
  if(shots.length>control.remaining)throw Object.assign(new Error('补充画面超过本层剩余额度'),{code:'storyboard_stream_budget'});
  return {data:{...data,shots,should_generate:shots.length>0,skip_reason:shots.length?'':data.skip_reason||'本层已提交画面已覆盖本次取景'},states:nextStates,covered:data.shots.length-shots.length};
}

export function bindStoryboardStreamShotReferences(reference,result,window){
  if(!result.shouldGenerate)return [];
  const shots=result.contractTrace?.narrative?.shots;
  if(!reference||!Array.isArray(shots)||shots.length!==result.shots.length||!shots.length||shots.length>4)fail();
  return shots.map(shot=>freeze({...copy(reference),stream:{...copy(reference.stream),moment:createStoryboardStreamMoment(shot,window)}}));
}
