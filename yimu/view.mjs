// A standalone ST surface. All story/model/user text is rendered as text, never HTML.
import { stageGroups, planStageRange } from './layers.mjs';
import { createStoryView } from './story-view.mjs';
import { mountCompanionView } from './companion-view.mjs';
import { createBackupView } from './backup-view.mjs';
import { planManualRange, summaryCoverage } from './core.mjs';
import { mountTheme } from './theme.mjs';
import { createYimuIcon } from './icons.mjs';
import { mountApiView } from './api-view.mjs';
import { VERSION, DEFAULTS, effectiveSettings, validateSettings, canUndoText } from './contract.mjs';
import { orderedEntries as timelineEntries, memoryTitle, MEMORY_TITLE_LIMIT } from './timeline.mjs';
import { mountYimuNavigation } from './nav.mjs';
import { mountYimuVersionBadge } from './release-version.mjs';
import { mountPromptView } from './prompt-view.mjs';
import { renderSceneLabels, editableMemoryText, editedMemoryValue } from './scene-view.mjs';
import { mountRetrievalView } from './retrieval-view.mjs';

const SETTINGS = [
    ['budget', '记忆注入上限', 'number', 0],
    ['recent', '正文保留层数', 'number', 0],
    ['trigger', '自动总结触发', 'number', 0],
    ['sliceChars', '每条切片字数上限', 'number', 0],
    ['stageAuto', '自动阶段总结', 'checkbox'],
    ['stageBasis', '阶段整理方式', 'select'],
    ['stageThreshold', '阶段总结触发', 'number', 0],
    ['stageRecent', '保留最近记忆切片', 'number', 0],
    ['stageChars', '每条阶段总结字数上限', 'number', 0],
    ['recall', '原文回查与补充', 'checkbox'],
    ['companionShareCustom', '允许伴读使用自定义切片', 'checkbox'],
];
const STAGE_BASES = [{ id: 'tokens', name: '记忆切片 token 数' }, { id: 'floors', name: '覆盖的正文楼层数' }, { id: 'slices', name: '记忆切片份数' }];
const STAGE_THRESHOLDS = { tokens: 65000, floors: 100, slices: 12 };
const sourceStart = entry => entry.source?.start ?? entry.source?.ranges?.[0]?.start ?? Infinity;
const memoryText = entry => entry.kind === 'excerpt' ? typeof entry.quoteText === 'string' ? entry.quoteText : '' : entry.text;
const INSTALL_GUIDE = 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/blob/refactor/storyboard-modularization/yimu/README.md#安装与更新';

export function sourceLabel(entry) {
    const prefix = entry?.origin?.binding?.file ? `${entry.origin.binding.file} · ` : '';
    return prefix + localSourceLabel(entry);
}

