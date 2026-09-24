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
  const native=assistant?.native,format=value=>htmlEscape(formatStorageBytes(value));
  return `<p class="sd-storage-scope sd-storage-assistant-native-summary" role="status" style="overflow-wrap:anywhere">场外特助 · 当前账户 ST 文件<br>${native?.status==='ready'
    ? `${native.heads.count} 份当前会话文件（含场外与清空标记）· ${format(native.heads.bytes+native.current.bytes)}<br>保留版本/残留文件 ${native.retained.count} 份 · ${format(native.retained.bytes)}；合计 ${native.total.count} 个文件 · ${format(native.total.bytes)}<br>按文件大小统计，不是磁盘分配量、可释放容量或浏览器配额；不含未保存回复。仅核对入口与文件元数据，不读取问答或核验历史正文；未自动删除旧版本。当前会话可在特助设置内清空，储存清理中的旧副本选项仅针对本机。`
    : `暂未盘点 · ${htmlEscape(native?.error||'ST助手文件尚未读取；请确认配套后端可用后刷新。未读取不代表零占用。')}<br>日常助手保存和跨端读取仍通过ST原生存储，不依赖这项盘点。`}</p>
<p class="sd-storage-scope sd-storage-assistant-summary" role="status" style="overflow-wrap:anywhere">场外特助 · 当前账户旧本机副本<br>${assistant?.status==='ready'
    ? `${assistant.chats} 个会话 · ${assistant.count} 轮问答 · ${format(assistant.bytes)} 逻辑估算<br>完整 ${assistant.complete} · 失败 ${assistant.failed} · 停止 ${assistant.cancelled}；含 ${assistant.markers} 份清空版本标记。不含未保存回复、其他账户或设备，旧版归属未核实的记录不认领；非可重建缓存。可选择清理项目中的旧本机副本，不删除ST记录。`
    : `暂未读取 · ${htmlEscape(assistant?.error||'助手本机历史尚未盘点，当前本机总计不含此部分。')}`}</p>`;
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
  const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const notesInfo = notesStorage?.status === 'ready'
    ? `当前账户本机已保存 ${count(notesStorage.count)} 条（常驻 ${count(notesStorage.pinned)} 条）· ${escape(formatBytes(count(notesStorage.bytes)))} 内容及同步记录估算。不含其他设备尚未同步的内容，也不是 VPS 占用。`
    : notesStorage?.status === 'unavailable' ? `账户便笺暂不可读取，当前统计未包含此部分。${escape(notesStorage.error)}` : '便笺备份仅包含当前 ST 账户在本机已保存的内容。';
  return `<details class="sd-storage-disclosure sd-storage-backup-section" data-storage-section="backups">
    <summary>资料管理<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></summary>
    <div class="sd-storage-disclosure-body">
      <h4 class="sd-storage-group-title">通用资源</h4>
      <p class="sd-storage-scope">按内容分别备份。配置不包含素材原件；导入配置会覆盖现有设置。分镜资源包的范围在导出前核对，不代表全部聊天备份。</p>
      <div class="sd-storage-backup-row"><span>配置</span><button type="button" class="sd-btn sd-export-config">导出</button><button type="button" class="sd-btn sd-import-config">导入</button><input type="file" class="sd-import-config-file" accept="application/json,.json" hidden></div>
      <button type="button" class="sd-btn sd-undo-config" hidden>撤回本次恢复</button>
      ${[['notes','便笺','application/json,.json'],['favorites','语音收藏','application/json,.json'],['audio','音频缓存','application/json,.json']].map(([key,label,accept])=>storagePackageRow(key,label,accept)).join('')}
      ${storagePackageRow('collections','正文收藏','application/json,.json')}
      <div class="sd-storage-backup-row"><span>场外特助会话</span><button type="button" class="sd-btn sd-storage-assistant-library">管理 / 恢复</button></div>
      <p class="sd-storage-scope">正文收藏备份读取当前 ST 账户的服务器原件，不含已删除条目；与聊天及本机缓存清理独立。导入仅新增副本，不覆盖现有收藏。</p>
      <div class="sd-storage-backup-row"><span>专注语音原件</span><button type="button" class="sd-btn sd-storage-focus-library">管理</button></div>
      <p class="sd-storage-scope">音频缓存是本浏览器当前 ST 站点的本机记录，可含多个聊天；旧记录没有可靠账户归属，不代表当前账户专属，也不自动跨端。清理请在本卡选择「音频缓存」，不会删除语音收藏。重新合成可能收费。</p>
      <p class="sd-storage-scope sd-storage-notes-summary" role="status">${notesInfo} 所有便笺都保存，常驻不影响备份范围。</p>
      <p class="sd-storage-scope">旧版便笺原件仍在本浏览器；请从便笺面板的“旧便笺”查看、导出或确认归属。旧版清理不会删除账户便笺。</p>
      <h4 class="sd-storage-group-title">分镜与伴读</h4>
      ${storagePackageRow('storyboard','分镜资源','.qmb,application/json,.json')}
      <p class="sd-storage-scope sd-storage-gallery-check-status" role="status" style="overflow-wrap:anywhere" hidden></p>
      ${storagePackageRow('reader','伴读资料','application/json,.json')}
      <div class="sd-storage-resource-list">${data ? renderStorageResourceRows(data,formatBytes) : '<p class="sd-storage-scope">资料目录等待盘点；备份与恢复仍可使用。</p>'}</div>
      <div class="sd-storage-actions sd-storage-manage-actions">${data ? `<button type="button" class="sd-btn sd-primary sd-storage-clean" ${ready && (data.manageableBytes > 0 || collectionCleanupOptions(data).some(row=>row.bytes>0)) ? '' : 'disabled'}>选择清理项目<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button><button type="button" class="sd-btn sd-storage-chat-clean" ${ready && data.idb?.chatScopes?.length ? '' : 'disabled'}>按聊天选择本机记录<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>` : ''}</div>
    </div>
  </details>`;
}

