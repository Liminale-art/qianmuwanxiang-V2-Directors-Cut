const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const button = (action, title, disabled = false) => `<button type="button" class="sd-btn" data-link-action="${action}" ${disabled ? 'disabled' : ''}>${title}</button>`;

export function openStoryboardLinkReview({ parent, session, apply, paintIcons = () => {} }) {
  const dialog = document.createElement('dialog'); dialog.className = 'sd-bundle-dialog sd-link-review-dialog'; dialog.setAttribute('aria-labelledby','qm-link-review-title');
  const returnFocus = document.activeElement;
  let step = 'floors', page = 0, choice = null, busy = false, closed = false, result = null, notice = '', resolve;
  const finished = new Promise(done => resolve = done);
  function close() { if (closed) return; closed = true; window.removeEventListener('pagehide', close); if (dialog.open) dialog.close(); dialog.remove(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); if (!busy) resolve(result); }
  function draw() {
    if (closed) return;
    let data = { rows: [], pages: 1, page: 0 };
    try { if (!result) data = step === 'floors' ? session.floors(page) : session.paragraphs(page); }
    catch (error) { notice = error.message; choice = null; step = 'floors'; }
    page = data.page;
    dialog.innerHTML = `<header><b id="qm-link-review-title">核对正文位置</b><button type="button" class="sd-icon-btn" data-link-action="close" aria-label="关闭核对页面"><i data-qm-icon="qm-regular-x"></i></button></header>
      <main><p>只调整此图的正文落点，不重新生成，不改原配方。原来源与定位记录保留。</p>
      ${result ? '' : `<fieldset ${busy ? 'disabled' : ''}><h3>${step === 'floors' ? '1 · 选择当前聊天的正文楼层' : `2 · 选择第 ${data.floor + 1} 层的插入段落`}</h3>
      ${data.rows.map(row => step === 'floors' ? `<button type="button" class="sd-link-row" data-link-floor="${row.floor}"><b>第 ${row.floor + 1} 层 · ${escape(row.name)}</b><span>${escape(row.preview)}</span></button>` : `<label class="sd-link-row"><input type="radio" name="qm-link-paragraph" data-link-paragraph="${row.index}" ${choice?.index === row.index ? 'checked' : ''}><span><b>段落 ${row.index + 1}</b><span class="sd-link-paragraph">${escape(row.text)}</span></span></label>`).join('') || '<p>暂无可选择正文。</p>'}
      <nav>${button('previous','上一页',!page)}<span>${page + 1} / ${data.pages}</span>${button('next','下一页',page + 1 >= data.pages)}</nav></fieldset>`}
      </main><footer><p role="status">${escape(notice || (choice ? `确认后将插在第 ${choice.floor + 1} 层、第 ${choice.index + 1} 段末尾。` : '请先选层，再明确选择段落；不会自动猜测。'))}</p><div>${result ? button('close','完成') : `${button(step === 'floors' ? 'close' : 'floors',step === 'floors' ? '取消' : '重新选层',busy)}${button('confirm','确认挂回',busy || !choice)}`}</div></footer>`;
    paintIcons(dialog);
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', close);
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-link-action]')?.dataset.linkAction;
    if (action === 'close') { close(); return; } if (busy || result || closed) return;
    try {
      const floor = event.target.closest('[data-link-floor]');
      if (floor) { session.selectFloor(Number(floor.dataset.linkFloor)); step = 'paragraphs'; page = 0; choice = null; notice = ''; draw(); return; }
      if (!action) return;
      if (action === 'floors') { step = 'floors'; page = 0; choice = null; notice = ''; }
      if (action === 'previous' || action === 'next') page += action === 'next' ? 1 : -1;
      if (action === 'confirm' && choice) {
        busy = true; notice = '正在保存定位；关闭会停止后续步骤，已写入部分需核对。'; draw();
        void (async () => {
          try { result = await apply(); notice = '正文位置已应用。请刷新后使用“核对导入”确认保存；可从该记录恢复原定位。'; }
          catch (error) { notice = error?.message || '保存未确认，请核对导入记录'; choice = null; }
          finally { busy = false; if (closed) resolve(result); else draw(); }
        })(); return;
      }
      draw(); dialog.querySelector('main').scrollTop = 0;
    } catch (error) { notice = error.message; choice = null; draw(); }
  });
  dialog.addEventListener('change', event => {
    if (busy || closed || !event.target.matches('[data-link-paragraph]')) return;
    try { choice = session.selectParagraph(Number(event.target.dataset.linkParagraph)); notice = ''; }
    catch (error) { notice = error.message; choice = null; }
    const scroll = dialog.querySelector('main').scrollTop; draw(); dialog.querySelector('main').scrollTop = scroll;
    dialog.querySelector(`[data-link-paragraph="${choice?.index}"]`)?.focus({ preventScroll: true });
  });
  parent.append(dialog); draw(); window.addEventListener('pagehide', close);
  try { dialog.showModal(); } catch (error) { close(); throw error; }
  return Object.freeze({ finished, close, get isOpen() { return !closed && dialog.isConnected; } });
}
