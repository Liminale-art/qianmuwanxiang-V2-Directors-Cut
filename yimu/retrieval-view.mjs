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
    const input = (label, type = 'text') => {
        const node = el('input'); node.type = type; node.setAttribute('aria-label', label); node.autocomplete = 'off';
        return node;
    };
    const field = (label, node) => {
        const row = el('label', 'ym-field'); row.append(el('span', '', label), node); return row;
    };
    const runButton = (label, glyph, action, iconOnly = false) => {
        const node = el('button', `ym-button${iconOnly ? ' ym-icon-button' : ''}`); node.type = 'button';
        node.setAttribute('aria-label', label); node.title = label;
        if (glyph) node.append(createYimuIcon(glyph, { document }));
        if (!iconOnly) node.append(el('span', '', label));
        node.addEventListener('click', () => { void action(); });
        return node;
    };
    const options = (node, items, value) => {
        const signature = JSON.stringify(items);
        if (node._ymOptions !== signature) {
            node.replaceChildren(...items.map(([id, label]) => { const option = el('option', '', label); option.value = id; return option; }));
            node._ymOptions = signature;
        }
        node.value = value;
    };
    const root = el('section', 'ym-retrieval-page');

    const statusCard = el('section', 'ym-card ym-retrieval-status-card');
    statusCard.append(el('h3', '', '检查链路'));
    const rows = new Map();
    for (const [id, title] of [['lexical', '关键词召回'], ['vector', '向量召回'], ['rerank', '重排']]) {
        const row = el('div', 'ym-retrieval-status-row');
        const name = el('span', 'ym-retrieval-status-name', title);
        const badge = el('span', 'ym-retrieval-badge');
        const detail = el('span', 'ym-retrieval-status-detail');
        row.append(name, badge, detail); statusCard.append(row); rows.set(id, { row, badge, detail });
    }

    const timeoutCard = el('section', 'ym-card ym-retrieval-vector-card ym-retrieval-timeout-card');
    const timeoutHeading = el('div', 'ym-retrieval-card-heading');
    timeoutHeading.append(el('h3', '', '候选请求超时'));
    const timeoutInput = input('候选请求超时（秒）', 'number');
    timeoutInput.min = '5'; timeoutInput.max = '60'; timeoutInput.step = '1';
    const timeoutRow = el('label', 'ym-retrieval-timeout-field');
    timeoutRow.append(timeoutInput, el('span', 'ym-retrieval-unit', '秒'));
    timeoutInput.addEventListener('change', async () => {
        if (!vectorApi?.updateRetrievalTimeout) return;
        const value = timeoutInput.value.trim();
        try { await vectorApi.updateRetrievalTimeout(value === '' ? '' : Math.trunc(Number(value))); timeoutInput.removeAttribute('aria-invalid'); }
        catch (error) { timeoutInput.setAttribute('aria-invalid', 'true'); timeoutInput.title = error.message; }
    });
    timeoutHeading.append(timeoutRow);
    timeoutCard.append(timeoutHeading);

    const providerCard = ({ kind, title, toggleLabel, read, update, savePreset, loadPreset, deletePreset, testConnection, fetchModels }) => {
        const card = el('section', 'ym-card ym-retrieval-vector-card ym-retrieval-provider');
        const heading = el('div', 'ym-retrieval-card-heading');
        const cardTitle = el('h3', '', title);
        const toggle = input(toggleLabel, 'checkbox'); toggle.className = 'ym-switch';
        heading.append(cardTitle, toggle);

        const preset = document.createElement('select'); preset.setAttribute('aria-label', `${title}预设`);
        const removePreset = runButton(`删除${title}预设`, 'trash', async () => {
            if (!preset.value || !deletePreset) return;
            try { await deletePreset(preset.value); status.textContent = '预设已删除'; status.hidden = false; }
            catch (error) { status.textContent = error?.message || '预设未删除'; status.hidden = false; }
        }, true);
        const presetRow = el('div', 'ym-api-preset-row'); presetRow.append(preset, removePreset);

        const url = input('API URL', 'url');
        url.placeholder = kind === 'vector' ? 'https://api.siliconflow.cn/v1/embeddings' : 'https://api.siliconflow.cn/v1/rerank';
        const key = input('API Key', 'password'); key.autocomplete = 'new-password';
        key.placeholder = '输入 API Key';
        const keyVisibility = runButton('显示 API Key', 'eye', () => {
            const visible = key.type === 'password';
            key.type = visible ? 'text' : 'password';
            keyVisibility.setAttribute('aria-label', visible ? '隐藏 API Key' : '显示 API Key');
            keyVisibility.title = keyVisibility.getAttribute('aria-label');
        }, true);
        const keyControl = el('div', 'ym-password-control');
        keyControl.append(key, keyVisibility);
        const model = input('模型');
        const topN = kind === 'rerank' ? input('保留候选数', 'number') : null;
        if (topN) { topN.min = '1'; topN.max = '64'; topN.step = '1'; }
        const fields = el('div', 'ym-retrieval-provider-fields');
        fields.append(field('API URL', url), field('API Key', keyControl), field('模型', model));
        if (topN) fields.append(field('保留候选数', topN));

        const actions = el('div', 'ym-api-actions');
        let saveNameRow = null, saveName = null;
        const save = runButton('保存预设', 'save', () => {
            if (!saveNameRow) return;
            const config = read?.() || {};
            saveName.value = config.model || '';
            saveNameRow.hidden = false; saveName.focus();
        });
        const test = runButton('测试连接', 'link', async () => {
            if (!testConnection) return;
            try { await testConnection(); status.textContent = '连接可用'; status.hidden = false; }
            catch (error) { status.textContent = error?.message || '连接不可用'; status.hidden = false; }
        });
        const fetch = runButton('拉取模型', 'refresh', async () => {
            if (!fetchModels) return;
            try {
                const models = await fetchModels();
                status.textContent = Array.isArray(models) && models.length ? `已获取 ${models.length} 个模型` : '未获取到模型';
                status.hidden = false;
            } catch (error) { status.textContent = error?.message || '模型列表获取失败'; status.hidden = false; }
        });
        actions.append(test, fetch, save);
        const status = el('p', 'ym-muted ym-retrieval-provider-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.hidden = true;
        saveName = input(`${title}预设名称`);
        const saveConfirm = runButton('确认保存预设', 'check', async () => {
            try { await savePreset?.(saveName.value); saveNameRow.hidden = true; status.textContent = '预设已保存'; status.hidden = false; }
            catch (error) { status.textContent = error?.message || '预设未保存'; status.hidden = false; }
        }, true);
        const saveCancel = runButton('取消保存预设', 'close', () => { saveNameRow.hidden = true; }, true);
        saveNameRow = el('div', 'ym-api-preset-name'); saveNameRow.append(saveName, saveConfirm, saveCancel); saveNameRow.hidden = true;

        const updateField = async (node, keyName) => {
            if (!update) return;
            try { await update({ [keyName]: node.type === 'number' ? Math.trunc(Number(node.value)) : node.value.trim() }); node.removeAttribute('aria-invalid'); }
            catch (error) { node.setAttribute('aria-invalid', 'true'); node.title = error.message; }
        };
        for (const [node, keyName] of [[url, 'apiUrl'], [key, 'apiKey'], [model, 'model'], ...(topN ? [[topN, 'topN']] : [])]) {
            node.addEventListener('change', () => { void updateField(node, keyName); });
        }
        preset.addEventListener('change', () => {
            if (!preset.value || !loadPreset) return;
            void loadPreset(preset.value).catch(error => { status.textContent = error?.message || '预设未载入'; status.hidden = false; });
        });

        card.append(heading, presetRow, fields, actions, saveNameRow, status);
        return {
            card, toggle,
            render(config = {}) {
                const list = Array.isArray(config.presets) ? [['', '载入预设'], ...config.presets.map(item => [item.id, item.name])] : [['', '载入预设']];
                options(preset, list, config.selectedPreset || '');
                for (const [node, value] of [[url, config.apiUrl], [key, config.apiKey], [model, config.model], ...(topN ? [[topN, config.topN]] : [])]) {
                    if (document.activeElement !== node) node.value = value === undefined ? '' : String(value);
                    node.disabled = !update;
                    node.removeAttribute('aria-invalid');
                }
                preset.disabled = !loadPreset; removePreset.disabled = !deletePreset || !config.selectedPreset;
                test.disabled = !testConnection; fetch.disabled = !fetchModels;
                save.disabled = !savePreset;
                saveName.disabled = !savePreset; saveConfirm.disabled = !savePreset; saveCancel.disabled = !savePreset;
            },
        };
    };

    const vector = providerCard({ kind: 'vector', title: '向量检索', toggleLabel: '启用向量检索',
        read: () => vectorApi?.vectorRead?.() || {}, update: vectorApi?.updateVector, savePreset: vectorApi?.saveVectorPreset,
        loadPreset: vectorApi?.loadVectorPreset, deletePreset: vectorApi?.deleteVectorPreset,
        testConnection: vectorApi?.testVectorConnection, fetchModels: vectorApi?.fetchVectorModels });
    const rerank = providerCard({ kind: 'rerank', title: 'Rerank', toggleLabel: '启用重排',
        read: () => vectorApi?.rerankRead?.() || {}, update: vectorApi?.updateRerank, savePreset: vectorApi?.saveRerankPreset,
        loadPreset: vectorApi?.loadRerankPreset, deletePreset: vectorApi?.deleteRerankPreset,
        testConnection: vectorApi?.testRerankConnection, fetchModels: vectorApi?.fetchRerankModels });
    vector.toggle.addEventListener('change', async () => {
        const enabled = vector.toggle.checked;
        try { await onToggleVector?.(enabled); } catch { vector.toggle.checked = !enabled; }
    });
    rerank.toggle.addEventListener('change', async () => {
        const enabled = rerank.toggle.checked;
        try { await onToggleRerank?.(enabled); } catch { rerank.toggle.checked = !enabled; }
    });

    const candidatesCard = el('section', 'ym-card ym-retrieval-candidates');
    const candidatesTitle = el('h3', '', '最近一次候选');
    const candidatesList = el('div', 'ym-retrieval-candidate-list');
    const candidatesEmpty = el('p', 'ym-retrieval-empty', '暂无候选记录');
    candidatesCard.append(candidatesTitle, candidatesList, candidatesEmpty);
    root.append(statusCard, vector.card, rerank.card, timeoutCard, candidatesCard);

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
        const timeoutConfig = vectorApi?.retrievalTimeoutRead?.() || { seconds: 15 };
        if (document.activeElement !== timeoutInput) timeoutInput.value = String(timeoutConfig.seconds ?? 15);
        timeoutInput.disabled = !vectorApi?.updateRetrievalTimeout;
        timeoutInput.removeAttribute('aria-invalid');
        vector.render(vectorApi?.vectorRead?.() || {});
        rerank.render(vectorApi?.rerankRead?.() || {});
        vector.toggle.checked = Boolean(state.document?.settings?.vectorEnabled ?? state.defaults?.values?.vectorEnabled) && Boolean(state.document);
        vector.toggle.disabled = !state.document;
        rerank.toggle.checked = Boolean(state.document?.settings?.rerankEnabled ?? state.defaults?.values?.rerankEnabled) && Boolean(state.document);
        rerank.toggle.disabled = !state.document;

        const lexical = rows.get('lexical');
        lexical.detail.textContent = statusText(lexical.badge, retrieval.mode === 'disabled' ? 'off' : 'ready', retrieval.mode === 'disabled' ? '原文回查已关闭' : '当前默认候选路径');
        const vectorRow = rows.get('vector');
        const vectorStatus = retrieval.vector?.status;
        vectorRow.detail.textContent = statusText(vectorRow.badge, vectorStatus === 'ready' ? 'ready' : vectorStatus === 'error' || vectorStatus === 'unavailable' ? 'error' : vectorStatus === 'disabled' ? 'off' : 'planned', vectorStatus === 'ready' ? '已接入候选发现' : vectorStatus === 'error' || vectorStatus === 'unavailable' ? (retrieval.vector?.reason || '不可用，已回退关键词召回') : vectorStatus === 'disabled' ? '当前聊天未启用' : '等待本轮整理');
        const rerankRow = rows.get('rerank');
        const rerankStatus = retrieval.rerank?.status;
        rerankRow.detail.textContent = statusText(rerankRow.badge,
            rerankStatus === 'ready' ? 'ready' : rerankStatus === 'error' || rerankStatus === 'unavailable' ? 'error' : rerankStatus === 'disabled' ? 'off' : 'planned',
            rerankStatus === 'ready' ? '已接入排序' : rerankStatus === 'error' || rerankStatus === 'unavailable' ? (retrieval.rerank?.reason || '不可用，保留原候选顺序') : rerankStatus === 'disabled' ? '当前聊天未启用' : '等待本轮整理');

        const candidates = Array.isArray(retrieval.candidates) ? retrieval.candidates : [];
        candidatesList.replaceChildren(...candidates.map(candidate => {
            const item = el('article', 'ym-retrieval-candidate');
            item.append(el('strong', '', candidate.title || '记忆切片'), el('span', 'ym-retrieval-candidate-source', `${candidate.sourceLabel || '忆幕'} · ${sourceText(candidate)}`));
            return item;
        }));
        candidatesEmpty.hidden = candidates.length > 0;
    }
    return { element: root, render, destroy() { root.remove(); } };
}
