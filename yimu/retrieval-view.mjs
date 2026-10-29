import { createYimuIcon } from './icons.mjs';

// The retrieval page is deliberately a review surface, not a second memory store.
// It reports the currently active lexical path and reserves clear slots for the
// vector and rerank stages without pretending that those services are available.
export function mountRetrievalView({ document = globalThis.document } = {}) {
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
    root.append(intro, statusCard, candidatesCard, boundaryCard);

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
        const lexical = rows.get('lexical');
        lexical.detail.textContent = statusText(lexical.badge, retrieval.mode === 'disabled' ? 'off' : 'ready', retrieval.mode === 'disabled' ? '原文回查已关闭' : '当前默认候选路径');
        const vector = rows.get('vector');
        const vectorStatus = retrieval.vector?.status;
        vector.detail.textContent = statusText(vector.badge, vectorStatus === 'ready' ? 'ready' : vectorStatus === 'error' ? 'error' : 'planned', vectorStatus === 'ready' ? '已接入候选发现' : vectorStatus === 'error' ? '不可用，已回退关键词召回' : '后续接入，当前不参与生成');
        const rerank = rows.get('rerank');
        const rerankStatus = retrieval.rerank?.status;
        rerank.detail.textContent = statusText(rerank.badge, rerankStatus === 'ready' ? 'ready' : rerankStatus === 'error' ? 'error' : 'planned', rerankStatus === 'ready' ? '已接入排序' : rerankStatus === 'error' ? '不可用，保留原候选顺序' : '后续接入，当前不改变顺序');

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
