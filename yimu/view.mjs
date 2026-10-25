// A standalone ST surface. All story/model/user text is rendered as text, never HTML.
const SETTINGS = [
    ['recent', '近期原文层数', 'number', 1],
    ['trigger', '自动整理阈值（token）', 'number', 256],
    ['batch', '单次整理上限（token）', 'number', 256],
    ['budget', '记忆预算（token，0 为自动）', 'number', 0],
    ['profileId', '整理连接', 'select'],
    ['model', '独立连接的模型（留空沿用连接）', 'text'],
    ['preference', '记忆整理偏好', 'textarea'],
];

export function sourceLabel(entry) {
    if (!entry?.source) return '手动补充';
    return `第 ${entry.source.start}–${entry.source.end} 层`;
}

export function orderedEntries(entries = []) {
    return entries.filter(entry => entry.status !== 'deleted').slice().sort((a, b) =>
        (a.source?.start ?? Infinity) - (b.source?.start ?? Infinity));
}

export function createView({ onAction, document = globalThis.document } = {}) {
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, action, className = '') => {
        const node = el('button', `ym-button ${className}`.trim(), label);
        node.type = 'button';
        node.setAttribute('aria-label', label);
        node.addEventListener('click', action);
        return node;
    };
    const field = (caption, input) => {
        const label = el('label', 'ym-field');
        label.append(el('span', '', caption), input);
        return label;
    };
    const textarea = (label, value = '') => {
        const node = el('textarea', 'ym-textarea');
        node.setAttribute('aria-label', label);
        node.value = value;
        node.rows = 5;
        return node;
    };

    let state = {}, opened = false, destroyed = false, returnFocus = null;
    let scopeKey = '', scopeGeneration = 0, localError = '', settingsGlobal = false;
    const edits = new Map(), cards = new Map(), settingDrafts = [new Map(), new Map()], settingRevisions = [null, null];
    const dialog = el('dialog', 'ym-dialog');
    dialog.setAttribute('aria-label', '忆幕');
    const shell = el('section', 'ym-shell');
    const header = el('header', 'ym-header');
    const heading = el('div', 'ym-heading');
    heading.append(el('span', 'ym-logo'), el('h2', '', '忆幕'));
    const closeButton = button('关闭忆幕', () => close(), 'ym-close');
    closeButton.textContent = '×';
    header.append(heading, closeButton);
    const scroller = el('div', 'ym-scroll');
    const status = el('p', 'ym-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const main = el('div', 'ym-content');
    scroller.append(status, main);
    shell.append(header, scroller);
    dialog.append(shell);
    document.body.append(dialog);

    const context = el('div', 'ym-context');
    const chatName = el('span', 'ym-chat-name');
    const refresh = button('刷新记忆', () => dispatch('refresh'), 'ym-small');
    context.append(chatName, refresh);
    const enableCard = el('section', 'ym-card');
    const enabled = el('input', 'ym-switch');
    enabled.type = 'checkbox';
    enabled.setAttribute('aria-label', '此聊天启用忆幕');
    const enableLabel = el('label', 'ym-switch-row');
    enableLabel.append(el('span', '', '此聊天启用忆幕'), enabled);
    const rangeForm = el('form', 'ym-range');
    rangeForm.hidden = true;
    const rangeStart = el('input'), rangeEnd = el('input');
    for (const input of [rangeStart, rangeEnd]) { input.type = 'number'; input.min = '1'; input.required = true; }
    rangeStart.setAttribute('aria-label', '开始楼层'); rangeEnd.setAttribute('aria-label', '结束楼层');
    const rangeFields = el('div', 'ym-two-columns');
    rangeFields.append(field('开始楼层', rangeStart), field('结束楼层', rangeEnd));
    const rangeHint = el('p', 'ym-muted', '确认初次整理范围；整理在后台进行，不影响正常聊天。');
    const rangeActions = el('div', 'ym-actions');
    const rangeSubmit = button('确认并开启', () => rangeForm.requestSubmit(), 'ym-primary');
    rangeActions.append(rangeSubmit, button('取消', () => { rangeForm.hidden = true; enabled.checked = false; }));
    rangeForm.append(rangeHint, rangeFields, rangeActions);
    enableCard.append(enableLabel, rangeForm);
    enabled.addEventListener('change', () => {
        if (!enabled.checked) { rangeForm.hidden = true; void dispatch('enable', { enabled: false }); return; }
        if (state.document?.initialRange) { void dispatch('enable', { enabled: true }); return; }
        const total = state.snapshot?.messages?.length ?? 0;
        if (!total) { void dispatch('enable', { enabled: true, range: { start: 1, end: 0, total: 0 } }); return; }
        rangeStart.value = '1'; rangeEnd.value = String(total);
        rangeStart.max = rangeEnd.max = String(total);
        rangeForm.hidden = false;
        rangeStart.focus();
    });
    rangeForm.addEventListener('submit', async event => {
        event.preventDefault();
        const total = state.snapshot?.messages?.length ?? 0;
        const start = Number(rangeStart.value), end = Number(rangeEnd.value);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
            localError = '请填写当前聊天内有效的起止楼层。'; updateStatus(); return;
        }
        if (await dispatch('enable', { enabled: true, range: { start, end, total } }, rangeSubmit)) rangeForm.hidden = true;
    });

    const settings = el('details', 'ym-card ym-settings');
    settings.append(el('summary', '', '整理设置'));
    const settingsScope = el('div', 'ym-actions ym-settings-scope');
    const localSettingsButton = button('当前聊天', () => { settingsGlobal = false; updateSettings(); });
    const globalSettingsButton = button('全局默认', () => { settingsGlobal = true; updateSettings(); });
    settingsScope.append(localSettingsButton, globalSettingsButton);
    const settingsForm = el('form', 'ym-settings-form'), controls = new Map();
    for (const [key, label, type, min] of SETTINGS) {
        const input = type === 'textarea' ? textarea(label) : el(type === 'select' ? 'select' : 'input');
        input.setAttribute('aria-label', label);
        if (type !== 'textarea' && type !== 'select') input.type = type;
        if (min !== undefined) { input.min = String(min); input.step = '1'; }
        input.addEventListener('input', () => {
            setDraft(key, type === 'number' ? Number(input.value) : input.value);
            updateFollow(key);
        });
        // Some mobile selects emit only change.
        if (type === 'select') input.addEventListener('change', () => {
            setDraft(key, input.value); updateFollow(key);
        });
        const reset = button('跟随默认', () => {
            setDraft(key, null); updateSettings();
        }, 'ym-small ym-follow');
        reset.setAttribute('aria-label', `${label}跟随默认`);
        const row = el('div', 'ym-setting-row');
        row.append(field(label, input), reset); settingsForm.append(row);
        controls.set(key, { input, reset, type, min });
    }
    const saveSettings = button('保存设置', () => settingsForm.requestSubmit(), 'ym-primary');
    const cancelSettings = button('取消设置修改', () => {
        const index = Number(settingsGlobal);
        settingDrafts[index].clear(); settingRevisions[index] = null;
        localError = ''; updateSettings(); updateStatus();
    });
    const settingsActions = el('div', 'ym-actions');
    settingsActions.append(saveSettings, cancelSettings); settingsForm.append(settingsActions);
    settingsForm.addEventListener('submit', async event => {
        event.preventDefault();
        const currentGlobal = settingsGlobal, draft = settingDrafts[Number(currentGlobal)];
        const values = Object.fromEntries(draft);
        if (!Object.keys(values).length) return;
        for (const [key, value] of Object.entries(values)) {
            const control = controls.get(key);
            if (control?.type === 'number' && value !== null && (!Number.isSafeInteger(value) || value < control.min)) {
                localError = `请填写不小于 ${control.min} 的整数。`; updateStatus(); control.input.focus(); return;
            }
        }
        if (await dispatch('settings', { global: currentGlobal, values, expectedRevision: settingRevisions[Number(currentGlobal)] }, saveSettings)) {
            // Keep edits typed after the save started.
            for (const [key, value] of Object.entries(values)) if (draft.get(key) === value) draft.delete(key);
            if (!draft.size) settingRevisions[Number(currentGlobal)] = null;
            updateSettings();
        }
    });
    settings.append(settingsScope, settingsForm);

    const controlsRow = el('div', 'ym-actions');
    const summarize = button('整理未覆盖内容', () => dispatch('summarize', {}, summarize), 'ym-primary');
    const retry = button('重试本次整理', () => dispatch('retry', {}, retry));
    const addManual = button('手动补充', () => {
        manualForm.hidden = false; manualInput.focus();
    });
    controlsRow.append(summarize, retry, addManual);
    const manualForm = el('form', 'ym-card ym-manual-form');
    manualForm.hidden = true;
    const manualInput = textarea('手动补充内容');
    const manualSave = button('保存补充', () => manualForm.requestSubmit(), 'ym-primary');
    manualSave.disabled = true;
    manualInput.addEventListener('input', () => { manualSave.disabled = !manualInput.value.trim(); });
    const manualActions = el('div', 'ym-actions');
    manualActions.append(manualSave, button('取消补充', () => { manualForm.hidden = true; }));
    manualForm.append(el('h3', '', '手动补充'), manualInput, manualActions);
    manualForm.addEventListener('submit', async event => {
        event.preventDefault();
        const text = manualInput.value.trim(); if (!text) return;
        if (await dispatch('manual', { text }, manualSave)) {
            if (manualInput.value.trim() === text) { manualInput.value = ''; manualForm.hidden = true; }
            manualSave.disabled = !manualInput.value.trim();
        }
    });
    const list = el('div', 'ym-list');
    const empty = el('p', 'ym-muted', '还没有记忆。开启后确认范围，或添加手动补充。');
    const deleted = el('details', 'ym-card ym-deleted');
    const deletedTitle = el('summary', '', '已删除的记忆'), deletedBody = el('div', 'ym-deleted-body');
    deleted.append(deletedTitle, deletedBody);
    const lastUsed = el('details', 'ym-card ym-last-used');
    lastUsed.append(el('summary', '', '最近一次请求中的记忆'));
    const usedBody = el('div', 'ym-used-body'); lastUsed.append(usedBody);
    scroller.insertBefore(context, status);
    main.append(enableCard, settings, controlsRow, manualForm, list, empty, deleted, lastUsed);

    async function dispatch(type, payload = {}, sourceButton) {
        if (destroyed || sourceButton?.disabled) return false;
        const generation = scopeGeneration;
        localError = ''; updateStatus();
        if (sourceButton) sourceButton.disabled = true;
        try {
            const result = await onAction?.(type, payload);
            if (destroyed || generation !== scopeGeneration) return false;
            return result !== false;
        } catch (error) {
            if (generation === scopeGeneration) { localError = error?.message || '操作未完成，请重试。'; updateStatus(); }
            return false;
        } finally {
            if (sourceButton?.isConnected && generation === scopeGeneration) sourceButton.disabled = false;
            if (!destroyed) updateControls();
        }
    }

    function updateStatus() {
        const sourceWarning = state.snapshot && state.document && state.sourceAvailable === false && !state.loading
            ? '当前聊天原件尚未通过核对，记忆暂不参与生成。' : '';
        const text = localError || state.error || sourceWarning || state.status || (state.loading ? '正在读取记忆…' : '');
        status.textContent = typeof text === 'string' ? text : String(text?.message || '');
        status.hidden = !status.textContent;
        status.className = `ym-status${localError || state.error ? ' ym-error' : ''}`;
    }
    function updateControls() {
        const available = Boolean(state.document && state.snapshot && !state.loading);
        main.hidden = !available;
        enabled.disabled = !available;
        if (rangeForm.hidden) enabled.checked = Boolean(state.document?.enabled && !state.paused);
        const canSummarize = available && state.document.enabled && !state.paused && state.sourceAvailable !== false;
        summarize.disabled = !canSummarize || Boolean(state.busy);
        retry.hidden = !(state.error && state.document?.enabled);
        retry.disabled = !canSummarize || Boolean(state.busy);
        refresh.disabled = Boolean(state.loading);
        for (const redo of list.querySelectorAll('[data-ym-redo]')) redo.disabled = !canSummarize || Boolean(state.busy);
        dialog.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    }
    function setDraft(key, value) {
        const index = Number(settingsGlobal);
        if (!settingDrafts[index].size) settingRevisions[index] = settingsGlobal ? state.defaults?.revision ?? 0 : state.document?.configRevision ?? 0;
        settingDrafts[index].set(key, value);
    }
    function updateFollow(key) {
        const { reset } = controls.get(key);
        const draft = settingDrafts[0];
        const overridden = draft.has(key) ? draft.get(key) !== null : Object.hasOwn(state.document?.settings || {}, key);
        reset.hidden = settingsGlobal;
        reset.disabled = !overridden;
        reset.textContent = overridden ? '跟随默认' : '已跟随';
    }
    function updateSettings() {
        localSettingsButton.setAttribute('aria-pressed', String(!settingsGlobal));
        globalSettingsButton.setAttribute('aria-pressed', String(settingsGlobal));
        const defaults = state.defaults?.values || {}, local = state.document?.settings || {};
        for (const [key, control] of controls) {
            const draft = settingDrafts[Number(settingsGlobal)], raw = draft.has(key) ? draft.get(key) : settingsGlobal ? defaults[key] : local[key];
            const value = raw ?? defaults[key] ?? '';
            if (control.type === 'select') {
                const options = [{ id: '', name: '沿用当前 ST 连接' }, ...(state.profiles || [])];
                if (value && !options.some(profile => profile.id === value)) options.push({ id: value, name: '原连接当前不可用' });
                control.input.replaceChildren(...options.map(profile => {
                    const option = el('option', '', profile.name || profile.id); option.value = profile.id; return option;
                }));
            }
            if (document.activeElement !== control.input) control.input.value = String(value);
            updateFollow(key);
        }
    }
    function entryAction(entry, action, extra = {}, sourceButton) {
        return dispatch('entry', { entryId: entry.id, expectedRevision: entry.revision, action, ...extra }, sourceButton);
    }
    function renderCard(entry, existing) {
        const signature = JSON.stringify(entry);
        if (existing?.signature === signature) return existing;
        const card = existing?.node || el('article', 'ym-card ym-memory');
        card.dataset.entryId = entry.id;
        const editing = edits.get(entry.id);
        // Replace saved text / conflict choices independently of an active editor.
        // Keeping the editor connected preserves focus, IME and unsaved revisions.
        for (const child of [...card.children]) if (child !== editing?.form) child.remove();
        const content = el('div', 'ym-memory-content');
        card.insertBefore(content, card.children[0] || null);
        const top = el('div', 'ym-memory-top');
        top.append(el('h3', '', sourceLabel(entry)));
        if (entry.edited) top.append(el('span', 'ym-muted', '已手动修订'));
        if (entry.status === 'excluded') top.append(el('span', 'ym-muted', '暂不使用'));
        content.append(top);
        if (entry.status === 'invalid') content.append(el('p', 'ym-inline-warning', entry.edited ? '原文已变化，人工修订已保留，暂不使用。' : '原文已变化，此条记忆暂不使用。'));
        const text = el('p', 'ym-memory-text', entry.text); content.append(text);
        const actions = el('div', 'ym-actions ym-entry-actions');
        const edit = button('编辑', () => startEdit(entry, card));
        edit.setAttribute('aria-label', `编辑${sourceLabel(entry)}`);
        actions.append(edit);
        if (entry.source) {
            const redo = button('重新总结', () => dispatch('redo', { entryId: entry.id, expectedRevision: entry.revision }, redo));
            redo.setAttribute('aria-label', `重新总结${sourceLabel(entry)}`);
            redo.dataset.ymRedo = '';
            redo.disabled = Boolean(state.busy) || !state.document?.enabled || Boolean(state.paused) || state.sourceAvailable === false;
            actions.append(redo);
        }
        const remove = button('删除', () => entryAction(entry, 'delete', {}, remove));
        remove.setAttribute('aria-label', `删除${sourceLabel(entry)}`); actions.append(remove);
        const more = el('details', 'ym-more'); more.append(el('summary', '', '更多'));
        const moreActions = el('div', 'ym-more-actions');
        const use = button(entry.status === 'excluded' ? '恢复使用' : '暂不使用', () => entryAction(entry, entry.status === 'excluded' ? 'restore' : 'exclude', {}, use));
        moreActions.append(use);
        if (entry.history?.length) {
            const undo = button('撤回上次修改', () => entryAction(entry, 'undo', {}, undo)); moreActions.append(undo);
        }
        if (entry.status === 'invalid' && entry.edited) {
            const keep = button('保留为手动补充', () => entryAction(entry, 'keepManual', {}, keep)); moreActions.append(keep);
        }
        more.append(moreActions); actions.append(more); content.append(actions);
        actions.hidden = Boolean(editing);
        if (entry.candidate) {
            const candidate = el('section', 'ym-candidate');
            candidate.append(el('h4', '', '重新总结候选'), el('p', 'ym-memory-text', entry.candidate.text));
            const choice = el('div', 'ym-actions');
            const accept = button('采用候选', () => entryAction(entry, 'acceptCandidate', {}, accept));
            const reject = button('保留原修订', () => entryAction(entry, 'discardCandidate', {}, reject));
            choice.append(accept, reject); candidate.append(choice); content.append(candidate);
        }
        for (const conflict of entry.conflicts || []) {
            const candidate = el('section', 'ym-candidate');
            candidate.append(el('h4', '', '另一份待确认修改'), el('p', 'ym-memory-text', conflict.text));
            const choice = el('div', 'ym-actions');
            const accept = button('采用此版本', () => entryAction(entry, 'acceptConflict', { conflictId: conflict.id }, accept));
            const reject = button('保留已保存版本', () => entryAction(entry, 'discardConflict', { conflictId: conflict.id }, reject));
            choice.append(accept, reject); candidate.append(choice); content.append(candidate);
        }
        return { node: card, signature };
    }
    function startEdit(entry, card) {
        const form = el('form', 'ym-edit-form'), input = textarea('编辑记忆内容', entry.text);
        const save = button('保存修订', () => form.requestSubmit(), 'ym-primary');
        const finishEdit = () => {
            edits.delete(entry.id);
            const item = cards.get(entry.id);
            if (item) item.signature = null;
            renderEntries();
        };
        const cancel = button('取消编辑', finishEdit);
        const actions = el('div', 'ym-actions'); actions.append(save, cancel);
        form.append(input, actions);
        edits.set(entry.id, { form, entry });
        card.append(form); input.focus();
        input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
        form.addEventListener('submit', async event => {
            event.preventDefault(); const value = input.value.trim(); if (!value) return;
            if (await dispatch('edit', { entryId: entry.id, expectedRevision: entry.revision, text: value }, save)) {
                finishEdit();
            }
        });
        card.querySelector('.ym-entry-actions')?.setAttribute('hidden', '');
    }
    function renderEntries() {
        // Source checks can invalidate a slice before the server acknowledges the
        // corresponding status write. Reflect that fact without mutating the document.
        const entries = orderedEntries(state.document?.entries).map(entry =>
            entry.status === 'active' && state.invalidSourceIds?.includes(entry.id) ? { ...entry, status: 'invalid' } : entry);
        const present = new Set();
        for (const entry of entries) {
            present.add(entry.id);
            const item = renderCard(entry, cards.get(entry.id));
            cards.set(entry.id, item);
            // Re-append only when order differs; moving a focused editor would blur it.
            const wantedIndex = entries.indexOf(entry);
            if (list.children[wantedIndex] !== item.node) list.insertBefore(item.node, list.children[wantedIndex] || null);
        }
        for (const [id, item] of cards) if (!present.has(id)) {
            // A remote deletion must not erase a draft still being edited locally.
            if (edits.has(id)) continue;
            item.node.remove(); cards.delete(id);
        }
        empty.hidden = entries.length > 0;
        const removed = (state.document?.entries || []).filter(entry => entry.status === 'deleted');
        deleted.hidden = !removed.length;
        deletedTitle.textContent = `已删除的记忆（${removed.length}）`;
        deletedBody.replaceChildren(...removed.map(entry => {
            const item = el('div', 'ym-used-entry');
            item.append(el('strong', '', sourceLabel(entry)), el('p', 'ym-memory-text', entry.text));
            const undo = button('撤回删除', () => entryAction(entry, 'undo', {}, undo));
            undo.setAttribute('aria-label', `撤回删除${sourceLabel(entry)}`);
            undo.disabled = !entry.history?.length;
            item.append(undo); return item;
        }));
    }
    function updateUsed() {
        const use = state.lastUsed;
        usedBody.replaceChildren();
        if (!use) { usedBody.append(el('p', 'ym-muted', '暂无可核对的请求记录。')); return; }
        usedBody.append(el('p', 'ym-muted', '仅记录已核对的请求上下文，不代表模型已接收。'));
        const usedEntries = use.entries || (use.memoryIds || []).map(id => state.document?.entries.find(entry => entry.id === id)).filter(Boolean);
        for (const entry of usedEntries) {
            const item = el('div', 'ym-used-entry'); item.append(el('strong', '', sourceLabel(entry)), el('p', 'ym-memory-text', entry.text)); usedBody.append(item);
        }
        if (Number.isFinite(use.tokens)) usedBody.append(el('p', 'ym-muted', `约 ${use.tokens} token（估算）`));
    }
    function render(nextState) {
        if (destroyed) return;
        state = nextState || {};
        const key = JSON.stringify(state.snapshot?.binding || null);
        if (key !== scopeKey) {
            scopeKey = key; scopeGeneration++;
            for (const item of cards.values()) item.node.remove();
            cards.clear(); edits.clear(); settingDrafts[0].clear(); settingDrafts[1].clear();
            settingRevisions[0] = settingRevisions[1] = null;
            rangeForm.hidden = true; manualForm.hidden = true; manualInput.value = ''; localError = '';
            scroller.scrollTop = 0;
        }
        chatName.textContent = state.snapshot?.name || '请选择单人聊天';
        updateStatus(); updateControls(); updateSettings(); renderEntries(); updateUsed();
    }
    function open() {
        if (destroyed || opened) return;
        returnFocus = document.activeElement;
        opened = true;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
        closeButton.focus();
    }
    function close() {
        if (!opened) return;
        opened = false;
        if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
        if (returnFocus?.isConnected) returnFocus.focus();
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = [...dialog.querySelectorAll('button,input,textarea,select,summary,[tabindex="0"]')].filter(node => !node.disabled && !node.closest('[hidden]'));
            if (!focusable.length) return;
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    return {
        render, open, close,
        destroy() { if (destroyed) return; close(); destroyed = true; scopeGeneration++; dialog.remove(); cards.clear(); edits.clear(); },
    };
}

