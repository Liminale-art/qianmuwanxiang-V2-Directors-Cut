// 「管理」页：日志、当前聊天的记忆清理、记忆文件（含导入与导出）。
// 这里只发起动作与显示结果；真正的清理、删除与记录都在 runtime／服务端。文案只说动作与结果。
import { createYimuIcon } from './icons.mjs';
import { shownFloor } from './contract.mjs';

const pad = value => String(value).padStart(2, '0');
const clock = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const seconds = ms => Number.isFinite(ms) ? ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒` : '';
const floors = range => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) ? `第 ${shownFloor(range.start)}–${shownFloor(range.end)} 层` : '';
const character = item => String(item?.binding?.avatar || '').replace(/\.[^.]+$/, '');
const CONFIRM_MS = 4000;
// 清理范围：下拉里选一项，旁边一个图标按钮执行。前两项会清掉记忆本身，要点两下。
const SCOPES = [
    { id: 'all', label: '全部记忆', confirm: true, payload: ['purge', { scope: 'all' }] },
    { id: 'keep', label: '全部记忆，保留自定义切片', confirm: true, payload: ['purge', { scope: 'all', keepManual: true }] },
    { id: 'traces', label: '已删除与被替换的旧记录', confirm: false, payload: ['purge', { scope: 'traces' }] },
    { id: 'local', label: '本机记录与向量缓存', confirm: false, payload: ['clearLocal', {}] },
];

export function mountManageView({ document = globalThis.document, journal = null, backup = null, onAction = async () => {}, describeSkip = reason => [String(reason || ''), ''] } = {}) {
    if (!document?.createElement) throw new TypeError('忆幕管理页缺少文档容器');
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let state = {}, disposed = false, listed = false, logSignature = '', fileSignature = '';
    const open = new Set(), timers = new Set(), folders = new Set(), picked = new Set();
    let selecting = false;
    const run = async (type, payload) => { try { return await onAction(type, payload); } catch { return false; } };

    // 小图标按钮。needsConfirm 返回真时要点两下：第一下变成「确认」样式，几秒内不再点就复原。不弹对话框。
    const iconAction = (label, glyph, action, { needsConfirm = () => false, className = '' } = {}) => {
        const node = el('button', `ym-button ym-icon-button ym-small ${className}`.trim());
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        const paint = name => node.replaceChildren(createYimuIcon(name, { document }));
        paint(glyph);
        let armed = false, timer = null;
        const disarm = () => { armed = false; clearTimeout(timer); timers.delete(timer); timer = null; node.removeAttribute('data-armed'); node.title = label; paint(glyph); };
        node.disarm = disarm;
        node.addEventListener('click', async event => {
            event.stopPropagation?.();
            if (node.disabled) return;
            if (needsConfirm() && !armed) {
                armed = true; node.setAttribute('data-armed', 'true'); node.title = '再点一次确认'; paint('check');
                timer = setTimeout(disarm, CONFIRM_MS); timers.add(timer);
                return;
            }
            disarm(); node.disabled = true;
            try { await action(); } finally { if (!disposed) { node.disabled = false; render(state); } }
        });
        return node;
    };
    const head = (title, ...right) => {
        const node = el('div', 'ym-manage-head');
        const side = el('div', 'ym-manage-head-side'); side.append(...right);
        node.append(el('h3', 'ym-setting-title', title), side);
        return node;
    };

    // ---------- 日志（首卡） ----------
    const logCard = el('section', 'ym-card ym-settings-group ym-manage-log');
    const clearLog = iconAction('清空日志', 'trash', async () => { journal?.clear(); open.clear(); }, { needsConfirm: () => true });
    const logList = el('div', 'ym-log-list');
    // 标题同排右侧：最近一轮最终发出的请求有多大（含 ST 自己的提示词、世界书、角色卡与忆幕带上的记忆）。
    const requestLine = el('span', 'ym-muted ym-manage-count ym-log-request');
    logCard.append(head('日志', requestLine, clearLog), logList);

    // ---------- 当前聊天 ----------
    const chatCard = el('section', 'ym-card ym-settings-group ym-manage-chat');
    const chatCount = el('span', 'ym-muted ym-manage-count');
    const scope = el('select', 'ym-manage-scope'); scope.setAttribute('aria-label', '清理范围');
    const scopeOf = () => SCOPES.find(item => item.id === scope.value) || SCOPES[0];
    const clean = iconAction('清理', 'trash', () => run(...scopeOf().payload), { needsConfirm: () => scopeOf().confirm, className: 'ym-danger' });
    scope.addEventListener('change', () => { clean.disarm(); render(state); });
    const cleanRow = el('div', 'ym-manage-row'); cleanRow.append(scope, clean);
    chatCard.append(head('当前聊天', chatCount), cleanRow);

    // ---------- 记忆文件 ----------
    const filesCard = el('section', 'ym-card ym-settings-group ym-manage-files');
    const filesNote = el('span', 'ym-muted ym-manage-count');
    const reload = iconAction('刷新记忆文件列表', 'refresh', () => run('manageList', {}));
    const selectToggle = iconAction('多选文件', 'select', async () => { selecting = !selecting; picked.clear(); fileSignature = ''; });
    const selectAll = iconAction('全选文件', 'check', async () => {
        const all = selectable(); const everything = all.length > 0 && all.every(item => picked.has(item.name));
        picked.clear(); if (!everything) for (const item of all) picked.add(item.name);
        fileSignature = '';
    });
    const removePicked = iconAction('删除所选文件', 'trash', async () => {
        const items = selectable().filter(item => picked.has(item.name));
        if (!items.length) return;
        await run('manageDelete', { items }); picked.clear(); selecting = false; fileSignature = '';
    }, { needsConfirm: () => true, className: 'ym-danger' });
    // 多选后一次导出：所选的打成一个记忆包文件，导入时选这一个文件即可。
    const exportPicked = iconAction('导出所选文件', 'download', async () => {
        await run('backupExportPack', { bindings: scoped().filter(item => !item.unreadable && picked.has(item.name)).map(item => item.binding) });
    });
    const fileList = el('div', 'ym-manage-list');
    // 导入与导出并在这张卡里：标题行两个小图标，导入的进度与「选目标」出现在列表上方。
    const importFiles = iconAction('导入记忆文件', 'upload', async () => { backup?.importFiles(); });
    const exportCurrent = iconAction('导出当前聊天的记忆', 'download', async () => { backup?.exportCurrent(); });
    filesCard.append(head('记忆文件', filesNote, selectAll, exportPicked, removePicked, importFiles, exportCurrent, selectToggle, reload));
    if (backup?.node) filesCard.append(backup.node);
    filesCard.append(fileList);

    const element = el('div', 'ym-manage');
    element.append(logCard, chatCard, filesCard);

    const cap = text => el('div', 'ym-log-cap', text);
    const term = text => el('pre', 'ym-term', text);
    function logEntry(item) {
        const node = el('details', 'ym-log-entry'); node.dataset.logId = item.id; node.open = open.has(item.id);
        node.addEventListener('toggle', () => { if (node.open) open.add(item.id); else open.delete(item.id); });
        const summary = el('summary');
        const status = el('span', `ym-log-status ${item.status || ''}`.trim()); status.setAttribute('aria-hidden', 'true');
        const isRound = item.kind === 'round', isIdle = item.kind === 'idle';
        const [why, hint] = isRound && item.reason && item.reason !== 'empty' ? describeSkip(item.reason) : ['', ''];
        const title = isIdle ? '自动总结 · 未到触发值' : isRound
            ? item.status === 'success' ? `生成 · 带入 ${item.memories || 0} 条记忆` : item.reason === 'empty' ? '生成 · 没有可带的记忆' : item.offered ? '生成 · 记忆以附加方式带入' : '生成 · 未带记忆'
            : `${item.kind === 'stage' ? '阶段总结' : '切片总结'} · ${floors(item.range)}`;
        const meta = [clock(item.at)];
        if (isIdle) {
            meta.push(`待整理 ${item.pendingFloors} 层`);
            if (item.triggerFloors > 0) meta.push(`满 ${item.triggerFloors} 层触发`);
        } else if (isRound) {
            if (Number.isFinite(item.tokens)) meta.push(`约 ${item.tokens} token`);
            if (item.hiddenTo > 0) meta.push(`隐藏到第 ${shownFloor(item.hiddenTo)} 层`);
            if (Number.isFinite(item.waitMs)) meta.push(`生成前用时 ${seconds(item.waitMs)}`);
        } else {
            if (Number.isFinite(item.durationMs)) meta.push(`用时 ${seconds(item.durationMs)}`);
            if (Array.isArray(item.slices)) meta.push(`${item.slices.length} 片`);
            if (item.status === 'loading') meta.push('进行中');
        }
        summary.append(status, el('span', 'ym-log-title', title), el('span', 'ym-log-meta', meta.join(' · ')));
        const kind = isIdle ? '自动' : isRound ? '生成' : item.manual ? item.batch ? `手动 ${item.batch}` : '手动' : '自动';
        summary.append(el('span', 'ym-log-kind', kind));
        const detail = el('div', 'ym-log-detail');
        if (item.chat) { detail.append(cap('聊天'), el('p', 'ym-log-text', item.chat)); }
        if (isIdle) {
            detail.append(cap('情况'), el('p', 'ym-log-text', `保留最近 ${item.recent} 层以外，还有 ${floors(item.range) || `${item.pendingFloors} 层`}（共 ${item.pendingFloors} 层、约 ${item.pendingTokens} token）没整理。`
                + `要满 ${item.triggerFloors > 0 ? `${item.triggerFloors} 层或 ` : ''}${item.trigger} token 才自动总结。`));
        } else if (isRound) {
            if (why) { detail.append(cap('原因'), el('p', 'ym-log-text', hint ? `${why} ${hint}` : why)); }
            if (item.reason === 'empty') detail.append(cap('原因'), el('p', 'ym-log-text', '这一轮没有与当前正文相关、且尚未淡去的记忆。'));
        } else {
            if (Array.isArray(item.slices) && item.slices.length) {
                detail.append(cap('结果'));
                for (const slice of item.slices) detail.append(el('p', 'ym-log-text', `${floors(slice)}${slice.title ? ` · ${slice.title}` : ''}`));
            }
            if (Array.isArray(item.observations) && item.observations.length) {
                detail.append(cap('留意到'));
                for (const seen of item.observations) detail.append(el('p', 'ym-log-text', `${seen.about}：${seen.text}（第 ${shownFloor(seen.floor)} 层）`));
            }
            if (item.raw) { detail.append(cap(item.status === 'loading' ? '模型返回（接收中）' : '模型返回'), term(item.raw)); }
        }
        if (item.error) { detail.append(cap('未完成'), el('p', 'ym-log-text ym-log-error', item.error)); }
        node.append(summary, detail);
        return node;
    }
    function renderLog() {
        const items = journal ? journal.list() : [];
        // 内容没变就不重建（否则展开着的条目会跟着闪、被收起）。
        const signature = JSON.stringify(items.map(item => [item.id, item.status, item.durationMs ?? null, item.raw ? item.raw.length : 0, (item.slices || []).length, item.error || '']));
        if (signature === logSignature) return;
        logSignature = signature;
        if (!items.length) { logList.replaceChildren(el('p', 'ym-muted', '暂无日志')); clearLog.hidden = true; return; }
        clearLog.hidden = false;
        logList.replaceChildren(...items.map(logEntry));
    }

    // ---------- 记忆文件：范围、分组、多选 ----------
    const currentKey = () => state.snapshot?.binding ? JSON.stringify([state.snapshot.binding.avatar, state.snapshot.binding.file]) : '';
    const keyOf = item => JSON.stringify([item.binding?.avatar, item.binding?.file]);
    // 在某个聊天里只看这个角色的记忆文件；在 ST 首页（没有打开聊天）才看全部角色的。
    const scoped = () => {
        const items = Array.isArray(state.manage?.items) ? state.manage.items : [];
        const avatar = state.snapshot?.binding?.avatar;
        return avatar ? items.filter(item => !item.unreadable && item.binding?.avatar === avatar) : items;
    };
    // 当前打开的聊天不能从这里删，读不出来的文件服务端也不认，所以两者都不进多选。
    const selectable = () => scoped().filter(item => !item.unreadable && keyOf(item) !== currentKey());
    function fileRow(item, { withCharacter = false } = {}) {
        const node = el('div', 'ym-manage-file'); node.dataset.name = item.name;
        const isCurrent = !item.unreadable && keyOf(item) === currentKey(), canPick = !item.unreadable && !isCurrent;
        const text = el('div', 'ym-manage-file-text');
        const facts = item.unreadable ? [size(item.bytes), day(item.updated)]
            : [...(withCharacter ? [character(item)] : []), `${item.slices + item.stages + item.custom} 条`, size(item.bytes), day(item.updated)];
        text.append(el('span', 'ym-manage-file-name', item.unreadable ? item.name : item.binding.file), el('span', 'ym-muted', facts.join(' · ')));
        node.append(text);
        if (selecting) {
            node.dataset.selectable = String(canPick); node.dataset.selected = String(canPick && picked.has(item.name));
            if (canPick) node.addEventListener('click', () => { if (picked.has(item.name)) picked.delete(item.name); else picked.add(item.name); fileSignature = ''; render(state); });
            return node;
        }
        const actions = el('div', 'ym-manage-file-actions');
        // 在聊天里：把这份记忆指定给当前聊天（作为独立记忆带入）。两下确认。
        if (canPick && state.snapshot?.binding) actions.append(iconAction(`把 ${item.binding.file} 的记忆带入当前聊天`, 'link', () => run('manageAssign', { item }), { needsConfirm: () => true }));
        if (!item.unreadable) actions.append(iconAction(`导出 ${item.binding.file} 的记忆`, 'download', () => run('backupExportFile', { binding: item.binding })));
        if (canPick) actions.append(iconAction(`删除 ${item.binding.file} 的记忆`, 'trash', () => run('manageDelete', { items: [item] }), { needsConfirm: () => true, className: 'ym-danger' }));
        node.append(actions);
        return node;
    }
    function folder(id, title, items, options) {
        const node = el('details', 'ym-manage-folder'); node.dataset.folder = id; node.open = folders.has(id);
        node.addEventListener('toggle', () => { if (node.open) folders.add(id); else folders.delete(id); });
        const body = el('div', 'ym-manage-folder-body');
        body.append(...items.map(item => fileRow(item, options)));
        node.append(el('summary', '', `${title}（${items.length}）`), body);
        return node;
    }
    function renderFiles() {
        const manage = state.manage || {}, loaded = Array.isArray(manage.items);
        const items = scoped(), inChat = Boolean(state.snapshot?.binding);
        for (const name of [...picked]) if (!items.some(item => item.name === name)) picked.delete(name);
        const chosen = selectable().filter(item => picked.has(item.name)).length;
        reload.disabled = manage.loading === true;
        selectToggle.hidden = !selectable().length && !selecting;
        selectToggle.setAttribute('aria-pressed', String(selecting));
        selectAll.hidden = removePicked.hidden = exportPicked.hidden = !selecting;
        importFiles.hidden = exportCurrent.hidden = selecting || !backup; reload.hidden = selecting;
        importFiles.disabled = !backup?.canImport(); exportCurrent.disabled = !backup?.canExport();
        removePicked.disabled = exportPicked.disabled = !chosen;
        filesNote.textContent = selecting ? `已选 ${chosen} 个` : !loaded ? manage.loading ? '正在读取…' : manage.error || ''
            : manage.error || (items.length ? `${items.length} 个 · ${size(items.reduce((sum, item) => sum + (item.bytes || 0), 0))}` : '');
        const signature = JSON.stringify([loaded, inChat, currentKey(), selecting, [...picked].sort(), items.map(item => [item.name, item.revision, item.bytes, item.updated, item.sourceExists, item.unreadable])]);
        if (signature === fileSignature) return;
        fileSignature = signature;
        if (!loaded) { fileList.replaceChildren(); return; }
        if (!items.length) { fileList.replaceChildren(el('p', 'ym-muted', inChat ? '这个角色还没有记忆文件' : '还没有记忆文件')); return; }
        const live = items.filter(item => !item.unreadable && item.sourceExists !== false);
        const gone = items.filter(item => !item.unreadable && item.sourceExists === false);
        const broken = items.filter(item => item.unreadable);
        const nodes = [];
        if (inChat) {
            // 当前聊天排最前，其余按最近更新。
            const ordered = [...live].sort((a, b) => Number(keyOf(b) === currentKey()) - Number(keyOf(a) === currentKey()) || b.updated - a.updated);
            nodes.push(...ordered.map(item => fileRow(item)));
        } else {
            const groups = new Map();
            for (const item of live) { const name = character(item); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(item); }
            for (const [name, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) nodes.push(folder(`character:${name}`, name, list.sort((a, b) => b.updated - a.updated)));
        }
        if (gone.length) nodes.push(folder('gone', '原聊天不存在', gone.sort((a, b) => b.updated - a.updated), { withCharacter: !inChat }));
        if (broken.length) nodes.push(folder('broken', '无法读取', broken));
        fileList.replaceChildren(...nodes);
    }
    function render(next = {}) {
        if (disposed) return;
        state = next;
        const entries = state.document?.entries || [], usable = Boolean(state.document && state.snapshot && !state.loading);
        const live = entries.filter(entry => entry.status !== 'deleted'), traces = entries.length - live.length;
        chatCard.hidden = !state.snapshot;
        chatCount.textContent = usable ? `${live.length} 条记忆 · ${traces} 条旧记录` : '';
        // 没有自定义切片时，「保留自定义切片」与上一项等价，不列出。
        const options = SCOPES.filter(item => item.id !== 'keep' || live.some(entry => entry.kind === 'manual'));
        if ([...scope.children].map(node => node.value).join() !== options.map(item => item.id).join()) {
            const previous = scope.value;
            scope.replaceChildren(...options.map(item => { const option = el('option', '', item.label); option.value = item.id; return option; }));
            scope.value = options.some(item => item.id === previous) ? previous : options[0].id;
        }
        const busy = !usable || Boolean(state.busy), chosen = scopeOf().id;
        scope.disabled = !state.snapshot;
        clean.disabled = chosen === 'local' ? !state.snapshot : busy || (chosen === 'traces' ? !traces : !entries.length);
        const requestTokens = state.requestSize?.tokens;
        requestLine.textContent = `本轮请求发送统计：${Number.isFinite(requestTokens) ? `${requestTokens.toLocaleString()} Token（预估）` : '---'}`;
        renderFiles(); renderLog();
    }
    const unsubscribe = journal?.subscribe?.(() => { if (!disposed && !element.hidden) renderLog(); });
    return {
        element,
        render,
        /** 第一次翻到这一页时才读账户文件列表：平时打开面板不为它多发请求。 */
        shown() { renderLog(); if (!listed) { listed = true; void run('manageList', {}); } },
        destroy() { disposed = true; unsubscribe?.(); for (const timer of timers) clearTimeout(timer); element.remove(); },
    };
}
