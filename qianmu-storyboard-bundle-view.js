const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const button = (action, text, disabled = false) => `<button type="button" class="sd-btn" data-bundle-action="${action}" ${disabled ? 'disabled' : ''}>${text}</button>`;
export function renderStoryboardBundleReview(view) {
  const p = view.preview, offset = view.page * 24, conflicts = p?.conflicts || [], bindings = p?.bindingReview || [];
  const pages = Math.max(1, Math.ceil(Math.max(conflicts.length, bindings.length) / 24));
  const ready = p?.ready && !p.needsRecheck && view.environmentReviewed && (!bindings.length || view.bindingsReviewed);
  return `<header><b id="qm-bundle-title">恢复分镜资源联包</b><button type="button" class="sd-icon-btn" data-bundle-action="close" title="关闭恢复页面" aria-label="关闭恢复页面"><i data-qm-icon="qm-regular-x"></i></button></header>
    <main data-bundle-scroll><fieldset ${view.busy || view.result ? 'disabled' : ''}>
    <section><p class="sd-bundle-file">${escape(view.fileName)}</p><p>恢复当前聊天成片、配置、Vibe 原文件、完整工作流／候选历史及角色库。只补缺件，不覆盖原图；不含模型文件或 API 授权。跨环境身份重绑定尚未开放，请先保留旧环境。</p>
    ${p ? `<p>成片 ${p.summary.images} · Vibe ${p.summary.vibeFiles} · 工作流 ${p.summary.workflows.count}（${p.summary.workflows.versions} 版） · 候选 ${p.summary.pools.count} · 角色 ${p.summary.characters.count}</p>
    <p>${p.sourceLabelsMatched ? 'ST 来源标识一致；完整服务器副本也会相同，角色与聊天仍须人工核对。' : '此包无 ST 来源标识，仅凭同名账户与聊天不能确认身份，请人工核对原环境。'}</p>
    ${p.summary.legacyVibeOriginals ? `<p>已包含 ${p.summary.legacyVibeOriginals} 个旧 Vibe 地址的本地原图；原配方及强度不变。</p>` : ''}
    ${p.summary.legacyVibeUrls > (p.summary.legacyVibeOriginals || 0) ? `<p>另有 ${p.summary.legacyVibeUrls - (p.summary.legacyVibeOriginals || 0)} 个旧 Vibe 地址未包含原图，请另行保全。</p>` : ''}
    <p>档案／绑定：新增 ${p.characterSummary.added} · 替换 ${p.characterSummary.replaced} · 保留 ${p.characterSummary.kept}</p>
    ${p.configuration?.orphaned ? `<p>${p.configuration.orphaned} 张成片无法确认正文位置，将保留在阅片室，不自动挂入楼层。</p>` : ''}
    ${!p.needsRecheck && p.planDigest ? `<p>原图 ${p.images.length} 处 · 缺件 ${p.images.filter(row => row.state === 'missing').length} · 冲突 ${p.images.filter(row => row.state === 'conflict').length}</p>` : '<p>选项只是草稿，选好后请核对原件。</p>'}
    ${p.record ? `<p>上次资源核对：${escape(({prepared:'已确认',originals:'原图',workflows:'工作流',pools:'候选',metadata:'角色',vibes:'Vibe',verified:'原件已核对，配置另行确认'})[p.record.phase] || p.record.phase)}。续接仍会逐项核对。</p>` : ''}` : ''}</section>
    ${conflicts.length ? `<section><h3>逐项选择 · ${conflicts.length}</h3>${conflicts.slice(offset, offset + 24).map((row, index) => `<label class="sd-bundle-choice"><span>${escape(row.kind === 'archive' ? `${row.localName} v${row.localVersion} → ${row.incomingName} v${row.incomingVersion}` : `${row.category.toUpperCase()} · ${row.subjectKey} · ${row.chatKey || '默认绑定'} · ${row.localArchiveId || '不绑定'} → ${row.incomingArchiveId || '不绑定'}`)}</span><select class="text_pole" data-bundle-choice="${offset + index}"><option value="" ${!row.choice?'selected':''}>请选择</option><option value="local" ${row.choice==='local'?'selected':''}>保留本机</option><option value="incoming" ${row.choice==='incoming'?'selected':''}>使用备份</option></select></label>`).join('')}</section>` : ''}
    ${bindings.length ? `<section><h3>原身份与聊天绑定 · ${bindings.length}</h3>${bindings.slice(offset, offset + 24).map(row => `<p>${escape(row.category.toUpperCase())} · ${escape(row.subjectKey)}<br>${escape(row.scope === 'chat' ? row.chatKey : '角色默认')} → ${escape(row.archiveId || '明确不绑定')}</p>`).join('')}</section>` : ''}
    ${pages > 1 ? `<nav>${button('previous','上一页',view.page === 0)}<span>${view.page + 1} / ${pages}</span>${button('next','下一页',view.page >= pages - 1)}</nav>` : ''}
    ${p?.images?.some(row => row.state === 'conflict') ? `<section><h3>原图冲突，未覆盖</h3>${p.images.filter(row => row.state === 'conflict').slice(0,24).map(row => `<p>${escape(row.url)}</p>`).join('')}<p>请先在旧环境保全并处理冲突后重新核对。</p></section>` : ''}
    <label class="sd-bundle-review"><input type="checkbox" data-bundle-environment ${view.environmentReviewed?'checked':''}>我确认来自当前 ST 原环境和原聊天；同名不代表同一身份，不确定时取消。</label>
    ${bindings.length ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-bindings ${view.bindingsReviewed?'checked':''}>我已核对全部 ${bindings.length} 处原身份与聊天标识。</label>` : ''}
    </fieldset></main><footer><p role="status">${escape(view.notice || (view.busy ? '正在后台核对；关闭会中止后续步骤，已保存部分仍保留。' : '不会启动生成任务。'))}</p><div>${view.result ? button('close','关闭并稍后核对导入') : `${button('preview',p?.needsRecheck?'核对选择与原件':'重新核对',view.busy)}${button('restore','确认恢复',view.busy || !ready)}`}</div></footer>`;
}

export function openStoryboardBundleReview({ parent, fileName, connect, paintIcons = () => {} }) {
  const dialog = document.createElement('dialog'); dialog.className = 'sd-bundle-dialog'; dialog.setAttribute('aria-labelledby','qm-bundle-title');
  const view = { fileName, page: 0, preview: null, busy: true, notice: '', result: null, environmentReviewed: false, bindingsReviewed: false };
  let session = null, closed = false, choices = {}, focusChoice = null, resolve; const finished = new Promise(done => resolve = done);
  function close() { if (closed) return; closed = true; session?.close(); if (dialog.open) dialog.close(); dialog.remove(); resolve(view.result); }
  function draw() {
    if (closed) return;
    const scroll = dialog.querySelector('[data-bundle-scroll]')?.scrollTop || 0;
    const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.bundleChoice : undefined;
    if (focused !== undefined) focusChoice = focused;
    dialog.innerHTML = renderStoryboardBundleReview(view); paintIcons(dialog);
    const main = dialog.querySelector('[data-bundle-scroll]'); main.scrollTop = scroll;
    if (!view.busy && focusChoice !== null) dialog.querySelector(`[data-bundle-choice="${Number(focusChoice)}"]`)?.focus({ preventScroll: true });
  }
  async function run(action) {
    if (view.busy || !session || closed) return;
    view.busy = true; view.notice = ''; draw();
    try {
      if (action === 'preview') { view.environmentReviewed = false; view.bindingsReviewed = false; view.preview = await session.preview(choices); }
      if (action === 'choose') view.preview = await session.choose(choices);
      if (action === 'restore') {
        view.result = await session.restore(view.preview, { confirmed: true, environmentReviewed: view.environmentReviewed, bindingsReviewed: view.bindingsReviewed });
        session.close(); // Release the source Blob, decoded documents and worker DB connections while the result stays readable.
        view.notice = '原件已核对，配置已应用。请刷新后点击“核对导入”确认保存；历史生成任务不会续跑。';
      }
    } catch (error) {
      view.notice = error?.message || '恢复未确认，请核对原包';
      if (view.preview) view.preview = { ...view.preview, ready: false, needsRecheck: true, planDigest: '' };
      view.environmentReviewed = false; view.bindingsReviewed = false;
      if (/过期/.test(view.notice)) { choices = {}; view.preview = null; view.page = 0; view.notice += '，已清空过期选择，请重新核对。'; }
    } finally { view.busy = false; draw(); }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-bundle-action]')?.dataset.bundleAction;
    if (action === 'close') { close(); return; } if (view.busy) return;
    if (action === 'next' || action === 'previous') { focusChoice = null; view.page = Math.max(0, view.page + (action === 'next' ? 1 : -1)); draw(); dialog.querySelector('[data-bundle-scroll]').scrollTop = 0; }
    else if (['preview','restore'].includes(action)) void run(action);
  });
  dialog.addEventListener('change', event => {
    if (view.busy || closed) return; const field = event.target;
    if (field.matches('[data-bundle-environment]')) { focusChoice = null; view.environmentReviewed = field.checked; draw(); }
    else if (field.matches('[data-bundle-bindings]')) { focusChoice = null; view.bindingsReviewed = field.checked; draw(); }
    else if (field.matches('[data-bundle-choice]')) {
      const row = view.preview?.conflicts[Number(field.dataset.bundleChoice)]; if (!row) return;
      focusChoice = field.dataset.bundleChoice;
      if (field.value) choices[row.key] = field.value; else delete choices[row.key];
      view.environmentReviewed = false; view.bindingsReviewed = false; view.preview = { ...view.preview, ready: false, needsRecheck: true, planDigest: '' }; void run('choose');
    }
  });
  parent.appendChild(dialog); draw();
  try { dialog.showModal(); } catch (error) { close(); throw error; }
  void (async () => {
    try { session = await connect(); if (closed) { session.close(); return; } view.preview = await session.preview(); }
    catch (error) { view.notice = error?.message || '原包核对失败，请关闭后重选文件'; }
    finally { view.busy = false; draw(); }
  })();
  return Object.freeze({ finished, close, get isOpen() { return !closed && dialog.isConnected; } });
}
