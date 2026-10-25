// Inline continuation controls. Source prose never becomes HTML or a default inheritance choice.
export function createStoryView({ document = globalThis.document, onAction } = {}) {
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
    const node = el('details', 'ym-card ym-story'); node.append(el('summary', '', '故事续接与分支'));
    const body = el('div', 'ym-story-body');
    const source = el('p', 'ym-muted');
    const modes = el('select'); modes.setAttribute('aria-label', '故事延续方式');
    modes.append(option('continue', '从当前聊天末尾续接'), option('branch', '从指定楼层建立分支')); modes.value = 'continue';
    const cutoff = el('input'); cutoff.type = 'number'; cutoff.min = '1'; cutoff.step = '1';
    cutoff.setAttribute('aria-label', '故事分支截止楼层');
    const cutoffField = field('截止楼层', cutoff); cutoffField.hidden = true;
    const fields = el('div', 'ym-two-columns'); fields.append(field('延续方式', modes), cutoffField);
    const explanation = el('p', 'ym-muted');
    const prepare = button('核对继承范围', () => invoke('storyPlan', { mode: modes.value, ...(modes.value === 'branch' ? { cutoff: Number(cutoff.value) } : {}) }));
    const planBody = el('div', 'ym-story-plan'); planBody.hidden = true;
    const summary = el('p'), boundaries = el('div', 'ym-story-boundaries'), manual = el('div', 'ym-story-choices');
    const permission = el('p', 'ym-muted', '确认后将建立新聊天并为它开启忆幕。原聊天和原记忆保持不变，此后各自发展。');
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
    body.append(source, fields, explanation, prepare, planBody, resultBody, notice); node.append(body);
    let state = {}, scope = '', planKey = '', localError = '', working = false, alive = true, revision = 0;
    const choices = new Map();
    const count = () => state.snapshot?.messages?.length || 0;
    const selectedCutoff = () => modes.value === 'continue' ? count() : Number(cutoff.value);
    const planMatches = () => state.story?.plan && state.story.plan.mode === modes.value && state.story.plan.cutoff === selectedCutoff()
        && JSON.stringify(state.story.plan.sourceBinding) === JSON.stringify(state.snapshot?.binding);
    const matchingPlan = () => planMatches() ? state.story.plan : null;
    function collectChoices() {
        if (!matchingPlan()) { localError = '范围已改变，请重新核对继承范围。'; update(); return null; }
        const selected = [];
        for (const item of state.story.plan.manualChoices || []) {
            const choice = choices.get(item.id);
            if (!choice?.select.value) { localError = '请逐项确认人工记忆是否继承。'; update(); return null; }
            if (choice.select.value === 'skip') continue;
            const text = choice.input.value.trim();
            if (!text) { localError = '请填写明确属于截止位置之前的内容，或选择不继承此条。'; update(); return null; }
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
        summary.textContent = `截至第 ${plan.cutoff} 层，带入最近 ${plan.bridgeCount} 层原文和 ${plan.inheritedCount} 份有效记忆。`;
        if (planKey === key) return;
        planKey = key; choices.clear(); boundaries.replaceChildren(); manual.replaceChildren();
        if (plan.unrepresentedFloorCount > 0) boundaries.append(el('p', 'ym-inline-warning',
            `另有 ${plan.unrepresentedFloorCount} 层更早原文不在本次有效继承范围内，不会复制到新聊天。如需带入，请先在原聊天核对整理范围和条目状态。`));
        if (plan.skippedExcerptCount > 0) boundaries.append(el('p', 'ym-muted', '原文引证仍保留在源聊天；本次继承细摘要、阶段摘要和明确确认的人工内容。'));
        if (plan.boundaries?.length) {
            boundaries.append(el('p', 'ym-muted', '以下边界只读取截止前的原文重新整理，完成后再建立新聊天；不会让模型删减含后续剧情的旧摘要。'));
            for (const part of plan.boundaries) boundaries.append(el('p', '', `第 ${part.source.start}–${part.source.end} 层待补充整理`));
            boundaries.append(el('p', 'ym-muted', '确认建立时使用当前忆幕整理连接，可能产生模型费用。'));
        }
        for (const item of plan.manualChoices || []) {
            const card = el('section', 'ym-story-choice');
            const crossing = item.reason === 'crossing-edited';
            card.append(el('h4', '', crossing ? `跨截止位置的手动修订${item.sourceLabel ? ` · ${item.sourceLabel}` : ''}` : '没有楼层定位的手动补充'));
            if (!crossing && item.text) card.append(el('p', 'ym-memory-text', item.text));
            card.append(el('p', 'ym-muted', crossing ? '旧修订可能包含后续剧情。若需继承，请自行填写截止位置之前的有效内容；原修订不会改变。' : '请确认此内容是否已经适用于所选位置，不自动继承。'));
            const select = el('select'); select.setAttribute('aria-label', `人工记忆取舍 ${item.id}`);
            select.append(option('', '请选择'), option('skip', '不继承此条'), option('include', crossing ? '填写截止前的内容' : '确认并继承此条')); select.value = '';
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
        source.textContent = `来源：${state.snapshot?.name || '当前角色'} · ${state.snapshot?.binding?.file || ''}`;
        const recent = state.document?.settings?.recent ?? state.defaults?.values?.recent ?? 5;
        explanation.textContent = `衔接原文沿用近期原文设置：${recent} 层，仅截至所选位置。`;
        cutoffField.hidden = modes.value !== 'branch'; cutoff.max = String(count());
        renderPlan();
        const result = story.result, receipt = result?.receipt || story.receipt;
        const complete = receipt?.status === 'complete';
        const pending = !complete && !!(story.pending || story.operation || story.operationId);
        modes.disabled = cutoff.disabled = !!busy || pending;
        prepare.disabled = !available || !!busy || !!state.busy || pending;
        for (const choice of choices.values()) choice.select.disabled = choice.input.disabled = !!busy || pending || complete;
        resultBody.hidden = !complete && !pending;
        resultText.textContent = complete ? `已建立：${receipt.target?.file || result?.binding?.file || ''}` : '本次建立的结果尚未确认；继续操作会核对同一次请求，不会另建重复聊天。';
        open.hidden = !complete; open.disabled = !!busy || !available;
        retry.hidden = !pending; retry.disabled = !!busy || !available;
        const unresolved = [...choices.values()].some(choice => !choice.select.value || choice.select.value === 'include' && !choice.input.value.trim());
        create.disabled = !available || !!busy || !!state.busy || !matchingPlan() || unresolved || complete || pending;
        notice.textContent = localError || story.error || story.status || (busy ? '正在核对故事资料…' : ''); notice.hidden = !notice.textContent;
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
                modes.value = state.story?.plan?.mode || 'continue'; cutoff.value = String(state.story?.plan?.cutoff ?? count()); node.open = false;
            }
            update();
        },
        destroy() { alive = false; revision++; node.remove(); choices.clear(); },
    };
}
