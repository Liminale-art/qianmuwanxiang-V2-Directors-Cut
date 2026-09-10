// Focus locks are application navigation boundaries, not an OS/browser security mechanism.
export const FOCUS_LOCK_MAX_MS = 4 * 60 * 60 * 1000;

export function inspectFocusLock(state, owner, now = Date.now()) {
  const lock = state?.lock;
  if (!lock || lock.owner !== owner || !owner) return { active: false, reason: 'absent' };
  if (lock.version !== 1 || !['task', 'reading'].includes(lock.activity)
      || !Number.isFinite(lock.startedAt) || !Number.isFinite(lock.endsAt)
      || lock.endsAt <= lock.startedAt || lock.endsAt - lock.startedAt > FOCUS_LOCK_MAX_MS
      || lock.startedAt > now + 60000 || lock.endsAt > now + FOCUS_LOCK_MAX_MS
      || state.status !== 'running' || state.phase !== 'focus'
      || lock.token !== state.sessionToken || lock.endsAt !== state.endsAt
      || (lock.activity === 'reading' && (!lock.bookId || lock.bookId !== state.sessionBookId))) {
    return { active: false, reason: 'invalid' };
  }
  if (lock.endsAt <= now) return { active: false, reason: 'expired' };
  return { active: true, lock };
}

// Only mounted during a lock. Preserve pre-existing inert state and release on disposal/error.
// Native inert handles pointer, keyboard focus, and accessibility without a second modal system.
export function createFocusLockGuard({ document, isActive, roots, blocked, hasSurface = () => true, onBlocked, onUnavailable }) {
  const managed = new Set();
  const view = document.defaultView;
  let observer, disposed = false;
  const releaseNodes = () => { for (const node of managed) node.inert = false; managed.clear(); };
  const dispose = () => {
    disposed = true; observer?.disconnect(); releaseNodes();
    for (const type of ['click', 'pointerdown', 'keydown', 'focusin']) document.removeEventListener(type, guard, true);
  };
  const sync = () => {
    if (disposed) return;
    try {
      if (!isActive()) { dispose(); return; }
      const allowed = roots().filter(node => node?.isConnected);
      if (!allowed.length || !hasSurface()) { dispose(); onUnavailable(); return; }
      const forbidden = new Set(blocked());
      for (const child of document.body.children) {
        if (['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName)) continue;
        if (!allowed.some(root => child === root || child.contains(root))) forbidden.add(child);
      }
      for (const node of managed) if (!forbidden.has(node)) { node.inert = false; managed.delete(node); }
      for (const node of forbidden) if (!node.inert) { node.inert = true; managed.add(node); }
    } catch (_) { dispose(); onUnavailable(); }
  };
  const guard = event => {
    if (!isActive()) { dispose(); return; }
    const target = event.target;
    const denied = blocked().some(node => node === target || node.contains(target));
    const inside = roots().some(node => node === target || node.contains(target));
    if (!inside || denied) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click' || event.type === 'keydown') onBlocked();
    }
  };
  if (!('inert' in document.createElement('div'))) { onUnavailable(); return { sync() {}, dispose }; }
  observer = new view.MutationObserver(sync);
  observer.observe(document.body, { childList: true });
  for (const type of ['click', 'pointerdown', 'keydown', 'focusin']) document.addEventListener(type, guard, true);
  sync();
  return { sync, dispose };
}
