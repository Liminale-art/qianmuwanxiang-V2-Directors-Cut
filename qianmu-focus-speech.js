// Own only focus speech admission and audio identity; the shared TTS channel stays with the host.
export function createFocusSpeechPlayer({Audio, URL, memory, cacheAvailable, readCache, channel, bindingActive}) {
  let sequence = 0, ownedAudio = null;
  function stopOwned() {
    if (ownedAudio && channel.current() === ownedAudio) channel.stop();
  }
  function cancel({stopPlayback = true} = {}) {
    sequence += 1;
    if (stopPlayback) stopOwned();
  }
  async function play(cue, {automatic = false, isCurrent = () => true} = {}) {
    if (!cue?.cacheKey) return false;
    const playSeq = ++sequence, channelSeq = channel.epoch();
    const allowed = () => playSeq === sequence && channelSeq === channel.epoch() && isCurrent()
      && (!automatic || bindingActive(cue.voiceBindingKey));
    if (!allowed()) return false;
    try {
      const memoryBlob = memory(cue.cacheKey);
      const hit = memoryBlob ? {blob: memoryBlob} : (cacheAvailable() ? await readCache(cue.cacheKey) : null);
      if (!hit?.blob || !allowed()) return false;
      channel.stop();
      const url = URL.createObjectURL(hit.blob);
      const audio = new Audio(url);
      ownedAudio = audio;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        channel.release(audio, url, cleanup);
        if (ownedAudio === audio) ownedAudio = null;
      };
      channel.adopt(audio, url, cleanup);
      audio.addEventListener('ended', cleanup, {once: true});
      audio.addEventListener('error', cleanup, {once: true});
      try { await audio.play(); } catch (_) { cleanup(); return false; }
      return true;
    } catch (_) { return false; }
  }
  async function complete(cue, fallback) {
    const epoch = sequence;
    if (await play(cue, {automatic: true})) return;
    if (sequence > epoch + (cue?.cacheKey ? 1 : 0)) return;
    await fallback();
  }
  return Object.freeze({play, cancel, stopOwned, complete});
}
