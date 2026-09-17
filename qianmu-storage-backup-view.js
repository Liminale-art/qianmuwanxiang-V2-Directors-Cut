// A detached/hidden chooser is cancellation, never an implicit confirmation.
// Keep listeners only while a chooser is pending; the caller owns the cleanup lock.
export function bindStorageCleanupLifetime(layer, modal, resolve) {
  const document = layer.ownerDocument, view = document.defaultView;
  const card = modal?.querySelector('.sd-storage-card');
  let settled = false;
  const observer = new view.MutationObserver(() => {
    if (!layer.isConnected || !modal?.isConnected || !modal.classList.contains('open') || (card && !card.isConnected)) finish(null);
  });
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
  };
  const onPageHide = () => finish(null);
  const finish = value => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    document.removeEventListener('keydown', onKey, true);
    view.removeEventListener('pagehide', onPageHide);
    layer.remove();
    resolve(value);
  };
  observer.observe(document.body, {childList:true, subtree:true});
  if (modal) observer.observe(modal, {attributes:true, attributeFilter:['class']});
  document.addEventListener('keydown', onKey, true);
  view.addEventListener('pagehide', onPageHide);
  layer.querySelector('.sd-storage-backup-home')?.addEventListener('click', () => {
    finish(null);
    const backup = modal?.querySelector('.sd-storage-backup-section');
    if (backup) { backup.open = true; backup.scrollIntoView({block:'nearest'}); backup.querySelector('summary')?.focus({preventScroll:true}); }
  });
  if (!layer.isConnected || !modal?.isConnected || !modal.classList.contains('open')) finish(null);
  return finish;
}

// Keep view replacement independent of application state and storage mutations.
export function replaceStorageManagementCard(current, html, {icons, bind}) {
  const document = current.ownerDocument;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const next = template.content.firstElementChild;
  if (!next) return false;
  for (const section of current.querySelectorAll('details[data-storage-section]')) {
    const target = [...next.querySelectorAll('details[data-storage-section]')].find(item=>item.dataset.storageSection===section.dataset.storageSection);
    if (target) target.open = section.open;
  }
  // Retain live file inputs and their listeners across quota refreshes.
  const backup = current.querySelector('.sd-storage-backup-section');
  if (backup) {
    const summary = next.querySelector('.sd-storage-notes-summary');
    if (summary) backup.querySelector('.sd-storage-notes-summary')?.replaceWith(summary);
    next.querySelector('.sd-storage-backup-section')?.replaceWith(backup);
  }
  const refreshFocused = document.activeElement === current.querySelector('.sd-storage-refresh');
  current.replaceWith(next);
  icons(next);
  bind(next);
  if (refreshFocused) next.querySelector('.sd-storage-refresh')?.focus({ preventScroll: true });
  return true;
}

// Existing module packages only; this is not an all-device snapshot or sync protocol.
export function renderStorageBackupSection(notesStorage, formatBytes = value => `${value} B`) {
  const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const notesInfo = notesStorage?.status === 'ready'
    ? `当前账户本机已保存 ${count(notesStorage.count)} 条（常驻 ${count(notesStorage.pinned)} 条）· ${escape(formatBytes(count(notesStorage.bytes)))} 内容及同步记录估算。不含其他设备尚未同步的内容，也不是 VPS 占用。`
    : notesStorage?.status === 'unavailable' ? `账户便笺暂不可读取，当前统计未包含此部分。${escape(notesStorage.error)}` : '便笺备份仅包含当前 ST 账户在本机已保存的内容。';
  return `<details class="sd-storage-disclosure sd-storage-backup-section" data-storage-section="backups">
    <summary>备份与恢复<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></summary>
    <div class="sd-storage-disclosure-body">
      <div class="sd-storage-backup-row"><span>专注语音原件</span><button type="button" class="sd-btn sd-storage-focus-library">选择备份／恢复／清理</button></div>
      <p class="sd-storage-scope">按内容分别备份。配置不包含素材原件；导入配置会覆盖现有设置。分镜资源包的范围在导出前核对，不代表全部聊天备份。</p>
      <div class="sd-storage-backup-row"><span>配置</span><button type="button" class="sd-btn sd-export-config">导出</button><button type="button" class="sd-btn sd-import-config">导入</button><input type="file" class="sd-import-config-file" accept="application/json,.json" hidden></div>
      <button type="button" class="sd-btn sd-undo-config" hidden>撤回本次恢复</button>
      ${[['storyboard','分镜资源','.qmb,application/json,.json'],['reader','伴读资料','application/json,.json'],['favorites','语音收藏','application/json,.json'],['notes','便笺','application/json,.json']].map(([key,label,accept])=>`<div class="sd-storage-backup-row"><span>${label}</span><button type="button" class="sd-btn" data-storage-export="${key}" aria-label="导出${label}">导出</button><button type="button" class="sd-btn" data-storage-pick="${key}" aria-label="导入${label}">导入</button><input type="file" data-storage-import="${key}" accept="${accept}" hidden></div>`).join('')}
      <p class="sd-storage-scope sd-storage-notes-summary" role="status">${notesInfo} 所有便笺都保存，常驻不影响备份范围。</p>
      <p class="sd-storage-scope">旧版便笺原件仍在本浏览器；请从便笺面板的“旧便笺”查看、导出或确认归属。旧版清理不会删除账户便笺。</p>
    </div>
  </details>`;
}
