const escape = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const button = (action, label, disabled = false) =>
  `<button type="button" class="sd-btn" data-historical-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;

function targetLabel(target) {
  if (!target || typeof target !== 'object') return '当前聊天';
  return target.kind === 'group' ? `群聊 ${target.chatId}` : `角色聊天 ${target.chatId}`;
}

function renderImages(preview) {
  const rows = Array.isArray(preview?.images) ? preview.images : [];
  if (!rows.length) return '<p>没有可核对的原图。</p>';
  const counts = rows.reduce((result, row) => {
    const state = String(row?.state || 'unknown');
    result[state] = (result[state] || 0) + 1;
    return result;
  }, {});
  const state = { present: '已存在', missing: '待恢复', conflict: '冲突', unknown: '待核对' };
  return `<p>原图 ${rows.length} 张 · ${Object.entries(counts).map(([key, value]) => `${state[key] || key} ${value}`).join(' · ')}</p>
    ${rows.filter(row => row?.state !== 'present').slice(0, 12).map(row => `<p><small>${escape(row.state || 'unknown')} · ${escape(row.receipt?.url || row.url || '原图记录')}</small></p>`).join('')}`;
}

export function renderHistoricalRestoreReview(view) {
  const preview = view?.preview;
  const hostWriteReady = view?.hostWriteReady !== false;
  const ready = Boolean(preview?.ready && view.dependenciesAccepted && hostWriteReady);
  const excluded = Array.isArray(preview?.excluded) ? preview.excluded : [];
  const result = view?.result;
  return `<header><b id="qm-historical-restore-title">恢复历史聊天分镜</b><button type="button" class="sd-icon-btn" data-historical-action="close" title="关闭恢复页面" aria-label="关闭恢复页面"><i data-qm-icon="qm-regular-x"></i></button></header>
    <main data-historical-scroll><fieldset ${view?.busy || result ? 'disabled' : ''}>
      <section><p class="sd-bundle-file">${escape(view?.fileName || '历史原件联包')}</p>
        <p>此原件只面向当前已定位的聊天，恢复其中的静帧原图、相册记录、人物草稿与可验证的历史配方引用。不会恢复正文、视频、全局设置、共享库、外部模型或节点资产，也不会启动生成任务。</p>
        ${preview ? `<p>${escape(targetLabel(preview.target))} · ${preview.mode === 'recovery' ? '存在待核对记录，将续接原保存' : '新的恢复核对'} · 原件指纹 ${escape(preview.fingerprint)}</p>` : '<p>正在读取原件并核对当前聊天来源…</p>'}
      </section>
      ${preview ? `<section><h3>本次范围</h3>${renderImages(preview)}<p>配方 ${Number(preview.recipes || 0)} 条 · 当前聊天资料为三项字段受保护合并（画面、相册、人物草稿）。</p>
        <p>明确不恢复：${excluded.map(item => escape(item)).join('、') || '外部依赖'}</p></section>` : ''}
      ${preview?.journal ? `<section><h3>已有待核对记录</h3><p>阶段 ${escape(preview.journal.phase)} · 记录修订 ${Number(preview.journal.revision || 0)}。本次核对会绑定同一原件指纹，不会自动换用其他聊天或旧记录。</p></section>` : ''}
      ${preview && !hostWriteReady ? '<section><p>当前 ST 宿主未提供可确认的聊天保存接口；仍可只读核对原件，但恢复按钮保持关闭，不会修改聊天资料。</p></section>' : ''}
      ${preview?.ready === false ? '<section><p>当前原件、聊天或原图未通过完整核对，恢复按钮保持关闭；请保留原文件并先处理冲突。</p></section>' : ''}
      ${preview ? `<label class="sd-bundle-review"><input type="checkbox" data-historical-dependencies ${view.dependenciesAccepted ? 'checked' : ''}>我已理解以上恢复范围，确认外部依赖不会随本原件恢复；仅在当前准确聊天中继续。</label>` : ''}
    </fieldset></main>
    <footer><p role="status">${escape(view?.notice || (view?.busy ? '正在核对；关闭不会写入未确认内容。' : '预览不会修改正文或聊天资料。'))}</p><div>${result ? button('close', '关闭') : `${button('preview', '重新核对', view?.busy)}${button('restore', '确认恢复', view?.busy || !ready)}`}</div></footer>`;
}

export function openHistoricalRestoreReview({ parent, fileName, connect, paintIcons = () => {} }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sd-bundle-dialog sd-historical-restore-dialog';
  dialog.setAttribute('aria-labelledby', 'qm-historical-restore-title');
  const view = { fileName, preview: null, busy: true, notice: '', result: null, dependenciesAccepted: false };
  let session = null;
  let closed = false;
  let resolve;
  const finished = new Promise(done => { resolve = done; });

  function close() {
    if (closed) return;
    closed = true;
    try { session?.close?.(); } finally {
      session = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(view.result);
    }
  }

  function active() {
    if (closed) return false;
    if (!dialog.isConnected) { close(); return false; }
    return true;
  }

  function draw() {
    if (!active()) return;
    const scroll = dialog.querySelector('[data-historical-scroll]')?.scrollTop || 0;
    dialog.innerHTML = renderHistoricalRestoreReview(view);
    paintIcons(dialog);
    const main = dialog.querySelector('[data-historical-scroll]');
    if (main) main.scrollTop = scroll;
  }

  async function request(method, ...args) {
    if (!active() || !session) throw new Error('恢复页面已关闭');
    const value = await session[method](...args);
    if (!active()) throw new Error('恢复页面已关闭');
    return value;
  }

  async function run(action) {
    if (!active() || view.busy || view.result || !session) return;
    view.busy = true;
    view.notice = '';
    draw();
    try {
      if (action === 'preview') {
        view.dependenciesAccepted = false;
        view.preview = await request('preview');
      } else if (action === 'restore') {
        view.result = await request('restore', { confirmed: true, expectedDigest: view.preview?.digest, dependenciesAccepted: view.dependenciesAccepted });
        view.notice = '历史聊天原件已恢复并完成最终核对；外部依赖仍需在当前环境单独配置。';
        session?.close?.();
        session = null;
      }
    } catch (error) {
      if (active()) {
        view.notice = error?.message || '历史原件未恢复，请重新核对';
        if (action === 'restore') view.dependenciesAccepted = false;
      }
    } finally {
      view.busy = false;
      draw();
    }
  }

  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('change', event => {
    if (!active() || view.busy || view.result) return;
    if (event.target.matches('[data-historical-dependencies]')) {
      view.dependenciesAccepted = event.target.checked;
      draw();
    }
  });
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-historical-action]')?.dataset.historicalAction;
    if (action === 'close') { close(); return; }
    if (action === 'preview' || action === 'restore') void run(action);
  });

  parent.appendChild(dialog);
  draw();
  try { dialog.showModal(); } catch (error) { close(); throw error; }
  void (async () => {
    try {
      session = await connect();
      if (!active()) { session?.close?.(); session = null; return; }
      view.preview = await request('preview');
    } catch (error) {
      if (active()) view.notice = error?.message || '原件核对失败，请关闭后重选文件';
    } finally {
      view.busy = false;
      draw();
    }
  })();
  return Object.freeze({ finished, close, get isOpen() { return !closed && dialog.isConnected; } });
}
