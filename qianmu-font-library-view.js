import { qianmuIconMarkup } from './qianmu-icon-renderer.js?v=1.59.470';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const FONT_LIBRARY_PAGE_SIZE = 10;
export const FONT_LIBRARY_PREVIEW_TEXT = '一蝶振翅，万象入幕。';
const array = value => Array.isArray(value) ? value : [];
const strings = value => [...new Set(array(value).filter(item => typeof item === 'string' && item))];
const parseTags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，]/)).map(tag => String(tag).trim()).filter(Boolean))];
export function collectFontLibraryTags(state = {}) { return parseTags(array(state.entries).flatMap(entry => array(entry?.tags))); }
const styles = value => /^(?:normal|italic|oblique)/.test(String(value)) ? String(value).split(' ')[0] : 'normal';
const styleLabel = value => ({ normal: '常规', italic: '斜体', oblique: '倾斜' })[value] || value;
const options = (values, selected, label = value => value) => values.map(value => `<option value="${escape(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escape(label(value))}</option>`).join('');
const icon = name => qianmuIconMarkup(name);
const nameOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const sortLabels = { asc: '名称正序', desc: '名称倒序', 'added-asc': '添加时间正序', 'added-desc': '添加时间倒序' };
const sortValue = state => `${state.sortBy === 'added' ? 'added-' : ''}${state.sortOrder === 'desc' ? 'desc' : 'asc'}`;
const validPreviewSize = value => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 256;
function iconButton(action, name, title, attributes = '', classes = '') {
    return `<button type="button" class="sd-icon-btn qm-font-icon ${classes}" data-font-action="${action}" aria-label="${escape(title)}" title="${escape(title)}" ${attributes}>${icon(name)}</button>`;
}
function tagEditor(key, input) {
    return `<div class="qm-font-tag-editor" data-font-tag-editor="${escape(key)}"><div class="qm-font-tag-input">${input}${iconButton('tags', 'fa-plus', '选择已有标签', `data-font-tag-target="${escape(key)}" aria-expanded="false"`)}</div><div class="qm-font-tag-options" data-font-tag-options="${escape(key)}" role="group" aria-label="已有标签" hidden></div></div>`;
}
function fontStyles(entry) {
    const available = strings(array(entry?.faces).length ? entry.faces.map(face => face.style || 'normal') : entry?.styles).map(styles);
    return available.length ? [...new Set(available)] : ['normal'];
}
function supportedWeights(entry, style) {
    const matching = array(entry?.faces).filter(face => styles(face.style || 'normal') === style);
    const declared = matching.length ? matching.map(face => String(face.weight || '400')) : array(entry?.weights);
    const values = [...new Set(declared.map(raw => raw === 'normal' ? '400' : raw === 'bold' ? '700' : String(raw)))].flatMap(value => {
        if (!/^\d{1,4}(?: \d{1,4})?$/.test(value)) return [];
        const [first, last = first] = value.split(' ').map(Number);
        if (first < 1 || last > 1000 || last < first) return [];
        return Array.from({ length: last - first + 1 }, (_, index) => first + index);
    });
    return [...new Set(values.length ? values : [400])].sort((a, b) => a - b);
}
function choice(entry, current = {}) {
    const available = fontStyles(entry), style = available.includes(current.style) ? current.style : available[0], weights = supportedWeights(entry, style), requested = Number(current.weight);
    return { weight: String(weights.includes(requested) ? requested : weights.includes(400) ? 400 : weights[0]), style };
}
export function fontLibraryWeightControl(entry, current = {}) {
    const selected = choice(entry, current), values = supportedWeights(entry, selected.style), continuous = values.length > 1 && values.at(-1) - values[0] + 1 === values.length;
    return { values, min: continuous ? values[0] : 0, max: continuous ? values.at(-1) : values.length - 1, step: 1,
        value: continuous ? Number(selected.weight) : values.indexOf(Number(selected.weight)), weight: selected.weight, continuous, disabled: values.length < 2 };
}
function activeTargets(state, id) {
    if (state.mode === 'shared') return state.shared?.enabled && state.shared.fontId === id ? ['shared'] : [];
    return ['body', 'st'].filter(target => state[target]?.enabled && state[target].fontId === id);
}
function initialChoice(state, entry, draft) { const target = activeTargets(state, entry.id)[0]; return choice(entry, draft || (target ? state[target] : {})); }
function hasVariants(entry, selected) { return fontStyles(entry).length > 1 || !fontLibraryWeightControl(entry, selected).disabled; }
function pinMarker(entry, selected, view) { return `<span class="qm-font-pin-mark" aria-label="已置顶" title="已置顶"${view.managing || (hasVariants(entry, selected) && view.expandedId !== entry.id) ? '' : ' hidden'}>${icon('qm-fill-push-pin')}</span>`; }
function applyControl(state, entry) {
    const active = activeTargets(state, entry.id), labels = { body: '正文', st: '界面', shared: '全部' };
    const current = active.length > 1 ? '全部' : active.length ? labels[active[0]] : '应用字体';
    const restore = active.includes('st') ? '<option value="restore-st">恢复界面</option>' : '';
    return `<label class="sd-icon-btn qm-font-icon qm-font-apply-pick" data-applied="${active.length > 0}" title="${escape(current)}">${icon(active.length ? 'font-applied' : 'font-apply')}<select class="qm-font-apply" data-font-apply="${escape(entry.id)}" aria-label="${escape(entry.name)}应用"><option value="body">正文</option><option value="st">界面</option><option value="shared">全部</option>${restore}</select></label>`;
}
function variantTools(entry, current) {
    const selected = choice(entry, current), range = fontLibraryWeightControl(entry, selected), available = fontStyles(entry), id = escape(entry.id);
    return `${range.disabled ? '' : `<div class="qm-font-weight-pick">${iconButton('weight', 'fa-sliders', '调整字重', `data-font-id="${id}" aria-expanded="false"`)}<div class="qm-font-weight-pop" data-font-weight-pop="${id}" hidden><input type="range" data-font-weight="${id}" aria-label="${escape(entry.name)}字重" aria-valuetext="${range.weight}" min="${range.min}" max="${range.max}" step="1" value="${range.value}"><output data-font-weight-value="${id}">${range.weight}</output></div></div>`}${available.length > 1 ? `<label class="sd-icon-btn qm-font-style-pick qm-font-icon" title="字形：${styleLabel(selected.style)}">${icon('fa-font')}<select data-font-style="${id}" aria-label="${escape(entry.name)}字形">${options(available, selected.style, styleLabel)}</select></label>` : ''}`;
}
export function fontLibraryPreviewSize(state = {}, view = {}) {
    const baseline = validPreviewSize(state.defaultPreviewSize) ? Number(state.defaultPreviewSize) : 18, value = validPreviewSize(view.previewSizeOverride) ? Number(view.previewSizeOverride) : baseline;
    return { values: [12, 14, 16, 18, 20], value };
}
function cardTools(state, entry, selected, view = {}) {
    const id = escape(entry.id), variants = hasVariants(entry, selected), expanded = variants && view.expandedId === entry.id, pinned = array(state.pinnedIds).includes(entry.id);
    const pin = iconButton('pin', pinned ? 'qm-fill-push-pin' : 'qm-regular-push-pin', pinned ? `取消置顶 ${entry.name}` : `置顶 ${entry.name}`, `data-font-id="${id}" aria-pressed="${pinned}"`, pinned ? 'is-pinned' : '');
    const builtin = entry.source?.kind === 'builtin';
    const editing = builtin ? '' : iconButton('edit', 'fa-pen', `编辑 ${entry.name}`, `data-font-id="${id}"`) + iconButton('delete-one', 'fa-trash', `删除 ${entry.name}`, `data-font-id="${id}"`);
    return `${variants ? iconButton('more', 'fa-ellipsis', expanded ? '收起字体操作' : '更多字体操作', `data-font-id="${id}" aria-expanded="${expanded}"`) : ''}${expanded ? variantTools(entry, selected) + pin + editing : !variants ? pin + editing : ''}${expanded ? '' : applyControl(state, entry)}`;
}
function localUploadDialog(view) {
    if (!array(view.localUploads).length) return '';
    return `<div class="qm-font-local-layer" data-font-local-layer><section class="sd-card qm-font-local-dialog" data-font-local-dialog role="dialog" aria-modal="true" aria-label="上传本地字体"><h3>上传本地字体</h3><div class="qm-font-local-files">${view.localUploads.map((item, index) => `<div class="qm-font-local-file"><p title="${escape(item.fileName)}">${escape(item.fileName)}</p><label>名称<input data-font-local-name="${index}" value="${escape(item.name)}" maxlength="160" aria-label="第 ${index + 1} 款字体名称"></label><div class="qm-font-local-tag-field"><span>标签</span>${tagEditor(`local-${index}`, `<input data-font-local-tags="${index}" value="${escape(item.tags)}" maxlength="2623" placeholder="如：宋体,黑体，多个标签用逗号分隔" aria-label="第 ${index + 1} 款字体标签">`)}</div></div>`).join('')}</div><footer><button type="button" class="sd-btn" data-font-action="local-cancel">取消</button><button type="button" class="sd-btn" data-font-action="local-confirm">加入字体库</button></footer></section></div>`;
}
export function sortFontLibraryEntries(state = {}) {
    const pinned = new Map(strings(state.pinnedIds).map((id, index) => [id, index])), direction = state.sortOrder === 'desc' ? -1 : 1;
    return array(state.entries).map((entry, index) => ({ entry, index })).filter(({ entry }) => entry && typeof entry.id === 'string').sort((left, right) => {
        const a = pinned.get(left.entry.id), b = pinned.get(right.entry.id);
        if (a !== undefined || b !== undefined) return a === undefined ? 1 : b === undefined ? -1 : a - b || left.index - right.index;
        return direction * (state.sortBy === 'added' ? left.index - right.index : nameOrder.compare(String(left.entry.name || ''), String(right.entry.name || ''))) || left.index - right.index;
    }).map(({ entry }) => entry);
}
function matchingEntries(state, view) {
    const query = String(view.query || '').trim().toLocaleLowerCase();
    return sortFontLibraryEntries(state).filter(entry => !query || [entry.name, ...array(entry.tags)].join(' ').toLocaleLowerCase().includes(query));
}
export function selectFontLibraryPage(state = {}, view = {}) {
    const filtered = matchingEntries(state, view);
    const pages = Math.max(1, Math.ceil(filtered.length / FONT_LIBRARY_PAGE_SIZE)), page = Math.max(0, Math.min(pages - 1, Math.floor(Number(view.page) || 0)));
    return { entries: filtered.slice(page * FONT_LIBRARY_PAGE_SIZE, (page + 1) * FONT_LIBRARY_PAGE_SIZE), total: filtered.length, page, pages };
}
export function renderFontLibraryCards(state = {}, view = {}) {
    const page = selectFontLibraryPage(state, view), selected = new Set(array(view.selected));
    const cards = page.entries.map(entry => {
        const value = initialChoice(state, entry, view.variants?.[entry.id]), id = escape(entry.id), metadata = strings(entry.tags).map(tag => `<span class="qm-font-tag">${escape(tag)}</span>`).join('');
        const pinned = array(state.pinnedIds).includes(entry.id), renameVisible = !view.managing && view.renameId === entry.id && (!hasVariants(entry, value) || view.expandedId === entry.id);
        const editor = `<div class="qm-font-rename-pop" data-font-rename-pop="${id}"${renameVisible ? '' : ' hidden'}><div class="qm-font-rename-row"><input data-font-rename="${id}" aria-label="字体名称" maxlength="160" value="${escape(view.renameId === entry.id ? view.renameDraft : entry.name)}">${iconButton('rename-save', 'fa-check', '保存字体修改', `data-font-id="${id}"`)}${iconButton('rename-cancel', 'fa-xmark', '取消编辑字体', `data-font-id="${id}"`)}</div>${tagEditor(`rename-${entry.id}`, `<input data-font-rename-tags="${id}" type="text" maxlength="2623" placeholder="如：宋体,黑体，多个标签用逗号分隔" value="${escape(view.renameId === entry.id ? view.renameTags ?? array(entry.tags).join(', ') : array(entry.tags).join(', '))}" aria-label="字体标签">`)}</div>`;
        return `<article class="sd-card qm-font-card${view.managing ? ` is-selecting${selected.has(entry.id) ? ' is-selected' : ''}` : ''}" data-font-id="${id}"${view.managing ? ` role="button" tabindex="0" aria-label="选择 ${escape(entry.name)}" aria-pressed="${selected.has(entry.id)}"` : ''}><div class="qm-font-card-head"><div class="qm-font-name"><strong title="${escape(entry.name)}">${escape(entry.name)}</strong>${pinned ? pinMarker(entry, value, view) : ''}</div><div class="qm-font-card-tools"${view.managing ? ' hidden' : ''}>${cardTools(state, entry, value, view)}</div></div>${editor}<p class="qm-font-sample qm-font-preview" data-font-sample="${id}">${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}</p><div class="qm-font-card-foot"><span class="qm-font-meta">${metadata}</span></div><span class="qm-font-load-state" data-font-load-state="${id}" aria-live="polite">${escape(entry.status || '')}</span></article>`;
    }).join('');
    return `<div class="qm-font-list">${cards || '<p class="sd-muted qm-font-empty">没有符合条件的字体</p>'}</div><div class="qm-font-pagination">${iconButton('previous', 'fa-chevron-left', '上一页字体', page.page ? '' : 'disabled')}<span>${page.page + 1} / ${page.pages} · ${page.total} 款</span><div class="qm-font-page-end">${iconButton('top', 'fa-arrow-up', '回到顶部')}${iconButton('next', 'fa-chevron-right', '下一页字体', page.page + 1 < page.pages ? '' : 'disabled')}</div></div>`;
}
export function renderFontLibrary(state = {}, view = {}) {
    const selected = array(view.selected).length, previewSize = fontLibraryPreviewSize(state, view);
    return `<header class="sd-header qm-font-header"${array(view.localUploads).length ? ' inert' : ''}><h2>字体库管理</h2>${iconButton('back', 'fa-arrow-left', '返回正文排版')}</header><main class="sd-body"${array(view.localUploads).length ? ' inert' : ''}><div class="qm-font-library sd-reader-lib sd-reader-lib-list">
      <label class="sd-card sd-switch-row qm-font-enable"><strong>启用字体库</strong><input type="checkbox" role="switch" data-font-enabled aria-label="启用字体库"${state.enabled !== false ? ' checked' : ''}></label>
      <label class="sd-card sd-switch-row qm-font-original-sync"><span><strong>同步本地字体原件</strong><small class="sd-muted">仅在开启后上传到当前 ST 账户</small></span><input type="checkbox" role="switch" data-font-sync-originals aria-label="同步本地字体原件"${state.syncLocalOriginals === true ? ' checked' : ''}></label>
      <details class="sd-card qm-font-add"${(view.addOpen ?? !array(state.entries).length) ? ' open' : ''}><summary><b>添加字体</b><div class="qm-font-add-actions">${view.editWebId ? iconButton('cancel-web', 'fa-xmark', '取消编辑字体') : ''}${iconButton('add-web', 'fa-check', view.editWebId ? '保存字体修改' : '加入字体库')}</div></summary><div class="qm-font-web"><label class="qm-font-web-label">名称<input data-font-web-name type="text" maxlength="160" placeholder="可选，留空使用字体名" autocomplete="off" value="${escape(view.webName || '')}"></label><div class="qm-font-web-label"><span>字体链接</span><textarea data-font-web-source aria-label="字体链接" rows="3" placeholder="${view.editWebId && view.editWebSourceMissing ? '留空保留当前来源；替换时粘贴新链接' : '字体文件链接、字体 CSS 链接、@import 或 @font-face'}" spellcheck="false">${escape(view.webSource || '')}</textarea></div><div class="qm-font-web-label"><span>标签</span>${tagEditor('web', `<input data-font-web-tags type="text" maxlength="2623" placeholder="如：宋体,黑体，多个标签用逗号分隔" value="${escape(view.webTags || '')}" aria-label="字体标签">`)}</div></div>
      <div class="qm-font-imports"><label class="sd-btn qm-font-file-pick" title="上传本地字体">上传本地字体<input class="sd-reader-native-file" type="file" data-font-file="local" accept=".woff2,.woff,.ttf,.otf" aria-label="上传本地字体" multiple></label><label class="sd-btn qm-font-file-pick" title="导入字体包">导入字体包<input class="sd-reader-native-file" type="file" data-font-file="import" accept=".json,application/json" aria-label="导入字体包"></label></div>
      </details>
      <section class="sd-card qm-font-preview-editor"><div class="qm-font-field-head"><span>预览文案</span><label class="sd-icon-btn qm-font-icon qm-font-size-pick" title="预览字号">${icon('font-preview-size')}<select data-font-preview-size aria-label="预览字号">${previewSize.values.includes(previewSize.value) ? '' : `<option value="${previewSize.value}" selected disabled>当前 ${previewSize.value}px</option>`}${options(previewSize.values, previewSize.value, value => `${value}px`)}</select></label></div><input data-font-preview type="text" maxlength="500" value="${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}" aria-label="预览文案"></section>
      <div class="sd-reader-lib-bar qm-font-toolbar"><input type="search" class="sd-reader-search" data-font-search value="${escape(view.query || '')}" placeholder="搜索字体 / 标签" aria-label="搜索字体">${iconButton('manage', 'font-manage', view.managing ? '退出多选' : '多选', `aria-expanded="${!!view.managing}"`, `sd-reader-batch-mode${view.managing ? ' active' : ''}`)}<label class="sd-icon-btn qm-font-icon qm-font-sort-pick" title="按名称或添加时间排序；置顶顺序不变">${icon('fa-arrow-down-wide-short')}<select data-font-sort-order aria-label="字体排序">${options(Object.keys(sortLabels), sortValue(state), value => sortLabels[value])}</select></label></div>
      <div class="sd-reader-batch-actions qm-font-bulk-actions"${view.managing ? '' : ' hidden'}>${iconButton('select-page', 'fa-check-double', '全选 / 取消本页', 'aria-pressed="false"', 'sd-reader-batch-toggle-all')}${iconButton('bulk-tags', 'fa-tags', '设置选中标签', selected ? '' : 'disabled')}${iconButton('export-selected', 'fa-file-export', '导出选中字体包', selected ? '' : 'disabled')}${iconButton('delete', 'fa-trash', '移除选中', selected ? '' : 'disabled')}<span data-font-selection-count>已选 ${selected}</span></div>
      <div class="qm-font-bulk-editor" data-font-bulk-editor hidden><div class="qm-font-bulk-field"><span>设置标签</span>${tagEditor('bulk', '<input data-font-bulk-value maxlength="2623" placeholder="逗号分隔；留空清除" aria-label="选中字体的标签">')}</div>${iconButton('bulk-save', 'fa-check', '保存标签')}</div><div data-font-cards>${renderFontLibraryCards(state, view)}</div>
    </div></main>${localUploadDialog(view)}`;
}

