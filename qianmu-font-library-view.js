import { qianmuIconMarkup } from './qianmu-icon-renderer.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const FONT_LIBRARY_PAGE_SIZE = 6;
export const FONT_LIBRARY_PREVIEW_TEXT = '一蝶振翅，万象入幕。';
const array = value => Array.isArray(value) ? value : [];
const strings = value => [...new Set(array(value).filter(item => typeof item === 'string' && item))];
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
    return `<select class="qm-font-apply" data-font-apply="${escape(entry.id)}" aria-label="${escape(entry.name)}应用"><option value="" selected>${current}</option><option value="body">正文</option><option value="st">ST界面</option><option value="shared">全部</option>${restore}</select>`;
}
function variantTools(entry, current) {
    const selected = choice(entry, current), range = fontLibraryWeightControl(entry, selected), available = fontStyles(entry), id = escape(entry.id);
    return `${range.disabled ? '' : `<div class="qm-font-weight-pick">${iconButton('weight', 'fa-sliders', '调整字重', `data-font-id="${id}" aria-expanded="false"`)}<div class="qm-font-weight-pop" data-font-weight-pop="${id}" hidden><input type="range" data-font-weight="${id}" aria-label="${escape(entry.name)}字重" aria-valuetext="${range.weight}" min="${range.min}" max="${range.max}" step="1" value="${range.value}"><output data-font-weight-value="${id}">${range.weight}</output></div></div>`}${available.length > 1 ? `<label class="sd-icon-btn qm-font-style-pick qm-font-icon" title="字形：${styleLabel(selected.style)}">${icon('fa-font')}<select data-font-style="${id}" aria-label="${escape(entry.name)}字形">${options(available, selected.style, styleLabel)}</select></label>` : ''}`;
}
export function fontLibraryPreviewSize(state = {}, view = {}) {
    const baseline = validPreviewSize(state.defaultPreviewSize) ? Number(state.defaultPreviewSize) : 18, value = validPreviewSize(view.previewSizeOverride) ? Number(view.previewSizeOverride) : baseline;
    return { min: Math.min(12, baseline, value), max: Math.max(48, baseline, value), value };
}
export function selectFontLibraryPage(state = {}, view = {}) {
    const query = String(view.query || '').trim().toLocaleLowerCase(), tags = strings(view.tags || (view.tag ? [view.tag] : []));
    const entries = array(state.entries).filter(entry => entry && typeof entry.id === 'string');
    const filtered = entries.filter(entry => (!view.folder || (view.folder === '__none__' ? !entry.folder : entry.folder === view.folder)) && tags.every(tag => array(entry.tags).includes(tag)) && (!query || [entry.name, entry.folder, ...array(entry.tags)].join(' ').toLocaleLowerCase().includes(query)));
    const pages = Math.max(1, Math.ceil(filtered.length / FONT_LIBRARY_PAGE_SIZE)), page = Math.max(0, Math.min(pages - 1, Math.floor(Number(view.page) || 0)));
    return { entries: filtered.slice(page * FONT_LIBRARY_PAGE_SIZE, (page + 1) * FONT_LIBRARY_PAGE_SIZE), total: filtered.length, page, pages };
}
export function renderFontLibraryCards(state = {}, view = {}) {
    const page = selectFontLibraryPage(state, view), selected = new Set(array(view.selected));
    const cards = page.entries.map(entry => {
        const value = initialChoice(state, entry, view.variants?.[entry.id]), id = escape(entry.id), metadata = [entry.folder, ...array(entry.tags).map(tag => `#${tag}`)].filter(Boolean).map(escape).join(' · ');
        return `<article class="sd-card qm-font-card" data-font-id="${id}"><div class="qm-font-card-head"><label class="qm-font-name"><input class="sd-reader-book-check" type="checkbox" data-font-select="${id}" aria-label="选择 ${escape(entry.name)}"${selected.has(entry.id) ? ' checked' : ''}${view.managing ? '' : ' hidden'}><strong title="${escape(entry.name)}">${escape(entry.name)}</strong></label><div class="qm-font-card-tools">${variantTools(entry, value)}${applyControl(state, entry)}</div></div><p class="qm-font-sample qm-font-preview" data-font-sample="${id}">${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}</p><div class="qm-font-card-foot"><span class="qm-font-meta">${metadata}</span>${iconButton('delete-one', 'fa-trash', `删除 ${entry.name}`, `data-font-id="${id}"`)}</div><span class="qm-font-load-state" data-font-load-state="${id}" aria-live="polite">${escape(entry.status || '')}</span></article>`;
    }).join('');
    return `<div class="qm-font-list">${cards || '<p class="sd-muted qm-font-empty">没有符合条件的字体</p>'}</div><div class="qm-font-pagination">${iconButton('previous', 'fa-chevron-left', '上一页字体', page.page ? '' : 'disabled')}<span>${page.page + 1} / ${page.pages} · ${page.total} 款</span>${iconButton('next', 'fa-chevron-right', '下一页字体', page.page + 1 < page.pages ? '' : 'disabled')}</div>`;
}
export function renderFontLibrary(state = {}, view = {}) {
    const folders = strings([...array(state.folders), ...array(state.entries).map(entry => entry.folder)]), tags = strings(array(state.entries).flatMap(entry => array(entry.tags))), selected = array(view.selected).length, previewSize = fontLibraryPreviewSize(state, view);
    return `<header class="sd-header qm-font-header">${iconButton('back', 'fa-arrow-left', '返回正文排版')}<h2>字体库管理</h2>${iconButton('close', 'fa-xmark', '关闭字体库')}</header><main class="sd-body"><div class="qm-font-library sd-reader-lib sd-reader-lib-list">
      <label class="sd-card sd-switch-row qm-font-enable"><span>启用字体库</span><input type="checkbox" data-font-enabled aria-label="启用字体库"${state.enabled !== false ? ' checked' : ''}></label>
      <div class="qm-font-web"><label class="qm-font-web-label">名称<div class="qm-font-web-name"><input data-font-web-name type="text" maxlength="80" placeholder="可选，留空使用字体名" autocomplete="off" value="${escape(view.webName || '')}">${iconButton('add-web', 'fa-plus', '加入字体库')}</div></label><label class="qm-font-web-label">字体链接<textarea data-font-web-source rows="3" placeholder="字体文件链接、字体 CSS 链接、@import 或 @font-face" spellcheck="false">${escape(view.webSource || '')}</textarea></label></div>
      <div class="qm-font-imports"><label class="sd-btn qm-font-file-pick" title="上传本地字体">${icon('fa-upload')}<span>上传本地字体</span><input class="sd-reader-native-file" type="file" data-font-file="local" accept=".woff2,.woff,.ttf,.otf" aria-label="上传本地字体" multiple></label><label class="sd-btn qm-font-icon qm-font-file-pick" title="导入字库">${icon('fa-file-import')}<input class="sd-reader-native-file" type="file" data-font-file="import" accept=".json,application/json" aria-label="导入字库"></label>${iconButton('export-all', 'fa-file-export', '导出字库', array(state.entries).length ? '' : 'disabled')}</div>
      <section class="sd-card qm-font-preview-editor"><label class="qm-font-preview-label">统一预览文案<input data-font-preview type="text" maxlength="500" value="${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}" aria-label="统一字体预览文案"></label><label class="qm-font-size-row"><span>预览字号</span><input type="range" data-font-preview-size aria-label="预览字号" min="${previewSize.min}" max="${previewSize.max}" step="1" value="${previewSize.value}"><output data-font-preview-size-value>${previewSize.value}px</output></label></section>
      <div class="sd-reader-lib-bar qm-font-toolbar"><input type="search" class="sd-reader-search" data-font-search value="${escape(view.query || '')}" placeholder="搜索字体 / 标签 / 文件夹" aria-label="搜索字体"><div class="sd-reader-sort-pick">${iconButton('filter', 'fa-folder', view.folder ? `文件夹：${view.folder === '__none__' ? '未分类' : view.folder}` : '文件夹', 'aria-expanded="false"', 'sd-reader-sort-toggle sd-reader-sort-icononly')}<div class="sd-reader-sort-menu qm-font-folder-menu" data-font-folder-menu hidden>${[['', '全部文件夹'], ['__none__', '未分类'], ...folders.map(folder => [folder, folder])].map(([value, name]) => `<button type="button" class="sd-reader-sort-opt${(view.folder || '') === value ? ' active' : ''}" data-font-folder-choice="${escape(value)}" aria-pressed="${(view.folder || '') === value}">${escape(name)}</button>`).join('')}</div></div>${iconButton('manage', 'fa-check-double', view.managing ? '退出多选' : '多选', `aria-expanded="${!!view.managing}"`, `sd-reader-batch-mode${view.managing ? ' active' : ''}`)}</div>
      ${tags.length ? `<div class="sd-reader-tags">${tags.map(tag => `<button type="button" class="sd-reader-tag${array(view.tags).includes(tag) ? ' active' : ''}" data-font-tag="${escape(tag)}" aria-pressed="${array(view.tags).includes(tag)}">${escape(tag)}</button>`).join('')}</div>` : ''}
      <div class="sd-reader-batch-actions qm-font-bulk-actions"${view.managing ? '' : ' hidden'}>${iconButton('select-page', 'fa-check-double', '全选 / 取消本页', 'aria-pressed="false"', 'sd-reader-batch-toggle-all')}${iconButton('bulk-folder', 'fa-folder', '移动选中字体', selected ? '' : 'disabled')}${iconButton('bulk-tags', 'fa-tags', '设置选中标签', selected ? '' : 'disabled')}${iconButton('export-selected', 'fa-file-export', '导出选中', selected ? '' : 'disabled')}${iconButton('delete', 'fa-trash', '移除选中', selected ? '' : 'disabled')}<span data-font-selection-count>已选 ${selected}</span></div>
      <div class="qm-font-bulk-editor" data-font-bulk-editor hidden><label><span data-font-bulk-label>文件夹</span><input data-font-bulk-value maxlength="200"></label>${iconButton('bulk-save', 'fa-check', '保存分类')}</div><div data-font-cards>${renderFontLibraryCards(state, view)}</div><p class="qm-font-status" role="status" aria-live="polite" hidden></p>
    </div></main>`;
}

