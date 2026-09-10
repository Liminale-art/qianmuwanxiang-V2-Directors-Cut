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

export function renderCoreadSwitchView(cls, on) {
  return `<label class="sd-reader-mtoggle"><input type="checkbox" class="${cls}"${on ? ' checked' : ''}><span class="sd-reader-mtoggle-track"><span class="sd-reader-mtoggle-thumb"></span></span></label>`;
}

export function renderCoreadModelRowView({kind, list, cur, placeholder}, htmlEscape) {
  const opts = list.length
    ? list.map((x) => `<option value="${htmlEscape(x)}"${x === cur ? ' selected' : ''}>${htmlEscape(x)}</option>`).join('')
    : `<option value="" disabled selected>— 先拉取模型列表 —</option>`;
  return `<label class="sd-reader-mlab">模型</label>
    <select class="sd-reader-minput sd-reader-mem-modelpick" data-kind="${kind}">
      ${list.length ? `<option value="">— ${htmlEscape(placeholder || '选择模型')} —</option>` : ''}
      ${opts}
    </select>`;
}

export function renderCoreadProfileRowView({kind, list, sel}, htmlEscape) {
  return `
    <div class="sd-reader-mprofile">
      <select class="sd-reader-minput sd-reader-mem-profile" data-kind="${kind}">
        <option value="">— 载入预设 —</option>
        ${list.map((p) => `<option value="${htmlEscape(p.id)}"${p.id === sel ? ' selected' : ''}>${htmlEscape(p.name || p.model || '未命名')}</option>`).join('')}
      </select>
      <button type="button" class="sd-reader-mbtn sd-reader-mem-profile-del" data-kind="${kind}" title="删除选中预设"><i class="fa-solid fa-trash"></i></button>
    </div>`;
}

export function renderCoreadApiActionsView(kind) {
  return `
    <div class="sd-reader-mactions">
      <button type="button" class="sd-reader-mbtn sd-reader-mem-test" data-kind="${kind}"><i class="fa-solid fa-plug-circle-check"></i>测试连接</button>
      <button type="button" class="sd-reader-mbtn sd-reader-mem-fetch" data-kind="${kind}"><i class="fa-solid fa-rotate"></i>拉取模型</button>
      <button type="button" class="sd-reader-mbtn sd-reader-mem-save" data-kind="${kind}"><i class="fa-solid fa-bookmark"></i>保存预设</button>
    </div>`;
}

export function renderCoreadInjectionRowsView({injected, recall}, htmlEscape, coreadSliceSourceClass, coreadSliceSourceLabel) {
  const batchOf = (s) => s.compressed ? '合并' : (s.batch || '?');
  // 锚定词高亮：用召回内核算出的真实 hits（已过同义词归一），非裸字符串匹配。近景切片是无条件注入·不算锚定·不高亮。
  const kwTags = (h) => {
    const anchorSet = new Set(h.recent ? [] : (h.hits || []));
    return (h.slice.keywords || []).map((k) => `<span class="sd-reader-slice-key ${anchorSet.has(k) ? 'on' : ''}">${htmlEscape(k)}</span>`).join('');
  };
  // 切片来源徽标 HTML（三来源统一命名·同色系区分）
  const srcBadge = (s) => `<span class="sd-reader-src-badge ${coreadSliceSourceClass(s)}">${coreadSliceSourceLabel(s)}</span>`;
  // ① 实际注入：显完整总结全文（书籍/对谈/主线来源徽标 + 近景/检索通道标）
  const injCards = injected.length
    ? injected.map((h) => `
      <div class="sd-reader-injslice inj">
        <div class="sd-reader-injslice-head"><span class="sd-reader-slice-batch">#${batchOf(h.slice)}</span>${srcBadge(h.slice)}<span class="sd-reader-injslice-tag${h.recent ? ' recent' : ''}">${h.recent ? '近景' : '检索'}</span></div>
        <div class="sd-reader-injslice-full">${htmlEscape(h.slice.summary || '')}</div>
        <div class="sd-reader-injslice-keys">${kwTags(h)}</div>
      </div>`).join('')
    : '<div class="sd-reader-mempty">尚无注入记录</div>';

  // ② 召回候选：编号 + 来源徽标 + 关键词（锚定词点亮）+ 命中数 + 分数
  const candRows = recall.length
    ? recall.map((h) => `
      <div class="sd-reader-injrow">
        <span class="sd-reader-slice-batch">#${batchOf(h.slice)}</span>
        ${srcBadge(h.slice)}
        <span class="sd-reader-injrow-keys">${kwTags(h)}</span>
        <span class="sd-reader-injrow-score">命中 ${h.hits.length} · 分 ${(h.score || 0).toFixed(2)}</span>
      </div>`).join('')
    : '<div class="sd-reader-mempty">无候选。</div>';

  return {injCards, candRows};
}

