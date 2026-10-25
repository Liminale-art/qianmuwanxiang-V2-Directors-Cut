// Read-only archive management stays available without a selected ST chat.
export function createBackupView({ document = globalThis.document, onAction } = {}) {
    const el = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };
    const button = (label, action) => { const n = el('button', 'ym-button', label); n.type = 'button'; n.setAttribute('aria-label', label); n.addEventListener('click', action); return n; };
    const checkbox = (label, action) => { const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', label); input.addEventListener('change', action); const row = el('label', 'ym-backup-check'); row.append(input, el('span', '', label)); return { input, row }; };
    const node = el('details', 'ym-card ym-backup'); node.append(el('summary', '', '备份与导入'));
    const body = el('div', 'ym-backup-body'); node.append(body);
    let state = {}, alive = true, working = false, localError = '', file = null, planKey = '', archiveKey = '', rolesKey = '', listKey = '', currentKey = '';
    let entryLimit = 20, archiveLimit = 20, roleLimit = 20, selectedAvatar = '', uploadReset = 0;
    const exportChoices = new Map(), restoreChoices = new Map();
    const exportStart = button('导出当前记忆', () => invoke('backupPlan'));
    const listStart = button('已导入资料', () => invoke('backupList'));
    const top = el('div', 'ym-actions'); top.append(exportStart, listStart);
    const pick = el('input'); pick.type = 'file'; pick.accept = '.yimu.gz'; pick.hidden = true; pick.setAttribute('aria-label', '忆幕备份文件');
    const choose = button('选择忆幕备份包', () => { if (alive && !pick.disabled) pick.click(); });
    const fileNotice = el('p', 'ym-muted', '仅支持忆幕 .yimu.gz 备份包。选好后确认上传；不会自动创建聊天。');
    const upload = button('确认上传备份包', () => invoke('backupImport', { file }));
    const uploadRetry = button('核对本次上传', () => invoke('backupImport', { retry: true }));
    const uploadActions = el('div', 'ym-actions'); uploadActions.append(upload, uploadRetry);
    const exportBody = el('section', 'ym-backup-section'); exportBody.hidden = true;
    const exportTitle = el('h4');
    const include = checkbox('附带 ST 聊天原件', () => update());
    const exportSources = el('div', 'ym-backup-sources');
    const download = button('下载备份包', () => invoke('backupExport', { includeOriginals: include.input.checked,
        sourceIds: [...exportChoices].filter(([, input]) => input.checked).map(([id]) => id) }));
    exportBody.append(exportTitle, include.row, exportSources,
        el('p', 'ym-muted', '原件逐项选择；未附原件仍可备份记忆，不代表原文回查条件齐全。聊天文件不含角色卡与外部媒体原件。'), download);
    const library = el('section', 'ym-backup-section'), archiveList = el('div', 'ym-backup-list'); library.hidden = true;
    library.append(el('h4', '', '已导入资料'), archiveList);
    const detail = el('section', 'ym-backup-section'); detail.hidden = true;
    const detailTitle = el('h4'), sourceInfo = el('div'), memories = el('div', 'ym-backup-memories');
    const moreEntries = button('显示更多记忆', () => { entryLimit += 20; renderMemories(); });
    const restore = el('details', 'ym-backup-restore'); restore.append(el('summary', '', '恢复为新聊天副本'));
    const restoreBody = el('div', 'ym-backup-body'); restore.append(restoreBody);
    const roleSearch = el('input'); roleSearch.type = 'search'; roleSearch.placeholder = '搜索角色名或角色文件'; roleSearch.setAttribute('aria-label', '搜索恢复目标角色');
    const roleSelection = el('p', 'ym-muted'), roleList = el('div', 'ym-backup-roles');
    const restoreSources = el('div', 'ym-backup-sources');
    const useCurrent = checkbox('使用当前打开的聊天核对主原件', () => update());
    const currentLabel = el('p', 'ym-muted');
    const restoreButton = button('确认恢复为新聊天副本', () => invoke('backupRestore', { targetAvatar: selectedAvatar,
        sourceIds: [...restoreChoices].filter(([, input]) => input.checked).map(([id]) => id), useCurrent: useCurrent.input.checked,
        currentBinding: useCurrent.input.checked ? state.snapshot?.binding : undefined }));
    const restoreRetry = button('继续核对本次恢复', () => invoke('backupRestore', { retry: true }));
    const open = button('打开恢复副本', () => invoke('backupOpen'));
    const result = el('p', 'ym-muted');
    restoreBody.append(el('p', 'ym-muted', '请选择真实角色。主聊天与勾选的祖先原件都恢复为该角色下的新副本；原聊天和原记忆不覆盖，忆幕默认关闭。'),
        el('p', 'ym-muted', '未勾选或缺失的祖先原件不恢复，依赖这些来源的记忆仍保留，但来源保持未核验。'),
        el('p', 'ym-muted', '恢复副本不带回旧聊天头中的其他插件设置和旧忆幕状态；原始聊天文件仍完整保存在备份包内。'),
        roleSearch, roleSelection, roleList, restoreSources, useCurrent.row, currentLabel, restoreButton, restoreRetry, result, open);
    detail.append(detailTitle, el('p', 'ym-muted', '独立资料只供查看，不参与生成。以下来源和历史状态来自备份，不代表已在当前账户核验。'), sourceInfo, restore, memories, moreEntries);
    const notice = el('p', 'ym-muted'); notice.setAttribute('aria-live', 'polite'); notice.hidden = true;
    body.append(top, choose, pick, fileNotice, uploadActions, exportBody, library, detail, notice);
    const available = () => !['error', 'mismatch', 'checking'].includes(state.service?.status);
    async function invoke(type, payload = {}) {
        if (!alive || working || state.backup?.busy) return;
        working = true; localError = ''; update();
        try { await onAction?.(type, payload); }
        catch (error) { if (alive) localError = error?.message || '备份操作未完成'; }
        finally { if (alive) { working = false; update(); } }
    }
    function sources(container, items, choices, isExport) {
        container.replaceChildren(); choices.clear();
        for (const source of items || []) {
            const usable = isExport ? source.available : source.included;
            const caption = `${source.id === (isExport ? state.backup?.exportPlan?.primarySourceId : state.backup?.selected?.primarySourceId) ? '主聊天 · ' : ''}${source.label || source.binding?.file || source.id}`;
            const choice = checkbox(caption, () => update()); choice.input.checked = false; choice.input.disabled = !usable;
            choice.input.dataset.ymBackupSource = source.id;
            container.append(choice.row);
            if (!usable) container.append(el('p', 'ym-muted', isExport ? '此原件当前不可读取，仅保留记忆资料及来源关联。' : '此来源未附聊天原件；恢复后无法据此声明原文已核验。'));
            choices.set(source.id, choice.input);
        }
    }
    function renderRoles(force = false) {
        const roles = state.backup?.roles || [], query = roleSearch.value.trim().toLocaleLowerCase();
        const key = JSON.stringify([roles, query, roleLimit, selectedAvatar]);
        if (!force && rolesKey === key) return;
        rolesKey = key; roleList.replaceChildren();
        const filtered = roles.filter(role => `${role.name} ${role.avatar}`.toLocaleLowerCase().includes(query));
        for (const role of filtered.slice(0, roleLimit)) {
            const select = button(`${role.name} · ${role.avatar}`, () => { selectedAvatar = role.avatar; renderRoles(); update(); });
            select.dataset.ymBackupRole = role.avatar; select.setAttribute('aria-pressed', String(selectedAvatar === role.avatar)); roleList.append(select);
        }
        if (filtered.length > roleLimit) roleList.append(button('显示更多角色', () => { roleLimit += 20; renderRoles(); update(); }));
        if (!filtered.length) roleList.append(el('p', 'ym-muted', '没有匹配的角色。请先在 ST 中添加角色；导入资料已保留。'));
    }
    function renderMemories() {
        memories.replaceChildren();
        const entries = state.backup?.document?.entries || [];
        for (const entry of entries.slice(0, entryLimit)) {
            const card = el('details', 'ym-backup-memory');
            const type = { summary: '细摘要', stage: '阶段摘要', manual: '手动补充', excerpt: '原文引证' }[entry.kind] || '记忆';
            const status = { active: '可用状态', invalid: '来源失效', excluded: '暂不使用', deleted: '已删除记录' }[entry.status] || entry.status || '';
            const ranges = entry.source ? entry.source.ranges || [entry.source] : [];
            const source = ranges.map(range => `第 ${range.start}—${range.end} 层`).join('、');
            card.append(el('summary', '', `${type} · ${status}${source ? ` · ${source}` : ''}`));
            if (entry.origin?.binding?.file) card.append(el('p', 'ym-muted', `继承来源：${entry.origin.binding.file}`));
            card.append(el('p', 'ym-memory-text', entry.text || ''));
            for (const [label, items] of [['修订历史', entry.history], ['冲突记录', entry.conflicts]]) {
                if (!items?.length) continue;
                const history = el('details'); history.append(el('summary', '', `${label}（${items.length}）`));
                for (const item of items) history.append(el('p', 'ym-memory-text', JSON.stringify(item, null, 2)));
                card.append(history);
            }
            if (entry.candidate) { const candidate = el('details'); candidate.append(el('summary', '', '保留的候选'), el('p', 'ym-memory-text', JSON.stringify(entry.candidate, null, 2))); card.append(candidate); }
            memories.append(card);
        }
        moreEntries.hidden = entries.length <= entryLimit;
    }
    function renderArchives() {
        const backup = state.backup || {}, key = JSON.stringify([backup.archives, archiveLimit]);
        library.hidden = !backup.loaded && !backup.archives?.length;
        if (listKey === key) return;
        listKey = key; archiveList.replaceChildren();
        for (const archive of (backup.archives || []).slice(0, archiveLimit)) archiveList.append(button(`${archive.title || '忆幕备份'} · ${archive.entriesCount || 0} 份记忆`, () => invoke('backupRead', { archiveId: archive.id })));
        if ((backup.archives?.length || 0) > archiveLimit) archiveList.append(button('显示更多导入资料', () => { archiveLimit += 20; renderArchives(); }));
        if (!backup.archives?.length) archiveList.append(el('p', 'ym-muted', '尚无已导入资料。'));
    }
    function update() {
        const backup = state.backup || {}, busy = working || backup.busy, disabled = !!busy || !available();
        if ((backup.uploadReset || 0) !== uploadReset) {
            uploadReset = backup.uploadReset || 0; file = null; pick.value = '';
            fileNotice.textContent = '仅支持忆幕 .yimu.gz 备份包。选好后确认上传；不会自动创建聊天。';
        }
        const plan = backup.exportPlan;
        exportBody.hidden = !plan;
        if (plan && planKey !== plan.planId) {
            planKey = plan.planId; include.input.checked = false; exportTitle.textContent = plan.title || '导出当前记忆'; sources(exportSources, plan.sources, exportChoices, true);
        }
        exportSources.hidden = !include.input.checked;
        const exportMatches = JSON.stringify(plan?.binding || null) === JSON.stringify(state.snapshot?.binding || null);
        exportStart.disabled = disabled || !state.snapshot || !state.document;
        download.disabled = disabled || !plan || !exportMatches;
        include.input.disabled = disabled;
        for (const source of plan?.sources || []) { const choice = exportChoices.get(source.id); if (choice) choice.disabled = disabled || !source.available; }
        listStart.disabled = disabled; choose.disabled = pick.disabled = disabled || !!backup.uploadPending;
        upload.hidden = !!backup.uploadPending; upload.disabled = disabled || !file || !/\.yimu\.gz$/i.test(file.name);
        uploadRetry.hidden = !backup.uploadPending; uploadRetry.disabled = disabled;
        renderArchives();
        const archive = backup.selected;
        detail.hidden = !archive;
        if (archive && archiveKey !== archive.id) {
            archiveKey = archive.id; entryLimit = 20; selectedAvatar = ''; useCurrent.input.checked = false; roleSearch.value = ''; roleLimit = 20;
            detailTitle.textContent = archive.title || '已导入资料'; sourceInfo.replaceChildren();
            for (const source of archive.sources || []) sourceInfo.append(el('p', 'ym-muted', `${source.label || source.binding?.file || source.id} · ${source.included ? '包内含聊天原件' : '未附聊天原件'}`));
            if (backup.document?.archivedCompanion) sourceInfo.append(el('p', 'ym-muted', '伴读关联仅作为历史资料保留，不会自动恢复为活动关联。'));
            sources(restoreSources, archive.sources, restoreChoices, false); renderMemories();
        }
        renderRoles();
        const target = (backup.roles || []).find(role => role.avatar === selectedAvatar);
        roleSelection.textContent = target ? `恢复至：${target.name} · ${target.avatar}` : '尚未选择恢复角色';
        const primary = archive?.sources?.find(source => source.id === archive.primarySourceId);
        useCurrent.row.hidden = !!primary?.included;
        useCurrent.input.disabled = disabled || !state.snapshot || !!backup.restorePending;
        currentLabel.hidden = useCurrent.row.hidden;
        currentLabel.textContent = state.snapshot ? `当前聊天：${state.snapshot.name || ''} · ${state.snapshot.binding.file}。只有全文指纹一致才复制，现有忆幕不会覆盖。` : '未打开单人聊天；可以先保留资料，之后再核对来源。';
        const hasPrimary = restoreChoices.get(archive?.primarySourceId)?.checked || !primary?.included && useCurrent.input.checked && state.snapshot;
        const complete = backup.result?.receipt?.status === 'complete';
        restoreButton.hidden = !!backup.restorePending || complete; restoreButton.disabled = disabled || !target || !hasPrimary;
        restoreRetry.hidden = !backup.restorePending; restoreRetry.disabled = disabled;
        roleSearch.disabled = disabled || !!backup.restorePending || complete;
        for (const choice of roleList.querySelectorAll('button')) choice.disabled = roleSearch.disabled;
        for (const source of archive?.sources || []) { const choice = restoreChoices.get(source.id); if (choice) choice.disabled = disabled || !!backup.restorePending || complete || !source.included; }
        open.hidden = !complete; open.disabled = disabled;
        const restoredIds = new Set((backup.result?.receipt?.restoredSources || []).map(source => source.id));
        const missing = complete && backup.result?.receipt?.restoredSources ? (archive?.sources || []).filter(source => !restoredIds.has(source.id)).length : 0;
        result.textContent = complete ? `已建立副本：${backup.result.binding.file}；忆幕保持关闭。${missing ? `另有 ${missing} 份来源原件未恢复，相关资料已保留但来源尚未核验。` : ''}` : backup.restorePending ? '本次恢复结果尚未确认，继续核对将复用原操作，不另建副本。' : '';
        notice.textContent = localError || backup.error || backup.status || (busy ? '正在处理备份资料…' : ''); notice.hidden = !notice.textContent;
        notice.className = localError || backup.error ? 'ym-inline-warning' : 'ym-muted'; node.setAttribute('aria-busy', String(!!busy));
    }
    pick.addEventListener('change', () => {
        file = pick.files?.[0] || null; localError = '';
        if (file && !/\.yimu\.gz$/i.test(file.name)) localError = '仅支持忆幕自己的 .yimu.gz 备份包';
        fileNotice.textContent = file ? `已选择：${file.name}。确认上传后才保存到当前 ST 账户；不会自动创建聊天。` : '仅支持忆幕 .yimu.gz 备份包。选好后确认上传；不会自动创建聊天。'; update();
    });
    roleSearch.addEventListener('input', () => { roleLimit = 20; renderRoles(); update(); });
    return { node, render(next) { state = next || {}; const key = JSON.stringify(state.snapshot?.binding || null); if (key !== currentKey) { currentKey = key; useCurrent.input.checked = false; } update(); },
        destroy() { alive = false; file = null; node.remove(); } };
}
