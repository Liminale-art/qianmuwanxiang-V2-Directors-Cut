// Backup content is untrusted text. Never render a saved message as chat HTML.
export function mountChatRecoveryView({ root, controller, getCharacters, confirm, notify = () => {} } = {}) {
    const document = root.ownerDocument;
    let disposed = false, page = 0, selectedAvatar = '', search = '';
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
    const hint = element('p', 'qm-recovery-hint', '从当前 ST 账户的备份另建角色聊天。请通过预览确认原单聊及目标角色；原聊天与备份保持不变。');
    const tools = element('div', 'qm-recovery-tools');
    const load = button('加载备份', () => run(() => controller.load()));
    const input = element('input'); input.type = 'search'; input.placeholder = '搜索备份名或末条摘要';
    input.setAttribute('aria-label', '搜索聊天备份');
    input.addEventListener('input', () => { search = input.value; page = 0; render(); });
    tools.append(input, load);
    const status = element('p', 'qm-recovery-status'); status.setAttribute('role', 'status');
    const list = element('div', 'qm-recovery-list');
    const pager = element('div', 'qm-recovery-pager');
    const previous = button('上一页', () => { page--; render(); });
    const pageLabel = element('span');
    const next = button('下一页', () => { page++; render(); }); pager.append(previous, pageLabel, next);
    const preview = element('section', 'qm-recovery-preview');
    const previewTitle = element('h4');
    const previewText = element('pre'); previewText.tabIndex = 0;
    const targetLabel = element('label', '', '找回至角色');
    const target = element('select'); target.setAttribute('aria-label', '找回副本的目标角色');
    target.addEventListener('change', () => { selectedAvatar = target.value; render(); });
    targetLabel.append(target);
    const recover = button('另建找回副本', () => run(async () => {
        const before = controller.snapshot(), name = before.preview?.name, revision = before.preview?.revision, avatar = selectedAvatar;
        const characters = getCharacters().filter(row => row?.avatar === avatar);
        if (characters.length !== 1 || !name || !before.preview.canRecover || before.busy) return;
        const characterName = characters[0].name;
        // A confirmation never authorizes a later preview or a different target.
        if (await confirm(`请确认预览是要找回的角色单聊。将备份另存为“${characters[0].name || '未命名角色'}”的新聊天？原聊天与备份不会被覆盖。`) !== true) return;
        const after = controller.snapshot(), currentCharacters = getCharacters().filter(row => row?.avatar === avatar);
        if (disposed || selectedAvatar !== avatar || after.preview?.name !== name || after.preview?.revision !== revision || after.busy
            || currentCharacters.length !== 1 || currentCharacters[0].name !== characterName) return;
        await controller.recover(avatar);
    }));
    preview.append(previewTitle, previewText, targetLabel, recover);
    const receipt = element('section', 'qm-recovery-receipt');
    const receiptText = element('p'); receiptText.setAttribute('role', 'status');
    const verify = button('核实上次结果', () => run(() => controller.verify())); receipt.append(receiptText, verify);
    root.replaceChildren(hint, tools, status, list, pager, preview, receipt);

    function render(snapshot = controller.snapshot()) {
        if (disposed) return;
        const query = search.trim().toLocaleLowerCase();
        const rows = (snapshot.backups || []).filter(row => !query || `${row.name} ${row.excerpt || ''}`.toLocaleLowerCase().includes(query));
        const pages = Math.max(1, Math.ceil(rows.length / 10)); page = Math.min(Math.max(0, page), pages - 1);
        load.disabled = !!snapshot.busy; input.disabled = !!snapshot.busy;
        status.textContent = snapshot.busy ? '正在处理，请稍候…' : snapshot.error || (snapshot.phase === 'idle' ? '点击“加载备份”查看可用记录。' : `${rows.length} 份备份候选`);
        list.replaceChildren();
        for (const row of rows.slice(page * 10, (page + 1) * 10)) {
            const item = button('', () => run(() => controller.preview(row.name)));
            item.className = 'qm-recovery-item'; item.disabled = !!snapshot.busy;
            item.classList.toggle('is-selected', snapshot.preview?.name === row.name);
            item.setAttribute('aria-pressed', String(snapshot.preview?.name === row.name));
            const name = element('span', 'qm-recovery-name', row.name);
            const count = Number.isFinite(row.messageCount) ? `${row.messageCount} 条消息` : '消息数待预览';
            const info = element('small', '', count + (row.size ? ` · ${row.size}` : ''));
            item.append(name, info);
            if (row.excerpt) item.append(element('span', 'qm-recovery-excerpt', row.excerpt));
            list.append(item);
        }
        pager.hidden = rows.length <= 10;
        previous.disabled = !!snapshot.busy || page === 0; next.disabled = !!snapshot.busy || page >= pages - 1;
        pageLabel.textContent = `${page + 1} / ${pages}`;
        preview.hidden = !snapshot.preview;
        if (snapshot.preview) {
            previewTitle.textContent = `备份预览 · ${snapshot.preview.messageCount} 条消息`;
            previewText.textContent = snapshot.preview.text || '这份备份没有可预览的正文。';
        }
        const oldValue = selectedAvatar;
        const placeholder = element('option', '', '请选择目标角色'); placeholder.value = '';
        target.replaceChildren(placeholder);
        for (const row of getCharacters()) {
            if (typeof row?.avatar !== 'string' || !row.avatar) continue;
            const option = element('option', '', row.name || row.avatar); option.value = row.avatar; target.append(option);
        }
        target.value = oldValue; if (target.value !== oldValue) selectedAvatar = '';
        target.disabled = !!snapshot.busy;
        // An unknown write is verified, never re-submitted from this button.
        recover.disabled = !!snapshot.busy || !selectedAvatar || !snapshot.preview?.canRecover || !!snapshot.result;
        receipt.hidden = !snapshot.result;
        if (snapshot.result) {
            const result = snapshot.result;
            receiptText.textContent = result.status === 'verified'
                ? `已找回 ${result.messageCount} 条消息至“${result.target?.name || '所选角色'}”。请从该角色的聊天记录打开副本：${result.fileName}`
                : result.status === 'conflict' ? '找到的文件与预期内容不一致，未覆盖或自动重试。请保留原件并核对。'
                    : '尚未确认是否已创建副本。请先核实上次结果，不要重复找回。';
            verify.hidden = result.status === 'verified'; verify.disabled = !!snapshot.busy;
        }
    }
    render();
    return Object.freeze({ render, dispose() { disposed = true; root.replaceChildren(); } });
}
