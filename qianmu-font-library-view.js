const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const FONT_LIBRARY_PAGE_SIZE = 6;
export const FONT_LIBRARY_PREVIEW_TEXT = '山海有相逢，字里有天地。The quick brown fox 0123456789';
const array = value => Array.isArray(value) ? value : [];
const strings = value => [...new Set(array(value).filter(item => typeof item === 'string' && item))];
const targets = { body: '正文', st: 'ST 界面', shared: '共用字体' };
const styleLabel = value => ({ normal: '常规', italic: '斜体', oblique: '倾斜' })[value] || value;
const safeWeight = value => /^\d{1,4}(?: \d{1,4})?$/.test(String(value)) || ['normal', 'bold'].includes(value) ? String(value) : '400';
const safeStyle = value => /^(?:normal|italic|oblique(?: -?\d+(?:\.\d+)?deg(?: -?\d+(?:\.\d+)?deg)?)?)$/.test(String(value)) ? String(value) : 'normal';
const weightValue = value => safeWeight(value).split(' ')[0];
const styleValue = value => safeStyle(value).startsWith('oblique') ? 'oblique' : safeStyle(value);
const options = (values, selected, label = value => value) => values.map(value => `<option value="${escape(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escape(label(value))}</option>`).join('');
function fontWeights(entry, style) {
    const matchingFaces = array(entry?.faces).filter(face => styleValue(face.style || 'normal') === style);
    const values = strings(matchingFaces.length ? matchingFaces.map(face => String(face.weight || '400')) : entry?.weights);
    const expanded = values.flatMap(value => {
        const [from, to] = safeWeight(value).split(' ').map(Number);
        return to ? [from, ...[100, 200, 300, 400, 500, 600, 700, 800, 900].filter(weight => weight > from && weight < to), to].map(String) : [weightValue(value)];
    });
    return [...new Set(expanded.length ? expanded : ['400'])];
}
function fontStyles(entry) { return [...new Set(strings(entry?.styles).map(styleValue))].length ? [...new Set(strings(entry?.styles).map(styleValue))] : ['normal']; }
function choice(entry, current = {}) {
    const styles = fontStyles(entry), style = styles.includes(current.style) ? current.style : styles[0], weights = fontWeights(entry, style);
    return { weight: weights.includes(String(current.weight)) ? String(current.weight) : (weights.includes('400') ? '400' : weights[0]), style };
}
function variantControls(entry, current, attributes = '') {
    const value = choice(entry, current);
    return `<label>字重<select data-font-variant="weight" ${attributes} aria-label="字重">${options(fontWeights(entry, value.style), value.weight)}</select></label><label>字形<select data-font-variant="style" ${attributes} aria-label="字形">${options(fontStyles(entry), value.style, styleLabel)}</select></label>`;
}
export function selectFontLibraryPage(state = {}, view = {}) {
    const query = String(view.query || '').trim().toLocaleLowerCase();
    const entries = array(state.entries).filter(entry => entry && typeof entry.id === 'string');
    const filtered = entries.filter(entry => (!view.folder || (view.folder === '__none__' ? !entry.folder : entry.folder === view.folder)) && (!view.tag || array(entry.tags).includes(view.tag)) && (!query || [entry.name, entry.folder, ...array(entry.tags)].join(' ').toLocaleLowerCase().includes(query)));
    const pages = Math.max(1, Math.ceil(filtered.length / FONT_LIBRARY_PAGE_SIZE));
    const page = Math.max(0, Math.min(pages - 1, Math.floor(Number(view.page) || 0)));
    return { entries: filtered.slice(page * FONT_LIBRARY_PAGE_SIZE, (page + 1) * FONT_LIBRARY_PAGE_SIZE), total: filtered.length, page, pages };
}
function assignment(state, target) {
    const value = state[target] || {}, entry = array(state.entries).find(item => item.id === value.fontId);
    const selected = entry && value.enabled !== false ? entry.id : '';
    return `<div class="qm-font-assignment" data-font-target="${target}"><label class="qm-font-target"><span>${targets[target]}</span><select data-font-assignment="${target}" aria-label="${targets[target]}字体"><option value="">沿用原生字体</option>${array(state.entries).map(item => `<option value="${escape(item.id)}"${item.id === selected ? ' selected' : ''}>${escape(item.name)}</option>`).join('')}</select></label><div class="qm-font-variants">${variantControls(entry, value, `data-font-target="${target}"${selected ? '' : ' disabled'}`)}</div></div>`;
}
export function renderFontLibraryCards(state = {}, view = {}) {
    const page = selectFontLibraryPage(state, view), selected = new Set(array(view.selected));
    const drafts = view.variants || {};
    const cards = page.entries.map(entry => {
        const folder = entry.folder ? `<span>${escape(entry.folder)}</span>` : '';
        const tags = array(entry.tags).map(tag => `<span>#${escape(tag)}</span>`).join('') + (entry.sourceType === 'local' && entry.variantKnown === false ? '<span>文件默认字形</span>' : '');
        return `<article class="qm-font-card" data-font-id="${escape(entry.id)}"><div class="qm-font-card-head"><label><input type="checkbox" data-font-select="${escape(entry.id)}" aria-label="选择 ${escape(entry.name)}"${selected.has(entry.id) ? ' checked' : ''}><strong>${escape(entry.name)}</strong></label><span class="qm-font-source">${entry.sourceType === 'local' ? '本机' : 'Web'}</span></div><div class="qm-font-meta">${folder}${tags}</div><p class="qm-font-sample" data-font-sample="${escape(entry.id)}">${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}</p><span class="qm-font-load-state" data-font-load-state="${escape(entry.id)}" aria-live="polite">${escape(entry.status || '')}</span><div class="qm-font-card-foot"><div class="qm-font-variants">${variantControls(entry, drafts[entry.id], `data-font-card="${escape(entry.id)}"`)}</div><div class="qm-font-apply">${(state.mode === 'shared' ? ['shared'] : ['body', 'st']).map(target => `<button type="button" data-font-action="apply" data-font-id="${escape(entry.id)}" data-font-target="${target}">${target === 'shared' ? '应用共用' : `用于${targets[target]}`}</button>`).join('')}</div></div></article>`;
    }).join('');
    return `<div class="qm-font-list">${cards || '<p class="qm-font-empty">没有符合条件的字体</p>'}</div><div class="qm-font-pagination"><button type="button" data-font-action="previous" aria-label="上一页字体"${page.page ? '' : ' disabled'}>上一页</button><span>${page.page + 1} / ${page.pages} · ${page.total} 款</span><button type="button" data-font-action="next" aria-label="下一页字体"${page.page + 1 < page.pages ? '' : ' disabled'}>下一页</button></div>`;
}
export function renderFontLibrary(state = {}, view = {}) {
    const folders = strings([...array(state.folders), ...array(state.entries).map(entry => entry.folder)]);
    const tags = strings(array(state.entries).flatMap(entry => array(entry.tags)));
    const selected = array(view.selected).length;
    return `<div class="qm-font-library"><div class="qm-font-heading"><button type="button" data-font-action="back">‹ 返回正文排版</button></div><div class="qm-font-mode" role="group" aria-label="字体应用方式"><button type="button" data-font-action="mode" data-font-mode="separate" aria-pressed="${state.mode !== 'shared'}">分别设置</button><button type="button" data-font-action="mode" data-font-mode="shared" aria-pressed="${state.mode === 'shared'}">共用字体</button></div><details class="qm-font-application" data-font-assignments${view.assignmentsOpen ? ' open' : ''}><summary>应用设置</summary><div class="qm-font-assignments">${(state.mode === 'shared' ? ['shared'] : ['body', 'st']).map(target => assignment(state, target)).join('')}</div></details><p class="qm-font-note">字体在下方列表预览；正文与 ST 界面的字号保持各自设置。</p><details class="qm-font-web"${array(state.entries).length ? '' : ' open'}><summary>Web 引入</summary><label>名称<input data-font-web-name type="text" maxlength="80" placeholder="可选，留空使用字体名" autocomplete="off"></label><label>字体链接或样式<textarea data-font-web-source rows="3" placeholder="粘贴字体文件链接、字体 CSS 链接、@import 或 @font-face" spellcheck="false"></textarea></label><button type="button" data-font-action="add-web">加入字体库</button></details><div class="qm-font-imports"><button type="button" data-font-action="local">上传本地字体</button><button type="button" data-font-action="import">导入字库</button><button type="button" data-font-action="export-all"${array(state.entries).length ? '' : ' disabled'}>导出字库</button><input type="file" data-font-file="local" accept=".woff2,.woff,.ttf,.otf" multiple hidden><input type="file" data-font-file="import" accept=".json,application/json" hidden></div><label class="qm-font-preview-label">统一预览文案<input data-font-preview type="text" maxlength="500" value="${escape(state.previewText || FONT_LIBRARY_PREVIEW_TEXT)}" aria-label="统一字体预览文案"></label><div class="qm-font-filters"><input type="search" data-font-search value="${escape(view.query || '')}" placeholder="搜索字体、标签" aria-label="搜索字体"><select data-font-folder aria-label="按文件夹筛选"><option value="">全部文件夹</option><option value="__none__"${view.folder === '__none__' ? ' selected' : ''}>未分类</option>${options(folders, view.folder)}</select><select data-font-tag aria-label="按标签筛选"><option value="">全部标签</option>${options(tags, view.tag)}</select></div><div class="qm-font-selection"><label><input type="checkbox" data-font-select-page>选择本页</label><span data-font-selection-count>已选 ${selected} 款</span><button type="button" data-font-action="clear-selection"${selected ? '' : ' disabled'}>取消选择</button></div><div class="qm-font-bulk"${selected ? '' : ' hidden'}><label>文件夹<input data-font-bulk-folder maxlength="80" placeholder="填写文件夹名，留空移出"></label><button type="button" data-font-action="folder">移动</button><label>标签<input data-font-bulk-tags maxlength="200" placeholder="逗号分隔，留空清除"></label><button type="button" data-font-action="tags">设置</button><button type="button" data-font-action="export-selected">导出选中</button><button type="button" data-font-action="delete">移除选中</button></div><div data-font-cards>${renderFontLibraryCards(state, view)}</div><p class="qm-font-note qm-font-storage-note">Web 字体需来源可访问；本地原件仅存当前浏览器，清站点数据或换设备前请导出字库。</p><p class="qm-font-status" role="status" aria-live="polite" hidden></p></div>`;
}

