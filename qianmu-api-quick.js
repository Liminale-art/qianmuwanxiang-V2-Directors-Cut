// 千幕 API 快切：入口放在 ST「API 连接」面板的「发送测试消息」旁（千幕图标＋小字），前面一个折叠小箭头展开快速切换；
// 点入口进千幕自己的快切面板：新建（填名称、来源、地址、密钥、模型即可，模型可一键获取）、编辑、置顶、分组、最近使用。
// 连接本身就是 ST 原生的「连接配置」（Connection Profiles）；密钥写进 ST 的密钥库，连接只记密钥的编号（secret-id），千幕不存密钥。
// 千幕只存自己的整理（settings.apiSwitch）：置顶、分组、最近使用、每条连接获取到的模型列表。
// 外观不跟千幕主题：入口、快选与面板是一套固定的简洁样式，颜色取自 ST 当前主题（--SmartTheme*）。
import {readProfiles, normalizeSwitchState, arrangeProfiles, togglePinned, moveToGroup, markUsed, checkProfileName, presetNames, setModels, forgetProfile, ensureGroup, newGroupId, cleanModels} from './features/chat/qianmu-chat-api-switch.js';

export const API_QUICK_STYLESHEET = new URL('./qianmu-api-quick.css', import.meta.url);
const text = value => (typeof value === 'string' ? value.trim() : '');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);
const SOURCE_SHORT = {openai: 'OpenAI', claude: 'Claude', custom: '自定义', openrouter: 'OpenRouter', makersuite: 'Google', google: 'Google', deepseek: 'DeepSeek', mistralai: 'Mistral', cohere: 'Cohere', groq: 'Groq', xai: 'xAI', vertexai: 'Vertex'};
const sourceLabel = api => SOURCE_SHORT[api] || api;

// ST 支持的对话补全来源：直接读 ST 自己的下拉（值与显示名都照 ST）。
export function sourceOptions(doc = globalThis.document) {
    const select = doc?.getElementById?.('chat_completion_source');
    const options = [...(select?.options || [])].map(option => ({value: text(option.value), label: text(option.textContent) || text(option.value)})).filter(option => option.value);
    return options.length ? options : [{value: 'custom', label: 'Custom (OpenAI-compatible)'}, {value: 'openai', label: 'OpenAI'}, {value: 'claude', label: 'Claude'}, {value: 'makersuite', label: 'Google AI Studio'}, {value: 'openrouter', label: 'OpenRouter'}, {value: 'deepseek', label: 'DeepSeek'}];
}

// 来源对应 ST 密钥库里的哪一类密钥；ST 没有这一类（如 Vertex 的服务账号）就返回空，表单里不出现密钥栏。
export function secretKeyFor(source, secretKeys = {}) {
    const source2 = source === 'google' ? 'makersuite' : text(source);
    const key = `api_key_${source2}`;
    return Object.values(secretKeys || {}).includes(key) ? key : '';
}

// 表单 → ST 连接配置。只写填了的项；没写的项切换时 ST 不动它们。
export function buildProfile(existing, values, makeId = () => globalThis.crypto.randomUUID()) {
    const profile = existing ? {...existing} : {id: makeId(), mode: 'cc', exclude: []};
    profile.name = text(values.name);
    profile.mode = 'cc';
    profile.api = text(values.source) || 'custom';
    const set = (key, value) => { if (text(value)) profile[key] = text(value); else delete profile[key]; };
    set('api-url', profile.api === 'custom' ? values.url : '');
    set('model', values.model);
    set('preset', values.preset);
    set('secret-id', values.secretId);
    if (!Array.isArray(profile.exclude)) profile.exclude = [];
    return profile;
}

// 复制一条连接：整条 ST 连接配置深拷贝（代理、排除项、正则预设等都跟着走），换新 id，再套上表单里的值。
export function copyProfile(original, values, makeId = () => globalThis.crypto.randomUUID()) {
    const clone = JSON.parse(JSON.stringify(original || {}));
    clone.id = makeId();
    return buildProfile(clone, values);
}
// 副本的名字：「原名 副本」，重名就往后加数字。
export function copyName(name, profiles) {
    const taken = new Set((Array.isArray(profiles) ? profiles : []).map(item => item?.name)), base = `${text(name)} 副本`;
    for (let n = 1; ; n += 1) { const candidate = n === 1 ? base : `${base} ${n}`; if (!taken.has(candidate)) return candidate; }
}

// 「存为方案」可勾选的绑定项（ST 连接配置里除来源、地址、模型、密钥之外的字段；-state 与它的模板合成一项）。顺序照 ST。
const SNAPSHOT_ITEMS = [
    {keys: ['preset'], label: '预设', modes: ['cc', 'tc']},
    {keys: ['proxy'], label: '代理', modes: ['cc']},
    {keys: ['sysprompt', 'sysprompt-state'], label: '系统提示词', modes: ['tc']},
    {keys: ['instruct', 'instruct-state'], label: '指令模板', modes: ['tc']},
    {keys: ['context'], label: '上下文模板', modes: ['tc']},
    {keys: ['tokenizer'], label: '分词器', modes: ['tc']},
    {keys: ['stop-strings'], label: '停止字符串', modes: ['cc', 'tc']},
    {keys: ['start-reply-with'], label: '回复开头', modes: ['cc', 'tc']},
    {keys: ['reasoning-template'], label: '推理模板', modes: ['cc', 'tc']},
    {keys: ['prompt-post-processing'], label: '提示词后处理', modes: ['cc']},
    {keys: ['regex-preset'], label: '正则预设', modes: ['cc', 'tc']},
];
export function snapshotItems(mode) {
    const m = mode === 'tc' ? 'tc' : 'cc';
    return SNAPSHOT_ITEMS.filter(item => item.modes.includes(m)).map(item => ({id: item.keys[0], keys: [...item.keys], label: item.label}));
}
// /profile-create 建好之后：没勾的项从连接里删掉并记进 exclude（与 ST 自己弹窗里取消勾选同义）；密钥总要存下，ST 没读到就用这一类当前的密钥。
export function applySnapshotChoice(profile, picked, activeSecretId = '') {
    const keep = new Set(Array.isArray(picked) ? picked : []);
    const exclude = new Set((Array.isArray(profile.exclude) ? profile.exclude : []).filter(key => key !== 'secret-id'));
    for (const item of snapshotItems(profile.mode)) {
        if (keep.has(item.id)) { for (const key of item.keys) exclude.delete(key); continue; }
        for (const key of item.keys) { delete profile[key]; exclude.add(key); }
    }
    profile.exclude = [...exclude];
    if (!text(profile['secret-id']) && text(activeSecretId)) profile['secret-id'] = text(activeSecretId);
    return profile;
}

