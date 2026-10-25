// Inline continuation controls. Source prose never becomes HTML or a default inheritance choice.
export function createStoryView({ document = globalThis.document, onAction, pageMode = false } = {}) {
    const el = (tag, className = '', text) => {
        const node = document.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, action) => {
        const node = el('button', 'ym-button', label); node.type = 'button';
        node.setAttribute('aria-label', label); node.addEventListener('click', action); return node;
    };
    const field = (label, input) => {
        const node = el('label', 'ym-field'); node.append(el('span', '', label), input); return node;
    };
    const option = (value, text) => { const node = el('option', '', text); node.value = value; return node; };
    const node = el(pageMode ? 'section' : 'details', `ym-story ${pageMode ? 'ym-subpage-section' : 'ym-card'}`);
    if (!pageMode) node.append(el('summary', '', '故事续接与分支'));
    const body = el('div', 'ym-story-body');
    const modes = el('select'); modes.setAttribute('aria-label', '故事延续方式');
    modes.append(option('continue', '从当前聊天末尾续接'), option('branch', '从指定楼层建立分支')); modes.value = 'continue';
    const cutoff = el('input'); cutoff.type = 'number'; cutoff.min = '1'; cutoff.step = '1';
    cutoff.setAttribute('aria-label', '故事分支截止楼层');
    const cutoffField = field('截止楼层', cutoff); cutoffField.hidden = true;
    const fields = el('div', 'ym-two-columns'); fields.append(field('延续方式', modes), cutoffField);
    const prepare = button('预览带入内容', () => invoke('storyPlan', { mode: modes.value, ...(modes.value === 'branch' ? { cutoff: Number(cutoff.value) } : {}) }));
    const planBody = el('div', 'ym-story-plan'); planBody.hidden = true;
    const summary = el('p'), boundaries = el('div', 'ym-story-boundaries'), manual = el('div', 'ym-story-choices');
    const permission = el('p', 'ym-muted', '新聊天独立发展，原聊天保持不变。');
    const create = button('确认建立新聊天', () => {
        const choices = collectChoices();
        if (choices) void invoke('storyCreate', { manualChoices: choices });
    }); create.className += ' ym-primary';
    planBody.append(summary, boundaries, manual, permission, create);
    const resultBody = el('div', 'ym-story-result'), resultText = el('p');
    const open = button('打开已建立的聊天', () => invoke('storyOpen'));
    const retry = button('继续本次建立', () => invoke('storyCreate', { retry: true }));
    const resultActions = el('div', 'ym-actions'); resultActions.append(open, retry);
    resultBody.append(resultText, resultActions); resultBody.hidden = true;
    const notice = el('p', 'ym-muted'); notice.setAttribute('aria-live', 'polite'); notice.hidden = true;
    body.append(fields, prepare, planBody, resultBody, notice); node.append(body);
    let state = {}, scope = '', planKey = '', localError = '', working = false, alive = true, revision = 0;
    const choices = new Map();
    const count = () => state.snapshot?.messages?.length || 0;
    const selectedCutoff = () => modes.value === 'continue' ? count() : Number(cutoff.value);
    const planMatches = () => state.story?.plan && state.story.plan.mode === modes.value && state.story.plan.cutoff === selectedCutoff()
        && JSON.stringify(state.story.plan.sourceBinding) === JSON.stringify(state.snapshot?.binding);
    const matchingPlan = () => planMatches() ? state.story.plan : null;
    function collectChoices() {
        if (!matchingPlan()) { localError = '范围已改变，请重新预览带入内容。'; update(); return null; }
        const selected = [];
        for (const item of state.story.plan.manualChoices || []) {
            const choice = choices.get(item.id);
            if (!choice?.select.value) { localError = '请选择要带入的手动记忆。'; update(); return null; }
            if (choice.select.value === 'skip') continue;
            const text = choice.input.value.trim();
            if (!text) { localError = '请填写截止位置之前的内容，或选择不带入此条。'; update(); return null; }
            selected.push({ id: item.id, revision: item.revision, text });
        }
        return selected;
    }
    async function invoke(type, payload = {}) {
        if (!alive || working || state.story?.busy) return;
        if (type === 'storyPlan' && (!Number.isSafeInteger(selectedCutoff()) || selectedCutoff() < 1 || selectedCutoff() > count())) {
            localError = '请选择当前聊天内有效的截止楼层。'; update(); return;
        }
        const ticket = revision; working = true; localError = ''; update();
        try { await onAction?.(type, payload); }
        catch (error) { if (ticket === revision) localError = error?.message || '故事操作未完成。'; }
        finally { if (ticket === revision) { working = false; update(); } }
    }
    function renderPlan() {
        const plan = matchingPlan();
        planBody.hidden = !plan;
        if (!plan) return;
        const key = String(plan.planId);
        summary.textContent = `截至 ${plan.cutoff} 层 · 带入 ${plan.bridgeCount} 层原文、${plan.inheritedCount} 份记忆`;
        if (planKey === key) return;
        planKey = key; choices.clear(); boundaries.replaceChildren(); manual.replaceChildren();
        if (plan.unrepresentedFloorCount > 0) boundaries.append(el('p', 'ym-inline-warning',
            `${plan.unrepresentedFloorCount} 层旧正文尚未整理，不会带入新聊天。`));
        if (plan.skippedExcerptCount > 0) boundaries.append(el('p', 'ym-muted', '原文引证留在原聊天。'));
        if (plan.boundaries?.length) {
            boundaries.append(el('p', 'ym-muted', '以下切片将按截止楼层重新整理：'));
            for (const part of plan.boundaries) boundaries.append(el('p', '', `第 ${part.source.start}–${part.source.end} 层待补充整理`));
            boundaries.append(el('p', 'ym-muted', '建立时需调用模型，可能计费。'));
        }
        for (const item of plan.manualChoices || []) {
            const card = el('section', 'ym-story-choice');
            const crossing = item.reason === 'crossing-edited';
            card.append(el('h4', '', crossing ? `跨越截止位置的修订${item.sourceLabel ? ` · ${item.sourceLabel}` : ''}` : '手动补充'));
            if (!crossing && item.text) card.append(el('p', 'ym-memory-text', item.text));
            card.append(el('p', 'ym-muted', crossing ? '只带入截止前的内容；原修订保留。' : '此条没有楼层范围，请选择是否带入。'));
            const select = el('select'); select.setAttribute('aria-label', `人工记忆取舍 ${item.id}`);
            select.append(option('', '请选择'), option('skip', '不带入此条'), option('include', crossing ? '填写截止前的内容' : '带入此条')); select.value = '';
            const input = el('textarea'); input.rows = 4; input.value = ''; input.hidden = true;
            input.setAttribute('aria-label', `继承的人工内容 ${item.id}`);
            select.addEventListener('change', () => {
                input.hidden = select.value !== 'include';
                if (!crossing && select.value === 'include' && !input.value) input.value = item.text || '';
                localError = ''; update();
            });
            input.addEventListener('input', () => { localError = ''; update(); });
            card.append(select, input); manual.append(card); choices.set(item.id, { select, input });
        }
    }
    function update() {
        const story = state.story || {}, busy = working || story.busy;
        const available = !!state.snapshot && !!state.document && !state.loading && state.sourceAvailable !== false;
        cutoffField.hidden = modes.value !== 'branch'; cutoff.max = String(count());
        renderPlan();
        const result = story.result, receipt = result?.receipt || story.receipt;
        const complete = receipt?.status === 'complete';
        const pending = !complete && !!(story.pending || story.operation || story.operationId);
        modes.disabled = cutoff.disabled = !!busy || pending;
        prepare.disabled = !available || !!busy || !!state.busy || pending;
        for (const choice of choices.values()) choice.select.disabled = choice.input.disabled = !!busy || pending || complete;
        resultBody.hidden = !complete && !pending;
        resultText.textContent = complete ? `已建立：${receipt.target?.file || result?.binding?.file || ''}` : '尚未确认建立结果；继续会核对本次操作，不重复创建聊天。';
        open.hidden = !complete; open.disabled = !!busy || !available;
        retry.hidden = !pending; retry.disabled = !!busy || !available;
        const unresolved = [...choices.values()].some(choice => !choice.select.value || choice.select.value === 'include' && !choice.input.value.trim());
        create.disabled = !available || !!busy || !!state.busy || !matchingPlan() || unresolved || complete || pending;
        notice.textContent = localError || story.error || story.status || (busy ? '正在准备故事…' : ''); notice.hidden = !notice.textContent;
        notice.className = localError || story.error ? 'ym-inline-warning' : 'ym-muted';
        node.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    const changed = () => { localError = ''; update(); };
    modes.addEventListener('change', changed); cutoff.addEventListener('input', changed);
    return {
        node,
        render(next) {
            state = next || {};
            const nextScope = JSON.stringify(state.snapshot?.binding || null);
            if (scope !== nextScope) {
                scope = nextScope; revision++; working = false; planKey = ''; choices.clear(); localError = '';
                modes.value = state.story?.plan?.mode || 'continue'; cutoff.value = String(state.story?.plan?.cutoff ?? count());
                if (!pageMode) node.open = false;
            }
            update();
        },
        destroy() { alive = false; revision++; node.remove(); choices.clear(); },
    };
}
