// Bind controls only for a freshly rendered focus page; no application singleton or timers.
export function bindFocusClockPage(root, {state, stateOwner, enabled, defaults, phases, relations, frequencies, soundPresets, ui, clock, books, sound, voice}) {
  const displayedVoice = voice.context();
  const voicePageCurrent = () => {
    const current = voice.context();
    return current.characterKey === displayedVoice.characterKey && current.providerId === displayedVoice.providerId;
  };
  if (root.querySelector('.sd-focus-voice-setup-tip') && !state().voiceSetupTipSeen) {
    state().voiceSetupTipSeen = true;
    ui.save();
  }
  root.querySelector('.sd-focus-lock')?.addEventListener('click', () => void clock.enableLock());
  root.querySelector('.sd-focus-auto-next-wrap')?.addEventListener('click', (event) => event.stopPropagation());
  root.querySelector('.sd-focus-voice-drawer-open')?.addEventListener('click', voice.openDrawer);
  const libraryButton=root.querySelector('.sd-focus-library-open');
  for(const type of ['pointerenter','focus'])libraryButton?.addEventListener(type,()=>{void voice.warmLibrary?.().catch(()=>{});},{once:true});
  libraryButton?.addEventListener('click',async()=>{const label=libraryButton.innerHTML;libraryButton.disabled=true;libraryButton.textContent='正在打开…';try{await voice.openLibrary();}finally{if(libraryButton.isConnected){libraryButton.innerHTML=label;libraryButton.disabled=false;}}});
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
    if (event.target.checked) voice.setEnabled(false);
    state().soundEnabled = Boolean(event.target.checked);
    if (event.target.checked) sound.prime(); else sound.reset();
    ui.save();
    ui.render();
  });
  root.querySelectorAll('.sd-focus-sound-source').forEach((button) => button.addEventListener('click', () => {
    const f = state();
    f.soundSource = ['builtin', 'url'].includes(button.dataset.focusSoundSource) ? button.dataset.focusSoundSource : 'builtin';
    ui.save();
    void sound.play({ selectionChanged: true });
    ui.render();
  }));
  root.querySelector('.sd-focus-sound-preset')?.addEventListener('change', (event) => {
    const f = state();
    f.soundPreset = soundPresets[event.target.value] ? event.target.value : 'silverBell';
    ui.save();
    void sound.play({ selectionChanged: true });
  });
  root.querySelector('.sd-focus-sound-url')?.addEventListener('change', (event) => {
    const f = state();
    f.soundUrl = String(event.target.value || '').trim().slice(0, 2048);
    ui.save();
    void sound.play({ selectionChanged: true });
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
  const speaker=root.querySelector('.sd-focus-voice-speaker'),menu=root.querySelector('.sd-focus-voice-menu');
  const voiceMenuOwner=stateOwner?.()||state();
  const voiceMenuCurrent=()=>enabled?.()!==false&&(stateOwner?.()||state())===voiceMenuOwner&&state().status==='idle'&&voicePageCurrent();
  const dismissVoiceMenu=()=>{menu.close();speaker.setAttribute('aria-expanded','false');};
  speaker?.addEventListener('click',()=>{
    if(!voiceMenuCurrent())return;
    menu.showModal();speaker.setAttribute('aria-expanded','true');
    (menu.querySelector('[aria-selected=true]')||menu.querySelector('[role=option]'))?.focus();
  });
  root.querySelector('.sd-focus-voice-menu-close')?.addEventListener('click',dismissVoiceMenu);
  menu?.addEventListener('close',()=>{speaker.setAttribute('aria-expanded','false');});
  menu?.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismissVoiceMenu();}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      const rows=[...menu.querySelectorAll('[role=option]')],at=rows.indexOf(event.target);
      if(at<0)return;event.preventDefault();event.stopPropagation();
      rows[event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,at+(event.key==='ArrowDown'?1:-1)))]?.focus();
    }
  });
  menu?.addEventListener('click',event=>{
    if(event.target!==menu)return;const rect=menu.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dismissVoiceMenu();
  });
  root.querySelectorAll('[data-focus-voice-key]').forEach(option=>option.addEventListener('click',()=>{
    if(!voiceMenuCurrent()){dismissVoiceMenu();return;}
    dismissVoiceMenu();voice.bind(option.dataset.focusVoiceKey,displayedVoice.characterKey,displayedVoice.providerId);ui.render();
  }));
  root.querySelector('.sd-focus-voice-relation')?.addEventListener('change', (event) => {
    const f = state();
    const binding = voice.context(f);
    if (!binding.chatKey || f.status !== 'idle' || !voicePageCurrent()) return;
    f.voiceRelationByChat[binding.chatKey] = relations[event.target.value] ? event.target.value : 'neutral';
    ui.save();
  });
  root.querySelectorAll('.sd-focus-voice-mode').forEach((button) => button.addEventListener('click', () => {
    if(state().status!=='idle')return;
    state().voiceMode = button.dataset.focusVoiceMode === 'scene' ? 'scene' : 'custom';
    voice.cancel({clearCues:true});
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
