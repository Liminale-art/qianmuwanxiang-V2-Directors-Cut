// 千幕 API 快切：入口放在 ST「API 连接」面板的「发送测试消息」旁（千幕图标＋小字），前面一个折叠小箭头展开快速切换；
// 点入口进千幕自己的快切面板：新建（填名称、来源、地址、密钥、模型即可，模型可一键获取）、编辑、置顶、分组、最近使用。
// 连接本身就是 ST 原生的「连接配置」（Connection Profiles）；密钥写进 ST 的密钥库，连接只记密钥的编号（secret-id），千幕不存密钥。
// 千幕只存自己的整理（settings.apiSwitch）：置顶、分组、最近使用。配色跟千幕主题走，不受 ST 主题影响。
import {readProfiles, normalizeSwitchState, arrangeProfiles, togglePinned, moveToGroup, markUsed, checkProfileName, presetNames} from './features/chat/qianmu-chat-api-switch.js';

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

// 折叠箭头展开的快选列表：置顶在前，其余按最近使用（没用过的按名字）。
export function quickList(profiles, rawState) {
    const state = normalizeSwitchState(rawState), list = Array.isArray(profiles) ? profiles : [];
    const byId = new Map(list.map(item => [item.id, item]));
    const pinned = state.pinned.map(id => byId.get(id)).filter(Boolean).map(item => ({item, pinned: true}));
    const used = new Set(pinned.map(entry => entry.item.id));
    const rest = list.filter(item => !used.has(item.id))
        .sort((a, b) => (state.recent[b.id] || 0) - (state.recent[a.id] || 0) || a.name.localeCompare(b.name)).map(item => ({item, pinned: false}));
    return [...pinned, ...rest];
}

