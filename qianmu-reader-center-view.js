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
