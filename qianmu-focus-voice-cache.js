// Focus owns bounded memory references; persistent audio remains in the shared store.
export function createFocusVoiceCache({available, read, write, prune, cacheLimit, tts, round}) {
  const blobs = new Map();
  let cleanup=Promise.resolve();
  function beginRound(state){
    if(!round||state!==round.state())return;
    const token=state.sessionToken||crypto.randomUUID();
    const old=[...(state.voiceReplayCues||[]),...(state.voiceCleanupCues||[]),...(state.sessionVoiceCues||[]),
      ...(!state.voiceReplayCues?(state.history||[]).flatMap(entry=>entry.voiceCues||[]):[])];
    const unique=[...new Map(old.filter(cue=>cue?.cacheKey).map(cue=>[cue.cacheKey,{...cue}])).values()];
    state.voiceRoundId=token;state.voiceReplayCues=[];state.voiceCleanupCues=unique;round.save();
    cleanup=cleanup.then(async()=>{
      const live=()=>state===round.state()&&state.voiceRoundId===token;
      if(!live())return;const failed=[];
      for(const cue of unique){
        if(!live())return;
        try{
          if(!available())throw Error('无法核对收藏，暂不清理');
          const favorite=await round.hasFavorite(`fav:${cue.cacheKey}`);
          if(!live())return;
          if(favorite){state.voiceReplayCues.push(cue);continue;}
          // Never delete a legacy shared TTS key, narration audio, or a library original.
          if(cue.cacheKey.startsWith('focus-round:')&&available())await round.remove(cue.cacheKey);
          if(!live())return;blobs.delete(cue.cacheKey);
        }catch(_){if(!live())return;failed.push(cue);state.voiceReplayCues.push(cue);}
      }
      if(live()){state.voiceCleanupCues=failed;round.save();if(failed.length)round.warn();}
    }).catch(()=>{if(state===round.state())round.warn();});
    return cleanup;
  }
  function remember(key, blob) {
    blobs.set(key, blob);
    while (blobs.size > 12) blobs.delete(blobs.keys().next().value);
    return key;
  }
  async function cueBlob(cue) {
    if (!cue?.cacheKey) return null;
    const memoryBlob = blobs.get(cue.cacheKey);
    if (memoryBlob) return memoryBlob;
    if (!available()) return null;
    const hit = await read(cue.cacheKey).catch(() => null);
    return hit?.blob || null;
  }
  async function synthesize(binding, text, {isCurrent = () => true} = {}) {
    const assertCurrent = () => { if (!isCurrent()) throw new DOMException('专注语音请求已失效', 'AbortError'); };
    assertCurrent();
    const state=round?.state();
    if(round){await cleanup;assertCurrent();if(state!==round.state())throw new DOMException('账户已变化','AbortError');}
    const prefix=state?`focus-round:${state.voiceRoundId||state.sessionToken}:`:'';
    let params = {...binding.params, text};
    const provider = tts.provider(params.providerId);
    if (!tts.hasCredentials(params.providerId, params)) throw new Error(`未配置 ${provider.label} 凭证`);
    let key = prefix+tts.key(params.providerId, params);
    if (available()) {
      const hit = await read(key).catch(() => null);
      assertCurrent();
      if (hit?.blob) return remember(key, hit.blob);
    }
    const result = await tts.synthesize(params.providerId, params);
    assertCurrent();
    if (params.providerId === 'doubao' && params.model === 'auto' && result.resolvedModel) {
      tts.persistResolvedModel(params, result.resolvedModel);
      params = {...params, model: result.resolvedModel};
      key = prefix+tts.key(params.providerId, params);
    }
    if (available()) {
      await write(key, result.blob, {speaker: binding.speaker, text, source: 'focus', provider: params.providerId});
      if(!isCurrent()){if(round&&key.startsWith('focus-round:'))await round.remove(key).catch(()=>{});assertCurrent();}
      await prune(cacheLimit(), 'tts').catch(() => {});
    }
    assertCurrent();
    return remember(key, result.blob);
  }
  return Object.freeze({
    beginRound, remember, cueBlob, synthesize, peek: key => blobs.get(key), clear: () => blobs.clear(),
    get size() { return blobs.size; },
  });
}
