// Transient view inputs only: no settings ownership, persistence, timers or host access.
import {focusClockFormat} from './qianmu-focus-time.js';

export function renderFocusClockView({f, remaining, total, phase, strongLocked, today, week, books, weekStart, voiceContext, providerLabel, voiceCharacters, voiceDrawerCount, FOCUS_CLOCK_PHASES, FOCUS_CLOCK_RELATIONS, FOCUS_CLOCK_VOICE_FREQUENCIES, FOCUS_CLOCK_SOUND_PRESETS}, htmlEscape) {
  const progress = Math.max(0, Math.min(1, 1 - remaining / total));
  const statusLabel = f.status === 'running' ? `${phase.label}中` : f.status === 'paused' ? '停在此刻' : '准备开始';
  const mainLabel = strongLocked ? '已上锁' : f.status === 'running' ? '暂停' : f.status === 'paused' ? '继续' : '开始';
  const mainIcon = f.status === 'running' ? 'fa-pause' : 'fa-play';
  const todayMinutes = Math.round(today.reduce((sum, item) => sum + Math.max(0, Number(item.durationMs) || 0), 0) / 60000);
  const goalProgress = Math.max(0, Math.min(100, today.length / f.dailyGoal * 100));
  const locked = f.status === 'running' || f.status === 'paused';
  const linkedBook = books.find((book) => book.id === f.bookId) || null;
  const weekMax = Math.max(1, ...week.days.map((day) => day.minutes));
  const weekBars = week.days.map((day, index) => `<div class="sd-focus-week-day"><span class="sd-focus-week-value">${day.minutes || ''}</span><span class="sd-focus-week-bar"><i style="height:${day.minutes ? Math.max(8, day.minutes / weekMax * 100) : 3}%"></i></span><small>${['一', '二', '三', '四', '五', '六', '日'][index]}</small></div>`).join('');
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
  const weekRange = `${weekStart.getMonth() + 1}.${weekStart.getDate()}–${weekEnd.getMonth() + 1}.${weekEnd.getDate()}`;
  const voiceAvailable = voiceContext.hasCharacter && !!voiceContext.voice;
  const showVoiceSetupTip = voiceContext.hasCharacter && !voiceContext.voice && !f.voiceSetupTipSeen;
  const voiceStatus = !voiceContext.hasCharacter
    ? (f.activity === 'reading' ? '请先选择伴读书友。' : '请选择角色，或进入角色聊天。')
    : voiceContext.voice ? `音色跟随 ${voiceContext.characterName} · ${providerLabel}`
      : showVoiceSetupTip ? '选择一次音色后按角色保存；可使用音色库或手动沿用当前聊天音色。'
        : voiceContext.enabled ? '请选择音色。' : '';
  const voiceSpeakerOptions = '<option value="">选择音色</option>' + voiceContext.options.map(row => `<option value="${htmlEscape(row.key)}" ${row.key === voiceContext.selected ? 'selected' : ''}>${htmlEscape(row.label)}</option>`).join('');
  const voiceCharacterOptions = '<option value="">跟随当前聊天</option>' + voiceCharacters.map(ch => `<option value="${htmlEscape(ch.avatar)}" ${ch.avatar === f.voiceCharacterAvatar ? 'selected' : ''}>${htmlEscape(ch.name)}</option>`).join('')
    + (f.voiceCharacterAvatar && !voiceCharacters.some(ch => ch.avatar === f.voiceCharacterAvatar) ? '<option selected disabled>原角色已不存在，请重选</option>' : '');
  const voiceRelationOptions = Object.entries(FOCUS_CLOCK_RELATIONS).map(([id, item]) => `<option value="${id}" ${voiceContext.relation === id ? 'selected' : ''}>${item.label}</option>`).join('');
  const voiceConfig = `
    <div class="sd-focus-voice-config">
      <div class="sd-focus-voice-grid">
        <label><span>${f.activity === 'reading' ? '书友' : '角色'}</span>${f.activity === 'reading' ? `<input class="text_pole" value="${htmlEscape(voiceContext.characterName)}" readonly>` : `<select class="text_pole sd-focus-voice-character" ${locked ? 'disabled' : ''}>${voiceCharacterOptions}</select>`}</label>
        <label><span>音色</span><select class="text_pole sd-focus-voice-speaker" ${locked || !voiceContext.hasCharacter ? 'disabled' : ''}>${voiceSpeakerOptions}</select></label>
      </div>
      ${voiceContext.enabled && voiceAvailable ? `<label><span>关系</span><select class="text_pole sd-focus-voice-relation" ${locked ? 'disabled' : ''}>${voiceRelationOptions}</select></label>
      <div class="sd-focus-voice-row"><span>话语方式</span><div class="sd-focus-segments">${[['stock', '轻量话语'], ['scene', '情景生成']].map(([id, label]) => `<button type="button" class="sd-focus-voice-mode ${f.voiceMode === id ? 'active' : ''}" data-focus-voice-mode="${id}" ${locked ? 'disabled' : ''}>${label}</button>`).join('')}</div></div>
      <div class="sd-focus-voice-row"><span>长时陪伴频率</span><div class="sd-focus-segments">${Object.entries(FOCUS_CLOCK_VOICE_FREQUENCIES).map(([id, item]) => `<button type="button" class="sd-focus-voice-frequency ${f.voiceFrequency === id ? 'active' : ''}" data-focus-voice-frequency="${id}" ${locked ? 'disabled' : ''}>${item.label} ${Math.round(item.chance * 100)}%</button>`).join('')}</div></div>
      ` : ''}
    </div>`;
  const soundPresetOptions = Object.entries(FOCUS_CLOCK_SOUND_PRESETS).map(([id, item]) => `<option value="${id}" ${f.soundPreset === id ? 'selected' : ''}>${htmlEscape(item.label)}</option>`).join('');
  const soundConfig = f.soundEnabled ? `
    <div class="sd-focus-sound-config">
      <div class="sd-focus-sound-sources" role="tablist" aria-label="完成提示音来源">
        ${[['builtin', '内置'], ['url', '自定义']].map(([id, label]) => `<button type="button" class="sd-focus-sound-source ${f.soundSource === id ? 'active' : ''}" data-focus-sound-source="${id}">${label}</button>`).join('')}
      </div>
      <div class="sd-focus-sound-control">
        ${f.soundSource === 'builtin'
          ? `<select class="text_pole sd-focus-sound-preset" aria-label="内置提示音">${soundPresetOptions}</select>`
          : `<input class="text_pole sd-focus-sound-url" type="url" inputmode="url" maxlength="2048" placeholder="https://…/提示音.mp3" value="${htmlEscape(f.soundUrl)}">`}
        <button type="button" class="sd-icon-btn sd-focus-sound-preview" title="试听提示音" aria-label="试听提示音"><i class="fa-solid fa-play"></i></button>
      </div>
    </div>` : '';
  const historyRows = today.length ? today.map((item) => {
    const time = new Date(item.finishedAt || item.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const minutes = Math.max(1, Math.round((Number(item.durationMs) || 0) / 60000));
    const readingProgress = item.activity === 'reading' && Number.isFinite(Number(item.progressStart)) && Number.isFinite(Number(item.progressEnd))
      ? ` · ${Math.round(Number(item.progressStart))}% → ${Math.round(Number(item.progressEnd))}%` : '';
    return `<article class="sd-focus-history-row"><span><i class="fa-solid ${item.activity === 'reading' ? 'fa-book-open' : 'fa-check'}"></i></span><div><b>${htmlEscape(item.task || '未命名专注')}</b><small>${htmlEscape(time)} · ${minutes} 分钟${readingProgress}</small></div></article>`;
  }).join('') : '<div class="sd-focus-empty">今天还没有完成记录。</div>';
  const lastCompletion = f.history.find((item) => item.id === f.lastCompletionId) || null;
  const finaleProgress = lastCompletion?.activity === 'reading' && Number.isFinite(Number(lastCompletion.progressStart)) && Number.isFinite(Number(lastCompletion.progressEnd))
    ? `${Math.round(Number(lastCompletion.progressStart))}% → ${Math.round(Number(lastCompletion.progressEnd))}%` : '';
  const finaleMarkup = lastCompletion ? `<section class="sd-card sd-focus-finale-card">
      <div class="sd-card-title-row"><h3>这一程</h3><button type="button" class="sd-icon-btn sd-focus-finale-close" title="收起片尾卡" aria-label="收起片尾卡"><i class="fa-solid fa-xmark"></i></button></div>
      <strong>${htmlEscape(lastCompletion.task || '未命名专注')}</strong>
      <div class="sd-focus-finale-meta"><span>${Math.max(1, Math.round((Number(lastCompletion.durationMs) || 0) / 60000))} 分钟</span>${finaleProgress ? `<span>${finaleProgress}</span>` : ''}</div>
      ${lastCompletion.voiceText ? `<button type="button" class="sd-focus-finale-voice" title="打开陪伴语音"><span>${htmlEscape(lastCompletion.voiceText)}</span><i class="fa-solid fa-headphones-simple"></i></button>` : ''}
      <input class="text_pole sd-focus-finale-note" maxlength="100" placeholder="留一句给此刻的自己（可选）" value="${htmlEscape(lastCompletion.note || '')}">
    </section>` : '';
  return `
    <section class="sd-card sd-focus-hero">
      <div class="sd-focus-phase-tabs" role="tablist" aria-label="计时阶段">
        ${Object.entries(FOCUS_CLOCK_PHASES).map(([id, item]) => `<button type="button" class="sd-focus-phase ${f.phase === id ? 'active' : ''}" data-focus-phase="${id}" ${locked ? 'disabled' : ''}><i class="fa-solid ${item.icon}"></i><span>${item.label}</span></button>`).join('')}
      </div>
      <div class="sd-focus-ring" role="progressbar" aria-label="${htmlEscape(phase.label)}进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress * 100)}" style="--sd-focus-angle:${(progress * 360).toFixed(2)}deg">
        <div class="sd-focus-ring-inner"><small>${htmlEscape(statusLabel)}</small><strong class="sd-focus-time">${focusClockFormat(remaining)}</strong><span>${htmlEscape(phase.label)}</span></div>
      </div>
      <div class="sd-focus-activity-tabs">
        <button type="button" class="sd-focus-activity ${f.activity === 'task' ? 'active' : ''}" data-focus-activity="task" ${locked ? 'disabled' : ''}><i class="fa-solid fa-list-check"></i>专注任务</button>
        <button type="button" class="sd-focus-activity ${f.activity === 'reading' ? 'active' : ''}" data-focus-activity="reading" ${locked ? 'disabled' : ''}><i class="fa-solid fa-book-open-reader"></i>伴读</button>
      </div>
      ${f.activity === 'reading' ? `<div class="sd-focus-reading-link"><label><span>选择书籍</span><select class="text_pole sd-focus-book" ${locked ? 'disabled' : ''}>${books.length ? books.map((book) => `<option value="${htmlEscape(book.id)}" ${book.id === f.bookId ? 'selected' : ''}>${htmlEscape(book.title || '未命名书籍')}</option>`).join('') : '<option value="">书架还是空的</option>'}</select></label>${linkedBook ? `<button type="button" class="sd-btn sd-focus-open-reading"><i class="fa-solid fa-book-open"></i>进入阅读</button>` : ''}</div>` : `<label class="sd-focus-task-label"><span>这一程想完成什么</span><input class="text_pole sd-focus-task" maxlength="120" placeholder="写下一个清楚、够小的目标" value="${htmlEscape(f.task)}" ${f.status === 'running' ? 'disabled' : ''}></label>`}
      <div class="sd-focus-actions">
        <button type="button" class="sd-btn sd-primary sd-focus-main" ${strongLocked ? 'disabled' : ''}><i class="fa-solid ${mainIcon}"></i>${mainLabel}</button>
        <button type="button" class="sd-btn sd-focus-reset" ${strongLocked ? 'disabled' : ''}><i class="fa-solid fa-arrow-rotate-left"></i>${f.status === 'idle' ? '重置' : '结束本轮'}</button>
        <button type="button" class="sd-icon-btn sd-focus-lock ${strongLocked ? 'active' : ''}" title="${strongLocked ? '到时自动解锁' : '上锁并开始专注'}" aria-label="${strongLocked ? '专注已上锁' : '上锁并开始专注'}" ${f.status !== 'idle' || f.phase !== 'focus' ? 'disabled' : ''}><i class="fa-solid" data-qm-icon="qm-regular-lock-keyhole"></i></button>
      </div>
    </section>
    ${finaleMarkup}
    <section class="sd-card sd-focus-today-card">
      <div class="sd-card-title-row"><h3>今日</h3><span class="sd-focus-today-count">${today.length} / ${f.dailyGoal} 段</span></div>
      <div class="sd-focus-today-stats"><div><b>${todayMinutes}</b><small>专注分钟</small></div><div><b>${today.length}</b><small>完成段数</small></div><div><b>${f.focusCycle}</b><small>当前循环</small></div></div>
      <div class="sd-focus-goal-track" aria-label="今日目标进度"><span style="width:${goalProgress.toFixed(1)}%"></span></div>
    </section>
    <section class="sd-card sd-focus-week-card">
      <div class="sd-card-title-row"><h3>本周记录</h3><span class="sd-focus-week-head"><small>${weekRange}</small><button type="button" class="sd-icon-btn sd-focus-week-export" title="导出本周记录图片" aria-label="导出本周记录图片" ${week.history.length ? '' : 'disabled'}><i class="fa-solid fa-image"></i></button></span></div>
      <div class="sd-focus-week-summary"><span><b>${week.minutes}</b><small>分钟</small></span><span><b>${week.count}</b><small>段</small></span><span><b>${week.readingMinutes}</b><small>伴读</small></span></div>
      <div class="sd-focus-week-chart" aria-label="本周每日专注分钟">${weekBars}</div>
    </section>
    <section class="sd-card">
      <details class="sd-focus-settings" data-acc="focus-clock-settings">
        <summary><span>周期设置</span><span class="sd-focus-settings-head"><label class="checkbox_label sd-focus-auto-next-wrap"><input type="checkbox" class="sd-focus-auto-next" ${f.autoStartNext ? 'checked' : ''}> 自动开始下一阶段</label><i class="fa-solid fa-chevron-down"></i></span></summary>
        <div class="sd-focus-setting-grid">
          <label><span>专注</span><div><input class="text_pole sd-focus-setting" data-focus-setting="focusMinutes" type="number" min="1" max="240" value="${f.focusMinutes}" ${locked ? 'disabled' : ''}><small>分钟</small></div></label>
          <label><span>小憩</span><div><input class="text_pole sd-focus-setting" data-focus-setting="shortBreakMinutes" type="number" min="1" max="60" value="${f.shortBreakMinutes}" ${locked ? 'disabled' : ''}><small>分钟</small></div></label>
          <label><span>长休</span><div><input class="text_pole sd-focus-setting" data-focus-setting="longBreakMinutes" type="number" min="1" max="120" value="${f.longBreakMinutes}" ${locked ? 'disabled' : ''}><small>分钟</small></div></label>
          <label><span>每几段长休</span><div><input class="text_pole sd-focus-setting" data-focus-setting="longBreakEvery" type="number" min="1" max="12" value="${f.longBreakEvery}" ${locked ? 'disabled' : ''}><small>段</small></div></label>
          <label><span>今日目标</span><div><input class="text_pole sd-focus-setting" data-focus-setting="dailyGoal" type="number" min="1" max="24" value="${f.dailyGoal}"><small>段</small></div></label>
        </div>
      </details>
    </section>
    <section class="sd-card sd-focus-sound-card">
      <div class="sd-card-title-row"><h3>完成提示音</h3><label class="checkbox_label"><input type="checkbox" class="sd-focus-sound" ${f.soundEnabled ? 'checked' : ''}>${f.soundEnabled ? '已开启' : '已关闭'}</label></div>
      ${soundConfig}
    </section>
    <section class="sd-card sd-focus-voice-card">
      <div class="sd-card-title-row"><h3>角色语音</h3><span class="sd-focus-voice-head-actions"><button type="button" class="sd-icon-btn sd-focus-voice-drawer-open" title="陪伴语音" aria-label="打开陪伴语音" ${voiceDrawerCount ? '' : 'hidden'}><i class="fa-solid fa-headphones-simple"></i><span>${voiceDrawerCount}</span></button><label class="checkbox_label"><input type="checkbox" class="sd-focus-voice-enabled" ${voiceContext.enabled ? 'checked' : ''} ${voiceContext.hasCharacter || voiceContext.enabled ? '' : 'disabled'}>${voiceContext.enabled ? '已开启' : '已关闭'}</label></span></div>
      ${voiceStatus ? `<div class="sd-focus-voice-status ${showVoiceSetupTip ? 'sd-focus-voice-setup-tip' : ''}"><i class="fa-solid ${voiceAvailable ? 'fa-link' : 'fa-circle-info'}"></i><span>${htmlEscape(voiceStatus)}</span></div>` : ''}
      ${voiceConfig}
    </section>
    <section class="sd-card sd-focus-history-card">
      <div class="sd-card-title-row"><h3>今日记录</h3>${today.length ? '<button type="button" class="sd-icon-btn sd-danger sd-focus-clear-history" title="清空今日记录" aria-label="清空今日记录"><i class="fa-solid fa-trash-can"></i></button>' : ''}</div>
      <div class="sd-focus-history">${historyRows}</div>
    </section>`;
}

export function updateFocusClockView(document, {f, remaining, total}, voiceCountForView) {
  const progress = Math.max(0, Math.min(1, 1 - remaining / total));
  document.querySelectorAll('.sd-focus-time').forEach((el) => { el.textContent = focusClockFormat(remaining); });
  document.querySelectorAll('.sd-reader-focus-mini').forEach((el) => { el.textContent = f.status !== 'idle' ? focusClockFormat(remaining) : '专注'; });
  document.querySelectorAll('.sd-focus-ring').forEach((el) => {
    el.style.setProperty('--sd-focus-angle', `${(progress * 360).toFixed(2)}deg`);
    el.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  });
  const voiceCount = voiceCountForView();
  document.querySelectorAll('.sd-focus-voice-drawer-open').forEach((button) => {
    button.hidden = voiceCount === 0;
    const count = button.querySelector('span');
    if (count) count.textContent = String(voiceCount);
  });
}
