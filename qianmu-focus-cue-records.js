// Keeps cue record identity and legacy favorite contracts; persistent storage stays with the host.
export function createFocusCueRecords({getState, safeName, formatStamp, now, storage, audio, folder, setButton, notify}) {
  function fileBase(cue) {
    const speaker = safeName(cue?.speaker, '角色').slice(0, 28) || '角色';
    const task = safeName(cue?.task, '专注').slice(0, 30) || '专注';
    const stamp = formatStamp(cue?.sourceTime || now());
    const seq = String((Number(cue?.lineIndex) || 0) + 1).padStart(2, '0');
    return `${speaker}-${task}-${stamp}-${seq}`.slice(0, 110);
  }

  function rows(state = getState()) {
    const rows = [];
    for (const cue of state.sessionVoiceCues || []) {
      if (cue?.played && cue.cacheKey) rows.push(cue);
    }
    for (const entry of state.history || []) {
      for (const cue of Array.isArray(entry?.voiceCues) ? entry.voiceCues : []) {
        if (!cue?.cacheKey) continue;
        if (!cue.task) cue.task = entry.task || '专注';
        rows.push(cue);
      }
    }
    const seen = new Set();
    return rows.filter((cue) => {
      const id = cue.id || cue.cacheKey;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, 16);
  }

  async function syncFavorites(portal) {
    if (!portal || !storage.available()) return;
    for (const button of portal.querySelectorAll('.sd-focus-cue-fav')) {
      const cue = rows().find((item) => item.id === button.dataset.cueId);
      if (!cue) continue;
      const active = await storage.has(`fav:${cue.cacheKey}`).catch(() => false);
      setButton(button, active);
    }
  }

  async function toggleFavorite(cue, button) {
    if (!storage.available()) { notify('当前环境不支持本地收藏。', 'warning'); return; }
    // Regeneration can replace the live cue during either read; keep this click's audio and metadata together.
    cue = { ...cue };
    const id = `fav:${cue.cacheKey}`;
    try {
      if (await storage.has(id)) {
        await storage.remove(id);
        setButton(button, false);
        notify('已取消收藏。', 'success');
        return;
      }
      const blob = await audio(cue);
      if (!blob) throw new Error('音频缓存已过期，请先重新生成');
      await storage.add(id, blob, {
        speaker: cue.speaker || '角色', text: cue.text || '',
        format: cue.format || 'mp3', provider: cue.providerId || '',
        folder: folder(cue.speaker || ''), fileNameBase: fileBase(cue),
        chatKey: cue.chatKey || '', sourceTime: cue.sourceTime || now(), lineIndex: Number(cue.lineIndex) || 0,
        source: 'focus',
      }, cue.text || '');
      setButton(button, true);
      notify('已收藏。', 'success');
    } catch (error) { notify(`收藏失败：${error?.message || error}`, 'error'); }
  }
  return Object.freeze({fileBase, rows, syncFavorites, toggleFavorite});
}
