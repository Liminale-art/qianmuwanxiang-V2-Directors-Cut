export function mountCompanionView({ document, el, button, onAction }) {
    const element = el('details', 'ym-card ym-companion');
    element.append(el('summary', '', '关联伴读'));
    const body = el('div', 'ym-settings-form'); element.append(body);
    let last = '', state, listOwner = null, draft = {key:'',cutoff:'',own:false}, binding = '';
    const invoke = (type, payload) => Promise.resolve(onAction(type, payload)).catch(() => {});
    const field = (label, input) => { const node = el('label', 'ym-field'); node.append(el('span', '', label), input); return node; };
    return { element, render(next) {
        state = next;
        const value = next.companion || {}, linked = next.document?.companion;
        const nextBinding = JSON.stringify(next.snapshot?.binding || null);
        if (binding !== nextBinding || listOwner !== value.list) {
            binding = nextBinding; listOwner = value.list;
            const first = value.list?.items?.[0]; draft = {key:first?.key || '',cutoff:first?.readTo == null ? '' : String(first.readTo),own:false};
        }
        const unavailable = !next.document || !next.snapshot || next.loading || ['error','mismatch'].includes(next.service?.status);
        const signature = JSON.stringify([value, linked, next.snapshot?.binding,unavailable]);
        if (signature === last) return; last = signature;
        body.replaceChildren();
        body.append(el('p', 'ym-muted', '只关联明确确认的已读摘要；书中情节与共同交流分开使用，不上传全书，不自动扩大到后续章节。'));
        if (linked) {
            body.append(el('p', '', `已关联《${linked.title}》 · ${linked.entries.length} 条 · 共同已读位置 ${linked.confirmedReadTo}`));
            body.append(button('解除此聊天关联', () => invoke('companionClear')));
        }
        body.append(button(linked ? '选择或更新关联' : '选择伴读记录', () => invoke('companionList')));
        if (value.busy) body.append(el('p', 'ym-muted', '正在核对伴读资料…'));
        if (value.error) body.append(el('p', 'ym-error', value.error));
        if (value.status) body.append(el('p', 'ym-status', value.status));
        let save = null;
        const matchesPreview = () => value.query && draft.key === value.query.key && Number(draft.cutoff) === value.query.confirmedReadTo && draft.own;
        if (value.list && !value.list.items?.length) body.append(el('p','ym-muted','本机没有可关联的伴读记录。请先在伴读中选择书籍与书友，并保存交流记忆。'));
        if (value.list?.items?.length) {
            const select = document.createElement('select');
            for (const item of value.list.items || []) {
                const option = el('option', '', `${item.title} · ${item.charName || item.avatar} / ${item.userName || item.persona}`);
                option.value = item.key; select.append(option);
            }
            const cutoff = document.createElement('input'); cutoff.type = 'number'; cutoff.min = '0'; cutoff.step = '1';
            select.value = draft.key; cutoff.value = draft.cutoff;
            const own = document.createElement('input'); own.type = 'checkbox';
            own.checked = draft.own;
            const confirm = el('label', 'ym-field'); confirm.append(own, el('span', '', '这是我的本机伴读档案，以上位置是已共同读到的截止。'));
            body.append(field('伴读记录', select), field('共同已读截止（书内位置；可在伴读定位后重新读取）', cutoff), confirm);
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
        if (value.omitted && Object.values(value.omitted).some(count=>count>0)) {
            const {future=0,unknown=0,mixed=0}=value.omitted;
            body.append(el('p','ym-muted',`未纳入：超出已读范围 ${future} 条，来源不完整 ${unknown} 条，混合来源 ${mixed} 条。`));
        }
        if (value.preview?.entries?.length) {
            for (const item of value.preview.entries) {
                const card = el('div', 'ym-card'); card.append(el('strong', '', item.kind === 'book' ? '书中背景（不等于亲历或知情）' : '共同交流'), el('p', 'ym-memory-text', item.text)); body.append(card);
            }
            body.append(el('p', 'ym-muted', '这是用户确认的摘要快照，不冒称原文已核验。更新需再次预览确认，不会改写现有手动记忆。'));
            save=button('确认关联以上摘要', () => invoke('companionSave'));save.disabled=!matchesPreview();body.append(save);
        }
        if (value.busy || unavailable) for (const control of body.querySelectorAll('button,input,select')) control.disabled = true;
        element.hidden = !state.document;
    } };
}
