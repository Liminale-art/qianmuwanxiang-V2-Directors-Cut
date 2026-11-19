import { DEFAULT_CONTEXT_RULES, normalizeContextRules } from './context-filter.mjs';
import { createYimuIcon } from './icons.mjs';

// These controls shape only the copy sent to memory summarisation. They never
// mutate ST messages, source hashes, or the saved chat file.
const clone = value => structuredClone(value);
export { DEFAULT_CONTEXT_RULES, normalizeContextRules } from './context-filter.mjs';

// bare：只要内容区（标题与折叠由外层的工具卡负责）。
export function mountContextRulesView({ bare = false, document = globalThis.document, onSave = () => {}, onError = () => {} } = {}) {
    if (!document?.createElement) throw new TypeError('标签规则缺少文档容器');
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, glyph, action, className = '') => {
        const node = el('button', `ym-button ${className}`.trim());
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        if (glyph) node.append(createYimuIcon(glyph, { document }));
        node.addEventListener('click', action);
        return node;
    };
    const card = el('section', 'ym-card ym-tool-card ym-prompt-folder ym-context-rules-card');
    const heading = el('button', 'ym-button ym-tool-summary'); heading.type = 'button';
    heading.append(createYimuIcon('settings', { document }), el('strong', '', '标签规则'));
    heading.setAttribute('aria-label', '标签规则'); heading.setAttribute('aria-expanded', 'false');
    const body = el('div', 'ym-tool-body'); body.hidden = true;
    const stripRow = el('label', 'ym-switch-row');
    const strip = el('input', 'ym-switch'); strip.type = 'checkbox'; strip.setAttribute('aria-label', '清除 HTML 注释');
    stripRow.append(el('span', '', '清除 HTML 注释'), strip);
    const rules = el('div', 'ym-context-rule-list'); rules.setAttribute('aria-label', '正文标签规则');
    const add = button('添加正文标签', 'plus', event => { event.preventDefault(); addRow('', 'blocked', true); }, 'ym-icon-button ym-context-rule-add');
    body.append(stripRow, rules, add); card.append(heading, body);
    if (bare) { body.hidden = false; body.className = 'ym-context-rules-body'; }

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
        // 保存期间不把控件置灰：置灰会让正在输入的框失焦、整块闪一下。连续修改由 saving/queued 合并成顺序保存。
        const value = read(); saving = true;
        try {
            const result = await onSave(clone(value));
            if (result === false) throw new Error('标签规则设置未保存');
            state = { ...state, contextRules: value };
        } catch (error) { onError(error); }
        finally {
            saving = false;
            if (queued && !disposed) { queued = false; void save(); }
            else if (!disposed) applyDisabled();
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
        const remove = button('删除正文标签', 'close', event => { event.preventDefault(); event.stopPropagation(); removeRow(row); }, 'ym-icon-button ym-context-rule-remove');
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
    // 外层在自己这次保存进行时会报「忙」，那不是需要用户等待的状态：自己保存期间不置灰。
    // 其他来源的禁用（读取中、别的操作在进行）照常生效。
    const applyDisabled = () => {
        const disabled = Boolean(state.disabled) && !saving && !queued;
        controls().forEach(node => { if (node.disabled !== disabled) node.disabled = disabled; });
    };
    strip.addEventListener('change', () => { void save(); });
    heading.addEventListener('click', () => {
        body.hidden = !body.hidden; heading.setAttribute('aria-expanded', String(!body.hidden)); card.setAttribute('data-open', String(!body.hidden));
    });
    return {
        element: bare ? body : card,
        render(next = {}) {
            state = next; const value = normalizeContextRules(next.settings?.contextRules || next.contextRules);
            card.hidden = false;
            // 只有规则内容真的和界面上不一样时才重建各行；忙闲状态变化只切换可用性，不动节点。
            // 原先每次状态变化（保存开始、保存结束、新值返回）都整块重建，编辑一个标签会连闪三次。
            const signature = JSON.stringify(value);
            if (signature !== last) {
                last = signature;
                const editing = [strip, ...rows.flatMap(item => [item.input, item.mode])].includes(document.activeElement);
                if (document.activeElement !== strip) strip.checked = value.stripComments;
                if (!editing && !saving && !queued && JSON.stringify(read()) !== signature) renderRules(value);
            }
            applyDisabled();
        },
        destroy() { disposed = true; card.remove(); },
    };
}
