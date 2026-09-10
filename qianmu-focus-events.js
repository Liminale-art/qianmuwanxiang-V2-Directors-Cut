// Bind controls only for a freshly rendered focus page; no application singleton or timers.
export function bindFocusClockPage(root, {state, stateOwner, enabled, defaults, phases, relations, frequencies, soundPresets, ui, clock, books, sound, voice}) {
  const displayedVoice = voice.context();
  const voicePageCurrent = () => {
    const current = voice.context();
    return current.characterKey === displayedVoice.characterKey && current.providerId === displayedVoice.providerId;
  };
  root.querySelector('.sd-focus-lock')?.addEventListener('click', () => void clock.enableLock());
  root.querySelector('.sd-focus-auto-next-wrap')?.addEventListener('click', (event) => event.stopPropagation());
  root.querySelector('.sd-focus-voice-drawer-open')?.addEventListener('click', voice.openDrawer);
  root.querySelector('.sd-focus-finale-voice')?.addEventListener('click', voice.openDrawer);
  root.querySelectorAll('.sd-focus-phase').forEach((button) => button.addEventListener('click', () => {
    clock.selectPhase(button.dataset.focusPhase);
    ui.render();
  }));
  root.querySelectorAll('.sd-focus-activity').forEach((button) => button.addEventListener('click', () => {
    const f = state();
    if (f.status !== 'idle') return;
    f.activity = button.dataset.focusActivity === 'reading' ? 'reading' : 'task';
    if (f.activity === 'reading' && !books.meta(f.bookId)) f.bookId = books.list()?.[0]?.id || '';
    ui.save();
    ui.render();
  }));
  root.querySelector('.sd-focus-book')?.addEventListener('change', (event) => {
    const f = state();
    f.bookId = String(event.target.value || '');
    const book = books.meta(f.bookId);
    if (book) f.task = `阅读《${book.title || '未命名书籍'}》`;
    ui.save();
    ui.render();
  });
  root.querySelector('.sd-focus-open-reading')?.addEventListener('click', () => {
    if (state().status === 'running') void clock.enterReading();
    else void clock.requestStart();
  });
  root.querySelector('.sd-focus-main')?.addEventListener('click', () => {
    const f = state();
    const task = root.querySelector('.sd-focus-task')?.value;
    if (typeof task === 'string') f.task = task.trim().slice(0, 120);
    if (f.status === 'running') clock.pause(); else void clock.requestStart();
    ui.render();
  });
  root.querySelector('.sd-focus-task')?.addEventListener('change', (event) => {
    state().task = String(event.target.value || '').trim().slice(0, 120);
    ui.save();
  });
  root.querySelector('.sd-focus-reset')?.addEventListener('click', async () => {
    const f = state();
    if (f.status !== 'idle') {
      const sessionToken = f.sessionToken, phase = f.phase;
      const yes = await ui.confirm('结束本轮', '当前进度不会计入完成记录，确定结束？');
      if (!yes || !enabled() || stateOwner() !== f || f.sessionToken !== sessionToken || f.phase !== phase) return;
    }
    clock.reset();
    ui.render();
  });
  root.querySelectorAll('.sd-focus-setting').forEach((input) => input.addEventListener('change', () => {
    const f = state();
    const key = input.dataset.focusSetting;
    const limits = { focusMinutes: [1, 240], shortBreakMinutes: [1, 60], longBreakMinutes: [1, 120], longBreakEvery: [1, 12], dailyGoal: [1, 24] };
    const [min, max] = limits[key] || [1, 240];
    f[key] = Math.max(min, Math.min(max, Math.round(Number(input.value) || Number(defaults[key]) || min)));
    if (f.status === 'idle' && phases[f.phase]?.setting === key) {
      f.remainingMs = clock.phaseMs(f.phase, f);
      f.sessionPlannedMs = f.remainingMs;
    }
    ui.save();
    ui.render();
  }));
  root.querySelector('.sd-focus-auto-next')?.addEventListener('change', (event) => {
    state().autoStartNext = Boolean(event.target.checked);
    ui.save();
  });
  root.querySelector('.sd-focus-sound')?.addEventListener('change', (event) => {
    state().soundEnabled = Boolean(event.target.checked);
    if (event.target.checked) sound.prime(); else sound.reset();
    ui.save();
    ui.render();
  });
  root.querySelectorAll('.sd-focus-sound-source').forEach((button) => button.addEventListener('click', () => {
    const f = state();
    f.soundSource = ['builtin', 'url'].includes(button.dataset.focusSoundSource) ? button.dataset.focusSoundSource : 'builtin';
    sound.reset();
    ui.save();
    ui.render();
  }));
  root.querySelector('.sd-focus-sound-preset')?.addEventListener('change', (event) => {
    const f = state();
    f.soundPreset = soundPresets[event.target.value] ? event.target.value : 'silverBell';
    ui.save();
  });
  root.querySelector('.sd-focus-sound-url')?.addEventListener('change', (event) => {
    const f = state();
    f.soundUrl = String(event.target.value || '').trim().slice(0, 2048);
    sound.reset();
    ui.save();
  });
  root.querySelector('.sd-focus-sound-preview')?.addEventListener('click', () => {
    const urlInput = root.querySelector('.sd-focus-sound-url');
    if (urlInput) {
      const f = state();
      const nextUrl = String(urlInput.value || '').trim().slice(0, 2048);
      if (nextUrl !== f.soundUrl) {
        f.soundUrl = nextUrl;
        sound.reset();
        ui.save();
      }
    }
    void sound.play({ preview: true });
  });
  sound.sync();
  root.querySelector('.sd-focus-week-export')?.addEventListener('click', () => void clock.exportWeek());
  root.querySelector('.sd-focus-voice-enabled')?.addEventListener('change', (event) => {
    if (voicePageCurrent()) voice.setEnabled(Boolean(event.target.checked));
    ui.render();
  });
  root.querySelector('.sd-focus-voice-character')?.addEventListener('change', event => {
    const f = state(), avatar = event.target.value;
    if (f.status !== 'idle' || f.activity === 'reading') return;
    if (avatar && !books.choices().some(ch => (ch.avatar || ch.data?.avatar) === avatar)) return;
    f.voiceCharacterAvatar = avatar; voice.cancel({ clearCues: true }); ui.save(); ui.render();
  });
  root.querySelector('.sd-focus-voice-speaker')?.addEventListener('change', (event) => {
    voice.bind(event.target.value, displayedVoice.characterKey, displayedVoice.providerId); ui.render();
  });
  root.querySelector('.sd-focus-voice-relation')?.addEventListener('change', (event) => {
    const f = state();
    const voice = voice.context(f);
    if (!voice.chatKey || f.status !== 'idle' || !voicePageCurrent()) return;
    f.voiceRelationByChat[voice.chatKey] = relations[event.target.value] ? event.target.value : 'neutral';
    ui.save();
  });
  root.querySelectorAll('.sd-focus-voice-mode').forEach((button) => button.addEventListener('click', () => {
    state().voiceMode = button.dataset.focusVoiceMode === 'scene' ? 'scene' : 'stock';
    ui.save();
    ui.render();
  }));
  root.querySelectorAll('.sd-focus-voice-frequency').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.focusVoiceFrequency;
    state().voiceFrequency = frequencies[id] ? id : 'low';
    ui.save();
    ui.render();
  }));
  root.querySelector('.sd-focus-finale-note')?.addEventListener('change', (event) => {
    const f = state();
    const entry = f.history.find((item) => item.id === f.lastCompletionId);
    if (!entry) return;
    entry.note = String(event.target.value || '').trim().slice(0, 100);
    ui.save();
  });
  root.querySelector('.sd-focus-finale-close')?.addEventListener('click', () => {
    state().lastCompletionId = '';
    ui.save();
    ui.render();
  });
  root.querySelector('.sd-focus-clear-history')?.addEventListener('click', async () => {
    const owner = stateOwner(), today = clock.dateKey();
    const yes = await ui.confirm('清空今日记录', '只清除今天已完成的专注记录，确定继续？');
    if (!yes || !enabled() || stateOwner() !== owner || clock.dateKey() !== today) return;
    const f = state();
    f.history = f.history.filter((item) => clock.dateKey(item.finishedAt || item.startedAt) !== today);
    if (!f.history.some((item) => item.id === f.lastCompletionId)) f.lastCompletionId = '';
    ui.save();
    ui.render();
  });
}
