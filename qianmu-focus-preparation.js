// Owns preparation tickets only; adapters keep provider requests, storage and identity resolution outside.
export function createFocusVoicePreparation({enabled, getState, voice, frequencies, midpoints, bookMeta, textSource, synthesize, uid, now, save, warn}) {
  let sequence = 0, pending = null;
  async function prepare(sessionToken) {
    const f = getState();
    if (!enabled() || f.status !== 'running' || f.phase !== 'focus' || !sessionToken || f.sessionToken !== sessionToken) return;
    const voiceContext = voice.context(f);
    if (!voiceContext.hasCharacter || !voiceContext.enabled || !voiceContext.voice) return;
    const bindingKey = voice.key(voiceContext);
    if (pending?.sessionToken === sessionToken && pending.bindingKey === bindingKey
        && pending.seq === sequence) return;
    const prepareSeq = ++sequence;
    const work = { sessionToken, bindingKey, seq: prepareSeq };
    pending = work;
    const isCurrent = () => prepareSeq === sequence && getState() === f
      && f.status === 'running' && f.phase === 'focus' && f.sessionToken === sessionToken && voice.active(bindingKey);
    try {
      const baseParams = voice.params(voiceContext, '专注提醒');
      if (!baseParams || !voice.credentials(baseParams.providerId, baseParams)) return;
      const frequency = frequencies[f.voiceFrequency] || frequencies.low;
      const durationMinutes = Math.max(1, Number(f.sessionPlannedMs) / 60000);
      const specs = midpoints(durationMinutes, frequency.chance)
        .map((progress) => ({ type: 'mid', progress }));
      specs.push({ type: 'complete', progress: 1 });
      const book = f.sessionBookId ? bookMeta(f.sessionBookId) : null;
      const subject = f.sessionBookId ? `阅读《${book?.title || '未命名书籍'}》` : (f.task || '完成一段专注');
      const binding = { ...voiceContext, params: { ...baseParams, text: '' } };
      let lines = [];
      if (f.voiceMode === 'scene') {
        try { lines = await textSource.generate(binding, specs.length, subject, { isCurrent }); }
        catch (error) {
          if (!isCurrent() || error?.name === 'AbortError') return;
          warn('scene', error);
        }
      }
      if (lines.length < specs.length) {
        const fallback = textSource.fallback(binding.relation, specs.length);
        lines = specs.map((_, index) => lines[index] || fallback[index]);
      }
      const cues = [];
      for (let index = 0; index < specs.length; index++) {
        if (!isCurrent()) return;
        const text = textSource.clean(lines[index]);
        if (!text) continue;
        try {
          const cacheKey = await synthesize(binding, text, { isCurrent });
          if (!isCurrent()) return;
          cues.push({
            id: uid('focusvoice'), ...specs[index], text, cacheKey, played: false,
            speaker: binding.speaker,
            providerId: baseParams.providerId,
            format: baseParams.fileExtension || 'mp3',
            chatKey: binding.chatKey,
            characterKey: binding.characterKey,
            voiceBindingKey: bindingKey,
            task: String(subject || f.task || '专注').slice(0, 120),
            sourceTime: f.sessionStartedAt || now(),
            lineIndex: index,
          });
        } catch (error) {
          if (!isCurrent() || error?.name === 'AbortError') return;
          warn('synth', error);
        }
      }
      const current = getState();
      if (!isCurrent()) return;
      current.sessionVoiceCues = [...current.sessionVoiceCues.filter(cue => cue.played), ...cues].slice(-4);
      save();
    } finally { if (pending === work) pending = null; }
  }
  function cancel() { sequence += 1; }
  return Object.freeze({prepare, cancel, get epoch() { return sequence; }, get busy() { return pending !== null; }});
}
