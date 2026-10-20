// Backup content is untrusted text. Never render a saved message as chat HTML.
const CHAT_BACKUP_RETENTION_DAYS = Object.freeze([3, 7, 15, 30]);
const DEFAULT_CHAT_BACKUP_RETENTION_DAYS = 30;
export function mountChatRecoveryView({ root, controller, getCharacters, confirm, notify = () => {} } = {}) {
    const document = root.ownerDocument, OTHER = '__qianmu_other_backups__';
    let disposed = false, visibleLimit = 10, selectedAvatar = '', selection = '', search = '', selectionRevision = 0, suggestionDismissed = false;
    // Keep preview data in the view so each expanded row owns its own
    // disclosure state. The controller still performs the bounded, verified
    // download; switching back to an already-open row never reloads it.
    const expandedPreviews = new Map();
    let activePreviewName = '';
    const CHARACTER_BATCH = 50;
    let characterLimit = CHARACTER_BATCH, targetLimit = CHARACTER_BATCH, targetSearch = '', searchTimer = null, targetSearchTimer = null;
    let characterIndex = null, characterIndexRevision = 0;
    const pickerStates = new WeakMap();
    let hasRead = false, automaticBusy = false, automaticMissing = false, automaticUnknown = false, automaticDirty = false, automaticRevision = 0;
    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, action) => {
        const node = element('button', '', label); node.type = 'button';
        node.addEventListener('click', action); return node;
    };
    const run = async action => {
        try { await action(); }
        catch (error) { if (!disposed) notify(error?.message || '操作未完成，请核对后重试。', 'warning'); }
    };
    // ST already owns the loaded character array. Index it in one linear pass;
    // batching below controls DOM size, never changes the full search source.
    const readCharacterIndex = () => {
        const raw = getCharacters?.() || [];
        let changed = !characterIndex || characterIndex.sources.length !== raw.length;
        for (let i = 0; !changed && i < raw.length; i++) {
            const old = characterIndex.sources[i], row = raw[i];
            changed = old.avatar !== row?.avatar || old.name !== row?.name;
        }
        if (!changed) return characterIndex;
        const sources = [], rows = [], names = new Map(), avatarCounts = new Map();
        for (const row of raw) {
            sources.push({ avatar: row?.avatar, name: row?.name });
            if (typeof row?.avatar !== 'string' || !row.avatar) continue;
            const name = typeof row.name === 'string' ? row.name : '';
            rows.push({ avatar: row.avatar, name, searchName: name.toLocaleLowerCase() });
            names.set(name, (names.get(name) || 0) + 1);
            avatarCounts.set(row.avatar, (avatarCounts.get(row.avatar) || 0) + 1);
        }
        for (const row of rows) row.label = names.get(row.name) > 1 ? `${row.name || '未命名角色'} · ${row.avatar}` : row.name || row.avatar;
        return characterIndex = { sources, rows, avatarCounts, revision: ++characterIndexRevision };
    };
    const characters = () => readCharacterIndex().rows;
    const option = (label, value) => { const node = element('option', '', label); node.value = value; return node; };
    const invalidatePreview = () => { expandedPreviews.clear(); activePreviewName = ''; selectionRevision++; visibleLimit = 10; };
    const unresolved = snapshot => !!snapshot.result && snapshot.result.status !== 'verified';
    const filteredRows = snapshot => {
        const currentCharacters = readCharacterIndex();
        const rows = (snapshot.backups || []).filter(row => selection === OTHER
            ? row.match !== 'candidate' || !(row.candidateAvatars || []).some(avatar => currentCharacters.avatarCounts.get(avatar) === 1)
            : !!selection && (row.candidateAvatars || []).includes(selection));
        // Native timestamps have no UTC offset. Keep timezone groups explicit;
        // never present server wall-clock and local instants as one exact order.
        // A longer conversation has a later final floor. Prefer that signal
        // over backup creation time so the newest usable story context is
        // surfaced first; creation time remains a deterministic tie-breaker.
        const floorOf = row => Number.isSafeInteger(row.lastMessageFloor)
            ? row.lastMessageFloor
            : Number.isSafeInteger(row.messageCount) ? row.messageCount : -1;
        return rows.sort((a, b) => {
            const floorDelta = floorOf(b) - floorOf(a);
            if (floorDelta) return floorDelta;
            const knownA = Number.isFinite(a.backupSort), knownB = Number.isFinite(b.backupSort);
            if (knownA !== knownB) return knownA ? -1 : 1;
            const dayA = a.backupDay || '', dayB = b.backupDay || '';
            return dayB.localeCompare(dayA) || String(a.timeZoneLabel || '').localeCompare(String(b.timeZoneLabel || ''))
                || ((Number.isFinite(b.backupSort) ? b.backupSort : -Infinity) - (Number.isFinite(a.backupSort) ? a.backupSort : -Infinity) || 0)
                || String(a.name).localeCompare(String(b.name));
        });
    };
    const tools = element('div', 'qm-recovery-tools qm-recovery-character-tools');
    const input = element('input'); input.type = 'search'; input.autocomplete = 'off'; input.placeholder = '搜索角色名'; input.setAttribute('aria-label', '搜索角色名');
    const suggestions = element('div', 'qm-recovery-role-suggestions');
    suggestions.setAttribute('role', 'listbox');
    input.addEventListener('input', () => {
        suggestionDismissed = false;
        selection = ''; selectedAvatar = ''; hasRead = false;
        invalidatePreview(); previewActions.hidden = true; recover.disabled = true;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { searchTimer = null; if (disposed) return; search = input.value; characterLimit = CHARACTER_BATCH; render(); }, 120);
    });
    const character = element('select', 'qm-recovery-character-select'); character.setAttribute('aria-label', '选择要找回的角色');
    character.addEventListener('change', () => {
        selection = character.value; selectedAvatar = selection === OTHER ? '' : selection; hasRead = false; invalidatePreview(); render();
    });
    const characterControl = element('span', 'qm-recovery-character-control');
    const characterIcon = button('', () => {
        character.focus();
        try { if (typeof character.showPicker === 'function') character.showPicker(); else character.click(); }
        catch { try { character.click(); } catch {} }
    });
    characterIcon.className = 'qm-recovery-icon-button'; characterIcon.innerHTML = '<i class="fa-solid fa-filter"></i><span class="qm-sr-only">选择角色</span>';
    characterIcon.setAttribute('aria-label', '选择角色');
    characterControl.append(characterIcon, character);
    const moreCharacters = button('加载更多角色', () => { characterLimit += CHARACTER_BATCH; render(); });
    moreCharacters.className = 'qm-recovery-character-more'; moreCharacters.setAttribute('aria-label', '加载更多角色');
    const load = button('读取备份', () => run(async () => {
        if (!selection) return;
        invalidatePreview(); hasRead = true; render(); await controller.load();
    }));
    load.innerHTML = '<i class="fa-solid fa-rotate"></i><span class="qm-sr-only">读取备份</span>';
    load.setAttribute('aria-label', '读取备份');
    tools.append(characterControl, input, load, moreCharacters);
    const status = element('p', 'qm-recovery-status'); status.setAttribute('role', 'status');
    const loadedCount = element('small', 'qm-recovery-loaded');
    const list = element('div', 'qm-recovery-list');
    const loadMoreBackups = button('加载更多备份', () => { visibleLimit += 10; render(); });
    loadMoreBackups.className = 'qm-recovery-load-more';
    // Recovery actions remain shared because only one target can be active at
    // a time; the preview bodies themselves are rendered per row below.
    const previewActions = element('section', 'qm-recovery-preview qm-recovery-preview-actions');
    const previewActionsTitle = element('h4');
    const fixedTarget = element('p', 'qm-recovery-target-fixed');
    const targetLabel = element('label', '', '找回至角色');
    const targetTools = element('div', 'qm-recovery-target-tools');
    const targetInput = element('input', 'qm-recovery-target-search'); targetInput.type = 'search'; targetInput.placeholder = '搜索目标角色名'; targetInput.setAttribute('aria-label', '搜索目标角色名');
    targetInput.addEventListener('input', () => {
        selectionRevision++; clearTimeout(targetSearchTimer);
        targetSearchTimer = setTimeout(() => { targetSearchTimer = null; if (disposed) return; targetSearch = targetInput.value; targetLimit = CHARACTER_BATCH; render(); }, 120);
    });
    const target = element('select'); target.setAttribute('aria-label', '找回副本的目标角色');
    target.addEventListener('change', () => { selectedAvatar = target.value; selectionRevision++; render(); });
    target.append(option('请选择目标角色', ''));
    const moreTargets = button('加载更多目标角色', () => { targetLimit += CHARACTER_BATCH; render(); });
    moreTargets.className = 'qm-recovery-character-more';
    moreTargets.setAttribute('aria-label', '加载更多目标角色');
    targetTools.append(targetInput, target, moreTargets); targetLabel.append(targetTools);
    const recover = button('找回至所选角色', () => run(async () => {
        const before = controller.snapshot(), currentPreview = activePreviewName ? expandedPreviews.get(activePreviewName) : null;
        const name = currentPreview?.name, revision = currentPreview?.revision;
        const avatar = selectedAvatar, selectionToken = selectionRevision, matches = characters().filter(row => row.avatar === avatar);
        if (matches.length !== 1 || !name || !currentPreview.canRecover || before.busy || before.result) return;
        const characterName = matches[0].name;
        if (await confirm(`请确认预览是要找回的角色单聊。将备份另存为“${characterName || '未命名角色'}”的新聊天？原聊天与备份不会被覆盖。`) !== true) return;
        const after = controller.snapshot(), afterPreview = activePreviewName ? expandedPreviews.get(activePreviewName) : null, currentCharacters = characters().filter(row => row.avatar === avatar);
        if (disposed || selectedAvatar !== avatar || selectionRevision !== selectionToken || afterPreview?.name !== name || afterPreview?.revision !== revision
            || after.preview?.name !== name || after.preview?.revision !== revision || after.busy || after.result
            || currentCharacters.length !== 1 || currentCharacters[0].name !== characterName) return;
        await controller.recover(avatar);
    }));
    previewActions.append(previewActionsTitle, fixedTarget, targetLabel, recover);
    const receipt = element('section', 'qm-recovery-receipt');
    const receiptText = element('p'); receiptText.setAttribute('role', 'status');
    const verify = button('核实上次结果', () => run(() => controller.verify())); receipt.append(receiptText, verify);

    const automatic = element('section', 'qm-recovery-auto');
    automatic.append(element('h4', 'qm-recovery-auto-title', '自动备份'));
    const automaticFields = element('div', 'qm-recovery-auto-fields');
    const enabledLabel = element('label', 'qm-recovery-auto-toggle', '启用自动备份');
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.setAttribute('aria-label', '启用自动备份');
    const toggleTrack = element('span', 'qm-recovery-toggle-track');
    const toggle = element('span', 'qm-recovery-toggle'); toggle.append(enabled, toggleTrack); enabledLabel.append(toggle);
    const intervalLabel = element('label', '', '备份间隔（分钟）');
    const interval = element('input'); interval.type = 'number'; interval.min = '15'; interval.max = '1440'; interval.step = '1'; interval.value = '30'; interval.setAttribute('aria-label', '备份间隔（分钟）'); intervalLabel.append(interval);
    const capacityLabel = element('label', '', '备份空间（MB）');
    const capacity = element('input'); capacity.type = 'number'; capacity.min = '256'; capacity.max = '10240'; capacity.step = '1'; capacity.setAttribute('aria-label', '备份空间（MB）');
    capacity.value = '1024';
    capacityLabel.append(capacity);
    const versionsLabel = element('label', '', '单聊天保留版本数');
    const versions = element('input'); versions.type = 'number'; versions.min = '1'; versions.max = '20000'; versions.step = '1'; versions.value = ''; versions.placeholder = '不限'; versions.setAttribute('aria-label', '单聊版本上限');
    versionsLabel.append(versions);
    const retentionLabel = element('label', '', '保留周期');
    const retention = element('select'); retention.setAttribute('aria-label', '保留周期');
    for (const days of CHAT_BACKUP_RETENTION_DAYS) retention.append(option(`${days} 天`, String(days)));
    retention.value = String(DEFAULT_CHAT_BACKUP_RETENTION_DAYS);
    retentionLabel.append(retention);
    let automaticSaveTimer = null, automaticInspectTimer = null;
    const dirty = () => {
        automaticDirty = true; automaticRevision++; render();
        clearTimeout(automaticSaveTimer);
        automaticSaveTimer = setTimeout(() => void persistAutomaticDraft(), 280);
    };
    enabled.addEventListener('change', dirty); interval.addEventListener('input', dirty); capacity.addEventListener('input', dirty); versions.addEventListener('input', dirty); retention.addEventListener('change', dirty);
    automaticFields.append(enabledLabel, intervalLabel, capacityLabel, versionsLabel, retentionLabel);
    const automaticStatus = element('p', 'qm-recovery-auto-status'); automaticStatus.setAttribute('role', 'status');
    const inspectAutomatic = async () => {
        if (automaticBusy || controller.snapshot().busy || controller.snapshot().automaticBackup?.busy) return;
        if (typeof controller.inspectAutomaticBackup !== 'function') { automaticMissing = true; render(); return; }
        const resolvingUnknown = automaticUnknown || controller.snapshot().automaticBackup?.configurationUnknown === true;
        automaticRevision++;
        automaticBusy = true; render();
        try {
            await controller.inspectAutomaticBackup();
            const current = controller.snapshot().automaticBackup;
            if (current?.availability === 'available' && current.status && !current.error) {
                automaticUnknown = false;
                // An ordinary status refresh must not discard unsaved inputs.
                // A previously submitted unknown draft is resolved by readback.
                if (resolvingUnknown) automaticDirty = false;
            }
        } finally { automaticBusy = false; render(); }
    };
    const persistAutomaticDraft = async () => run(async () => {
        const current = controller.snapshot().automaticBackup;
        if (automaticBusy || controller.snapshot().busy || current?.busy || current?.configurationUnknown || automaticUnknown || current?.availability !== 'available' || typeof controller.configureAutomaticBackup !== 'function') return;
        const draft = {
            enabled: enabled.checked,
            intervalMinutes: Number(interval.value),
            limitMiB: Number(capacity.value),
            maxVersionsPerChat: versions.value === '' ? 0 : Number(versions.value),
            retentionDays: Number(retention.value),
        };
        if (!Number.isSafeInteger(draft.intervalMinutes) || draft.intervalMinutes < 15 || draft.intervalMinutes > 1440) { notify('备份间隔请填写 15–1440 的整数分钟。', 'warning'); return; }
        if (capacity.validity?.badInput || !capacity.value.trim() || !Number.isSafeInteger(draft.limitMiB) || draft.limitMiB < 256 || draft.limitMiB > 10240) { notify('备份空间请填写 256–10240 的整数 MB，不能为空。', 'warning'); return; }
        if (versions.validity?.badInput || !Number.isSafeInteger(draft.maxVersionsPerChat) || draft.maxVersionsPerChat < 0 || draft.maxVersionsPerChat > 20000 || (versions.value !== '' && draft.maxVersionsPerChat === 0)) { notify('单聊版本上限请留空表示不限，或填写 1–20000 的整数。', 'warning'); return; }
        if (!CHAT_BACKUP_RETENTION_DAYS.includes(draft.retentionDays)) { notify('保留周期请选择 3、7、15 或 30 天。', 'warning'); return; }
        const revision = automaticRevision;
        if (disposed || revision !== automaticRevision || automaticBusy || controller.snapshot().busy || controller.snapshot().automaticBackup?.busy || controller.snapshot().automaticBackup?.configurationUnknown) return;
        automaticBusy = true; render();
        try {
            await controller.configureAutomaticBackup(draft);
            const result = controller.snapshot().automaticBackup;
            if (result?.error) automaticUnknown = true;
            else automaticDirty = false;
        } catch (error) { automaticUnknown = true; throw error; }
        finally { automaticBusy = false; render(); }
    });
    automatic.append(automaticFields, automaticStatus);
    root.replaceChildren(status, tools, suggestions, loadedCount, list, previewActions, receipt, automatic);

    const createPreviewSection = (displayName, currentPreview) => {
        const section = element('section', 'qm-recovery-preview');
        section.append(element('h4', '', displayName));
        const floorLimit = currentPreview.previewFloorLimit || 5;
        const previewHint = element('small', 'qm-recovery-preview-hint',
            `预览仅加载最后${floorLimit}层${currentPreview.messageCount > floorLimit ? '' : '（不足则全部）'}`);
        const body = element('div', 'qm-recovery-preview-body');
        body.append(previewHint);
        for (const message of currentPreview.previewMessages || []) {
            const details = element('details', 'qm-recovery-message');
            const summary = element('summary', '', `第 ${message.floor} 层 · ${message.name}`);
            const content = element('pre', '', message.text);
            details.append(summary, content);
            body.append(details);
        }
        section.append(body);
        return section;
    };

    function renderAutomatic(snapshot) {
        const state = snapshot.automaticBackup || { availability: 'unknown', busy: false }, stored = state.status;
        const busy = automaticBusy || !!state.busy || !!snapshot.busy, available = !automaticMissing && state.availability === 'available';
        const unknown = automaticUnknown || state.configurationUnknown === true;
        if (stored && !automaticDirty && !busy) {
            enabled.checked = stored.enabled === true;
            interval.value = String(stored.intervalMinutes || 30);
            capacity.value = String(stored.limitMiB || 1024);
            versions.value = stored.maxVersionsPerChat ? String(stored.maxVersionsPerChat) : '';
            retention.value = String(CHAT_BACKUP_RETENTION_DAYS.includes(stored.retentionDays) ? stored.retentionDays : DEFAULT_CHAT_BACKUP_RETENTION_DAYS);
        }
        for (const node of [enabled, interval, capacity, versions, retention]) node.disabled = !available || busy || unknown;
        if (busy) {
            automaticStatus.hidden = false;
            automaticStatus.textContent = automaticDirty ? '正在保存备份设置…' : '正在读取备份设置…';
        } else if (unknown) {
            automaticStatus.hidden = false;
            automaticStatus.textContent = '设置结果尚未确认，请稍后重新打开自动备份。';
        } else if (automaticMissing || state.availability === 'unavailable') {
            automaticStatus.hidden = false;
            automaticStatus.textContent = '自动备份需要千幕增强服务 v1.59.482；不影响读取 ST 现有备份。';
        } else if (state.error) {
            automaticStatus.hidden = false;
            automaticStatus.textContent = state.error;
        } else {
            automaticStatus.hidden = true;
            automaticStatus.textContent = '';
        }
    }

    function renderCharacterPicker(select, more, index, query, limit, selected, other = false) {
        const normalized = query.trim().toLocaleLowerCase(), previous = pickerStates.get(select);
        if (previous?.revision === index.revision && previous.query === normalized && previous.limit === limit && previous.selected === selected) return;
        const matching = previous?.revision === index.revision && previous.query === normalized
            ? previous.matching : index.rows.filter(row => !normalized || row.searchName.includes(normalized));
        const shown = matching.slice(0, limit), nodes = [option(other ? '请选择角色' : '请选择目标角色', '')];
        // Keep an explicit current selection even outside this search/page.
        // A search never silently chooses a different role or clears a target.
        const current = index.rows.find(row => row.avatar === selected);
        if (current && !shown.some(row => row.avatar === selected)) nodes.push(option(`当前：${current.label}`, current.avatar));
        for (const row of shown) nodes.push(option(row.label, row.avatar));
        if (other) nodes.push(option('其他／未匹配备份', OTHER));
        select.replaceChildren(...nodes); select.value = selected;
        more.hidden = matching.length <= limit;
        more.textContent = `加载更多（${Math.min(limit, matching.length)} / ${matching.length}）`;
        pickerStates.set(select, { revision: index.revision, query: normalized, limit, selected, matching });
    }

    function render(snapshot = controller.snapshot()) {
        if (disposed) return;
        const index = readCharacterIndex(), allCharacters = index.rows;
        renderCharacterPicker(character, moreCharacters, index, search, characterLimit, selection, true);
        if (character.value !== selection) { selection = ''; selectedAvatar = ''; hasRead = false; invalidatePreview(); }
        const rows = filteredRows(snapshot), currentPreview = activePreviewName ? expandedPreviews.get(activePreviewName) : null;
        const locked = unresolved(snapshot);
        load.classList.toggle('is-loading', !!snapshot.busy);
        load.disabled = !!snapshot.busy || !selection; input.disabled = !!snapshot.busy; character.disabled = !!snapshot.busy; characterIcon.disabled = !!snapshot.busy;
        moreCharacters.disabled = !!snapshot.busy;
        status.hidden = !(snapshot.busy || snapshot.error);
        status.classList.toggle('is-loading', !!snapshot.busy);
        status.replaceChildren();
        if (snapshot.busy) {
            status.append(element('span', 'qm-recovery-loading-dot'), element('span', '', '正在读取，请稍候…'));
        } else if (snapshot.error) status.textContent = snapshot.error;
        input.disabled = !!snapshot.busy;
        const indexForSuggestions = readCharacterIndex();
        const suggestionQuery = input.value.trim().toLocaleLowerCase();
        const suggestionRows = suggestionQuery
            ? indexForSuggestions.rows.filter(row => row.searchName.includes(suggestionQuery)).slice(0, 50)
            : [];
        suggestions.hidden = suggestionDismissed || !suggestionQuery || suggestionRows.length === 0;
        suggestions.replaceChildren(...suggestionRows.map(row => {
            const suggestion = button(row.label, () => {
                input.value = row.name;
                search = row.name;
                selection = row.avatar;
                selectedAvatar = row.avatar;
                hasRead = false;
                invalidatePreview();
                suggestionDismissed = true;
                render();
                input.focus();
            });
            suggestion.className = 'qm-recovery-suggestion';
            suggestion.setAttribute('role', 'option');
            return suggestion;
        }));
        const loadedRole = selection === OTHER
            ? '其他备份'
            : allCharacters.find(row => row.avatar === selection)?.name || '当前角色';
        const loadedVisible = Math.min(rows.length, visibleLimit);
        loadedCount.textContent = snapshot.busy
            ? '正在读取备份…'
            : hasRead ? `当前已加载 ${loadedVisible} 份\n${loadedRole} · 共 ${rows.length} 份聊天记录` : '';
        loadedCount.hidden = !snapshot.busy && !hasRead;
        previewActions.hidden = !currentPreview;
        previewActionsTitle.textContent = currentPreview
            ? `当前找回：${rows.find(row => row.name === currentPreview.name)?.chatFile || currentPreview.name}`
            : '';
        list.replaceChildren();
        const shownRows = rows.slice(0, visibleLimit);
        const formatLastMessage = value => {
            if (value === '' || value == null) return '';
            const date = new Date(value);
            return Number.isFinite(date.getTime()) ? date.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : String(value);
        };
        for (const row of shownRows) {
            const item = button('', () => run(async () => {
                const before = controller.snapshot(), epoch = selectionRevision;
                if (before.busy || unresolved(before) || !filteredRows(before).some(candidate => candidate.name === row.name)) return;
                if (expandedPreviews.has(row.name)) {
                    expandedPreviews.delete(row.name);
                    if (activePreviewName === row.name) {
                        const last = [...expandedPreviews.keys()].at(-1);
                        activePreviewName = last || '';
                    }
                    render();
                    return;
                }
                render(); await controller.preview(row.name);
                const after = controller.snapshot();
                if (disposed || epoch !== selectionRevision || after.preview?.name !== row.name || !filteredRows(after).some(candidate => candidate.name === row.name)) return;
                expandedPreviews.set(row.name, after.preview);
                activePreviewName = row.name;
                render();
            }));
            const displayName = typeof row.chatFile === 'string' && row.chatFile ? row.chatFile : row.name;
            item.className = 'qm-recovery-item'; item.disabled = !!snapshot.busy || locked; item.title = displayName;
            const expanded = expandedPreviews.has(row.name);
            item.classList.toggle('is-selected', expanded);
            item.classList.toggle('is-active', activePreviewName === row.name);
            item.setAttribute('aria-pressed', String(expanded));
            const count = Number.isFinite(row.messageCount) ? `${row.messageCount} 条消息` : '消息数待预览';
            const title = element('span', 'qm-recovery-name', displayName);
            const sourceBadge = element('small', 'qm-recovery-source', row.sourceLabel || 'ST备份');
            const titleLine = element('span', 'qm-recovery-title-line'); titleLine.append(title, sourceBadge);
            const metadata = [count, row.size].filter(Boolean).join(' · ');
            const lastMessage = formatLastMessage(row.lastMessageAt);
            item.append(titleLine, element('small', 'qm-recovery-meta', metadata + (lastMessage ? ` · 最后对话 ${lastMessage}` : '')));
            if (row.excerpt) item.append(element('span', 'qm-recovery-excerpt', row.excerpt));
            const wrap = element('article', 'qm-recovery-row'); wrap.append(item);
            const rowPreview = expandedPreviews.get(row.name);
            if (rowPreview) wrap.append(createPreviewSection(displayName, rowPreview));
            list.append(wrap);
        }
        list.append(loadMoreBackups);
        loadMoreBackups.hidden = rows.length <= visibleLimit;
        loadMoreBackups.disabled = !!snapshot.busy;
        const matches = allCharacters.filter(row => row.avatar === selectedAvatar);
        fixedTarget.hidden = true;
        fixedTarget.textContent = '';
        targetLabel.hidden = selection !== OTHER;
        if (selection === OTHER) {
            renderCharacterPicker(target, moreTargets, index, targetSearch, targetLimit, selectedAvatar);
            if (target.value !== selectedAvatar) selectedAvatar = '';
        }
        target.disabled = !!snapshot.busy;
        targetInput.disabled = !!snapshot.busy; moreTargets.disabled = !!snapshot.busy;
        recover.textContent = `找回至${matches.length === 1 ? matches[0].label : '所选角色'}`;
        recover.disabled = !!snapshot.busy || matches.length !== 1 || !currentPreview?.canRecover || !!snapshot.result;
        receipt.hidden = !snapshot.result;
        if (snapshot.result) {
            const result = snapshot.result;
            receiptText.textContent = result.status === 'verified'
                ? `已找回 ${result.messageCount} 条消息至“${result.target?.name || '所选角色'}”。请从该角色的聊天记录打开副本：${result.fileName}`
                : result.status === 'conflict' ? '找到的文件与预期内容不一致，未覆盖或自动重试。请保留原件并核对。'
                    : '尚未确认是否已创建副本。请先核实上次结果，不要重复找回。';
            verify.hidden = result.status === 'verified'; verify.disabled = !!snapshot.busy;
        }
        renderAutomatic(snapshot);
    }
    render();
    // A fixed, expanded card should be useful on first render. Avoid a
    // duplicate request when a host already read the status before mounting.
    if (!controller.snapshot().automaticBackup?.status && !controller.snapshot().automaticBackup?.busy) {
        automaticInspectTimer = setTimeout(() => {
            automaticInspectTimer = null;
            if (!disposed) void run(inspectAutomatic);
        }, 0);
    }
    return Object.freeze({ render, dispose() { disposed = true; clearTimeout(searchTimer); clearTimeout(targetSearchTimer); clearTimeout(automaticSaveTimer); clearTimeout(automaticInspectTimer); root.replaceChildren(); } });
}