function localSourceLabel(entry) {
    if (!entry?.source) return entry?.placement ? `自定义切片 · 第 ${entry.placement.fromFloor} 层后` : '自定义切片';
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

export function orderedEntries(entries = [], entryOrder = []) {
    return timelineEntries(entries, entryOrder).filter(entry => entry.status !== 'deleted');
}

export function groupMemoryEntries(entries = [], invalidSourceIds = [], entryOrder = []) {
    const records = orderedEntries(entries, entryOrder).map(entry => entry.status === 'active' && invalidSourceIds.includes(entry.id) ? { ...entry, status: 'invalid' } : entry);
    const byId = new Map(records.map(entry => [entry.id, entry])), assigned = new Set(), children = new Map();
    for (let i = 0; i < records.length; i++) {
        const stage = records[i];
        if (stage.kind !== 'stage' || stage.status !== 'active') continue;
        const parents = stage.source?.parents || [];
        const valid = parents.length > 0 && parents.every(parent => {
            const fine = byId.get(parent.id);
            return ['summary', 'manual'].includes(fine?.kind) && fine.revision === parent.revision && fine.status === 'active' && (fine.kind === 'manual' || !fine.edited) && !assigned.has(fine.id);
        });
        if (!valid) { records[i] = { ...stage, status: 'invalid' }; continue; }
        const nested = orderedEntries(parents.map(parent => byId.get(parent.id)), entryOrder);
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

export function createView({ onAction, connectionApi, document = globalThis.document, saveDelayMs = 300,
    onNotice = (message, tone = 'success') => (document.defaultView?.toastr || globalThis.toastr)?.[tone]?.(message) } = {}) {
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
    let scopeKey = '', scopeGeneration = 0, localError = '', localErrorPage = '', noticePage = '', seenNotice = '';
    let settingsTimer = null, settingsSaving = false, settingsDraftRevision = null, settingsSaveFailed = false;
    let currentPage = 'overview', manualAfterId = null, openMenuId = null, draggingId = null, dragGeneration = 0;
    const pageScroll = new Map(), pageFocus = new Map(), pages = new Map(), navButtons = new Map();
    const pageTitles = { overview: '导览', memory: '记忆', retrieval: '检索', settings: '设置', manual: '自定义切片' };
    const pageParents = { manual: 'memory' };
    const edits = new Map(), cards = new Map(), groups = new Map(), settingDraft = new Map();
    const pendingButtons = new Set();
    const dialog = el('dialog', 'ym-dialog');
    dialog.setAttribute('aria-label', '忆幕');
    const shell = el('section', 'ym-shell');
    const header = el('header', 'ym-header');
    const heading = el('div', 'ym-heading');
    const pageTitle = el('h2', '', '忆幕');
    heading.append(el('span', 'ym-logo'), pageTitle);
    const versionBadge = mountYimuVersionBadge(heading, { document, version: VERSION,
        onNotice: message => { localError = ''; state.status = message; noticePage = currentPage; seenNotice = message; updateStatus(); },
    });
    const backButton = iconButton('返回', 'back', () => navigate(pageParents[currentPage] || 'overview'), 'ym-back ym-small');
    backButton.hidden = true;
    const closeButton = iconButton('关闭忆幕', 'close', () => close(), 'ym-close');
    const headerActions = el('div', 'ym-actions ym-header-actions');
    headerActions.append(backButton, closeButton);
    header.append(heading, headerActions);
    const nav = el('nav', 'ym-nav-shell'); nav.setAttribute('aria-label', '忆幕页面');
    const navigation = mountYimuNavigation(nav, { document, tabs: ['overview', 'memory', 'retrieval', 'settings'].map(name => [name, pageTitles[name]]), onNavigate: navigate });
    for (const [name, item] of navigation.buttons) navButtons.set(name, item);
    const scroller = el('div', 'ym-scroll');
    const serviceStatus = el('section', 'ym-card ym-service-card');
    serviceStatus.setAttribute('aria-label', '忆幕服务状态'); serviceStatus.setAttribute('aria-live', 'polite');
    const serviceHeading = el('div', 'ym-service-heading'), serviceBadge = el('span', 'ym-service-badge');
    serviceHeading.append(el('h3', '', '后端服务支持'), serviceBadge);
    const serviceVersions = el('span', 'ym-service-versions');
    const serviceVersionRow = el('div', 'ym-service-version-row');
    serviceVersionRow.append(serviceVersions); serviceStatus.append(serviceHeading, serviceVersionRow);
    const status = el('p', 'ym-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const main = el('div', 'ym-content');
    const interfaceCard = el('section', 'ym-card ym-interface-settings');
    const shortcutToggle = el('input', 'ym-switch'); shortcutToggle.type = 'checkbox';
    shortcutToggle.setAttribute('aria-label', '显示输入栏快捷入口');
    const shortcutLabel = el('label', 'ym-switch-row');
    shortcutLabel.append(el('span', 'ym-setting-title', '显示输入栏快捷入口'), shortcutToggle); interfaceCard.append(shortcutLabel);
    shortcutToggle.addEventListener('change', async () => {
        if (!await dispatch('uiSettings', { showShortcut: shortcutToggle.checked }, shortcutToggle)) {
            shortcutToggle.checked = state.ui?.showShortcut === true;
        }
    });
    const backup = createBackupView({ document, pageMode: true, onNotice, onAction: (type, payload) => onAction?.(type, payload) });
    const retrieval = mountRetrievalView({ document });
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
    const installGuide = el('a', 'ym-install-link ym-small'); installGuide.append(createYimuIcon('help', { document })); installGuide.title = '安装说明';
    installGuide.setAttribute('href', INSTALL_GUIDE); installGuide.setAttribute('target', '_blank');
    installGuide.setAttribute('rel', 'noopener noreferrer'); installGuide.setAttribute('aria-label', '忆幕安装说明');
    serviceVersionRow.append(installGuide);
    context.append(chatName);
    const overview = el('section', 'ym-card ym-overview ym-hero');
    const overviewFile = el('p', 'ym-muted ym-overview-file');
    const heroTop = el('div', 'ym-hero-top'), heroText = el('div', 'ym-hero-text');
    const avatar = el('img', 'ym-avatar'); avatar.alt = ''; avatar.hidden = true;
    avatar.addEventListener('error', () => { avatar.hidden = true; });
    const stats = el('div', 'ym-stats'), statValues = [];
    for (const label of ['记忆切片', '已整理层', '待整理层']) {
        const stat = el('div', 'ym-card ym-stat'), value = el('b', '', '0');
        stat.append(value, el('span', '', label)); statValues.push(value); stats.append(stat);
    }
    chatName.className += ' ym-overview-name';
    heroText.append(context, overviewFile); heroTop.append(heroText, avatar);
    const enableCard = el('section', 'ym-card ym-hero-switches');
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
            localError = '请填写当前聊天内有效的起止楼层。'; localErrorPage = currentPage; updateStatus(); return;
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
    const manualLabel = el('span', 'ym-manual-label');
    manualLabel.append(el('strong', '', '手动总结'));
    summarizeRow.append(manualLabel, summarizeStart, el('span', '', '—'), summarizeEnd, el('span', '', '层'), summarizeSubmit);
    const summarizeNotice = el('p', 'ym-muted'); summarizeNotice.hidden = true; summarizeNotice.setAttribute('role', 'status');
    summarizeRangeForm.append(summarizeRow, summarizeNotice);
    summarizeRangeForm.addEventListener('submit', async event => {
        event.preventDefault();
        const range = { start: Number(summarizeStart.value), end: Number(summarizeEnd.value) };
        try {
            const plan = planManualRange(state.document, state.snapshot?.messages || [], rangePreviewSettings(), range);
            if (plan.range.start !== range.start || plan.range.end !== range.end) {
                summarizeStart.value = String(plan.range.start); summarizeEnd.value = String(plan.range.end);
                summarizeNotice.textContent = `已有切片覆盖 ${plan.range.start}–${plan.range.end} 层，已调整范围，请确认后开始。`;
                summarizeNotice.hidden = false; return;
            }
            summarizeNotice.hidden = true;
            await dispatch('summarizeRange', { range, expectedRange: plan.range }, summarizeSubmit);
        } catch (error) { localError = error.message; localErrorPage = currentPage; updateStatus(); }
    });
    for (const input of [summarizeStart, summarizeEnd]) input.addEventListener('input', () => { summarizeNotice.hidden = true; });
    overview.append(heroTop, rangeForm);
    const manualSummaryCard = el('section', 'ym-card ym-manual-summary'); manualSummaryCard.append(summarizeRangeForm);

    const settings = el('section', 'ym-settings');
    const settingsForm = el('form', 'ym-settings-form'), controls = new Map();
    const settingGroups = new Map();
    for (const [name, title, keys] of [
        ['budget', '记忆注入上限', ['budget']],
        ['basic', '切片总结', ['recent', 'trigger', 'sliceChars']],
        ['stage', '阶段总结', ['stageAuto', 'stageBasis', 'stageThreshold', 'stageRecent', 'stageChars']],
        ['extra', '附加功能', ['recall', 'companionShareCustom']],
    ]) {
        const group = el(name === 'extra' ? 'details' : 'section', `ym-card ym-settings-group${name === 'budget' ? ' ym-budget-group' : ''}${name === 'extra' ? ' ym-extra-settings' : ''}`);
        group.append(el(name === 'extra' ? 'summary' : 'h3', 'ym-setting-title', title));
        const body = el('div', 'ym-settings-form'); group.append(body);
        settingsForm.append(group); for (const key of keys) settingGroups.set(key, body);
    }
    for (const [key, label, type, min] of SETTINGS) {
        const input = type === 'textarea' ? textarea(label) : el(type === 'select' ? 'select' : 'input');
        input.setAttribute('aria-label', label);
        if (type !== 'textarea' && type !== 'select') input.type = type;
        if (type === 'checkbox') input.className = 'ym-switch';
        if (min !== undefined) { input.min = String(min); input.step = '1'; }
        if (type === 'number') input.placeholder = key === 'budget' ? '留空自动' : String(DEFAULTS[key] ?? '');
        const readInput = event => {
            if (settingsDraftRevision === null || settingsSaveFailed) settingsDraftRevision = state.document?.configRevision ?? 0;
            settingsSaveFailed = false;
            const value = type === 'checkbox' ? input.checked : type === 'number' ? input.value.trim() === '' ? null : Number(input.value) : input.value;
            const oldBasis = settingValue('stageBasis') || 'tokens';
            if (key === 'stageBasis' && value !== oldBasis) settingDraft.set('stageThreshold', STAGE_THRESHOLDS[value]);
            settingDraft.set(key, value);
            localError = ''; updateStatus();
            if (key === 'stageBasis') updateSettings();
            clearTimeout(settingsTimer);
            if (event.type === 'change' || type === 'select' || type === 'checkbox') void saveChangedSettings();
            else settingsTimer = setTimeout(() => { settingsTimer = null; void saveChangedSettings(); }, saveDelayMs);
        };
        input.addEventListener('input', readInput);
        input.addEventListener('change', readInput);
        input.addEventListener('blur', () => { clearTimeout(settingsTimer); void saveChangedSettings(); });
        const row = el('div', `ym-setting-row${type === 'checkbox' ? ' ym-setting-boolean' : type === 'number' ? ' ym-setting-numeric' : type === 'select' ? ' ym-setting-select' : ''}`);
        const labelNode = field(label, input);
        if (key === 'budget') labelNode.children[0].hidden = true;
        row.append(labelNode);
        settingGroups.get(key).append(row);
        controls.set(key, { input, type, min, label: labelNode.children[0] });
    }
    async function saveChangedSettings() {
        clearTimeout(settingsTimer); settingsTimer = null;
        if (destroyed || settingsSaving || settingsSaveFailed || !state.document || !settingDraft.size) return;
        const values = Object.fromEntries(settingDraft), generation = scopeGeneration;
        const expectedRevision = settingsDraftRevision ?? state.document.configRevision ?? 0;
        for (const [key, value] of Object.entries(values)) {
            const control = controls.get(key);
            if (control?.type === 'number' && value !== null && (!Number.isSafeInteger(value) || value < control.min)) {
                localError = `请填写不小于 ${control.min} 的整数。`; localErrorPage = 'settings'; updateStatus(); return;
            }
        }
        try { validateSettings(values); } catch (error) {
            const invalid = Object.entries(values).find(([key, value]) => { try { validateSettings({ [key]: value }); return false; } catch { return true; } });
            localError = `${invalid ? `${controls.get(invalid[0])?.label.textContent || invalid[0]}：` : ''}${error.message}`; localErrorPage = 'settings'; updateStatus(); return;
        }
        settingsSaving = true;
        let saved = false;
        try {
            saved = await dispatch('settings', { global: false, values, expectedRevision });
            if (saved && generation === scopeGeneration) {
                for (const [key, value] of Object.entries(values)) if (settingDraft.get(key) === value) settingDraft.delete(key);
                settingsDraftRevision = settingDraft.size ? expectedRevision + 1 : null;
                updateSettings();
            } else if (generation === scopeGeneration) settingsSaveFailed = true;
        } finally {
            settingsSaving = false;
            // Drain only newer deliberate edits after success, never loop a failed write.
            if (!destroyed && settingDraft.size && (saved || generation !== scopeGeneration)) void saveChangedSettings();
        }
    }
    settingsForm.addEventListener('submit', event => { event.preventDefault(); void saveChangedSettings(); });
    settings.append(settingsForm);
    const apiSection = el('section', 'ym-connection-settings');
    const apiView = connectionApi ? mountApiView(apiSection, { api: connectionApi, document, accountOnly: true,
        onLegacyChange: values => dispatch('settings', { global: false, values, expectedRevision: state.document?.configRevision ?? 0 }),
    }) : null;
    apiSection.hidden = !connectionApi;

    const controlsRow = el('div', 'ym-actions');
    const retry = button('重新总结失败部分', () => dispatch('retry', {}, retry));
    const addManual = iconButton('插入自定义切片', 'plus', () => openManual());
    const stageButton = iconButton('阶段总结', 'layers', () => {
        stageFormGeneration++;
        if (!stageForm.hidden) { stageForm.hidden = true; stageButton.setAttribute('aria-expanded', 'false'); return; }
        const eligible = stageEligible();
        stageStart.value = String(eligible.find(entry => entry.source)?.source.start || 1);
        stageEnd.value = String(Math.max(1, (state.snapshot?.messages?.length || 0) - (currentSettings().recent || 5)));
        stageForm.hidden = false; stageButton.setAttribute('aria-expanded', 'true'); updateStageRange(); stageStart.focus();
    });
    stageButton.setAttribute('aria-expanded', 'false'); stageButton.setAttribute('aria-controls', 'ym-stage-form');
    controlsRow.append(retry);
    const stageForm = el('form', 'ym-card ym-stage-form'); stageForm.hidden = true; stageForm.id = 'ym-stage-form';
    const stageStart = el('input'), stageEnd = el('input');
    for (const input of [stageStart, stageEnd]) { input.type = 'number'; input.min = '1'; input.step = '1'; input.required = true; }
    stageStart.setAttribute('aria-label', '阶段摘要开始楼层'); stageEnd.setAttribute('aria-label', '阶段摘要结束楼层');
    const stageFields = el('div', 'ym-two-columns');
    stageFields.append(field('开始楼层', stageStart), field('结束楼层', stageEnd));
    const stageHint = el('p', 'ym-inline-warning'); stageHint.hidden = true;
    const stageSubmit = button('开始阶段总结', () => stageForm.requestSubmit(), 'ym-primary');
    let includeCustom = false, stageRequest = null, stageFormGeneration = 0;
    const stageCustom = button('包含自定义切片', () => {
        includeCustom = !includeCustom; stageCustom.setAttribute('aria-pressed', String(includeCustom)); updateStageRange();
    }, 'ym-toggle-tag'); stageCustom.setAttribute('aria-pressed', 'false');
    const stageActions = el('div', 'ym-actions ym-stage-actions');
    stageActions.append(stageSubmit, stageCustom);
    stageForm.append(stageFields, stageHint, stageActions);
    for (const input of [stageStart, stageEnd]) input.addEventListener('input', updateStageRange);
    stageForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!updateStageRange()) return;
        const start = Number(stageStart.value), end = Number(stageEnd.value);
        let plan;
        try {
            plan = planStageRange(state.document, rangePreviewSettings(), { start, end, includeCustom, recentCutoff: state.snapshot.messages.length - currentSettings().recent });
            if (plan.expanded) { stageStart.value = String(plan.range.start); stageEnd.value = String(plan.range.end); stageHint.textContent = '已对齐完整切片范围，请确认后开始'; stageHint.hidden = false; return; }
        } catch (error) { localError = error.message; localErrorPage = currentPage; updateStatus(); return; }
        const request = { scope: scopeGeneration, form: stageFormGeneration, includeCustom };
        const result = dispatch('stage', { start, end, includeCustom, expectedRange: plan.range }, stageSubmit);
        stageRequest = request; updateStageRange();
        if (await result) {
            if (request.scope === scopeGeneration && request.form === stageFormGeneration
                && includeCustom === request.includeCustom && stageStart.value === String(start) && stageEnd.value === String(end)) {
                stageForm.hidden = true; stageButton.setAttribute('aria-expanded', 'false');
            }
        }
        if (stageRequest === request) { stageRequest = null; updateStageRange(); }
    });
    const manualForm = el('form', 'ym-card ym-manual-form');
    manualForm.hidden = true;
    const manualInput = textarea('自定义切片内容');
    const manualTitle = el('input', 'ym-custom-title-input'); manualTitle.setAttribute('aria-label', '自定义切片名称'); manualTitle.placeholder = '自定义切片'; manualTitle.maxLength = MEMORY_TITLE_LIMIT;
    const manualSave = iconButton('保存自定义切片', 'save', () => manualForm.requestSubmit(), 'ym-primary');
    manualSave.disabled = true;
    manualInput.addEventListener('input', () => { manualSave.disabled = pendingButtons.has(manualSave) || !manualInput.value.trim(); });
    const manualActions = el('div', 'ym-actions');
    manualActions.append(manualSave, iconButton('取消自定义切片', 'close', () => { manualForm.hidden = true; navigate('memory'); }));
    manualForm.append(manualTitle, manualActions, manualInput);
    manualForm.addEventListener('submit', async event => {
        event.preventDefault();
        const text = manualInput.value.trim(), title = manualTitle.value.trim(); if (!text) return;
        if (await dispatch('manual', { text, title, afterId: manualAfterId, scenes: [] }, manualSave)) {
            if (manualInput.value.trim() === text && manualTitle.value.trim() === title) {
                manualInput.value = ''; manualTitle.value = ''; manualForm.hidden = true;
                if (currentPage === 'manual') navigate('memory');
            }
            manualSave.disabled = !manualInput.value.trim();
        }
    });
    const list = el('div', 'ym-list');
    const deleted = el('details', 'ym-card ym-memory ym-deleted');
    const deletedTitle = el('summary', 'ym-memory-head', '已删除的记忆'), deletedBody = el('div', 'ym-deleted-body');
    deleted.append(deletedTitle, deletedBody);
    const lastUsed = el('section', 'ym-last-used');
    const usedBody = el('div', 'ym-used-body'); lastUsed.append(usedBody);
    const story = createStoryView({ document, pageMode: true, onNotice, onAction: (type, payload) => onAction?.(type, payload) });
    const companion = mountCompanionView({ document, el, button, pageMode: true, onNotice, onAction: (type, payload) => dispatch(type, payload) });
    const routes = el('div', 'ym-tools'), toolCards = new Map();
    let toolRow = null, toolPanels = null, toolGroup = null, toolIndex = 0;
    for (const [name, title, icon, body] of [
        ['used', '记忆调阅', 'eye', lastUsed], ['story', '故事续接', 'book', story.node],
        ['companion', '关联伴读', 'link', companion.element], ['backup', '记忆备份', 'download', backup.node],
    ]) {
        if (toolIndex++ % 2 === 0) {
            toolGroup = el('div', 'ym-tool-group'); toolRow = el('div', 'ym-tool-row'); toolPanels = el('div', 'ym-folder-panels'); toolGroup.append(toolRow, toolPanels); routes.append(toolGroup);
        }
        const group = toolGroup, side = (toolIndex - 1) % 2 ? 'right' : 'left';
        const card = el('section', 'ym-card ym-tool-card'); card.dataset.tool = name; card.open = false;
        const summary = button(`展开${title}`, () => {
            const open = !card.open;
            for (const sibling of toolCards.values()) if (sibling.group === group) setToolOpen(sibling, false);
            setToolOpen(card, open); group.dataset.side = open ? side : '';
        }, 'ym-tool-summary');
        summary.replaceChildren();
        summary.append(createYimuIcon(icon, { document }), el('strong', '', title));
        summary.append(createYimuIcon('expand', { document }));
        const content = el('section', 'ym-folder-body ym-tool-body'); content.id = `ym-tool-panel-${name}`; content.hidden = true;
        content.append(body); summary.setAttribute('aria-controls', content.id); summary.setAttribute('aria-expanded', 'false');
        card.append(summary); card.panel = content; card.button = summary; card.group = group;
        toolCards.set(name, card); toolRow.append(card); toolPanels.append(content);
    }
    const toolbar = el('div', 'ym-memory-toolbar');
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索记忆'; search.setAttribute('aria-label', '搜索记忆');
    const filter = el('select'); filter.setAttribute('aria-label', '筛选记忆');
    for (const [value, label] of [['all', '全部记忆'], ['summary', '记忆切片'], ['stage', '阶段总结'], ['manual', '自定义切片'], ['attention', '待确认处理']]) {
        const option = el('option', '', label); option.value = value; filter.append(option);
    }
    filter.value = 'all'; toolbar.append(search, filter, stageButton, addManual);
    search.addEventListener('input', applyFilter); filter.addEventListener('change', applyFilter);
    const noMatch = el('p', 'ym-muted', '没有符合条件的记忆。'); noMatch.hidden = true;
    const streamPreview = el('section', 'ym-card ym-stream-preview');
    streamPreview.append(el('h3', 'ym-setting-title', '正在接收整理结果'));
    const streamOutput = el('pre', 'ym-stream-output'); streamOutput.setAttribute('role', 'status'); streamOutput.setAttribute('aria-live', 'polite');
    streamPreview.append(streamOutput); streamPreview.hidden = true;
    const promptContainer = el('section', 'ym-prompt-section');
    const promptView = mountPromptView(promptContainer, { document, showTitle: false,
        onSave: (config, meta = {}) => {
            if (meta.scope && meta.scope !== 'global' && meta.scope !== JSON.stringify(state.snapshot?.binding || null)) return false;
            const global = meta.scope ? meta.scope === 'global' : !state.document;
            return dispatch('settings', { global, values: { prompts: config },
                expectedRevision: meta.revision ?? (global ? state.defaults?.revision ?? 0 : state.document?.configRevision ?? 0) });
        },
        onError: error => { localError = error?.message || '提示词保存未完成'; localErrorPage = 'overview'; updateStatus(); },
    });
    const promptFolder = el('section', 'ym-card ym-tool-card ym-prompt-folder');
    const promptTitle = button('展开总结提示词', () => {
        promptContainer.hidden = !promptContainer.hidden; promptTitle.setAttribute('aria-expanded', String(!promptContainer.hidden));
        promptFolder.setAttribute('data-open', String(!promptContainer.hidden));
    }, 'ym-tool-summary');
    promptTitle.replaceChildren(createYimuIcon('settings', { document }), el('strong', '', '总结提示词'), createYimuIcon('expand', { document }));
    promptTitle.setAttribute('aria-expanded', 'false'); promptContainer.hidden = true; promptContainer.className += ' ym-tool-body';
    promptFolder.append(promptTitle, promptContainer);
    pages.get('overview').append(overview, enableCard, manualSummaryCard, stats, routes, promptFolder);
    pages.get('memory').append(controlsRow, toolbar, stageForm, streamPreview, list, noMatch, deleted);
    pages.get('retrieval').append(retrieval.element);
    pages.get('settings').append(apiSection, interfaceCard, settings, serviceStatus);
    pages.get('manual').append(manualForm);

    function setToolOpen(card, open) {
        card.open = open; card.panel.hidden = !open; card.button.setAttribute('aria-expanded', String(open)); card.setAttribute('data-open', String(open));
    }
    function navigate(name) {
        if (!pages.has(name) || name === currentPage) return;
        pageScroll.set(currentPage, scroller.scrollTop || 0);
        pageFocus.set(currentPage, document.activeElement);
        currentPage = name; updateNavigation(); updateStatus(); scroller.scrollTop = pageScroll.get(name) || 0;
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
        navigation.select(pageParents[currentPage] || currentPage);
    }
    function applyFilter() {
        // A filtered top-level slice may become a stage child after a background update.
        for (const item of cards.values()) item.node.hidden = false;
        const query = search.value.trim().toLocaleLowerCase(), kind = filter.value;
        const matches = entry => (!query || `${sourceLabel(entry)} ${memoryText(entry)}`.toLocaleLowerCase().includes(query))
            && (kind === 'all' || entry.kind === kind || kind === 'manual' && entry.edited
                || kind === 'attention' && (entry.status === 'invalid' || entry.candidate || entry.conflicts?.length));
        let visible = 0;
        for (const group of groupMemoryEntries(state.document?.entries, state.invalidSourceIds, state.document?.entryOrder)) {
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
        overviewFile.textContent = state.snapshot?.binding?.file || '';
        overviewFile.title = state.snapshot?.binding?.file || '';
        overviewFile.hidden = !state.snapshot?.binding?.file;
        stats.hidden = false; overview.dataset.empty = String(!doc);
        const avatarUrl = state.snapshot?.avatarUrl;
        if (avatarUrl && avatar.getAttribute('src') !== avatarUrl) { avatar.setAttribute('src', avatarUrl); avatar.hidden = false; }
        else if (!avatarUrl) { avatar.removeAttribute('src'); avatar.hidden = true; }
        const coverage = doc && state.sourceAvailable !== false ? currentCoverage() : null;
        statValues[0].textContent = coverage ? String(coverage.sliceCount) : '0';
        statValues[1].textContent = coverage ? String(coverage.organizedFloors) : '0';
        statValues[2].textContent = coverage ? String(coverage.pendingFloors) : '0';
        stats.setAttribute('aria-disabled', String(!doc));
        for (const [name, card] of toolCards) {
            card.hidden = false; card.button.disabled = name !== 'backup' && !doc;
            card.panel.hidden = !card.open;
        }
    }
    function currentSettings() { return effectiveSettings(state.document, state.defaults); }
    // The view confirms source boundaries only. The runtime resolves the actual
    // selected connection and checks its input capacity before any model call.
    function rangePreviewSettings() { return { ...currentSettings(), inputCapacity: Number.MAX_SAFE_INTEGER }; }
    function currentCoverage() {
        const doc = state.document;
        return summaryCoverage({ ...doc, entries: (doc?.entries || []).map(entry => state.invalidSourceIds?.includes(entry.id)
            && entry.status === 'active' ? { ...entry, status: 'invalid' } : entry) }, state.snapshot?.messages || [], currentSettings());
    }
    async function dispatch(type, payload = {}, sourceButton) {
        if (destroyed || sourceButton?.disabled || pendingButtons.has(sourceButton)) return false;
        const generation = scopeGeneration;
        const actionPage = currentPage;
        localError = ''; updateStatus();
        if (sourceButton) { pendingButtons.add(sourceButton); sourceButton.disabled = true; }
        try {
            const result = await onAction?.(type, payload);
            if (destroyed || generation !== scopeGeneration) return false;
            return result !== false;
        } catch (error) {
            if (generation === scopeGeneration) { localError = error?.message || '操作未完成，请重试。'; localErrorPage = actionPage; updateStatus(); }
            return false;
        } finally {
            pendingButtons.delete(sourceButton);
            if (sourceButton?.isConnected && generation === scopeGeneration) sourceButton.disabled = false;
            if (!destroyed) updateControls();
        }
    }

    function updateStatus() {
        const service = state.service || {};
        serviceBadge.textContent = ({ok:'正常',mismatch:'待更新',error:'未连接',checking:'检查中'})[service.status] || '待检测';
        serviceBadge.dataset.tone = service.status === 'ok' ? 'ready' : service.status === 'error' ? 'error' : 'warning';
        const latest = versionBadge.latest?.();
        serviceVersions.textContent = `当前 ${service.version ? `v${service.version}` : '—'} · 最新 ${latest ? `v${latest}` : '—'}`;
        const sourceWarning = state.snapshot && state.document && state.sourceAvailable === false && !state.loading
            ? '当前聊天原件尚未通过核对，记忆暂不参与生成。' : '';
        // The homepage has a dedicated empty state, not an error for normal navigation.
        const memoryPage = ['overview', 'memory', 'manual'].includes(currentPage);
        const error = !state.snapshot && state.error === '请先打开一个角色的聊天' ? '' : (memoryPage || currentPage === 'settings' && state.errorPage === 'settings') ? state.error : '';
        const needsChoice = (state.document?.entries || []).some(entry => entry.candidate || entry.conflicts?.length);
        const notice = typeof state.status === 'string' && !/^(已保存|本轮整理已完成|阶段总结已完成)$/.test(state.status)
            && (/(请.*确认|两版|无法|失败|不支持)/.test(state.status) || noticePage === currentPage && seenNotice === state.status)
            && (!/两版/.test(state.status) || needsChoice) ? state.status : '';
        const text = (localError && (!localErrorPage || localErrorPage === currentPage) ? localError : '') || error
            || (memoryPage ? sourceWarning : '') || (memoryPage || noticePage === currentPage && seenNotice === state.status ? notice : '');
        status.textContent = typeof text === 'string' ? text : String(text?.message || '');
        status.hidden = !status.textContent;
        status.className = `ym-status${localError || state.error ? ' ym-error' : ''}`;
    }
    function updateControls() {
        const available = Boolean(state.document && state.snapshot && !state.loading);
        main.hidden = false;
        enableCard.hidden = summarizeRangeForm.hidden = settings.hidden = false;
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
        stageButton.disabled = !available;
        stageButton.title = !enabled.checked ? '请先启用忆幕后开始总结' : '';
        updateStageRange();
        retry.hidden = !(state.failedWork && state.document?.enabled);
        retry.textContent = state.failedWork?.kind === 'stage' ? '重试阶段总结' : '重新总结失败部分';
        retry.disabled = !canSummarize || Boolean(state.busy);
        streamOutput.textContent = typeof state.streamPreview === 'string' ? state.streamPreview : '';
        streamPreview.hidden = !(Boolean(state.busy) && streamOutput.textContent);
        addManual.disabled = !available;
        search.disabled = filter.disabled = !available;
        for (const control of controls.values()) control.input.disabled = !available;
        for (const redo of list.querySelectorAll('[data-ym-redo]')) {
            const active = state.activeEntryId === redo.dataset.ymRedo && state.busy;
            redo.disabled = !active && (!canSummarize || Boolean(state.busy));
            const entry = state.document?.entries.find(item => item.id === redo.dataset.ymRedo);
            const label = `${active ? '停止总结' : '重新总结'}${sourceLabel(entry)}`;
            redo.title = label; redo.setAttribute('aria-label', label);
            redo.replaceChildren(createYimuIcon(active ? 'stop' : 'refresh', { document }));
        }
        for (const item of pendingButtons) {
            // A running redo reuses this button as Stop while its first promise
            // is still pending; do not let the duplicate-submit guard lock Stop.
            item.disabled = !(state.busy && item.dataset.ymRedo === state.activeEntryId);
        }
        dialog.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    }
    function updateRangePreview() {
        if (rangeForm.hidden) return;
        rangeHint.replaceChildren(el('span', '', '是否整理历史楼层 '), el('span', 'ym-history-numbers', `${rangeStart.value}–${rangeEnd.value}`));
    }
    function settingValue(key) {
        if (settingDraft.has(key)) return settingDraft.get(key) ?? effectiveSettings(null, state.defaults)[key] ?? DEFAULTS[key];
        return currentSettings()[key] ?? DEFAULTS[key] ?? '';
    }
    function updateSettings() {
        for (const [key, control] of controls) {
            const value = settingValue(key);
            if (control.type === 'select') {
                // Recreating a focused native select resets its selection on mobile.
                if (!control.input.children.length) control.input.replaceChildren(...STAGE_BASES.map(profile => {
                    const option = el('option', '', profile.name || profile.id); option.value = profile.id; return option;
                }));
                control.input.value = String(value);
            }
            if (control.type === 'checkbox') control.input.checked = Boolean(value);
            else if (document.activeElement !== control.input) control.input.value = key === 'budget' && Number(value) === 0 ? '' : String(value);
        }
        apiView?.render({ settings: currentSettings(),
            profiles: state.profiles || [], snapshot: state.snapshot, isGlobal: true,
            overrides: state.document?.settings || {}, showFollow: false });
        const global = !state.document;
        promptView.render({ settings: global ? state.defaults?.values || DEFAULTS : currentSettings(), snapshot: state.snapshot,
            scope: global ? 'global' : JSON.stringify(state.snapshot?.binding || null),
            revision: global ? state.defaults?.revision ?? 0 : state.document?.configRevision ?? 0, global,
            disabled: !state.defaults || state.loading || state.busy, recallEnabled: currentSettings().recall !== false });
    }
    function stageEligible(start = 1, end = Infinity) {
        if (!state.document || !state.snapshot) return [];
        const recent = state.document.settings?.recent ?? state.defaults?.values?.recent ?? 5;
        const entries = state.document.entries.map(entry => entry.status === 'active' && state.invalidSourceIds?.includes(entry.id)
            ? { ...entry, status: 'invalid' } : entry);
        return stageGroups({ ...state.document, entries }, { start, end: Math.min(end, state.snapshot.messages.length - recent) }).flat();
    }
    function updateStageRange() {
        const locked = Boolean(stageRequest || state.busy);
        for (const control of [stageStart, stageEnd, stageCustom]) control.disabled = locked;
        const start = Number(stageStart.value), end = Number(stageEnd.value);
        const bounds = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end;
        let plan = null, reason = '';
        try { if (bounds && state.document && state.snapshot) plan = planStageRange(state.document, rangePreviewSettings(), { start, end, includeCustom, recentCutoff: state.snapshot.messages.length - currentSettings().recent }); }
        catch (error) { reason = error.message; }
        const valid = Boolean(plan?.parents?.length >= 2);
        stageHint.textContent = ''; stageHint.hidden = true;
        stageSubmit.title = valid ? '' : reason || '请选择至少两份切片的完整范围';
        stageSubmit.disabled = !valid || locked || !state.document?.enabled || Boolean(state.paused || state.loading) || state.sourceAvailable === false;
        return valid && !locked;
    }
    function entryAction(entry, action, extra = {}, sourceButton) {
        closeMore();
        return dispatch('entry', { entryId: entry.id, expectedRevision: entry.revision, action, ...extra }, sourceButton);
    }
    function openManual(afterId = null) {
        manualAfterId = afterId;
        manualForm.hidden = false; navigate('manual'); manualInput.focus(); closeMore();
    }
    function closeMore() {
        if (!openMenuId) return;
        const card = cards.get(openMenuId)?.node;
        card?.querySelector('.ym-fixed-actions')?.removeAttribute('hidden');
        card?.querySelector('.ym-more-actions')?.setAttribute('hidden', '');
        card?.querySelector('[data-ym-more]')?.setAttribute('aria-expanded', 'false');
        openMenuId = null;
    }
    async function moveEntry(entryId, beforeId = null) {
        const doc = state.document;
        if (!doc || state.busy) return;
        const entry = doc.entries.find(item => item.id === entryId);
        const block = new Set([entryId, ...(entry?.kind === 'stage' ? entry.source.parents.map(ref => ref.id) : [])]);
        for (const quote of doc.entries.filter(item => item.kind === 'excerpt' && block.has(item.parent?.id))) block.add(quote.id);
        if (beforeId && block.has(beforeId)) return;
        const current = doc.entryOrder || doc.entries.map(item => item.id), moved = current.filter(id => block.has(id));
        const order = current.filter(id => !block.has(id));
        const target = beforeId ? order.indexOf(beforeId) : order.length;
        if (target < 0) return;
        order.splice(target, 0, ...moved);
        closeMore();
        await dispatch('reorder', { entryOrder: order, movedId: entryId, expectedRevision: doc.revision });
    }
    function entryHeading(entry) {
        const heading = el('h3', `ym-entry-title${entry.kind === 'manual' ? ' ym-custom-name' : ''}`);
        const range = entry.source?.start !== undefined ? `楼层${entry.source.start}-${entry.source.end}`
            : entry.kind === 'stage' ? localSourceLabel(entry).replace('阶段摘要 · 第 ', '楼层').replace(' 层', '') : '';
        if (range) heading.append(el('small', 'ym-entry-range', range));
        const title = entry.kind === 'excerpt' ? '回查补充' : memoryTitle(entry);
        heading.append(el('span', 'ym-entry-name', title));
        heading.title = `${sourceLabel(entry)}${title ? ` · ${title}` : ''}`;
        return heading;
    }
    function renderCard(entry, existing) {
        const signature = JSON.stringify(entry);
        if (existing?.signature === signature) return existing;
        const card = existing?.node || el('details', 'ym-card ym-memory');
        card.className = `ym-card ym-memory${entry.kind === 'stage' ? ' ym-stage' : ''}${entry.status === 'excluded' ? ' ym-excluded' : ''}`;
        card.dataset.entryId = entry.id;
        const editing = edits.get(entry.id);
        // Replace saved text / conflict choices independently of an active editor.
        // Keeping the editor connected preserves focus, IME and unsaved revisions.
        for (const child of [...card.children]) if (child !== editing?.form && child !== groups.get(entry.id)?.node) child.remove();
        const content = el('div', 'ym-memory-content');
        const top = el('summary', 'ym-memory-head');
        top.append(entryHeading(entry));
        if (entry.edited && entry.kind !== 'manual') content.append(el('p', 'ym-muted', '人工保护'));
        if (entry.kind === 'manual' && entry.placementVerified === false) content.append(el('p', 'ym-inline-warning', '叙事位置已变化，请重新定位'));
        if (entry.status === 'excluded') { content.append(el('p', 'ym-muted', '已屏蔽注入')); top.title = '已屏蔽注入'; }
        if (entry.scenes?.length) { const scenes = el('div', 'ym-scenes'); renderSceneLabels(scenes, entry.scenes, { document }); content.append(scenes); }
        card.insertBefore(content, card.children[0] || null); card.insertBefore(top, content);
        if (entry.status === 'invalid') {
            const reason = entry.kind === 'stage' ? '所含切片已变化' : '原文已变化';
            content.append(el('p', 'ym-inline-warning', entry.edited ? `${reason}，人工修订已保留，暂不使用。` : `${reason}，此条记忆暂不使用。`));
        }
        appendMemoryText(content, entry, entry.status !== 'invalid');
        const actions = el('div', 'ym-actions ym-entry-actions'), fixed = el('div', 'ym-fixed-actions');
        actions.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
        fixed.addEventListener('click', event => event.stopPropagation());
        if (entry.kind === 'manual') {
            const drag = iconButton('拖动自定义切片', 'drag', () => {});
            drag.className += ' ym-custom-drag';
            drag.setAttribute('draggable', 'true'); drag.draggable = true;
            drag.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
            drag.addEventListener('dragstart', event => { draggingId = entry.id; dragGeneration = scopeGeneration; event.dataTransfer?.setData('text/plain', entry.id); event.stopPropagation(); });
            drag.addEventListener('dragend', () => { draggingId = null; });
            drag.disabled = Boolean(state.busy); top.insertBefore(drag, top.children[0]);
        }
        const edit = iconButton('编辑', 'edit', () => startEdit(entry, card));
        edit.setAttribute('aria-label', `编辑${sourceLabel(entry)}`);
        edit.disabled = entry.kind === 'excerpt' && !memoryText(entry).trim();
        fixed.append(edit);
        if (entry.source && entry.kind !== 'excerpt' && !entry.origin) {
            const running = state.busy && state.activeEntryId === entry.id;
            const redo = iconButton(running ? '停止总结' : '重新总结', running ? 'stop' : 'refresh', () => {
                const stopping = state.busy && state.activeEntryId === entry.id;
                return dispatch(stopping ? 'stop' : 'redo', { entryId: entry.id, expectedRevision: entry.revision }, stopping ? undefined : redo);
            });
            redo.setAttribute('aria-label', running ? '停止总结' : `重新总结${sourceLabel(entry)}`);
            redo.dataset.ymRedo = entry.id;
            redo.disabled = !running && (Boolean(state.busy) || !state.document?.enabled || Boolean(state.paused) || state.sourceAvailable === false);
            redo.title = !state.document?.enabled ? '请先启用忆幕' : state.sourceAvailable === false ? '原文尚未通过核对' : state.busy ? '正在整理此聊天' : '重新总结';
            fixed.append(redo);
        }
        const remove = iconButton('删除', 'trash', () => entryAction(entry, 'delete', {}, remove));
        remove.setAttribute('aria-label', `删除${sourceLabel(entry)}`); fixed.append(remove);
        const moreActions = el('div', 'ym-more-actions');
        moreActions.hidden = true;
        const more = iconButton(`更多${sourceLabel(entry)}`, 'more', () => {
            const wasOpen = openMenuId === entry.id; closeMore();
            if (!wasOpen) { openMenuId = entry.id; fixed.hidden = true; moreActions.hidden = false; more.setAttribute('aria-expanded', 'true'); }
        }); more.dataset.ymMore = ''; more.setAttribute('aria-expanded', 'false');
        const insert = iconButton('插入自定义切片', 'plus', () => openManual(entry.id));
        const use = iconButton(entry.status === 'excluded' ? '取消注入屏蔽' : '将此切片注入屏蔽', 'eye', () => entryAction(entry, entry.status === 'excluded' ? 'restore' : 'exclude', {}, use));
        const up = iconButton('上移切片', 'up', () => {
            const order = orderedEntries(state.document.entries, state.document.entryOrder).filter(item => item.kind !== 'excerpt');
            const index = order.findIndex(item => item.id === entry.id); if (index > 0) void moveEntry(entry.id, order[index - 1].id);
        });
        const down = iconButton('下移切片', 'down', () => {
            const order = orderedEntries(state.document.entries, state.document.entryOrder).filter(item => item.kind !== 'excerpt');
            const index = order.findIndex(item => item.id === entry.id); if (index >= 0 && index < order.length - 1) void moveEntry(entry.id, order[index + 2]?.id);
        });
        moreActions.append(insert, use);
        if (entry.kind === 'manual') moreActions.append(up, down);
        if (canUndoText(entry)) {
            const undo = iconButton('撤回上次修改', 'back', () => entryAction(entry, 'undoText', {}, undo)); moreActions.append(undo);
        }
        if (entry.status === 'invalid' && entry.edited) {
            const keep = iconButton('保留为自定义切片', 'book', () => entryAction(entry, 'keepManual', {}, keep)); moreActions.append(keep);
        }
        actions.append(fixed, moreActions, more); top.append(actions);
        if (editing) {
            card.open = true;
            content.hidden = true;
            top.append(editing.actions);
        }
        if (!existing) {
            card.addEventListener('dragover', event => { if (draggingId && dragGeneration === scopeGeneration && draggingId !== card.dataset.entryId) event.preventDefault(); });
            card.addEventListener('drop', event => { if (draggingId && dragGeneration === scopeGeneration && draggingId !== card.dataset.entryId) { event.preventDefault(); event.stopPropagation(); void moveEntry(draggingId, card.dataset.entryId); draggingId = null; } });
        }
        actions.hidden = Boolean(editing);
        if (entry.candidate) {
            const candidate = el('section', 'ym-candidate');
            candidate.append(el('h4', '', '新版摘要 · 待确认'));
            if (typeof entry.candidate.title === 'string' && entry.candidate.title !== (entry.title || '')) candidate.append(el('p', 'ym-candidate-name', `名称：${entry.candidate.title || '自定义切片'}`));
            candidate.append(el('p', 'ym-memory-text', entry.candidate.text));
            const choice = el('div', 'ym-actions');
            const accept = button('采用候选', () => entryAction(entry, 'acceptCandidate', {}, accept));
            const reject = button('保留原修订', () => entryAction(entry, 'discardCandidate', {}, reject));
            choice.append(accept, reject); candidate.append(choice); content.append(candidate);
        }
        for (const conflict of entry.conflicts || []) {
            const candidate = el('section', 'ym-candidate');
            candidate.append(el('h4', '', '另一份待确认修改'));
            if (typeof conflict.title === 'string' && conflict.title !== (entry.title || '')) candidate.append(el('p', 'ym-candidate-name', `名称：${conflict.title || '自定义切片'}`));
            candidate.append(el('p', 'ym-memory-text', conflict.text));
            const choice = el('div', 'ym-actions');
            const accept = button('采用此版本', () => entryAction(entry, 'acceptConflict', { conflictId: conflict.id }, accept));
            const reject = button('保留已保存版本', () => entryAction(entry, 'discardConflict', { conflictId: conflict.id }, reject));
            choice.append(accept, reject); candidate.append(choice); content.append(candidate);
        }
        return { node: card, signature };
    }
    function startEdit(entry, card) {
        if (edits.has(entry.id)) { edits.get(entry.id).form.querySelector('textarea')?.focus(); return; }
        const text = editableMemoryText(entry);
        if (entry.kind === 'excerpt' && !text.trim()) return;
        closeMore(); card.open = true;
        const form = el('form', 'ym-edit-form'), input = textarea('编辑记忆内容', text);
        const titleInput = entry.kind === 'manual' ? el('input', 'ym-custom-title-input') : null;
        if (titleInput) { titleInput.setAttribute('aria-label', '编辑自定义切片名称'); titleInput.value = entry.title || ''; titleInput.placeholder = '自定义切片'; titleInput.maxLength = MEMORY_TITLE_LIMIT; }
        const save = iconButton('保存修订', 'save', () => form.requestSubmit());
        const finishEdit = () => {
            if (edits.get(entry.id) !== draft) return;
            edits.delete(entry.id);
            const item = cards.get(entry.id);
            if (item) item.signature = null;
            renderEntries();
        };
        const cancel = iconButton('取消编辑', 'close', finishEdit);
        const actions = el('div', 'ym-actions ym-edit-actions'); actions.append(save, cancel);
        actions.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
        if (titleInput) form.append(titleInput);
        form.append(input);
        const draft = { form, entry, actions }; edits.set(entry.id, draft);
        card.querySelector('.ym-memory-content').hidden = true;
        card.querySelector('.ym-memory-head').append(actions);
        card.append(form); input.focus();
        input.addEventListener('input', () => { save.disabled = pendingButtons.has(save) || !input.value.trim(); });
        form.addEventListener('submit', async event => {
            event.preventDefault(); const value = input.value.trim(), title = titleInput?.value.trim(); if (!value) return;
            const edited = editedMemoryValue(value, draft.entry);
            if (titleInput) edited.title = title;
            if (await dispatch('edit', { entryId: entry.id, expectedRevision: draft.entry.revision, ...edited }, save)) {
                if (edits.get(entry.id) !== draft) return;
                if (input.value.trim() === value && titleInput?.value.trim() === title) finishEdit();
                else draft.entry = state.document?.entries.find(item => item.id === entry.id) || draft.entry;
            }
        });
        card.querySelector('.ym-entry-actions')?.setAttribute('hidden', '');
    }
    function renderEntries() {
        const tree = groupMemoryEntries(state.document?.entries, state.invalidSourceIds, state.document?.entryOrder);
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
        const removed = (state.document?.entries || []).filter(entry => entry.status === 'deleted' && !entry.discarded && !entry.replacedBy)
            .sort((a, b) => (b.deletedRevision || 0) - (a.deletedRevision || 0)).slice(0, 10);
        deleted.hidden = !removed.length;
        deletedTitle.textContent = `已删除的记忆（${removed.length}）`;
        const openDeleted = new Set([...deletedBody.children].filter(item => item.open).map(item => item.dataset.entryId));
        deletedBody.replaceChildren(...removed.map(entry => {
            const item = el('details', 'ym-card ym-memory ym-deleted-entry');
            item.dataset.entryId = entry.id; item.open = openDeleted.has(entry.id);
            const title = el('summary', 'ym-memory-head'), body = el('div', 'ym-memory-content');
            title.append(entryHeading(entry)); appendMemoryText(body, entry);
            const undo = button('撤回', () => entryAction(entry, 'undo', {}, undo), 'ym-undo-tag');
            undo.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
            undo.setAttribute('aria-label', `撤回删除${sourceLabel(entry)}`);
            undo.disabled = !entry.history?.length;
            title.append(undo); item.append(title, body); return item;
        }));
        applyFilter();
    }
    function updateUsed() {
        const use = state.lastUsed;
        usedBody.replaceChildren();
        if (!use) { usedBody.append(el('p', 'ym-muted', '暂无注入记录')); return; }
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
            cards.clear(); edits.clear(); groups.clear(); settingDraft.clear(); settingsDraftRevision = null; settingsSaveFailed = false;
            clearTimeout(settingsTimer); settingsTimer = null;
            rangeForm.hidden = true; stageForm.hidden = true; stageButton.setAttribute('aria-expanded', 'false'); includeCustom = false; stageCustom.setAttribute('aria-pressed', 'false');
            stageRequest = null; stageFormGeneration++;
            manualForm.hidden = true; manualInput.value = ''; manualTitle.value = ''; localError = ''; manualAfterId = null; draggingId = null; closeMore();
            rangeFields.hidden = true; rangeStart.value = summarizeStart.value = '1';
            rangeEnd.value = summarizeEnd.value = String(state.snapshot?.messages?.length || 0); summarizeNotice.hidden = true;
            for (const [name, card] of toolCards) if (name !== 'backup') setToolOpen(card, false);
            search.value = ''; filter.value = 'all'; pageScroll.clear(); pageFocus.clear();
            // Backup browsing is account-scoped; other pages belong to the opened chat.
            currentPage = 'overview';
            scroller.scrollTop = 0;
        }
        chatName.textContent = state.snapshot?.name || '请选择一个聊天打开';
        shortcutToggle.checked = state.ui?.showShortcut === true;
        story.render(state);
        companion.render(state);
        backup.render(state);
        updateStatus(); updateControls(); updateSettings(); renderEntries(); updateOverview(); retrieval.render(state); updateNavigation();
        updateRangePreview();
        if (!stageForm.hidden) updateStageRange();
        updateUsed();
    }
    function open() {
        if (destroyed || opened) return;
        theme.sync(); navigation.refresh(); Promise.resolve(versionBadge.check?.()).then(() => { if (!destroyed) updateStatus(); }).catch(() => {});
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
    dialog.addEventListener('cancel', event => { if (event.target !== dialog) return; event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
        if (openMenuId && !event.target.closest?.('.ym-entry-actions')) closeMore();
        if (event.target === dialog) close();
    });
    dialog.addEventListener('keydown', event => {
        const ownerDialog = event.target.closest?.('dialog');
        if (ownerDialog && ownerDialog !== dialog) return;
        if (event.key === 'Escape' && openMenuId) { event.preventDefault(); event.stopPropagation(); closeMore(); return; }
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
        destroy() { if (destroyed) return; close(); destroyed = true; scopeGeneration++; clearTimeout(settingsTimer); theme.destroy(); navigation.destroy(); versionBadge.destroy(); promptView.destroy(); apiView?.destroy(); story.destroy(); backup.destroy(); retrieval.destroy(); dialog.remove(); cards.clear(); edits.clear(); groups.clear(); },
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
        const entry = make('yimu-menu-entry', '忆幕', 'ym-menu-entry interactable');
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
        shortcut.dataset.ymBusy = String(Boolean(state.busy && /正在(?:整理|重试|核对)/.test(String(state.status || ''))));
        shortcut.title = `忆幕：${status.message}`;
        shortcut.setAttribute('aria-label', `忆幕：${status.message}`);
    };
    dispose.update();
    return dispose;
}
