// Lazy compiler-result adapter. It owns no host state, event subscriptions or
// storage; the caller supplies guarded dependencies and retains draft ownership.
import {createStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
import {attachEnsembleCompilerResult} from './qianmu-ensemble-handoff.js?v=1.59.324';
export async function resolveStoryboardCompilerResult(raw, context, capabilities, state, contractRequest, inputGuard, dependencies) {
  const {featureRuntime,storyboardCallCompiler,STORYBOARD_RATIOS,getStoryboardGenerationPolicy,STORYBOARD_PLAN_SCHEMA,extractJson,normalizeStoryboardShotSpec,storyboardProviderProfile,compileStoryboardPrompt,uid}=dependencies;
  inputGuard?.assertCurrent();
  let focused=null;
  const styleSession=contractRequest?.styleSession;
  if(contractRequest?.focused){
    const contract=contractRequest.runtime;
    focused=await contract.completeStoryboardFocusedExtraction({raw,context,request:contractRequest,
      guard:async()=>{inputGuard.assertCurrent();await context.casting?.assertCurrent();await inputGuard.comfyRoutes?.assertCurrent();inputGuard.assertCurrent();},
      publish:records=>inputGuard.continuityStore.publish(records),
      call:(messages,options)=>inputGuard.compilerAttempt.call(messages,state.promptCompiler.apiProfileId,{maxTokens:options.maxTokens,promptFormats:contractRequest.promptFormats,temperature:options.temperature,repair:options.repair,
        jsonSchema:options.schema,jsonSchemaName:options.schemaId,jsonSchemaStrict:true}),
    });
    raw=focused.raw;contractRequest={...focused.legacyRequest,runtime:contract};
  }
  let object = null;
  let contractMeta = null;
  let contractTrace = null;
  const rawText = String(raw || '');
  const declaresPlanContract = /"schema"\s*:\s*"qianmu\.storyboard\.plan\.v1"/.test(rawText);
  if (contractRequest || declaresPlanContract) {
    const contract = contractRequest?.runtime || await featureRuntime.load('storyboardContract');
    inputGuard?.assertCurrent();
    const paragraphIds = contractRequest?.paragraphIds || context.paragraphs.map((_, index) => `P${index + 1}`);
    const paragraphIndexById = Object.fromEntries(paragraphIds.map((id, index) => [id, index]));
    const manualSupplement = contractRequest?.manualSupplement ?? state.pendingParagraphSelection?.mode === 'manual_supplement';
    const requiredInsertAfter = contractRequest?.requiredInsertAfter || (Number.isInteger(context.forcedParagraphIndex)
      ? paragraphIds[context.forcedParagraphIndex] || ''
      : '');
    const allowedRatioIds = state.compositionPolicy?.mode === 'fixed' && state.compositionPolicy?.fixedRatioId
      ? [state.compositionPolicy.fixedRatioId]
      : state.compositionPolicy?.allowedRatioIds || STORYBOARD_RATIOS.map((item) => item.id);
    const contractOptions = {
      kind: 'plan',
      ...(contractRequest?.promptFormats?.length ? {promptFormats:contractRequest.promptFormats} : {}),
      requirePrimarySubject: contractRequest?.requirePrimarySubject === true,
      allowedParagraphIds: paragraphIds,
      allowedRatioIds,
      maxShots: manualSupplement ? 1 : getStoryboardGenerationPolicy(state).maxImages,
      manualSupplement,
      requiredInsertAfter,
      requiredSourceParagraphIds: contractRequest?.requiredSourceParagraphIds || [],
    };
    const initial = contract.parseStoryboardContractResponse(rawText, contractOptions);
    let repairMessages = [];
    const result = initial.ok ? initial : focused ? {...initial,repairCalls:focused.meta.repairCalls,repairBudgetUsed:focused.meta.repairBudgetUsed} : await contract.repairStoryboardContract({
      raw: rawText,
      validation: initial,
      options: contractOptions,
      request: async (messages) => {
        await context.casting?.assertCurrent();
        await inputGuard?.comfyRoutes?.assertCurrent();
        inputGuard?.assertCurrent();
        repairMessages = messages;
        return (inputGuard?.compilerAttempt?.call||storyboardCallCompiler)(messages, state.promptCompiler.apiProfileId, {
          repair:true,
          temperature: 0,
          maxTokens: contractRequest?.maxTokens || 1800,
          ...(contractRequest?.promptFormats?.length ? {promptFormats:contractRequest.promptFormats} : {}),
          jsonSchema: contractRequest?.schema || contract.STORYBOARD_PLAN_RESPONSE_SCHEMA,
          jsonSchemaName: contract.STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
          jsonSchemaStrict: true,
        });
      },
    });
    inputGuard?.assertCurrent();
    contractMeta = {
      ...(focused?.meta||{}),
      schema: STORYBOARD_PLAN_SCHEMA,
      repairAttempted: Boolean(focused?.meta.repairCalls || result.repairAttempted === true),
      repairCalls: Number(focused?.meta.repairCalls || result.repairCalls || 0),
      localNormalization: (result.normalization || []).slice(0, 8),
      initialErrors: (result.originalErrors || []).slice(0, 24),
      finalErrors: (result.errors || []).slice(0, 24),
    };
    contractTrace = {
      ...(focused?.trace||{}),
      initialResponse: rawText,
      repairMessages,
      repairResponse: String(result.repairedRaw || ''),
      parsedStructure: result.data || null,
    };
    if (!result.ok) throw contract.storyboardContractFailure(result);
    object = contract.adaptStoryboardPlanContract(result.data, {
      paragraphIndexById,
      fallbackParagraphIndex: context.forcedParagraphIndex,
      ...(contractRequest?.promptFormats?.length ? {promptFormats:contractRequest.promptFormats} : {}),
    });
    if(focused)for(const [index,shot] of object.shots.entries()){
      shot.shotSpec.continuityUpdates.facts=focused.trace.shotFacts[index];
      shot.shotSpec.narrativeMoment=createStoryboardStreamMoment(focused.trace.narrative.shots[index],context.compilerSources);
      shot.tags=[...new Set(focused.trace.narrative.shots[index].gallery_keywords||[])];
      const rendering=shot.promptRenderings?.[state.source==='novel'?'tags':'natural_language']||Object.values(shot.promptRenderings||{})[0];
      if(rendering){shot.prompt=[rendering.global,...rendering.characters.map(row=>row.positive)].filter(Boolean).join(', ');shot.negative=rendering.negative;}
    }
  } else {
    let parsed = null;
    try { parsed = extractJson(rawText); } catch (_) {}
    object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) object = {};
  const manualSupplement = state.pendingParagraphSelection?.mode === 'manual_supplement';
  if (object.should_generate === false && !manualSupplement) {
    return {
      shouldGenerate: false,
      skipReason: String(object.skip_reason || '当前楼层没有新增的画面价值').trim().slice(0, 500),
      shots: [], decisions: [], contractMeta, contractTrace,
    };
  }
  const maxIndex = Math.max(0, context.paragraphs.length - 1);
  const allowedTypes = new Set(['portrait', 'group', 'environment', 'object', 'action', 'closeup', 'custom']);
  const allowedRoles = new Set(['establishing', 'relationship', 'medium', 'closeup', 'reaction', 'detail', 'action', 'atmosphere', 'turn', 'custom']);
  const rawShots = Array.isArray(object.shots) ? object.shots : [object];
  const limit = manualSupplement ? 1 : getStoryboardGenerationPolicy(state).maxImages;
  const shots = rawShots.slice(0, limit).map((item, index) => {
    const rawPrompt = String(item?.prompt || item?.positive_prompt || item?.final_prompt || (index === 0 && !Object.keys(object).length ? raw : '') || '')
      .replace(/^```(?:json)?|```$/gi, '').trim().slice(0, 24000);
    const shotSpec = normalizeStoryboardShotSpec(item?.shotSpec || {
      ...item,
      id: item?.id || uid('shotspec'),
      promptAtoms: item?.prompt_atoms || item?.promptAtoms || { global: rawPrompt ? [rawPrompt] : [], negative: [item?.negative || item?.negative_prompt || ''].filter(Boolean) },
    });
    if (!shotSpec.id) shotSpec.id = item?.id || uid('shotspec');
    const profile = storyboardProviderProfile(state);
    const prompt = rawPrompt || compileStoryboardPrompt({ providerId: state.source, remoteModelId: profile.model, capabilityModelId: profile.capabilityModelId, shot: shotSpec }).prompt;
    if (!prompt) return null;
    return {
      id: uid('shotdraft'), prompt, tags:focused?[...(item.tags||[])]:[],
      title: String(item?.title || `镜头 ${index + 1}`).trim().slice(0, 120),
      role: allowedRoles.has(item?.shot_role) ? item.shot_role : 'custom',
      purpose: String(item?.purpose || '').trim().slice(0, 500),
      safePrompt: String(item?.safe_prompt || item?.safePrompt || '').trim().slice(0, 24000),
      negative: capabilities.supportsNativeNegative || capabilities.supportsExclusionText ? String(item?.negative || item?.negative_prompt || '').trim().slice(0, 12000) : '',
      paragraphIndex: Number.isInteger(context.forcedParagraphIndex)
        ? context.forcedParagraphIndex
        : Math.max(0, Math.min(maxIndex, Math.round(Number(item?.paragraph_index) || 0))),
      shotType: allowedTypes.has(item?.shot_type) ? item.shot_type : 'custom',
      shotSpec, sensitive: Boolean(item?.sensitive), order: index,
      ...(item?.promptRenderings ? {promptRenderings:item.promptRenderings} : {}),
    };
  }).filter(Boolean);
  if (!shots.length) throw new Error('画面整理没有返回可用提示词');
  const first = shots[0];
  const output = {
    shouldGenerate: true, skipReason: '',
    prompt: first.prompt, safePrompt: first.safePrompt, negative: first.negative, paragraphIndex: first.paragraphIndex, shotType: first.shotType, shots,
    decisions: Array.isArray(object.decisions) ? object.decisions.map((item) => String(item).slice(0, 500)).slice(0, 12) : [],
    contractMeta, contractTrace,
  };
  return focused?.styleSelection?attachEnsembleCompilerResult(output,{session:styleSession,receipt:focused.styleSelection}):output;
}