/** Sample font changes are local to cards; only apply-font writes host choices. */
export function createFontLibraryView({ root, getState, onAction, onVisibleFonts, onBack, onClose, initialSession = {}, fontFamily = () => '' } = {}) {
    if (!root || typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('字体库视图缺少宿主');
    let disposed = false, busy = false, rendered = false, page = Number(initialSession?.page) || 0, query = String(initialSession?.query || ''), folder = String(initialSession?.folder || ''), managing = false,
        previewDraft = typeof initialSession?.previewDraft === 'string' ? initialSession.previewDraft.slice(0, 500) : undefined,
        previewSizeOverride = validPreviewSize(initialSession?.previewSizeOverride) ? Number(initialSession.previewSizeOverride) : undefined,
        webName = String(initialSession?.webName || ''), webSource = String(initialSession?.webSource || ''), bulk = '';
    const tags = new Set(strings(initialSession?.tags)), selected = new Set(), variants = Object.create(null), loadingStates = new Map();
    for (const entry of array(getState().entries)) if (initialSession?.variants?.[entry.id]) variants[entry.id] = choice(entry, initialSession.variants[entry.id]);
    const state = () => ({ ...getState(), ...(previewDraft === undefined ? {} : { previewText: previewDraft }) });
    const viewState = () => ({ page, query, folder, tags: [...tags], selected: [...selected], variants, managing, webName, webSource, previewSizeOverride });
    const q = selector => root.querySelector(selector), qa = selector => [...root.querySelectorAll(selector)];
    function message(text, { error = false } = {}) { const node = q('.qm-font-status'); if (!node || disposed) return; node.textContent = String(text || ''); node.hidden = !text; node.classList.toggle('is-error', error); }
    function captureWeb() { if (q('[data-font-web-name]')) webName = q('[data-font-web-name]').value; if (q('[data-font-web-source]')) webSource = q('[data-font-web-source]').value; }
    function clearWebDraft({ name = '', source = '' } = {}) { if (disposed) return false; captureWeb(); if (webName !== String(name) || webSource !== String(source)) return false; webName = ''; webSource = ''; for (const selector of ['[data-font-web-name]', '[data-font-web-source]']) { const field = q(selector); if (field) field.value = ''; } return true; }
    function captureSession() { captureWeb(); return { page, query, folder, tags: [...tags], variants: Object.fromEntries(Object.entries(variants).map(([id, value]) => [id, { ...value }])), previewDraft, previewSizeOverride, webName, webSource, scrollTop: Math.max(0, Number(q('.sd-body')?.scrollTop) || 0) }; }
    function sizeSamples() { const { value } = fontLibraryPreviewSize(state(), viewState()); for (const node of qa('[data-font-sample]')) node.style.setProperty('font-size', `${value}px`, 'important'); const output = q('[data-font-preview-size-value]'); if (output) output.textContent = `${value}px`; }
    function previewSize(target) { const range = fontLibraryPreviewSize(state(), viewState()), value = Number(target.value); if (!Number.isFinite(value)) return; previewSizeOverride = Math.max(range.min, Math.min(range.max, Math.round(value))); sizeSamples(); }
    function setBusy(value) { busy = value; root.setAttribute('aria-busy', String(value)); const enabled = q('[data-font-enabled]'); if (enabled) enabled.disabled = value; }
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
        for (const action of ['bulk-folder', 'bulk-tags', 'export-selected', 'delete']) { const button = q(`[data-font-action="${action}"]`); if (button) button.disabled = !selected.size; }
        for (const input of qa('[data-font-select]')) { input.checked = selected.has(input.dataset.fontSelect); input.hidden = !managing; }
        for (const card of qa('.qm-font-card')) card.classList.toggle('is-selecting', managing);
        if (!managing || !selected.size) { const editor = q('[data-font-bulk-editor]'); if (editor) editor.hidden = true; bulk = ''; }
    }
    function renderCards() { if (disposed) return; const host = q('[data-font-cards]'); if (!host) return; page = selectFontLibraryPage(state(), viewState()).page; host.innerHTML = renderFontLibraryCards(state(), viewState()); selection(); samples(); }
    function render() {
        if (disposed) return;
        const scrollTop = rendered ? Number(q('.sd-body')?.scrollTop) || 0 : Number(initialSession?.scrollTop) || 0; captureWeb();
        const current = state(), entries = array(current.entries), liveIds = new Set(entries.map(entry => entry.id)), liveTags = new Set(entries.flatMap(entry => array(entry.tags))), liveFolders = new Set([...array(current.folders), ...entries.map(entry => entry.folder)]);
        for (const id of selected) if (!liveIds.has(id)) selected.delete(id); for (const tag of tags) if (!liveTags.has(tag)) tags.delete(tag); if (folder && folder !== '__none__' && !liveFolders.has(folder)) folder = '';
        page = selectFontLibraryPage(current, viewState()).page; root.innerHTML = renderFontLibrary(current, viewState()); setBusy(busy); selection(); samples();
        const body = q('.sd-body'); if (body) body.scrollTop = Math.max(0, scrollTop); rendered = true;
    }
    async function dispatch(type, payload = {}, { refresh = true, exclusive = true } = {}) {
        if (disposed || (exclusive && busy)) return; if (exclusive) setBusy(true); message('');
        try { await onAction({ type, ...payload }); if (!disposed && refresh) { if (type === 'add-web') clearWebDraft(payload); render(); } }
        catch (error) { if (!disposed) { if (type === 'set-enabled') { const enabled = q('[data-font-enabled]'); if (enabled) enabled.checked = getState().enabled !== false; } message(error?.userMessage || '操作未完成，请检查输入或稍后重试。', { error: true }); } }
        finally { if (exclusive) { busy = false; if (!disposed) setBusy(false); } }
    }
    function closePopovers() { for (const pop of qa('[data-font-weight-pop],[data-font-folder-menu]')) pop.hidden = true; for (const button of qa('[data-font-action="weight"],[data-font-action="filter"]')) button.setAttribute('aria-expanded', 'false'); }
    function setVariant(id, patch, notify = true) {
        const current = state(), entry = array(current.entries).find(item => item.id === id); if (!entry) return; variants[id] = choice(entry, { ...initialChoice(current, entry, variants[id]), ...patch });
        if ('style' in patch) { const host = qa('.qm-font-card').find(node => node.dataset.fontId === id)?.querySelector('.qm-font-card-tools'); if (host) host.innerHTML = variantTools(entry, variants[id]) + applyControl(current, entry); }
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
        const navigation = target.closest?.('[data-font-action]'); if (navigation?.dataset.fontAction === 'back') return onBack?.(); if (navigation?.dataset.fontAction === 'close') return onClose?.();
        if (busy) return;
        const folderChoice = target.closest?.('[data-font-folder-choice]'); if (folderChoice) { folder = folderChoice.dataset.fontFolderChoice; page = 0; selected.clear(); closePopovers(); for (const button of qa('[data-font-folder-choice]')) { button.classList.toggle('active', button === folderChoice); button.setAttribute('aria-pressed', String(button === folderChoice)); } return renderCards(); }
        const tag = target.closest?.('[data-font-tag]'); if (tag) { const value = tag.dataset.fontTag; tags.has(value) ? tags.delete(value) : tags.add(value); tag.classList.toggle('active', tags.has(value)); tag.setAttribute('aria-pressed', String(tags.has(value))); page = 0; selected.clear(); return renderCards(); }
        const button = target.closest?.('[data-font-action]');
        if (!button || button.disabled) {
            if (!target.closest?.('[data-font-weight-pop],[data-font-folder-menu]')) closePopovers();
            const card = target.closest?.('.qm-font-card'); if (managing && card && !target.closest?.('button,input,select,label,output,[data-font-weight-pop]')) { const id = card.dataset.fontId; selected.has(id) ? selected.delete(id) : selected.add(id); selection(); }
            return;
        }
        const action = button.dataset.fontAction;
        if (action === 'weight' || action === 'filter') { const pop = action === 'filter' ? q('[data-font-folder-menu]') : qa('[data-font-weight-pop]').find(node => node.dataset.fontWeightPop === button.dataset.fontId); if (pop) { const opening = pop.hidden; closePopovers(); pop.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); if (opening) pop.querySelector('input,button')?.focus(); } return; }
        closePopovers();
        if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; selected.clear(); return renderCards(); }
        if (action === 'manage') { managing = !managing; if (!managing) selected.clear(); return selection(); }
        if (action === 'select-page') { const visible = selectFontLibraryPage(state(), viewState()).entries, all = visible.length && visible.every(entry => selected.has(entry.id)); for (const entry of visible) all ? selected.delete(entry.id) : selected.add(entry.id); return selection(); }
        if (action === 'add-web') return dispatch('add-web', { name: q('[data-font-web-name]')?.value || '', source: q('[data-font-web-source]')?.value || '' });
        if (action === 'export-all' || action === 'export-selected') return dispatch('export', { ids: action === 'export-all' ? null : [...selected] }, { refresh: false });
        if (action === 'delete-one') { const id = button.dataset.fontId; if (array(state().entries).some(entry => entry.id === id)) return dispatch('delete-fonts', { ids: [id] }); return; }
        if (!selected.size) return;
        if (action === 'bulk-folder' || action === 'bulk-tags') { bulk = action === 'bulk-folder' ? 'folder' : 'tags'; const editor = q('[data-font-bulk-editor]'), label = q('[data-font-bulk-label]'), input = q('[data-font-bulk-value]'); if (editor) editor.hidden = false; if (label) label.textContent = bulk === 'folder' ? '移入文件夹' : '设置标签'; if (input) { input.value = ''; input.placeholder = bulk === 'folder' ? '文件夹名；留空移出' : '逗号分隔；留空清除'; input.focus(); } return; }
        if (action === 'bulk-save' && bulk) { const value = q('[data-font-bulk-value]')?.value || ''; return dispatch('update-fonts', { ids: [...selected], ...(bulk === 'folder' ? { folder: value.trim() } : { tags: value.split(/[,，]/).map(value => value.trim()).filter(Boolean) }) }); }
        if (action === 'delete') return dispatch('delete-fonts', { ids: [...selected] });
    }
    function input(event) {
        const target = event.target; if (!root.contains(target) || disposed) return;
        isolateField(event);
        if (target.matches?.('[data-font-preview]')) { previewDraft = target.value; for (const sample of qa('[data-font-sample]')) sample.textContent = previewDraft || FONT_LIBRARY_PREVIEW_TEXT; }
        if (target.matches?.('[data-font-search]')) { query = target.value; page = 0; selected.clear(); renderCards(); }
        if (target.matches?.('[data-font-weight]')) dragWeight(target, false);
        if (target.matches?.('[data-font-preview-size]')) previewSize(target);
    }
    async function change(event) {
        isolateField(event);
        const target = event.target; if (!root.contains(target) || disposed || busy) return;
        if (target.matches?.('[data-font-enabled]')) return dispatch('set-enabled', { enabled: target.checked === true });
        if (target.matches?.('[data-font-preview-size]')) return previewSize(target);
        if (target.matches?.('[data-font-preview]')) return dispatch('set-preview', { text: target.value }, { refresh: false, exclusive: false });
        if (target.matches?.('[data-font-select]') && managing) { target.checked ? selected.add(target.dataset.fontSelect) : selected.delete(target.dataset.fontSelect); return selection(); }
        if (target.matches?.('[data-font-file]')) { const files = [...(target.files || [])]; target.value = ''; if (files.length) return dispatch(target.dataset.fontFile === 'local' ? 'add-local' : 'import', target.dataset.fontFile === 'local' ? { files } : { file: files[0] }); }
        if (target.matches?.('[data-font-weight]')) return dragWeight(target, true);
        if (target.matches?.('[data-font-style]')) return setVariant(target.dataset.fontStyle, { style: target.value });
        if (target.matches?.('[data-font-apply]')) { const id = target.dataset.fontApply, value = target.value, current = state(), entry = array(current.entries).find(item => item.id === id); target.value = ''; if (!entry || !/^(?:body|st|shared|restore-(?:body|st|shared))$/.test(value)) return; return value.startsWith('restore-') ? dispatch('restore-font', { fontId: id, target: value.slice(8) }) : dispatch('apply-font', { fontId: id, target: value, ...initialChoice(current, entry, variants[id]) }); }
    }
    function isolateField(event) { if (event.target?.closest?.('input,textarea,select')) event.stopPropagation?.(); }
    function keydown(event) { if (event.key === 'Escape' && qa('[data-font-weight-pop],[data-font-folder-menu]').some(node => !node.hidden)) { closePopovers(); event.stopPropagation?.(); } else isolateField(event); }
    root.addEventListener('click', click); root.addEventListener('input', input); root.addEventListener('change', change); root.addEventListener('keydown', keydown);
    for (const event of ['keyup', 'keypress', 'focusin']) root.addEventListener(event, isolateField); render();
    return { render, captureSession, clearWebDraft, setStatus: message,
        setFontStatus(id, text) { if (disposed) return; loadingStates.set(String(id), String(text || '')); for (const node of qa('[data-font-load-state]')) if (node.dataset.fontLoadState === String(id)) node.textContent = String(text || ''); },
        destroy() { if (disposed) return; disposed = true; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', change); root.removeEventListener('keydown', keydown); for (const event of ['keyup', 'keypress', 'focusin']) root.removeEventListener(event, isolateField); }
    };
}
