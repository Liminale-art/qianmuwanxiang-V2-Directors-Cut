// A standalone ST surface. All story/model/user text is rendered as text, never HTML.
import { stageGroups } from './layers.mjs';
import { createStoryView } from './story-view.mjs';
import { mountCompanionView } from './companion-view.mjs';
import { createBackupView } from './backup-view.mjs';
import { planManualRange, summaryCoverage } from './core.mjs';
import { mountTheme } from './theme.mjs';
import { createYimuIcon } from './icons.mjs';
import { mountApiView } from './api-view.mjs';

const SETTINGS = [
    ['recent', '近期原文层数', 'number', 1],
    ['trigger', '自动整理阈值（token）', 'number', 256],
    ['batch', '单次整理上限（token）', 'number', 256],
    ['stageAuto', '自动整理阶段摘要', 'checkbox'],
    ['stageBasis', '阶段整理依据', 'select'],
    ['stageThreshold', '阶段整理阈值', 'number', 1],
    ['recall', '自动回查与补充（试用）', 'checkbox'],
    ['budget', '记忆预算（token，0 为自动）', 'number', 0],
    ['profileId', '整理连接', 'select'],
    ['model', '独立连接的模型（留空沿用连接）', 'text'],
    ['preference', '记忆整理偏好', 'textarea'],
];
const STAGE_BASES = [{ id: 'tokens', name: '记忆切片 token 数' }, { id: 'floors', name: '覆盖的原文楼层数' }, { id: 'slices', name: '记忆切片份数' }];
const STAGE_THRESHOLDS = { tokens: 6000, floors: 100, slices: 12 };
const sourceStart = entry => entry.source?.start ?? entry.source?.ranges?.[0]?.start ?? Infinity;
const memoryText = entry => entry.kind === 'excerpt' ? typeof entry.quoteText === 'string' ? entry.quoteText : '' : entry.text;
const INSTALL_GUIDE = 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/blob/refactor/storyboard-modularization/yimu/README.md#安装与更新';

export function sourceLabel(entry) {
    const prefix = entry?.origin?.binding?.file ? `${entry.origin.binding.file} · ` : '';
    return prefix + localSourceLabel(entry);
}

function localSourceLabel(entry) {
    if (!entry?.source) return '手动补充';
    if (entry.kind === 'excerpt') return `回查补充 · 第 ${entry.source.start} 层`;
    if (entry.kind === 'stage') {
        const ranges = [];
        for (const range of [...(entry.source.ranges || [])].sort((a, b) => a.start - b.start)) {
            const previous = ranges.at(-1);
            if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
            else ranges.push({ start: range.start, end: range.end });
        }
        return `阶段摘要 · 第 ${ranges.map(range => range.start === range.end ? range.start : `${range.start}–${range.end}`).join('、')} 层`;
    }
    return `第 ${entry.source.start}–${entry.source.end} 层`;
}

export function orderedEntries(entries = []) {
    return entries.filter(entry => entry.status !== 'deleted').slice().sort((a, b) =>
        sourceStart(a) - sourceStart(b) || Number(b.kind === 'stage') - Number(a.kind === 'stage'));
}

export function groupMemoryEntries(entries = [], invalidSourceIds = []) {
    const records = orderedEntries(entries).map(entry => entry.status === 'active' && invalidSourceIds.includes(entry.id) ? { ...entry, status: 'invalid' } : entry);
    const byId = new Map(records.map(entry => [entry.id, entry])), assigned = new Set(), children = new Map();
    for (let i = 0; i < records.length; i++) {
        const stage = records[i];
        if (stage.kind !== 'stage' || stage.status !== 'active') continue;
        const parents = stage.source?.parents || [];
        const valid = parents.length > 0 && parents.every(parent => {
            const fine = byId.get(parent.id);
            return fine?.kind === 'summary' && fine.revision === parent.revision && fine.status === 'active' && !fine.edited && !assigned.has(fine.id);
        });
        if (!valid) { records[i] = { ...stage, status: 'invalid' }; continue; }
        const nested = parents.map(parent => byId.get(parent.id)).sort((a, b) => sourceStart(a) - sourceStart(b));
        children.set(stage.id, nested);
        for (const fine of nested) assigned.add(fine.id);
    }
    return records.filter(entry => !assigned.has(entry.id)).map(entry => ({ entry, children: children.get(entry.id) || [] }));
}

export function shortcutStatus(state = {}) {
    const neutral = message => ({ tone: 'neutral', message });
    if (state.service?.status !== 'ok') return neutral(state.service?.status === 'mismatch' ? '服务版本不匹配'
        : state.service?.status === 'error' ? '服务未连接' : '服务尚未就绪');
    const actionError = state.backup?.error || state.story?.error || state.companion?.error;
    if (actionError) return { tone: 'failed', message: `执行失败：${actionError}` };
    if (!state.snapshot || !state.document) return neutral('当前没有适用的单人聊天');
    if (state.loading) return neutral('正在读取记忆');
    if (state.sourceAvailable === false) return neutral('当前聊天来源尚未通过核对');
    if (state.error) return { tone: 'failed', message: `执行失败：${state.error}` };
    if (!state.document.enabled || state.paused) return neutral('此聊天未启用忆幕');
    if (state.document.movedTo) return neutral('此聊天记忆已迁移');
    if (state.invalidSourceIds?.length) return neutral('部分记忆来源已变化');
    if (state.snapshot.mainApi !== 'openai') return neutral('当前连接不适用原文替换');
    return { tone: 'ready', message: state.busy ? '正在处理' : '正常' };
}

