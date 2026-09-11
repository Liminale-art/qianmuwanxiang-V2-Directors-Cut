// Owns only drawer DOM; closing does not cancel media or change records.
export function createFocusVoiceDrawer({document, getModal, rowsForView, format, voice, favorites, download, notify, now}) {
  let currentPortal = null;
  function close() {
    currentPortal?.remove();
    currentPortal = null;
  }

  function open() {
    close();
    const modal = getModal();
    if (!modal) return;
    const rows = rowsForView();
    if (!rows.length) { notify('还没有可重听的陪伴语音。', 'info'); return; }
    const portal = document.createElement('div');
    portal.className = 'sd-focus-voice-drawer-portal';
    portal.innerHTML = `<button type="button" class="sd-focus-voice-drawer-backdrop" aria-label="关闭陪伴语音"></button>
      <section class="sd-focus-voice-drawer" role="dialog" aria-modal="true" aria-label="陪伴语音">
        <header><div><h3>陪伴语音</h3><small>重听或整理这一程留下的声音</small></div><button type="button" class="sd-icon-btn sd-focus-voice-drawer-close" title="关闭" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button></header>
        <div class="sd-focus-voice-drawer-list">${rows.map((cue) => `<article class="sd-focus-cue" data-cue-id="${format.escape(cue.id)}">
          <button type="button" class="sd-focus-cue-play" title="重听" aria-label="重听"><i class="fa-solid fa-play"></i></button>
          <button type="button" class="sd-focus-cue-main" title="重听这句"><b>${format.escape(cue.speaker || '角色')}</b><span>${format.escape(cue.text || '')}</span><small>${format.escape(cue.task || '专注')} · ${format.escape(format.date(cue.sourceTime || now()))}</small></button>
          <button type="button" class="sd-icon-btn sd-focus-cue-more" title="更多操作" aria-label="更多操作" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
          <div class="sd-focus-cue-tools" hidden>
            ${cue.library ? '<small>编辑请前往专注语音库</small>' : `<button type="button" class="sd-icon-btn sd-focus-cue-regen" title="重新生成" aria-label="重新生成"><i class="fa-solid fa-rotate"></i></button>
            <button type="button" class="sd-icon-btn sd-focus-cue-fav" data-cue-id="${format.escape(cue.id)}" title="收藏" aria-label="收藏" aria-pressed="false"><i class="fa-regular fa-star"></i></button>`}
            <button type="button" class="sd-icon-btn sd-focus-cue-download" title="下载" aria-label="下载"><i class="fa-solid fa-download"></i></button>
          </div>
        </article>`).join('')}</div>
      </section>`;
    modal.appendChild(portal);
    format.icons(portal);
    currentPortal = portal;
    const cueFor = (target) => rows.find((cue) => cue.id === target.closest('.sd-focus-cue')?.dataset.cueId);
    portal.querySelector('.sd-focus-voice-drawer-backdrop')?.addEventListener('click', close);
    portal.querySelector('.sd-focus-voice-drawer-close')?.addEventListener('click', close);
    portal.querySelectorAll('.sd-focus-cue-play, .sd-focus-cue-main').forEach((button) => button.addEventListener('click', async (event) => {
      const cue = cueFor(event.currentTarget);
      if (!cue) return;
      if (!await voice.play(cue)) notify(cue.library ? '语音原件已变化或不可播放，请到专注语音库核对。' : '音频缓存已过期，可以使用重新生成。', 'warning');
    }));
    portal.querySelectorAll('.sd-focus-cue-more').forEach((button) => button.addEventListener('click', () => {
      const item = button.closest('.sd-focus-cue');
      const tools = item?.querySelector('.sd-focus-cue-tools');
      const next = Boolean(tools?.hidden);
      portal.querySelectorAll('.sd-focus-cue-tools').forEach((row) => { row.hidden = true; });
      portal.querySelectorAll('.sd-focus-cue-more').forEach((entry) => entry.setAttribute('aria-expanded', 'false'));
      if (tools) tools.hidden = !next;
      button.setAttribute('aria-expanded', next ? 'true' : 'false');
    }));
    portal.querySelectorAll('.sd-focus-cue-regen').forEach((button) => button.addEventListener('click', async (event) => {
      const cue = cueFor(event.currentTarget);
      if (!cue) return;
      button.disabled = true;
      const icon = button.querySelector('i'); format.iconClass(icon, 'fa-solid fa-spinner fa-spin');
      await voice.regenerate(cue);
      if (currentPortal === portal && portal.isConnected) open();
    }));
    portal.querySelectorAll('.sd-focus-cue-fav').forEach((button) => button.addEventListener('click', async (event) => {
      const cue = cueFor(event.currentTarget);
      if (cue) await favorites.toggle(cue, button);
    }));
    portal.querySelectorAll('.sd-focus-cue-download').forEach((button) => button.addEventListener('click', async (event) => {
      const cue = cueFor(event.currentTarget);
      if (!cue) return;
      const blob = await voice.blob(cue);
      if (!blob) { notify('音频缓存已过期，请先重新生成。', 'warning'); return; }
      download.save(blob, `${download.fileBase(cue)}.${download.safeName(cue.format, 'mp3') || 'mp3'}`);
      notify('已下载。', 'success');
    }));
    void favorites.sync(portal);
  }
  return Object.freeze({open, close});
}
