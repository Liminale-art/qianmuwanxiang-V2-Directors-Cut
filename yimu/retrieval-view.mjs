import { createYimuIcon } from './icons.mjs';

// The retrieval page is deliberately a review surface, not a second memory store.
// It exposes optional retrieval enhancements without creating a second memory store.
export function mountRetrievalView({ document = globalThis.document, vectorApi = null, onToggleVector = null, onToggleRerank = null } = {}) {
    if (!document?.createElement) throw new TypeError('忆幕检索页缺少文档容器');
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const root = el('section', 'ym-retrieval-page');
    const intro = el('section', 'ym-card ym-retrieval-intro');
    intro.append(el('h3', '', '向量与重排'), el('p', 'ym-muted', '先看候选从哪里来，再决定是否接入向量与重排。现有记忆注入不会因本页改变。'));

    const vectorCard = el('section', 'ym-card ym-retrieval-vector-card');
    const vectorHeading = el('div', 'ym-retrieval-card-heading');
    const vectorTitle = el('h3', '', '向量候选');
    const vectorToggle = el('input', 'ym-switch'); vectorToggle.type = 'checkbox'; vectorToggle.setAttribute('aria-label', '启用向量候选');
    vectorHeading.append(vectorTitle, vectorToggle);
    const vectorHint = el('p', 'ym-muted', '可选增强。未配置或调用失败时自动沿用关键词召回。');
    const vectorFields = el('div', 'ym-retrieval-vector-fields');
    const makeField = (label, type, key, placeholder) => {
        const input = el('input', 'ym-input'); input.type = type; input.autocomplete = 'off'; input.placeholder = placeholder; input.setAttribute('aria-label', label);
        input.addEventListener('change', async () => {
            if (!vectorApi?.updateVector) return;
            try { await vectorApi.updateVector({ [key]: input.value.trim() }); }
            catch (error) { input.setAttribute('aria-invalid', 'true'); input.title = error.message; }
        });
        return { input, row: (() => { const row = el('label', 'ym-field ym-retrieval-vector-field'); row.append(el('span', '', label), input); return row; })() };
    };
    const vectorUrl = makeField('向量接口地址', 'url', 'apiUrl', 'https://example.com/v1');
    const vectorKey = makeField('向量接口密钥', 'password', 'apiKey', '本地接口可留空');
    const vectorModel = makeField('向量模型', 'text', 'model', '例如 text-embedding-3-small');
    vectorFields.append(vectorUrl.row, vectorKey.row, vectorModel.row);
    vectorCard.append(vectorHeading, vectorHint, vectorFields);
    vectorToggle.addEventListener('change', async () => {
        const enabled = vectorToggle.checked;
        try { await onToggleVector?.(enabled); }
        catch { vectorToggle.checked = !enabled; }
    });

    const rerankCard = el('section', 'ym-card ym-retrieval-vector-card');
    const rerankHeading = el('div', 'ym-retrieval-card-heading');
    const rerankTitle = el('h3', '', '重排候选');
    const rerankToggle = el('input', 'ym-switch'); rerankToggle.type = 'checkbox'; rerankToggle.setAttribute('aria-label', '启用重排候选');
    rerankHeading.append(rerankTitle, rerankToggle);
    const rerankHint = el('p', 'ym-muted', '可选增强。失败时保留当前候选顺序。');
    const rerankFields = el('div', 'ym-retrieval-vector-fields');
    const makeRerankField = (label, type, key, placeholder) => {
        const input = el('input', 'ym-input'); input.type = type; input.autocomplete = 'off'; input.placeholder = placeholder; input.setAttribute('aria-label', label);
        input.addEventListener('change', async () => {
            if (!vectorApi?.updateRerank) return;
            try { await vectorApi.updateRerank({ [key]: type === 'number' ? Math.trunc(Number(input.value)) : input.value.trim() }); }
            catch (error) { input.setAttribute('aria-invalid', 'true'); input.title = error.message; }
        });
        const row = el('label', 'ym-field ym-retrieval-vector-field'); row.append(el('span', '', label), input);
        return { input, row };
    };
    const rerankUrl = makeRerankField('重排接口地址', 'url', 'apiUrl', 'https://example.com/v1');
    const rerankKey = makeRerankField('重排接口密钥', 'password', 'apiKey', '本地接口可留空');
    const rerankModel = makeRerankField('重排模型', 'text', 'model', '例如 bge-reranker-v2-m3');
    const rerankTopN = makeRerankField('保留候选数', 'number', 'topN', '1—64'); rerankTopN.input.min = '1'; rerankTopN.input.max = '64';
    rerankFields.append(rerankUrl.row, rerankKey.row, rerankModel.row, rerankTopN.row);
    rerankCard.append(rerankHeading, rerankHint, rerankFields);
    rerankToggle.addEventListener('change', async () => {
        const enabled = rerankToggle.checked;
        try { await onToggleRerank?.(enabled); }
        catch { rerankToggle.checked = !enabled; }
    });

    const statusCard = el('section', 'ym-card ym-retrieval-status-card');
    statusCard.append(el('h3', '', '检索链路'));
    const rows = new Map();
    for (const [id, title] of [['lexical', '关键词召回'], ['vector', '向量召回'], ['rerank', '重排']]) {
        const row = el('div', 'ym-retrieval-status-row');
        const name = el('span', 'ym-retrieval-status-name', title);
        const badge = el('span', 'ym-retrieval-badge');
        const detail = el('span', 'ym-retrieval-status-detail');
        row.append(name, badge, detail); statusCard.append(row); rows.set(id, { row, badge, detail });
    }

    const candidatesCard = el('section', 'ym-card ym-retrieval-candidates');
    const candidatesTitle = el('h3', '', '最近一次候选');
    const candidatesMeta = el('p', 'ym-muted');
    const candidatesList = el('div', 'ym-retrieval-candidate-list');
    const candidatesEmpty = el('p', 'ym-muted ym-retrieval-empty', '打开一个聊天并开始整理后，这里会显示候选来源。');
    candidatesCard.append(candidatesTitle, candidatesMeta, candidatesList, candidatesEmpty);

    const boundaryCard = el('section', 'ym-card ym-retrieval-boundary');
    const boundaryTitle = el('h3', '', '当前范围');
    const boundaryText = el('p', 'ym-muted');
    boundaryCard.append(boundaryTitle, boundaryText);
    root.append(intro, vectorCard, rerankCard, statusCard, candidatesCard, boundaryCard);

    const statusText = (badge, tone, detailText) => {
        badge.textContent = tone === 'ready' ? '可用' : tone === 'planned' ? '待接入' : tone === 'off' ? '未启用' : '不可用';
        badge.dataset.tone = tone;
        return detailText;
    };
    const sourceText = candidate => {
        const start = Number.isSafeInteger(candidate?.start) ? candidate.start : null;
        const end = Number.isSafeInteger(candidate?.end) ? candidate.end : null;
        return start === null ? '来源范围未知' : `第 ${start}–${end ?? start} 层`;
    };
    function render(state = {}) {
        const retrieval = state.retrieval || {};
        const config = vectorApi?.vectorRead?.() || {};
        const rerankConfig = vectorApi?.rerankRead?.() || {};
        vectorToggle.checked = Boolean(state.document?.settings?.vectorEnabled ?? state.defaults?.values?.vectorEnabled) && Boolean(state.document);
        vectorToggle.disabled = !state.document;
        for (const [input, key] of [[vectorUrl.input, 'apiUrl'], [vectorKey.input, 'apiKey'], [vectorModel.input, 'model']]) {
            if (document.activeElement !== input) input.value = String(config[key] || '');
            input.disabled = !vectorApi?.updateVector;
            input.removeAttribute('aria-invalid');
        }
        rerankToggle.checked = Boolean(state.document?.settings?.rerankEnabled ?? state.defaults?.values?.rerankEnabled) && Boolean(state.document);
        rerankToggle.disabled = !state.document;
        for (const [input, key] of [[rerankUrl.input, 'apiUrl'], [rerankKey.input, 'apiKey'], [rerankModel.input, 'model'], [rerankTopN.input, 'topN']]) {
            if (document.activeElement !== input) input.value = String(rerankConfig[key] ?? '');
            input.disabled = !vectorApi?.updateRerank;
            input.removeAttribute('aria-invalid');
        }
        const lexical = rows.get('lexical');
        lexical.detail.textContent = statusText(lexical.badge, retrieval.mode === 'disabled' ? 'off' : 'ready', retrieval.mode === 'disabled' ? '原文回查已关闭' : '当前默认候选路径');
        const vector = rows.get('vector');
        const vectorStatus = retrieval.vector?.status;
        vector.detail.textContent = statusText(vector.badge, vectorStatus === 'ready' ? 'ready' : vectorStatus === 'error' || vectorStatus === 'unavailable' ? 'error' : vectorStatus === 'disabled' ? 'off' : 'planned', vectorStatus === 'ready' ? '已接入候选发现' : vectorStatus === 'error' || vectorStatus === 'unavailable' ? (retrieval.vector?.reason || '不可用，已回退关键词召回') : vectorStatus === 'disabled' ? '当前聊天未启用' : '等待本轮整理');
        const rerank = rows.get('rerank');
        const rerankStatus = retrieval.rerank?.status;
        rerank.detail.textContent = statusText(rerank.badge,
            rerankStatus === 'ready' ? 'ready' : rerankStatus === 'error' || rerankStatus === 'unavailable' ? 'error' : rerankStatus === 'disabled' ? 'off' : 'planned',
            rerankStatus === 'ready' ? '已接入排序' : rerankStatus === 'error' || rerankStatus === 'unavailable' ? (retrieval.rerank?.reason || '不可用，保留原候选顺序') : rerankStatus === 'disabled' ? '当前聊天未启用' : '等待本轮整理');

        const hasChat = Boolean(state.snapshot?.binding);
        const candidates = Array.isArray(retrieval.candidates) ? retrieval.candidates : [];
        candidatesMeta.textContent = retrieval.lastRun?.fallback
            ? retrieval.lastRun.fallback
            : retrieval.lastRun?.count !== undefined
                ? `本次命中 ${retrieval.lastRun.count} 份候选 · 仅显示来源与范围`
            : hasChat ? '尚未产生候选检索记录' : '尚未打开聊天';
        candidatesList.replaceChildren(...candidates.map(candidate => {
            const item = el('article', 'ym-retrieval-candidate');
            item.append(el('strong', '', candidate.title || '记忆切片'), el('span', 'ym-retrieval-candidate-source', `${candidate.sourceLabel || '忆幕'} · ${sourceText(candidate)}`));
            if (candidate.reason) item.append(el('p', 'ym-muted', candidate.reason));
            return item;
        }));
        candidatesEmpty.hidden = candidates.length > 0;
        boundaryText.textContent = !hasChat ? '请选择一个聊天打开。' : state.document?.enabled ? '当前聊天的候选只来自已核对的同一份记忆，不会跨聊天混用。' : '此聊天尚未启用忆幕，检索仅作预览。';
    }
    return { element: root, render, destroy() { root.remove(); } };
}