// 折叠箭头展开的快选列表：当前连接在最前，再是置顶，其余按最近使用（没用过的按名字）。
export function quickList(profiles, rawState, activeId = '') {
    const state = normalizeSwitchState(rawState), list = Array.isArray(profiles) ? profiles : [];
    const byId = new Map(list.map(item => [item.id, item])), pinnedIds = new Set(state.pinned);
    const active = activeId && byId.get(activeId) ? [{item: byId.get(activeId), pinned: pinnedIds.has(activeId), active: true}] : [];
    const used = new Set(active.map(entry => entry.item.id));
    const pinned = state.pinned.filter(id => !used.has(id)).map(id => byId.get(id)).filter(Boolean).map(item => ({item, pinned: true, active: false}));
    for (const entry of pinned) used.add(entry.item.id);
    const rest = list.filter(item => !used.has(item.id))
        .sort((a, b) => (state.recent[b.id] || 0) - (state.recent[a.id] || 0) || a.name.localeCompare(b.name)).map(item => ({item, pinned: false, active: false}));
    return [...active, ...pinned, ...rest];
}

function tagsOf(item) {
    return [item.api && sourceLabel(item.api), item.model, item.preset && `预设 ${item.preset}`].filter(Boolean);
}
const iconButton = (cls, label, fa, extra = '') => `<button type="button" class="qm-apiq-icon ${cls}" title="${label}" aria-label="${label}"${extra}><i class="fa-solid ${fa}" aria-hidden="true"></i></button>`;
// where：drop 折叠快选、panel 面板列表。
export function rowHtml(item, {active = false, pinned = false, open = false, where = 'panel'} = {}) {
    const sub = where === 'drop' ? (item.model ? `<span class="qm-apiq-model">${esc(item.model)}</span>` : '')
        : `<span class="qm-apiq-tags">${tagsOf(item).map(tag => `<span class="qm-apiq-tag">${esc(tag)}</span>`).join('')}</span>`;
    const pin = iconButton(`qm-apiq-pin${pinned ? ' is-on' : ''}`, pinned ? '取消置顶' : '置顶', 'fa-thumbtack', ` aria-pressed="${pinned}"`);
    const edit = iconButton('qm-apiq-edit', '编辑', 'fa-pen'), del = iconButton('qm-apiq-del', '删除', 'fa-trash');
    const copy = iconButton('qm-apiq-copy', '复制', 'fa-copy');
    const tools = where === 'drop' ? pin + edit + del
        : `${pin}${open ? edit + copy + del : ''}${iconButton(`qm-apiq-more${open ? ' is-on' : ''}`, open ? '收起' : '更多', 'fa-ellipsis', ` aria-expanded="${open}"`)}`;
    return `<div class="qm-apiq-row${active ? ' is-active' : ''}" data-id="${esc(item.id)}">
        <button type="button" class="qm-apiq-pick" aria-pressed="${active}" title="${active ? '当前连接' : '切换到这条连接'}"><span class="qm-apiq-name">${active ? '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>' : ''}${esc(item.name)}</span>${sub}</button>${tools ? `<span class="qm-apiq-row-tools">${tools}</span>` : ''}
    </div>`;
}
let instanceCount = 0;
// getContext：ST 上下文；getOwner/save：千幕设置；loadSecrets：载入 ST 的密钥模块；logoUrl：千幕图标。
export function createApiQuick({getContext, getOwner, save, notify = () => {}, confirm = async () => true, prompt = async () => null,
    loadSecrets, logoUrl: logoSource = '', doc = globalThis.document, fetchImpl = (...args) => globalThis.fetch(...args)} = {}) {
    let portal = null, panel = null, drop = null, dropAnchor = null, stylesheet = null, attached = false;
    let openId = '', formState = null, busy = false;
    const entries = new Set(), uid = `qm-apiq-${instanceCount += 1}`;
    const combo = {wrap: null, items: [], active: -1};
    const logoUrl = () => { try { return String(typeof logoSource === 'function' ? logoSource() : logoSource || ''); } catch { return ''; } };
    const ctx = () => getContext?.() || {};
    const owner = () => getOwner?.() || {};
    const state = () => normalizeSwitchState(owner().apiSwitch);
    const write = next => { owner().apiSwitch = normalizeSwitchState(next); save?.(); };
    const nativeSelect = () => doc.getElementById('connection_profiles');
    const manager = () => ctx().extensionSettings?.connectionManager;
    const make = (tag, className) => { const node = doc.createElement(tag); if (className) node.className = className; return node; };

    function ensurePortal() {
        if (portal?.isConnected) return portal;
        if (!stylesheet?.isConnected) {
            stylesheet = make('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = API_QUICK_STYLESHEET.href;
            doc.head.append(stylesheet);
        }
        portal = make('section', 'qm-apiq-portal');
        for (const type of ['mousedown', 'touchstart', 'pointerdown', 'mouseup', 'touchend', 'click']) portal.addEventListener(type, event => event.stopPropagation());
        doc.body.append(portal);
        return portal;
    }

    // ── 入口 ──────────────────────────────────────────────────────────────
    function makeEntry() {
        const entry = make('span', 'qm-apiq-entry');
        entry.dataset.qmApiq = '1';
        const fold = make('button', 'qm-apiq-fold'); fold.type = 'button';
        fold.title = '快速切换连接'; fold.setAttribute('aria-label', '快速切换连接'); fold.setAttribute('aria-expanded', 'false');
        fold.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
        const open = make('button', 'qm-apiq-open'); open.type = 'button';
        open.title = 'API快切'; open.setAttribute('aria-label', 'API快切');
        if (logoUrl()) { const img = make('img'); img.src = logoUrl(); img.alt = ''; img.draggable = false; open.append(img); }
        const label = make('span'); label.textContent = 'API快切'; open.append(label);
        fold.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggleDrop(entry); });
        open.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); closeDrop(); openPanel(); });
        entry.append(fold, open);
        return entry;
    }
    function attach() {
        attached = true;
        const anchors = [doc.getElementById('test_api_button'), doc.getElementById('api_button_textgenerationwebui')].filter(Boolean);
        for (const anchor of anchors) {
            if (anchor.parentElement?.querySelector(':scope > .qm-apiq-entry')) continue;
            const entry = makeEntry();
            anchor.after(entry); entries.add(entry);
        }
        if (entries.size) ensurePortal();   // 先挂上样式表
        return entries.size > 0;
    }
    function detach() {
        attached = false;
        closeDrop(); closePanel();
        for (const entry of entries) entry.remove();
        entries.clear();
        portal?.remove(); portal = null; stylesheet?.remove(); stylesheet = null;
    }

    // ── 切换 ──────────────────────────────────────────────────────────────
    // 走原生下拉切换（与 /profile 同一路径），等 ST 说套用完。
    async function apply(id) {
        const node = nativeSelect();
        if (!node) throw new Error('没有找到 ST 的连接配置，请先启用 ST 的 Connection Profiles');
        if (![...node.options].some(option => option.value === id)) throw new Error('ST 的连接列表里没有这一条，请重开页面');
        const context = ctx(), type = context.eventTypes?.CONNECTION_PROFILE_LOADED || 'connection_profile_loaded';
        const loaded = new Promise(resolve => { const timer = setTimeout(resolve, 10000); context.eventSource?.once?.(type, () => { clearTimeout(timer); resolve(); }); });
        node.value = id;
        node.dispatchEvent(new Event('change'));
        await loaded;
        write(markUsed(state(), id));
    }
    async function pick(id) {
        if (busy || !id || id === readProfiles(ctx()).selected) return;
        busy = true; refresh();
        try {
            await apply(id);
            notify(`已切换到「${readProfiles(ctx()).profiles.find(item => item.id === id)?.name || ''}」`, 'success');
        } catch (error) { notify(error?.message || '切换没有完成', 'warning'); }
        finally { busy = false; refresh(); }
    }
    const syncOption = (id, name) => {
        const select = nativeSelect();
        if (!select) return;
        const option = [...select.options].find(item => item.value === id);
        if (name == null) { option?.remove(); return; }
        if (option) { option.textContent = name; return; }
        const added = make('option'); added.value = id; added.textContent = name; select.append(added);
    };
    function refresh() { if (drop) renderDrop(); if (panel?.open) renderPanel(); }
    // ── 折叠快选 ──────────────────────────────────────────────────────────
    function renderDrop() {
        const data = readProfiles(ctx());
        if (!data.available) { drop.innerHTML = '<p class="qm-apiq-empty">请先在 ST 的扩展里启用 Connection Profiles。</p>'; return; }
        const list = quickList(data.profiles, state(), data.selected);
        drop.innerHTML = `<div class="qm-apiq-drop-list">${list.length ? list.map(({item, pinned, active}) => rowHtml(item, {active, pinned, where: 'drop'})).join('')
            : '<p class="qm-apiq-empty">还没有连接</p>'}</div>`;
        drop.classList.toggle('is-busy', busy);
    }
    function placeDrop() {
        if (!drop || !dropAnchor?.isConnected) return;
        const rect = dropAnchor.getBoundingClientRect(), view = doc.defaultView;
        const width = Math.min(320, view.innerWidth - 16);
        const left = Math.min(Math.max(8, rect.left), view.innerWidth - width - 8);
        const below = view.innerHeight - rect.bottom - 8, above = rect.top - 8;
        drop.style.width = `${width}px`; drop.style.left = `${left}px`;
        if (below >= 220 || below >= above) { drop.style.top = `${rect.bottom + 6}px`; drop.style.bottom = ''; drop.style.maxHeight = `${Math.max(160, below - 6)}px`; }
        else { drop.style.top = ''; drop.style.bottom = `${view.innerHeight - rect.top + 6}px`; drop.style.maxHeight = `${Math.max(160, above - 6)}px`; }
    }
    const outside = event => { if (drop && !drop.contains(event.target) && !dropAnchor?.contains(event.target)) closeDrop(); };
    const onKey = event => { if (event.key === 'Escape' && drop) { event.stopPropagation(); closeDrop(); } };
    function toggleDrop(entry) {
        if (drop && dropAnchor === entry) { closeDrop(); return; }
        closeDrop();
        dropAnchor = entry;
        drop = make('div', 'qm-apiq-drop');
        drop.setAttribute('role', 'listbox'); drop.setAttribute('aria-label', '快速切换连接');
        ensurePortal().append(drop);
        renderDrop(); placeDrop();
        entry.querySelector('.qm-apiq-fold')?.setAttribute('aria-expanded', 'true');
        drop.addEventListener('click', event => {
            const row = event.target.closest('.qm-apiq-row'), id = row?.dataset.id;
            if (!id || busy) return;
            if (event.target.closest('.qm-apiq-pick')) { closeDrop(); void pick(id); return; }
            if (event.target.closest('.qm-apiq-pin')) { write(togglePinned(state(), id)); renderDrop(); return; }
            if (event.target.closest('.qm-apiq-edit')) { closeDrop(); openPanel(); void secrets().then(() => startForm(id)); return; }
            if (event.target.closest('.qm-apiq-del')) { void deleteProfile(id).then(() => { if (drop) renderDrop(); }); }
        });
        doc.addEventListener('pointerdown', outside, true);
        doc.addEventListener('keydown', onKey, true);
        doc.defaultView.addEventListener('resize', placeDrop);
        doc.addEventListener('scroll', placeDrop, true);
    }
    function closeDrop() {
        if (!drop) return;
        drop.remove(); drop = null;
        dropAnchor?.querySelector('.qm-apiq-fold')?.setAttribute('aria-expanded', 'false');
        dropAnchor = null;
        doc.removeEventListener('pointerdown', outside, true);
        doc.removeEventListener('keydown', onKey, true);
        doc.defaultView.removeEventListener('resize', placeDrop);
        doc.removeEventListener('scroll', placeDrop, true);
    }
    // ── 快切面板 ──────────────────────────────────────────────────────────
    function listHtml() {
        const data = readProfiles(ctx());
        if (!data.available) return '<p class="qm-apiq-empty">没有找到 ST 的「连接配置」。请在 ST 的扩展里启用 Connection Profiles 后再来。</p>';
        const s = state(), arranged = arrangeProfiles(data.profiles, s, data.selected), pinnedIds = new Set(s.pinned);
        const form = id => (formState && formState.id === id ? (formState.kind === 'snapshot' ? snapshotHtml(formState) : formHtml(formState, s)) : '');
        const row = item => rowHtml(item, {active: item.id === data.selected, pinned: pinnedIds.has(item.id), open: item.id === openId && formState?.id !== item.id}) + form(item.id);
        const block = (id, title, items, head = '') => `<section class="qm-apiq-group" data-group="${esc(id)}"><div class="qm-apiq-group-head"><h4>${esc(title)}</h4>${head}</div>${items.length ? items.map(row).join('') : '<p class="qm-apiq-empty">空</p>'}</section>`;
        const groupHead = group => `<span class="qm-apiq-acts">${iconButton('qm-apiq-group-rename', '改组名', 'fa-pen', ` data-group="${esc(group.id)}"`)}${iconButton('qm-apiq-group-del', '删除分组', 'fa-trash', ` data-group="${esc(group.id)}"`)}</span>`;
        return `<div class="qm-apiq-tools"><button type="button" class="qm-apiq-text qm-apiq-new">新建连接</button><button type="button" class="qm-apiq-text qm-apiq-group-add">新建分组</button><button type="button" class="qm-apiq-text qm-apiq-snapshot">将当前ST设置存为方案</button></div>
            ${form('')}
            ${arranged.active ? `<section class="qm-apiq-group qm-apiq-lead">${row(arranged.active)}</section>` : ''}
            ${arranged.pinned.length ? block('pinned', '置顶', arranged.pinned) : ''}
            ${arranged.groups.map(group => block(group.id, group.name, group.items, groupHead(group))).join('')}
            ${block('others', '最近使用', arranged.others)}`;
    }
    function formHtml(f, s) {
        const sources = sourceOptions(doc), key = secretKeyFor(f.source, secretsModule?.SECRET_KEYS);
        const presets = presetNames(ctx(), 'cc');
        const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
        const field = (label, body) => `<label class="qm-apiq-field"><span>${label}</span>${body}</label>`;
        // 带下拉的栏不用 <label> 包：点下拉里的项会被 label 转成点输入框。
        const plainField = (label, body) => `<div class="qm-apiq-field"><span>${label}</span>${body}</div>`;
        // 可输入也可从下拉里选的一栏（模型、分组）；下拉内容在打开时按 kind 现取。
        const comboBox = (kind, input, withList) => `<span class="qm-apiq-combo" data-combo="${kind}">${input}${withList
            ? `<button type="button" class="qm-apiq-combo-toggle" tabindex="-1" aria-label="展开" title="展开"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button><div class="qm-apiq-combo-list" id="${uid}-${kind}-list" role="listbox" hidden></div>` : ''}</span>`;
        const comboAttrs = kind => ` role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${uid}-${kind}-list" autocomplete="off" spellcheck="false"`;
        return `<form class="qm-apiq-form" novalidate data-id="${esc(f.id)}">
            ${field('名称', `<input class="qm-apiq-f-name" value="${esc(f.name)}" maxlength="80" autocomplete="off" spellcheck="false">`)}
            ${field('来源', `<select class="qm-apiq-f-source">${sources.map(item => option(item.value, item.label, item.value === f.source)).join('')}</select>`)}
            ${f.source === 'custom' ? field('服务地址', `<input class="qm-apiq-f-url" value="${esc(f.url)}" placeholder="https://…/v1" autocomplete="off" spellcheck="false" inputmode="url">`) : ''}
            ${key ? field('密钥', `<input class="qm-apiq-f-key" type="password" value="${esc(f.key)}" placeholder="${f.secretId ? '留空不改' : '粘贴密钥'}" autocomplete="new-password" spellcheck="false">`) : ''}
            ${plainField('模型', `<span class="qm-apiq-inline">${comboBox('model', `<input class="qm-apiq-f-model" value="${esc(f.model)}" placeholder="可留空" aria-label="模型"${comboAttrs('model')}>`, f.models.length > 0)}<button type="button" class="qm-apiq-text qm-apiq-fetch"${f.fetching ? ' disabled' : ''}>${f.fetching ? '获取中…' : '获取模型'}</button></span>`)}
            ${field('预设', `<select class="qm-apiq-f-preset">${option('', '不切换预设', !f.preset)}${[...new Set([...(f.preset ? [f.preset] : []), ...presets])].map(name => option(name, name, name === f.preset)).join('')}</select>`)}
            ${plainField('分组', comboBox('group', `<input class="qm-apiq-f-group" value="${esc(f.group)}" placeholder="不放进分组" maxlength="40" aria-label="分组"${comboAttrs('group')}>`, true))}
            ${f.error ? `<p class="qm-apiq-error" role="alert">${esc(f.error)}</p>` : ''}
            <div class="qm-apiq-form-acts"><button type="button" class="qm-apiq-text qm-apiq-cancel">取消</button><button type="button" class="qm-apiq-text qm-apiq-save">保存</button><button type="button" class="qm-apiq-text is-primary qm-apiq-save-use">保存并切换</button></div>
        </form>`;
    }
    function snapshotHtml(f) {
        const checks = snapshotItems(f.mode).map(item => `<label class="qm-apiq-check"><input type="checkbox" class="qm-apiq-f-bind" value="${esc(item.id)}"${f.picked.includes(item.id) ? ' checked' : ''}><span>${esc(item.label)}</span></label>`).join('');
        return `<form class="qm-apiq-form qm-apiq-snap" novalidate data-id="">
            <h4 class="qm-apiq-form-title">存为方案</h4>
            <label class="qm-apiq-field"><span>名称</span><input class="qm-apiq-f-name" value="${esc(f.name)}" maxlength="80" autocomplete="off" spellcheck="false"></label>
            <div class="qm-apiq-field"><span>绑定</span><div class="qm-apiq-checks">${checks}</div></div>
            ${f.error ? `<p class="qm-apiq-error" role="alert">${esc(f.error)}</p>` : ''}
            <div class="qm-apiq-form-acts"><button type="button" class="qm-apiq-text qm-apiq-cancel">取消</button><button type="button" class="qm-apiq-text is-primary qm-apiq-snap-save">保存</button></div>
        </form>`;
    }

    // ── 可输入的下拉（模型、分组）────────────────────────────────────────
    function comboItems(kind) {
        if (kind === 'model') return (formState?.models || []).map(id => ({value: id, label: id}));
        if (kind === 'group') return [{value: '', label: '不放进分组'}, ...state().groups.map(group => ({value: group.name, label: group.name}))];
        return [];
    }
    // query 为 null：列出全部（点开时）；否则按输入筛选（打字时）。
    function openCombo(wrap, query = null) {
        const input = wrap?.querySelector('input'), list = wrap?.querySelector('.qm-apiq-combo-list');
        if (!input || !list) return;
        const q = text(query ?? '').toLowerCase(), all = comboItems(wrap.dataset.combo);
        const items = q ? all.filter(item => item.value && item.label.toLowerCase().includes(q)) : all;
        if (combo.wrap && combo.wrap !== wrap) closeCombo();
        if (!items.length) { closeCombo(); return; }
        const current = text(input.value);
        combo.wrap = wrap; combo.items = items; combo.active = items.findIndex(item => item.value === current);
        list.innerHTML = items.map((item, index) => `<div class="qm-apiq-combo-opt${item.value ? '' : ' is-none'}" role="option" id="${uid}-opt-${index}" data-index="${index}" aria-selected="${item.value === current}">${esc(item.label)}</div>`).join('');
        list.hidden = false; wrap.classList.add('is-open'); input.setAttribute('aria-expanded', 'true');
        markCombo(true);
    }
    function closeCombo() {
        const wrap = combo.wrap;
        combo.wrap = null; combo.items = []; combo.active = -1;
        if (!wrap) return;
        const list = wrap.querySelector('.qm-apiq-combo-list'), input = wrap.querySelector('input');
        if (list) { list.hidden = true; list.innerHTML = ''; }
        wrap.classList.remove('is-open');
        input?.setAttribute('aria-expanded', 'false'); input?.removeAttribute('aria-activedescendant');
    }
    function markCombo(scroll) {
        const wrap = combo.wrap, input = wrap?.querySelector('input');
        if (!wrap) return;
        let hit = null;
        for (const node of wrap.querySelectorAll('.qm-apiq-combo-opt')) {
            const on = Number(node.dataset.index) === combo.active;
            node.classList.toggle('is-active', on);
            if (on) hit = node;
        }
        if (hit) input?.setAttribute('aria-activedescendant', hit.id); else input?.removeAttribute('aria-activedescendant');
        if (scroll) (hit || wrap.querySelector('.qm-apiq-combo-list'))?.scrollIntoView?.({block: 'nearest'});
    }
    function chooseCombo(index) {
        const wrap = combo.wrap, item = combo.items[index], input = wrap?.querySelector('input');
        if (!input || !item) { closeCombo(); return; }
        input.value = item.value;
        closeCombo();
        readForm();
        if (formState?.error) { formState.error = ''; panel?.querySelector('.qm-apiq-error')?.remove(); }
    }
    // 下拉开着时的方向键、回车、Esc；返回 true 表示已处理（Esc 不再退出表单）。
    function comboKey(event) {
        const input = event.target?.closest?.('.qm-apiq-combo input');
        if (!input || event.isComposing) return false;
        const wrap = input.closest('.qm-apiq-combo'), open = combo.wrap === wrap;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) { openCombo(wrap); return true; }
            const count = combo.items.length, step = event.key === 'ArrowDown' ? 1 : -1;
            combo.active = combo.active < 0 ? (step > 0 ? 0 : count - 1) : (combo.active + step + count) % count;
            markCombo(true); return true;
        }
        if (!open) return false;
        if (event.key === 'Enter') { event.preventDefault(); if (combo.active >= 0) chooseCombo(combo.active); else closeCombo(); return true; }
        if (event.key === 'Escape') { event.preventDefault(); closeCombo(); return true; }
        if (event.key === 'Tab') closeCombo();
        return false;
    }
    let secretsModule = null;
    async function secrets() {
        if (secretsModule) return secretsModule;
        try { secretsModule = await loadSecrets?.(); } catch { secretsModule = null; }
        return secretsModule;
    }
    function renderPanel() {
        if (!panel) return;
        const body = panel.querySelector('.qm-apiq-body'), scroll = body.scrollTop;
        combo.wrap = null; combo.items = []; combo.active = -1;   // 下拉随整块重画一起没了
        body.innerHTML = listHtml();
        body.scrollTop = scroll;
        panel.classList.toggle('is-busy', busy);
    }
    function openPanel() {
        const root = ensurePortal();
        if (!panel) {
            panel = make('dialog', 'qm-apiq-panel');
            panel.setAttribute('aria-label', 'API快切');
            panel.innerHTML = `<header class="qm-apiq-head"><img class="qm-apiq-logo" alt="" draggable="false"${logoUrl() ? ` src="${esc(logoUrl())}"` : ' hidden'}><b class="qm-apiq-title">API快切</b>
                <button type="button" class="qm-apiq-icon qm-apiq-close" aria-label="关闭" title="关闭"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header>
                <div class="qm-apiq-body"></div>`;
            panel.addEventListener('click', event => { void onPanelClick(event); });
            panel.addEventListener('change', onPanelChange);
            panel.addEventListener('input', onPanelInput);
            panel.addEventListener('cancel', event => { event.preventDefault(); if (formState) void leaveForm(); else closePanel(); });
            for (const type of ['keydown', 'keyup', 'keypress']) panel.addEventListener(type, event => event.stopPropagation());
            panel.addEventListener('keydown', event => {
                if (comboKey(event)) return;
                if (event.key === 'Escape') { event.preventDefault(); if (formState) void leaveForm(); else closePanel(); }
            });
            // 点在开着的下拉外面就收起（面板外的灰底点到的是 dialog 本身，也算外面）。
            panel.addEventListener('pointerdown', event => { if (combo.wrap && !combo.wrap.contains(event.target)) closeCombo(); }, true);
            // 点下拉里的项不让输入框失焦（桌面端键盘还能接着用）。
            panel.addEventListener('mousedown', event => { if (event.target.closest?.('.qm-apiq-combo-list, .qm-apiq-combo-toggle')) event.preventDefault(); });
        }
        if (!panel.isConnected) root.append(panel);
        openId = ''; formState = null;
        renderPanel();
        if (!panel.open) panel.showModal();
        void secrets();
    }
    function closePanel() {
        if (!panel) return;
        void discardPending();
        if (panel.open) panel.close();
        panel.remove(); openId = ''; formState = null;
    }

    // ── 新建、编辑、复制与存为方案 ────────────────────────────────────────
    // copy：以 id 那条为底开一张新建表单（新名字、同一把密钥、同一份模型列表），保存时整条深拷贝。
    function startForm(id = '', {copy = false} = {}) {
        if (!panel?.open) return;
        void discardPending();
        const raw = id ? (manager()?.profiles || []).find(item => item?.id === id) : null;
        if (id && !raw) return;
        const s = state(), sources = sourceOptions(doc), group = id ? s.groups.find(item => item.ids.includes(id))?.name || '' : '';
        formState = raw
            ? {kind: 'profile', id: copy ? '' : id, copyOf: copy ? id : '', name: copy ? copyName(raw.name, manager()?.profiles) : raw.name || '', source: text(raw.api) === 'google' ? 'makersuite' : text(raw.api) || 'custom', url: raw['api-url'] || '', key: '', secretId: raw['secret-id'] || '', model: raw.model || '', preset: raw.preset || '', group, models: [...(s.models[id] || [])], pending: null, error: ''}
            : {kind: 'profile', id: '', copyOf: '', name: '', source: sources.some(item => item.value === 'custom') ? 'custom' : sources[0]?.value || 'custom', url: '', key: '', secretId: '', model: '', preset: '', group: '', models: [], pending: null, error: ''};
        showForm();
    }
    function startSnapshot() {
        if (!panel?.open) return;
        void discardPending();
        formState = {kind: 'snapshot', id: '', name: '', mode: ctx().mainApi === 'openai' ? 'cc' : 'tc', picked: [], pending: null, error: ''};
        showForm();
    }
    function showForm() {
        openId = ''; renderPanel();
        const form = panel.querySelector('.qm-apiq-form');
        form?.scrollIntoView?.({block: 'nearest'});
        form?.querySelector('.qm-apiq-f-name')?.focus({preventScroll: true});
    }
    function readForm() {
        const form = panel?.querySelector('.qm-apiq-form');
        if (!form || !formState) return;
        const value = cls => form.querySelector(cls)?.value;
        formState.name = value('.qm-apiq-f-name') ?? formState.name;
        if (formState.kind === 'snapshot') { formState.picked = [...form.querySelectorAll('.qm-apiq-f-bind:checked')].map(node => node.value); return; }
        formState.url = value('.qm-apiq-f-url') ?? formState.url;
        formState.key = value('.qm-apiq-f-key') ?? formState.key;
        formState.secretId = value('.qm-apiq-f-secret') ?? formState.secretId;
        formState.model = value('.qm-apiq-f-model') ?? formState.model;
        formState.preset = value('.qm-apiq-f-preset') ?? formState.preset;
        formState.group = value('.qm-apiq-f-group') ?? formState.group;
    }
    // 新填的密钥写进 ST 的密钥库（ST 会把它设为这一类的当前密钥）。同一次填写只写一次。
    async function writePendingKey() {
        const module = await secrets(), key = secretKeyFor(formState.source, module?.SECRET_KEYS), value = text(formState.key);
        if (!key || !value) return '';
        if (formState.pending?.key === key && formState.pending.value === value) return formState.pending.id;
        await discardPending();
        if (typeof module?.writeSecret !== 'function') throw new Error('当前 ST 不能从这里保存密钥，请在 ST 的 API 面板里填');
        const previous = (module.secret_state?.[key] || []).find(item => item.active)?.id || '';
        const id = await module.writeSecret(key, value, text(formState.name) || sourceLabel(formState.source));
        if (!id) throw new Error('密钥没有存进 ST');
        formState.pending = {key, value, id, previous};
        return id;
    }
    // 获取模型时为这条连接新写的密钥，没保存就退出：从 ST 里删掉，并换回原来的当前密钥。
    async function discardPending() {
        const pending = formState?.pending;
        if (!pending) return;
        formState.pending = null;
        const module = await secrets();
        try {
            await module?.deleteSecret?.(pending.key, pending.id);
            if (pending.previous) await module?.rotateSecret?.(pending.key, pending.previous);
        } catch (error) { console.warn('[千幕] 未保存的密钥没能撤回', error); }
    }
    async function fetchModels() {
        readForm();
        if (formState.source === 'custom' && !text(formState.url)) { formState.error = '先填服务地址'; renderPanel(); return; }
        formState.fetching = true; formState.error = ''; renderPanel();
        try {
            const module = await secrets(), key = secretKeyFor(formState.source, module?.SECRET_KEYS);
            if (text(formState.key)) await writePendingKey();
            else if (key && formState.secretId && typeof module?.rotateSecret === 'function') {   // 编辑时沿用这条连接原来的密钥
                const active = (module.secret_state?.[key] || []).find(item => item.active)?.id || '';
                if (active !== formState.secretId) await module.rotateSecret(key, formState.secretId);
            }
            const body = {chat_completion_source: formState.source === 'google' ? 'makersuite' : formState.source, reverse_proxy: '', proxy_password: ''};
            if (formState.source === 'custom') body.custom_url = text(formState.url);
            const response = await fetchImpl('/api/backends/chat-completions/status', {method: 'POST', headers: ctx().getRequestHeaders?.() || {'Content-Type': 'application/json'}, body: JSON.stringify(body), cache: 'no-cache'});
            const data = response.ok ? await response.json() : null;
            if (!data || data.error || !Array.isArray(data.data)) throw new Error('没取到模型，请检查地址与密钥');
            formState.models = cleanModels([...new Set(data.data.map(item => text(item?.id)).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
            if (!formState.models.length) throw new Error('这个服务没有返回模型');
            if (!formState.model) formState.model = formState.models[0];
        } catch (error) { formState.error = error?.message || '没取到模型'; }
        finally { formState.fetching = false; renderPanel(); }
        if (formState?.models.length && !formState.error) openCombo(panel?.querySelector('.qm-apiq-combo[data-combo="model"]'));
    }
    async function saveForm(andSwitch) {
        readForm();
        const store = manager();
        if (!store || !Array.isArray(store.profiles)) { formState.error = '没有找到 ST 的连接配置'; renderPanel(); return; }
        const problem = checkProfileName(formState.name, readProfiles(ctx()).profiles, formState.id);
        if (problem) { formState.error = problem; renderPanel(); return; }
        if (formState.source === 'custom' && !text(formState.url)) { formState.error = '自定义来源要填服务地址'; renderPanel(); return; }
        busy = true; formState.error = ''; renderPanel();
        try {
            const typed = text(formState.key) ? await writePendingKey() : '';
            const existing = formState.id ? store.profiles.find(item => item?.id === formState.id) : null;
            if (formState.id && !existing) throw new Error('这条连接已不在 ST 里');
            const original = formState.copyOf ? store.profiles.find(item => item?.id === formState.copyOf) : null;
            if (formState.copyOf && !original) throw new Error('要复制的连接已不在 ST 里');
            const values = {...formState, secretId: typed || formState.secretId};
            const profile = original ? copyProfile(original, values) : buildProfile(existing, values);
            formState.pending = null;   // 已经归到这条连接名下，不再撤回
            const context = ctx(), types = context.eventTypes || {};
            if (existing) {
                for (const key of Object.keys(existing)) delete existing[key];
                Object.assign(existing, profile);
                syncOption(existing.id, existing.name);
                await context.eventSource?.emit?.(types.CONNECTION_PROFILE_UPDATED || 'connection_profile_updated', existing, existing);
            } else {
                store.profiles.push(profile);
                syncOption(profile.id, profile.name);
                await context.eventSource?.emit?.(types.CONNECTION_PROFILE_CREATED || 'connection_profile_created', profile);
            }
            context.saveSettingsDebounced?.();
            const id = profile.id, wasCurrent = readProfiles(ctx()).selected === id;
            const grouped = ensureGroup(setModels(state(), id, formState.models), formState.group);
            write(moveToGroup(grouped.state, id, grouped.id));
            formState = null;
            if (andSwitch || wasCurrent) await apply(id);
            notify(andSwitch ? `已保存并切换到「${profile.name}」` : `已保存「${profile.name}」`, 'success');
        } catch (error) {
            if (formState) formState.error = error?.message || '没有保存成功';
            else notify(error?.message || '切换没有完成', 'warning');
        } finally { busy = false; renderPanel(); }
    }
    // 存为方案：用 ST 的 /profile-create 照当前设置建一条，再按勾选去掉不绑定的项，并确保密钥在里面。
    async function saveSnapshot() {
        readForm();
        const name = text(formState.name), problem = checkProfileName(name, readProfiles(ctx()).profiles);
        if (problem) { formState.error = problem; renderPanel(); return; }
        const run = ctx().executeSlashCommandsWithOptions;
        if (typeof run !== 'function') { formState.error = '当前 ST 不支持在此新建连接'; renderPanel(); return; }
        busy = true; formState.error = ''; renderPanel();
        try {
            const picked = [...formState.picked];
            await run(`/profile-create ${name}`, {handleParserErrors: true, handleExecutionErrors: true});
            const made = (manager()?.profiles || []).find(item => item?.name === name);
            if (!made) throw new Error('ST 没有建成这条连接');
            const before = JSON.parse(JSON.stringify(made));
            applySnapshotChoice(made, picked, await activeSecretFor(made));
            const context = ctx();
            context.saveSettingsDebounced?.();
            await context.eventSource?.emit?.(context.eventTypes?.CONNECTION_PROFILE_UPDATED || 'connection_profile_updated', before, made);
            write(markUsed(state(), made.id));
            formState = null;
            notify(`已存下「${made.name}」`, 'success');
        } catch (error) {
            if (formState) formState.error = error?.message || '没有存成';
            else notify(error?.message || '没有存成', 'warning');
        } finally { busy = false; renderPanel(); }
    }
    // 这条连接的来源在 ST 密钥库里的当前密钥（先按 ST 此刻的设置认密钥类别，认不出再按连接的来源）。
    async function activeSecretFor(profile) {
        const module = await secrets();
        let key = '';
        try { key = text(module?.resolveSecretKey?.()); } catch (error) { console.warn('[千幕] 没认出当前来源的密钥类别', error); }
        if (!key) key = secretKeyFor(profile?.api, module?.SECRET_KEYS);
        const list = key ? module?.secret_state?.[key] : null;
        return (Array.isArray(list) ? list : []).find(item => item?.active)?.id || '';
    }
    async function leaveForm() { await discardPending(); formState = null; renderPanel(); }
    // 直接删除 ST 里的这条连接配置（密钥仍留在 ST 的密钥库）。
    async function deleteProfile(id) {
        const store = manager(), index = store?.profiles?.findIndex(profile => profile?.id === id) ?? -1;
        if (index < 0) return;
        const [removed] = store.profiles.splice(index, 1);
        if (store.selectedProfile === id) { store.selectedProfile = null; const node = nativeSelect(); if (node) node.value = ''; }
        syncOption(id, null);
        write(forgetProfile(state(), id));
        ctx().saveSettingsDebounced?.();
        if (formState?.id === id) formState = null;
        if (openId === id) openId = '';
        await ctx().eventSource?.emit?.(ctx().eventTypes?.CONNECTION_PROFILE_DELETED || 'connection_profile_deleted', removed);
        notify(`已删除「${removed?.name || ''}」`, 'info');
        if (panel?.open) renderPanel();
    }

    async function onPanelClick(event) {
        const target = event.target;
        if (busy && !target.closest('.qm-apiq-close')) return;
        const row = target.closest('.qm-apiq-row');
        const id = row?.dataset.id || '';
        try {
            if (target.closest('.qm-apiq-close')) { closePanel(); return; }
            const option = target.closest('.qm-apiq-combo-opt');
            if (option) { chooseCombo(Number(option.dataset.index)); return; }
            const wrap = target.closest('.qm-apiq-combo');
            if (wrap && target.closest('.qm-apiq-combo-toggle')) { if (combo.wrap === wrap) closeCombo(); else openCombo(wrap); return; }
            if (wrap && target.matches('input')) { if (combo.wrap !== wrap) openCombo(wrap); return; }
            if (target.closest('.qm-apiq-snap-save')) { await saveSnapshot(); return; }
            if (target.closest('.qm-apiq-cancel')) { await leaveForm(); return; }
            if (target.closest('.qm-apiq-fetch')) { await fetchModels(); return; }
            if (target.closest('.qm-apiq-save-use')) { await saveForm(true); return; }
            if (target.closest('.qm-apiq-save')) { await saveForm(false); return; }
            if (target.closest('.qm-apiq-pick')) { await pick(id); return; }
            if (target.closest('.qm-apiq-pin')) { readForm(); write(togglePinned(state(), id)); renderPanel(); return; }
            if (target.closest('.qm-apiq-more')) { readForm(); openId = openId === id ? '' : id; renderPanel(); return; }
            if (target.closest('.qm-apiq-new')) { await secrets(); startForm(); return; }
            if (target.closest('.qm-apiq-edit')) { await secrets(); startForm(id); return; }
            if (target.closest('.qm-apiq-copy')) { await secrets(); startForm(id, {copy: true}); return; }
            if (target.closest('.qm-apiq-del')) { await deleteProfile(id); return; }
            if (target.closest('.qm-apiq-snapshot')) { await secrets(); startSnapshot(); return; }
            if (target.closest('.qm-apiq-group-add')) {
                readForm();
                const name = text(await prompt('新建分组', '分组名：', '') || '');
                if (!name) return;
                write({...state(), groups: [...state().groups, {id: newGroupId(), name, ids: []}]}); renderPanel(); return;
            }
            const rename = target.closest('.qm-apiq-group-rename');
            if (rename) {
                const group = state().groups.find(item => item.id === rename.dataset.group);
                const name = text(await prompt('改组名', '新的分组名：', group?.name || '') || '');
                if (!group || !name) return;
                write({...state(), groups: state().groups.map(item => (item.id === group.id ? {...item, name} : item))}); renderPanel(); return;
            }
            const drop2 = target.closest('.qm-apiq-group-del');
            if (drop2) {
                const group = state().groups.find(item => item.id === drop2.dataset.group);
                if (!group || !await confirm('删除分组', `删除分组「${group.name}」？里面的连接不会删，回到「最近使用」。`)) return;
                write({...state(), groups: state().groups.filter(item => item.id !== group.id)}); renderPanel();
            }
        } catch (error) { notify(error?.message || '操作没有完成', 'warning'); renderPanel(); }
    }
    function onPanelChange(event) {
        const target = event.target;
        if (!formState) return;
        if (target.matches('.qm-apiq-f-source')) { readForm(); void discardPending(); formState.source = target.value; formState.secretId = ''; formState.key = ''; formState.models = []; renderPanel(); }
    }
    function onPanelInput(event) {
        const wrap = event.target.closest?.('.qm-apiq-combo');
        if (wrap && event.target.matches('input')) openCombo(wrap, event.target.value);
        if (formState?.error && event.target.closest('.qm-apiq-form')) { formState.error = ''; panel.querySelector('.qm-apiq-error')?.remove(); }
    }

    return Object.freeze({
        attach, detach, open: openPanel,
        get attached() { return attached; },
        events: Object.freeze({
            // 在 ST 原生里切换／新建／改／删连接时：记最近使用，开着的面板跟着刷新。
            profileLoaded(name) {
                const item = readProfiles(ctx()).profiles.find(profile => profile.name === text(name));
                if (item) write(markUsed(state(), item.id));
                refresh();
            },
            profilesChanged() { refresh(); },
        }),
    });
}