export function renderCoreadInjectionAnchorsView(roundAnchors, htmlEscape) {
  const anchorBar = roundAnchors.length
    ? `<div class="sd-reader-anchorbar"><span class="sd-reader-anchorbar-lab">本轮关键词</span>${roundAnchors.map((k) => `<span class="sd-reader-slice-key on">${htmlEscape(k)}</span>`).join('')}</div>`
    : '<div class="sd-reader-anchorbar sd-muted">本轮没有命中切片关键词。</div>';

  return anchorBar;
}

export function renderCoreadInjectionDictionaryView({curBook, curBound, isDefaultBook, dictOptions}, htmlEscape) {
  let dictRows = '';
  if (curBook && curBook.pairs) {
    dictRows = Object.entries(curBook.pairs).map(([canon, aliases]) => `
      <div class="sd-reader-dict-row" data-bookid="${htmlEscape(curBook.id)}" data-canon="${htmlEscape(canon)}">
        <span class="sd-reader-dict-canon">${htmlEscape(canon)}</span>
        <span class="sd-reader-dict-aliases">
          ${(aliases || []).map((a) => `<span class="sd-reader-dict-alias">${htmlEscape(a)}</span>`).join('')}
        </span>
        <span class="sd-reader-dict-row-acts">
          <button type="button" class="sd-reader-dict-row-edit" title="编辑"><i class="fa-solid fa-pencil"></i></button>
          <button type="button" class="sd-reader-dict-row-del" title="删除"><i class="fa-solid fa-trash"></i></button>
        </span>
      </div>`).join('');
  }
  if (!dictRows) dictRows = '<div class="sd-reader-mempty">点下方「新增词条」添加。</div>';
  const dictBody = `
    <div class="sd-reader-dict-selector">
      <select class="sd-reader-minput sd-reader-dict-booksel">
        ${dictOptions}
      </select>
      ${curBook ? `<span class="sd-reader-dict-book-acts">
        ${isDefaultBook ? '' : `<button type="button" class="sd-reader-mbtn sd-reader-dictbook-rename" data-id="${htmlEscape(curBook.id)}" title="重命名词册"><i class="fa-solid fa-pen"></i></button>
        <button type="button" class="sd-reader-mbtn sd-reader-dictbook-delbtn" data-id="${htmlEscape(curBook.id)}" title="删除此词册"><i class="fa-solid fa-trash"></i></button>`}
      </span>` : ''}
    </div>
    <div class="sd-reader-dict-rows">${dictRows}</div>
    <div class="sd-reader-mactions">
      <button type="button" class="sd-reader-mbtn sd-reader-dictbook-add">新建词册</button>
      <button type="button" class="sd-reader-mbtn sd-reader-dict-addentry">新增词条</button>
      <button type="button" class="sd-reader-mbtn sd-reader-dictbook-bind">${curBound ? '解除绑定' : '绑定至此聊天'}</button>
    </div>`;
  return dictBody;
}

