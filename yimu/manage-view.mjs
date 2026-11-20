// 「管理」页：日志、当前聊天的记忆清理、记忆文件（含导入与导出）。
// 这里只发起动作与显示结果；真正的清理、删除与记录都在 runtime／服务端。文案只说动作与结果。
import { createYimuIcon } from './icons.mjs';
import { shownFloor } from './contract.mjs';
import { parseHeartExport } from './heart-view.mjs';

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

export function mountManageView({ document = globalThis.document, journal = null, backup = null, onAction = async () => {}, describeSkip = reason => [String(reason || ''), ''], onNotice: notify = () => {} } = {}) {
    if (!document?.createElement) throw new TypeError('忆幕管理页缺少文档容器');
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let state = {}, disposed = false, listed = false, logSignature = '', fileSignature = '';
    const open = new Set(), timers = new Set(), folders = new Set(), picked = new Set();
    let selecting = false, moreOpen = false;
    const run = async (type, payload) => { try { return await onAction(type, payload); } catch { return false; } };

    // 小图标按钮。needsConfirm 返回真时要点两下：第一下变成「确认」样式，几秒内不再点就复原。不弹对话框。
    // 给了 text 就是文字按钮（待确认时文字换成 confirmText），否则是图标按钮（待确认时换成对勾）。onArm 在进入、退出待确认时各叫一次。
    const iconAction = (label, glyph, action, { needsConfirm = () => false, className = '', text = '', confirmText = '再点确认', onArm = null } = {}) => {
        const node = el('button', `ym-button ${text ? '' : 'ym-icon-button '}ym-small ${className}`.trim());
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        const paint = confirming => { if (text) node.textContent = confirming ? confirmText : text; else node.replaceChildren(createYimuIcon(confirming ? 'check' : glyph, { document })); };
        paint(false);
        let armed = false, timer = null;
        const disarm = () => { const was = armed; armed = false; clearTimeout(timer); timers.delete(timer); timer = null; node.removeAttribute('data-armed'); node.title = label; paint(false); if (was) onArm?.(false); };
        node.disarm = disarm;
        node.addEventListener('click', async event => {
            event.stopPropagation?.();
            if (node.disabled) return;
            if (needsConfirm() && !armed) {
                armed = true; node.setAttribute('data-armed', 'true'); node.title = '再点一次确认'; paint(true); onArm?.(true);
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
    const selectToggle = iconAction('多选文件', 'select', async () => { selecting = !selecting; moreOpen = false; picked.clear(); fileSignature = ''; });
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
    // 导入、导出、多选收在「更多」里：点开后三个小图标横排在它左边，点别处收回。导入的进度与「选目标」出现在列表上方。
    const importFiles = iconAction('导入记忆文件', 'upload', async () => { moreOpen = false; backup?.importFiles(); });
    const exportCurrent = iconAction('导出当前聊天的记忆', 'download', async () => { moreOpen = false; backup?.exportCurrent(); });
    const more = el('button', 'ym-button ym-icon-button ym-small');
    more.type = 'button'; more.title = '更多'; more.setAttribute('aria-label', '更多文件操作'); more.setAttribute('aria-expanded', 'false');
    more.append(createYimuIcon('more', { document }));
    more.addEventListener('click', () => { moreOpen = !moreOpen; renderFiles(); });
    // 导入一份导出的心迹页（网页文件）：里面的日记、心迹、年表并进当前聊天，按条去重。
    const heartFile = el('input'); heartFile.type = 'file'; heartFile.accept = '.html,text/html'; heartFile.hidden = true; heartFile.setAttribute('aria-label', '选择导出的心迹页');
    heartFile.addEventListener('change', async () => {
        const file = heartFile.files?.[0]; heartFile.value = '';
        if (!file) return;
        try { await run('heartImport', { heart: parseHeartExport(await file.text()) }); }
        catch (error) { notify(error?.message || '心迹页没有导入成', 'error'); }
    });
    const importHeart = iconAction('导入心迹页', 'loveletter', async () => { moreOpen = false; heartFile.click(); });
    const moreTray = el('div', 'ym-manage-more-tray'); moreTray.hidden = true;
    moreTray.append(importFiles, importHeart, exportCurrent, selectToggle); // 文件选择框不挂进页面，点图标时直接唤起
    const moreGroup = el('div', 'ym-manage-more'); moreGroup.append(moreTray, more);
    filesCard.append(head('记忆文件', filesNote, selectAll, exportPicked, removePicked, moreGroup, reload));
    if (backup?.node) filesCard.append(backup.node);
    filesCard.append(fileList);

    const element = el('div', 'ym-manage');
    element.append(logCard, chatCard, filesCard);

    const cap = text => el('div', 'ym-log-cap', text);
    const term = (text, className = 'ym-term') => el('pre', className, text);
    // 与千幕的日志同一个形式：一行是「日期 · 输出用时」，右侧标「切片」或「阶段」；
    // 展开后两块终端样式的全文——发送、返回，小标题后跟 token 标签。
    const tag = text => el('span', 'ym-log-tag', text);
    function logEntry(item) {
        const node = el('details', 'ym-log-entry'); node.dataset.logId = item.id; node.open = open.has(item.id);
        node.addEventListener('toggle', () => { if (node.open) open.add(item.id); else open.delete(item.id); });
        const summary = el('summary');
        const status = el('span', `ym-log-status ${item.status || ''}`.trim()); status.setAttribute('aria-hidden', 'true');
        const took = item.status === 'loading' ? '进行中' : Number.isFinite(item.durationMs) ? `用时 ${seconds(item.durationMs)}` : '';
        summary.append(status, el('span', 'ym-log-title', clock(item.at)), el('span', 'ym-log-meta', took), el('span', 'ym-log-kind', item.kind === 'stage' ? '阶段' : item.kind === 'diary' ? '日记' : '切片'));
        const detail = el('div', 'ym-log-detail');
        if (item.error) detail.append(term(item.error, 'ym-term ym-term-error'));
        const sent = cap('发送'); if (item.request) sent.append(tag(`约 ${Number.isFinite(item.requestTokens) ? item.requestTokens : '—'} token`));
        const back = cap(item.status === 'loading' ? '返回（接收中）' : '返回'); if (item.raw) back.append(tag(`约 ${Number.isFinite(item.responseTokens) ? item.responseTokens : '—'} token`));
        detail.append(sent, term(item.request || '暂无'), back, term(item.raw || '暂无'));
        node.append(summary, detail);
        return node;
    }
    function renderLog() {
        const items = journal ? journal.list() : [];
        // 内容没变就不重建（否则展开着的条目会跟着闪、被收起）。
        const signature = JSON.stringify(items.map(item => [item.id, item.status, item.durationMs ?? null, item.raw ? item.raw.length : 0, item.request ? item.request.length : 0, item.error || '']));
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
    // 带入之后的「撤销带入」：只记在这次面板会话里，不落盘。带入写进来的条目编号是「操作号_序号」的自定义切片，
    // 带入前后各看一眼当前聊天的条目，多出来的那一批就是它；认不出来（或已撤完）就留空，只记得「带入过」。
    const adopted = new Map(), undoing = new Set();
    const adoptKey = item => `${currentKey()}\n${item.name}`;
    const entriesNow = () => Array.isArray(state.document?.entries) ? state.document.entries : [];
    const liveBatch = item => {
        const ids = adopted.get(adoptKey(item));
        if (!ids?.length) return [];
        const live = new Set(entriesNow().filter(entry => entry.status !== 'deleted').map(entry => entry.id));
        return ids.filter(id => live.has(id));
    };
    async function assign(item) {
        const key = adoptKey(item), before = new Set(entriesNow().map(entry => entry.id));
        if (await run('manageAssign', { item }) === false) return;
        const fresh = entriesNow().filter(entry => !before.has(entry.id) && entry.kind === 'manual' && /_\d+$/.test(entry.id));
        const batches = new Set(fresh.map(entry => entry.id.replace(/_\d+$/, '')));
        adopted.set(key, batches.size === 1 ? fresh.map(entry => entry.id) : []);
    }
    async function undoAssign(item) {
        const key = adoptKey(item);
        if (undoing.has(key)) return;
        undoing.add(key);
        try {
            // 逐条走记忆页多选删除用的同一个删除（可在「已删除的记忆」里撤回）；某一条删不了就停下，前面删掉的保留。
            for (const entryId of liveBatch(item)) if (await run('entry', { entryId, action: 'delete' }) === false) break;
        } finally { undoing.delete(key); }
    }
    function fileRow(item, { withCharacter = false } = {}) {
        const node = el('div', 'ym-manage-file'); node.dataset.name = item.name;
        const isCurrent = !item.unreadable && keyOf(item) === currentKey(), canPick = !item.unreadable && !isCurrent;
        const fileName = item.unreadable ? item.name : item.binding.file;
        const facts = item.unreadable ? [size(item.bytes), day(item.updated)]
            : [...(withCharacter ? [character(item)] : []), `${item.slices + item.stages + item.custom} 条`, size(item.bytes), day(item.updated)];
        // 文件名独占一行（单行，超出省略，完整名字在 title）；下一行左边是小字信息，右边是操作。
        const name = el('span', 'ym-manage-file-name', fileName); name.title = fileName;
        const info = el('span', 'ym-muted', facts.join(' · '));
        const meta = el('div', 'ym-manage-file-meta'); meta.append(info);
        node.append(name, meta);
        if (selecting) {
            node.dataset.selectable = String(canPick); node.dataset.selected = String(canPick && picked.has(item.name));
            if (canPick) node.addEventListener('click', () => { if (picked.has(item.name)) picked.delete(item.name); else picked.add(item.name); fileSignature = ''; render(state); });
            return node;
        }
        if (!canPick) return node;
        const actions = el('div', 'ym-manage-file-actions');
        // 在聊天里：把这份记忆指定给当前聊天（作为独立记忆带入）。两下确认。单个导出走「更多 → 多选 → 导出」。
        // 这次会话里带入过、那一批还在：按钮换成「撤销带入」。带入过又要再带：待确认时在左边那行小字里说一句。
        if (state.snapshot?.binding) {
            if (liveBatch(item).length) {
                const undo = iconAction(`撤销带入 ${item.binding.file} 的记忆`, 'back', () => undoAssign(item), { needsConfirm: () => true, text: '撤销带入', confirmText: '再点撤销' });
                undo.disabled = undoing.has(adoptKey(item)); actions.append(undo);
            } else actions.append(iconAction(`把 ${item.binding.file} 的记忆带入本聊天`, 'link', () => assign(item), { needsConfirm: () => true, text: '带入本聊天',
                onArm: adopted.has(adoptKey(item)) ? armed => { info.textContent = armed ? '这份已带入过，再点一次重复带入' : facts.join(' · '); } : null }));
        }
        actions.append(iconAction(`删除 ${item.binding.file} 的记忆`, 'trash', () => run('manageDelete', { items: [item] }), { needsConfirm: () => true, className: 'ym-danger' }));
        meta.append(actions);
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
        // 多选时「更多」让位，只留「多选」这一个图标用来退出。
        more.hidden = selecting || !backup && !selectable().length && !state.document;
        if (more.hidden) moreOpen = false;
        more.setAttribute('aria-expanded', String(moreOpen));
        moreTray.hidden = !moreOpen && !selecting;
        selectAll.hidden = removePicked.hidden = exportPicked.hidden = !selecting;
        importFiles.hidden = exportCurrent.hidden = selecting || !backup; reload.hidden = selecting;
        importHeart.hidden = selecting || !state.document;
        importFiles.disabled = !backup?.canImport(); exportCurrent.disabled = !backup?.canExport();
        removePicked.disabled = exportPicked.disabled = !chosen;
        filesNote.textContent = selecting ? `已选 ${chosen} 个` : !loaded ? manage.loading ? '正在读取…' : manage.error || ''
            : manage.error || (items.length ? `${items.length} 个 · ${size(items.reduce((sum, item) => sum + (item.bytes || 0), 0))}` : '');
        const signature = JSON.stringify([loaded, inChat, currentKey(), selecting, [...picked].sort(), items.map(item => [item.name, item.revision, item.bytes, item.updated, item.sourceExists, item.unreadable, ...(inChat && !item.unreadable ? [adopted.has(adoptKey(item)), liveBatch(item).length, undoing.has(adoptKey(item))] : [])])]);
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
        /** 面板里任何一处被点到时由外层告知：点在「更多」之外就把它收回。 */
        clickedAt(target) { if (moreOpen && target?.closest?.('.ym-manage-more') !== moreGroup) { moreOpen = false; renderFiles(); } },
        shown() { renderLog(); if (!listed) { listed = true; void run('manageList', {}); } },
        destroy() { disposed = true; unsubscribe?.(); for (const timer of timers) clearTimeout(timer); element.remove(); },
    };
}
