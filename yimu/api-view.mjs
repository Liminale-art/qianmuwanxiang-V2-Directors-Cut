import { createYimuIcon } from './icons.mjs';

/** Companion-style controls; secrets remain in the account API adapter, not view state/backup actions. */
export function mountApiView(container, { api, document = container?.ownerDocument || globalThis.document,
    onError = () => {}, onChange = () => {}, getLegacy = () => ({}), getProfiles = () => [], onLegacyChange, accountOnly = false } = {}) {
    if (!container || !api?.read || !document?.createElement) throw new TypeError('忆幕 API 卡缺少连接接口');
    let disposed = false, busy = false, supplied = null, editingModel = false;
    let scope = '', operation = 0, activeKind = '', statusKind = '';
    const el = (tag, cls = '', value = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = value; return node; };
    const field = (label, node) => { const wrap = el('label', 'ym-field'); wrap.append(el('span', '', label), node); return wrap; };
    const input = (label, type = 'text') => { const node = el('input'); node.type = type; node.setAttribute('aria-label', label); return node; };
    const select = label => { const node = el('select'); node.setAttribute('aria-label', label); return node; };
    const button = (label, glyph, action, onlyIcon = false, kind = 'account') => {
        const node = el('button', `ym-button${onlyIcon ? ' ym-icon-button' : ''}`); node.type = 'button';
        node.setAttribute('aria-label', label); node.setAttribute('title', label);
        if (glyph) node.append(createYimuIcon(glyph, { document }));
        if (!onlyIcon) node.append(el('span', '', label));
        node.addEventListener('click', () => { if (!busy) void run(action, kind); }); return node;
    };
    const options = (node, items, value) => {
        const signature = JSON.stringify(items);
        if (node._ymOptions !== signature) {
            node.replaceChildren(...items.map(([id, label]) => { const option = el('option', '', label); option.value = id; return option; }));
            node._ymOptions = signature;
        }
        node.value = value;
    };
    const legacy = () => supplied?.settings || getLegacy() || {};
    const profiles = () => api.qianmuProfiles?.() || supplied?.profiles || [];
    const card = el('section', 'ym-card ym-api-card');
    const header = el('div', 'ym-api-heading'), title = el('h3', '', 'API设置');
    const stream = input('流式接收整理结果', 'checkbox'); stream.className = 'ym-switch';
    const streamRow = el('label', 'ym-switch-row ym-api-stream'); streamRow.append(el('span', '', '流式'), stream);
    header.append(title, streamRow);
    const mode = select('整理连接方式');
    options(mode, [['st', '跟随SillyTavern当前API'], ['qianmu', '千幕API预设'], ['external', '独立连接']], 'st');
    const current = el('p', 'ym-muted ym-api-current');
    const profileArea = el('div', 'ym-api-profile-area');
    const profile = select('千幕 API 预设'), profileInfo = el('p', 'ym-muted');
    profileArea.append(field('选择预设', profile), profileInfo);
    const external = el('div', 'ym-api-external');
    const presetRow = el('div', 'ym-api-preset-row'), preset = select('忆幕连接预设');
    const remove = button('删除连接预设', 'trash', async () => { await api.deletePreset(preset.value); status.textContent = ''; }, true);
    presetRow.append(preset, remove);
    const url = input('API URL', 'url'); url.placeholder = 'https://example.com/v1'; url.autocomplete = 'off';
    const key = input('API Key', 'password'); key.placeholder = ''; key.autocomplete = 'new-password';
    const model = select('整理模型');
    const manualRow = el('div', 'ym-api-model-row'), manualModel = input('手动填写整理模型');
    const modelSave = button('确认模型', 'check', async () => { await api.update({ model: manualModel.value }); editingModel = false; }, true);
    manualRow.append(manualModel, modelSave); manualRow.hidden = true;
    const params = el('div', 'ym-api-params');
    const temperature = input('整理温度', 'number'); temperature.min = '0'; temperature.max = '2'; temperature.step = '0.05';
    const maxTokens = input('最大输出 Token', 'number'); maxTokens.min = '1'; maxTokens.max = '10000000'; maxTokens.step = '1';
    const contextTokens = input('上下文 Token', 'number'); contextTokens.min = '256'; contextTokens.max = '10000000'; contextTokens.step = '1';
    params.append(field('温度', temperature), field('最大输出', maxTokens), field('上下文', contextTokens));
    const actions = el('div', 'ym-api-actions');
    const test = button('测试连接', 'link', async () => { await api.testConnection(); status.textContent = '连接可用'; });
    const fetch = button('拉取模型', 'refresh', async () => { const list = await api.fetchModels(); status.textContent = list.length ? `已获取 ${list.length} 个模型` : '连接返回的模型列表为空'; });
    const nameRow = el('div', 'ym-api-preset-name'), name = input('连接预设名称'); name.placeholder = '预设名称';
    const saveConfirm = button('确认保存预设', 'check', async () => { await api.savePreset(name.value); nameRow.hidden = true; status.textContent = '预设已保存'; }, true);
    const saveCancel = button('取消保存预设', 'close', () => { nameRow.hidden = true; }, true);
    nameRow.append(name, saveConfirm, saveCancel); nameRow.hidden = true;
    const save = button('保存预设', 'save', () => { nameRow.hidden = false; name.value = api.read().model || ''; name.focus(); });
    actions.append(test, fetch, save);
    const status = el('p', 'ym-muted ym-api-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    external.append(presetRow, field('API URL', url), field('API Key', key), field('模型', model), manualRow, params, actions, nameRow);
    card.append(header, field('连接', mode), current, profileArea, external, status); container.append(card);
    const editable = [mode, profile, stream, preset, url, key, model, manualModel, temperature, maxTokens, contextTokens, name];
    const buttons = [remove, modelSave, test, fetch, save, saveConfirm, saveCancel];
    async function run(action, kind = 'account') {
        if (disposed || busy) return;
        const ticket = ++operation, startedScope = scope;
        const current = () => !disposed && ticket === operation && (kind !== 'legacy' || scope === startedScope);
        activeKind = kind; statusKind = kind; busy = true; status.textContent = ''; render();
        try { await action(); if (current()) onChange(); }
        catch (error) { if (current()) { status.textContent = error?.message || '连接设置未完成'; onError(error); } }
        finally { if (current()) { busy = false; activeKind = ''; render(); } }
    }
    function change(node, action, kind = 'account') { node.addEventListener('change', () => {
        const value = node.type === 'checkbox' ? node.checked : node.value;
        if (!busy) void run(() => action(value), kind);
    }); }
    mode.addEventListener('change', () => {
        const value = mode.value;
        if (!busy) void run(() => api.update({ mode: value }));
    });
    change(profile, value => api.update({ mode: 'qianmu', qianmuPresetId: value }));
    change(preset, async value => { if (value) { await api.loadPreset(value); editingModel = false; } });
    change(model, async value => {
        if (value === '__manual__') { editingModel = true; manualModel.value = api.read().model; render(); manualModel.focus(); }
        else await api.update({ model: value });
    });
    for (const [node, setting] of [[url, 'apiUrl'], [key, 'apiKey']]) change(node, value => api.update({ [setting]: value }));
    for (const [node, setting] of [[temperature, 'temperature'], [maxTokens, 'maxTokens'], [contextTokens, 'contextTokens']]) change(node, value => api.update({
        [setting]: String(value).trim() === '' ? { temperature: 1, maxTokens: 32000, contextTokens: 1000000 }[setting] : Number(value),
    }));
    change(stream, value => api.update({ stream: value }));
    function render(state) {
        if (disposed) return;
        if (state) supplied = state;
        const nextScope = supplied?.scope ?? JSON.stringify([supplied?.snapshot?.binding || null, supplied?.isGlobal === true]);
        const scopeChanged = nextScope !== scope;
        if (scopeChanged) {
            scope = nextScope;
            if (activeKind === 'legacy') { operation++; busy = false; activeKind = ''; }
            if (statusKind === 'legacy') { status.textContent = ''; statusKind = ''; }
        }
        const config = api.read(), old = legacy();
        // Preserve a historic explicit ST profile without presenting it as one of the new choices.
        const historicProfile = config.mode === 'profile' || config.mode === 'inherit' && old.profileId;
        const shownMode = config.mode === 'inherit' ? historicProfile ? '' : 'st' : config.mode === 'profile' ? '' : config.mode;
        mode.value = shownMode; external.hidden = shownMode !== 'external'; profileArea.hidden = shownMode !== 'qianmu';
        current.hidden = shownMode !== 'st' && !historicProfile; streamRow.hidden = shownMode !== 'external';
        current.textContent = historicProfile ? '旧版 ST 连接已保留；选择新的连接方式后才会切换。' : '沿用酒馆当前的连接与模型';
        const list = profiles();
        const items = [['', '选择千幕 API 预设'], ...list.map(item => [item.id, item.name || item.model || item.id])];
        const selectedProfile = list.find(item => item.id === config.qianmuPresetId);
        if (config.qianmuPresetId && !selectedProfile) items.push([config.qianmuPresetId, '原千幕预设（当前不可用）']);
        options(profile, items, config.qianmuPresetId);
        profileInfo.textContent = selectedProfile ? `模型：${selectedProfile.model || '尚未设置'} · 预设在千幕 API 设置中管理` : list.length ? '请选择已有的千幕 API 预设' : '尚无千幕 API 预设，请先在千幕中保存';
        options(preset, [['', '载入预设'], ...config.presets.map(item => [item.id, item.name])], config.selectedPreset);
        const models = config.models.includes(config.model) || !config.model ? config.models : [config.model, ...config.models];
        options(model, [['', models.length ? '选择模型' : '先拉取模型列表'], ...models.map(value => [value, value]), ['__manual__', '手动填写模型']], editingModel ? '__manual__' : config.model);
        manualRow.hidden = !editingModel;
        for (const [node, value] of [[url, config.apiUrl], [key, config.apiKey], [temperature, config.temperature], [maxTokens, config.maxTokens], [contextTokens, config.contextTokens]]) {
            if (document.activeElement !== node) node.value = String(value);
        }
        stream.checked = config.stream;
        for (const node of [...editable, ...buttons]) node.disabled = busy;
        remove.disabled ||= !config.selectedPreset;
        test.disabled ||= !config.apiUrl.trim(); fetch.disabled ||= !config.apiUrl.trim();
        status.hidden = !status.textContent;
    }
    const unsubscribe = api.subscribe(() => render()); render();
    return { render, destroy() { if (disposed) return; disposed = true; operation++; unsubscribe(); card.remove(); } };
}