export function renderCoreadInjectionPanelView({injectedCount, hasLastInjection, liChannelLabel, injCards, blockedCount, config, scanN, mainlineSwitch, dictPairCount, curBound, dictBody, scanText, anchorBar, candidateCount, candRows, targetClass}, htmlEscape) {
  return `
    <details class="sd-reader-mcard${targetClass}" open>
      <summary class="sd-reader-mcard-head"><i class="fa-solid fa-syringe"></i> 实际注入 <span class="sd-reader-inj-tag">${injectedCount} 条</span>${hasLastInjection ? `<span class="sd-reader-inj-tag">最近一次·${liChannelLabel}</span>` : ''}</summary>
      <div class="sd-reader-injslices">${injCards}</div>
    </details>
    <div class="sd-reader-mcard">
      <div class="sd-reader-mcard-head"><i class="fa-solid fa-sliders"></i> 注入设置</div>
      ${blockedCount ? `<div class="sd-reader-mhint"><i class="fa-solid fa-shield-halved"></i> 当前已隔离 ${blockedCount} 条超过阅读进度的记忆；它们仍保存在档案中，读到相应位置后自动恢复。</div>` : ''}
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">检索命中注入数</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-inj-recall" min="0" step="1" value="${config.recallCount}"></div>
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">近景切片注入数</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-inj-recent" min="0" step="1" value="${config.recentInject}"></div>
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">语境扫描对话条数</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-inj-scan" min="1" max="50" step="1" value="${scanN}"></div>
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">重排后保留数</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-inj-reranktop" min="1" step="1" value="${config.rerankTopN}"></div>
    </div>
    <div class="sd-reader-mcard">
      <div class="sd-reader-mcard-head"><i class="fa-solid fa-arrow-right-arrow-left"></i> 主线联动</div>
      <div class="sd-reader-mhint">根据主线当下语境将伴读记忆切片召回注入。</div>
      <div class="sd-reader-mrow">
        <span class="sd-reader-mrow-lab">开启主线联动</span>
        ${mainlineSwitch}
      </div>
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">检索命中注入数</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-mainline-recall" min="0" step="1" value="${config.mainlineRecall}"${config.mainlineFeedback ? '' : ' disabled'}></div>
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">近景切片注入数</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-mainline-recent" min="0" step="1" value="${config.mainlineRecent}"${config.mainlineFeedback ? '' : ' disabled'}></div>
      <div class="sd-reader-mrow"><span class="sd-reader-mrow-lab">注入深度</span><input type="number" class="sd-reader-minput sd-reader-num-narrow sd-reader-mainline-depth" min="0" step="1" value="${config.mainlineDepth}"${config.mainlineFeedback ? '' : ' disabled'}></div>
    </div>
    <details class="sd-reader-mcard" open>
      <summary class="sd-reader-mcard-head"><i class="fa-solid fa-book-bookmark"></i> 检索词典 <span class="sd-reader-inj-tag">${dictPairCount}</span><span class="sd-reader-inj-tag${curBound ? ' on' : ''}">${curBound ? '已绑定' : '未绑定'}</span></summary>
      ${dictBody}
    </details>
    <details class="sd-reader-mcard">
      <summary class="sd-reader-mcard-head">
        <i class="fa-solid fa-diagram-project"></i> 召回管线
        <span class="sd-reader-inj-tag${config.vectorEnabled ? ' on' : ''}">向量</span>
        <span class="sd-reader-inj-tag${config.rerankEnabled ? ' on' : ''}">重排</span>
      </summary>
      <div class="sd-reader-pipe-step">
        <div class="sd-reader-pipe-lab"><i class="fa-solid fa-magnifying-glass"></i> ① 语境扫描（最近 ${scanN} 条对话）</div>
        <div class="sd-reader-scanbox">${htmlEscape(scanText)}</div>
      </div>
      <div class="sd-reader-pipe-step">
        <div class="sd-reader-pipe-lab"><i class="fa-solid fa-anchor"></i> ② 关键词锚定</div>
        ${anchorBar}
      </div>
      <div class="sd-reader-pipe-step">
        <div class="sd-reader-pipe-lab"><i class="fa-solid fa-vector-square"></i> ③ 向量召回 <span class="sd-reader-inj-tag${config.vectorEnabled ? ' on' : ''}">向量</span></div>
      </div>
      <div class="sd-reader-pipe-step">
        <div class="sd-reader-pipe-lab"><i class="fa-solid fa-arrow-down-wide-short"></i> ④ 重排精排 <span class="sd-reader-inj-tag${config.rerankEnabled ? ' on' : ''}">重排</span></div>
      </div>
      <div class="sd-reader-pipe-step">
        <div class="sd-reader-pipe-lab"><i class="fa-solid fa-list-check"></i> ⑤ 召回候选（${candidateCount}）</div>
        <div class="sd-reader-injrows">${candRows}</div>
      </div>
    </details>`;
}
