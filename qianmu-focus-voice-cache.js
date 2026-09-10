// Focus owns bounded memory references; persistent audio remains in the shared store.
export function createFocusVoiceCache({available, read, write, prune, cacheLimit, tts}) {
  const blobs = new Map();
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
    let params = {...binding.params, text};
    const provider = tts.provider(params.providerId);
    if (!tts.hasCredentials(params.providerId, params)) throw new Error(`未配置 ${provider.label} 凭证`);
    let key = tts.key(params.providerId, params);
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
      key = tts.key(params.providerId, params);
    }
    if (available()) {
      await write(key, result.blob, {speaker: binding.speaker, text, source: 'focus', provider: params.providerId});
      assertCurrent();
      await prune(cacheLimit(), 'tts').catch(() => {});
    }
    assertCurrent();
    return remember(key, result.blob);
  }
  return Object.freeze({
    remember, cueBlob, synthesize, peek: key => blobs.get(key), clear: () => blobs.clear(),
    get size() { return blobs.size; },
  });
}