function tagsOf(item) {
    return [item.api && sourceLabel(item.api), item.model, item.preset && `预设 ${item.preset}`].filter(Boolean);
}
function rowHtml(item, {active = false, pinned = false, open = false, compact = false} = {}) {
    const tags = tagsOf(item).map(tag => `<span class="qm-apiq-tag">${esc(tag)}</span>`).join('');
    const tools = compact ? (pinned ? '<i class="fa-solid fa-thumbtack qm-apiq-pinmark" aria-hidden="true"></i>' : '')
        : `<button type="button" class="qm-apiq-icon qm-apiq-pin${pinned ? ' is-on' : ''}" aria-pressed="${pinned}" title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>
           <button type="button" class="qm-apiq-icon qm-apiq-more" aria-expanded="${open}" title="更多" aria-label="更多"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>`;
    return `<div class="qm-apiq-row${active ? ' is-active' : ''}" data-id="${esc(item.id)}">
        <button type="button" class="qm-apiq-pick" aria-pressed="${active}" title="${active ? '当前连接' : '切换到这条连接'}"><span class="qm-apiq-name">${active ? '<i class="fa-solid fa-circle-check" aria-hidden="true"></i>' : ''}${esc(item.name)}</span><span class="qm-apiq-tags">${tags}</span></button>${tools}
    </div>`;
}
// getContext：ST 上下文；getOwner/save：千幕设置；loadSecrets：载入 ST 的密钥模块；mountPortal：套千幕主题；logoUrl：千幕图标。
export function createApiQuick({getContext, getOwner, save, notify = () => {}, confirm = async () => true, prompt = async () => null,
    loadSecrets, mountPortal, logoUrl: logoSource = '', doc = globalThis.document, fetchImpl = (...args) => globalThis.fetch(...args)} = {}) {
    let portal = null, unmountPortal = null, panel = null, drop = null, dropAnchor = null, stylesheet = null, attached = false;
    let view = 'list', openId = '', formState = null, busy = false;
    const entries = new Set();
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
        doc.body.append(portal);
        try { unmountPortal = mountPortal?.(portal) || null; } catch { unmountPortal = null; }
        return portal;
    }
    // 入口在 ST 的面板里，套不了千幕主题根，只把千幕主题的几个颜色抄过去。
    function paintEntries() {
        const root = ensurePortal(), style = doc.defaultView.getComputedStyle(root);
        for (const entry of entries) {
            for (const name of ['--sd-accent', '--sd-text', '--sd-muted', '--sd-sticky-bg', '--sd-card', '--sd-hairline', '--sd-input-bg', '--sd-font']) {
                const value = style.getPropertyValue(name).trim();
                if (value) entry.style.setProperty(name.replace('--sd-', '--qm-apiq-'), value); else entry.style.removeProperty(name.replace('--sd-', '--qm-apiq-'));
            }
        }
    }

    // ── 入口 ──────────────────────────────────────────────────────────────
    function makeEntry() {
        const entry = make('span', 'qm-apiq-entry');
        entry.dataset.qmApiq = '1';
        const fold = make('button', 'qm-apiq-fold'); fold.type = 'button';
        fold.title = '快速切换连接'; fold.setAttribute('aria-label', '快速切换连接'); fold.setAttribute('aria-expanded', 'false');
        fold.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
        const open = make('button', 'qm-apiq-open'); open.type = 'button';
        open.title = '千幕 API 快切'; open.setAttribute('aria-label', '千幕 API 快切');
        if (logoUrl()) { const img = make('img'); img.src = logoUrl(); img.alt = ''; img.draggable = false; open.append(img); }
        const label = make('span'); label.textContent = '千幕快切'; open.append(label);
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
        if (entries.size) paintEntries();
        return entries.size > 0;
    }
    function detach() {
        attached = false;
        closeDrop(); closePanel();
        for (const entry of entries) entry.remove();
        entries.clear();
        try { unmountPortal?.(); } catch { /* 主题已卸 */ }
        unmountPortal = null; portal?.remove(); portal = null; stylesheet?.remove(); stylesheet = null;
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
        const list = quickList(data.profiles, state());
        drop.innerHTML = `<div class="qm-apiq-drop-list">${list.length ? list.map(({item, pinned}) => rowHtml(item, {active: item.id === data.selected, pinned, compact: true})).join('')
            : '<p class="qm-apiq-empty">还没有连接</p>'}</div>
            <div class="qm-apiq-drop-foot"><button type="button" class="qm-apiq-text qm-apiq-drop-manage">管理连接</button></div>`;
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
        paintEntries();
        dropAnchor = entry;
        drop = make('div', 'qm-apiq-drop');
        drop.setAttribute('role', 'listbox'); drop.setAttribute('aria-label', '快速切换连接');
        ensurePortal().append(drop);
        renderDrop(); placeDrop();
        entry.querySelector('.qm-apiq-fold')?.setAttribute('aria-expanded', 'true');
        drop.addEventListener('click', event => {
            const row = event.target.closest('.qm-apiq-row');
            if (row && event.target.closest('.qm-apiq-pick')) { const id = row.dataset.id; closeDrop(); void pick(id); return; }
            if (event.target.closest('.qm-apiq-drop-manage')) { closeDrop(); openPanel(); }
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
        const s = state(), arranged = arrangeProfiles(data.profiles, s), pinnedIds = new Set(s.pinned);
        const current = data.profiles.find(item => item.id === data.selected);
        const row = item => rowHtml(item, {active: item.id === data.selected, pinned: pinnedIds.has(item.id), open: item.id === openId}) + (item.id === openId ? moreHtml(item, s) : '');
        const block = (id, title, items, head = '') => `<section class="qm-apiq-group" data-group="${esc(id)}"><div class="qm-apiq-group-head"><h4>${esc(title)}</h4>${head}</div>${items.length ? items.map(row).join('') : '<p class="qm-apiq-empty">空</p>'}</section>`;
        const groupHead = group => `<span class="qm-apiq-acts"><button type="button" class="qm-apiq-icon qm-apiq-group-rename" data-group="${esc(group.id)}" title="改组名" aria-label="改组名"><i class="fa-solid fa-pen" aria-hidden="true"></i></button><button type="button" class="qm-apiq-icon qm-apiq-group-del" data-group="${esc(group.id)}" title="删除分组" aria-label="删除分组"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></span>`;
        return `<section class="qm-apiq-current"><h4>当前连接</h4>${current ? rowHtml(current, {active: true, pinned: pinnedIds.has(current.id), compact: true}) : '<p class="qm-apiq-empty">ST 现在没有选中连接</p>'}</section>
            <div class="qm-apiq-tools"><button type="button" class="qm-apiq-text is-primary qm-apiq-new">＋ 新建连接</button><button type="button" class="qm-apiq-text qm-apiq-snapshot" title="把 ST 现在的连接设置（含预设、代理等）存成一条">存下当前设置</button><button type="button" class="qm-apiq-text qm-apiq-group-add">＋ 分组</button></div>
            ${arranged.pinned.length ? block('pinned', '置顶', arranged.pinned) : ''}
            ${arranged.groups.map(group => block(group.id, group.name, group.items, groupHead(group))).join('')}
            ${block('others', '最近使用', arranged.others)}`;
    }
    function moreHtml(item, s) {
        const inGroup = s.groups.find(group => group.ids.includes(item.id))?.id || '';
        const options = [`<option value=""${inGroup ? '' : ' selected'}>不放进分组</option>`, ...s.groups.map(group => `<option value="${esc(group.id)}"${group.id === inGroup ? ' selected' : ''}>${esc(group.name)}</option>`)].join('');
        return `<div class="qm-apiq-menu" data-id="${esc(item.id)}">
            ${item.mode === 'cc' ? '<button type="button" class="qm-apiq-text qm-apiq-edit">编辑</button>' : ''}
            <label class="qm-apiq-move"><span>分组</span><select class="qm-apiq-group-pick" aria-label="移到分组">${options}</select></label>
            <button type="button" class="qm-apiq-text is-danger qm-apiq-del">删除</button>
        </div>`;
    }
    function formHtml(f, secrets) {
        const sources = sourceOptions(doc), key = secretKeyFor(f.source, secrets?.SECRET_KEYS);
        const saved = key && Array.isArray(secrets?.secret_state?.[key]) ? secrets.secret_state[key] : [];
        const presets = presetNames(ctx(), 'cc');
        const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
        const field = (label, body, cls = '') => `<label class="qm-apiq-field${cls ? ` ${cls}` : ''}"><span>${label}</span>${body}</label>`;
        const models = f.models.length ? `<select class="qm-apiq-f-modelpick" aria-label="选择模型">${option('', `从 ${f.models.length} 个模型中选`, !f.models.includes(f.model))}${f.models.map(id => option(id, id, id === f.model)).join('')}</select>` : '';
        return `<form class="qm-apiq-form" novalidate>
            ${field('名称', `<input class="qm-apiq-f-name" value="${esc(f.name)}" maxlength="80" autocomplete="off" spellcheck="false">`)}
            ${field('来源', `<select class="qm-apiq-f-source">${sources.map(item => option(item.value, item.label, item.value === f.source)).join('')}</select>`)}
            ${f.source === 'custom' ? field('服务地址', `<input class="qm-apiq-f-url" value="${esc(f.url)}" placeholder="https://…/v1" autocomplete="off" spellcheck="false" inputmode="url">`) : ''}
            ${key ? field('密钥', `<input class="qm-apiq-f-key" type="password" value="${esc(f.key)}" placeholder="${saved.length || f.secretId ? '留空沿用下面选的' : '粘贴密钥'}" autocomplete="new-password" spellcheck="false">
                ${saved.length ? `<select class="qm-apiq-f-secret" aria-label="已存的密钥">${option('', '不指定（用 ST 当前的）', !f.secretId)}${saved.map(item => option(item.id, `${item.label || '未命名'}${item.value ? ` · ${item.value}` : ''}`, item.id === f.secretId)).join('')}</select>` : ''}`) : ''}
            ${field('模型', `<span class="qm-apiq-inline"><input class="qm-apiq-f-model" value="${esc(f.model)}" placeholder="可留空" autocomplete="off" spellcheck="false"><button type="button" class="qm-apiq-text qm-apiq-fetch"${f.fetching ? ' disabled' : ''}>${f.fetching ? '获取中…' : '获取模型'}</button></span>${models}`)}
            ${field('预设', `<select class="qm-apiq-f-preset">${option('', '不切换预设', !f.preset)}${[...new Set([...(f.preset ? [f.preset] : []), ...presets])].map(name => option(name, name, name === f.preset)).join('')}</select>`)}
            ${f.error ? `<p class="qm-apiq-error" role="alert">${esc(f.error)}</p>` : ''}
            <div class="qm-apiq-form-acts"><button type="button" class="qm-apiq-text qm-apiq-cancel">取消</button><button type="button" class="qm-apiq-text qm-apiq-save">保存</button><button type="button" class="qm-apiq-text is-primary qm-apiq-save-use">保存并切换</button></div>
        </form>`;
    }
    let secretsModule = null;
    async function secrets() {
        if (secretsModule) return secretsModule;
        try { secretsModule = await loadSecrets?.(); } catch { secretsModule = null; }
        return secretsModule;
    }
    function renderPanel() {
        if (!panel) return;
        const body = panel.querySelector('.qm-apiq-body'), title = panel.querySelector('.qm-apiq-title'), back = panel.querySelector('.qm-apiq-back');
        back.hidden = view !== 'form';
        if (view === 'form' && formState) {
            title.textContent = formState.id ? '编辑连接' : '新建连接';
            body.innerHTML = formHtml(formState, secretsModule);
        } else {
            title.textContent = 'API 快切';
            body.innerHTML = listHtml();
        }
        panel.classList.toggle('is-busy', busy);
    }
    function openPanel() {
        const root = ensurePortal();
        if (!panel) {
            panel = make('dialog', 'qm-apiq-panel');
            panel.setAttribute('aria-label', 'API 快切');
            panel.innerHTML = `<header class="qm-apiq-head"><button type="button" class="qm-apiq-icon qm-apiq-back" aria-label="返回" title="返回" hidden><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
                <img class="qm-apiq-logo" alt="" draggable="false"${logoUrl() ? ` src="${esc(logoUrl())}"` : ' hidden'}><b class="qm-apiq-title">API 快切</b>
                <button type="button" class="qm-apiq-icon qm-apiq-close" aria-label="关闭" title="关闭"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header>
                <div class="qm-apiq-body"></div>`;
            panel.addEventListener('click', event => { void onPanelClick(event); });
            panel.addEventListener('change', onPanelChange);
            panel.addEventListener('input', onPanelInput);
            panel.addEventListener('cancel', event => { event.preventDefault(); if (view === 'form') void leaveForm(); else closePanel(); });
            for (const type of ['keydown', 'keyup', 'keypress']) panel.addEventListener(type, event => event.stopPropagation());
            panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); if (view === 'form') void leaveForm(); else closePanel(); } });
        }
        if (!panel.isConnected) root.append(panel);
        view = 'list'; openId = ''; formState = null;
        renderPanel();
        if (!panel.open) panel.showModal();
        void secrets();
    }
    function closePanel() {
        if (!panel) return;
        void discardPending();
        if (panel.open) panel.close();
        panel.remove(); view = 'list'; openId = ''; formState = null;
    }

    // ── 新建与编辑 ────────────────────────────────────────────────────────
    function startForm(id = '') {
        const raw = id ? (manager()?.profiles || []).find(item => item?.id === id) : null;
        const sources = sourceOptions(doc);
        formState = raw
            ? {id, name: raw.name || '', source: text(raw.api) === 'google' ? 'makersuite' : text(raw.api) || 'custom', url: raw['api-url'] || '', key: '', secretId: raw['secret-id'] || '', model: raw.model || '', preset: raw.preset || '', models: [], pending: null, error: ''}
            : {id: '', name: '', source: sources.some(item => item.value === 'custom') ? 'custom' : sources[0]?.value || 'custom', url: '', key: '', secretId: '', model: '', preset: '', models: [], pending: null, error: ''};
        view = 'form'; openId = ''; renderPanel();
        panel.querySelector('.qm-apiq-f-name')?.focus();
    }
    function readForm() {
        const form = panel?.querySelector('.qm-apiq-form');
        if (!form || !formState) return;
        const value = cls => form.querySelector(cls)?.value;
        formState.name = value('.qm-apiq-f-name') ?? formState.name;
        formState.url = value('.qm-apiq-f-url') ?? formState.url;
        formState.key = value('.qm-apiq-f-key') ?? formState.key;
        formState.secretId = value('.qm-apiq-f-secret') ?? formState.secretId;
        formState.model = value('.qm-apiq-f-model') ?? formState.model;
        formState.preset = value('.qm-apiq-f-preset') ?? formState.preset;
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
            else if (key && formState.secretId && typeof module?.rotateSecret === 'function') {
                const active = (module.secret_state?.[key] || []).find(item => item.active)?.id || '';
                if (active !== formState.secretId) await module.rotateSecret(key, formState.secretId);
            }
            const body = {chat_completion_source: formState.source === 'google' ? 'makersuite' : formState.source, reverse_proxy: '', proxy_password: ''};
            if (formState.source === 'custom') body.custom_url = text(formState.url);
            const response = await fetchImpl('/api/backends/chat-completions/status', {method: 'POST', headers: ctx().getRequestHeaders?.() || {'Content-Type': 'application/json'}, body: JSON.stringify(body), cache: 'no-cache'});
            const data = response.ok ? await response.json() : null;
            if (!data || data.error || !Array.isArray(data.data)) throw new Error('没取到模型，请检查地址与密钥');
            formState.models = [...new Set(data.data.map(item => text(item?.id)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            if (!formState.models.length) throw new Error('这个服务没有返回模型');
            if (!formState.model) formState.model = formState.models[0];
        } catch (error) { formState.error = error?.message || '没取到模型'; }
        finally { formState.fetching = false; renderPanel(); }
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
            const profile = buildProfile(existing, {...formState, secretId: typed || formState.secretId});
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
            view = 'list'; formState = null;
            if (andSwitch || wasCurrent) await apply(id);
            notify(andSwitch ? `已保存并切换到「${profile.name}」` : `已保存「${profile.name}」`, 'success');
        } catch (error) {
            if (formState) formState.error = error?.message || '没有保存成功';
            else notify(error?.message || '切换没有完成', 'warning');
        } finally { busy = false; renderPanel(); }
    }
    async function leaveForm() { await discardPending(); view = 'list'; formState = null; renderPanel(); }

    async function onPanelClick(event) {
        const target = event.target;
        if (busy && !target.closest('.qm-apiq-close')) return;
        const row = target.closest('.qm-apiq-row, .qm-apiq-menu');
        const id = row?.dataset.id || '';
        try {
            if (target.closest('.qm-apiq-close')) { closePanel(); return; }
            if (target.closest('.qm-apiq-back') || target.closest('.qm-apiq-cancel')) { await leaveForm(); return; }
            if (target.closest('.qm-apiq-fetch')) { await fetchModels(); return; }
            if (target.closest('.qm-apiq-save-use')) { await saveForm(true); return; }
            if (target.closest('.qm-apiq-save')) { await saveForm(false); return; }
            if (target.closest('.qm-apiq-pick')) { await pick(id); return; }
            if (target.closest('.qm-apiq-pin')) { write(togglePinned(state(), id)); renderPanel(); return; }
            if (target.closest('.qm-apiq-more')) { openId = openId === id ? '' : id; renderPanel(); return; }
            if (target.closest('.qm-apiq-new')) { await secrets(); startForm(); return; }
            if (target.closest('.qm-apiq-edit')) { await secrets(); startForm(id); return; }
            if (target.closest('.qm-apiq-del')) {
                const item = readProfiles(ctx()).profiles.find(profile => profile.id === id);
                if (!item || !await confirm('删除连接', `删除 ST 里的连接配置「${item.name}」？不可恢复。`)) return;
                const store = manager(), index = store.profiles.findIndex(profile => profile?.id === id);
                if (index < 0) return;
                const [removed] = store.profiles.splice(index, 1);
                if (store.selectedProfile === id) { store.selectedProfile = null; const node = nativeSelect(); if (node) node.value = ''; }
                syncOption(id, null);
                write({...moveToGroup(state(), id, ''), pinned: state().pinned.filter(item2 => item2 !== id)});
                ctx().saveSettingsDebounced?.();
                await ctx().eventSource?.emit?.(ctx().eventTypes?.CONNECTION_PROFILE_DELETED || 'connection_profile_deleted', removed);
                openId = ''; notify('已删除。', 'info'); renderPanel(); return;
            }
            if (target.closest('.qm-apiq-snapshot')) {
                const name = text(await prompt('存下当前设置', '用 ST 现在的连接设置存一条，起个名：', '') || '');
                if (!name) return;
                const problem = checkProfileName(name, readProfiles(ctx()).profiles);
                if (problem) { notify(problem, 'warning'); return; }
                const run = ctx().executeSlashCommandsWithOptions;
                if (typeof run !== 'function') throw new Error('当前 ST 不支持在此新建连接');
                await run(`/profile-create ${name}`, {handleParserErrors: true, handleExecutionErrors: true});
                const made = readProfiles(ctx()).profiles.find(item => item.name === name);
                if (!made) throw new Error('ST 没有建成这条连接');
                write(markUsed(state(), made.id)); notify(`已存下「${made.name}」`, 'success'); renderPanel(); return;
            }
            if (target.closest('.qm-apiq-group-add')) {
                const name = text(await prompt('新建分组', '分组名：', '') || '');
                if (!name) return;
                write({...state(), groups: [...state().groups, {id: `grp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, ids: []}]}); renderPanel(); return;
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
        if (target.closest('.qm-apiq-group-pick')) { write(moveToGroup(state(), target.closest('.qm-apiq-menu').dataset.id, target.value)); openId = ''; renderPanel(); return; }
        if (!formState) return;
        if (target.matches('.qm-apiq-f-source')) { readForm(); void discardPending(); formState.source = target.value; formState.secretId = ''; formState.key = ''; formState.models = []; renderPanel(); return; }
        if (target.matches('.qm-apiq-f-modelpick') && target.value) { readForm(); formState.model = target.value; panel.querySelector('.qm-apiq-f-model').value = target.value; }
    }
    function onPanelInput(event) { if (formState?.error && event.target.closest('.qm-apiq-form')) { formState.error = ''; panel.querySelector('.qm-apiq-error')?.remove(); } }

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
