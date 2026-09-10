// Display-only center components; callers own reading boundaries, filtering and guide state.
export function renderCoreadCenterStatusView({meta, progress, blocked, sliceCount}, htmlEscape) {
  return `<section class="sd-reader-center-status">
    <div class="sd-reader-center-book">
      <span class="sd-reader-center-book-icon"><i class="fa-solid fa-book"></i></span>
      <span class="sd-reader-center-book-copy">
        <b>${meta ? `《${htmlEscape(meta.title || '未命名')}》` : '尚未打开书籍'}</b>
        <small>已读 ${progress}% · ${sliceCount} 条记忆${blocked ? ` · ${blocked} 条进度外隔离` : ''}</small>
      </span>
    </div>
  </section>`;
}

export function renderCoreadSpoilerGuardView({on, switchHtml}) {
  return `<label class="sd-reader-center-guard sd-reader-setup-guard${on ? ' is-protected' : ''}">
    <span><i class="fa-solid fa-shield-halved"></i><b>防全知剧透</b></span>
    ${switchHtml}
  </label>`;
}

export function renderCoreadGuideView({step, index, total}, htmlEscape) {
  return `<aside class="sd-reader-tour" role="dialog" aria-label="伴读快速引导">
    <div class="sd-reader-tour-icon"><i class="fa-solid ${step.icon}"></i></div>
    <div class="sd-reader-tour-copy">
      <span class="sd-reader-tour-count">${index + 1} / ${total}</span>
      <b>${htmlEscape(step.title)}</b>
      <p>${htmlEscape(step.text)}</p>
    </div>
    <div class="sd-reader-tour-actions">
      <button type="button" class="sd-reader-tour-skip" title="跳过引导">跳过</button>
      <button type="button" class="sd-reader-tour-prev" title="上一步"${index ? '' : ' disabled'}><i class="fa-solid fa-arrow-left"></i></button>
      <button type="button" class="sd-reader-tour-next" title="${index === total - 1 ? '完成' : '下一步'}"><i class="fa-solid ${index === total - 1 ? 'fa-check' : 'fa-arrow-right'}"></i></button>
    </div>
  </aside>`;
}

export function renderCoreadPackBarView(targetClass) {
  return `<section class="sd-reader-packbar${targetClass}">
    <span class="sd-reader-packbar-icon"><i class="fa-solid fa-box-open"></i></span>
    <span class="sd-reader-packbar-copy"><b>伴读数据打包</b><small>整包迁移与备份 · 不含 API 密钥</small></span>
    <span class="sd-reader-packbar-actions">
      <button type="button" class="sd-reader-pack-export" title="导出伴读数据打包"><i class="fa-solid fa-file-export"></i></button>
      <label class="sd-reader-pack-import" title="导入伴读数据打包"><i class="fa-solid fa-file-import"></i><input type="file" class="sd-reader-pack-import-input sd-reader-native-file" accept="application/json,.json"></label>
    </span>
  </section>`;
}

export function renderCoreadMemoryStorageView({syncLabel, syncMode, busy}) {
  return `
    <details class="sd-reader-mcard">
      <summary class="sd-reader-mcard-head"><i class="fa-solid fa-database"></i> 世界书同步 <span class="sd-reader-inj-tag">${syncLabel}</span></summary>
      <div class="sd-reader-mrow">
        <span class="sd-reader-mrow-lab" style="white-space:nowrap">同步方式</span>
        <select class="sd-reader-minput sd-reader-storagemode"${busy ? ' disabled' : ''}>
          <option value="none"${syncMode === 'none' ? ' selected' : ''}>仅存至千幕档案（本地存储）</option>
          <option value="dedicated"${syncMode === 'dedicated' ? ' selected' : ''}>同步到千幕伴读世界书</option>
          <option value="shared"${syncMode === 'shared' ? ' selected' : ''}>同步至正文记忆插件所用世界书</option>
        </select>
      </div>
    </details>`;
}

export function renderCoreadSummaryItemsView(items, htmlEscape) {
  return items.map((it, i) => {
    return `
    <details class="sd-reader-promptblock sd-reader-sumitem" data-id="${htmlEscape(it.id)}">
      <summary class="sd-reader-promptblock-lab">
        <span><i class="fa-solid fa-comments"></i> ${htmlEscape(it.title)}</span>
        <span class="sd-reader-promptblock-acts" onclick="event.preventDefault()">
          <button type="button" class="sd-reader-mbtn sd-reader-sumitem-up" data-id="${htmlEscape(it.id)}" title="上移"${i === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
          <button type="button" class="sd-reader-mbtn sd-reader-sumitem-down" data-id="${htmlEscape(it.id)}" title="下移"${i === items.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
          ${it.builtin ? '' : `<button type="button" class="sd-reader-mbtn sd-reader-sumitem-del" data-id="${htmlEscape(it.id)}" title="删除"><i class="fa-solid fa-trash"></i></button>`}
        </span>
      </summary>
      <div class="sd-reader-promptedit">
        <input class="sd-reader-minput sd-reader-sumitem-title" data-id="${htmlEscape(it.id)}" value="${htmlEscape(it.title)}" placeholder="提示词名">
        <textarea class="sd-reader-mtextarea sd-reader-sumitem-text" data-id="${htmlEscape(it.id)}" rows="8" placeholder="这条提示词要总结什么……">${htmlEscape(it.text)}</textarea>
      </div>
    </details>`;
  }).join('');
}

export function renderCoreadMemoryOverviewView({curBook, msgsLen, cursor, sliceCount, pendingN, boundN, blockedN, targetClass}, htmlEscape) {
  return `
    <section class="sd-reader-memory-overview${targetClass}">
      <div class="sd-reader-memory-title"><span><i class="fa-solid fa-book-bookmark"></i></span><div><b>${curBook ? `《${htmlEscape(curBook.title || '未命名')}》` : '当前伴读档案'}</b><small>${msgsLen} 条对话 · 已整理 ${cursor} 条</small></div></div>
      <div class="sd-reader-memory-stats">
        <span><b>${sliceCount}</b><small>记忆切片</small></span>
        <span><b>${pendingN}</b><small>待整理对话</small></span>
        <span><b>${boundN}</b><small>绑定档案</small></span>
        <span><b>${blockedN}</b><small>进度外隔离</small></span>
      </div>
      <div class="sd-reader-memory-actions">
        <button type="button" class="sd-reader-mbtn sd-reader-slice-manage"><i class="fa-solid fa-table-list"></i>管理切片</button>
        <button type="button" class="sd-reader-mbtn sd-reader-arch-manage"><i class="fa-solid fa-box-archive"></i>管理档案</button>
        <button type="button" class="sd-reader-mbtn sd-reader-slice-clear"${sliceCount ? '' : ' disabled'}><i class="fa-solid fa-trash-can"></i>清空切片</button>
      </div>
    </section>`;
}