/** Sample font changes are local to cards; only apply-font writes host choices. */
export function createFontLibraryView({ root, getState, onAction, onVisibleFonts, onBack, notify = () => {}, initialSession = {}, fontFamily = () => '' } = {}) {
    if (!root || typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('字体库视图缺少宿主');
    let disposed = false, busy = false, rendered = false, page = Number(initialSession?.page) || 0, query = String(initialSession?.query || ''), managing = false,
        previewDraft = typeof initialSession?.previewDraft === 'string' ? initialSession.previewDraft.slice(0, 500) : undefined,
        previewSizeOverride = validPreviewSize(initialSession?.previewSizeOverride) ? Number(initialSession.previewSizeOverride) : undefined,
        webName = String(initialSession?.webName || ''), webSource = String(initialSession?.webSource || ''), webTags = String(initialSession?.webTags || ''), editWebId = String(initialSession?.editWebId || ''), editWebSourceMissing = initialSession?.editWebSourceMissing === true,
        addOpen = typeof initialSession?.addOpen === 'boolean' ? initialSession.addOpen : !!initialSession?.editWebId || !array(getState().entries).length,
        renameId = String(initialSession?.renameId || ''), renameDraft = String(initialSession?.renameDraft || ''), renameTags = typeof initialSession?.renameTags === 'string' ? initialSession.renameTags : undefined, expandedId = String(initialSession?.renameId || ''), bulk = false, localUploads = [], tagTarget = '';
    const selected = new Set(), variants = Object.create(null), loadingStates = new Map();
    for (const entry of array(getState().entries)) { if (initialSession?.variants?.[entry.id]) variants[entry.id] = choice(entry, initialSession.variants[entry.id]); if (renameId === entry.id && renameTags === undefined) renameTags = array(entry.tags).join(', '); }
    const state = () => ({ ...getState(), ...(previewDraft === undefined ? {} : { previewText: previewDraft }) });
    const viewState = () => ({ page, query, selected: [...selected], variants, managing, webName, webSource, webTags, editWebId, editWebSourceMissing, addOpen, localUploads, renameId, renameDraft, renameTags, expandedId, previewSizeOverride });
    const q = selector => root.querySelector(selector), qa = selector => [...root.querySelectorAll(selector)];
    const tagInput = key => key === 'web' ? q('[data-font-web-tags]') : key === 'bulk' ? q('[data-font-bulk-value]') : key.startsWith('rename-') ? qa('[data-font-rename-tags]').find(node => node.dataset.fontRenameTags === key.slice(7)) : /^local-\d+$/.test(key) ? q(`[data-font-local-tags="${Number(key.slice(6))}"]`) : null;
    const tagPanel = key => qa('[data-font-tag-options]').find(node => node.dataset.fontTagOptions === key);
    function closeTags({ focus = false } = {}) {
        if (!tagTarget) return false;
        const key = tagTarget; tagTarget = ''; const panel = tagPanel(key); if (panel) { panel.hidden = true; panel.innerHTML = ''; }
        const button = qa('[data-font-action="tags"]').find(node => node.dataset.fontTagTarget === key); button?.setAttribute('aria-expanded', 'false'); if (focus) button?.focus({ preventScroll: true }); return true;
    }
    function renderTagOptions() {
        const panel = tagPanel(tagTarget), input = tagInput(tagTarget); if (!panel || !input) return;
        const selectedTags = new Set(parseTags(input.value)), available = collectFontLibraryTags(state());
        panel.innerHTML = available.length ? available.map(tag => { const unavailable = /[,，]/.test(tag); return `<button type="button" class="qm-font-tag-choice" data-font-action="tag-toggle" data-font-tag-target="${escape(tagTarget)}" data-font-tag="${escape(tag)}" aria-pressed="${selectedTags.has(tag)}"${unavailable ? ' data-font-tag-unavailable="true" disabled title="标签含逗号，暂不支持快捷选择"' : busy ? ' disabled' : ''}>${escape(tag)}</button>`; }).join('') : '<p class="qm-font-tag-empty">暂无已有标签</p>';
    }
    function toggleTagPanel(key) {
        if (!tagInput(key) || !tagPanel(key)) return;
        if (tagTarget === key) { closeTags(); return; } closeTags(); tagTarget = key; renderTagOptions(); tagPanel(key).hidden = false;
        qa('[data-font-action="tags"]').find(node => node.dataset.fontTagTarget === key)?.setAttribute('aria-expanded', 'true');
        if (key === `rename-${renameId}`) showLocalEditor();
    }
    function toggleTag(key, tag) {
        const input = tagInput(key); if (busy || tagTarget !== key || !input || /[,，]/.test(tag) || !collectFontLibraryTags(state()).includes(tag)) return;
        const tags = parseTags(input.value), existed = tags.includes(tag); if (!existed && tags.length >= 32) { message('每款字体最多 32 个标签。', { error: true }); return; }
        input.value = (existed ? tags.filter(value => value !== tag) : [...tags, tag]).join(', ');
        if (key === 'web') webTags = input.value; else if (key === `rename-${renameId}`) renameTags = input.value; else if (/^local-\d+$/.test(key) && localUploads[Number(key.slice(6))]) localUploads[Number(key.slice(6))].tags = input.value;
        renderTagOptions(); qa('[data-font-action="tag-toggle"]').find(node => node.dataset.fontTagTarget === key && node.dataset.fontTag === tag)?.focus({ preventScroll: true });
    }
    function closeTagsOutside(target) { if (tagTarget && target.closest?.('[data-font-tag-editor]')?.dataset.fontTagEditor !== tagTarget) closeTags(); }
    function message(text, { error = false } = {}) { if (!disposed && text) notify(String(text), error ? 'warning' : 'info'); }
    function captureWeb() { if (q('[data-font-web-name]')) webName = q('[data-font-web-name]').value; if (q('[data-font-web-source]')) webSource = q('[data-font-web-source]').value; if (q('[data-font-web-tags]')) webTags = q('[data-font-web-tags]').value; if (q('.qm-font-add')) addOpen = q('.qm-font-add').open; }
    function clearWebDraft({ id = '', name = '', source = '', tags: submittedTags = [] } = {}) { if (disposed) return false; captureWeb(); if (editWebId !== String(id) || webName !== String(name) || webSource !== String(source) || JSON.stringify(parseTags(webTags)) !== JSON.stringify(parseTags(submittedTags))) return false; editWebId = ''; editWebSourceMissing = false; webName = ''; webSource = ''; webTags = ''; for (const selector of ['[data-font-web-name]', '[data-font-web-source]', '[data-font-web-tags]']) { const field = q(selector); if (field) field.value = ''; } return true; }
    function captureSession() { captureWeb(); return { page, query, variants: Object.fromEntries(Object.entries(variants).map(([id, value]) => [id, { ...value }])), previewDraft, previewSizeOverride, webName, webSource, webTags, editWebId, editWebSourceMissing, addOpen, renameId, renameDraft, renameTags: renameTags ?? '', scrollTop: Math.max(0, Number(q('.sd-body')?.scrollTop) || 0) }; }
    function sizeSamples(current = state()) { const { value } = fontLibraryPreviewSize(current, viewState()); for (const node of qa('[data-font-sample]')) node.style.setProperty('font-size', `${value}px`, 'important'); }
    function previewSize(target) { const range = fontLibraryPreviewSize(state(), viewState()), value = Number(target.value); if (!range.values.includes(value)) return; previewSizeOverride = value; sizeSamples(); }
    function setWebDraft(id, name, source, entryTags = [], missing = false) { editWebId = id; editWebSourceMissing = missing === true; webName = name; webSource = source; webTags = parseTags(entryTags).join(', '); addOpen = true; for (const [selector, value] of [['[data-font-web-name]', webName], ['[data-font-web-source]', webSource], ['[data-font-web-tags]', webTags]]) { const field = q(selector); if (field) field.value = value; } if (q('.qm-font-add')) q('.qm-font-add').open = true; render(); }
    function setBusy(value) { busy = value; root.setAttribute('aria-busy', String(value)); for (const control of [q('[data-font-enabled]'), q('[data-font-sync-originals]')]) if (control) control.disabled = value; for (const selector of ['[data-font-local-dialog] input,[data-font-local-dialog] button,[data-font-tag-editor] input,[data-font-tag-editor] button', '[data-font-rename-pop] input,[data-font-rename-pop] button']) for (const control of qa(selector)) control.disabled = value || control.dataset.fontTagUnavailable === 'true'; }
    function cancelLocal() { if (busy || !localUploads.length) return; localUploads = []; render(); q('[data-font-file="local"]')?.focus({ preventScroll: true }); }
    function samples(notify = true, current = state()) {
        const ids = [], previewChoices = {};
        for (const node of qa('[data-font-sample]')) {
            const id = node.dataset.fontSample, entry = array(current.entries).find(item => item.id === id), variant = initialChoice(current, entry || {}, variants[id]), family = fontFamily(id);
            node.style.setProperty('font-family', typeof family === 'string' ? family : '', 'important'); node.style.setProperty('font-weight', variant.weight, 'important'); node.style.setProperty('font-style', variant.style, 'important');
            ids.push(id); previewChoices[id] = variant;
        }
        for (const node of qa('[data-font-load-state]')) if (loadingStates.has(node.dataset.fontLoadState)) node.textContent = loadingStates.get(node.dataset.fontLoadState);
        sizeSamples(current);
        if (notify) try { Promise.resolve(onVisibleFonts?.(ids, previewChoices)).catch(() => { if (!disposed) message('部分字体预览暂未载入。', { error: true }); }); } catch { message('字体预览暂未载入。', { error: true }); }
    }
    function selection(current = state()) {
        const visible = selectFontLibraryPage(current, viewState()).entries, all = visible.length > 0 && visible.every(entry => selected.has(entry.id)); q('[data-font-action="select-page"]')?.setAttribute('aria-pressed', String(all));
        const count = q('[data-font-selection-count]'); if (count) count.textContent = `已选 ${selected.size}`;
        const manager = q('[data-font-action="manage"]'); if (manager) { manager.setAttribute('aria-expanded', String(managing)); manager.setAttribute('aria-label', managing ? '退出多选' : '多选'); manager.title = managing ? '退出多选' : '多选'; manager.classList.toggle('active', managing); }
        const actions = q('.qm-font-bulk-actions'); if (actions) actions.hidden = !managing;
        for (const action of ['bulk-tags', 'export-selected', 'delete']) { const button = q(`[data-font-action="${action}"]`); if (button) button.disabled = !selected.size; }
        for (const card of qa('.qm-font-card')) {
            const id = card.dataset.fontId, entry = array(current.entries).find(item => item.id === id);
            card.classList.toggle('is-selecting', managing); card.classList.toggle('is-selected', managing && selected.has(id));
            if (managing) { card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0'); card.setAttribute('aria-label', `选择 ${entry?.name || ''}`); card.setAttribute('aria-pressed', String(selected.has(id))); }
            else for (const attribute of ['role', 'tabindex', 'aria-label', 'aria-pressed']) card.removeAttribute?.(attribute);
            const tools = card.querySelector?.('.qm-font-card-tools'); if (tools) tools.hidden = managing;
            const rename = card.querySelector?.('[data-font-rename-pop]'); if (rename) rename.hidden = managing || renameId !== id || (entry && hasVariants(entry, initialChoice(current, entry, variants[id])) && expandedId !== id);
            const mark = card.querySelector?.('.qm-font-pin-mark'); if (mark && entry) mark.hidden = !managing && (!hasVariants(entry, initialChoice(current, entry, variants[id])) || expandedId === id);
        }
        for (const picker of qa('[data-font-apply]')) picker.selectedIndex = -1;
        if (!managing || !selected.size) { const editor = q('[data-font-bulk-editor]'); if (editor) editor.hidden = true; bulk = false; if (tagTarget === 'bulk') closeTags(); }
    }
    function renderCards() { if (disposed) return; const host = q('[data-font-cards]'); if (!host) return; closeTags(); const current = state(); page = selectFontLibraryPage(current, viewState()).page; host.innerHTML = renderFontLibraryCards(current, viewState()); setBusy(busy); selection(current); samples(true, current); }
    function showLocalEditor({ focus = false } = {}) {
        const panel = qa('[data-font-rename-pop]').find(node => node.dataset.fontRenamePop === renameId), body = q('.sd-body');
        if (!panel || panel.hidden) return;
        if (panel.getBoundingClientRect && body?.getBoundingClientRect) {
            const rect = panel.getBoundingClientRect(), bounds = body.getBoundingClientRect(), top = bounds.top + 6, bottom = bounds.bottom - 6;
            body.scrollTop += rect.height > bottom - top || rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
        }
        if (focus) qa('[data-font-rename]').find(node => node.dataset.fontRename === renameId)?.focus({ preventScroll: true });
    }
    function render(snapshot) {
        if (disposed) return;
        const scrollTop = rendered ? Number(q('.sd-body')?.scrollTop) || 0 : Number(initialSession?.scrollTop) || 0; captureWeb();
        const current = snapshot || state(), liveIds = new Set(array(current.entries).map(entry => entry.id));
        for (const id of selected) if (!liveIds.has(id)) selected.delete(id);
        page = selectFontLibraryPage(current, viewState()).page; tagTarget = ''; root.innerHTML = renderFontLibrary(current, viewState()); setBusy(busy); selection(current); samples(true, current);
        const body = q('.sd-body'); if (body) body.scrollTop = Math.max(0, scrollTop); rendered = true;
    }
    function locateFont(id, { reveal = false } = {}) {
        if (disposed) return false;
        const current = state(), index = matchingEntries(current, { query: reveal ? '' : query }).findIndex(entry => entry.id === id); if (index < 0) return false;
        if (reveal) { query = ''; selected.clear(); } page = Math.floor(index / FONT_LIBRARY_PAGE_SIZE); render(current);
        const card = qa('.qm-font-card').find(node => node.dataset.fontId === id), body = q('.sd-body');
        if (card) { card.setAttribute('data-font-revealed', 'true'); if (body && card.getBoundingClientRect && body.getBoundingClientRect) body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top - 6; }
        return true;
    }
    function revealFont(id) { return locateFont(id, { reveal: true }); }
    async function dispatch(type, payload = {}, { refresh = true, exclusive = true } = {}) {
        if (disposed || (exclusive && busy)) return; if (exclusive) setBusy(true); message('');
        try { const result = await onAction({ type, ...payload }); if (!disposed && refresh) { if (type === 'add-web' || type === 'edit-web') clearWebDraft(payload); if (type === 'add-local') localUploads = []; if (type === 'update-fonts' && 'name' in payload && payload.ids?.[0] === renameId) { renameId = ''; renameDraft = ''; renameTags = ''; } if (type === 'set-sort-order') page = 0; if (result?.revealFontId) revealFont(result.revealFontId); else if (type !== 'set-font-pinned' || !locateFont(payload.id)) render(); } }
        catch (error) { if (!disposed) { if (type === 'set-enabled') { const enabled = q('[data-font-enabled]'); if (enabled) enabled.checked = getState().enabled !== false; } if (type === 'set-sync-local-originals') { const sync = q('[data-font-sync-originals]'); if (sync) sync.checked = getState().syncLocalOriginals === true; } if (type === 'set-sort-order') { const order = q('[data-font-sort-order]'); if (order) order.value = sortValue(getState()); } message(error?.userMessage || '操作未完成，请检查输入或稍后重试。', { error: true }); } }
        finally { if (exclusive) { busy = false; if (!disposed) setBusy(false); } }
    }
    function closePopovers() { for (const pop of qa('[data-font-weight-pop]')) pop.hidden = true; for (const button of qa('[data-font-action="weight"]')) button.setAttribute('aria-expanded', 'false'); }
    function refreshTools(id) {
        const current = state(), entry = array(current.entries).find(item => item.id === id), card = qa('.qm-font-card').find(node => node.dataset.fontId === id), host = card?.querySelector('.qm-font-card-tools');
        if (!entry || !host) return;
        host.innerHTML = cardTools(current, entry, initialChoice(current, entry, variants[id]), viewState());
        for (const picker of host.querySelectorAll('[data-font-apply]')) picker.selectedIndex = -1;
        const rename = card.querySelector('[data-font-rename-pop]'); if (rename) rename.hidden = managing || renameId !== id || (hasVariants(entry, initialChoice(current, entry, variants[id])) && expandedId !== id);
        const mark = card.querySelector('.qm-font-pin-mark'); if (mark) mark.hidden = !managing && (!hasVariants(entry, initialChoice(current, entry, variants[id])) || expandedId === id);
    }
    function collapseMore({ focus = false } = {}) {
        if (!expandedId) return false;
        const id = expandedId; expandedId = ''; closePopovers(); refreshTools(id);
        if (focus) qa('[data-font-action="more"]').find(node => node.dataset.fontId === id)?.focus({ preventScroll: true });
        return true;
    }
    function collapseOutside(target) {
        if (!expandedId) return;
        const card = target.closest?.('.qm-font-card'), inside = card?.dataset.fontId === expandedId && ['.qm-font-card-tools', '[data-font-weight-pop]', '[data-font-rename-pop]'].some(selector => target.closest?.(selector));
        if (!inside) collapseMore();
    }
    function toggleCard(card) { const id = card?.dataset.fontId; if (!id || !array(state().entries).some(entry => entry.id === id)) return; selected.has(id) ? selected.delete(id) : selected.add(id); selection(); }
    function setVariant(id, patch, notify = true) {
        const current = state(), entry = array(current.entries).find(item => item.id === id); if (!entry) return; variants[id] = choice(entry, { ...initialChoice(current, entry, variants[id]), ...patch });
        if ('style' in patch) refreshTools(id);
        const range = fontLibraryWeightControl(entry, variants[id]), input = qa('[data-font-weight]').find(node => node.dataset.fontWeight === id);
        if (input) { input.min = String(range.min); input.max = String(range.max); input.value = String(range.value); input.setAttribute('aria-valuetext', range.weight); }
        const output = qa('[data-font-weight-value]').find(node => node.dataset.fontWeightValue === id); if (output) output.textContent = range.weight;
        const button = qa('[data-font-action="weight"]').find(node => node.dataset.fontId === id); if (button) button.disabled = range.disabled; samples(notify);
    }
    function dragWeight(target, notify) {
        const id = target.dataset.fontWeight, current = state(), entry = array(current.entries).find(item => item.id === id); if (!entry) return;
        const range = fontLibraryWeightControl(entry, initialChoice(current, entry, variants[id])), value = Number(target.value), weight = range.continuous ? Math.max(range.min, Math.min(range.max, Math.round(value))) : range.values[Math.max(0, Math.min(range.values.length - 1, Math.round(value)))];
        if (Number.isFinite(weight)) setVariant(id, { weight: String(weight) }, notify);
    }
    async function click(event) {
        const target = event.target; if (!root.contains(target) || disposed) return;
        const navigation = target.closest?.('[data-font-action]'); if (navigation?.closest?.('.qm-font-add>summary') || target.closest?.('.qm-font-add-actions')) event.preventDefault?.(); if (navigation?.dataset.fontAction === 'back') return onBack?.();
        if (busy) return;
        if (target.matches?.('[data-font-local-layer]')) return cancelLocal();
        if (localUploads.length && !target.closest?.('[data-font-local-dialog]') && !['local-confirm', 'local-cancel'].includes(navigation?.dataset.fontAction)) return;
        closeTagsOutside(target);
        collapseOutside(target);
        const selectedCard = target.closest?.('.qm-font-card'); if (managing && selectedCard) { toggleCard(selectedCard); return; }
        const button = target.closest?.('[data-font-action]');
        if (!button || button.disabled) {
            if (!target.closest?.('[data-font-weight-pop]')) closePopovers();
            return;
        }
        const action = button.dataset.fontAction;
        if (action === 'tags') return toggleTagPanel(button.dataset.fontTagTarget);
        if (action === 'tag-toggle') return toggleTag(button.dataset.fontTagTarget, button.dataset.fontTag);
        if (action === 'local-cancel') return cancelLocal();
        if (action === 'local-confirm' && localUploads.length) return dispatch('add-local', { files: localUploads.map(item => item.file), metadata: localUploads.map(item => ({ name: item.name, tags: parseTags(item.tags) })) });
        if (action === 'weight') { const pop = qa('[data-font-weight-pop]').find(node => node.dataset.fontWeightPop === button.dataset.fontId); if (pop) { const opening = pop.hidden; closePopovers(); pop.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); if (opening) pop.querySelector('input,button')?.focus(); } return; }
        closePopovers();
        if (action === 'more') { const id = button.dataset.fontId; expandedId = expandedId === id ? '' : id; refreshTools(id); if (expandedId === renameId) showLocalEditor(); return; }
        if (action === 'pin') { const id = button.dataset.fontId; if (array(state().entries).some(entry => entry.id === id)) return dispatch('set-font-pinned', { id, pinned: !array(state().pinnedIds).includes(id) }); return; }
        if (action === 'edit') {
            const entry = array(state().entries).find(item => item.id === button.dataset.fontId); if (!entry) return;
            if (entry.sourceType === 'local' || entry.source?.kind === 'local') { if (renameId !== entry.id) { renameDraft = entry.name; renameTags = array(entry.tags).join(', '); } renameId = entry.id; renderCards(); showLocalEditor({ focus: true }); }
            else { const source = entry.editableSource ?? entry.source?.url ?? (/^https?:/i.test(entry.source?.input || '') ? entry.source.input : ''); setWebDraft(entry.id, entry.name, source, entry.tags, entry.editableSourceMissing); const body = q('.sd-body'), card = q('.qm-font-add'); if (body && card?.getBoundingClientRect && body.getBoundingClientRect) body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top - 6; q('[data-font-web-name]')?.focus({ preventScroll: true }); }
            return;
        }
        if (action === 'cancel-web') return setWebDraft('', '', '');
        if (action === 'rename-cancel') { renameId = ''; renameDraft = ''; renameTags = ''; return renderCards(); }
        if (action === 'rename-save' && renameId === button.dataset.fontId) { const entry = array(state().entries).find(item => item.id === renameId); if (!entry) return; const name = qa('[data-font-rename]').find(node => node.dataset.fontRename === renameId)?.value ?? renameDraft, draft = tagInput(`rename-${renameId}`)?.value ?? renameTags ?? '', tags = draft === array(entry.tags).join(', ') ? [...array(entry.tags)] : parseTags(draft); return dispatch('update-fonts', { ids: [renameId], name, tags }); }
        if (action === 'top') { const body = q('.sd-body'); if (body?.scrollTo) body.scrollTo({ top: 0, behavior: root.ownerDocument?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'instant' : 'smooth' }); else if (body) body.scrollTop = 0; return; }
        if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; return renderCards(); }
        if (action === 'manage') { managing = !managing; if (!managing) selected.clear(); return selection(); }
        if (action === 'select-page') { const visible = selectFontLibraryPage(state(), viewState()).entries, all = visible.length && visible.every(entry => selected.has(entry.id)); for (const entry of visible) all ? selected.delete(entry.id) : selected.add(entry.id); return selection(); }
        if (action === 'add-web') { captureWeb(); return dispatch(editWebId ? 'edit-web' : 'add-web', { ...(editWebId ? { id: editWebId } : {}), name: webName, source: webSource, tags: parseTags(webTags) }); }
        if (action === 'delete-one') { const id = button.dataset.fontId; if (array(state().entries).some(entry => entry.id === id)) return dispatch('delete-font', { id }); return; }
        if (!selected.size) return;
        if (action === 'export-selected') return dispatch('export', { ids: [...selected] }, { refresh: false });
        if (action === 'bulk-tags') { bulk = true; const editor = q('[data-font-bulk-editor]'), input = q('[data-font-bulk-value]'); if (editor) editor.hidden = false; if (input) { input.value = ''; input.focus(); } return; }
        if (action === 'bulk-save' && bulk) return dispatch('update-fonts', { ids: [...selected], tags: parseTags(q('[data-font-bulk-value]')?.value || '') });
        if (action === 'delete') return dispatch('delete-fonts', { ids: [...selected] });
    }
    function input(event) {
        const target = event.target; if (!root.contains(target) || disposed) return;
        isolateField(event);
        if (busy && (target.closest?.('[data-font-tag-editor]') || target.closest?.('[data-font-rename-pop]'))) return;
        if (target.matches?.('[data-font-preview]')) { previewDraft = target.value; for (const sample of qa('[data-font-sample]')) sample.textContent = previewDraft || FONT_LIBRARY_PREVIEW_TEXT; }
        if (target.matches?.('[data-font-search]')) { query = target.value; page = 0; selected.clear(); renderCards(); }
        if (target.matches?.('[data-font-weight]')) dragWeight(target, false);
        if (target.matches?.('[data-font-preview-size]')) previewSize(target);
        if (target.matches?.('[data-font-rename]') && target.dataset.fontRename === renameId) renameDraft = target.value;
        if (target.matches?.('[data-font-rename-tags]') && target.dataset.fontRenameTags === renameId) renameTags = target.value;
        if (target.matches?.('[data-font-local-name]') && localUploads[Number(target.dataset.fontLocalName)]) localUploads[Number(target.dataset.fontLocalName)].name = target.value;
        if (target.matches?.('[data-font-local-tags]') && localUploads[Number(target.dataset.fontLocalTags)]) localUploads[Number(target.dataset.fontLocalTags)].tags = target.value;
        if (tagTarget && target === tagInput(tagTarget)) renderTagOptions();
    }
    async function change(event) {
        isolateField(event);
        const target = event.target; if (!root.contains(target) || disposed || busy) return;
        if (target.matches?.('[data-font-enabled]')) return dispatch('set-enabled', { enabled: target.checked === true });
        if (target.matches?.('[data-font-sync-originals]')) return dispatch('set-sync-local-originals', { enabled: target.checked === true });
        if (target.matches?.('[data-font-preview-size]')) return previewSize(target);
        if (target.matches?.('[data-font-sort-order]')) { if (!Object.hasOwn(sortLabels, target.value)) return; collapseMore(); return dispatch('set-sort-order', { by: target.value.startsWith('added-') ? 'added' : 'name', order: target.value.endsWith('desc') ? 'desc' : 'asc' }); }
        if (target.matches?.('[data-font-preview]')) return dispatch('set-preview', { text: target.value }, { refresh: false, exclusive: false });
        if (target.matches?.('[data-font-file]')) { const files = [...(target.files || [])]; target.value = ''; if (!files.length) return; if (target.dataset.fontFile === 'local') { localUploads = files.map(file => ({ file, fileName: file.name, name: String(file.name || '').replace(/\.(?:woff2?|ttf|otf)$/i, '').slice(0, 160), tags: '' })); closePopovers(); render(); q('[data-font-local-name="0"]')?.focus(); return; } return dispatch('import', { file: files[0] }); }
        if (target.matches?.('[data-font-weight]')) return dragWeight(target, true);
        if (target.matches?.('[data-font-style]')) return setVariant(target.dataset.fontStyle, { style: target.value });
        if (target.matches?.('[data-font-apply]')) { const id = target.dataset.fontApply, value = target.value, current = state(), entry = array(current.entries).find(item => item.id === id); target.selectedIndex = -1; target.value = ''; if (!entry || !/^(?:body|st|shared|restore-st)$/.test(value)) return; return value === 'restore-st' ? dispatch('restore-font', { fontId: id, target: 'st' }) : dispatch('apply-font', { fontId: id, target: value, ...initialChoice(current, entry, variants[id]) }); }
    }
    function isolateField(event) { if (event.target?.closest?.('input,textarea,select')) event.stopPropagation?.(); }
    function keydown(event) {
        if (event.key === 'Escape' && tagTarget) { closeTags({ focus: !!event.target?.closest?.('[data-font-tag-options]') }); event.preventDefault?.(); event.stopPropagation?.(); return; }
        if (localUploads.length && event.key === 'Escape') { cancelLocal(); event.preventDefault?.(); event.stopPropagation?.(); return; }
        if (localUploads.length && event.key === 'Tab') { const fields = qa('[data-font-local-dialog] input,[data-font-local-dialog] button').filter(node => !node.disabled && !node.closest?.('[hidden]') && (typeof node.getClientRects !== 'function' || node.getClientRects().length)), first = fields[0], last = fields.at(-1); if (first && ((event.shiftKey && event.target === first) || (!event.shiftKey && event.target === last))) { (event.shiftKey ? last : first).focus(); event.preventDefault?.(); } }
        if (event.key === 'Escape' && (collapseMore({ focus: true }) || qa('[data-font-weight-pop]').some(node => !node.hidden))) { closePopovers(); event.preventDefault?.(); event.stopPropagation?.(); return; }
        if (!busy && managing && ['Enter', ' '].includes(event.key) && event.target?.matches?.('.qm-font-card')) { toggleCard(event.target); event.preventDefault?.(); event.stopPropagation?.(); return; }
        isolateField(event);
    }
    root.addEventListener('click', click); root.addEventListener('input', input); root.addEventListener('change', change); root.addEventListener('keydown', keydown);
    for (const event of ['keyup', 'keypress', 'focusin']) root.addEventListener(event, isolateField); render();
    return { render, captureSession, clearWebDraft, revealFont, setStatus: message,
        setFontStatus(id, text) { if (disposed) return; loadingStates.set(String(id), String(text || '')); for (const node of qa('[data-font-load-state]')) if (node.dataset.fontLoadState === String(id)) node.textContent = String(text || ''); for (const node of qa('[data-font-sample]')) if (node.dataset.fontSample === String(id)) node.style.setProperty('font-family', fontFamily(String(id)) || '', 'important'); },
        destroy() { if (disposed) return; disposed = true; localUploads = []; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', change); root.removeEventListener('keydown', keydown); for (const event of ['keyup', 'keypress', 'focusin']) root.removeEventListener(event, isolateField); }
    };
}
