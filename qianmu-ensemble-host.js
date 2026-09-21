import {createEnsembleStorage} from './qianmu-ensemble-storage.js?v=1.59.271';
import {prepareEnsembleStyleBindings} from './qianmu-ensemble-bindings.js?v=1.59.271';
import {createEnsemblePlanStorage} from './qianmu-ensemble-plan-storage.js';
import {createEnsembleRecoveryRecord,restoreEnsembleRecoveryRecord} from './qianmu-ensemble-recovery.js?v=1.59.271';
import {normalizeEnsembleRecoveryScope,normalizeEnsembleRecoveryRecord} from './qianmu-ensemble-record.js';
import {resolveStoryboardMessageReference} from './qianmu-storyboard.js?v=1.59.271';

const copy=value=>JSON.parse(JSON.stringify(value));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_host',submissionState:'not_submitted'});};
const retired=plan=>plan?.ensembleRecoveryRetired===true;
function planScope(plan,namespace,d){
  const state=d.storyboardState(),chatKey=String(d.getChatKey()||''),ref=plan?.messageRef;
  if(!plan||!state.shotPlans.includes(plan)||plan.chatKey!==chatKey||ref?.chatKey!==chatKey||plan.revisionId!==ref.revisionId
    ||plan.status==='cancelled'||resolveStoryboardMessageReference(ref,d.ctx().chat,{chatKey,namespace,metadata:d.ctx().chatMetadata}).state!=='active')fail('镜组计划不属于当前有效正文，请重新提取');
  return normalizeEnsembleRecoveryScope({namespace,chatKey,planId:plan.id,messageKey:ref.messageKey,revisionId:ref.revisionId});
}

// Invoked while the real compiler's source/casting/binding guards are alive,
// before it replaces the editable workbench. A successful settings enqueue is
// never treated as durable storage. A newer remote record is not overwritten.
export async function persistStoryboardEnsemblePlan(result,context,plan,inputGuard,d){
  if(!result.ensembleRequired)return null;
  const state=d.storyboardState(),identity=await d.featureRuntime.load('imageAdmission');inputGuard.assertCurrent();
  const namespace=await identity.resolveImageAccountNamespace();inputGuard.assertCurrent();
  const scope=planScope(plan,namespace,d),previous=Object.hasOwn(plan,'ensembleRecovery')?normalizeEnsembleRecoveryRecord(plan.ensembleRecovery):null,wasRetired=retired(plan);
  const check=()=>{inputGuard.assertCurrent();context.compilerSources.assertCurrent();
    const ref=context.compilerSources.current.messageRef;
    if(d.storyboardState()!==state||!equal(planScope(plan,namespace,d),scope)||ref.chatKey!==scope.chatKey||ref.messageKey!==scope.messageKey||ref.revisionId!==scope.revisionId
      ||!equal(plan.ensembleRecovery??null,previous)||retired(plan)!==wasRetired)fail('镜组保存期间原计划或来源已变化');return true;};
  const guard=async()=>{check();await context.compilerSources.guard();await context.casting?.assertCurrent();await inputGuard.comfyRoutes?.assertCurrent();
    if(await identity.resolveImageAccountNamespace()!==namespace)fail('镜组保存账户已变化');check();return true;};
  await guard();const record=await createEnsembleRecoveryRecord(result,{scope,guard});await guard();
  const store=await createEnsemblePlanStorage({scope,guard:check});
  try{
    const before=await store.read();await guard();
    if(!equal(before.record,previous))fail('此楼层的镜组记录已在其他端变化，未覆盖');
    const confirmed=await store.save(record,before);await guard();
    plan.ensembleRecovery=confirmed.record;delete plan.ensembleRecoveryRetired;return confirmed.record;
  }finally{store.close();}
}

// Successful extraction owns the new recipe. Retain retired recovery records
// for exact future writes and archives, but never execute them as the new draft.
// A new manual plan is added only after extraction; failure removes just that
// owned object, not another plan or a remotely accepted/uncertain old record.
export async function finalizeStoryboardEnsemblePlan(result,context,plan,inputGuard,d,{automatic=false}={}){
  inputGuard.assertCurrent();const state=d.storyboardState();
  if(!result.ensembleRequired){
    if(plan&&Object.hasOwn(plan,'ensembleRecovery')&&!result.manualRequired){
      const ref=context.compilerSources.current.messageRef;
      context.compilerSources.assertCurrent();
      if(!state.shotPlans.includes(plan)||plan.chatKey!==ref.chatKey||plan.messageRef?.messageKey!==ref.messageKey||plan.revisionId!==ref.revisionId)fail('原镜组计划已变化，旧记录未停用');
      // The compiler marks retirement in its final synchronous draft adoption,
      // after rechecking the guard following this async function's return.
    }
    return plan;
  }
  let created=false;
  try{
    if(!plan){
      if(state.shotPlans.length>=300)fail('计划记录暂满，请先整理已完成的计划；未移除旧记录');
      const ref=context.compilerSources.current.messageRef;context.compilerSources.assertCurrent();
      plan=d.createPlan({id:d.uid('ensemble-plan'),messageRef:ref,chatKey:ref.chatKey,floor:context.floor,origin:automatic?'automatic':'manual',autoGenerate:automatic,status:'compiling',createdAt:Date.now()});
      if(!plan?.id||state.shotPlans.some(row=>row.id===plan.id))fail('新镜组计划身份冲突，未替换旧计划');
      state.shotPlans=[plan,...state.shotPlans];created=true;inputGuard.bindPlan(plan);
    }
    await persistStoryboardEnsemblePlan(result,context,plan,inputGuard,d);return plan;
  }catch(error){if(created)state.shotPlans=state.shotPlans.filter(row=>row!==plan);throw error;}
}

