// 「管理」页：当前聊天的记忆清理、账户内全部记忆文件、日志。
// 这里只发起动作与显示结果；真正的清理、删除与记录都在 runtime／服务端。文案只说动作与结果。
import { createYimuIcon } from './icons.mjs';
import { shownFloor } from './contract.mjs';

const pad = value => String(value).padStart(2, '0');
const clock = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const seconds = ms => Number.isFinite(ms) ? ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒` : '';
const floors = range => range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) ? `第 ${shownFloor(range.start)}–${shownFloor(range.end)} 层` : '';
const CONFIRM_MS = 4000;

export function mountManageView({ document = globalThis.document, journal = null, onAction = async () => {}, describeSkip = reason => [String(reason || ''), ''] } = {}) {
    if (!document?.createElement) throw new TypeError('忆幕管理页缺少文档容器');
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let state = {}, disposed = false, listed = false, logSignature = '';
    const open = new Set(), timers = new Set();
    const run = async (type, payload) => { try { return await onAction(type, payload); } catch { return false; } };

    // 破坏性按钮都要点两下：第一下变成「确认…」，几秒内不再点就复原。不弹对话框、不打断操作。
    const confirmButton = (label, confirmLabel, action, className = '') => {
        const node = el('button', `ym-button ym-small ${className}`.trim(), label);
        node.type = 'button'; node.setAttribute('aria-label', label);
        let armed = false, timer = null;
        const disarm = () => { armed = false; clearTimeout(timer); timers.delete(timer); timer = null; node.textContent = label; node.removeAttribute('data-armed'); };
        node.addEventListener('click', async () => {
            if (node.disabled) return;
            if (!armed) {
                armed = true; node.textContent = confirmLabel; node.setAttribute('data-armed', 'true');
                timer = setTimeout(disarm, CONFIRM_MS); timers.add(timer);
                return;
            }
            disarm(); node.disabled = true;
            try { await action(); } finally { if (!disposed) node.disabled = false; render(state); }
        });
        return node;
    };
    const row = (label, control) => { const node = el('div', 'ym-manage-row'); node.append(el('span', '', label), control); return node; };

    // ---------- 当前聊天 ----------
    const chatCard = el('section', 'ym-card ym-settings-group ym-manage-chat');
    const chatTitle = el('h3', 'ym-setting-title', '当前聊天');
    const chatCount = el('p', 'ym-muted ym-manage-count');
    const clearAll = confirmButton('清空', '确认清空', () => run('purge', { scope: 'all' }), 'ym-danger');
    const clearKeep = confirmButton('清空', '确认清空', () => run('purge', { scope: 'all', keepManual: true }), 'ym-danger');
    const clearTraces = confirmButton('清理', '确认清理', () => run('purge', { scope: 'traces' }));
    const clearLocal = confirmButton('清理', '确认清理', () => run('clearLocal', {}));
    const rows = [row('全部记忆', clearAll), row('全部记忆，保留自定义切片', clearKeep), row('已删除与被替换的旧记录', clearTraces), row('本机记录与向量缓存', clearLocal)];
    chatCard.append(chatTitle, chatCount, ...rows);

    // ---------- 账户内的记忆文件 ----------
    const filesCard = el('section', 'ym-card ym-settings-group ym-manage-files');
    const filesHead = el('div', 'ym-manage-head');
    const reload = el('button', 'ym-button ym-icon-button ym-small'); reload.type = 'button'; reload.title = '刷新记忆文件列表'; reload.setAttribute('aria-label', '刷新记忆文件列表');
    reload.append(createYimuIcon('refresh', { document }));
    reload.addEventListener('click', () => { void run('manageList', {}); });
    filesHead.append(el('h3', 'ym-setting-title', '记忆文件'), reload);
    const filesNote = el('p', 'ym-muted ym-manage-count');
    const fileList = el('div', 'ym-manage-list');
    let orphans = [];
    const orphanAction = confirmButton('清理原聊天已不存在的', '确认清理', () => run('manageDelete', { items: orphans }), 'ym-danger');
    orphanAction.hidden = true;
    filesCard.append(filesHead, filesNote, orphanAction, fileList);

    // ---------- 日志 ----------
    const logCard = el('section', 'ym-card ym-settings-group ym-manage-log');
    const logHead = el('div', 'ym-manage-head');
    const clearLog = confirmButton('清空', '确认清空', async () => { journal?.clear(); open.clear(); }, '');
    clearLog.setAttribute('aria-label', '清空日志');
    logHead.append(el('h3', 'ym-setting-title', '日志'), clearLog);
    const logList = el('div', 'ym-log-list');
    logCard.append(logHead, logList);

    const element = el('div', 'ym-manage');
    element.append(chatCard, filesCard, logCard);

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
            if (item.raw) { detail.append(cap(item.status === 'loading' ? '模型返回（接收中）' : '模型返回'), term(item.raw)); }
        }
        if (item.error) { detail.append(cap('未完成'), el('p', 'ym-log-text ym-log-error', item.error)); }
        node.append(summary, detail);
        return node;
    }
    function renderLog() {
        const items = journal ? journal.list() : [];
        // 进行中的那条每个分块都会变：只更新它自己的正文，不重建整张列表（否则展开的条目会跟着闪）。
        const signature = JSON.stringify(items.map(item => [item.id, item.status, item.durationMs ?? null, item.raw ? item.raw.length : 0, (item.slices || []).length, item.error || '']));
        if (signature === logSignature) return;
        logSignature = signature;
        if (!items.length) { logList.replaceChildren(el('p', 'ym-muted', '暂无日志')); clearLog.hidden = true; return; }
        clearLog.hidden = false;
        logList.replaceChildren(...items.map(logEntry));
    }
    function renderFiles() {
        const manage = state.manage || {}, items = Array.isArray(manage.items) ? manage.items : null;
        reload.disabled = manage.loading === true;
        if (!items) { filesNote.textContent = manage.loading ? '正在读取…' : manage.error || ''; filesNote.hidden = !filesNote.textContent; orphanAction.hidden = true; fileList.replaceChildren(); return; }
        const current = state.snapshot?.binding ? JSON.stringify([state.snapshot.binding.avatar, state.snapshot.binding.file]) : '';
        orphans = items.filter(item => !item.unreadable && item.sourceExists === false && JSON.stringify([item.binding?.avatar, item.binding?.file]) !== current);
        const total = items.reduce((sum, item) => sum + (item.bytes || 0), 0);
        filesNote.textContent = manage.error || (items.length ? `${items.length} 个聊天 · 共 ${size(total)}` : '还没有记忆文件');
        filesNote.hidden = false;
        orphanAction.hidden = !orphans.length;
        if (orphans.length && orphanAction.getAttribute('data-armed') !== 'true') orphanAction.textContent = `清理原聊天已不存在的（${orphans.length} 个）`;
        fileList.replaceChildren(...items.map(item => {
            const node = el('div', 'ym-manage-file');
            const text = el('div', 'ym-manage-file-text');
            const isCurrent = JSON.stringify([item.binding?.avatar, item.binding?.file]) === current;
            const name = el('strong', '', item.unreadable ? '无法读取的文件' : item.binding.file);
            const facts = item.unreadable ? [size(item.bytes), day(item.updated)]
                : [item.binding.avatar.replace(/\.[^.]+$/, ''), `${item.slices + item.stages + item.custom} 条`, size(item.bytes), day(item.updated)];
            text.append(name, el('span', 'ym-muted', facts.join(' · ')));
            if (isCurrent) text.append(el('span', 'ym-manage-tag', '当前'));
            else if (!item.unreadable && item.sourceExists === false) text.append(el('span', 'ym-manage-tag ym-manage-tag-warn', '原聊天不存在'));
            node.append(text);
            const actions = el('div', 'ym-manage-file-actions');
            if (!item.unreadable) {
                const save = el('button', 'ym-button ym-icon-button ym-small'); save.type = 'button'; save.title = '导出这份记忆'; save.setAttribute('aria-label', `导出 ${item.binding.file} 的记忆`);
                save.append(createYimuIcon('download', { document }));
                save.addEventListener('click', async () => { if (save.disabled) return; save.disabled = true; try { await run('backupExportFile', { binding: item.binding }); } finally { if (!disposed) save.disabled = false; } });
                actions.append(save);
            }
            if (!isCurrent) actions.append(confirmButton('删除', '确认删除', () => run('manageDelete', { items: [item] }), 'ym-danger'));
            node.append(actions);
            return node;
        }));
    }
    function render(next = {}) {
        if (disposed) return;
        state = next;
        const entries = state.document?.entries || [], usable = Boolean(state.document && state.snapshot && !state.loading);
        const live = entries.filter(entry => entry.status !== 'deleted'), traces = entries.length - live.length;
        chatCard.hidden = !state.snapshot;
        chatCount.textContent = usable ? `${live.length} 条记忆 · ${traces} 条旧记录` : '';
        chatCount.hidden = !chatCount.textContent;
        const busy = !usable || Boolean(state.busy);
        clearAll.disabled = clearKeep.disabled = busy || !entries.length;
        clearTraces.disabled = busy || !traces;
        clearLocal.disabled = !state.snapshot;
        // 没有自定义切片时，「保留自定义切片」那一行与上一行等价，不显示。
        rows[1].hidden = !live.some(entry => entry.kind === 'manual');
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
