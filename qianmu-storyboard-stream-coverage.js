import {normalizeStoryboardStreamReference,verifyStoryboardStreamReference,storyboardStreamBudgetReference} from './qianmu-storyboard-stream-reference.js?v=1.59.235';
import {createStoryboardStreamLineage} from './qianmu-storyboard-stream-lineage.js?v=1.59.235';
import {assertStoryboardStreamMoment,createStoryboardStreamMoment,storyboardStreamMomentsOverlap} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
const coverages=new WeakMap();
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=()=>{throw Object.assign(new Error('本层已有流式任务，但来源或占位记录不完整，未重复自动生成'),{code:'storyboard_stream_coverage'});};
const occupied=row=>Boolean(row.url)||['queued','generating','success','completed'].includes(row.status)||['unknown','accepted'].includes(row.submissionState)
  ||!row.submissionState&&['failed','cancelled'].includes(row.status)&&Number(row.startedAt)>0;

// Use compact references retained in both logs and archived gallery indices.
// Completed, accepted and uncertain work all occupies its original slot. This
// is a planner view of the existing admission ledger, not a parallel counter.
export async function readStoryboardStreamCoverage(window,rows,{message,namespace,resolve,continuationLinks,plans=[]}={}){
  window.assertCurrent();if(!Array.isArray(rows)||rows.length>2000||!Array.isArray(plans)||plans.length>300)fail();
  const current=window.current.messageRef,lineage=createStoryboardStreamLineage(current,message,continuationLinks,namespace),pins=new Map();let family=null;
  const remember=ref=>{
    const root=storyboardStreamBudgetReference(ref,namespace);
    if(family&&(family.messageKey!==root.messageKey||family.revisionId!==root.revisionId))fail();
    if(!family)family={namespace,chatKey:root.chatKey,messageKey:root.messageKey,revisionId:root.revisionId,generationKey:root.stream.generationKey,reference:copy(root)};
    return root;
  };
  let matchingPlans=0;const selectedPlans=[],coveredSlots=new Set(),unsubmittedSlots=new Set();
  for(const plan of plans){
    if(plan?.origin!=='automatic'||!lineage.matches(plan.messageRef))continue;
    const root=storyboardStreamBudgetReference(plan.messageRef,namespace);
    if(++matchingPlans>1||plan.chatKey!==current.chatKey||plan.id!==`stream-${root.stream.generationKey}`||plan.revisionId!==root.revisionId
      ||plan.status==='cancelled'||plan.promptLocked||plan.manualReviewRequired)fail();
    await window.guard();await verifyStoryboardStreamReference(plan.messageRef,()=>resolve(plan.messageRef));window.assertCurrent();remember(plan.messageRef);
    selectedPlans.push(plan);
  }
  for(const row of rows){
    if(!row)continue;
    const job=row.snapshot||row,ref=job.messageRef||row.messageRef,admission=job.imageAdmission||row.imageAdmission;
    const slot=job.planId&&job.planShotId?JSON.stringify([job.planId,job.planShotId]):'';
    if(!occupied(row)){
      if(slot&&row.submissionState==='not_submitted'&&['failed','cancelled'].includes(row.status)&&lineage.matches(ref)){
        await verifyStoryboardStreamReference(ref,()=>resolve(ref));window.assertCurrent();unsubmittedSlots.add(slot);
      }
      continue;
    }
    if(!lineage.matches(ref))continue;
    const proof=normalizeStoryboardStreamReference(ref);
    if(admission?.automaticSlot===false||job.automatic===false&&admission?.automaticSlot!==true)continue;
    const root=storyboardStreamBudgetReference(ref,namespace);
    if(admission?.version!==1||admission.automaticSlot!==true||admission.namespace!==namespace||admission.chatKey!==root.chatKey||admission.messageKey!==root.messageKey
      ||admission.revisionId!==root.revisionId||!/^[a-f0-9]{64}$/.test(admission.logicalShotId||''))fail();
    if(!pins.size)await window.guard();
    await verifyStoryboardStreamReference(ref,()=>resolve(ref));window.assertCurrent();
    const moment=assertStoryboardStreamMoment(proof.moment,window),id=admission.logicalShotId,old=pins.get(id);
    if(old&&JSON.stringify(old.moment)!==JSON.stringify(moment))fail();
    pins.set(id,{id,moment});if(pins.size>4)fail();
    if(slot)coveredSlots.add(slot);
    remember(ref);
  }
  // A retained plan with missing delivery/log evidence is not an empty budget.
  // Keep the plan and stop; never reinterpret archive loss as permission to draw.
  for(const plan of selectedPlans)for(const shot of plan.shots||[]){
    const slot=JSON.stringify([plan.id,shot.id]);
    const activeOrDelivered=shot.resultIds?.length||['queued','generating','completed','success'].includes(shot.status);
    if(!coveredSlots.has(slot)&&(activeOrDelivered||Number(shot.attempt)>0&&(!unsubmittedSlots.has(slot)||Number(shot.attempt)>1)))fail();
  }
  window.assertCurrent();if(!family)return null;await window.guard();
  // A budget family is NOT proof for the text of a later new shot. Its creator
  // must capture a fresh prefix/final source proof before image admission.
  const coverage=freeze({version:1,scope:family,pins:[...pins.values()]});coverages.set(coverage,window);return coverage;
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
