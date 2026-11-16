export const STORAGE_CATEGORY_LABELS=Object.freeze({images:'图片',vibes:'参考素材',characters:'角色资料',audio:'音频',video:'影片',reader:'伴读资料',notes:'便笺',collections:'正文收藏',assistant:'场外特助',logs:'日志与记录',cache:'临时缓存',settings:'设置与预设',chat:'当前聊天数据',other:'其他'});
export const STORAGE_CATEGORY_COLORS=Object.freeze({images:'#5aa9ff',vibes:'#b29bc9',characters:'#c985b1',audio:'#ff9f43',video:'#6f8fff',reader:'#9b7cff',notes:'#f2c94c',collections:'#75bfa6',assistant:'#ce9f72',logs:'#ff647c',cache:'#3dc7c9',settings:'#65c466',chat:'#8d94a6',other:'#747b88'});

export async function runStorageInventoryJobs(jobs,onProgress,isCurrent){
  const values=Array(jobs.length);let next=0,done=0,failure;
  const report=count=>{try{onProgress?.(count,jobs.length+1);}catch{}};
  report(0);
  await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
    while(next<jobs.length&&!failure&&isCurrent()){
      const slot=next++;
      try{values[slot]=await jobs[slot]();}catch(error){failure=error;}
      report(++done);
    }
  }));
  if(failure)throw failure;
  if(!isCurrent())throw new Error('储存页面已变化，请重新盘点');
  return values;
}

export function storageDiagnosticSnapshot(settings){
  const storyboard=settings?.imagegen||{};
  return {apiLogs:Array.isArray(settings?.logHistory)?settings.logHistory:[],storyboardLogs:Array.isArray(storyboard.logs)?storyboard.logs:[],storyboardPipelineLogs:Array.isArray(storyboard.pipelineLogs)?storyboard.pipelineLogs:[]};
}
export function storageSettingsSnapshotWithoutDiagnostics(settings){
  const storyboard=settings?.imagegen||{};
  return {...settings,logHistory:[],logOpenState:{},imagegen:{...storyboard,logs:[],pipelineLogs:[]}};
}

export function storageCleanupOptions(data){
  const assistant=data?.assistantStorage;
  const collection=data?.collectionStorage;
  return [...(collection?.status==='ready'&&collection.count>0?[{id:'__text_collection__',label:'正文收藏',bytes:collection.bytes,count:collection.count,risk:['删除全部收藏正文 · 请先备份',true]}]:[]),...(assistant?.native?.status==='ready'&&assistant.native.heads?.count>0?[{id:'__assistant_native__',label:'场外特助会话（当前账户 · ST）',bytes:assistant.native.heads.bytes+assistant.native.current.bytes,count:assistant.native.heads.count,risk:['逐项查阅/备份/清空会话；保留旧版本，不回收磁盘空间',true]}]:[]),...(assistant?.status==='ready'&&assistant.count>0?[{id:'__assistant__',label:'场外特助旧副本（当前账户 · 本机）',bytes:assistant.bytes,count:assistant.count,risk:['不可恢复 · 请先复制留存；不删除ST记录，版本标记保留',true]}]:[])];
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
    for (const selector of ['.sd-dm-cleanup']) {
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