/** Owns presentation only. Loading samples never selects or applies a host font. */
export function createFontLibraryView({ root, getState, onAction, onVisibleFonts, onBack, fontFamily = () => '' } = {}) {
    if (!root || typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('字体库视图缺少宿主');
    let disposed = false, busy = false, page = 0, query = '', folder = '', tag = '', previewDraft, assignmentsOpen = false;
    const selected = new Set(), variants = {}, loadingStates = new Map();
    const state = () => ({ ...getState(), ...(previewDraft === undefined ? {} : { previewText: previewDraft }) });
    const viewState = () => ({ page, query, folder, tag, selected: [...selected], variants, assignmentsOpen });
    const q = selector => root.querySelector(selector);
    const qa = selector => [...root.querySelectorAll(selector)];
    const message = (text, { error = false } = {}) => {
        const node = q('.qm-font-status');
        if (!node || disposed) return;
        node.textContent = String(text || ''); node.hidden = !text; node.classList.toggle('is-error', error);
    };
    function samples() {
        const current = state(), ids = [], previewChoices = {};
        for (const node of qa('[data-font-sample]')) {
            const id = node.dataset.fontSample, entry = array(current.entries).find(item => item.id === id);
            const variant = choice(entry, variants[id]);
            const family = fontFamily(id);
            node.style.fontFamily = typeof family === 'string' ? family : '';
            node.style.fontWeight = variant.weight; node.style.fontStyle = variant.style;
            previewChoices[id] = variant;
            ids.push(id);
        }
        for (const node of qa('[data-font-load-state]')) if (loadingStates.has(node.dataset.fontLoadState)) node.textContent = loadingStates.get(node.dataset.fontLoadState);
        // The owner controls actual FontFace registration and source-specific errors.
        try { Promise.resolve(onVisibleFonts?.(ids, previewChoices)).catch(() => { if (!disposed) message('部分字体预览暂未载入，可检查来源后重试。', { error: true }); }); } catch { message('字体预览暂未载入。', { error: true }); }
    }
    function selection() {
        const visible = selectFontLibraryPage(state(), viewState()).entries;
        const all = visible.length > 0 && visible.every(entry => selected.has(entry.id));
        const pageCheckbox = q('[data-font-select-page]');
        if (pageCheckbox) { pageCheckbox.checked = all; pageCheckbox.indeterminate = !all && visible.some(entry => selected.has(entry.id)); }
        const count = q('[data-font-selection-count]'); if (count) count.textContent = `已选 ${selected.size} 款`;
        const clear = q('[data-font-action="clear-selection"]'); if (clear) clear.disabled = !selected.size;
        const bulk = q('.qm-font-bulk'); if (bulk) bulk.hidden = !selected.size;
        for (const input of qa('[data-font-select]')) input.checked = selected.has(input.dataset.fontSelect);
    }
    function renderCards() {
        if (disposed) return;
        const host = q('[data-font-cards]'); if (!host) return;
        const normalized = selectFontLibraryPage(state(), viewState()); page = normalized.page;
        host.innerHTML = renderFontLibraryCards(state(), viewState()); selection(); samples();
    }
    function render() {
        if (disposed) return;
        const applicationPanel = q('[data-font-assignments]');
        if (applicationPanel) assignmentsOpen = Boolean(applicationPanel.open);
        const liveIds = new Set(array(state().entries).map(entry => entry.id));
        for (const id of selected) if (!liveIds.has(id)) selected.delete(id);
        root.innerHTML = renderFontLibrary(state(), viewState());
        root.setAttribute('aria-busy', String(busy)); selection(); samples();
    }
    async function dispatch(type, payload = {}, { refresh = true, exclusive = true } = {}) {
        if (disposed || (exclusive && busy)) return;
        if (exclusive) { busy = true; root.setAttribute('aria-busy', 'true'); }
        message('');
        try {
            await onAction({ type, ...payload });
            if (!disposed && refresh) render();
        } catch (error) {
            if (!disposed) message(error?.userMessage || '操作未完成，请检查输入或稍后重试。', { error: true });
        } finally { if (exclusive) { busy = false; if (!disposed) root.setAttribute('aria-busy', 'false'); } }
    }
    async function click(event) {
        const button = event.target?.closest?.('[data-font-action]');
        if (!button || !root.contains(button) || button.disabled || busy || disposed) return;
        const action = button.dataset.fontAction, current = state();
        if (action === 'back') return onBack?.();
        if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; return renderCards(); }
        if (action === 'clear-selection') { selected.clear(); return selection(); }
        if (action === 'local' || action === 'import') return q(`[data-font-file="${action}"]`)?.click();
        if (action === 'mode') return dispatch('set-mode', { mode: button.dataset.fontMode });
        if (action === 'add-web') return dispatch('add-web', { name: q('[data-font-web-name]')?.value || '', source: q('[data-font-web-source]')?.value || '' });
        if (action === 'apply') {
            const id = button.dataset.fontId, entry = array(current.entries).find(item => item.id === id);
            if (!entry) return;
            return dispatch('set-assignment', { target: button.dataset.fontTarget, fontId: id, enabled: true, ...choice(entry, variants[id]) });
        }
        if (action === 'export-all' || action === 'export-selected') return dispatch('export', { ids: action === 'export-all' ? null : [...selected] }, { refresh: false });
        if (!selected.size) return;
        if (action === 'folder') return dispatch('update-fonts', { ids: [...selected], folder: q('[data-font-bulk-folder]')?.value.trim() || '' });
        if (action === 'tags') return dispatch('update-fonts', { ids: [...selected], tags: (q('[data-font-bulk-tags]')?.value || '').split(/[,，]/).map(value => value.trim()).filter(Boolean) });
        if (action === 'delete') return dispatch('delete-fonts', { ids: [...selected] });
    }
    function input(event) {
        const target = event.target;
        if (!root.contains(target) || disposed) return;
        if (target.matches?.('[data-font-preview]')) {
            previewDraft = target.value;
            for (const sample of qa('[data-font-sample]')) sample.textContent = previewDraft || FONT_LIBRARY_PREVIEW_TEXT;
        }
        if (target.matches?.('[data-font-search]')) { query = target.value; page = 0; renderCards(); }
    }
    async function change(event) {
        const target = event.target;
        if (!root.contains(target) || disposed || busy) return;
        // A text-field blur occurs before the following button click. Saving a
        // list-only preview must not swallow that user's explicit Apply click.
        if (target.matches?.('[data-font-preview]')) return dispatch('set-preview', { text: target.value }, { refresh: false, exclusive: false });
        if (target.matches?.('[data-font-folder]')) { folder = target.value; page = 0; return renderCards(); }
        if (target.matches?.('[data-font-tag]')) { tag = target.value; page = 0; return renderCards(); }
        if (target.matches?.('[data-font-select]')) { target.checked ? selected.add(target.dataset.fontSelect) : selected.delete(target.dataset.fontSelect); return selection(); }
        if (target.matches?.('[data-font-select-page]')) { for (const entry of selectFontLibraryPage(state(), viewState()).entries) target.checked ? selected.add(entry.id) : selected.delete(entry.id); return selection(); }
        if (target.matches?.('[data-font-file]')) {
            const files = [...(target.files || [])]; target.value = '';
            if (!files.length) return;
            return dispatch(target.dataset.fontFile === 'local' ? 'add-local' : 'import', target.dataset.fontFile === 'local' ? { files } : { file: files[0] });
        }
        if (target.matches?.('[data-font-assignment]')) {
            const entry = array(state().entries).find(item => item.id === target.value);
            return dispatch('set-assignment', { target: target.dataset.fontAssignment, fontId: entry?.id || '', enabled: !!entry, ...choice(entry) });
        }
        if (target.matches?.('[data-font-variant]')) {
            if (target.dataset.fontCard) {
                const id = target.dataset.fontCard, entry = array(state().entries).find(item => item.id === id);
                variants[id] = choice(entry, { ...choice(entry, variants[id]), [target.dataset.fontVariant]: target.value });
                const controls = target.closest?.('.qm-font-variants');
                if (controls) {
                    const weight = controls.querySelector('[data-font-variant="weight"]'), style = controls.querySelector('[data-font-variant="style"]');
                    if (weight) weight.innerHTML = options(fontWeights(entry, variants[id].style), variants[id].weight);
                    if (style) style.value = variants[id].style;
                }
                return samples();
            }
            const scope = target.dataset.fontTarget;
            if (targets[scope]) {
                const current = state()[scope] || {}, entry = array(state().entries).find(item => item.id === current.fontId);
                return dispatch('set-assignment', { target: scope, ...current, ...choice(entry, { ...current, [target.dataset.fontVariant]: target.value }) });
            }
        }
    }
    root.addEventListener('click', click); root.addEventListener('input', input); root.addEventListener('change', change);
    render();
    return {
        render, setStatus: message,
        setFontStatus(id, text) {
            if (disposed) return;
            loadingStates.set(String(id), String(text || ''));
            for (const node of qa('[data-font-load-state]')) if (node.dataset.fontLoadState === String(id)) node.textContent = String(text || '');
        },
        destroy() { if (disposed) return; disposed = true; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', change); }
    };
}
