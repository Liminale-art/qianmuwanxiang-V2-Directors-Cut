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
  const read = () => {
    const floor = stream?.floor ?? storyboardTargetFloor(state);
    const recent = Math.max(0, Math.min(20, Number(state.promptCompiler.includeRecentFloors) || 0));
    const chat = ctx().chat || [];
    const selectedPreset = state.promptPresets.find((item) => item.id === state.promptCompiler.instructionPresetId);
    const profileId = state.promptCompiler.apiProfileId;
    const matches = profileId ? (host.settings.apiProfiles || []).filter((item) => item.id === profileId) : [];
    if (requireCompiler && profileId && matches.length !== 1) throw new Error('取景 API 档案已失效或编号重复，请重新选择；未改用其他连接');
    const api = matches[0] || host.settings;
    return {
      enabled: state.enabled, automation:state.automation, source: state.source, target: state.target, floor, floorValue: state.floor,
      profiles: Object.fromEntries(Object.keys(host.providers).map((id) => {
        const { loaded, ...effectiveProfile } = storyboardProviderProfile(state, id);
        return [id, effectiveProfile];
      })), connections: state.connections, credentialRevision: host.credentialRevision,
      draftKeys: [...host.draftApiKeys.entries()],ensembleRevision:host.ensembleRevision,
      compiler: state.promptCompiler, preset: selectedPreset, composition: state.compositionPolicy, routing: state.routing, generation: state.generationPolicy,
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
  let baseline = copy(read()), invalidated = false;
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
  const isCurrent = () => !invalidated && !stream?.signal?.aborted && baseline !== null && (!upstreamGuard || upstreamGuard.isCurrent()) && state === storyboardState()
    && chatKey === String(getChatKey() || '') && plan?.status !== 'cancelled' && ctx().chat?.[floor] === message && equal(baseline, read());
  return {
    stream,
    bindPlan(value){this.assertCurrent();if(plan&&plan!==value||!state.shotPlans.includes(value)||value.chatKey!==chatKey)throw Object.assign(new Error('准备计划归属已变化'),{code:'storyboard_input_changed'});plan=value;this.assertCurrent();},
    get freshComfy() { return freshComfy === true; },
    isCurrent,
    ownsCurrentContext: () => state === storyboardState() && chatKey === String(getChatKey() || ''),
    assertCurrent() {
      try{this.streamFrame?.assertCurrent();}catch(error){throw Object.assign(error,{code:'storyboard_input_changed'});}
      if (isCurrent()) { this.compilerSources?.assertCurrent(); return; }
      const error = new Error('分镜配置或正文已变化，已忽略旧结果，请按当前设置重试');
      error.code = 'storyboard_input_changed'; throw error;
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
