// A small stand-in window shown the moment an entry is clicked, while the real panel's code, styles or
// account data are still on their way. It owns no feature state: the caller passes the promise that
// settles when the real panel is on screen (or failed), and the stand-in removes itself then.
// Fast opens never flash it: nothing is inserted before `delay` ms have passed.
const LAYER_ID = 'qianmu-pending-panel';

export function showPendingPanel({ document = globalThis.document, title = '', label = '正在载入…', until, delay = 90,
  themeClass = '', mount, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!document?.body) return () => {};
  let layer = null, closed = false;
  const timer = schedule(() => {
    if (closed) return;
    document.getElementById(LAYER_ID)?.remove();
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    if (themeClass) layer.className = themeClass;
    const card = document.createElement('section');
    card.className = 'qm-pending-card'; card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite');
    if (title) { const head = document.createElement('b'); head.className = 'qm-pending-title'; head.textContent = title; card.append(head); }
    const line = document.createElement('div'); line.className = 'qm-pending-line';
    const dot = document.createElement('span'); dot.className = 'qm-pending-dot'; dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.textContent = label;
    line.append(dot, text); card.append(line); layer.append(card);
    document.body.append(layer);
    try { mount?.(layer); } catch { /* theming is decorative */ }
  }, delay);
  const close = () => { if (closed) return; closed = true; cancel(timer); layer?.remove(); layer = null; };
  if (until && typeof until.then === 'function') until.then(close, close);
  return close;
}
