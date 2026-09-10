// Owns only the completion/preview sound, never character speech or narration.
export function createFocusSoundPlayer({Audio, requestAnimationFrame, cancelAnimationFrame, getState, presets, onChange, notify}) {
  let media = null, sequence = 0, previewMode = false, frame = 0;
  function source(state = getState()) {
    if (state.soundSource === 'builtin') return presets[state.soundPreset]?.url || presets.silverBell.url;
    if (state.soundSource === 'url' && /^https?:\/\//i.test(state.soundUrl)) return state.soundUrl;
    return '';
  }

  function stopFrame() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function runFrame() {
    stopFrame();
    const tick = () => {
      onChange();
      if (previewMode && media && !media.paused && !media.ended) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
      }
    };
    tick();
  }

  function attachEvents(audio) {
    if (!audio || audio.dataset?.qianmuEvents === '1') return;
    audio.dataset.qianmuEvents = '1';
    for (const eventName of ['loadedmetadata', 'durationchange', 'seeked', 'pause', 'play']) {
      audio.addEventListener(eventName, onChange);
    }
    audio.addEventListener('ended', () => {
      if (audio !== media) return;
      if (previewMode) {
        previewMode = false;
        try { audio.currentTime = 0; } catch (_) {}
      }
      stopFrame();
      onChange();
    });
  }

  function ensure(src) {
    if (!media || media.dataset?.source !== src) {
      reset();
      media = new Audio(src);
      media.preload = 'auto';
      media.dataset.source = src;
      attachEvents(media);
    }
    return media;
  }

  function reset() {
    sequence += 1;
    try { media?.pause?.(); } catch (_) {}
    previewMode = false;
    stopFrame();
    media = null;
    onChange();
  }

  function prime() {
    const f = getState();
    if (!f.soundEnabled) return;
    try {
      const src = source(f);
      if (!src) return;
      const audio = ensure(src);
      const mediaSeq = ++sequence;
      const isCurrent = () => mediaSeq === sequence && audio === media;
      // 开始/预览均来自用户手势；静音预热能提高移动端稍后播放的成功率，但浏览器仍可能在锁屏后暂停网页。
      const previousVolume = audio.volume;
      audio.volume = 0;
      const primed = audio.play();
      if (primed?.then) void primed.then(() => {
        if (!isCurrent()) return;
        audio.pause();
        audio.currentTime = 0;
        audio.volume = previousVolume || 1;
      }).catch(() => { if (isCurrent()) audio.volume = previousVolume || 1; });
    } catch (_) {}
  }

  async function play({ preview = false } = {}) {
    const f = getState();
    if (!f.soundEnabled && !preview) return false;
    let isCurrent = () => true;
    try {
      const src = source(f);
      if (!src) {
        if (preview) notify('请先填写可用的音频外链。', 'warning');
        return false;
      }
      const sameSource = media?.dataset?.source === src;
      const audio = ensure(src);
      const mediaSeq = ++sequence;
      isCurrent = () => mediaSeq === sequence && audio === media;
      audio.volume = 1;
      if (preview && sameSource && previewMode && !audio.ended) {
        if (audio.paused) {
          await audio.play();
          if (!isCurrent()) return false;
          runFrame();
        } else {
          audio.pause();
          stopFrame();
          onChange();
        }
        return true;
      }
      previewMode = preview;
      audio.currentTime = 0;
      await audio.play();
      if (!isCurrent()) return false;
      if (preview) runFrame();
      else onChange();
      return true;
    } catch (_) {
      if (!isCurrent()) return false;
      if (preview) {
        previewMode = false;
        stopFrame();
        onChange();
      }
      if (preview) notify('提示音无法播放，请检查音频地址或浏览器媒体权限。', 'warning');
      return false;
    }
  }
  function snapshot() {
    return {hasMedia: Boolean(media), duration: media?.duration, currentTime: media?.currentTime, previewMode,
      playing: Boolean(previewMode && media && !media.paused && !media.ended)};
  }
  return Object.freeze({prime, play, reset, snapshot});
}
