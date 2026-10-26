import { DEFAULT_PROMPTS, PROMPT_KINDS, resolvePromptConfig, validatePromptConfig, importPromptPreset, exportPromptPreset, mergeImportedPromptConfig } from './prompt-settings.mjs';
import { createYimuIcon } from './icons.mjs';

const LABELS = { summary: '切片总结', stage: '阶段总结', recall: '原文回查' };
const clone = value => structuredClone(value);
/** Small ordered editor for Yimu's own summary rules; never mutates ST prompt presets. */
export function mountPromptView(container, { document = container?.ownerDocument || globalThis.document,
    onSave = async () => {}, onError = () => {}, onExport, showTitle = true } = {}) {
    if (!container || !document?.createElement) throw new TypeError('总结提示词缺少容器');
    const el = (tag, cls = '', text = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; };
    const drafts = new Map(), revisions = new Map(), rows = new Map(), allButtons = new Set(), rowButtons = new Set();
    let state = {}, scope = '', config = clone(DEFAULT_PROMPTS), dirty = false, busy = false, disposed = false;
    let kind = 'summary', importCandidate = null, dragId = '', serial = 0;
    const createId = () => globalThis.crypto?.randomUUID?.() || `prompt_${Date.now()}_${++serial}`;
    const card = el('section', 'ym-card ym-prompts'); card.setAttribute('aria-label', '总结提示词');
    const heading = el('div', 'ym-prompt-heading'); if (showTitle) heading.append(el('h3', '', '总结提示词'));
    const badge = el('span', 'ym-muted ym-prompt-unsaved'); badge.hidden = true; heading.append(badge);
    const button = (label, action, glyph, onlyIcon = false) => {
        const node = el('button', `ym-button${onlyIcon ? ' ym-icon-button' : ''}`); node.type = 'button';
        node.title = label; node.setAttribute('aria-label', label);
        if (glyph) node.append(createYimuIcon(glyph, { document }));
        if (!onlyIcon) node.append(el('span', '', label));
        node.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!busy && !state.disabled) action(); });
        allButtons.add(node); return node;
    };
    const presets = el('div', 'ym-prompt-presets'), preset = el('select'); preset.setAttribute('aria-label', '总结提示词预设');
    const load = button('载入提示词预设', () => { const found = config.presets.find(item => item.id === preset.value); if (!found) return;
        ask('载入后将替换当前三组提示词，未保存的修改将被替换。', () => { config.groups = clone(found.groups); config.selectedPreset = found.id; changed(); rebuild(); }); }, 'book');
    const remove = button('删除提示词预设', () => { const found = config.presets.find(item => item.id === preset.value); if (!found) return;
        ask(`删除预设「${found.name}」？当前三组提示词保留。`, () => { config.presets = config.presets.filter(item => item.id !== found.id); if (config.selectedPreset === found.id) config.selectedPreset = ''; changed(); rebuildPresets(); }); }, 'trash', true);
    presets.append(preset, load, remove);
    const toolbar = el('div', 'ym-actions ym-prompt-toolbar');
    const nameRow = el('div', 'ym-prompt-name'), name = el('input'); name.type = 'text'; name.maxLength = 160; name.placeholder = '预设名称'; name.setAttribute('aria-label', '总结提示词预设名称'); nameRow.hidden = true;
    const nameConfirm = button('确认保存提示词预设', () => { const title = name.value.trim(); if (!title) return fail(new Error('请填写预设名称'));
        const previous = config.presets.find(item => item.name === title);
        const save = async () => { const value = { id: previous?.id || createId(), name: title, groups: clone(config.groups) };
            config.presets = [...config.presets.filter(item => item.id !== value.id), value]; config.selectedPreset = value.id;
            changed(); nameRow.hidden = true; rebuildPresets(); await persist(); };
        if (previous) ask(`覆盖同名预设「${title}」？`, save); else void save(); }, 'check', true);
    nameRow.append(name, nameConfirm, button('取消预设命名', () => { nameRow.hidden = true; }, 'close', true));
    const file = el('input'); file.type = 'file'; file.accept = 'application/json,.json'; file.hidden = true; file.setAttribute('aria-label', '导入忆幕提示词文件');
    toolbar.append(button('新增条目', () => { const entry = { id: createId(), name: '自定义提示词', enabled: true, text: '' }; config.groups[kind].push(entry); changed(); rebuildRows(); const row = rows.get(entry.id); row.open = true; row.querySelector('input[type="text"]')?.focus(); }, 'plus'),
        button('保存为预设', () => { name.value = ''; nameRow.hidden = false; name.focus(); }, 'book'),
        button('导入', () => file.click(), 'upload'), button('导出', () => { try {
            const data = exportPromptPreset(config);
            if (onExport) return onExport(data);
            const window = document.defaultView || globalThis, Url = window.URL, BlobClass = window.Blob || globalThis.Blob;
            if (!Url?.createObjectURL || !BlobClass) throw new Error('当前环境不能导出文件');
            const url = Url.createObjectURL(new BlobClass([data], { type: 'application/json' })), anchor = el('a');
            anchor.href = url; anchor.download = '忆幕-总结提示词.json'; document.body.append(anchor); anchor.click(); anchor.remove(); Url.revokeObjectURL(url);
        } catch (error) { fail(error); } }, 'download'),
        button('恢复内置默认', () => ask('恢复三组内置提示词？当前编辑会被替换，已保存的预设保留。', () => { config.groups = clone(DEFAULT_PROMPTS.groups); config.selectedPreset = ''; changed(); rebuild(); }), 'refresh'));
    const confirmation = el('div', 'ym-prompt-confirm ym-status'), confirmText = el('span'); confirmation.hidden = true;
    let confirmed = null;
    confirmation.append(confirmText, button('确认提示词操作', () => { const action = confirmed; confirmation.hidden = true; confirmed = null; if (action) void action(); }, 'check', true),
        button('取消提示词操作', () => { confirmation.hidden = true; confirmed = null; importCandidate = null; }, 'close', true));
    function ask(text, action) { confirmText.textContent = text; confirmed = action; confirmation.hidden = false; }
    file.addEventListener('change', async () => {
        const picked = file.files?.[0], sourceScope = scope; file.value = ''; if (!picked) return;
        try { if (picked.size > 2 * 1024 * 1024) throw new Error('提示词文件超过 2 MiB');
            const candidate = importPromptPreset(await picked.text()); if (disposed || sourceScope !== scope) return;
            importCandidate = candidate; const count = PROMPT_KINDS.reduce((n, key) => n + candidate.groups[key].length, 0);
            ask(`导入「${picked.name}」：三组共 ${count} 条，${candidate.presets.length} 个预设。替换当前条目，已有预设保留；确认后请保存。`, () => {
                try { config = mergeImportedPromptConfig(config, importCandidate, createId); importCandidate = null; changed(); rebuild(); }
                catch (error) { fail(error); }
            });
        } catch (error) { if (sourceScope === scope) fail(error); }
    });
    const groups = el('div', 'ym-prompt-groups'); groups.setAttribute('role', 'tablist'); groups.setAttribute('aria-label', '提示词用途');
    const groupButtons = new Map(), recallBadge = el('small', 'ym-prompt-recall-badge');
    for (const key of PROMPT_KINDS) { const node = button(LABELS[key], () => { kind = key; rebuildRows(); update(); }); node.setAttribute('role', 'tab'); if (key === 'recall') node.append(recallBadge); groupButtons.set(key, node); groups.append(node); }
    const list = el('div', 'ym-prompt-list'), empty = el('p', 'ym-muted', '此组没有启用规则。可新增条目或恢复内置默认。');
    const actions = el('div', 'ym-actions ym-prompt-save');
    const save = button('保存提示词', () => void persist(), 'check'); save.className += ' ym-primary';
    const cancel = button('取消提示词修改', () => { drafts.delete(scope); dirty = false; config = resolvePromptConfig(state.settings); revisions.set(scope, state.revision); status.textContent = ''; rebuild(); }, 'close');
    actions.append(save, cancel);
    const status = el('p', 'ym-muted ym-prompt-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.hidden = true;
    card.append(heading, presets, toolbar, nameRow, file, confirmation, groups, list, empty, actions, status); container.append(card);
    function fail(error) { status.textContent = error?.message || '提示词操作未完成'; status.hidden = false; onError(error); }
    function changed() { dirty = true; config.selectedPreset ||= ''; drafts.set(scope, clone(config)); status.textContent = ''; update(); }
    function move(id, target) { const entries = config.groups[kind], from = entries.findIndex(item => item.id === id); if (from < 0 || target < 0 || target >= entries.length || target === from) return;
        const [entry] = entries.splice(from, 1); entries.splice(target, 0, entry); changed(); rebuildRows(); }
    function rebuildPresets() {
        const selectedValue = config.selectedPreset || preset.value;
        preset.replaceChildren(...[['', '选择提示词预设'], ...config.presets.map(item => [item.id, item.name])].map(([id, title]) => { const option = el('option', '', title); option.value = id; return option; }));
        preset.value = config.presets.some(item => item.id === selectedValue) ? selectedValue : ''; update();
    }
    preset.addEventListener('change', update);
    function rebuildRows() {
        const open = new Set([...rows].filter(([, row]) => row.open).map(([id]) => id)); rows.clear(); list.replaceChildren();
        for (const node of rowButtons) allButtons.delete(node); rowButtons.clear();
        config.groups[kind].forEach((entry, index) => {
            const row = el('details', 'ym-prompt-item'); row.dataset.promptId = entry.id; row.open = open.has(entry.id);
            const summary = el('summary', 'ym-prompt-item-head'), drag = el('span', 'ym-prompt-drag'); drag.append(createYimuIcon('drag', { document })); drag.draggable = true; drag.title = '拖动排序'; drag.setAttribute('aria-hidden', 'true');
            const title = el('span', 'ym-prompt-item-title', entry.name), tools = el('span', 'ym-actions ym-prompt-item-tools');
            const enabled = el('input', 'ym-switch'); enabled.type = 'checkbox'; enabled.checked = entry.enabled; enabled.setAttribute('aria-label', `启用${entry.name}`);
            enabled.addEventListener('click', event => event.stopPropagation()); enabled.addEventListener('change', () => { entry.enabled = enabled.checked; changed(); });
            const up = button(`上移${entry.name}`, () => move(entry.id, index - 1), 'up', true), down = button(`下移${entry.name}`, () => move(entry.id, index + 1), 'down', true);
            up.className += ' ym-prompt-up'; down.className += ' ym-prompt-down'; up.dataset.edgeDisabled = String(index === 0); down.dataset.edgeDisabled = String(index === config.groups[kind].length - 1);
            const removeItem = button(`删除${entry.name}`, () => { config.groups[kind] = config.groups[kind].filter(item => item.id !== entry.id); changed(); rebuildRows(); }, 'trash', true);
            for (const node of [up, down, removeItem]) rowButtons.add(node);
            tools.append(enabled, up, down, removeItem); summary.append(drag, title, tools);
            const body = el('div', 'ym-prompt-item-body'), titleInput = el('input'); titleInput.type = 'text'; titleInput.maxLength = 160; titleInput.value = entry.name; titleInput.setAttribute('aria-label', `${LABELS[kind]}条目名称`);
            const content = el('textarea'); content.rows = 7; content.value = entry.text; content.maxLength = 120000; content.setAttribute('aria-label', `${entry.name}提示词正文`);
            titleInput.addEventListener('input', () => { entry.name = titleInput.value; title.textContent = titleInput.value || '未命名条目'; changed(); });
            content.addEventListener('input', () => { entry.text = content.value; changed(); });
            drag.addEventListener('dragstart', event => { if (busy || state.disabled) { event.preventDefault(); return; } dragId = entry.id; event.dataTransfer?.setData('text/plain', entry.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
            drag.addEventListener('dragend', () => { dragId = ''; });
            row.addEventListener('dragover', event => { if (dragId && dragId !== entry.id) event.preventDefault(); });
            row.addEventListener('drop', event => { if (busy || state.disabled || !dragId || dragId === entry.id) return; event.preventDefault(); move(dragId, config.groups[kind].findIndex(item => item.id === entry.id)); dragId = ''; });
            body.append(titleInput, content); row.append(summary, body); rows.set(entry.id, row); list.append(row);
        }); update();
    }
    function rebuild() { rebuildPresets(); rebuildRows(); }
    function update() {
        const disabled = busy || state.disabled === true;
        badge.textContent = dirty ? '未保存' : ''; badge.hidden = !dirty;
        for (const node of allButtons) node.disabled = disabled || node.dataset.edgeDisabled === 'true';
        for (const tag of ['input', 'textarea', 'select']) for (const node of card.querySelectorAll(tag)) node.disabled = disabled;
        save.disabled ||= !dirty; cancel.disabled ||= !dirty;
        load.disabled ||= !preset.value; remove.disabled ||= !preset.value;
        empty.hidden = config.groups[kind].some(entry => entry.enabled); status.hidden = !status.textContent;
        recallBadge.textContent = (state.recallEnabled ?? state.settings?.recall !== false) ? '已开启' : '未开启';
        for (const [key, node] of groupButtons) { node.setAttribute('aria-selected', String(kind === key)); node.tabIndex = 0; }
    }
    async function persist() {
        if (disposed || busy) return; let value;
        try { value = validatePromptConfig(config); } catch (error) { fail(error); return; }
        const savedScope = scope, metadata = { scope, revision: revisions.get(scope), snapshot: state.snapshot };
        busy = true; status.textContent = ''; update();
        try {
            if (await onSave(value, metadata) === false) throw new Error('提示词尚未保存，请重试');
            drafts.delete(savedScope);
            if (!disposed && savedScope === scope) { dirty = false; config = value; revisions.set(scope, state.revision); status.textContent = '提示词已保存'; rebuildPresets(); }
        } catch (error) { if (!disposed && savedScope === scope) fail(error); }
        finally { if (!disposed) { busy = false; update(); } }
    }
    function render(next = {}) {
        if (disposed) return;
        const nextScope = String(next.scope ?? JSON.stringify(next.snapshot?.binding || null));
        const switched = scope !== nextScope;
        if (switched && dirty) drafts.set(scope, clone(config));
        state = next;
        if (switched || !dirty) {
            scope = nextScope; const draft = drafts.get(scope); config = draft ? clone(draft) : resolvePromptConfig(next.settings); dirty = !!draft;
            if (!draft) revisions.set(scope, next.revision);
            if (switched) { nameRow.hidden = true; confirmation.hidden = true; confirmed = null; importCandidate = null; status.textContent = ''; }
            rebuild();
        } else update();
    }
    render();
    return { render, destroy() { if (disposed) return; disposed = true; drafts.clear(); revisions.clear(); rows.clear(); allButtons.clear(); rowButtons.clear(); card.remove(); } };
}
