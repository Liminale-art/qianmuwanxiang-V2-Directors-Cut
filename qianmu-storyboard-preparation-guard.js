// Preparation input ownership only: no storage, model or startup side effects.
export function createStoryboardPreparationGuard(state, { plan = null, includeDraft = true, upstreamGuard = null, requireCompiler = false, freshComfy = false, stream = null } = {}, host) {
  const {ctx,getChatKey,storyboardState,storyboardTargetFloor,storyboardProviderProfile,getCharacterDescription,getPersonaDescription,document}=host;
  const chatKey = String(getChatKey() || '');
  const copy = (value) => Array.isArray(value) ? value.map(copy)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
  const equal = (a, b) => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  };
  // Only preparation inputs: no gallery, logs, media bytes or parameter-memory archive. Strings are not serialized/copied.
  const read = ({ initial = false } = {}) => {
    const floor = stream?.floor ?? storyboardTargetFloor(state);
    const recent = Math.max(0, Math.min(20, Number(state.promptCompiler.includeRecentFloors) || 0));
    const chat = ctx().chat || [];
    const selectedPreset = state.promptPresets.find((item) => item.id === state.promptCompiler.instructionPresetId);
    const profileId = state.promptCompiler.apiProfileId;
    const matches = profileId ? (host.settings.apiProfiles || []).filter((item) => item.id === profileId) : [];
    if (requireCompiler && profileId && matches.length !== 1) {
      // Invalid initial choices get their explicit setup error. Losing that
      // choice during a running attempt is an input change, not an exception
      // escaping isCurrent() (including the compiler catch's second check).
      if (!initial) return null;
      throw new Error('取景 API 档案已失效或编号重复，请重新选择；未改用其他连接');
    }
    const api = matches[0] || host.settings;
    // The directory currently being browsed is not a compiler input. Warming
    // the directory may clear a removed book here without changing any selected
    // book or entry. Keep every other compiler field (including unknown ones).
    const { worldBookView, ...compiler } = state.promptCompiler;
    return {
      enabled: state.enabled, automation:state.automation, source: state.source, target: state.target, floor, floorValue: state.floor,
      profiles: Object.fromEntries(Object.keys(host.providers).map((id) => {
        const { loaded, ...effectiveProfile } = storyboardProviderProfile(state, id);
        return [id, effectiveProfile];
      })), connections: state.connections, credentialRevision: host.credentialRevision,
      draftKeys: [...host.draftApiKeys.entries()],ensembleRevision:host.ensembleRevision,
      compiler, preset: selectedPreset, galleryKeywords:state.galleryKeywords, composition: state.compositionPolicy, routing: state.routing, generation: state.generationPolicy,
      comfyPoolSelection: state.comfyPoolSelection,
      comfyAutoEnabled: state.comfyAutoEnabled,
      parameterPresets: state.parameterPresets, paragraphMode: state.paragraphMode, manualParagraphIndex: state.manualParagraphIndex,
      paragraphSelection: state.pendingParagraphSelection, promptMode: state.promptMode,
      prompt: includeDraft ? state.prompt : undefined, negative: includeDraft ? state.negative : undefined, promptDraft: includeDraft ? state.promptDraft : undefined,
      selectedArtist: state.selectedArtistPresetId, selectedPool: state.selectedArtistPoolId,
      artists: state.artistPresets.map(({ id, value, positivePrompt, negativePrompt }) => ({ id, value, positivePrompt, negativePrompt })),
      pools: state.artistPools, vibes: state.selectedVibeIds,
      llm: { id: api.id, mode: host.settings.providerMode, apiUrl: api.apiUrl, apiKey: api.apiKey, model: api.model, temperature: api.temperature, structuredOutputMode: api.structuredOutputMode },
      character: getCharacterDescription(), persona: getPersonaDescription(), mainApi: ctx().mainApi,
      messages: chat.slice(Math.max(0, floor - recent), floor + 1).map((item,index,rows) => ({ text: stream && !stream.complete && index===rows.length-1 ? undefined : item?.mes, swipe: item?.swipe_id, user: item?.is_user, system: item?.is_system })),
    };
  };
  const floor = stream?.floor ?? storyboardTargetFloor(state), message = ctx().chat?.[floor];
  // Reuse the explicit floor action's existing origin; automatic/stream plans
  // cannot acquire this scope from a saved setting or a later plan mutation.
  const manualTarget = !stream && state.target === 'floor' && plan?.floor === floor && plan.chatKey === chatKey
    && state.shotPlans.includes(plan) && ['manual', 'manual_supplement'].includes(plan.origin)
    ? {plan, id:plan.id, origin:plan.origin} : null;
  let baseline = copy(read({ initial:true })), invalidated = false, inputChangeReason = '';
  // Input events also invalidate edit-and-restore (A → B → A), without cancelling on scrolling or library searches.
  const onInput = (event) => {
    const target = event.target;
    if (target?.closest?.('.sd-storyboard-root') && target.matches?.('input, textarea, select')
      && !/search/.test(String(target.className || '')) && target.type !== 'search') invalidated = true;
  };
  if (document) {
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
  }
  // Fixed categories only: never expose snapshot values, field names supplied
  // by users, connection addresses, keys, prompts or source text to diagnostics.
  const reject = reason => { inputChangeReason = reason; return false; };
  const isCurrent = () => {
    if (invalidated) return reject('preparation_input_event');
    if (stream?.signal?.aborted) return reject('preparation_stream_aborted');
    if (baseline === null) return reject('preparation_disposed');
    if (upstreamGuard && !upstreamGuard.isCurrent()) return reject('preparation_upstream_changed');
    if (state !== storyboardState()) return reject('preparation_state_changed');
    if (manualTarget && !(plan === manualTarget.plan && plan.id === manualTarget.id && plan.origin === manualTarget.origin && plan.floor === floor && plan.chatKey === chatKey && state.shotPlans.includes(plan))) return reject('preparation_plan_changed');
    if (chatKey !== String(getChatKey() || '')) return reject('preparation_chat_changed');
    if (plan?.status === 'cancelled') return reject('preparation_plan_cancelled');
    if (ctx().chat?.[floor] !== message) return reject('preparation_message_replaced');
    const current = read();
    if (current === null) return reject('preparation_compiler_changed');
    for (const key of Object.keys(baseline)) {
      if (equal(baseline[key], current[key])) continue;
      if (key === 'profiles') return reject('preparation_profile_changed');
      if (key === 'connections') return reject('preparation_connection_changed');
      if (['credentialRevision', 'draftKeys'].includes(key)) return reject('preparation_credentials_changed');
      if (key === 'compiler') return reject(!equal(baseline.compiler.worldBookNames, current.compiler.worldBookNames) || !equal(baseline.compiler.worldEntryIds, current.compiler.worldEntryIds)
        ? 'preparation_world_selection_changed' : 'preparation_compiler_changed');
      if (key === 'messages') return reject('preparation_messages_changed');
      if (['character', 'persona', 'mainApi'].includes(key)) return reject('preparation_context_changed');
      return reject('preparation_config_changed');
    }
    return true;
  };
  const sourceReasons = new Set(['compiler_sources_changed', 'compiler_source_message_changed', 'compiler_source_context_changed', 'compiler_source_account_changed']);
  const annotate = (error, reason) => { inputChangeReason = reason; return Object.assign(error, { code:'storyboard_input_changed', inputChangeReason:reason }); };
  return {
    stream,
    get inputChangeReason() { return inputChangeReason; },
    get allowHiddenTarget() { return manualTarget !== null; },
    bindPlan(value){this.assertCurrent();if(plan&&plan!==value||!state.shotPlans.includes(value)||value.chatKey!==chatKey)throw annotate(new Error('准备计划归属已变化'),'preparation_plan_changed');plan=value;this.assertCurrent();},
    get freshComfy() { return freshComfy === true; },
    isCurrent,
    ownsCurrentContext: () => state === storyboardState() && chatKey === String(getChatKey() || ''),
    assertCurrent() {
      try{this.streamFrame?.assertCurrent();}catch(error){throw annotate(error,'preparation_stream_changed');}
      if (isCurrent()) {
        try { this.compilerSources?.assertCurrent(); }
        catch (error) { throw annotate(error, sourceReasons.has(error?.inputChangeReason) ? error.inputChangeReason : 'compiler_sources_changed'); }
        return;
      }
      const error = new Error('分镜配置或正文已变化，已忽略旧结果，请按当前设置重试');
      throw annotate(error, inputChangeReason);
    },
    dispose() {
      this.ensemble?.close();
      this.continuityStore?.close();
      this.compilerSources?.close();
      this.streamFrame?.close();
      this.comfyBatch?.close();this.comfyAuto?.close();this.comfyReadiness?.close();
      baseline = null;
      if (document) {
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('change', onInput, true);
      }
    },
  };
}
