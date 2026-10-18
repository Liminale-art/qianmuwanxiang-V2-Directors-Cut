import { qianmuIconMarkup } from './qianmu-icon-renderer.js?v=1.59.468';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const FONT_LIBRARY_PAGE_SIZE = 10;
export const FONT_LIBRARY_PREVIEW_TEXT = '一蝶振翅，万象入幕。';
const array = value => Array.isArray(value) ? value : [];
const strings = value => [...new Set(array(value).filter(item => typeof item === 'string' && item))];
const parseTags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，]/)).map(tag => String(tag).trim()).filter(Boolean))];
const styles = value => /^(?:normal|italic|oblique)/.test(String(value)) ? String(value).split(' ')[0] : 'normal';
const styleLabel = value => ({ normal: '常规', italic: '斜体', oblique: '倾斜' })[value] || value;
const options = (values, selected, label = value => value) => values.map(value => `<option value="${escape(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escape(label(value))}</option>`).join('');
const icon = name => qianmuIconMarkup(name);
const validPreviewSize = value => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 256;
function iconButton(action, name, title, attributes = '', classes = '') {
    return `<button type="button" class="sd-icon-btn qm-font-icon ${classes}" data-font-action="${action}" aria-label="${escape(title)}" title="${escape(title)}" ${attributes}>${icon(name)}</button>`;
}
function fontStyles(entry) {
    const available = strings(array(entry?.faces).length ? entry.faces.map(face => face.style || 'normal') : entry?.styles).map(styles);
    return available.length ? [...new Set(available)] : ['normal'];
}
function supportedWeights(entry, style) {
    const matching = array(entry?.faces).filter(face => styles(face.style || 'normal') === style);
    const declared = matching.length ? matching.map(face => String(face.weight || '400')) : array(entry?.weights);
    const values = declared.flatMap(raw => {
        const value = raw === 'normal' ? '400' : raw === 'bold' ? '700' : String(raw);
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
function applyControl(state, entry) {
    const active = activeTargets(state, entry.id), labels = { body: '正文', st: 'ST界面', shared: '全部' };
    const current = active.length > 1 ? '全部' : active.length ? labels[active[0]] : '应用';
    const restore = active.filter(target => target !== 'body').map(target => `<option value="restore-${target}">${target === 'shared' ? '取消全部' : '恢复界面'}</option>`).join('');
    return `<label class="sd-icon-btn qm-font-icon qm-font-apply-pick" data-applied="${active.length > 0}" title="${escape(current === '应用' ? '应用字体' : current)}">${icon(active.length ? 'font-applied' : 'font-apply')}<select class="qm-font-apply" data-font-apply="${escape(entry.id)}" aria-label="${escape(entry.name)}应用"><option value="" selected>${current}</option><option value="body">正文</option><option value="st">ST界面</option><option value="shared">全部</option>${restore}</select></label>`;
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
    const id = escape(entry.id), variants = fontStyles(entry).length > 1 || !fontLibraryWeightControl(entry, selected).disabled, expanded = variants && view.expandedId === entry.id;
    const editing = iconButton('edit', 'fa-pen', `编辑 ${entry.name}`, `data-font-id="${id}"`) + iconButton('delete-one', 'fa-trash', `删除 ${entry.name}`, `data-font-id="${id}"`);
    return `${variants ? iconButton('more', 'fa-ellipsis', expanded ? '收起字体操作' : '更多字体操作', `data-font-id="${id}" aria-expanded="${expanded}"`) : ''}${expanded ? variantTools(entry, selected) + editing : !variants ? editing : ''}${expanded ? '' : applyControl(state, entry)}`;
}
function localUploadDialog(view) {
    if (!array(view.localUploads).length) return '';
    return `<div class="qm-font-local-layer" data-font-local-layer><section class="sd-card qm-font-local-dialog" data-font-local-dialog role="dialog" aria-modal="true" aria-label="上传本地字体"><h3>上传本地字体</h3><div class="qm-font-local-files">${view.localUploads.map((item, index) => `<div class="qm-font-local-file"><p title="${escape(item.fileName)}">${escape(item.fileName)}</p><label>名称<input data-font-local-name="${index}" value="${escape(item.name)}" maxlength="160" aria-label="第 ${index + 1} 款字体名称"></label><label>标签<input data-font-local-tags="${index}" value="${escape(item.tags)}" maxlength="2623" placeholder="多个标签用逗号分隔" aria-label="第 ${index + 1} 款字体标签"></label></div>`).join('')}</div><p class="qm-font-status" data-font-local-status role="status" hidden></p><footer><button type="button" class="sd-btn" data-font-action="local-cancel">取消</button><button type="button" class="sd-btn" data-font-action="local-confirm">加入字体库</button></footer></section></div>`;
}
export function selectFontLibraryPage(state = {}, view = {}) {
    const query = String(view.query || '').trim().toLocaleLowerCase();
    const entries = array(state.entries).filter(entry => entry && typeof entry.id === 'string');
    const filtered = entries.filter(entry => !query || [entry.name, ...array(entry.tags)].join(' ').toLocaleLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(filtered.length / FONT_LIBRARY_PAGE_SIZE)), page = Math.max(0, Math.min(pages - 1, Math.floor(Number(view.page) || 0)));
    return { entries: filtered.slice(page * FONT_LIBRARY_PAGE_SIZE, (page + 1) * FONT_LIBRARY_PAGE_SIZE), total: filtered.length, page, pages };
}
export function renderFontLibraryCards(state = {}, view = {}) {
    const page = selectFontLibraryPage(state, view), selected = new Set(array(view.selected));
    const cards = page.entries.map(entry => {
        const value = initialChoice(state, entry, view.variants?.[entry.id]), id = escape(entry.id), metadata = strings(entry.tags).map(tag => `<span class="qm-font-tag">${escape(tag)}</span>`).join('');
        return `<article class="sd-card qm-font-card" data-font-id="${id}"><div class="qm-font-card-head"><label class="qm-font-name"><input class="sd-reader-book-check" type="checkbox" data-font-select="${id}" aria-label="选择 ${escape(entry.name)}"${selected.has(entry.id) ? ' checked' : ''}${view.managing ? '' : ' hidden'}><strong title="${escape(entry.name)}">${escape(entry.name)}</strong></label><div class="qm-font-card-tools">${cardTools(state, entry, value, view)}</div></div><div class="qm-font-rename-pop" data-font-rename-pop="${id}"${view.renameId === entry.id ? '' : ' hidden'}><input data-font-rename="${id}" aria-label="字体名称" maxlength="160" value="${escape(view.renameId === entry.id ? view.renameDraft : entry.name)}">${iconButton('rename-save', 'fa-check', '保存名称', `data-font-id="${id}"`)}${iconButton('rename-cancel', 'fa-xmark', '取消改名', `data-font-id="${id}"`)}</div><p class="qm-font-sample qm-font-preview" data-font-sample="${id}">${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}</p><div class="qm-font-card-foot"><span class="qm-font-meta">${metadata}</span></div><span class="qm-font-load-state" data-font-load-state="${id}" aria-live="polite">${escape(entry.status || '')}</span></article>`;
    }).join('');
    return `<div class="qm-font-list">${cards || '<p class="sd-muted qm-font-empty">没有符合条件的字体</p>'}</div><div class="qm-font-pagination">${iconButton('previous', 'fa-chevron-left', '上一页字体', page.page ? '' : 'disabled')}<span>${page.page + 1} / ${page.pages} · ${page.total} 款</span>${iconButton('next', 'fa-chevron-right', '下一页字体', page.page + 1 < page.pages ? '' : 'disabled')}</div>`;
}
export function renderFontLibrary(state = {}, view = {}) {
    const selected = array(view.selected).length, previewSize = fontLibraryPreviewSize(state, view);
    return `<header class="sd-header qm-font-header"${array(view.localUploads).length ? ' inert' : ''}><h2>字体库管理</h2>${iconButton('back', 'fa-arrow-left', '返回正文排版')}</header><main class="sd-body"${array(view.localUploads).length ? ' inert' : ''}><div class="qm-font-library sd-reader-lib sd-reader-lib-list">
      <label class="sd-card sd-switch-row qm-font-enable"><strong>启用字体库</strong><input type="checkbox" role="switch" data-font-enabled aria-label="启用字体库"${state.enabled !== false ? ' checked' : ''}></label>
      <details class="sd-card qm-font-add"${(view.addOpen ?? !array(state.entries).length) ? ' open' : ''}><summary><b>添加字体</b></summary><div class="qm-font-web"><label class="qm-font-web-label">名称<input data-font-web-name type="text" maxlength="160" placeholder="可选，留空使用字体名" autocomplete="off" value="${escape(view.webName || '')}"></label><div class="qm-font-web-label"><div class="qm-font-field-head"><span>字体链接</span><div>${view.editWebId ? iconButton('cancel-web', 'fa-xmark', '取消编辑字体') : ''}${iconButton('add-web', view.editWebId ? 'fa-check' : 'fa-plus', view.editWebId ? '保存字体修改' : '加入字体库')}</div></div><textarea data-font-web-source aria-label="字体链接" rows="3" placeholder="字体文件链接、字体 CSS 链接、@import 或 @font-face" spellcheck="false">${escape(view.webSource || '')}</textarea></div><label class="qm-font-web-label">标签<input data-font-web-tags type="text" maxlength="2623" placeholder="多个标签用逗号分隔" value="${escape(view.webTags || '')}" aria-label="字体标签"></label></div>
      <div class="qm-font-imports"><label class="sd-btn qm-font-file-pick" title="上传本地字体">上传本地<input class="sd-reader-native-file" type="file" data-font-file="local" accept=".woff2,.woff,.ttf,.otf" aria-label="上传本地字体" multiple></label><label class="sd-btn qm-font-file-pick" title="导入字体包">导入字体包<input class="sd-reader-native-file" type="file" data-font-file="import" accept=".json,application/json" aria-label="导入字体包"></label></div>
      </details>
      <section class="sd-card qm-font-preview-editor"><div class="qm-font-field-head"><span>预览文案</span><label class="sd-icon-btn qm-font-icon qm-font-size-pick" title="预览字号">${icon('fa-font')}<select data-font-preview-size aria-label="预览字号">${previewSize.values.includes(previewSize.value) ? '' : `<option value="${previewSize.value}" selected disabled>当前 ${previewSize.value}px</option>`}${options(previewSize.values, previewSize.value, value => `${value}px`)}</select></label></div><input data-font-preview type="text" maxlength="500" value="${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}" aria-label="预览文案"></section>
      <div class="sd-reader-lib-bar qm-font-toolbar"><input type="search" class="sd-reader-search" data-font-search value="${escape(view.query || '')}" placeholder="搜索字体 / 标签" aria-label="搜索字体">${iconButton('manage', 'font-manage', view.managing ? '退出多选' : '多选', `aria-expanded="${!!view.managing}"`, `sd-reader-batch-mode${view.managing ? ' active' : ''}`)}</div>
      <div class="sd-reader-batch-actions qm-font-bulk-actions"${view.managing ? '' : ' hidden'}>${iconButton('select-page', 'fa-check-double', '全选 / 取消本页', 'aria-pressed="false"', 'sd-reader-batch-toggle-all')}${iconButton('bulk-tags', 'fa-tags', '设置选中标签', selected ? '' : 'disabled')}${iconButton('export-selected', 'fa-file-export', '导出选中字体包', selected ? '' : 'disabled')}${iconButton('delete', 'fa-trash', '移除选中', selected ? '' : 'disabled')}<span data-font-selection-count>已选 ${selected}</span></div>
      <div class="qm-font-bulk-editor" data-font-bulk-editor hidden><label><span>设置标签</span><input data-font-bulk-value maxlength="2623" placeholder="逗号分隔；留空清除" aria-label="选中字体的标签"></label>${iconButton('bulk-save', 'fa-check', '保存标签')}</div><div data-font-cards>${renderFontLibraryCards(state, view)}</div><p class="qm-font-status" role="status" aria-live="polite" hidden></p>
    </div></main>${localUploadDialog(view)}`;
}

/** Sample font changes are local to cards; only apply-font writes host choices. */
export function createFontLibraryView({ root, getState, onAction, onVisibleFonts, onBack, initialSession = {}, fontFamily = () => '' } = {}) {
    if (!root || typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('字体库视图缺少宿主');
    let disposed = false, busy = false, rendered = false, page = Number(initialSession?.page) || 0, query = String(initialSession?.query || ''), managing = false,
        previewDraft = typeof initialSession?.previewDraft === 'string' ? initialSession.previewDraft.slice(0, 500) : undefined,
        previewSizeOverride = validPreviewSize(initialSession?.previewSizeOverride) ? Number(initialSession.previewSizeOverride) : undefined,
        webName = String(initialSession?.webName || ''), webSource = String(initialSession?.webSource || ''), webTags = String(initialSession?.webTags || ''), editWebId = String(initialSession?.editWebId || ''),
        addOpen = typeof initialSession?.addOpen === 'boolean' ? initialSession.addOpen : !!initialSession?.editWebId || !array(getState().entries).length,
        renameId = String(initialSession?.renameId || ''), renameDraft = String(initialSession?.renameDraft || ''), expandedId = String(initialSession?.renameId || ''), bulk = false, localUploads = [];
    const selected = new Set(), variants = Object.create(null), loadingStates = new Map();
    for (const entry of array(getState().entries)) if (initialSession?.variants?.[entry.id]) variants[entry.id] = choice(entry, initialSession.variants[entry.id]);
    const state = () => ({ ...getState(), ...(previewDraft === undefined ? {} : { previewText: previewDraft }) });
    const viewState = () => ({ page, query, selected: [...selected], variants, managing, webName, webSource, webTags, editWebId, addOpen, localUploads, renameId, renameDraft, expandedId, previewSizeOverride });
    const q = selector => root.querySelector(selector), qa = selector => [...root.querySelectorAll(selector)];
    function message(text, { error = false } = {}) { const node = (localUploads.length && q('[data-font-local-status]')) || q('.qm-font-status'); if (!node || disposed) return; node.textContent = String(text || ''); node.hidden = !text; node.classList.toggle('is-error', error); }
    function captureWeb() { if (q('[data-font-web-name]')) webName = q('[data-font-web-name]').value; if (q('[data-font-web-source]')) webSource = q('[data-font-web-source]').value; if (q('[data-font-web-tags]')) webTags = q('[data-font-web-tags]').value; if (q('.qm-font-add')) addOpen = q('.qm-font-add').open; }
    function clearWebDraft({ id = '', name = '', source = '', tags: submittedTags = [] } = {}) { if (disposed) return false; captureWeb(); if (editWebId !== String(id) || webName !== String(name) || webSource !== String(source) || JSON.stringify(parseTags(webTags)) !== JSON.stringify(parseTags(submittedTags))) return false; editWebId = ''; webName = ''; webSource = ''; webTags = ''; for (const selector of ['[data-font-web-name]', '[data-font-web-source]', '[data-font-web-tags]']) { const field = q(selector); if (field) field.value = ''; } return true; }
    function captureSession() { captureWeb(); return { page, query, variants: Object.fromEntries(Object.entries(variants).map(([id, value]) => [id, { ...value }])), previewDraft, previewSizeOverride, webName, webSource, webTags, editWebId, addOpen, renameId, renameDraft, scrollTop: Math.max(0, Number(q('.sd-body')?.scrollTop) || 0) }; }
    function sizeSamples() { const { value } = fontLibraryPreviewSize(state(), viewState()); for (const node of qa('[data-font-sample]')) node.style.setProperty('font-size', `${value}px`, 'important'); }
    function previewSize(target) { const range = fontLibraryPreviewSize(state(), viewState()), value = Number(target.value); if (!range.values.includes(value)) return; previewSizeOverride = value; sizeSamples(); }
    function setWebDraft(id, name, source, entryTags = []) { editWebId = id; webName = name; webSource = source; webTags = parseTags(entryTags).join(', '); addOpen = true; for (const [selector, value] of [['[data-font-web-name]', webName], ['[data-font-web-source]', webSource], ['[data-font-web-tags]', webTags]]) { const field = q(selector); if (field) field.value = value; } if (q('.qm-font-add')) q('.qm-font-add').open = true; render(); }
    function setBusy(value) { busy = value; root.setAttribute('aria-busy', String(value)); const enabled = q('[data-font-enabled]'); if (enabled) enabled.disabled = value; for (const control of qa('[data-font-local-dialog] input,[data-font-local-dialog] button')) control.disabled = value; }
    function cancelLocal() { if (busy || !localUploads.length) return; localUploads = []; render(); q('[data-font-file="local"]')?.focus({ preventScroll: true }); }
    function samples(notify = true) {
        const current = state(), ids = [], previewChoices = {};
        for (const node of qa('[data-font-sample]')) {
            const id = node.dataset.fontSample, entry = array(current.entries).find(item => item.id === id), variant = initialChoice(current, entry || {}, variants[id]), family = fontFamily(id);
            node.style.setProperty('font-family', typeof family === 'string' ? family : '', 'important'); node.style.setProperty('font-weight', variant.weight, 'important'); node.style.setProperty('font-style', variant.style, 'important');
            ids.push(id); previewChoices[id] = variant;
        }
        for (const node of qa('[data-font-load-state]')) if (loadingStates.has(node.dataset.fontLoadState)) node.textContent = loadingStates.get(node.dataset.fontLoadState);
        sizeSamples();
        if (notify) try { Promise.resolve(onVisibleFonts?.(ids, previewChoices)).catch(() => { if (!disposed) message('部分字体预览暂未载入。', { error: true }); }); } catch { message('字体预览暂未载入。', { error: true }); }
    }
    function selection() {
        const visible = selectFontLibraryPage(state(), viewState()).entries, all = visible.length > 0 && visible.every(entry => selected.has(entry.id)); q('[data-font-action="select-page"]')?.setAttribute('aria-pressed', String(all));
        const count = q('[data-font-selection-count]'); if (count) count.textContent = `已选 ${selected.size}`;
        const manager = q('[data-font-action="manage"]'); if (manager) { manager.setAttribute('aria-expanded', String(managing)); manager.setAttribute('aria-label', managing ? '退出多选' : '多选'); manager.title = managing ? '退出多选' : '多选'; manager.classList.toggle('active', managing); }
        const actions = q('.qm-font-bulk-actions'); if (actions) actions.hidden = !managing;
        for (const action of ['bulk-tags', 'export-selected', 'delete']) { const button = q(`[data-font-action="${action}"]`); if (button) button.disabled = !selected.size; }
        for (const input of qa('[data-font-select]')) { input.checked = selected.has(input.dataset.fontSelect); input.hidden = !managing; }
        for (const card of qa('.qm-font-card')) card.classList.toggle('is-selecting', managing);
        if (!managing || !selected.size) { const editor = q('[data-font-bulk-editor]'); if (editor) editor.hidden = true; bulk = false; }
    }
    function renderCards() { if (disposed) return; const host = q('[data-font-cards]'); if (!host) return; page = selectFontLibraryPage(state(), viewState()).page; host.innerHTML = renderFontLibraryCards(state(), viewState()); selection(); samples(); }
    function render() {
        if (disposed) return;
        const scrollTop = rendered ? Number(q('.sd-body')?.scrollTop) || 0 : Number(initialSession?.scrollTop) || 0; captureWeb();
        const current = state(), liveIds = new Set(array(current.entries).map(entry => entry.id));
        for (const id of selected) if (!liveIds.has(id)) selected.delete(id);
        page = selectFontLibraryPage(current, viewState()).page; root.innerHTML = renderFontLibrary(current, viewState()); setBusy(busy); selection(); samples();
        const body = q('.sd-body'); if (body) body.scrollTop = Math.max(0, scrollTop); rendered = true;
    }
    function revealFont(id) {
        if (disposed) return false;
        const index = array(state().entries).findIndex(entry => entry.id === id); if (index < 0) return false;
        query = ''; selected.clear(); page = Math.floor(index / FONT_LIBRARY_PAGE_SIZE); render();
        const card = qa('.qm-font-card').find(node => node.dataset.fontId === id), body = q('.sd-body');
        if (card) { card.setAttribute('data-font-revealed', 'true'); if (body && card.getBoundingClientRect && body.getBoundingClientRect) body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top - 6; }
        return true;
    }
    async function dispatch(type, payload = {}, { refresh = true, exclusive = true } = {}) {
        if (disposed || (exclusive && busy)) return; if (exclusive) setBusy(true); message('');
        try { const result = await onAction({ type, ...payload }); if (!disposed && refresh) { if (type === 'add-web' || type === 'edit-web') clearWebDraft(payload); if (type === 'add-local') localUploads = []; if (type === 'update-fonts' && 'name' in payload && payload.ids?.[0] === renameId) { renameId = ''; renameDraft = ''; } if (result?.revealFontId) revealFont(result.revealFontId); else render(); } }
        catch (error) { if (!disposed) { if (type === 'set-enabled') { const enabled = q('[data-font-enabled]'); if (enabled) enabled.checked = getState().enabled !== false; } message(error?.userMessage || '操作未完成，请检查输入或稍后重试。', { error: true }); } }
        finally { if (exclusive) { busy = false; if (!disposed) setBusy(false); } }
    }
    function closePopovers() { for (const pop of qa('[data-font-weight-pop]')) pop.hidden = true; for (const button of qa('[data-font-action="weight"]')) button.setAttribute('aria-expanded', 'false'); }
    function setVariant(id, patch, notify = true) {
        const current = state(), entry = array(current.entries).find(item => item.id === id); if (!entry) return; variants[id] = choice(entry, { ...initialChoice(current, entry, variants[id]), ...patch });
        if ('style' in patch) { const host = qa('.qm-font-card').find(node => node.dataset.fontId === id)?.querySelector('.qm-font-card-tools'); if (host) host.innerHTML = cardTools(current, entry, variants[id], viewState()); }
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
        const navigation = target.closest?.('[data-font-action]'); if (navigation?.dataset.fontAction === 'back') return onBack?.();
        if (busy) return;
        if (target.matches?.('[data-font-local-layer]')) return cancelLocal();
        if (localUploads.length && !target.closest?.('[data-font-local-dialog]') && !['local-confirm', 'local-cancel'].includes(navigation?.dataset.fontAction)) return;
        const button = target.closest?.('[data-font-action]');
        if (!button || button.disabled) {
            if (!target.closest?.('[data-font-weight-pop]')) closePopovers();
            const card = target.closest?.('.qm-font-card'); if (managing && card && !target.closest?.('button,input,select,label,output,[data-font-weight-pop]')) { const id = card.dataset.fontId; selected.has(id) ? selected.delete(id) : selected.add(id); selection(); }
            return;
        }
        const action = button.dataset.fontAction;
        if (action === 'local-cancel') return cancelLocal();
        if (action === 'local-confirm' && localUploads.length) return dispatch('add-local', { files: localUploads.map(item => item.file), metadata: localUploads.map(item => ({ name: item.name, tags: parseTags(item.tags) })) });
        if (action === 'weight') { const pop = qa('[data-font-weight-pop]').find(node => node.dataset.fontWeightPop === button.dataset.fontId); if (pop) { const opening = pop.hidden; closePopovers(); pop.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); if (opening) pop.querySelector('input,button')?.focus(); } return; }
        closePopovers();
        if (action === 'more') { expandedId = expandedId === button.dataset.fontId ? '' : button.dataset.fontId; renameId = ''; return renderCards(); }
        if (action === 'edit') {
            const entry = array(state().entries).find(item => item.id === button.dataset.fontId); if (!entry) return;
            if (entry.sourceType === 'local' || entry.source?.kind === 'local') { renameId = entry.id; renameDraft = entry.name; renderCards(); qa('[data-font-rename]').find(node => node.dataset.fontRename === entry.id)?.focus(); }
            else { const source = entry.editableSource ?? entry.source?.url ?? (/^https?:/i.test(entry.source?.input || '') ? entry.source.input : ''); setWebDraft(entry.id, entry.name, source, entry.tags); const body = q('.sd-body'), card = q('.qm-font-add'); if (body && card?.getBoundingClientRect && body.getBoundingClientRect) body.scrollTop += card.getBoundingClientRect().top - body.getBoundingClientRect().top - 6; q('[data-font-web-name]')?.focus({ preventScroll: true }); }
            return;
        }
        if (action === 'cancel-web') return setWebDraft('', '', '');
        if (action === 'rename-cancel') { renameId = ''; renameDraft = ''; return renderCards(); }
        if (action === 'rename-save' && renameId === button.dataset.fontId) { const name = qa('[data-font-rename]').find(node => node.dataset.fontRename === renameId)?.value ?? renameDraft; return dispatch('update-fonts', { ids: [renameId], name }); }
        if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; return renderCards(); }
        if (action === 'manage') { managing = !managing; if (!managing) selected.clear(); return selection(); }
        if (action === 'select-page') { const visible = selectFontLibraryPage(state(), viewState()).entries, all = visible.length && visible.every(entry => selected.has(entry.id)); for (const entry of visible) all ? selected.delete(entry.id) : selected.add(entry.id); return selection(); }
        if (action === 'add-web') { captureWeb(); return dispatch(editWebId ? 'edit-web' : 'add-web', { ...(editWebId ? { id: editWebId } : {}), name: webName, source: webSource, tags: parseTags(webTags) }); }
        if (action === 'delete-one') { const id = button.dataset.fontId; if (array(state().entries).some(entry => entry.id === id)) return dispatch('delete-fonts', { ids: [id] }); return; }
        if (!selected.size) return;
        if (action === 'export-selected') return dispatch('export', { ids: [...selected] }, { refresh: false });
        if (action === 'bulk-tags') { bulk = true; const editor = q('[data-font-bulk-editor]'), input = q('[data-font-bulk-value]'); if (editor) editor.hidden = false; if (input) { input.value = ''; input.focus(); } return; }
        if (action === 'bulk-save' && bulk) return dispatch('update-fonts', { ids: [...selected], tags: parseTags(q('[data-font-bulk-value]')?.value || '') });
        if (action === 'delete') return dispatch('delete-fonts', { ids: [...selected] });
    }
    function input(event) {
        const target = event.target; if (!root.contains(target) || disposed) return;
        isolateField(event);
        if (target.matches?.('[data-font-preview]')) { previewDraft = target.value; for (const sample of qa('[data-font-sample]')) sample.textContent = previewDraft || FONT_LIBRARY_PREVIEW_TEXT; }
        if (target.matches?.('[data-font-search]')) { query = target.value; page = 0; selected.clear(); renderCards(); }
        if (target.matches?.('[data-font-weight]')) dragWeight(target, false);
        if (target.matches?.('[data-font-preview-size]')) previewSize(target);
        if (target.matches?.('[data-font-rename]') && target.dataset.fontRename === renameId) renameDraft = target.value;
        if (target.matches?.('[data-font-local-name]') && localUploads[Number(target.dataset.fontLocalName)]) localUploads[Number(target.dataset.fontLocalName)].name = target.value;
        if (target.matches?.('[data-font-local-tags]') && localUploads[Number(target.dataset.fontLocalTags)]) localUploads[Number(target.dataset.fontLocalTags)].tags = target.value;
    }
    async function change(event) {
        isolateField(event);
        const target = event.target; if (!root.contains(target) || disposed || busy) return;
        if (target.matches?.('[data-font-enabled]')) return dispatch('set-enabled', { enabled: target.checked === true });
        if (target.matches?.('[data-font-preview-size]')) return previewSize(target);
        if (target.matches?.('[data-font-preview]')) return dispatch('set-preview', { text: target.value }, { refresh: false, exclusive: false });
        if (target.matches?.('[data-font-select]') && managing) { target.checked ? selected.add(target.dataset.fontSelect) : selected.delete(target.dataset.fontSelect); return selection(); }
        if (target.matches?.('[data-font-file]')) { const files = [...(target.files || [])]; target.value = ''; if (!files.length) return; if (target.dataset.fontFile === 'local') { localUploads = files.map(file => ({ file, fileName: file.name, name: String(file.name || '').replace(/\.(?:woff2?|ttf|otf)$/i, '').slice(0, 160), tags: '' })); closePopovers(); render(); q('[data-font-local-name="0"]')?.focus(); return; } return dispatch('import', { file: files[0] }); }
        if (target.matches?.('[data-font-weight]')) return dragWeight(target, true);
        if (target.matches?.('[data-font-style]')) return setVariant(target.dataset.fontStyle, { style: target.value });
        if (target.matches?.('[data-font-apply]')) { const id = target.dataset.fontApply, value = target.value, current = state(), entry = array(current.entries).find(item => item.id === id); target.value = ''; if (!entry || !/^(?:body|st|shared|restore-(?:body|st|shared))$/.test(value)) return; return value.startsWith('restore-') ? dispatch('restore-font', { fontId: id, target: value.slice(8) }) : dispatch('apply-font', { fontId: id, target: value, ...initialChoice(current, entry, variants[id]) }); }
    }
    function isolateField(event) { if (event.target?.closest?.('input,textarea,select')) event.stopPropagation?.(); }
    function keydown(event) { if (localUploads.length && event.key === 'Escape') { cancelLocal(); event.preventDefault?.(); event.stopPropagation?.(); return; } if (localUploads.length && event.key === 'Tab') { const fields = qa('[data-font-local-dialog] input,[data-font-local-dialog] button').filter(node => !node.disabled), first = fields[0], last = fields.at(-1); if (first && ((event.shiftKey && event.target === first) || (!event.shiftKey && event.target === last))) { (event.shiftKey ? last : first).focus(); event.preventDefault?.(); } } if (event.key === 'Escape' && qa('[data-font-weight-pop]').some(node => !node.hidden)) { closePopovers(); event.stopPropagation?.(); } else isolateField(event); }
    root.addEventListener('click', click); root.addEventListener('input', input); root.addEventListener('change', change); root.addEventListener('keydown', keydown);
    for (const event of ['keyup', 'keypress', 'focusin']) root.addEventListener(event, isolateField); render();
    return { render, captureSession, clearWebDraft, revealFont, setStatus: message,
        setFontStatus(id, text) { if (disposed) return; loadingStates.set(String(id), String(text || '')); for (const node of qa('[data-font-load-state]')) if (node.dataset.fontLoadState === String(id)) node.textContent = String(text || ''); for (const node of qa('[data-font-sample]')) if (node.dataset.fontSample === String(id)) node.style.setProperty('font-family', fontFamily(String(id)) || '', 'important'); },
        destroy() { if (disposed) return; disposed = true; localUploads = []; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', change); root.removeEventListener('keydown', keydown); for (const event of ['keyup', 'keypress', 'focusin']) root.removeEventListener(event, isolateField); }
    };
}
