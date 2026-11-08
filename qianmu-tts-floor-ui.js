// DOM-only adapter: no extraction, audio, storage or host-message writes.
// Keep the legacy toolbar/line restoration lifecycle; remove only owned UI
// when an existing node now belongs to a user floor.
export function scanTtsFloor(mesEl, {isCharacter, barClass, bindBoundary, applyIcons, autoRestore}, options = {}) {
  if (!mesEl?.matches?.('.mes')) return;
  if (!isCharacter(mesEl)) {
    mesEl.querySelectorAll(`.sd-tts-toolbar, .sd-tts-inline, .${barClass}`).forEach(node => node.remove());
    delete mesEl.dataset.sdTtsHooked;
    return;
  }
  const textEl = mesEl.querySelector('.mes_text');
  if (!textEl) return;
  if (!mesEl.querySelector('.sd-tts-toolbar')) {
    mesEl.dataset.sdTtsHooked = '1';
    const toolbar = mesEl.ownerDocument.createElement('div');
    toolbar.className = 'sd-tts-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="sd-tts-trigger" title="提取/展开台词列表" aria-label="提取台词"><i class="fa-solid fa-clapperboard" data-qm-icon="voice-lines"></i></button>
      <button type="button" class="sd-tts-reextract" title="重新提取台词列表（仅刷新文本）" aria-label="重新提取台词"><i class="fa-solid fa-film" data-qm-icon="voice-reextract"></i></button>
      <button type="button" class="sd-tts-regenall" title="重新生成本条全部语音" aria-label="重生本条全部语音" hidden><i class="fa-solid fa-rotate" data-qm-icon="voice-regenerate-all"></i></button>
      <button type="button" class="sd-tts-playall" title="连续播放本条全部台词" aria-label="连续播放" hidden><i class="fa-regular fa-circle-play"></i></button>`;
    textEl.insertAdjacentElement('afterend', toolbar);
    applyIcons(toolbar);
  }
  bindBoundary(mesEl.querySelector('.sd-tts-toolbar'));
  const bar = mesEl.querySelector(`.${barClass}`);
  if (bar) bindBoundary(bar);
  followTextOrder(textEl, [mesEl.querySelector('.sd-tts-toolbar'), bar]);
  if (options.forceProvider && bar?.dataset.loaded === '1') delete bar.dataset.provider;
  autoRestore(mesEl);
  if (options.expand) {
    const restored = mesEl.querySelector(`.${barClass}[data-loaded="1"]`);
    if (restored) {
      restored.hidden = false;
      mesEl.querySelectorAll('.sd-tts-inline').forEach(node => { node.hidden = false; });
    }
  }
}

// Themes may lay .mes_block out as flex/grid and pull .mes_text down with
// `order` or an explicit grid row/area. Our nodes would then auto-place in
// the gap between header and text. Mirror the text's order and start our
// row right after the text's row so DOM sequence decides placement again.
export function gridRowAfter(start, end) {
  const s = String(start || 'auto').trim();
  const e = String(end || 'auto').trim();
  if (/^-?\d+$/.test(e)) return e;
  const span = /^span\s+(\d+)$/.exec(e);
  if (/^-?\d+$/.test(s)) return String(Number(s) + (span ? Number(span[1]) : 1));
  if (/^[a-zA-Z_][\w-]*$/.test(s) && s !== 'auto') return `${s}-end`;
  return '';
}

export function followTextOrder(textEl, nodes) {
  const view = textEl?.ownerDocument?.defaultView;
  if (!view?.getComputedStyle) return;
  const cs = view.getComputedStyle(textEl);
  const order = cs.order || '0';
  const row = gridRowAfter(cs.gridRowStart, cs.gridRowEnd);
  let next = row;
  for (const node of nodes) {
    if (!node?.style) continue;
    if (order === '0') node.style.removeProperty('order');
    else node.style.setProperty('order', order, 'important');
    if (next) node.style.setProperty('grid-row-start', next, 'important');
    else node.style.removeProperty('grid-row-start');
    if (next && /^-?\d+$/.test(next)) next = String(Number(next) + 1);
    else if (next) next = '';
  }
}
