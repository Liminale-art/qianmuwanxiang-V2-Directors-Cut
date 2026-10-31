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
    const button = (label, glyph, action, className = '') => {
        const node = el('button', `ym-button ${className}`.trim());
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        if (glyph) node.append(el('span', 'ym-context-rule-glyph', glyph));
        node.addEventListener('click', action);
        return node;
    };
    const card = el('section', 'ym-card ym-tool-card ym-prompt-folder ym-context-rules-card');
    const heading = el('button', 'ym-tool-summary'); heading.type = 'button';
    heading.append(el('span', 'ym-context-rule-glyph', '⌘'), el('strong', '', '正文提取'), el('span', 'ym-context-rule-glyph ym-context-rule-expand', '⌄'));
    heading.setAttribute('aria-label', '正文提取'); heading.setAttribute('aria-expanded', 'false');
    const body = el('div', 'ym-tool-body'); body.hidden = true;
    const stripRow = el('label', 'ym-switch-row');
    const strip = el('input', 'ym-switch'); strip.type = 'checkbox'; strip.setAttribute('aria-label', '清除 HTML 注释');
    stripRow.append(el('span', '', '清除 HTML 注释'), strip);
    const rules = el('div', 'ym-context-rule-list'); rules.setAttribute('aria-label', '正文标签规则');
    const add = button('添加正文标签', '＋', event => { event.preventDefault(); addRow('', 'blocked', true); }, 'ym-icon-button ym-context-rule-add');
    body.append(stripRow, rules, add); card.append(heading, body);

    let state = {}, last = '', saving = false, queued = false, disposed = false;
    const rows = [];
    const ruleValues = () => rows.map(item => ({ tag: item.input.value.trim(), mode: item.mode.value }));
    const read = () => {
        const blockedTags = [], includedTags = [];
        for (const item of ruleValues()) {
            if (!item.tag) continue;
            (item.mode === 'included' ? includedTags : blockedTags).push(item.tag);
        }
        return normalizeContextRules({ stripComments: strip.checked, blockedTags, includedTags });
    };
    const controls = () => [strip, add, ...rows.flatMap(item => [item.input, item.mode, item.remove])];
    const save = async () => {
        if (disposed) return;
        if (saving) { queued = true; return; }
        const value = read(); saving = true; controls().forEach(node => { node.disabled = true; });
        try {
            const result = await onSave(clone(value));
            if (result === false) throw new Error('正文提取设置未保存');
            state = { ...state, contextRules: value };
        } catch (error) { onError(error); }
        finally {
            saving = false;
            if (!disposed) controls().forEach(node => { node.disabled = Boolean(state.disabled); });
            if (queued && !disposed) { queued = false; void save(); }
        }
    };
    const removeRow = row => {
        const index = rows.indexOf(row); if (index < 0) return;
        rows.splice(index, 1); row.node.remove(); void save();
    };
    const addRow = (tag = '', mode = 'blocked', focus = false) => {
        const node = el('div', 'ym-context-rule-row');
        const input = el('input'); input.type = 'text'; input.value = tag; input.placeholder = '标签名'; input.maxLength = 64;
        input.setAttribute('aria-label', mode === 'included' ? '提取标签' : '屏蔽标签'); input.autocomplete = 'off';
        const select = el('select'); select.setAttribute('aria-label', '规则类型');
        for (const [value, label] of [['blocked', '屏蔽'], ['included', '提取']]) { const option = el('option', '', label); option.value = value; select.append(option); }
        select.value = mode;
        let row;
        const remove = button('删除正文标签', '×', event => { event.preventDefault(); event.stopPropagation(); removeRow(row); }, 'ym-icon-button ym-context-rule-remove');
        node.append(input, select, remove); rules.append(node);
        row = { node, input, mode: select, remove }; rows.push(row);
        input.addEventListener('change', () => { void save(); });
        select.addEventListener('change', () => { input.setAttribute('aria-label', select.value === 'included' ? '提取标签' : '屏蔽标签'); void save(); });
        if (focus) input.focus();
        return row;
    };
    const renderRules = value => {
        rows.splice(0, rows.length); rules.replaceChildren();
        // The initial UI intentionally contains only the extraction boundary.
        // Users add a block rule explicitly instead of inheriting guesses.
        for (const tag of value.blockedTags) addRow(tag, 'blocked');
        for (const tag of value.includedTags) addRow(tag, 'included');
    };
    strip.addEventListener('change', () => { void save(); });
    heading.addEventListener('click', () => {
        body.hidden = !body.hidden; heading.setAttribute('aria-expanded', String(!body.hidden)); card.setAttribute('data-open', String(!body.hidden));
    });
    return {
        element: card,
        render(next = {}) {
            state = next; const value = normalizeContextRules(next.settings?.contextRules || next.contextRules);
            const signature = JSON.stringify([value, Boolean(next.disabled)]); if (signature === last) return; last = signature;
            if (document.activeElement !== strip) strip.checked = value.stripComments;
            const editing = [strip, ...rows.flatMap(item => [item.input, item.mode])].includes(document.activeElement);
            if (!editing) renderRules(value);
            controls().forEach(node => { node.disabled = Boolean(next.disabled); });
            card.hidden = false;
        },
        destroy() { disposed = true; card.remove(); },
    };
}