export function mountEntries(onOpen, { document = globalThis.document } = {}) {
    const owned = [], observers = [];
    function make(id, label, className) {
        // This module owns these IDs only, not host or Qianmu nodes.
        document.getElementById(id)?.remove();
        const node = document.createElement('button');
        node.id = id; node.type = 'button'; node.className = className;
        node.setAttribute('aria-label', '忆幕'); node.title = '忆幕';
        const glyph = document.createElement('span'); glyph.className = 'ym-logo'; glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph);
        if (label) { const text = document.createElement('span'); text.textContent = label; node.append(text); }
        node.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            if (id === 'yimu-menu-entry') {
                const options = document.getElementById('options');
                if (options && document.defaultView?.getComputedStyle(options).display !== 'none') document.getElementById('options_button')?.click();
            }
            onOpen?.();
        });
        owned.push(node); return node;
    }
    const menu = document.querySelector('#options .options-content') || document.getElementById('options');
    if (menu) {
        const entry = make('yimu-menu-entry', '忆幕', 'ym-menu-entry interactable');
        const qianmu = menu.querySelector('[data-qm-st-menu="true"]');
        if (qianmu) menu.insertBefore(entry, qianmu.nextSibling); else menu.append(entry);
        // Qianmu may finish its own lazy initialization after this extension.
        // Watch only this menu's direct children, not chat messages or the whole page.
        const Observer = document.defaultView?.MutationObserver;
        if (Observer) {
            const observer = new Observer(() => {
                if (!entry.isConnected) return;
                const anchor = menu.querySelector('[data-qm-st-menu="true"]');
                if (anchor && anchor.nextSibling !== entry) menu.insertBefore(entry, anchor.nextSibling);
            });
            observer.observe(menu, { childList: true }); observers.push(observer);
        }
    }
    const send = document.getElementById('send_but');
    const sendParent = document.getElementById('rightSendForm');
    if (sendParent) sendParent.insertBefore(make('yimu-send-entry', '', 'ym-send-entry interactable'), send?.parentElement === sendParent ? send : null);
    return () => { for (const observer of observers) observer.disconnect(); for (const node of owned) node.remove(); };
}
