// Read-only archive management stays available without a selected ST chat.
export function createBackupView({ document = globalThis.document, onAction, pageMode = false } = {}) {
    const el = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };
    const button = (label, action) => { const n = el('button', 'ym-button', label); n.type = 'button'; n.setAttribute('aria-label', label); n.addEventListener('click', action); return n; };
    const checkbox = (label, action) => { const input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', label); input.addEventListener('change', action); const row = el('label', 'ym-backup-check'); row.append(input, el('span', '', label)); return { input, row }; };
    const node = el(pageMode ? 'section' : 'details', `ym-backup ${pageMode ? 'ym-subpage-section' : 'ym-card'}`);
    if (!pageMode) node.append(el('summary', '', '记忆备份'));
    const body = el('div', 'ym-backup-body'); node.append(body);
    let state = {}, alive = true, working = false, localError = '', file = null, planKey = '', archiveKey = '', rolesKey = '', listKey = '', currentKey = '';
    let entryLimit = 20, archiveLimit = 20, roleLimit = 20, selectedAvatar = '', uploadReset = 0;
    const exportChoices = new Map(), restoreChoices = new Map();
    const exportStart = button('导出当前记忆', () => invoke('backupPlan'));
    const listStart = button('已导入备份', () => invoke('backupList'));
    const top = el('div', 'ym-actions'); top.append(exportStart, listStart);
    const pick = el('input'); pick.type = 'file'; pick.accept = '.yimu.gz'; pick.hidden = true; pick.setAttribute('aria-label', '忆幕备份文件');
    const choose = button('选择忆幕备份包', () => { if (alive && !pick.disabled) pick.click(); });
    const fileHint = '仅支持忆幕 .yimu.gz 备份包；导入不会自动创建聊天。';
    const fileNotice = el('p', 'ym-muted', fileHint);
    const upload = button('确认上传备份包', () => invoke('backupImport', { file }));
    const uploadRetry = button('核对本次上传', () => invoke('backupImport', { retry: true }));
    const uploadActions = el('div', 'ym-actions'); uploadActions.append(upload, uploadRetry);
    const exportBody = el('section', 'ym-backup-section'); exportBody.hidden = true;
    const exportTitle = el('h4');
    const include = checkbox('同时备份聊天记录', () => update());
    const exportSources = el('div', 'ym-backup-sources');
    const download = button('下载备份包', () => invoke('backupExport', { includeOriginals: include.input.checked,
        sourceIds: [...exportChoices].filter(([, input]) => input.checked).map(([id]) => id) }));
    exportBody.append(exportTitle, include.row, exportSources,
        el('p', 'ym-muted', '聊天记录可逐项选择；不含角色卡和外部媒体。'), download);
    const library = el('section', 'ym-backup-section'), archiveList = el('div', 'ym-backup-list'); library.hidden = true;
    library.append(el('h4', '', '已导入备份'), archiveList);
    const detail = el('section', 'ym-backup-section'); detail.hidden = true;
    const detailTitle = el('h4'), sourceInfo = el('div'), memories = el('div', 'ym-backup-memories');
    const moreEntries = button('显示更多记忆', () => { entryLimit += 20; renderMemories(); });
    const restore = el('details', 'ym-backup-restore'); restore.append(el('summary', '', '找回聊天'));
    const restoreBody = el('div', 'ym-backup-body'); restore.append(restoreBody);
    const roleSearch = el('input'); roleSearch.type = 'search'; roleSearch.placeholder = '搜索角色名或角色文件'; roleSearch.setAttribute('aria-label', '搜索找回目标角色');
    const roleSelection = el('p', 'ym-muted'), roleList = el('div', 'ym-backup-roles');
    const restoreSources = el('div', 'ym-backup-sources');
    const useCurrent = checkbox('使用当前聊天作为原文', () => update());
    const currentLabel = el('p', 'ym-muted');
    const restoreButton = button('确认找回聊天', () => invoke('backupRestore', { targetAvatar: selectedAvatar,
        sourceIds: [...restoreChoices].filter(([, input]) => input.checked).map(([id]) => id), useCurrent: useCurrent.input.checked,
        currentBinding: useCurrent.input.checked ? state.snapshot?.binding : undefined }));
    const restoreRetry = button('继续本次找回', () => invoke('backupRestore', { retry: true }));
    const open = button('打开找回的聊天', () => invoke('backupOpen'));
    const result = el('p', 'ym-muted');
    restoreBody.append(el('p', 'ym-muted', '为所选角色另建聊天，不覆盖原聊天和记忆；找回后忆幕默认关闭。'),
        el('p', 'ym-muted', '仅找回勾选的聊天记录，不带回其他插件的旧设置。缺失来源的记忆仍保留，核对前不会用于回复。'),
        roleSearch, roleSelection, roleList, restoreSources, useCurrent.row, currentLabel, restoreButton, restoreRetry, result, open);
    detail.append(detailTitle, el('p', 'ym-muted', '备份预览，仅供查看，不会用于当前回复。'), sourceInfo, restore, memories, moreEntries);
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
            if (!usable) container.append(el('p', 'ym-muted', isExport ? '当前无法读取这份聊天记录，仍可备份记忆。' : '未附聊天记录，相关记忆暂不能核对来源。'));
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
        if (!filtered.length) roleList.append(el('p', 'ym-muted', '没有匹配的角色，可更换关键词或先在 ST 中添加角色。备份已保留。'));
    }
    function renderMemories() {
        memories.replaceChildren();
        const entries = state.backup?.document?.entries || [];
        for (const entry of entries.slice(0, entryLimit)) {
            const card = el('details', 'ym-backup-memory');
            const type = { summary: '记忆切片', stage: '阶段摘要', manual: '手动补充', excerpt: '原文引证' }[entry.kind] || '记忆';
            const status = { active: '备份中可用', invalid: '来源失效', excluded: '暂不使用', deleted: '已删除记录' }[entry.status] || entry.status || '';
            const ranges = entry.source ? entry.source.ranges || [entry.source] : [];
            const source = ranges.map(range => `第 ${range.start}—${range.end} 层`).join('、');
            card.append(el('summary', '', `${type} · ${status}${source ? ` · ${source}` : ''}`));
            if (entry.origin?.binding?.file) card.append(el('p', 'ym-muted', `继承来源：${entry.origin.binding.file}`));
            card.append(el('p', 'ym-memory-text', entry.text || ''));
            for (const [label, items] of [['修订历史', entry.history], ['冲突记录', entry.conflicts]]) {
                if (!items?.length) continue;
                const history = el('details'); history.append(el('summary', '', `${label}（${items.length}）`));
                for (const item of items) {
                    const revision = el('section', 'ym-backup-revision');
                    if (item.revision) revision.append(el('span', 'ym-muted', `版本 ${item.revision}`));
                    if (item.reason) revision.append(el('p', 'ym-muted', item.reason));
                    revision.append(el('p', 'ym-memory-text', item.text || '此版本没有文字内容。')); history.append(revision);
                }
                card.append(history);
            }
            if (entry.candidate) { const candidate = el('details'); candidate.append(el('summary', '', '待确认版本'), el('p', 'ym-memory-text', entry.candidate.text || '此版本没有文字内容。')); card.append(candidate); }
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
        if ((backup.archives?.length || 0) > archiveLimit) archiveList.append(button('加载更多备份', () => { archiveLimit += 20; renderArchives(); }));
        if (!backup.archives?.length) archiveList.append(el('p', 'ym-muted', '暂无已导入备份。'));
    }
    function update() {
        const backup = state.backup || {}, busy = working || backup.busy, disabled = !!busy || !available();
        if ((backup.uploadReset || 0) !== uploadReset) {
            uploadReset = backup.uploadReset || 0; file = null; pick.value = '';
            fileNotice.textContent = fileHint;
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
            detailTitle.textContent = archive.title || '备份预览'; sourceInfo.replaceChildren();
            for (const source of archive.sources || []) sourceInfo.append(el('p', 'ym-muted', `${source.label || source.binding?.file || source.id} · ${source.included ? '含聊天记录' : '未附聊天记录'}`));
            if (backup.document?.archivedCompanion) sourceInfo.append(el('p', 'ym-muted', '旧伴读关联已保留，需在找回后重新确认关联。'));
            sources(restoreSources, archive.sources, restoreChoices, false); renderMemories();
        }
        renderRoles();
        const target = (backup.roles || []).find(role => role.avatar === selectedAvatar);
        roleSelection.textContent = target ? `找回至：${target.name} · ${target.avatar}` : '请选择角色';
        const primary = archive?.sources?.find(source => source.id === archive.primarySourceId);
        useCurrent.row.hidden = !!primary?.included;
        useCurrent.input.disabled = disabled || !state.snapshot || !!backup.restorePending;
        currentLabel.hidden = useCurrent.row.hidden;
        currentLabel.textContent = state.snapshot ? `当前聊天：${state.snapshot.name || ''} · ${state.snapshot.binding.file}。须与备份记录的原文完全一致；只复制，不覆盖。` : '请先打开对应的单人聊天；备份会保留。';
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
        result.textContent = complete ? `已找回：${backup.result.binding.file}。忆幕尚未开启。${missing ? `另有 ${missing} 份来源未找回，相关记忆已保留，核对前不会用于回复。` : ''}` : backup.restorePending ? '尚未确认找回结果；继续会核对本次操作，不重复创建聊天。' : '';
        notice.textContent = localError || backup.error || backup.status || (busy ? '正在处理备份…' : ''); notice.hidden = !notice.textContent;
        notice.className = localError || backup.error ? 'ym-inline-warning' : 'ym-muted'; node.setAttribute('aria-busy', String(!!busy));
    }
    pick.addEventListener('change', () => {
        file = pick.files?.[0] || null; localError = '';
        if (file && !/\.yimu\.gz$/i.test(file.name)) localError = '仅支持忆幕自己的 .yimu.gz 备份包';
        fileNotice.textContent = file ? `已选择：${file.name}。确认后导入当前 ST 账户，不会自动创建聊天。` : fileHint; update();
    });
    roleSearch.addEventListener('input', () => { roleLimit = 20; renderRoles(); update(); });
    return { node, render(next) { state = next || {}; const key = JSON.stringify(state.snapshot?.binding || null); if (key !== currentKey) { currentKey = key; useCurrent.input.checked = false; } update(); },
        destroy() { alive = false; file = null; node.remove(); } };
}
