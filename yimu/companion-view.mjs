import { shownFloor, fingerprintMessages } from './contract.mjs';
import { companionBooks } from './companion-contract.mjs';

const day = at => { const date = new Date(at); return `${date.getMonth() + 1}月${date.getDate()}日`; };
// Where the latest update sits in the story: the anchor of the most recently shared entry.
const latestAnchor = book => book.entries.reduce((best, entry) => !best || entry.seq > best.seq ? entry : best, null)?.anchor || null;

export function mountCompanionView({ document, el, button, onAction, onNotice = () => {}, pageMode = false }) {
    const element = el(pageMode ? 'section' : 'details', `ym-companion ${pageMode ? 'ym-subpage-section' : 'ym-card'}`);
    if (!pageMode) element.append(el('summary', '', '关联伴读'));
    const body = el('div', 'ym-settings-form'); element.append(body);
    let last = '', state, listOwner = '', draft = {key:'',cutoff:'',own:false}, binding = '', lastStatus = '';
    let anchorKey = '', anchorHashes = new Map(), booksKey = '', books = [];
    const invoke = (type, payload) => Promise.resolve(onAction(type, payload)).catch(() => {});
    const field = (label, input) => { const node = el('label', 'ym-field'); node.append(el('span', '', label), input); return node; };
    const view = { element, render(next) {
        state = next;
        const value = next.companion || {}, linkedKey = next.document?.companion ? JSON.stringify(next.document.companion) : '';
        if (linkedKey !== booksKey) { booksKey = linkedKey; books = companionBooks(next.document?.companion); }
        const nextBinding = JSON.stringify(next.snapshot?.binding || null);
        const listKey = JSON.stringify([value.list || null, value.pick || '']);
        if (binding !== nextBinding || listOwner !== listKey) {
            binding = nextBinding; listOwner = listKey; lastStatus = '';
            const first = value.list?.items?.find(item => item.key === value.pick) || value.list?.items?.[0];
            const known = first?.readTo ?? books.find(book => book.key === first?.key)?.confirmedReadTo;
            draft = {key:first?.key || '',cutoff:known == null ? '' : String(known),own:false};
        }
        // Whether the floor a book was last recorded at still reads the same; checked off the render path.
        const messages = next.snapshot?.messages || [], floors = [...new Set(books.map(book => latestAnchor(book)?.floor).filter(Boolean))];
        const key = JSON.stringify([nextBinding, floors.map(floor => { const message = messages[floor - 1]; return [floor, message?.mes, message?.send_date, message?.name]; })]);
        if (key !== anchorKey) {
            anchorKey = key; anchorHashes = new Map();
            if (floors.length) fingerprintMessages(floors.map(floor => messages[floor - 1] || {})).then(hashes => {
                if (anchorKey !== key) return;
                anchorHashes = new Map(floors.map((floor, index) => [floor, messages[floor - 1] ? hashes[index] : '']));
                last = ''; if (state) view.render(state);
            }).catch(() => {});
        }
        const unavailable = !next.document || !next.snapshot || next.loading || ['error','mismatch'].includes(next.service?.status);
        const signature = JSON.stringify([value, linkedKey, next.snapshot?.binding,unavailable,[...anchorHashes]]);
        if (signature === last) return; last = signature;
        body.replaceChildren();
        for (const book of books) {
            const card = el('div', 'ym-card'), count = kind => book.entries.filter(entry => entry.kind === kind).length, anchor = latestAnchor(book);
            const moved = anchor && anchorHashes.has(anchor.floor) && anchorHashes.get(anchor.floor) !== anchor.hash;
            const actions = el('div', 'ym-actions');
            actions.append(button('更新关联', () => invoke('companionList', {key: book.key})), button('解除关联', () => invoke('companionClear', {key: book.key})));
            card.append(el('strong', '', `《${book.title}》${book.readLabel ? ` · 读到 ${book.readLabel}` : ''}`),
                el('p', 'ym-muted', `共读经历 ${count('dialog')} 条 · 书中内容 ${count('book')} 条 · 记事 ${count('note')} 条`),
                el('p', 'ym-muted', `${book.updatedAt ? `上次更新 ${day(book.updatedAt)} · ` : ''}${anchor ? `记在第 #${shownFloor(anchor.floor)} 层之后` : '尚未定位'}${moved ? ' · 锚点楼层已改动' : ''}`),
                actions);
            body.append(card);
        }
        body.append(button('关联伴读', () => invoke('companionList')));
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
                const card = el('div', 'ym-card'); card.append(el('strong', '', item.kind === 'book' ? '书中内容（提到这本书时才带入）' : '共读经历'), el('p', 'ym-memory-text', item.text)); body.append(card);
            }
            save=button('确认关联以上摘要', () => invoke('companionSave'));save.disabled=!matchesPreview();body.append(save);
        }
        if (value.busy || unavailable) for (const control of body.querySelectorAll('button,input,select')) control.disabled = true;
        element.hidden = false;
    } };
    return view;
}
