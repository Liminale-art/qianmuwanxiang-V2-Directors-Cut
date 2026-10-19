// Backup content is untrusted text. Never render a saved message as chat HTML.
export function mountChatRecoveryView({ root, controller, getCharacters, confirm, notify = () => {} } = {}) {
    const document = root.ownerDocument, OTHER = '__qianmu_other_backups__';
    let disposed = false, page = 0, selectedAvatar = '', selection = '', search = '', selectionRevision = 0, previewTicket = null;
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
    const invalidatePreview = () => { previewTicket = null; selectionRevision++; page = 0; };
    const unresolved = snapshot => !!snapshot.result && snapshot.result.status !== 'verified';
    const filteredRows = snapshot => {
        const currentCharacters = readCharacterIndex();
        const rows = (snapshot.backups || []).filter(row => selection === OTHER
            ? row.match !== 'candidate' || !(row.candidateAvatars || []).some(avatar => currentCharacters.avatarCounts.get(avatar) === 1)
            : !!selection && (row.candidateAvatars || []).includes(selection));
        // Native timestamps have no UTC offset. Keep timezone groups explicit;
        // never present server wall-clock and local instants as one exact order.
        return rows.sort((a, b) => {
            const knownA = Number.isFinite(a.backupSort), knownB = Number.isFinite(b.backupSort);
            if (knownA !== knownB) return knownA ? -1 : 1;
            const dayA = a.backupDay || '', dayB = b.backupDay || '';
            return dayB.localeCompare(dayA) || String(a.timeZoneLabel || '').localeCompare(String(b.timeZoneLabel || ''))
                || ((Number.isFinite(b.backupSort) ? b.backupSort : -Infinity) - (Number.isFinite(a.backupSort) ? a.backupSort : -Infinity) || 0)
                || String(a.name).localeCompare(String(b.name));
        });
    };
    const visiblePreview = snapshot => previewTicket && snapshot.preview?.name === previewTicket.name
        && snapshot.preview?.revision === previewTicket.revision && filteredRows(snapshot).some(row => row.name === previewTicket.name)
        ? snapshot.preview : null;

    const hint = element('p', 'qm-recovery-hint', '先选角色，再读取备份，按时间预览并另建找回副本。原聊天与备份不会被覆盖。');
    const tools = element('div', 'qm-recovery-tools qm-recovery-character-tools');
    const input = element('input'); input.type = 'search'; input.placeholder = '搜索角色名'; input.setAttribute('aria-label', '搜索角色名');
    input.addEventListener('input', () => {
        invalidatePreview(); preview.hidden = true; recover.disabled = true;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { searchTimer = null; if (disposed) return; search = input.value; characterLimit = CHARACTER_BATCH; render(); }, 120);
    });
    const character = element('select', 'qm-recovery-character-select'); character.setAttribute('aria-label', '选择要找回的角色');
    character.addEventListener('change', () => {
        selection = character.value; selectedAvatar = selection === OTHER ? '' : selection; invalidatePreview(); render();
    });
    const moreCharacters = button('加载更多角色', () => { characterLimit += CHARACTER_BATCH; render(); });
    moreCharacters.className = 'qm-recovery-character-more'; moreCharacters.setAttribute('aria-label', '加载更多角色');
    const load = button('读取备份', () => run(async () => {
        if (!selection) return;
        invalidatePreview(); hasRead = true; render(); await controller.load();
    }));
    tools.append(input, character, load, moreCharacters);
    const status = element('p', 'qm-recovery-status'); status.setAttribute('role', 'status');
    const list = element('div', 'qm-recovery-list');
    const pager = element('div', 'qm-recovery-pager');
    const previous = button('上一页', () => { page--; render(); });
    const pageLabel = element('span');
    const next = button('下一页', () => { page++; render(); }); pager.append(previous, pageLabel, next);
    const preview = element('section', 'qm-recovery-preview');
    const previewTitle = element('h4');
    const previewText = element('pre'); previewText.tabIndex = 0;
    const sourceDetails = element('details', 'qm-recovery-file-details');
    const sourceName = element('p'); sourceDetails.append(element('summary', '', '原备份文件名'), sourceName);
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
    const recover = button('另建找回副本', () => run(async () => {
        const before = controller.snapshot(), currentPreview = visiblePreview(before), name = currentPreview?.name, revision = currentPreview?.revision;
        const avatar = selectedAvatar, selectionToken = selectionRevision, matches = characters().filter(row => row.avatar === avatar);
        if (matches.length !== 1 || !name || !currentPreview.canRecover || before.busy || before.result) return;
        const characterName = matches[0].name;
        if (await confirm(`请确认预览是要找回的角色单聊。将备份另存为“${characterName || '未命名角色'}”的新聊天？原聊天与备份不会被覆盖。`) !== true) return;
        const after = controller.snapshot(), afterPreview = visiblePreview(after), currentCharacters = characters().filter(row => row.avatar === avatar);
        if (disposed || selectedAvatar !== avatar || selectionRevision !== selectionToken || afterPreview?.name !== name || afterPreview?.revision !== revision || after.busy || after.result
            || currentCharacters.length !== 1 || currentCharacters[0].name !== characterName) return;
        await controller.recover(avatar);
    }));
    preview.append(previewTitle, previewText, sourceDetails, fixedTarget, targetLabel, recover);
    const receipt = element('section', 'qm-recovery-receipt');
    const receiptText = element('p'); receiptText.setAttribute('role', 'status');
    const verify = button('核实上次结果', () => run(() => controller.verify())); receipt.append(receiptText, verify);

    const automatic = element('details', 'qm-recovery-auto');
    automatic.append(element('summary', '', '自动备份'));
    const automaticHint = element('p', 'qm-recovery-hint', 'ST 运行时由服务器定时备份；ST 所在设备休眠、关机或服务停止时暂停。到达上限后轮换旧版本，每份聊天保留至少一份有效副本；无法保底时暂停并提醒。');
    const automaticFields = element('div', 'qm-recovery-auto-fields');
    const enabledLabel = element('label', 'qm-recovery-auto-toggle', '启用自动备份');
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.setAttribute('aria-label', '启用自动备份'); enabledLabel.append(enabled);
    const intervalLabel = element('label', '', '备份间隔（分钟）');
    const interval = element('input'); interval.type = 'number'; interval.min = '15'; interval.max = '1440'; interval.step = '1'; interval.value = '30'; interval.setAttribute('aria-label', '备份间隔（分钟）'); intervalLabel.append(interval);
    const capacityLabel = element('label', '', '有效备份空间上限（MB）');
    const capacity = element('input'); capacity.type = 'number'; capacity.min = '256'; capacity.max = '10240'; capacity.step = '1'; capacity.setAttribute('aria-label', '有效备份空间上限（MB）');
    capacity.value = '1024'; capacityLabel.append(capacity, element('small', '', '1024 MB 约为 1 GB'));
    const versionsLabel = element('label', '', '每份聊天最多保留版本数');
    const versions = element('input'); versions.type = 'number'; versions.min = '1'; versions.max = '20000'; versions.step = '1'; versions.value = ''; versions.placeholder = '留空不限'; versions.setAttribute('aria-label', '每份聊天最多保留版本数');
    versionsLabel.append(versions, element('small', '', '留空不限；至少保留 1 份有效副本'));
    const dirty = () => { automaticDirty = true; automaticRevision++; render(); };
    enabled.addEventListener('change', dirty); interval.addEventListener('input', dirty); capacity.addEventListener('input', dirty); versions.addEventListener('input', dirty);
    automaticFields.append(enabledLabel, intervalLabel, capacityLabel, versionsLabel);
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
    automatic.addEventListener('toggle', () => { if (automatic.open) void run(inspectAutomatic); });
    const refreshAutomatic = button('读取状态', () => run(inspectAutomatic));
    const saveAutomatic = button('保存设置', () => run(async () => {
        const current = controller.snapshot().automaticBackup;
        if (automaticBusy || controller.snapshot().busy || current?.busy || current?.configurationUnknown || automaticUnknown || current?.availability !== 'available' || typeof controller.configureAutomaticBackup !== 'function') return;
        const draft = { enabled: enabled.checked, intervalMinutes: Number(interval.value), limitMiB: Number(capacity.value), maxVersionsPerChat: versions.value === '' ? 0 : Number(versions.value) };
        if (!Number.isSafeInteger(draft.intervalMinutes) || draft.intervalMinutes < 15 || draft.intervalMinutes > 1440) { notify('备份间隔请填写 15–1440 的整数分钟。', 'warning'); return; }
        if (capacity.validity?.badInput || !capacity.value.trim() || !Number.isSafeInteger(draft.limitMiB) || draft.limitMiB < 256 || draft.limitMiB > 10240) { notify('有效备份空间请填写 256–10240 的整数 MB，不能为空。', 'warning'); return; }
        if (versions.validity?.badInput || !Number.isSafeInteger(draft.maxVersionsPerChat) || draft.maxVersionsPerChat < 0 || draft.maxVersionsPerChat > 20000 || (versions.value !== '' && draft.maxVersionsPerChat === 0)) { notify('每份聊天的版本数请留空表示不限，或填写 1–20000 的整数。', 'warning'); return; }
        const revision = automaticRevision;
        const versionPolicy = draft.maxVersionsPerChat === 0 ? '每份聊天的版本数不限' : `每份聊天最多保留 ${draft.maxVersionsPerChat} 个版本`;
        if (await confirm(draft.enabled ? `保存自动备份设置：每 ${draft.intervalMinutes} 分钟检查，容量上限 ${draft.limitMiB} MB，${versionPolicy}？达到限制或下调上限后可能轮换旧版本，每份聊天仍保留至少一份有效副本。` : `关闭自动备份？已保存的备份仍保留。容量上限 ${draft.limitMiB} MB，${versionPolicy}，将在再次启用后使用。`) !== true) return;
        if (disposed || revision !== automaticRevision || automaticBusy || controller.snapshot().busy || controller.snapshot().automaticBackup?.busy || controller.snapshot().automaticBackup?.configurationUnknown) return;
        automaticBusy = true; render();
        try {
            await controller.configureAutomaticBackup(draft);
            const result = controller.snapshot().automaticBackup;
            if (result?.error) automaticUnknown = true;
            else automaticDirty = false;
        } catch (error) { automaticUnknown = true; throw error; }
        finally { automaticBusy = false; render(); }
    }));
    const automaticActions = element('div', 'qm-recovery-auto-actions'); automaticActions.append(refreshAutomatic, saveAutomatic);
    automatic.append(automaticHint, automaticFields, automaticActions, automaticStatus);
    root.replaceChildren(hint, tools, status, list, pager, preview, receipt, automatic);

    function renderAutomatic(snapshot) {
        const state = snapshot.automaticBackup || { availability: 'unknown', busy: false }, stored = state.status;
        const busy = automaticBusy || !!state.busy || !!snapshot.busy, available = !automaticMissing && state.availability === 'available';
        const unknown = automaticUnknown || state.configurationUnknown === true;
        if (stored && !automaticDirty && !busy) {
            enabled.checked = stored.enabled === true;
            interval.value = String(stored.intervalMinutes || 30);
            capacity.value = String(stored.limitMiB || 1024);
            versions.value = stored.maxVersionsPerChat ? String(stored.maxVersionsPerChat) : '';
        }
        for (const node of [enabled, interval, capacity, versions]) node.disabled = !available || busy || unknown;
        refreshAutomatic.disabled = busy;
        saveAutomatic.disabled = !available || busy || unknown || !automaticDirty;
        if (busy) automaticStatus.textContent = '正在读取或保存备份设置…';
        else if (unknown) automaticStatus.textContent = '设置结果尚未确认。请先“读取状态”，不要重复提交。';
        else if (automaticMissing || state.availability === 'unavailable') automaticStatus.textContent = '自动备份需要千幕增强服务 v1.59.478；不影响读取 ST 现有备份。';
        else if (state.error) automaticStatus.textContent = state.error;
        else if (!available || !stored) automaticStatus.textContent = '展开后读取当前自动备份状态。';
        else {
            const localTime = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : '暂无'; };
            const used = Number.isFinite(stored.usedBytes) ? `${(stored.usedBytes / 1048576).toFixed(1)} MB` : '未知';
            const last = stored.lastResult;
            automaticStatus.textContent = `${stored.enabled ? '已启用' : '未启用'} · 已用 ${used}\n最近检查：${localTime(stored.lastRunAt)}\n最近成功：${localTime(stored.lastSuccessAt)}\n下次检查：${stored.enabled ? localTime(stored.nextRunAt) : '暂停'}${last ? `\n最近一次：新增 ${last.created || 0}，未变化 ${last.unchanged || 0}，跳过 ${last.skipped || 0}${last.error ? ` · ${last.error}` : ''}` : ''}`;
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
        if (character.value !== selection) { selection = ''; selectedAvatar = ''; invalidatePreview(); }
        const rows = filteredRows(snapshot), currentPreview = visiblePreview(snapshot);
        const pages = Math.max(1, Math.ceil(rows.length / 10)); page = Math.min(Math.max(0, page), pages - 1);
        const locked = unresolved(snapshot);
        load.textContent = hasRead || snapshot.backups?.length ? '刷新备份' : '读取备份';
        load.disabled = !!snapshot.busy || !selection; input.disabled = !!snapshot.busy; character.disabled = !!snapshot.busy;
        moreCharacters.disabled = !!snapshot.busy;
        status.textContent = snapshot.busy ? '正在处理，请稍候…' : snapshot.error || (!selection ? '搜索或选择角色后，点击“读取备份”。'
            : snapshot.phase === 'idle' ? '点击“读取备份”，查看所选角色的备份候选。'
                : `${rows.length} 份备份候选${selection === OTHER ? ' · 预览后请选择找回目标' : ' · 请核对预览是否为要找回的单聊'}`);
        list.replaceChildren();
        let lastDay = '';
        for (const row of rows.slice(page * 10, (page + 1) * 10)) {
            const day = `${row.backupDay || '时间未知'}${row.timeZoneLabel ? ` · ${row.timeZoneLabel}` : ''}`;
            if (day !== lastDay) { list.append(element('h4', 'qm-recovery-day', day)); lastDay = day; }
            const item = button('', () => run(async () => {
                const before = controller.snapshot(), epoch = selectionRevision;
                if (before.busy || unresolved(before) || !filteredRows(before).some(candidate => candidate.name === row.name)) return;
                previewTicket = null; render(); await controller.preview(row.name);
                const after = controller.snapshot();
                if (disposed || epoch !== selectionRevision || after.preview?.name !== row.name || !filteredRows(after).some(candidate => candidate.name === row.name)) return;
                previewTicket = { name: row.name, revision: after.preview.revision }; render();
            }));
            item.className = 'qm-recovery-item'; item.disabled = !!snapshot.busy || locked; item.title = row.name;
            item.classList.toggle('is-selected', currentPreview?.name === row.name);
            item.setAttribute('aria-pressed', String(currentPreview?.name === row.name));
            const count = Number.isFinite(row.messageCount) ? `${row.messageCount} 条消息` : '消息数待预览';
            item.append(element('span', 'qm-recovery-name', row.backupTimeLabel || '时间未知'), element('small', '', count + (row.size ? ` · ${row.size}` : '')));
            item.append(element('small', 'qm-recovery-source', `${row.sourceLabel || 'ST 备份'}${row.timeZoneLabel ? ` · ${row.timeZoneLabel}` : ''}${row.match === 'ambiguous' ? ' · 归属待核对' : ''}`));
            if (row.excerpt) item.append(element('span', 'qm-recovery-excerpt', row.excerpt));
            list.append(item);
        }
        pager.hidden = rows.length <= 10;
        previous.disabled = !!snapshot.busy || page === 0; next.disabled = !!snapshot.busy || page >= pages - 1;
        pageLabel.textContent = `${page + 1} / ${pages}`;
        preview.hidden = !currentPreview;
        if (currentPreview) {
            previewTitle.textContent = `备份预览 · ${currentPreview.messageCount} 条消息`;
            previewText.textContent = currentPreview.text || '这份备份没有可预览的正文。'; sourceName.textContent = currentPreview.name;
        }
        const matches = allCharacters.filter(row => row.avatar === selectedAvatar);
        fixedTarget.hidden = selection === OTHER;
        fixedTarget.textContent = `找回至角色：${matches.length === 1 ? matches[0].label : '请重新选择角色'}`;
        targetLabel.hidden = selection !== OTHER;
        if (selection === OTHER) {
            renderCharacterPicker(target, moreTargets, index, targetSearch, targetLimit, selectedAvatar);
            if (target.value !== selectedAvatar) selectedAvatar = '';
        }
        target.disabled = !!snapshot.busy;
        targetInput.disabled = !!snapshot.busy; moreTargets.disabled = !!snapshot.busy;
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
    return Object.freeze({ render, dispose() { disposed = true; clearTimeout(searchTimer); clearTimeout(targetSearchTimer); root.replaceChildren(); } });
}
