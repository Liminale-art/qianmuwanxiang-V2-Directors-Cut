export function mountCompanionView({ document, el, button, onAction, onNotice = () => {}, pageMode = false }) {
    const element = el(pageMode ? 'section' : 'details', `ym-companion ${pageMode ? 'ym-subpage-section' : 'ym-card'}`);
    if (!pageMode) element.append(el('summary', '', '关联伴读'));
    const body = el('div', 'ym-settings-form'); element.append(body);
    let last = '', state, listOwner = '', draft = {key:'',cutoff:'',own:false}, binding = '', lastStatus = '';
    const invoke = (type, payload) => Promise.resolve(onAction(type, payload)).catch(() => {});
    const field = (label, input) => { const node = el('label', 'ym-field'); node.append(el('span', '', label), input); return node; };
    return { element, render(next) {
        state = next;
        const value = next.companion || {}, linked = next.document?.companion;
        const nextBinding = JSON.stringify(next.snapshot?.binding || null);
        const listKey = JSON.stringify(value.list || null);
        if (binding !== nextBinding || listOwner !== listKey) {
            binding = nextBinding; listOwner = listKey; lastStatus = '';
            const first = value.list?.items?.[0]; draft = {key:first?.key || '',cutoff:first?.readTo == null ? '' : String(first.readTo),own:false};
        }
        const unavailable = !next.document || !next.snapshot || next.loading || ['error','mismatch'].includes(next.service?.status);
        const signature = JSON.stringify([value, linked, next.snapshot?.binding,unavailable]);
        if (signature === last) return; last = signature;
        body.replaceChildren();
        if (linked) {
            body.append(el('p', '', `已关联《${linked.title}》 · 共同已读位置 ${linked.confirmedReadTo}`));
            body.append(button('解除此聊天关联', () => invoke('companionClear')));
        }
        body.append(button('选择伴读记忆', () => invoke('companionList')));
        if (value.busy) body.append(el('p', 'ym-muted', '正在读取伴读记忆…'));
        if (value.error) body.append(el('p', 'ym-error', value.error));
        if (value.status && value.status !== lastStatus) onNotice(value.status, 'success');
        lastStatus = value.status || '';
        let save = null;
        const matchesPreview = () => value.query && draft.key === value.query.key && Number(draft.cutoff) === value.query.confirmedReadTo && draft.own;
        if (value.list && !value.list.items?.length) body.append(el('p','ym-muted','本机没有可关联的伴读记录。请先在伴读中保存记忆。'));
        if (value.list?.items?.length) {
            const select = document.createElement('select');
            select.setAttribute('aria-label', '伴读记录');
            for (const item of value.list.items || []) {
                const option = el('option', '', `${item.title} · ${item.charName || item.avatar} / ${item.userName || item.persona}`);
                option.value = item.key; select.append(option);
            }
            const cutoff = document.createElement('input'); cutoff.type = 'number'; cutoff.min = '0'; cutoff.step = '1';
            cutoff.setAttribute('aria-label', '共同已读位置');
            select.value = draft.key; cutoff.value = draft.cutoff;
            const own = document.createElement('input'); own.type = 'checkbox';
            own.setAttribute('aria-label', '确认伴读记录与已读位置');
            own.checked = draft.own;
            const confirm = el('label', 'ym-backup-check'); confirm.append(own, el('span', '', '确认此记录及共同已读位置'));
            body.append(field('伴读记录', select), field('共同已读位置', cutoff), confirm);
            const preview = button('读取并预览摘要', () => invoke('companionPreview', {key: select.value, confirmedReadTo: Number(cutoff.value), confirmedLocalOwnership: own.checked}));
            const enabled = () => {
                preview.disabled = value.busy || unavailable || !own.checked || !select.value || cutoff.value === '' || !Number.isSafeInteger(Number(cutoff.value)) || Number(cutoff.value) < 0;
                if (save) save.disabled = value.busy || unavailable || !matchesPreview();
            };
            own.addEventListener('change', () => {draft.own=own.checked;enabled();});
            cutoff.addEventListener('input', () => {draft.cutoff=cutoff.value;draft.own=false;own.checked=false;enabled();});
            select.addEventListener('change', () => {
                const item=value.list.items.find(item=>item.key===select.value);
                draft={key:select.value,cutoff:item?.readTo==null?'':String(item.readTo),own:false};cutoff.value=draft.cutoff;own.checked=false;enabled();
            });
            enabled(); body.append(preview);
        }
        if (value.preview?.entries?.length) {
            for (const item of value.preview.entries) {
                const card = el('div', 'ym-card'); card.append(el('strong', '', item.kind === 'book' ? '书中背景（不等于亲历或知情）' : '共同交流'), el('p', 'ym-memory-text', item.text)); body.append(card);
            }
            save=button('确认关联以上摘要', () => invoke('companionSave'));save.disabled=!matchesPreview();body.append(save);
        }
        if (value.busy || unavailable) for (const control of body.querySelectorAll('button,input,select')) control.disabled = true;
        element.hidden = false;
    } };
}