function storagePackageRow(key,label,accept) {
  return `<div class="sd-storage-backup-row"><span>${label}${key==='storyboard'?'<button type="button" class="sd-btn sd-storage-gallery-check" aria-label="核对当前聊天静帧来源">核对来源</button>':''}</span><button type="button" class="sd-btn" data-storage-export="${key}" aria-label="导出${label}">导出</button><button type="button" class="sd-btn" data-storage-pick="${key}" aria-label="导入${label}">导入</button><input type="file" data-storage-import="${key}" accept="${accept}" hidden></div>`;
}

function renderStorageResourceRows(data,formatStorageBytes) {
  const htmlEscape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  return `${data.imageAttempts?.error ? `<p class="sd-storage-pressure is-warning">${htmlEscape(data.imageAttempts.error)}</p>` : ''}
<p class="sd-storage-scope sd-storage-server-recipes" role="status" style="overflow-wrap:anywhere">服务器配方 · 当前账户<br>${data.recipeStorage?.status==='ready'
  ? `${data.recipeStorage.files} 个归档文件 · ${htmlEscape(formatStorageBytes(data.recipeStorage.bytes))}${data.recipeStorage.state==='absent'?' · 尚无服务器配方文件':''}<br>不计入本设备占用；含保留旧版及未核验文件，不代表可恢复配方数量。${data.recipeStorage.files>=data.recipeStorage.limitFiles||data.recipeStorage.bytes>=data.recipeStorage.limitBytes?'<br>已达到配方写入安全限额；不是 VPS 磁盘容量，未自动清理原件。':''}`
  : `暂未读取 · ${htmlEscape(data.recipeStorage?.error||'配套后端尚未返回占用信息，未按零值计算。')}`}</p>
<div class="sd-storage-actions"><span>${data.galleryCatalogStorage?.status==='ready'?`图库目录 · 当前账户本机 ${data.galleryCatalogStorage.count} 条引用 · ${htmlEscape(formatStorageBytes(data.galleryCatalogStorage.bytes))} 逻辑估算`:'图库目录暂未盘点 · 当前总计不含此部分'}<br>仅来源与标签索引，不含图片、影片原件</span><button type="button" class="sd-btn sd-storage-gallery-catalog">管理目录</button></div>
${data.galleryCatalogStorage?.status==='unavailable'?`<p class="sd-storage-pressure is-warning">${htmlEscape(data.galleryCatalogStorage.error||'目录暂不可读取，未清除旧引用。')}</p>`:''}
<p class="sd-storage-scope sd-storage-collection-summary" role="status" style="overflow-wrap:anywhere">服务器正文收藏 · 当前账户<br>${data.collectionStorage?.status==='ready'
  ? `${data.collectionStorage.count} 条原件 · 文件 ${htmlEscape(formatStorageBytes(data.collectionStorage.bytes))}${data.collectionStorage.state==='absent'?' · 尚无收藏文件':''}<br>其中正文 UTF-8 ${htmlEscape(formatStorageBytes(data.collectionStorage.textBytes))}；文件另含来源、同步回执及 ${data.collectionStorage.deletedCount} 条删除标记。不计入浏览器配额，也不是 VPS 磁盘容量。`
  : `暂未读取 · ${htmlEscape(data.collectionStorage?.error||'收藏占用尚未盘点，未按零占用处理。')}`}</p>
<p class="sd-storage-scope sd-storage-collection-pending-summary" role="status" style="overflow-wrap:anywhere">收藏待存 · 当前账户本机<br>${data.collectionStorage?.pending?.status==='ready'
  ? `${data.collectionStorage.pending.count} 条 · ${htmlEscape(formatStorageBytes(data.collectionStorage.pending.bytes))} 内容及请求记录估算 · 冲突 ${data.collectionStorage.pending.conflicts} 条<br>计入本设备统计，不含服务器原件或其他设备待存。不是可重建缓存；在正文收藏→本机待存中备份、恢复或移除。`
  : `暂未读取 · ${htmlEscape(data.collectionStorage?.pending?.error||'本机待存尚未盘点，当前总计不含此部分。')}`}</p>
${renderAssistantStorageSummary(data.assistantStorage,formatStorageBytes,htmlEscape)}
${data.imageChannels?.error ? `<p class="sd-storage-pressure is-warning">${htmlEscape(data.imageChannels.error)}</p>` : ''}
${data.serviceReceipts?.error ? `<p class="sd-storage-pressure is-warning">${htmlEscape(data.serviceReceipts.error)}</p>` : ''}
${data.comfyReceipts?.error ? `<p class="sd-storage-pressure is-warning">${htmlEscape(data.comfyReceipts.error)}</p>` : ''}
${data.vibeStorage?.status==='ready'?`<div class="sd-storage-actions"><span>Vibe 文件 · ${data.vibeStorage.assets.count} 份 · ${htmlEscape(formatStorageBytes(data.vibeStorage.assets.bytes+data.vibeStorage.previews.bytes))}<br>编码记录 ${data.vibeStorage.records.count} 条（含归档 ${data.vibeStorage.records.archivedCount}）· ${htmlEscape(formatStorageBytes(data.vibeStorage.records.bytes))}${data.vibeStorage.feeOriginals?`<br>已登记费用原件 · ${htmlEscape(formatStorageBytes(data.vibeStorage.feeOriginals.total.bytes))} · ${data.vibeStorage.feeOriginals.total.count} 个文件 / ${data.vibeStorage.feeOriginals.versions} 个版本<br>当前版本文件 ${htmlEscape(formatStorageBytes(data.vibeStorage.feeOriginals.selected.bytes))} · 历史独有文件 ${htmlEscape(formatStorageBytes(data.vibeStorage.feeOriginals.history.bytes))}<br><small>按已核验 ST 文件去重；不含旧索引、未登记残留与本机副本。不与内容估算相加，不是 VPS 总占用或可清理量。</small>`:''}</span><button type="button" class="sd-btn sd-storage-vibes">Vibe 管理</button></div>`:`<div class="sd-storage-actions"><span>Vibe 占用暂不可读取 · 当前总计不含此部分</span><button type="button" class="sd-btn sd-storage-vibes">Vibe 管理</button></div><p class="sd-storage-pressure is-warning">${htmlEscape(data.vibeStorage?.error||'请进入 Vibe 管理核对或保全数据；未修改任何内容。')}</p>`}
<div class="sd-storage-actions"><span>Comfy 本机领取记录 · ${data.comfyReceipts && !data.comfyReceipts.error ? `${Number(data.comfyReceipts.count) || 0} 条 · ${htmlEscape(formatStorageBytes(data.comfyReceipts.bytes))}` : '暂不可读取，总计未包含'}</span><button type="button" class="sd-btn sd-storage-comfy-receipts">收片管理</button></div>
<div class="sd-storage-actions"><span>${data.restoreStorage?.status==='ready'?`分镜恢复记录 · ${data.restoreStorage.count} 条 · ${htmlEscape(formatStorageBytes(data.restoreStorage.bytes))}`:'恢复记录占用暂不可读取 · 当前总计不含此部分'}</span><button type="button" class="sd-btn sd-storage-restores">恢复记录管理</button></div>
${data.restoreStorage?.status==='ready'?'':`<p class="sd-storage-pressure is-warning">${htmlEscape(data.restoreStorage?.error||'请重新盘点或进入恢复记录管理核对；未修改记录。')}</p>`}
<div class="sd-storage-actions"><span>${data.mappingStorage?.status==='ready'?`迁移映射凭据 · ${data.mappingStorage.count} 份 · ${htmlEscape(formatStorageBytes(data.mappingStorage.bytes))}`:'迁移凭据占用暂不可读取 · 当前总计不含此部分'}</span><button type="button" class="sd-btn sd-storage-mappings">凭据管理</button></div>
${data.mappingStorage?.status==='ready'?'':`<p class="sd-storage-pressure is-warning">${htmlEscape(data.mappingStorage?.error||'请进入迁移凭据目录核对；未改动原记录。')}</p>`}
<div class="sd-storage-actions"><span>${data.carrierStorage?.status==='ready'?`来源记录 · ${data.carrierStorage.count} 份 · 原文 ${data.carrierStorage.originalCount} 份 · ${htmlEscape(formatStorageBytes(data.carrierStorage.bytes))} 逻辑估算<br>不含传输编码与保全副本，不等于VPS磁盘用量`:'来源记录占用暂不可读取 · 当前总计不含此部分'}</span><span>随资源联包完整备份</span></div>
${data.carrierStorage?.status==='ready'?'':`<p class="sd-storage-pressure is-warning">${htmlEscape(data.carrierStorage?.error||'来源记录暂不可读取，未自动清理。')}</p>`}
<div class="sd-storage-actions"><span>${data.characterStorage?.status==='ready'?`角色库 · ${data.characterStorage.documents.count} 份档案 · ${htmlEscape(formatStorageBytes(data.characterStorage.documents.bytes))}<br>绑定 ${data.characterStorage.bindings.count} 项 · 不含服务器参考图`:'角色库占用暂不可读取 · 当前总计不含此部分'}</span><button type="button" class="sd-btn sd-storage-characters">角色库管理</button></div>
${data.characterStorage?.status==='ready'?'':`<p class="sd-storage-pressure is-warning">${htmlEscape(data.characterStorage?.error||'请重新盘点或进入角色库核对；未修改档案。')}</p>`}
${(data.comfyStorage?.errors || []).map(message=>`<p class="sd-storage-pressure is-warning">${htmlEscape(message)}</p>`).join('')}
${[['workflows','Comfy 工作流库'],['pools','Comfy 候选方案'],['scenes','Comfy 续场记录']].map(([key,label])=>{const row=data.comfyStorage?.[key];return `<div class="sd-storage-actions"><span>${label} · 当前账户 · ${row?.status==='ready'?`${row.count} 项 · ${htmlEscape(formatStorageBytes(row.bytes))}<br>${key==='scenes'?'记录正文':`含 ${row.versions} 个版本、${row.archived} 项归档`}`:'未盘点，总计未包含'}</span>${key!=='scenes'?`<button type="button" class="sd-btn" data-storage-comfy-library="${key}">管理</button>`:''}</div>`;}).join('')}`;
}
