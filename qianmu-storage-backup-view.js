export const STORAGE_CATEGORY_LABELS=Object.freeze({images:'图片',vibes:'参考素材',characters:'角色资料',audio:'音频',video:'影片',reader:'伴读资料',notes:'便笺',collections:'收藏待存',assistant:'场外特助',logs:'日志与记录',cache:'临时缓存',settings:'设置与预设',chat:'当前聊天数据',other:'其他'});
export const STORAGE_CATEGORY_COLORS=Object.freeze({images:'#5aa9ff',vibes:'#b29bc9',characters:'#c985b1',audio:'#ff9f43',video:'#6f8fff',reader:'#9b7cff',notes:'#f2c94c',collections:'#75b6ab',assistant:'#ce9f72',logs:'#ff647c',cache:'#3dc7c9',settings:'#65c466',chat:'#8d94a6',other:'#747b88'});

// Pure accounting snapshots extracted from the entry without changing contents.
export function storageDiagnosticSnapshot(settings){
  const storyboard=settings?.imagegen||{};
  return {apiLogs:Array.isArray(settings?.logHistory)?settings.logHistory:[],storyboardLogs:Array.isArray(storyboard.logs)?storyboard.logs:[],storyboardPipelineLogs:Array.isArray(storyboard.pipelineLogs)?storyboard.pipelineLogs:[]};
}
export function storageSettingsSnapshotWithoutDiagnostics(settings){
  const storyboard=settings?.imagegen||{};
  return {...settings,logHistory:[],logOpenState:{},imagegen:{...storyboard,logs:[],pipelineLogs:[]}};
}

export function collectionCleanupOptions(data){
  const collection=data?.collectionStorage,pending=collection?.pending,assistant=data?.assistantStorage;
  return [...(collection?.status==='ready'?[{id:'__collections__',label:'正文收藏原件（当前账户 · 服务器）',bytes:collection.count>0?collection.bytes:0,count:collection.count,
    risk:['不可恢复 · 先确认范围；不删聊天，同步回执保留',true]}]:[]),...(pending?.status==='ready'?[{id:'__collection_pending__',label:'收藏待存（当前账户 · 本机）',bytes:pending.bytes,count:pending.count,risk:['不可恢复 · 先备份；不删除或取消服务器保存',true]}]:[]),...(assistant?.native?.status==='ready'&&assistant.native.heads?.count>0?[{id:'__assistant_native__',label:'场外特助会话（当前账户 · ST）',bytes:assistant.native.heads.bytes+assistant.native.current.bytes,count:assistant.native.heads.count,risk:['逐项查阅/备份/清空会话；保留旧版本，不回收磁盘空间',true]}]:[]),...(assistant?.status==='ready'&&assistant.count>0?[{id:'__assistant__',label:'场外特助旧副本（当前账户 · 本机）',bytes:assistant.bytes,count:assistant.count,risk:['不可恢复 · 请先复制留存；不删除ST记录，版本标记保留',true]}]:[])];
}

export function renderAssistantStorageSummary(assistant,formatStorageBytes,htmlEscape){
  const native=assistant?.native;
  return `<p class="sd-storage-scope sd-storage-assistant-native-summary" role="status">场外特助 · ${native?.status==='ready'?htmlEscape(formatStorageBytes(native.total.bytes)):'暂未读取'}</p>`;
}

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
    // Replace inventory-dependent rows, not live package inputs or their listeners.
    for (const selector of ['.sd-storage-resource-list', '.sd-storage-manage-actions']) {
      const fresh = next.querySelector(selector), previous = backup.querySelector(selector);
      if (fresh && previous) previous.replaceWith(fresh);
    }
    next.querySelector('.sd-storage-backup-section')?.replaceWith(backup);
  }
  const refreshFocused = document.activeElement === current.querySelector('.sd-storage-refresh');
  current.replaceWith(next);
  icons(next);
  bind(next);
  if (refreshFocused) next.querySelector('.sd-storage-refresh')?.focus({ preventScroll: true });
  return true;
}

// Bind existing package actions; rendering and quota refresh never start a transfer.
export function bindStoragePackageActions(root, {exports, imports}) {
  root.querySelectorAll('[data-storage-export]').forEach(button=>button.addEventListener('click',()=>{if(Object.hasOwn(exports,button.dataset.storageExport))void exports[button.dataset.storageExport](button);}));
  root.querySelectorAll('[data-storage-pick]').forEach(button=>button.addEventListener('click',()=>{
    root.querySelector(`input[data-storage-import="${button.dataset.storagePick}"]`)?.click();
  }));
  root.querySelectorAll('input[data-storage-import]').forEach(input=>input.addEventListener('change',async event=>{
    const file=input.files?.[0];if(!file)return;
    try{if(Object.hasOwn(imports,input.dataset.storageImport))await imports[input.dataset.storageImport](file,input,event);}finally{input.value='';}
  }));
}

