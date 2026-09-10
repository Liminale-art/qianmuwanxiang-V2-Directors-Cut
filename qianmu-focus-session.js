// Session transitions only. The host owns normalization, persistence, media and navigation.
export function createFocusSessionController({getState, phaseMs, remainingMs, phases, historyLimit, clockNow, uid, reading, voice, clock, lock, save, notify, renderCompletion}) {
  function selectPhase(phase) {
    const f = getState();
    if (!phases[phase] || f.status !== 'idle') return;
    f.phase = phase;
    f.status = 'idle';
    f.remainingMs = phaseMs(phase, f);
    f.sessionPlannedMs = f.remainingMs;
    f.endsAt = 0;
    f.runStartedAt = 0;
    f.sessionStartedAt = 0;
    f.sessionElapsedMs = 0;
    f.sessionToken = '';
    f.sessionVoiceCues = [];
    voice.cancel();
    save();
  }

  function start() {
    const f = getState();
    if (f.status === 'running') return;
    if (f.phase === 'focus' && f.activity === 'reading' && !reading.ready(f.bookId)) return;
    f.readingExitPaused = false;
    const now = clockNow();
    const remaining = Math.max(1000, remainingMs(f, now) || phaseMs(f.phase, f));
    let prepareVoice = false;
    if (f.status === 'idle') {
      if (f.phase === 'focus') f.lastCompletionId = '';
      if (f.activity === 'reading') {
        const book = reading.book(f.bookId);
        if (!book) return notify('请先选择一本伴读书籍。', 'warning');
        f.task = `阅读《${book.title || '未命名书籍'}》`;
        f.sessionBookId = book.id;
        f.sessionProgressStart = Math.max(0, Math.min(100, Number(book.progress) || 0));
      } else {
        f.sessionBookId = '';
        f.sessionProgressStart = 0;
      }
      f.sessionStartedAt = now;
      f.sessionElapsedMs = 0;
      f.sessionPlannedMs = remaining;
      f.sessionToken = f.phase === 'focus' ? uid('focussession') : '';
      f.sessionVoiceCues = [];
      voice.cancel();
      prepareVoice = f.phase === 'focus' && voice.enabled(f);
    } else {
      prepareVoice = f.phase === 'focus' && !f.sessionVoiceCues.some(cue => cue.type === 'complete' && !cue.played)
        && voice.enabled(f);
    }
    f.status = 'running';
    f.remainingMs = remaining;
    f.runStartedAt = now;
    f.endsAt = now + remaining;
    clock.prime();
    save();
    clock.reconcile({ prepareVoice: false });
    clock.refresh();
    if (prepareVoice) void voice.prepare(f.sessionToken);
  }

  function pause() {
    if (lock.blocks()) return;
    const f = getState();
    f.readingExitPaused = false;
    if (f.status !== 'running') return;
    const now = clockNow();
    if (f.endsAt <= now) { complete(); return; }
    f.sessionElapsedMs += Math.max(0, now - (f.runStartedAt || now));
    f.remainingMs = Math.max(0, f.endsAt - now);
    f.endsAt = 0;
    f.runStartedAt = 0;
    f.status = 'paused';
    voice.cancel();
    save();
    clock.reconcile({ prepareVoice: false });
    clock.refresh();
  }

  function reset() {
    if (lock.blocks()) return;
    const f = getState();
    f.readingExitPaused = false;
    f.status = 'idle';
    f.remainingMs = phaseMs(f.phase, f);
    f.sessionPlannedMs = f.remainingMs;
    f.endsAt = 0;
    f.runStartedAt = 0;
    f.sessionStartedAt = 0;
    f.sessionElapsedMs = 0;
    f.sessionBookId = '';
    f.sessionProgressStart = 0;
    f.sessionToken = '';
    f.sessionVoiceCues = [];
    voice.cancel();
    save();
    clock.reconcile({ prepareVoice: false });
    clock.refresh();
  }

  function complete() {
    const f = getState();
    if (f.status !== 'running') return;
    const now = clockNow();
    const completedPhase = f.phase;
    const wasLocked = !!f.lock;
    if (wasLocked) lock.release();
    const completionCue = completedPhase === 'focus' ? f.sessionVoiceCues.find((cue) => cue.type === 'complete' && !cue.played && voice.bindingActive(cue.voiceBindingKey)) : null;
    if (completedPhase === 'focus') {
      const durationMs = Math.max(1000, Number(f.sessionPlannedMs) || phaseMs('focus', f));
      const linkedBook = f.sessionBookId ? reading.book(f.sessionBookId) : null;
      const completedVoiceCues = f.sessionVoiceCues
        .filter((cue) => cue?.cacheKey && (cue.played || cue === completionCue))
        .map((cue) => ({ ...cue, played: true }));
      const completedEntry = {
        id: uid('focus'), kind: 'focus', task: String(f.task || '').trim() || '未命名专注',
        startedAt: f.sessionStartedAt || Math.max(0, now - durationMs), finishedAt: now, durationMs,
        activity: f.sessionBookId ? 'reading' : 'task', bookId: f.sessionBookId || '', bookTitle: linkedBook?.title || '',
        progressStart: f.sessionBookId ? f.sessionProgressStart : null,
        progressEnd: f.sessionBookId ? Math.max(0, Math.min(100, Number(linkedBook?.progress) || 0)) : null,
        voiceText: completionCue?.text || '', voiceCues: completedVoiceCues, note: '',
      };
      f.history.unshift(completedEntry);
      f.lastCompletionId = completedEntry.id;
      f.history = f.history.slice(0, historyLimit);
      f.focusCycle += 1;
      f.phase = f.focusCycle % f.longBreakEvery === 0 ? 'longBreak' : 'shortBreak';
    } else {
      f.phase = 'focus';
    }
    const autoNext = f.autoStartNext && !wasLocked && !(f.phase === 'focus' && f.activity === 'reading' && !reading.ready(f.bookId));
    f.status = autoNext ? 'running' : 'idle';
    f.remainingMs = phaseMs(f.phase, f);
    f.sessionPlannedMs = f.remainingMs;
    f.sessionStartedAt = autoNext ? now : 0;
    f.sessionElapsedMs = 0;
    f.sessionBookId = autoNext && f.phase === 'focus' && f.activity === 'reading' ? f.bookId : '';
    f.sessionProgressStart = f.sessionBookId ? Math.max(0, Math.min(100, Number(reading.book(f.sessionBookId)?.progress) || 0)) : 0;
    f.runStartedAt = autoNext ? now : 0;
    f.endsAt = autoNext ? now + f.remainingMs : 0;
    f.sessionToken = autoNext && f.phase === 'focus' ? uid('focussession') : '';
    f.sessionVoiceCues = [];
    voice.cancel();
    save();
    clock.reconcile({ prepareVoice: false });
    void voice.completionAlert(completionCue);
    if (f.sessionToken && voice.enabled(f)) void voice.prepare(f.sessionToken);
    const nextLabel = phases[f.phase].label;
    notify(completedPhase === 'focus' ? `这一程已经完成，接下来是${nextLabel}。` : '休息结束，慢慢回到下一段专注。', 'success');
    renderCompletion();
  }
  return Object.freeze({selectPhase, start, pause, reset, complete});
}
