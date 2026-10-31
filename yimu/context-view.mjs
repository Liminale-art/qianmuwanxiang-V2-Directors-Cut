import { DEFAULT_CONTEXT_RULES, normalizeContextRules } from './context-filter.mjs';

// These controls shape only the copy sent to memory summarisation. They never
// mutate ST messages, source hashes, or the saved chat file.
const clone = value => structuredClone(value);
export { DEFAULT_CONTEXT_RULES, normalizeContextRules } from './context-filter.mjs';

export function mountContextRulesView({ document = globalThis.document, onSave = () => {}, onError = () => {} } = {}) {
    if (!document?.createElement) throw new TypeError('正文提取缺少文档容器');
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const input = (label, type) => {
        const node = el('textarea'); node.setAttribute('aria-label', label);
        node.placeholder = type === 'blocked' ? '例如 status, status-bar, style' : '例如 content';
        node.rows = 2; node.autocomplete = 'off'; return node;
    };
    const field = (label, node) => { const row = el('label', 'ym-field'); row.append(el('span', '', label), node); return row; };
    const card = el('section', 'ym-card ym-context-rules-card');
    const heading = el('button', 'ym-tool-summary'); heading.type = 'button';
    heading.append(el('strong', '', '正文提取'), el('span', 'ym-context-rules-arrow', '⌄'));
    heading.setAttribute('aria-label', '正文提取'); heading.setAttribute('aria-expanded', 'false');
    const body = el('div', 'ym-context-rules-body'); body.hidden = true;
    body.append(el('p', 'ym-muted', '整理前先处理正文中的状态栏、装饰标签与注释；不会修改原聊天。'));
    const stripRow = el('label', 'ym-switch-row'); const strip = el('input', 'ym-switch'); strip.type = 'checkbox'; strip.setAttribute('aria-label', '清除 HTML 注释');
    stripRow.append(el('span', '', '清除 HTML 注释'), strip); body.append(stripRow);
    const blocked = input('屏蔽标签', 'blocked'); const included = input('提取标签', 'included');
    body.append(field('屏蔽标签', blocked), field('提取标签', included));
    body.append(el('p', 'ym-muted', '标签只填写名称，不含尖括号；屏蔽优先于提取。提取标签找不到时保留清理后的完整正文。'));
    card.append(heading, body);
    let state = {}, last = '', saving = false, queued = false, disposed = false;
    const read = () => normalizeContextRules({ stripComments: strip.checked, blockedTags: blocked.value, includedTags: included.value });
    const save = async () => {
        if (disposed) return;
        if (saving) { queued = true; return; }
        const value = read(); saving = true; [strip, blocked, included].forEach(node => { node.disabled = true; });
        try {
            const result = await onSave(clone(value));
            if (result === false) throw new Error('正文提取设置未保存');
            state = { ...state, contextRules: value };
        } catch (error) { onError(error); }
        finally {
            saving = false;
            if (!disposed) [strip, blocked, included].forEach(node => { node.disabled = Boolean(state.disabled); });
            if (queued && !disposed) { queued = false; void save(); }
        }
    };
    [strip, blocked, included].forEach(node => node.addEventListener('change', () => { void save(); }));
    heading.addEventListener('click', () => { body.hidden = !body.hidden; heading.setAttribute('aria-expanded', String(!body.hidden)); card.setAttribute('data-open', String(!body.hidden)); });
    return {
        element: card,
        render(next = {}) {
            state = next; const value = normalizeContextRules(next.settings?.contextRules || next.contextRules);
            const signature = JSON.stringify([value, Boolean(next.disabled)]); if (signature === last) return; last = signature;
            if (document.activeElement !== strip) strip.checked = value.stripComments;
            if (document.activeElement !== blocked) blocked.value = value.blockedTags.join(', ');
            if (document.activeElement !== included) included.value = value.includedTags.join(', ');
            [strip, blocked, included].forEach(node => { node.disabled = Boolean(next.disabled); });
            card.hidden = false;
        },
        destroy() { disposed = true; card.remove(); },
    };
}
