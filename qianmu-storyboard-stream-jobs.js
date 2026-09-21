// Consume one live compiler handoff without borrowing the editable workbench.
// Engine selection, prompt safety, admission and transport stay in the existing
// host pipeline. This adapter neither submits HTTP nor starts a stream watcher.
import {storyboardStreamBudgetReference} from './qianmu-storyboard-stream-reference.js?v=1.59.281';
import {storyboardStreamCoverageScope} from './qianmu-storyboard-stream-coverage.js?v=1.59.281';
import {resolveEnsembleCompiledRoutes} from './qianmu-ensemble-handoff.js?v=1.59.281';
const consumed = new WeakSet();
const copy = value => JSON.parse(JSON.stringify(value));
const stop = message => Object.assign(new Error(message), {code:'storyboard_stream_jobs'});

export async function submitStoryboardStreamPrepared(prepared, d) {
  const {result, context, inputGuard, messageRef, shotReferences} = prepared;
  inputGuard.assertCurrent();
  if (consumed.has(inputGuard)) throw stop('本次流式结果已交接，未重复提交');
  consumed.add(inputGuard);
  const outcome = {queued:0, failed:0, prepared:0};
  if (!result.shouldGenerate) return outcome;
  if (result.manualRequired || !messageRef?.stream || !Array.isArray(result.shots) || !result.shots.length
    || result.shots.length !== shotReferences?.length || result.shots.length > 4) throw stop('流式结果缺少已核对的画面来源，未提交');
  const state = d.storyboardState(), chatKey = messageRef.chatKey;
  let plan, existing=false, restored=null, planSnapshot='',ensemble=null;
  const valid = () => inputGuard.isCurrent() && state === d.storyboardState() && state.enabled
    && state.automation.autoGenerate && chatKey === String(d.getChatKey() || '')
    && plan?.status !== 'cancelled' && !plan?.promptLocked && !plan?.manualReviewRequired;
  const check = async () => {
    inputGuard.assertCurrent();
    if (!valid()) throw stop('自动生成或当前任务已变化，未继续提交');
    if (existing && !state.shotPlans.includes(plan)) throw stop('镜头计划已被归档或替换，请等待下一次取景');
    await context.compilerSources.guard();
    await inputGuard.comfyRoutes?.assertCurrent();
    await ensemble?.assertCurrent();
    inputGuard.assertCurrent();
    if (!valid()) throw stop('自动生成或当前任务已变化，未继续提交');
  };
  try {
    await check();
    const profile = d.storyboardProviderProfile(state);
    const projected = {...state, target:'floor', floor:String(context.floor), prompt:result.prompt, negative:result.negative,
      contentRating:result.shots.some(shot=>shot.sensitive) ? 'nsfw' : 'sfw', promptMode:'auto',
      paragraphMode:'auto', manualParagraphIndex:null, pendingParagraphIndex:null, pendingParagraphSelection:null,
      promptDraft:{...state.promptDraft, planId:'', shots:result.shots, userEditedCompiled:false, userEditedNegative:false},
      routing:{...state.routing, single:{providerId:state.source, modelId:profile.model, capabilityModelId:profile.capabilityModelId, connectionPresetId:'', parameterPresetId:''}},
      pendingCompilerStages:[d.sanitizeStoryboardDiagnosticData({id:d.uid('stage-stream'),type:'prompt_compiler',status:'success',
        startedAt:Date.now(),finishedAt:Date.now(),input:prepared.compilerInput,
        output:{contract:result.contractMeta,trace:result.contractTrace,streaming:true},decisions:result.decisions || [],error:''})],
    };
    const budgetRef=storyboardStreamBudgetReference(messageRef);
    const refs = new Map(result.shots.map((shot,index)=>[shot.id,shotReferences[index]]));
    if (refs.size !== result.shots.length) throw stop('流式镜头编号重复，未提交');
    const {planned,coverage} = d.storyboardPrepareDraftGroup(projected);
    if (!planned.length) return outcome;
    for (const shot of planned) {
      const ref=refs.get(shot.id);
      if (!ref?.stream?.moment || ref.revisionId !== messageRef.revisionId || ref.messageKey !== messageRef.messageKey
        || ref.chatKey !== chatKey || ref.stream.prefixDigest !== messageRef.stream.prefixDigest
        || JSON.stringify(ref.stream.family)!==JSON.stringify(messageRef.stream.family)) throw stop('流式镜头来源不一致，未提交');
    }
    const originalScope=storyboardStreamCoverageScope(context.streamCoverage,context.compilerSources);
    if(originalScope&&(originalScope.chatKey!==chatKey||originalScope.messageKey!==budgetRef.messageKey||originalScope.revisionId!==budgetRef.revisionId))throw stop('原计划与数量归属不一致，未提交');
    const planId = budgetRef.stream?`stream-${budgetRef.stream.generationKey}`:originalScope?.planId;
    if(!planId)throw stop('原普通计划缺少已核对身份，未另建自动任务');
    plan = state.shotPlans.find(row=>row.id===planId);
    if (!plan&&(context.streamCoverage||messageRef.stream.family))throw stop('原流式计划缺失，未另建自动任务');
    if (plan && (plan.chatKey !== chatKey || plan.revisionId !== budgetRef.revisionId || plan.messageRef?.messageKey!==budgetRef.messageKey || plan.origin !== 'automatic')) throw stop('流式任务归属不一致，未提交');
    existing=Boolean(plan);
    if (existing) planSnapshot=JSON.stringify(plan);
    if (plan?.archiveRef) {
      [restored]=await d.storyboardPlansForPortableExport([plan],{strict:true}); await check();
      if (!restored || restored.id!==plan.id || restored.revisionId!==plan.revisionId) throw stop('历史流式计划无法完整恢复，未提交');
    }
    const offset = plan?.shots?.length || 0;
    if (offset + planned.length > 20) throw stop('本层任务记录已满，请从已有镜头记录中重试，未新增请求');
    const oldMoments=new Map();
    for(const pin of context.streamCoverage?.pins||[])for(const slot of pin.slots||[]){
      if(slot.planId!==planId)continue;
      if(oldMoments.has(slot.shotId)&&JSON.stringify(oldMoments.get(slot.shotId))!==JSON.stringify(pin.moment))throw stop('原镜头叙事位置冲突，未新增请求');
      oldMoments.set(slot.shotId,pin.moment);
    }
    // Do not evict queued/running plans to make room. Follow normal retention for
    // terminal plans only, and do not prune anything until all jobs are prepared.
    const dropped = !existing && state.shotPlans.length >= 300
      ? [...state.shotPlans].reverse().filter(d.storyboardPlanIsTerminal).slice(0,state.shotPlans.length-299) : [];
    if (!existing && state.shotPlans.length-dropped.length >= 300) throw stop('任务记录暂满，请等待已有任务结束，未提交');
    plan ||= d.createStoryboardWorkflowTicket({id:planId,messageRef:budgetRef,chatKey,floor:context.floor,origin:'automatic',autoGenerate:true,createdAt:Date.now()});
    const newShots = planned.map((shot,index)=>({id:shot.id,title:shot.title || `镜头 ${offset+index+1}`,shotType:shot.shotType || 'custom',
      narrativeMoment:copy(refs.get(shot.id).stream.moment),
      role:shot.role || 'custom',purpose:shot.purpose || '',prompt:String(shot.prompt || ''),negative:String(shot.negative || ''),tags:[...(shot.tags||[])],
      // Only the existing queue may promote this row to queued. If preparation
      // is cancelled between mirrors, unsubmitted rows must not look in flight.
      status:'cancelled',resultIds:[],error:'本镜尚未提交',partialFailureCount:0,attempt:0,sensitive:Boolean(shot.sensitive),promptLocked:false,userEdited:false}));
    const planView = {...plan, shots:newShots};
    const inlineBatch = {version:1,batchId:plan.id,batchStartedAt:plan.createdAt};
    let routes = planned.map(shot=>projected.routing.enabled ? d.routeStoryboardShot(shot,projected.routing) : projected.routing.single);
    // Use the compiler's exact draft-ID mapping; style choice never uses an
    // array position after coverage has dropped a redundant mirror.
    ensemble=await resolveEnsembleCompiledRoutes(result,planned,{guard:async()=>{inputGuard.assertCurrent();await context.compilerSources.guard();inputGuard.assertCurrent();}});
    if(ensemble)routes=ensemble.routes;
    // Routes and model capabilities were pinned before the compiler request.
    // Reuse that session; rebuilding it here could silently switch workflows.
    let selection=null;
    if (inputGuard.comfyAuto) {
      selection=await d.storyboardChooseComfyGenerationRoutes(projected,inputGuard,planned,routes,coverage,planView,inlineBatch);
      routes=selection.routes; await check();
    }
    const jobs=[], artists=[];
    for (let index=0;index<planned.length;index++) {
      if (selection?.failures.has(index)) continue;
      const shot=planned[index],route=routes[index],choice=selection?.choices.get(index),sourceId=route.providerId;
      if (!d.STORYBOARD_PROVIDER_REGISTRY[sourceId]) throw stop('镜组包含未知生图渠道，未提交');
      const shotProfile={...d.storyboardResolveRoutingProfile(projected,route,sourceId===state.source?profile:null,inputGuard.comfyRoutes),count:'1'};
      const effective=await d.storyboardAdaptShotForModel(shot,sourceId,shotProfile.model,state,
        {chatKey,capabilityModelId:shotProfile.capabilityModelId,isCurrent:valid,cancelled:()=>plan.status==='cancelled'});
      await check();
      if (effective.safetyAborted) throw stop('本镜模型适配已取消，未提交');
      const job=d.storyboardCreateJob(projected,shotProfile,{shot:ensemble?.artistPresetIds[index]?{...effective,artistPresetId:ensemble.artistPresetIds[index]}:effective,sourceId,profileSourceId:sourceId,modelId:route.modelId,
        capabilityModelId:shotProfile.capabilityModelId,connectionPresetId:route.connectionPresetId,planId:plan.id,planShotId:newShots[index].id,
        recentArtistIds:artists,requestIndex:1,requestTotal:1,inlineOrder:{...inlineBatch,shotIndex:offset+index,requestIndex:1},
        routeTarget:route,preparedRoutes:inputGuard.comfyRoutes,freshComfy:inputGuard.freshComfy});
      // Replace ordinary full-message identity before admission, logs or queue.
      job.messageRef=copy(refs.get(shot.id)); job.automatic=true; job.manualSupplement=false;
      if(ensemble)job.ensembleStyleOrigin=ensemble.origins[index];
      if(ensemble?.stages?.[index])job.compilerStages.push(copy(ensemble.stages[index]));
      if (job.artistPresetId) artists.push(job.artistPresetId);
      Object.assign(newShots[index],{providerId:sourceId,connectionPresetId:route.connectionPresetId || '',parameterPresetId:route.parameterPresetId || '',routeRuleId:route.ruleId || '',
        safetyAdapted:effective.safetyAdapted,safetyMethod:effective.safetyMethod || '',shotSpec:copy(job.shotSpec),compiledPrompt:copy(job.compiledPrompt),
        compositionDecision:copy(job.compositionDecision),paragraphAnchor:copy(job.paragraphAnchor),paragraphSelection:null,
        ...(shotProfile.comfyRouteBinding?{comfyRouteBinding:copy(shotProfile.comfyRouteBinding)}:{})});
      if (choice) {
        Object.defineProperty(job,'comfyAutoSelected',{value:true,enumerable:false});
        await selection.batch.attach(job,choice); await check();
        job.compilerStages.push({id:d.uid('stage-comfy-selection'),type:'comfy_selection',status:'success',startedAt:Date.now(),finishedAt:Date.now(),
          input:{shot:offset+index+1},output:{workflow:route.comfyWorkflowBinding.name,version:route.comfyWorkflowBinding.version,candidateId:choice.candidateId,styleLocked:Boolean(choice.proposedLock)},error:''});
      }
      jobs.push(job);
    }
    await check();
    if (existing && JSON.stringify(plan)!==planSnapshot) throw stop('已有镜头状态在准备期间变化，请等待下一次取景，未新增请求');
    if (jobs.length > d.STORYBOARD_QUEUE_LIMIT-d.storyboardQueue.length-d.storyboardActiveJobs.size) throw stop('当前生图队列空间不足，未提交此批流式画面');
    // No asynchronous gap between the final source check and publishing plan rows.
    if (!existing) {
      const removed=new Set(dropped);
      state.shotPlans=[plan,...state.shotPlans.filter(row=>!removed.has(row))];
      if (dropped.length) void Promise.resolve(d.storyboardDeletePlanArchives(dropped)).catch(()=>{});
    }
    Object.assign(plan,{messageRef:copy(budgetRef),floor:context.floor,status:'prompt_ready',autoGenerate:true,
      shots:[...(restored?.shots || plan.shots || []).map(shot=>oldMoments.has(shot.id)?{...shot,narrativeMoment:copy(oldMoments.get(shot.id))}:shot),...newShots],updatedAt:Date.now(),
      continuityLedger:copy(coverage.continuityLedger || {}),continuityLedgerLayer:coverage.continuityLedgerLayer});
    // Retain the previous archive as recovery data until the next terminal
    // archive replaces it. Never delete the only full copy during preparation.
    delete plan.archiveRef; delete plan.archiveVersion; delete plan.archivedAt;
    d.saveSettings(); outcome.prepared=jobs.length;
    for (const [index,failure] of selection?.failures || []) {
      d.storyboardRecordComfyPreparationFailure({...failure.preparation,messageRef:copy(refs.get(planned[index].id)),
        inlineOrder:{...inlineBatch,shotIndex:offset+index,requestIndex:1}},failure.message,failure.diagnostics);
      outcome.failed++;
    }
    for (const job of jobs) {
      await check(); let reason='';
      try {
        if (await d.storyboardQueueJob(job,valid,message=>{reason=message;})) outcome.queued++;
        else if (reason && valid()) { outcome.failed++; d.storyboardRecordPreparedJobFailure(job,reason); }
      } catch (error) {
        if (job.queueAccepted || d.storyboardQueue.some(row=>row.id===job.id) || d.storyboardActiveJobs.has(job.id)) outcome.queued++;
        throw error;
      }
    }
    return outcome;
  } catch (error) {
    // Cancellation after one engine accepted a request is not "nothing sent".
    // A caller must not retry this batch wholesale, even if the compiler stops.
    error.streamOutcome={...outcome};
    throw error;
  }
}