export function createView({ onAction, connectionApi, document = globalThis.document } = {}) {
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, action, className = '') => {
        const node = el('button', `ym-button ${className}`.trim(), label);
        node.type = 'button';
        node.setAttribute('aria-label', label);
        node.addEventListener('click', action);
        return node;
    };
    const iconButton = (label, icon, action, className = '') => {
        const node = button(label, action, `ym-icon-button ${className}`.trim());
        node.replaceChildren(createYimuIcon(icon, { document })); node.title = label;
        return node;
    };
    const field = (caption, input) => {
        const label = el('label', 'ym-field');
        label.append(el('span', '', caption), input);
        return label;
    };
    const textarea = (label, value = '') => {
        const node = el('textarea', 'ym-textarea');
        node.setAttribute('aria-label', label);
        node.value = value;
        node.rows = 5;
        return node;
    };
    const appendMemoryText = (container, entry, missingNotice = true) => {
        const text = memoryText(entry);
        if (entry.kind === 'excerpt' && !text.trim()) {
            if (missingNotice) container.append(el('p', 'ym-inline-warning', '原文来源暂不可用，此补充暂不使用。'));
            return;
        }
        if (entry.kind === 'excerpt' && typeof entry.quoteSpeaker === 'string' && entry.quoteSpeaker.trim()) {
            container.append(el('p', 'ym-muted ym-quote-speaker', entry.quoteSpeaker));
        }
        container.append(el('p', 'ym-memory-text', text));
    };

    let state = {}, opened = false, destroyed = false, returnFocus = null;
    let scopeKey = '', scopeGeneration = 0, localError = '', settingsGlobal = false;
    let currentPage = 'overview';
    const pageScroll = new Map(), pageFocus = new Map(), pages = new Map(), navButtons = new Map();
    const pageTitles = { overview: '概览', memory: '记忆', settings: '设置', manual: '手动补充', stage: '阶段整理' };
    const pageParents = { manual: 'memory', stage: 'memory' };
    const edits = new Map(), cards = new Map(), groups = new Map(), settingDrafts = [new Map(), new Map()], settingRevisions = [null, null], thresholdTouched = [false, false];
    const pendingButtons = new Set();
    const dialog = el('dialog', 'ym-dialog');
    dialog.setAttribute('aria-label', '忆幕');
    const shell = el('section', 'ym-shell');
    const header = el('header', 'ym-header');
    const heading = el('div', 'ym-heading');
    const pageTitle = el('h2', '', '忆幕');
    heading.append(el('span', 'ym-logo'), pageTitle);
    const backButton = iconButton('返回', 'back', () => navigate(pageParents[currentPage] || 'overview'), 'ym-back ym-small');
    backButton.hidden = true;
    const closeButton = iconButton('关闭忆幕', 'close', () => close(), 'ym-close');
    const headerActions = el('div', 'ym-actions ym-header-actions');
    headerActions.append(backButton, closeButton);
    header.append(heading, headerActions);
    const nav = el('nav', 'ym-nav'); nav.setAttribute('aria-label', '忆幕页面');
    nav.setAttribute('role', 'tablist');
    for (const name of ['overview', 'memory', 'settings']) {
        const item = button(pageTitles[name], () => navigate(name), 'ym-nav-button');
        item.setAttribute('role', 'tab'); item.id = `ym-tab-${name}`;
        item.setAttribute('aria-controls', `ym-page-${name}`); navButtons.set(name, item); nav.append(item);
    }
    const scroller = el('div', 'ym-scroll');
    const serviceStatus = el('p', 'ym-service ym-muted');
    serviceStatus.setAttribute('aria-label', '忆幕服务状态'); serviceStatus.setAttribute('aria-live', 'polite');
    const status = el('p', 'ym-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const main = el('div', 'ym-content');
    const interfaceCard = el('section', 'ym-card ym-interface-settings');
    const shortcutToggle = el('input', 'ym-switch'); shortcutToggle.type = 'checkbox';
    shortcutToggle.setAttribute('aria-label', '显示输入栏快捷入口');
    const shortcutLabel = el('label', 'ym-switch-row');
    shortcutLabel.append(el('span', '', '显示输入栏快捷入口'), shortcutToggle); interfaceCard.append(shortcutLabel);
    shortcutToggle.addEventListener('change', async () => {
        if (!await dispatch('uiSettings', { showShortcut: shortcutToggle.checked }, shortcutToggle)) {
            shortcutToggle.checked = state.ui?.showShortcut === true;
        }
    });
    const backup = createBackupView({ document, pageMode: true, onAction: (type, payload) => onAction?.(type, payload) });
    for (const name of Object.keys(pageTitles)) {
        const page = el('section', 'ym-page'); page.dataset.page = name; page.id = `ym-page-${name}`;
        page.hidden = name !== currentPage;
        if (navButtons.has(name)) { page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', `ym-tab-${name}`); }
        else page.setAttribute('aria-label', pageTitles[name]);
        pages.set(name, page); main.append(page);
    }
    scroller.append(status, main);
    shell.append(header, nav, scroller);
    dialog.append(shell);
    document.body.append(dialog);
    const theme = mountTheme(dialog, { document });

    const context = el('div', 'ym-context');
    const chatName = el('span', 'ym-chat-name');
    const refresh = iconButton('刷新记忆', 'refresh', () => dispatch('refresh'), 'ym-small');
    const installGuide = el('a', 'ym-install-link ym-small', '安装说明');
    installGuide.setAttribute('href', INSTALL_GUIDE); installGuide.setAttribute('target', '_blank');
    installGuide.setAttribute('rel', 'noopener noreferrer'); installGuide.setAttribute('aria-label', '忆幕安装说明');
    headerActions.insertBefore(refresh, closeButton);
    context.append(chatName);
    const overview = el('section', 'ym-card ym-overview ym-hero');
    const overviewFile = el('p', 'ym-muted ym-overview-file');
    const heroTop = el('div', 'ym-hero-top'), heroText = el('div', 'ym-hero-text');
    const avatar = el('img', 'ym-avatar'); avatar.alt = ''; avatar.hidden = true;
    avatar.addEventListener('error', () => { avatar.hidden = true; });
    const stats = el('div', 'ym-stats'), statValues = [];
    for (const label of ['记忆切片', '已整理层', '待整理层']) {
        const stat = button(label, () => label === '待整理层' ? fillPendingRange() : navigate('memory'), 'ym-stat'), value = el('b', '', '—');
        stat.replaceChildren();
        stat.append(value, el('span', '', label)); statValues.push(value); stats.append(stat);
    }
    chatName.className += ' ym-overview-name';
    heroText.append(context, overviewFile); heroTop.append(heroText, avatar);
    const enableCard = el('div', 'ym-hero-switches');
    const enabled = el('input', 'ym-switch');
    enabled.type = 'checkbox';
    enabled.setAttribute('aria-label', '启用忆幕');
    const enableLabel = el('label', 'ym-switch-row');
    enableLabel.append(el('span', '', '启用忆幕'), enabled);
    const automatic = el('input', 'ym-switch'); automatic.type = 'checkbox';
    automatic.setAttribute('aria-label', '自动总结');
    const automaticLabel = el('label', 'ym-switch-row'); automaticLabel.append(el('span', '', '自动总结'), automatic);
    enableCard.append(enableLabel, automaticLabel);
    const rangeForm = el('form', 'ym-range ym-history-range');
    rangeForm.hidden = true;
    const rangeStart = el('input', 'ym-range-input'), rangeEnd = el('input', 'ym-range-input');
    for (const input of [rangeStart, rangeEnd]) { input.type = 'number'; input.min = '1'; input.required = true; }
    rangeStart.setAttribute('aria-label', '历史开始楼层'); rangeEnd.setAttribute('aria-label', '历史结束楼层');
    const rangeFields = el('div', 'ym-inline-row ym-history-fields'); rangeFields.hidden = true;
    rangeFields.append(rangeStart, el('span', '', '—'), rangeEnd, el('span', '', '层'));
    const rangeHint = el('span', 'ym-history-question');
    const rangeEdit = iconButton('调整历史楼层', 'edit', () => {
        rangeFields.hidden = !rangeFields.hidden; if (!rangeFields.hidden) rangeStart.focus();
    });
    const rangeSubmit = iconButton('确认整理历史', 'check', () => rangeForm.requestSubmit(), 'ym-primary');
    const rangeCancel = iconButton('不整理历史', 'close', () => dispatch('history', {
        range: { start: 1, end: 0, total: state.snapshot?.messages?.length || 0 },
    }, rangeCancel));
    const historyRow = el('div', 'ym-inline-row'); historyRow.append(rangeHint, rangeEdit, rangeSubmit, rangeCancel);
    rangeForm.append(historyRow, rangeFields);
    enabled.addEventListener('change', () => dispatch('enable', { enabled: enabled.checked }, enabled));
    automatic.addEventListener('change', () => dispatch('autoSummary', { value: automatic.checked }, automatic));
    for (const input of [rangeStart, rangeEnd]) input.addEventListener('input', updateRangePreview);
    rangeForm.addEventListener('submit', async event => {
        event.preventDefault();
        const total = state.snapshot?.messages?.length ?? 0;
        const start = Number(rangeStart.value), end = Number(rangeEnd.value);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
            localError = '请填写当前聊天内有效的起止楼层。'; updateStatus(); return;
        }
        updateRangePreview();
        if (await dispatch('history', { range: { start, end, total } }, rangeSubmit)) rangeForm.hidden = true;
    });
    const summarizeRangeForm = el('form', 'ym-manual-range');
    const summarizeStart = el('input', 'ym-range-input'), summarizeEnd = el('input', 'ym-range-input');
    for (const input of [summarizeStart, summarizeEnd]) { input.type = 'number'; input.min = '1'; input.step = '1'; input.required = true; }
    summarizeStart.setAttribute('aria-label', '手动总结开始楼层'); summarizeEnd.setAttribute('aria-label', '手动总结结束楼层');
    const summarizeSubmit = button('开始总结', () => summarizeRangeForm.requestSubmit(), 'ym-primary');
    const summarizeRow = el('div', 'ym-inline-row');
    summarizeRow.append(el('span', '', '手动总结'), summarizeStart, el('span', '', '—'), summarizeEnd, el('span', '', '层'), summarizeSubmit);
    const summarizeNotice = el('p', 'ym-muted'); summarizeNotice.hidden = true; summarizeNotice.setAttribute('role', 'status');
    summarizeRangeForm.append(summarizeRow, summarizeNotice);
    summarizeRangeForm.addEventListener('submit', async event => {
        event.preventDefault();
        const range = { start: Number(summarizeStart.value), end: Number(summarizeEnd.value) };
        try {
            const plan = planManualRange(state.document, state.snapshot?.messages || [], currentSettings(), range);
            if (plan.range.start !== range.start || plan.range.end !== range.end) {
                summarizeStart.value = String(plan.range.start); summarizeEnd.value = String(plan.range.end);
                summarizeNotice.textContent = `已有切片覆盖 ${plan.range.start}–${plan.range.end} 层，已调整范围，请确认后开始。`;
                summarizeNotice.hidden = false; return;
            }
            summarizeNotice.hidden = true;
            await dispatch('summarizeRange', { range, expectedRange: plan.range }, summarizeSubmit);
        } catch (error) { localError = error.message; updateStatus(); }
    });
    for (const input of [summarizeStart, summarizeEnd]) input.addEventListener('input', () => { summarizeNotice.hidden = true; });
    overview.append(heroTop, enableCard, summarizeRangeForm, rangeForm, stats);

    const settings = el('section', 'ym-settings');
    const settingsScope = el('div', 'ym-actions ym-settings-scope');
    const localSettingsButton = button('当前聊天', () => { settingsGlobal = false; updateSettings(); });
    const globalSettingsButton = button('全局默认', () => { settingsGlobal = true; updateSettings(); });
    settingsScope.append(localSettingsButton, globalSettingsButton);
    const settingsForm = el('form', 'ym-settings-form'), controls = new Map();
    const settingGroups = new Map();
    for (const [name, title, keys] of [
        ['basic', '整理方式', ['recent', 'trigger', 'recall', 'preference']],
        ['stage', '阶段摘要', ['stageAuto', 'stageBasis', 'stageThreshold']],
        ['connection', '使用容量', ['profileId', 'model', 'batch', 'budget']],
    ]) {
        const group = el('details', 'ym-card ym-settings-group'); group.open = name === 'basic';
        group.append(el('summary', '', title)); const body = el('div', 'ym-settings-form'); group.append(body);
        settingsForm.append(group); for (const key of keys) settingGroups.set(key, body);
    }
    for (const [key, label, type, min] of SETTINGS) {
        const input = type === 'textarea' ? textarea(label) : el(type === 'select' ? 'select' : 'input');
        input.setAttribute('aria-label', label);
        if (type !== 'textarea' && type !== 'select') input.type = type;
        if (type === 'checkbox') input.className = 'ym-switch';
        if (min !== undefined) { input.min = String(min); input.step = '1'; }
        const readInput = () => {
            const value = type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value;
            const index = Number(settingsGlobal), oldBasis = settingValue('stageBasis') || 'tokens';
            const oldThreshold = Number(settingValue('stageThreshold'));
            const customized = thresholdTouched[index] || (!settingsGlobal && Object.hasOwn(state.document?.settings || {}, 'stageThreshold')) || oldThreshold !== STAGE_THRESHOLDS[oldBasis];
            setDraft(key, value);
            if (key === 'stageThreshold') thresholdTouched[index] = true;
            if (key === 'stageBasis' && value !== oldBasis && !customized) setDraft('stageThreshold', STAGE_THRESHOLDS[value]);
            updateFollow(key);
            if (key === 'stageBasis') updateSettings();
        };
        input.addEventListener('input', readInput);
        // Some mobile selects emit only change.
        if (type === 'select' || type === 'checkbox') input.addEventListener('change', readInput);
        const reset = button('跟随默认', () => {
            if (key === 'stageThreshold') thresholdTouched[0] = false;
            setDraft(key, null); updateSettings();
        }, 'ym-small ym-follow');
        reset.setAttribute('aria-label', `${label}跟随默认`);
        const row = el('div', `ym-setting-row${type === 'checkbox' ? ' ym-setting-boolean' : ''}`);
        row.hidden = Boolean(connectionApi) && ['profileId', 'model'].includes(key);
        const labelNode = field(label, input);
        row.append(labelNode, reset); settingGroups.get(key).append(row);
        controls.set(key, { input, reset, type, min, label: labelNode.children[0] });
    }
    const saveSettings = button('保存设置', () => settingsForm.requestSubmit(), 'ym-primary');
    const cancelSettings = button('取消设置修改', () => {
        const index = Number(settingsGlobal);
        settingDrafts[index].clear(); settingRevisions[index] = null;
        thresholdTouched[index] = false;
        localError = ''; updateSettings(); updateStatus();
    });
    const settingsActions = el('div', 'ym-actions');
    settingsActions.append(saveSettings, cancelSettings); settingsForm.append(settingsActions);
    settingsForm.addEventListener('submit', async event => {
        event.preventDefault();
        const currentGlobal = settingsGlobal, draft = settingDrafts[Number(currentGlobal)];
        const values = Object.fromEntries(draft);
        if (!Object.keys(values).length) return;
        for (const [key, value] of Object.entries(values)) {
            const control = controls.get(key);
            if (control?.type === 'number' && value !== null && (!Number.isSafeInteger(value) || value < control.min)) {
                localError = `请填写不小于 ${control.min} 的整数。`; updateStatus(); control.input.focus(); return;
            }
        }
        if (await dispatch('settings', { global: currentGlobal, values, expectedRevision: settingRevisions[Number(currentGlobal)] }, saveSettings)) {
            // Keep edits typed after the save started.
            for (const [key, value] of Object.entries(values)) if (draft.get(key) === value) draft.delete(key);
            if (!draft.size) { settingRevisions[Number(currentGlobal)] = null; thresholdTouched[Number(currentGlobal)] = false; }
            updateSettings();
        }
    });
    settings.append(settingsScope, settingsForm);
    const apiSection = el('section', 'ym-connection-settings');
    const apiView = connectionApi ? mountApiView(apiSection, { api: connectionApi, document,
        onLegacyChange: values => dispatch('settings', { global: settingsGlobal, values,
            expectedRevision: settingsGlobal ? state.defaults?.revision ?? 0 : state.document?.configRevision ?? 0 }),
    }) : null;
    apiSection.hidden = !connectionApi;

    const controlsRow = el('div', 'ym-actions');
    const summarize = button('整理未覆盖内容', () => dispatch('summarize', {}, summarize), 'ym-primary');
    const retry = button('重试本次整理', () => dispatch('retry', {}, retry));
    const addManual = button('手动补充', () => {
        manualForm.hidden = false; navigate('manual'); manualInput.focus();
    });
    const stageButton = button('整理阶段摘要', () => {
        const eligible = stageEligible();
        if (!eligible.length) return;
        if (stageForm.hidden) { stageStart.value = String(eligible[0].source.start); stageEnd.value = String(eligible.at(-1).source.end); }
        stageForm.hidden = false; navigate('stage'); updateStageRange(); stageStart.focus();
    });
    controlsRow.append(summarize, retry, stageButton, addManual);
    const stageForm = el('form', 'ym-card ym-stage-form'); stageForm.hidden = true;
    const stageStart = el('input'), stageEnd = el('input');
    for (const input of [stageStart, stageEnd]) { input.type = 'number'; input.min = '1'; input.step = '1'; input.required = true; }
    stageStart.setAttribute('aria-label', '阶段摘要开始楼层'); stageEnd.setAttribute('aria-label', '阶段摘要结束楼层');
    const stageFields = el('div', 'ym-two-columns');
    stageFields.append(field('开始楼层', stageStart), field('结束楼层', stageEnd));
    const stageHint = el('p', 'ym-muted');
    const stageSubmit = button('确认整理阶段摘要', () => stageForm.requestSubmit(), 'ym-primary');
    const stageActions = el('div', 'ym-actions');
    stageActions.append(stageSubmit, button('取消阶段整理', () => { stageForm.hidden = true; navigate('memory'); }));
    stageForm.append(stageFields, stageHint, stageActions);
    for (const input of [stageStart, stageEnd]) input.addEventListener('input', updateStageRange);
    stageForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!updateStageRange()) return;
        const start = Number(stageStart.value), end = Number(stageEnd.value);
        if (await dispatch('stage', { start, end }, stageSubmit)) {
            if (stageStart.value === String(start) && stageEnd.value === String(end)) {
                stageForm.hidden = true; if (currentPage === 'stage') navigate('memory');
            }
        }
    });
    const manualForm = el('form', 'ym-card ym-manual-form');
    manualForm.hidden = true;
    const manualInput = textarea('手动补充内容');
    const manualSave = button('保存补充', () => manualForm.requestSubmit(), 'ym-primary');
    manualSave.disabled = true;
    manualInput.addEventListener('input', () => { manualSave.disabled = pendingButtons.has(manualSave) || !manualInput.value.trim(); });
    const manualActions = el('div', 'ym-actions');
    manualActions.append(manualSave, button('取消补充', () => { manualForm.hidden = true; navigate('memory'); }));
    manualForm.append(manualInput, manualActions);
    manualForm.addEventListener('submit', async event => {
        event.preventDefault();
        const text = manualInput.value.trim(); if (!text) return;
        if (await dispatch('manual', { text }, manualSave)) {
            if (manualInput.value.trim() === text) { manualInput.value = ''; manualForm.hidden = true; if (currentPage === 'manual') navigate('memory'); }
            manualSave.disabled = !manualInput.value.trim();
        }
    });
    const list = el('div', 'ym-list');
    const empty = el('p', 'ym-muted', '还没有记忆。可在概览中总结正文，或手动补充。');
    const deleted = el('details', 'ym-card ym-deleted');
    const deletedTitle = el('summary', '', '已删除的记忆'), deletedBody = el('div', 'ym-deleted-body');
    deleted.append(deletedTitle, deletedBody);
    const lastUsed = el('section', 'ym-last-used');
    const usedBody = el('div', 'ym-used-body'); lastUsed.append(usedBody);
    const story = createStoryView({ document, pageMode: true, onAction: (type, payload) => onAction?.(type, payload) });
    const companion = mountCompanionView({ document, el, button, pageMode: true, onAction: (type, payload) => dispatch(type, payload) });
    const routes = el('div', 'ym-tools'), toolCards = new Map();
    const usedMetric = el('span', 'ym-muted ym-used-metric');
    for (const [name, title, icon, body] of [
        ['used', '记忆调阅', 'eye', lastUsed], ['story', '故事续接', 'book', story.node],
        ['companion', '关联伴读', 'link', companion.element], ['backup', '记忆备份', 'download', backup.node],
    ]) {
        const card = el('details', 'ym-card ym-tool-card'); card.dataset.tool = name;
        const summary = el('summary', 'ym-tool-summary'); summary.setAttribute('aria-label', `展开${title}`);
        summary.append(createYimuIcon(icon, { document }), el('strong', '', title));
        if (name === 'used') summary.append(usedMetric);
        summary.append(createYimuIcon('expand', { document }));
        const content = el('div', 'ym-tool-body'); content.append(body); card.append(summary, content);
        toolCards.set(name, card); routes.append(card);
    }
    const toolbar = el('div', 'ym-memory-toolbar');
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索记忆'; search.setAttribute('aria-label', '搜索记忆');
    const filter = el('select'); filter.setAttribute('aria-label', '筛选记忆');
    for (const [value, label] of [['all', '全部记忆'], ['summary', '记忆切片'], ['stage', '阶段摘要'], ['manual', '手动内容'], ['attention', '需要处理']]) {
        const option = el('option', '', label); option.value = value; filter.append(option);
    }
    filter.value = 'all'; toolbar.append(search, filter);
    search.addEventListener('input', applyFilter); filter.addEventListener('change', applyFilter);
    const noMatch = el('p', 'ym-muted', '没有符合条件的记忆。'); noMatch.hidden = true;
    const settingsEmpty = el('p', 'ym-muted', '打开一个角色的聊天后，可调整整理设置。');
    pages.get('overview').append(overview, routes);
    pages.get('memory').append(controlsRow, toolbar, list, empty, noMatch, deleted);
    pages.get('settings').append(interfaceCard, apiSection, settingsEmpty, settings, serviceStatus, installGuide);
    pages.get('manual').append(manualForm); pages.get('stage').append(stageForm);

    function navigate(name) {
        if (!pages.has(name) || name === currentPage) return;
        pageScroll.set(currentPage, scroller.scrollTop || 0);
        pageFocus.set(currentPage, document.activeElement);
        currentPage = name; updateNavigation(); scroller.scrollTop = pageScroll.get(name) || 0;
        const focus = pageFocus.get(name);
        if (focus?.isConnected && !focus.disabled && !focus.closest('[hidden]')) focus.focus();
        else (pageParents[name] ? backButton : navButtons.get(name))?.focus();
    }
    function updateNavigation() {
        for (const [name, page] of pages) page.hidden = name !== currentPage;
        for (const [name, item] of navButtons) {
            const selected = name === (pageParents[currentPage] || currentPage);
            item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
        }
        nav.hidden = Boolean(pageParents[currentPage]); backButton.hidden = !pageParents[currentPage];
        pageTitle.textContent = pageParents[currentPage] ? pageTitles[currentPage] : '忆幕';
    }
    nav.addEventListener('keydown', event => {
        const names = [...navButtons.keys()], index = names.indexOf(currentPage);
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % names.length;
        if (event.key === 'ArrowLeft') next = (index + names.length - 1) % names.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = names.length - 1;
        if (next !== undefined) { event.preventDefault(); navigate(names[next]); navButtons.get(names[next]).focus(); }
    });
    function applyFilter() {
        // A filtered top-level slice may become a stage child after a background update.
        for (const item of cards.values()) item.node.hidden = false;
        const query = search.value.trim().toLocaleLowerCase(), kind = filter.value;
        const matches = entry => (!query || `${sourceLabel(entry)} ${memoryText(entry)}`.toLocaleLowerCase().includes(query))
            && (kind === 'all' || entry.kind === kind || kind === 'manual' && entry.edited
                || kind === 'attention' && (entry.status === 'invalid' || entry.candidate || entry.conflicts?.length));
        let visible = 0;
        for (const group of groupMemoryEntries(state.document?.entries, state.invalidSourceIds)) {
            const item = cards.get(group.entry.id); if (!item) continue;
            const show = matches(group.entry) || group.children.some(matches) || edits.has(group.entry.id) || group.children.some(child => edits.has(child.id));
            item.node.hidden = !show; if (show) visible++;
            const nested = groups.get(group.entry.id);
            if (nested && (query || kind !== 'all') && group.children.some(matches)) nested.node.open = true;
        }
        noMatch.hidden = visible > 0 || cards.size === 0;
    }
    function updateOverview() {
        const doc = state.document, total = state.snapshot?.messages?.length || 0;
        overviewFile.textContent = state.snapshot?.binding?.file || '在 ST 中打开一个角色的聊天，即可开始。';
        overviewFile.title = state.snapshot?.binding?.file || '';
        stats.hidden = !doc;
        const avatarUrl = state.snapshot?.avatarUrl;
        if (avatarUrl && avatar.getAttribute('src') !== avatarUrl) { avatar.setAttribute('src', avatarUrl); avatar.hidden = false; }
        else if (!avatarUrl) { avatar.removeAttribute('src'); avatar.hidden = true; }
        const coverage = doc && state.sourceAvailable !== false ? currentCoverage() : null;
        statValues[0].textContent = coverage ? String(coverage.sliceCount) : '—';
        statValues[1].textContent = coverage ? String(coverage.organizedFloors) : '—';
        statValues[2].textContent = coverage ? String(coverage.pendingFloors) : '—';
        for (const stat of stats.children) stat.disabled = !doc || state.sourceAvailable === false;
        for (const [name, card] of toolCards) card.hidden = name !== 'backup' && !doc;
    }
    function currentSettings() { return { ...(state.defaults?.values || {}), ...(state.document?.settings || {}) }; }
    function currentCoverage() {
        const doc = state.document;
        return summaryCoverage({ ...doc, entries: (doc?.entries || []).map(entry => state.invalidSourceIds?.includes(entry.id)
            && entry.status === 'active' ? { ...entry, status: 'invalid' } : entry) }, state.snapshot?.messages || [], currentSettings());
    }
    function fillPendingRange() {
        if (!state.document) return;
        const pending = currentCoverage().pendingRange;
        if (!pending) return;
        summarizeStart.value = String(pending.start); summarizeEnd.value = String(pending.end);
        summarizeNotice.hidden = true; summarizeStart.focus();
    }

    async function dispatch(type, payload = {}, sourceButton) {
        if (destroyed || sourceButton?.disabled || pendingButtons.has(sourceButton)) return false;
        const generation = scopeGeneration;
        localError = ''; updateStatus();
        if (sourceButton) { pendingButtons.add(sourceButton); sourceButton.disabled = true; }
        try {
            const result = await onAction?.(type, payload);
            if (destroyed || generation !== scopeGeneration) return false;
            return result !== false;
        } catch (error) {
            if (generation === scopeGeneration) { localError = error?.message || '操作未完成，请重试。'; updateStatus(); }
            return false;
        } finally {
            pendingButtons.delete(sourceButton);
            if (sourceButton?.isConnected && generation === scopeGeneration) sourceButton.disabled = false;
            if (!destroyed) updateControls();
        }
    }

    function updateStatus() {
        const service = state.service || {};
        const version = service.version ? ` · v${service.version}` : service.requiredVersion ? ` · 配套 v${service.requiredVersion}` : '';
        serviceStatus.textContent = service.status === 'ok' ? `服务：正常${service.version ? ` · v${service.version}` : ''}`
            : service.status === 'mismatch' ? `服务：版本不匹配${service.version ? ` · v${service.version}` : ''}${service.requiredVersion ? `（需 v${service.requiredVersion}）` : ''}`
            : service.status === 'error' ? `服务：未连接${version}` : service.status === 'checking' ? '服务：检查中…' : '服务：尚未检测';
        const sourceWarning = state.snapshot && state.document && state.sourceAvailable === false && !state.loading
            ? '当前聊天原件尚未通过核对，记忆暂不参与生成。' : '';
        // The homepage has a dedicated empty state, not an error for normal navigation.
        const error = !state.snapshot && state.error === '请先打开一个角色的聊天' ? '' : state.error;
        const text = localError || error || sourceWarning || state.status || (state.loading ? '正在读取记忆…' : '');
        status.textContent = typeof text === 'string' ? text : String(text?.message || '');
        status.hidden = !status.textContent;
        status.className = `ym-status${localError || state.error ? ' ym-error' : ''}`;
    }
    function updateControls() {
        const available = Boolean(state.document && state.snapshot && !state.loading);
        main.hidden = false;
        enableCard.hidden = !state.document;
        summarizeRangeForm.hidden = !state.document;
        settings.hidden = !state.document;
        settingsEmpty.hidden = Boolean(state.document);
        enabled.disabled = !available;
        enabled.checked = Boolean(state.document?.enabled && !state.paused);
        automatic.checked = state.document?.autoSummary === true;
        automatic.disabled = !available || !enabled.checked;
        const total = state.snapshot?.messages?.length || 0;
        // An empty chat may receive its first messages without changing its identity.
        // Only replace the initial zero, never a range the user has started editing.
        if (total > 0) {
            if (rangeEnd.value === '0') rangeEnd.value = String(total);
            if (summarizeEnd.value === '0') summarizeEnd.value = String(total);
        }
        rangeForm.hidden = !available || !enabled.checked || Boolean(state.document?.initialRange) || !total;
        summarizeStart.max = summarizeEnd.max = rangeStart.max = rangeEnd.max = String(total);
        const canSummarize = available && state.document.enabled && !state.paused && state.sourceAvailable !== false;
        summarizeStart.disabled = summarizeEnd.disabled = !available;
        summarizeSubmit.disabled = !canSummarize || Boolean(state.busy) || !total;
        rangeSubmit.disabled = rangeEdit.disabled = !canSummarize || Boolean(state.busy);
        rangeCancel.disabled = !available || Boolean(state.busy);
        summarize.disabled = !canSummarize || Boolean(state.busy);
        stageButton.disabled = !canSummarize || Boolean(state.busy) || stageEligible().length === 0;
        updateStageRange();
        retry.hidden = !(state.error && state.document?.enabled);
        retry.disabled = !canSummarize || Boolean(state.busy);
        refresh.disabled = Boolean(state.loading);
        addManual.disabled = !available;
        saveSettings.disabled = !available || pendingButtons.has(saveSettings);
        cancelSettings.disabled = pendingButtons.has(saveSettings);
        for (const control of controls.values()) control.input.disabled = !available;
        for (const redo of list.querySelectorAll('[data-ym-redo]')) redo.disabled = !canSummarize || Boolean(state.busy);
        for (const item of pendingButtons) item.disabled = true;
        dialog.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    }
    function updateRangePreview() {
        if (rangeForm.hidden) return;
        rangeHint.replaceChildren(el('span', '', '是否整理历史楼层 '), el('span', 'ym-history-numbers', `${rangeStart.value}–${rangeEnd.value}`));
    }
    function setDraft(key, value) {
        const index = Number(settingsGlobal);
        if (!settingDrafts[index].size) settingRevisions[index] = settingsGlobal ? state.defaults?.revision ?? 0 : state.document?.configRevision ?? 0;
        settingDrafts[index].set(key, value);
    }
    function settingValue(key) {
        const defaults = state.defaults?.values || {}, local = state.document?.settings || {}, draft = settingDrafts[Number(settingsGlobal)];
        const raw = draft.has(key) ? draft.get(key) : settingsGlobal ? defaults[key] : local[key];
        return raw ?? defaults[key] ?? ({ stageAuto: false, stageBasis: 'tokens', stageThreshold: 6000, recall: true }[key]) ?? '';
    }
    function updateFollow(key) {
        const { reset } = controls.get(key);
        const draft = settingDrafts[0];
        const overridden = draft.has(key) ? draft.get(key) !== null : Object.hasOwn(state.document?.settings || {}, key);
        reset.hidden = settingsGlobal || !overridden;
        reset.disabled = !overridden || !state.document || Boolean(state.loading);
        reset.textContent = overridden ? '跟随默认' : '已跟随';
    }
    function updateSettings() {
        localSettingsButton.setAttribute('aria-pressed', String(!settingsGlobal));
        globalSettingsButton.setAttribute('aria-pressed', String(settingsGlobal));
        for (const [key, control] of controls) {
            const value = settingValue(key);
            if (control.type === 'select') {
                const options = key === 'stageBasis' ? [...STAGE_BASES] : [{ id: '', name: '沿用当前 ST 连接' }, ...(state.profiles || [])];
                if (value && !options.some(profile => profile.id === value)) options.push({ id: value, name: '原连接当前不可用' });
                control.input.replaceChildren(...options.map(profile => {
                    const option = el('option', '', profile.name || profile.id); option.value = profile.id; return option;
                }));
            }
            if (control.type === 'checkbox') control.input.checked = Boolean(value);
            else if (document.activeElement !== control.input) control.input.value = String(value);
            if (key === 'stageThreshold') control.label.textContent = `阶段整理阈值（${{ tokens: 'token', floors: '层', slices: '份' }[settingValue('stageBasis')] || 'token'}）`;
            updateFollow(key);
        }
        apiView?.render({ settings: { profileId: settingValue('profileId'), model: settingValue('model') },
            profiles: state.profiles || [], snapshot: state.snapshot, isGlobal: settingsGlobal,
            overrides: state.document?.settings || {} });
    }
    function stageEligible(start = 1, end = Infinity) {
        if (!state.document || !state.snapshot) return [];
        const recent = state.document.settings?.recent ?? state.defaults?.values?.recent ?? 5;
        const entries = state.document.entries.map(entry => entry.status === 'active' && state.invalidSourceIds?.includes(entry.id)
            ? { ...entry, status: 'invalid' } : entry);
        return stageGroups({ ...state.document, entries }, { start, end: Math.min(end, state.snapshot.messages.length - recent) }).flat();
    }
    function updateStageRange() {
        const start = Number(stageStart.value), end = Number(stageEnd.value);
        const bounds = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end;
        const selected = bounds ? stageEligible(start, end) : [];
        const valid = selected.length >= 2 && selected[0].source.start === start && selected.at(-1).source.end === end;
        stageHint.textContent = valid
            ? `将整理 ${selected.length} 份记忆切片；手动修订保持不变。`
            : '选择至少两份连续切片的完整楼层范围。';
        stageSubmit.disabled = !valid || !state.document?.enabled || Boolean(state.paused || state.loading || state.busy) || state.sourceAvailable === false;
        return valid;
    }
    function entryAction(entry, action, extra = {}, sourceButton) {
        return dispatch('entry', { entryId: entry.id, expectedRevision: entry.revision, action, ...extra }, sourceButton);
    }
    function renderCard(entry, existing) {
        const signature = JSON.stringify(entry);
        if (existing?.signature === signature) return existing;
        const card = existing?.node || el('article', 'ym-card ym-memory');
        card.className = `ym-card ym-memory${entry.kind === 'stage' ? ' ym-stage' : ''}`;
        card.dataset.entryId = entry.id;
        const editing = edits.get(entry.id);
        // Replace saved text / conflict choices independently of an active editor.
        // Keeping the editor connected preserves focus, IME and unsaved revisions.
        for (const child of [...card.children]) if (child !== editing?.form && child !== groups.get(entry.id)?.node) child.remove();
        const content = el('div', 'ym-memory-content');
        card.insertBefore(content, card.children[0] || null);
        const top = el('div', 'ym-memory-top');
        top.append(el('h3', '', sourceLabel(entry)));
        if (entry.edited) top.append(el('span', 'ym-muted', '已手动修订'));
        if (entry.status === 'excluded') top.append(el('span', 'ym-muted', '暂不使用'));
        content.append(top);
        if (entry.status === 'invalid') {
            const reason = entry.kind === 'stage' ? '所含切片已变化' : '原文已变化';
            content.append(el('p', 'ym-inline-warning', entry.edited ? `${reason}，人工修订已保留，暂不使用。` : `${reason}，此条记忆暂不使用。`));
        }
        appendMemoryText(content, entry, entry.status !== 'invalid');
        const actions = el('div', 'ym-actions ym-entry-actions');
        const edit = iconButton('编辑', 'edit', () => startEdit(entry, card));
        edit.setAttribute('aria-label', `编辑${sourceLabel(entry)}`);
        edit.disabled = entry.kind === 'excerpt' && !memoryText(entry).trim();
        actions.append(edit);
        if (entry.source && entry.kind !== 'excerpt' && !entry.origin) {
            const redo = iconButton('重新总结', 'refresh', () => dispatch('redo', { entryId: entry.id, expectedRevision: entry.revision }, redo));
            redo.setAttribute('aria-label', `重新总结${sourceLabel(entry)}`);
            redo.dataset.ymRedo = '';
            redo.disabled = Boolean(state.busy) || !state.document?.enabled || Boolean(state.paused) || state.sourceAvailable === false;
            actions.append(redo);
        }
        const remove = iconButton('删除', 'trash', () => entryAction(entry, 'delete', {}, remove));
        remove.setAttribute('aria-label', `删除${sourceLabel(entry)}`); actions.append(remove);
        const more = el('details', 'ym-more'); more.append(el('summary', '', '更多'));
        const moreActions = el('div', 'ym-more-actions');
        const use = button(entry.status === 'excluded' ? '恢复使用' : '暂不使用', () => entryAction(entry, entry.status === 'excluded' ? 'restore' : 'exclude', {}, use));
        moreActions.append(use);
        if (entry.history?.length) {
            const undo = button('撤回上次修改', () => entryAction(entry, 'undo', {}, undo)); moreActions.append(undo);
        }
        if (entry.status === 'invalid' && entry.edited) {
            const keep = button('保留为手动补充', () => entryAction(entry, 'keepManual', {}, keep)); moreActions.append(keep);
        }
        more.append(moreActions); actions.append(more); content.append(actions);
        actions.hidden = Boolean(editing);
        if (entry.candidate) {
            const candidate = el('section', 'ym-candidate');
            candidate.append(el('h4', '', '新版摘要 · 待确认'), el('p', 'ym-memory-text', entry.candidate.text));
            const choice = el('div', 'ym-actions');
            const accept = button('采用候选', () => entryAction(entry, 'acceptCandidate', {}, accept));
            const reject = button('保留原修订', () => entryAction(entry, 'discardCandidate', {}, reject));
            choice.append(accept, reject); candidate.append(choice); content.append(candidate);
        }
        for (const conflict of entry.conflicts || []) {
            const candidate = el('section', 'ym-candidate');
            candidate.append(el('h4', '', '另一份待确认修改'), el('p', 'ym-memory-text', conflict.text));
            const choice = el('div', 'ym-actions');
            const accept = button('采用此版本', () => entryAction(entry, 'acceptConflict', { conflictId: conflict.id }, accept));
            const reject = button('保留已保存版本', () => entryAction(entry, 'discardConflict', { conflictId: conflict.id }, reject));
            choice.append(accept, reject); candidate.append(choice); content.append(candidate);
        }
        return { node: card, signature };
    }
    function startEdit(entry, card) {
        if (edits.has(entry.id)) { edits.get(entry.id).form.querySelector('textarea')?.focus(); return; }
        const text = memoryText(entry);
        if (entry.kind === 'excerpt' && !text.trim()) return;
        const form = el('form', 'ym-edit-form'), input = textarea('编辑记忆内容', text);
        const save = button('保存修订', () => form.requestSubmit(), 'ym-primary');
        const finishEdit = () => {
            if (edits.get(entry.id) !== draft) return;
            edits.delete(entry.id);
            const item = cards.get(entry.id);
            if (item) item.signature = null;
            renderEntries();
        };
        const cancel = button('取消编辑', finishEdit);
        const actions = el('div', 'ym-actions'); actions.append(save, cancel);
        form.append(input, actions);
        const draft = { form, entry }; edits.set(entry.id, draft);
        card.append(form); input.focus();
        input.addEventListener('input', () => { save.disabled = pendingButtons.has(save) || !input.value.trim(); });
        form.addEventListener('submit', async event => {
            event.preventDefault(); const value = input.value.trim(); if (!value) return;
            if (await dispatch('edit', { entryId: entry.id, expectedRevision: draft.entry.revision, text: value }, save)) {
                if (edits.get(entry.id) !== draft) return;
                if (input.value.trim() === value) finishEdit();
                else draft.entry = state.document?.entries.find(item => item.id === entry.id) || draft.entry;
            }
        });
        card.querySelector('.ym-entry-actions')?.setAttribute('hidden', '');
    }
    function renderEntries() {
        const tree = groupMemoryEntries(state.document?.entries, state.invalidSourceIds);
        const entries = tree.flatMap(group => [group.entry, ...group.children]);
        const present = new Set();
        const hasEditor = node => [...edits.values()].some(edit => {
            for (let current = edit.form; current; current = current.parentNode) if (current === node) return true;
            return false;
        });
        const place = (node, parent, index) => {
            // A newly created/invalidated stage must not detach a focused fine editor.
            // Its grouping catches up when editing finishes, not in the middle of IME input.
            if (node.isConnected && node.parentNode !== parent && hasEditor(node)) return;
            if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
        };
        for (const entry of entries) {
            present.add(entry.id);
            const item = renderCard(entry, cards.get(entry.id));
            cards.set(entry.id, item);
        }
        for (let index = 0; index < tree.length; index++) {
            const group = tree[index], item = cards.get(group.entry.id);
            place(item.node, list, index);
            if (group.entry.kind !== 'stage') continue;
            let nested = groups.get(group.entry.id);
            if (!nested && group.children.length) {
                const node = el('details', 'ym-stage-children'), title = el('summary'), body = el('div', 'ym-list ym-fine-list');
                node.append(title, body); nested = { node, title, body }; groups.set(group.entry.id, nested); item.node.append(node);
            }
            if (nested) for (let i = 0; i < group.children.length; i++) place(cards.get(group.children[i].id).node, nested.body, i);
        }
        for (const [id, item] of cards) if (!present.has(id)) {
            // A remote deletion must not erase a draft still being edited locally.
            if (hasEditor(item.node)) continue;
            item.node.remove(); cards.delete(id);
        }
        for (const [id, group] of groups) {
            const active = tree.some(item => item.entry.id === id && item.children.length > 0);
            const count = group.body.children.length;
            group.title.textContent = `${active ? '记忆切片' : '编辑中的切片'}（${count}）`;
            group.node.hidden = !count;
            if (!active && count && hasEditor(group.node)) group.node.open = true;
            if (!present.has(id) && !hasEditor(group.node)) { group.node.remove(); groups.delete(id); }
        }
        empty.hidden = entries.length > 0;
        empty.textContent = state.document ? '还没有记忆。可在概览中总结正文，或手动补充。' : '打开一个角色的聊天后，可查看和整理记忆。';
        const removed = (state.document?.entries || []).filter(entry => entry.status === 'deleted');
        deleted.hidden = !removed.length;
        deletedTitle.textContent = `已删除的记忆（${removed.length}）`;
        deletedBody.replaceChildren(...removed.map(entry => {
            const item = el('div', 'ym-used-entry');
            item.append(el('strong', '', sourceLabel(entry))); appendMemoryText(item, entry);
            const undo = button('撤回删除', () => entryAction(entry, 'undo', {}, undo));
            undo.setAttribute('aria-label', `撤回删除${sourceLabel(entry)}`);
            undo.disabled = !entry.history?.length;
            item.append(undo); return item;
        }));
        applyFilter();
    }
    function updateUsed() {
        const use = state.lastUsed;
        usedBody.replaceChildren();
        usedMetric.textContent = Number.isFinite(use?.tokens) ? `约 ${use.tokens} token` : '';
        if (!use) { usedBody.append(el('p', 'ym-muted', '还没有使用记录。')); return; }
        const injectedTitle = el('p', 'ym-muted', '最后一次注入的内容');
        injectedTitle.title = '记录已加入生成请求的内容，不代表模型已接收。'; usedBody.append(injectedTitle);
        if (Array.isArray(use.removedFloors) && Array.isArray(use.recentFloors)) usedBody.append(el('p', 'ym-muted',
            `替换原文 ${use.removedFloors.length} 层 · 保留近期 ${use.recentFloors.length} 层`));
        if ([use.requestTokens, use.contextTokens, use.responseTokens].every(Number.isFinite)) usedBody.append(el('p', 'ym-muted',
            `请求保守估算 ${use.requestTokens} + 回复预留 ${use.responseTokens} / 上下文 ${use.contextTokens} token`));
        const usedEntries = use.entries || (use.memoryIds || []).map(id => state.document?.entries.find(entry => entry.id === id)).filter(Boolean);
        for (const entry of usedEntries) {
            const item = el('div', 'ym-used-entry'); item.append(el('strong', '', sourceLabel(entry))); appendMemoryText(item, entry); usedBody.append(item);
        }
        if (Number.isFinite(use.tokens)) usedBody.append(el('p', 'ym-muted', `约 ${use.tokens} token（估算）`));
    }
    function render(nextState) {
        if (destroyed) return;
        state = nextState || {};
        const key = JSON.stringify(state.snapshot?.binding || null);
        if (key !== scopeKey) {
            scopeKey = key; scopeGeneration++;
            for (const item of cards.values()) item.node.remove();
            cards.clear(); edits.clear(); groups.clear(); settingDrafts[0].clear(); settingDrafts[1].clear();
            settingRevisions[0] = settingRevisions[1] = null;
            thresholdTouched[0] = thresholdTouched[1] = false;
            rangeForm.hidden = true; stageForm.hidden = true; manualForm.hidden = true; manualInput.value = ''; localError = '';
            rangeFields.hidden = true; rangeStart.value = summarizeStart.value = '1';
            rangeEnd.value = summarizeEnd.value = String(state.snapshot?.messages?.length || 0); summarizeNotice.hidden = true;
            for (const [name, card] of toolCards) if (name !== 'backup') card.open = false;
            search.value = ''; filter.value = 'all'; pageScroll.clear(); pageFocus.clear();
            // Backup browsing is account-scoped; other pages belong to the opened chat.
            currentPage = 'overview';
            scroller.scrollTop = 0;
        }
        chatName.textContent = state.snapshot?.name || '请选择单人聊天';
        shortcutToggle.checked = state.ui?.showShortcut === true;
        story.render(state);
        companion.render(state);
        backup.render(state);
        updateStatus(); updateControls(); updateSettings(); renderEntries(); updateOverview(); updateNavigation();
        updateRangePreview();
        if (!stageForm.hidden) updateStageRange();
        updateUsed();
    }
    function open() {
        if (destroyed || opened) return;
        theme.sync();
        returnFocus = document.activeElement;
        opened = true;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
        closeButton.focus();
    }
    function close() {
        if (!opened) return;
        opened = false;
        if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
        if (returnFocus?.isConnected) returnFocus.focus();
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (pageParents[currentPage]) navigate(pageParents[currentPage]); else close(); }
        if (event.key === 'Tab') {
            const focusable = [...dialog.querySelectorAll('button,input,textarea,select,summary,a[href],[tabindex="0"]')].filter(node => {
                if (node.disabled || node.closest('[hidden]')) return false;
                for (let parent = node.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
                    if (parent.tagName === 'DETAILS' && !parent.open && node.closest('summary')?.parentElement !== parent) return false;
                }
                return true;
            });
            if (!focusable.length) return;
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    return {
        render, open, close,
        destroy() { if (destroyed) return; close(); destroyed = true; scopeGeneration++; theme.destroy(); apiView?.destroy(); story.destroy(); backup.destroy(); dialog.remove(); cards.clear(); edits.clear(); groups.clear(); },
    };
}