// Existing module packages only; this is not an all-device snapshot or sync protocol.
export function renderStorageBackupSection(notesStorage, formatBytes = value => `${value} B`, {data, ready = false} = {}) {
  return `<details class="sd-storage-disclosure sd-storage-backup-section" data-storage-section="backups">
    <summary>备份与清理<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></summary>
    <div class="sd-storage-disclosure-body">
      <div class="sd-storage-backup-row"><span>配置</span><button type="button" class="sd-btn sd-export-config">导出</button><button type="button" class="sd-btn sd-import-config">导入</button><input type="file" class="sd-import-config-file" accept="application/json,.json" hidden></div>
      <button type="button" class="sd-btn sd-undo-config" hidden>撤回本次恢复</button>
      ${[['notes','便笺','application/json,.json'],['favorites','语音收藏','application/json,.json'],['audio','音频缓存','application/json,.json'],['collections','正文收藏','application/json,.json'],['storyboard','分镜资源','.qmb,application/json,.json'],['reader','伴读资料','application/json,.json']].map(([key,label,accept])=>storagePackageRow(key,label,accept)).join('')}
      <div class="sd-storage-backup-row"><span>场外特助会话</span><button type="button" class="sd-btn sd-storage-assistant-library">备份 / 恢复</button></div>
      <p class="sd-storage-scope sd-storage-gallery-check-status" role="status" hidden></p>
      <div class="sd-storage-resource-list">${data ? renderStorageResourceRows(data,formatBytes) : ''}</div>
      <div class="sd-storage-actions sd-storage-manage-actions">${data ? `<button type="button" class="sd-btn sd-primary sd-storage-clean" ${ready && (data.manageableBytes > 0 || collectionCleanupOptions(data).some(row=>row.bytes>0)) ? '' : 'disabled'}>选择清理项目</button><button type="button" class="sd-btn sd-storage-chat-clean" ${ready && data.idb?.chatScopes?.length ? '' : 'disabled'}>按聊天清理缓存</button>` : ''}</div>
    </div>
  </details>`;
}

function storagePackageRow(key,label,accept) {
  return `<div class="sd-storage-backup-row"><span>${label}</span><button type="button" class="sd-btn" data-storage-export="${key}" aria-label="导出${label}">导出</button><button type="button" class="sd-btn" data-storage-pick="${key}" aria-label="导入${label}">导入</button><input type="file" data-storage-import="${key}" accept="${accept}" hidden></div>`;
}

function renderStorageResourceRows(data,formatBytes) {
  const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const known=(record,value)=>record?.status==='ready'&&Number.isFinite(value)?escape(formatBytes(value)):'暂未读取';
  const rows=[
    ['正文收藏',known(data.collectionStorage,data.collectionStorage?.bytes)],
    ['角色资料',known(data.characterStorage,data.characterStorage?.documents?.bytes)],
    ['Vibe 素材',known(data.vibeStorage,(data.vibeStorage?.assets?.bytes??NaN)+(data.vibeStorage?.previews?.bytes??NaN))],
    ['工作流',known(data.comfyStorage?.workflows,data.comfyStorage?.workflows?.bytes)],
    ['工作流方案',known(data.comfyStorage?.pools,data.comfyStorage?.pools?.bytes)],
    ['场外特助',known(data.assistantStorage?.native,data.assistantStorage?.native?.total?.bytes)],
    ['图片配置',known(data.recipeStorage,data.recipeStorage?.bytes)],
  ];
  // Internal receipts and retained files remain protected by the cleanup
  // controller. Routine inventory is not a second navigation menu.
  const recipe=data.recipeStorage,full=recipe?.status==='ready'&&(recipe.bytes>=recipe.limitBytes||recipe.files>=recipe.limitFiles);
  return `<details class="sd-storage-disclosure" data-storage-section="sizes"><summary>查看资料占用</summary><div class="sd-storage-disclosure-body">${rows.map(([label,value])=>`<div class="sd-storage-backup-row"><span>${label}</span><span>${value}</span></div>`).join('')}${full?'<p role="status">图片配置存储已满，请先备份再清理。</p>':''}</div></details>`;
}