export function resolveStoryboardEnsembleDraftPlan(state,d,expectedDraft){
  if(expectedDraft!==JSON.stringify([state.prompt,state.negative,state.promptDraft]))fail('镜组草稿在准备期间已变化，请重新生成');
  const matches=state.shotPlans.filter(row=>row.id===state.promptDraft?.planId),plan=matches[0];
  const chatKey=String(d.getChatKey()||'');
  if(matches.length!==1||retired(plan)||!Object.hasOwn(plan,'ensembleRecovery')||plan.status==='cancelled'||plan.chatKey!==chatKey
    ||plan.floor!==d.storyboardTargetFloor(state)||plan.revisionId!==plan.messageRef?.revisionId
    ||resolveStoryboardMessageReference(plan.messageRef,d.ctx().chat,{chatKey}).state!=='active')fail('镜组草稿所属计划缺失或已变化，请重新提取');
  return plan;
}

// Fresh execution-side reconstruction: resolve the saved choice, not another
// model request. Read only the two exact library/selection files and this plan;
// old plans, startup and legacy routing incur no storage scans or new requests.
export async function restoreStoryboardEnsemblePlan(state,plan,planned,inputGuard,d){
  if(retired(plan))fail('此计划的旧镜组记录已停用，请重新提取');
  if(!state.promptDraft?.ensembleRequired&&!Object.hasOwn(plan||{},'ensembleRecovery'))return null;
  if(!Object.hasOwn(plan||{},'ensembleRecovery')||state.promptDraft?.planId!==plan.id)fail('镜组交接记录缺失或不属于当前草稿，请重新提取');
  const record=normalizeEnsembleRecoveryRecord(plan.ensembleRecovery),identity=await d.featureRuntime.load('imageAdmission');inputGuard.assertCurrent();
  const namespace=await identity.resolveImageAccountNamespace();inputGuard.assertCurrent();
  const scope=planScope(plan,namespace,d);
  if(!equal(scope,record.scope))fail('镜组记录的账户或正文版本已变化，请重新提取');
  const check=()=>{inputGuard.assertCurrent();
    if(state!==d.storyboardState()||retired(plan)||!equal(planScope(plan,namespace,d),scope)||!equal(plan.ensembleRecovery,record))fail('镜组计划已变化，未继续提交');return true;};
  const guard=async()=>{check();if(await identity.resolveImageAccountNamespace()!==namespace)fail('镜组账户已变化，未继续提交');await inputGuard.comfyRoutes?.assertCurrent();check();return true;};
  let choices,storage,bindings,closed=false;
  const close=()=>{if(closed)return;closed=true;bindings?.close();choices?.close();storage?.close();};
  try{
    await guard();storage=await createEnsemblePlanStorage({scope,guard:check});await guard();
    choices=await createEnsembleStorage({namespace,chatKey:scope.chatKey,isCurrent:check,resolveNamespace:identity.resolveImageAccountNamespace});
    const [library,selection]=await Promise.all([choices.readLibrary({fresh:true}),choices.readSelection({fresh:true})]);await guard();
    if(!selection.value.enabled||selection.value.revision!==record.selectionRevision)fail('本聊天镜组选择已变化，请重新提取');
    const current=d.storyboardProviderProfile(state),base={providerId:state.source,modelId:current.model,capabilityModelId:current.capabilityModelId,connectionPresetId:'',parameterPresetId:''};
    const routes=[base],used=new Set(record.shots.map(row=>row.schemeId));
    for(const id of selection.value.schemeIds.filter(id=>used.has(id))){const scheme=library.value.schemes.find(row=>row.id===id&&!row.archived);
      const route=scheme&&state.routing.rules.find(row=>row.id===scheme.binding.routeId&&row.enabled!==false)?.target;if(route)routes.push(copy(route));}
    await d.storyboardPrepareComfyRoutes(state,inputGuard,routes);await guard();
    bindings=await prepareEnsembleStyleBindings({library:library.value,selection:selection.value,namespace,chatKey:scope.chatKey,preparationId:d.uid('ensemble-recovery'),
      readState:()=>state,resolveProfile:({route})=>d.storyboardResolveRoutingProfile(state,route,null,inputGuard.comfyRoutes),assertCurrent:check,guard,
      verifyTarget:async descriptor=>{
        await guard();
        if(descriptor.route.providerId!=='comfy')return {ready:true};
        const reports=await d.storyboardPreflightComfyForCompiler(state,current,plan,inputGuard,true,null,[descriptor.route]);await guard();
        const ready=(Array.isArray(reports)?reports:[reports]).some(row=>row?.localConfigurationReady===true);
        const promptFormats=descriptor.profile.comfyRoutePromptFormat?[descriptor.profile.comfyRoutePromptFormat]:inputGuard.comfyRoutes?.promptFormats||[];
        return {ready,promptFormats};
      }});await guard();
    const restored=await restoreEnsembleRecoveryRecord(record,{scope,planned,session:bindings.session,guard,verifySaved:value=>storage.verify(value)});await guard();
    return Object.freeze({...restored,async assertCurrent(){if(closed)fail('镜组恢复会话已结束');await guard();await bindings.assertCurrent();await restored.assertCurrent();await guard();},close});
  }catch(error){close();throw error;}
}
