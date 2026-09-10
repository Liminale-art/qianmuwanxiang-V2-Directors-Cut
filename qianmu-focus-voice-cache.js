// Focus owns bounded memory references; persistent audio remains in the shared store.
export function createFocusVoiceCache({available, read}) {
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
  return Object.freeze({
    remember, cueBlob, peek: key => blobs.get(key), clear: () => blobs.clear(),
    get size() { return blobs.size; },
  });
}
