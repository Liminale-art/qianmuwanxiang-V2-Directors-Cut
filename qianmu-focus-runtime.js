// Own only timer/listener lifetimes. Session state, media and persistence stay with callers.
export function createFocusClockRuntime({ document, window, setInterval, clearInterval, tick, getState, prepare }) {
  let ticker = null, syncing = false;
  function visibilitySync() {
    if (document.visibilityState === 'visible') tick();
  }
  function stop() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    document.removeEventListener('visibilitychange', visibilitySync);
    window.removeEventListener('pageshow', tick);
    window.removeEventListener('focus', tick);
  }
  function start({ prepareVoice = true } = {}) {
    if (syncing) return;
    syncing = true;
    try {
      stop();
      tick();
      const state = getState();
      if (state.status !== 'running') return;
      ticker = setInterval(tick, 500);
      document.addEventListener('visibilitychange', visibilitySync, { passive: true });
      window.addEventListener('pageshow', tick, { passive: true });
      window.addEventListener('focus', tick, { passive: true });
      if (prepareVoice) prepare(state);
    } finally {
      syncing = false;
    }
  }
  return Object.freeze({ start, stop, get active() { return ticker !== null; }, get syncing() { return syncing; } });
}
