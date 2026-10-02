// Pure markup: the caller owns worldbook reads, draft selection and confirmation.
export function renderStoryboardWorldbookView(state, view, {htmlEscape, badge, hashText, cleanContextText}) {
  const collapsed = state.collapsedCards || {}, books = view.books || [], viewName = view.viewName || '';
  const currentBook = books.find(book => book.name === viewName), editing = view.bound && view.editing;
  const owner = htmlEscape(view.ownerLabel || '对应人设');
  const entriesEnabled = editing || Boolean(currentBook?.selected && (!view.bound || view.manual));
  const bookRows = books.map(book => `<div class="sd-source-row sd-world-row ${viewName === book.name ? 'sd-world-viewing' : ''}">
    <input type="checkbox" class="sd-storyboard-toggle-worldbook" data-name="${htmlEscape(book.name)}" ${book.selected ? 'checked' : ''} title="选中作为分镜参考" aria-label="选中 ${htmlEscape(book.name)} 作为分镜参考">
    <button type="button" class="sd-storyboard-world-name" data-name="${htmlEscape(book.name)}"><span>${htmlEscape(book.name)}</span>${(book.labels || []).map(label => badge(label)).join('')}${book.pending ? badge('待确认') : ''}</button>
  </div>`).join('');
  const entryRows = viewName ? (view.entries || []).map(row => {
    const card = `worldbook-entry-${hashText(row.id)}`;
    return `<details class="sd-source-row sd-context-item sd-unified-source-entry" data-storyboard-card="${htmlEscape(card)}" ${collapsed[card] === false ? 'open' : ''}><summary><label class="sd-context-entry-label"><input type="checkbox" data-storyboard-world-entry="${htmlEscape(row.id)}" ${row.checked ? 'checked' : ''} ${entriesEnabled ? '' : 'disabled'}><span>${htmlEscape(row.title)}</span></label></summary><pre>${htmlEscape(String(cleanContextText(row.content || '') || '').slice(0, 2000))}</pre></details>`;
  }).join('') : '';
  let hint = '', actions = '';
  if (viewName && view.bound) {
    const conversion = view.manual ? `<p class="sd-muted">确认后取消此书的通用手选，改为随${owner}生效。</p>` : '';
    if (editing) {
      hint = `<p class="sd-muted">确认后随${owner}发送；新条目不会自动加入。</p>${conversion}`;
      actions = `<div class="sd-button-row"><button type="button" class="sd-btn sd-primary sd-storyboard-confirm-persona-world">确认人设条目</button><button type="button" class="sd-btn sd-storyboard-skip-persona-world">不引用此书</button><button type="button" class="sd-btn sd-storyboard-cancel-persona-world">取消</button></div>`;
    } else {
      hint = conversion || `<p class="sd-muted">${currentBook?.pending ? '人设条目待确认，确认前不会随人设发送。' : currentBook?.selected ? `已确认的条目随${owner}发送；新条目不会自动加入。` : '当前不引用此书，可调整条目后重新启用。'}</p>`;
      actions = `<div class="sd-button-row"><button type="button" class="sd-btn sd-storyboard-edit-persona-world">${view.manual ? '随人设记住选择' : currentBook?.pending ? '选择人设条目' : '调整人设条目'}</button></div>`;
    }
  }
  const body = view.loading
    ? '<div class="sd-storyboard-empty-inline">正在读取世界书…</div>'
    : view.error
      ? `<div class="sd-storyboard-empty-inline">${htmlEscape(view.error)}</div>`
      : books.length
        ? `<div class="sd-storyboard-worldbook-picker"><details class="sd-dropdown" data-storyboard-card="worldbook-directory" ${collapsed['worldbook-directory'] ? '' : 'open'}><summary class="sd-dropdown-head"><span>世界书目录</span><b>${books.filter(book => book.selected).length} 项</b></summary><div class="sd-dropdown-body sd-scroll">${bookRows}</div></details></div>${viewName ? `<details class="sd-dropdown sd-storyboard-worldbook-entries" data-storyboard-card="worldbook-entries" ${collapsed['worldbook-entries'] ? '' : 'open'}><summary class="sd-dropdown-head"><span>世界书条目</span><b>${htmlEscape(viewName)}</b></summary>${hint}<div class="sd-dropdown-body sd-scroll sd-storyboard-worldbook-entry-list">${entryRows || '<p class="sd-muted">暂无条目</p>'}</div>${actions}</details>` : '<div class="sd-storyboard-empty-inline">选择一本世界书后查看条目。</div>'}`
        : '<div class="sd-storyboard-empty-inline">未读取到世界书。</div>';
  return `<details class="sd-card sd-storyboard-worldbook-card" data-storyboard-card="worldbook" ${collapsed.worldbook ? '' : 'open'}>
    <summary><span><b>世界书</b></span><button type="button" class="sd-icon-btn sd-icon-sm sd-storyboard-refresh-worldbooks" title="重新读取世界书" aria-label="重新读取世界书"><i class="fa-solid fa-rotate"></i></button></summary>
    <div class="sd-storyboard-card-body">${body}</div>
  </details>`;
}