export function mountEntries(onOpen, { document = globalThis.document } = {}) {
    const owned = [], observers = [];
    let disposed = false;
    function make(id, label, className) {
        // This module owns these IDs only, not host or Qianmu nodes.
        document.getElementById(id)?.remove();
        const node = document.createElement(label ? 'a' : 'button');
        node.id = id; node.className = className;
        if (label) { node.tabIndex = 0; node.setAttribute('role', 'button'); }
        else node.type = 'button';
        node.setAttribute('aria-label', '忆幕'); node.title = '忆幕';
        const glyph = document.createElement('span'); glyph.className = `ym-logo${label ? ' extensionsMenuExtensionButton' : ''}`; glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph);
        if (label) { const text = document.createElement('span'); text.textContent = label; node.append(text); }
        node.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            if (id === 'yimu-menu-entry') {
                const options = document.getElementById('options');
                if (options && document.defaultView?.getComputedStyle(options).display !== 'none') document.getElementById('options_button')?.click();
            }
            onOpen?.();
        });
        if (label) node.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.click(); }
        });
        owned.push(node); return node;
    }
    const menu = document.querySelector('#options .options-content') || document.getElementById('options');
    if (menu) {
        const entry = make('yimu-menu-entry', '忆幕', 'ym-menu-entry list-group-item interactable');
        const qianmu = menu.querySelector('[data-qm-st-menu="true"]');
        if (qianmu) menu.insertBefore(entry, qianmu.nextSibling); else menu.append(entry);
        // Qianmu may finish its own lazy initialization after this extension.
        // Watch only this menu's direct children, not chat messages or the whole page.
        const Observer = document.defaultView?.MutationObserver;
        if (Observer) {
            const observer = new Observer(() => {
                if (!entry.isConnected) return;
                const anchor = menu.querySelector('[data-qm-st-menu="true"]');
                if (anchor && anchor.nextSibling !== entry) menu.insertBefore(entry, anchor.nextSibling);
            });
            observer.observe(menu, { childList: true }); observers.push(observer);
        }
    }
    const send = document.getElementById('send_but');
    const sendParent = document.getElementById('rightSendForm');
    const shortcut = sendParent ? make('yimu-send-entry', '', 'ym-send-entry interactable') : null;
    if (shortcut) { shortcut.hidden = true; sendParent.insertBefore(shortcut, send?.parentElement === sendParent ? send : null); }
    const dispose = () => { disposed = true; for (const observer of observers) observer.disconnect(); for (const node of owned) node.remove(); };
    dispose.update = (preferences = {}, state = {}) => {
        if (disposed || !shortcut) return;
        const status = shortcutStatus(state);
        shortcut.hidden = preferences.showShortcut !== true;
        shortcut.dataset.ymState = status.tone;
        shortcut.title = `忆幕：${status.message}`;
        shortcut.setAttribute('aria-label', `忆幕：${status.message}`);
    };
    dispose.update();
    return dispose;
}
