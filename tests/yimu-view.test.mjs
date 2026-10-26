import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createView, mountEntries, orderedEntries, sourceLabel, groupMemoryEntries, shortcutStatus } from '../yimu/view.mjs';
import { boot } from '../yimu/index.mjs';
import { createApiSettings } from '../yimu/api-settings.mjs';

// Isolated DOM/event fixture. It proves operations and retained drafts, not layout or a live ST session.
function dom() {
    const document = { activeElement: null };
    const all = node => node.children.flatMap(child => [child, ...all(child)]);
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
            this.attrs = {}; this.dataset = {}; this.events = new Map(); this.className = '';
            this.disabled = false; this.hidden = false; this.value = ''; this.checked = false;
            this.open = false; this.id = ''; this._text = ''; this.ownerDocument = document;
        }
        get parentElement() { return this.parentNode; }
        get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
        get isConnected() { return this === document.body || this.parentNode?.isConnected === true; }
        set textContent(text) { this._text = String(text); for (const node of this.children) node.parentNode = null; this.children = []; }
        get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
        set innerHTML(value) {
            if (this.className !== 'ym-icon' || !value.startsWith('<svg ') || /script|onerror|javascript:/i.test(value)) throw Error('Untrusted markup must not be parsed');
            this._svg = value;
        }
        append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentNode = this; } }
        insertBefore(node, reference) {
            if (node === reference) return;
            node.remove(); const index = reference ? this.children.indexOf(reference) : -1;
            if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
            node.parentNode = this;
        }
        replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
        setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'hidden') this.hidden = true; if (name === 'open') this.open = true; }
        removeAttribute(name) { delete this.attrs[name]; if (name === 'hidden') this.hidden = false; if (name === 'open') this.open = false; }
        getAttribute(name) { return this.attrs[name] ?? null; }
        matches(selector) {
            if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
            if (selector.startsWith('#')) return this.id === selector.slice(1);
            if (selector.startsWith('[')) {
                const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
                const actual = name?.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : name === 'hidden' ? this.hidden ? '' : undefined : this.attrs[name];
                return value === undefined ? actual !== undefined : actual === value;
            }
            return this.tagName.toLowerCase() === selector;
        }
        querySelectorAll(selector) { return all(this).filter(node => selector.split(',').some(part => node.matches(part.trim()))); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
        addEventListener(name, handler) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(handler); }
        emit(name, extra = {}) {
            const event = { target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
            for (const handler of this.events.get(name) || []) handler(event);
            return event;
        }
        click() { if (!this.disabled) this.emit('click'); }
        requestSubmit() { this.emit('submit'); }
        focus() { document.activeElement = this; }
        showModal() { this.open = true; }
        close() { this.open = false; this.emit('close'); }
    }
    document.createElement = tag => new Element(tag);
    document.body = new Element('body');
    document.getElementById = id => all(document.body).find(node => node.id === id) || null;
    document.querySelector = selector => {
        let current = document.body;
        for (const part of selector.split(/\s+/)) current = current?.querySelector(part);
        return current || null;
    };
    document.defaultView = { getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block' }) };
    return { document, all: () => all(document.body), get: label => all(document.body).find(node => node.attrs['aria-label'] === label), text: text => all(document.body).find(node => node.tagName === 'BUTTON' && node.textContent === text), async flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}
const entry = (patch = {}) => {
    const value = { id: 'slice-a', revision: 2, kind: 'summary', text: '两人第一次约会。甲没有得知乙的秘密。', source: { start: 1, end: 3 }, status: 'active', edited: false, history: [], conflicts: [], ...patch };
    if (value.source && Number.isSafeInteger(value.source.start) && Number.isSafeInteger(value.source.end)) {
        value.source = { ...value.source, hashes: Array.from({ length: value.source.end - value.source.start + 1 }, (_, i) => /^[a-f0-9]{64}$/.test(value.source.hashes?.[i]) ? value.source.hashes[i] : 'a'.repeat(64)) };
    }
    return value;
};
// The overview has a prompt-group tab with the same visible title; select the memory action, not that separate editor tab.
const stageControl = f => f.all().find(node => node.attrs['aria-label'] === '阶段总结' && !node.closest('.ym-prompts'));
const stage = (parents, patch = {}) => entry({ id: 'stage-one', kind: 'stage', text: '这段经历改变了两人的关系。', source: { ranges: parents.map(parent => parent.source), parents: parents.map(parent => ({ id: parent.id, revision: parent.revision })) }, ...patch });
const excerpt = (patch = {}) => entry({ id: 'excerpt-one', kind: 'excerpt', text: '原文补充', parent: { id: 'slice-a', revision: 2 },
    source: { start: 2, end: 2, hashes: ['b'] }, quote: { start: 0, end: 19 }, quoteText: '甲将那封信藏进抽屉，尚未让乙知道。', quoteSpeaker: '甲', ...patch });
const state = (patch = {}) => ({
    snapshot: { binding: { avatar: '角色.png', file: '聊天', integrity: 'uuid-fixture' }, name: '角色', messages: Array.from({ length: 9 }, () => ({ mes: 'fixture' })) },
    document: { enabled: false, configRevision: 0, settings: {}, initialRange: null, entries: [] },
    defaults: { revision: 0, values: { recent: 5, trigger: 4000, batch: 6000, budget: 0, preference: '', profileId: '', model: '' } },
    loading: false, busy: false, error: '', profiles: [{ id: 'custom-profile', name: '独立连接' }], ...patch,
});

test('backup accepts several files immediately and file-picker cancellation stays local', async () => {
    const d=dom(),calls=[],view=createView({document:d.document,onAction:async(...args)=>calls.push(args)});
    view.render(state({snapshot:null,document:null,defaults:null,service:{status:'ok'}}));view.open();
    d.get('展开记忆备份').click();
    const choose=d.get('导入备份'),picker=d.get('忆幕备份文件');assert.equal(picker.multiple,true);
    let opened=0;picker.addEventListener('click',()=>opened++);choose.click();assert.equal(opened,1);assert.deepEqual(calls,[]);
    const files=[{name:'one.yimu.gz'},{name:'two.yimu.gz'}];picker.files=files;picker.emit('change');await d.flush();
    assert.deepEqual(calls,[['backupImport',{files}]]);assert.equal(d.get('确认上传备份包'),undefined);assert.equal(d.get('已导入备份'),undefined);
    const cancel=picker.emit('cancel');assert.equal(cancel.stopped,true);assert.equal(d.get('忆幕').open,true);view.destroy();
});

test('backup disables actions during processing and reports each file without hiding another result', async () => {
    const d=dom(),view=createView({document:d.document,onAction:async()=>{}});
    view.render(state({service:{status:'ok'},backup:{busy:true,items:[{id:'a',name:'one.yimu.gz',status:'uploading'},{id:'b',name:'two.yimu.gz',status:'complete',message:'内容相同，已跳过'}]}}));
    assert.equal(d.get('导入备份').disabled,true);assert.match(d.document.body.textContent,/one.yimu.gz/);assert.match(d.document.body.textContent,/正在读取并核对备份/);assert.match(d.document.body.textContent,/内容相同，已跳过/);
    view.render(state({service:{status:'error'}}));assert.equal(d.get('导入备份').disabled,true);view.destroy();
});

test('backup exports in one action and original attachments remain an independent opt-in', async () => {
    const d=dom(),calls=[],view=createView({document:d.document,onAction:async(...args)=>calls.push(args)});
    const s=state({backup:{exportPlan:{planId:'p',binding:state().snapshot.binding,primarySourceId:'main',sources:[{id:'main',label:'Main',available:true},{id:'ancestor',label:'Ancestor',available:true}]}}});
    view.render(s);assert.equal(d.get('附带ST聊天原件').checked,false);d.get('导出当前记忆').click();await d.flush();assert.deepEqual(calls[0],['backupQuickExport',{includeOriginals:false}]);
    d.get('附带ST聊天原件').checked=true;d.get('附带ST聊天原件').emit('change');await d.flush();
    assert.equal(d.get('Main').checked,true);assert.equal(d.get('Ancestor').checked,false);d.get('Ancestor').checked=true;
    d.get('导出当前记忆').click();await d.flush();assert.deepEqual(calls.at(-1),['backupQuickExport',{includeOriginals:true,planId:'p',sourceIds:['main','ancestor']}]);view.destroy();
});

test('ambiguous imports show only a target choice or cancellation and keep raw text out of the panel', async () => {
    const d=dom(),calls=[],view=createView({document:d.document,onAction:async(...args)=>calls.push(args)});
    const target=state().snapshot.binding;
    view.render(state({backup:{items:[{id:'a',name:'<img>.yimu.gz',status:'selection',archive:{sources:[]},candidates:[{binding:target,label:'原聊天',exact:true}]}]}}));
    const select=d.get('导入目标 <img>.yimu.gz');assert.equal(d.get('确认导入至所选目标').disabled,true);
    select.value='chat:0';select.emit('change');d.get('确认导入至所选目标').click();await d.flush();
    assert.deepEqual(calls[0],['backupResolve',{itemId:'a',targetBinding:target}]);assert.equal(d.document.querySelector('.ym-backup').querySelector('img'),null);view.destroy();
});

function fixture(patch, handler) {
    const d = dom(), calls = [];
    const view = createView({ document: d.document, onAction: async (type, payload) => { calls.push({ type, payload }); return handler?.(type, payload); } });
    let current = state(patch); view.render(current);
    return { ...d, calls, view, render(next) { current = { ...current, ...next }; view.render(current); }, get state() { return current; } };
}

const storyPlan = (binding, patch = {}) => ({ planId: 'plan-one', sourceBinding: binding, mode: 'continue', cutoff: 9,
    total: 9, recent: 5, bridgeCount: 5, inheritedCount: 2, manualChoices: [], boundaries: [], ...patch });


test('story defaults to the last floor and needs only one create action', async t => {
    const f=fixture();t.after(()=>f.view.destroy());f.view.open();
    assert.equal(f.get('续接楼层').value,'9');assert.equal(f.calls.length,0);assert.equal(f.get('故事延续方式'),undefined);assert.equal(f.get('预览带入内容'),undefined);
    f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.calls,[{type:'storyContinue',payload:{cutoff:9}}]);
});

test('story preserves an edited cutoff across ordinary rendering and validates it before action', async t => {
    const f=fixture();t.after(()=>f.view.destroy());f.get('续接楼层').value='4';f.get('续接楼层').emit('input');f.render({story:{status:''}});
    assert.equal(f.get('续接楼层').value,'4');f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.calls.at(-1),{type:'storyContinue',payload:{cutoff:4}});
    f.get('续接楼层').value='999';f.get('建立新聊天').click();await f.flush();assert.equal(f.calls.length,1);assert.match(f.document.body.textContent,/有效的续接楼层/);
});

test('story never renders artificial choices or cutoff-crossing prose as part of its controls', t => {
    const f=fixture();t.after(()=>f.view.destroy());
    f.render({story:{plan:storyPlan(f.state.snapshot.binding,{manualChoices:[{id:'future',text:'不应显示的未来剧情'}]})}});
    assert.doesNotMatch(f.document.body.textContent,/不应显示的未来剧情/);assert.equal(f.get('人工记忆取舍 future'),undefined);
});

test('unknown story results can only retry the same operation; completed results do not create again', async t => {
    const f=fixture();t.after(()=>f.view.destroy());f.render({story:{pending:true,error:'连接中断'}});
    assert.equal(f.get('建立新聊天').disabled,true);assert.equal(f.get('续接楼层').disabled,true);f.get('继续本次建立').click();await f.flush();assert.deepEqual(f.calls.at(-1),{type:'storyCreate',payload:{retry:true}});
    f.render({story:{result:{receipt:{status:'complete',target:{file:'已确认分支'}}}}});assert.equal(f.get('建立新聊天').disabled,true);
    f.get('打开已建立的聊天').click();await f.flush();assert.deepEqual(f.calls.at(-1),{type:'storyOpen',payload:{}});
});

test('inherited entries retain source chat labels and edit controls but do not offer automatic rewriting', t => {
    const inherited = entry({ origin: { binding: { file: '原故事' }, offset: 0 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [inherited] } }); t.after(() => f.view.destroy());
    assert.equal(sourceLabel(inherited), '原故事 · 第 1–3 层');
    assert.ok(f.get('编辑原故事 · 第 1–3 层')); assert.equal(f.get('重新总结原故事 · 第 1–3 层'), undefined);
});


test('story failures stay visible once inside the story tool', async t => {
    const f=fixture({},async type=>{if(type==='storyContinue')throw Error('故事建立未完成');});t.after(()=>f.view.destroy());
    f.get('建立新聊天').click();await f.flush();assert.equal(f.document.body.textContent.split('故事建立未完成').length-1,1);
});

test('opening a panel only displays its frontend and does not enable, summarize or save', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    f.view.open(); assert.equal(f.get('忆幕').open, true);
    assert.equal(f.calls.length, 0); assert.equal(f.get('启用忆幕').checked, false);
    assert.equal(f.get('整理未覆盖内容'), undefined);
    assert.equal(f.get('开始总结').disabled, true);
    assert.equal(f.get('忆幕').querySelectorAll('.ym-memory').length, 0);
});

test('the input shortcut preference is available in settings without a chat and separate from per-chat memory enable', async t => {
    const f = fixture({ snapshot: null, document: null, defaults: null }); t.after(() => f.view.destroy());
    f.get('设置').click();
    const toggle = f.get('显示输入栏快捷入口');
    assert.equal(toggle.checked, false); assert.equal(toggle.closest('[hidden]'), null); assert.equal(toggle.disabled, false);
    toggle.checked = true; toggle.emit('change'); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'uiSettings', payload: { showShortcut: true } }]);
    f.render({ ui: { showShortcut: true } }); assert.equal(toggle.checked, true);
    f.render({ snapshot: state().snapshot, document: state().document });
    assert.equal(toggle.checked, true); assert.equal(f.get('启用忆幕').checked, false);
    toggle.checked = false; toggle.emit('change'); await f.flush();
    assert.deepEqual(f.calls[1], { type: 'uiSettings', payload: { showShortcut: false } });
});

test('first card has independent master and automatic switches, manual stays available when auto is off', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const master = f.get('启用忆幕'), automatic = f.get('自动总结');
    assert.ok(master.closest('.ym-hero-switches'));
    assert.equal(master.closest('.ym-hero-switches'), automatic.closest('.ym-hero-switches'));
    assert.equal(master.closest('.ym-hero'), null, 'switches are now a separate card above the chat card');
    assert.equal(automatic.disabled, true); assert.equal(f.get('开始总结').disabled, true);
    master.checked = true; master.emit('change'); await f.flush();
    assert.deepEqual(f.calls, [{type: 'enable', payload: {enabled: true}}]);
    f.render({document: {...f.state.document, enabled: true, autoSummary: false}});
    assert.equal(automatic.disabled, false); assert.equal(f.get('开始总结').disabled, false);
    automatic.checked = true; automatic.emit('change'); await f.flush();
    assert.deepEqual(f.calls.at(-1), {type: 'autoSummary', payload: {value: true}});
    assert.equal(f.get('自动总结').closest('.ym-hero-switches'), master.closest('.ym-hero-switches'));
});

test('API profile editing is one account connection and numeric scope switches never rewrite it or server settings', async t => {
    const d = dom(), calls = [], ctx = { extensionSettings: {}, saveSettingsDebounced: async () => {} };
    const connectionApi = createApiSettings({ getContext: () => ctx });
    const view = createView({ document: d.document, connectionApi, onAction: async (type, payload) => { calls.push({type,payload}); } });
    t.after(() => view.destroy());
    view.render(state({ profiles: [{id:'global-profile',name:'全局连接'},{id:'chat-profile',name:'聊天连接'}],
        defaults:{revision:7,values:{...state().defaults.values,profileId:'global-profile',model:'global-model'}},
        document:{...state().document,settings:{profileId:'chat-profile',model:'chat-model'}} }));
    d.get('设置').click();
    assert.equal(d.get('ST 连接预设').value,'chat-profile'); assert.equal(connectionApi.read().mode,'inherit');
    d.get('整理连接方式').value='profile'; d.get('整理连接方式').emit('change'); await d.flush();
    assert.equal(connectionApi.read().profileConfigured,true);
    d.get('全局默认').click();
    assert.equal(d.get('ST 连接预设').value,'chat-profile'); assert.equal(d.get('ST 连接模型').value,'chat-model');
    d.get('ST 连接模型').value='new-account-model'; d.get('ST 连接模型').emit('change'); await d.flush();
    assert.equal(connectionApi.read().profileModel,'new-account-model'); assert.deepEqual(calls,[]);
    d.get('当前聊天').click(); assert.equal(d.get('ST 连接预设').value,'chat-profile'); assert.equal(d.get('ST 连接模型').value,'new-account-model');
    assert.deepEqual(calls,[], 'the numeric scope selector cannot submit or migrate account API choices');
});

test('unacknowledged invalid slices never inflate coverage and the pending shortcut fills only uncovered floors', t => {
    const f=fixture({document:{...state().document,enabled:true,initialRange:{start:1,end:9,total:9},entries:[entry()]},invalidSourceIds:['slice-a']});
    t.after(()=>f.view.destroy());
    const values=f.document.querySelector('.ym-stats').querySelectorAll('b');
    assert.equal(values[0].textContent,'0'); assert.equal(values[1].textContent,'0');
    f.get('待整理层').click();
    assert.equal(f.get('手动总结开始楼层').value,'1'); assert.equal(f.get('手动总结结束楼层').value,'4');
});

test('compact history controls edit explicit bounds and persist cancellation rather than hiding a temporary form', async t => {
    const f = fixture({document: {...state().document, enabled: true}}); t.after(() => f.view.destroy());
    assert.match(f.document.querySelector('.ym-history-question').textContent, /是否整理历史楼层 1–9/);
    f.get('调整历史楼层').click();
    f.get('历史开始楼层').value = '8'; f.get('历史结束楼层').value = '3';
    f.get('确认整理历史').click(); await f.flush(); assert.equal(f.calls.length, 0);
    f.get('历史开始楼层').value = '2'; f.get('历史结束楼层').value = '8';
    f.get('确认整理历史').click(); await f.flush();
    assert.deepEqual(f.calls[0], {type: 'history', payload: {range: {start: 2, end: 8, total: 9}}});
    f.get('不整理历史').click(); await f.flush();
    assert.deepEqual(f.calls[1], {type: 'history', payload: {range: {start: 1, end: 0, total: 9}}});
    f.render({document: {...f.state.document, initialRange: {start:1,end:0,total:9}}});
    f.view.close(); f.view.open();
    assert.equal(f.document.querySelector('.ym-history-range').hidden, true);
    assert.equal(f.get('开始总结').disabled, false);
});

test('hidden prose remains available for explicit summary and the panel never changes its ST flags', async t => {
    const messages = Array.from({length:11},(_,i)=>({mes:'正文'+i,is_system:i<5}));
    const original = structuredClone(messages);
    const f = fixture({snapshot:{...state().snapshot,messages},document:{...state().document,enabled:true,autoSummary:false}});
    t.after(()=>f.view.destroy());
    f.get('手动总结开始楼层').value='1'; f.get('手动总结结束楼层').value='5';
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls[0], {type:'summarizeRange',payload:{range:{start:1,end:5},expectedRange:{start:1,end:5}}});
    assert.deepEqual(messages,original); assert.doesNotMatch(f.document.body.textContent,/已被 ST 隐藏.*不参与整理/);
});

test('partial slice selection is visibly expanded and requires another explicit start before any call', async t => {
    const f=fixture({document:{...state().document,enabled:true,entries:[entry({source:{start:1,end:3}})]}});
    t.after(()=>f.view.destroy());
    f.get('手动总结开始楼层').value='2'; f.get('手动总结结束楼层').value='2';
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls,[]); assert.equal(f.get('手动总结开始楼层').value,'1');
    assert.equal(f.get('手动总结结束楼层').value,'3');
    assert.match(f.document.querySelector('.ym-manual-range').textContent,/请确认后开始/);
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls[0],{type:'summarizeRange',payload:{range:{start:1,end:3},expectedRange:{start:1,end:3}}});
});

test('history and manual range controls are disabled by the master switch and no hidden enabling is submitted', async t => {
    const f=fixture(); t.after(()=>f.view.destroy());
    f.get('开始总结').click(); f.get('确认整理历史').click(); f.get('自动总结').click();
    await f.flush(); assert.deepEqual(f.calls,[]);
    f.render({snapshot:{...f.state.snapshot,messages:[]}});
    assert.equal(f.document.querySelector('.ym-history-range').hidden,true);
    const master=f.get('启用忆幕'); master.checked=true; master.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0],{type:'enable',payload:{enabled:true}});
});

test('background work never disables the per-chat off action, and reopening a known chat does not ask initial range again', async t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [], initialRange: { start: 1, end: 9, total: 9 } }, busy: true }); t.after(() => f.view.destroy());
    const toggle = f.get('启用忆幕'); assert.equal(toggle.disabled, false);
    toggle.checked = false; toggle.emit('change'); await f.flush(); assert.deepEqual(f.calls[0], { type: 'enable', payload: { enabled: false } });
    toggle.checked = true; toggle.emit('change'); await f.flush(); assert.deepEqual(f.calls[1], { type: 'enable', payload: { enabled: true } });
});

test('source ordering excludes deleted entries and preserves explicit source-free manual supplements', () => {
    const items = [entry({ id: 'manual', source: null, kind: 'manual' }), entry({ id: 'later', source: { start: 8, end: 12 } }), entry(), entry({ id: 'deleted', status: 'deleted' })];
    assert.deepEqual(orderedEntries(items).map(item => item.id), ['slice-a', 'later', 'manual']);
    assert.equal(sourceLabel(items[0]), '自定义切片'); assert.equal(sourceLabel(items[2]), '第 1–3 层');
});

test('stage labels retain genuine gaps instead of falsely claiming the whole min-max interval', () => {
    const first = entry(), next = entry({ id: 'slice-b', source: { start: 7, end: 9, hashes: ['d', 'e', 'f'] } });
    assert.equal(sourceLabel(stage([first, next])), '阶段摘要 · 第 1–3、7–9 层');
    const adjacent = entry({ id: 'slice-c', source: { start: 4, end: 6, hashes: ['x', 'y', 'z'] } });
    assert.equal(sourceLabel(stage([first, adjacent])), '阶段摘要 · 第 1–6 层');
});

test('only active stages with exact valid unedited parents group their fine memories, each fine once', () => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } }), manual = entry({ id: 'manual', source: null, kind: 'manual', edited: true });
    const overview = stage([one, two]);
    const grouped = groupMemoryEntries([manual, two, overview, one]);
    assert.deepEqual(grouped.map(group => group.entry.id), ['stage-one', 'manual']);
    assert.deepEqual(grouped[0].children.map(child => child.id), ['slice-a', 'slice-b']);
    const invalid = groupMemoryEntries([overview, { ...one, revision: 3 }, two]);
    assert.equal(invalid[0].entry.status, 'invalid'); assert.equal(invalid[0].children.length, 0);
    assert.deepEqual(invalid.slice(1).map(group => group.entry.id), ['slice-a', 'slice-b']);
    const protectedFine = groupMemoryEntries([overview, { ...one, edited: true }, two]);
    assert.equal(protectedFine[0].entry.status, 'invalid'); assert.equal(protectedFine.length, 3);
    assert.equal(overview.status, 'active', 'the UI does not rewrite canonical validity');
});

test('stages render fine cards in retained collapsible groups and leave ungrouped fine cards directly visible', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } }), loose = entry({ id: 'slice-c', source: { start: 7, end: 9 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two, loose, stage([one, two])] } }); t.after(() => f.view.destroy());
    const list = f.get('忆幕').querySelector('.ym-list'), group = f.get('忆幕').querySelector('.ym-stage-children');
    assert.equal(list.children.length, 2); assert.equal(group.open, false);
    assert.equal(group.querySelectorAll('.ym-memory').length, 2);
    assert.match(group.querySelector('summary').textContent, /记忆切片（2）/);
    group.open = true; f.render({ status: '其他条目正在整理' });
    assert.equal(f.get('忆幕').querySelector('.ym-stage-children'), group); assert.equal(group.open, true);
});

test('manual stage selection confirms full slice boundaries, refuses protected revisions, and sends no raw chat data', async t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const revised = entry({ id: 'slice-manual', source: { start: 7, end: 9 }, edited: true });
    const later = entry({ id: 'slice-later', source: { start: 10, end: 12 } }), last = entry({ id: 'slice-last', source: { start: 13, end: 15 } });
    const f = fixture({ sourceAvailable: true, document: { enabled: true, settings: {}, entries: [one, two, revised, later, last] } }); t.after(() => f.view.destroy());
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 20 }, () => ({ mes: 'synthetic' })) } });
    stageControl(f).click();
    assert.equal(f.get('阶段摘要开始楼层').value, '1'); assert.equal(f.get('阶段摘要结束楼层').value, '15');
    assert.equal(f.get('确认整理阶段摘要').disabled, true, 'a single manual range cannot skip an artificial hole around a protected slice');
    f.get('阶段摘要结束楼层').value = '6'; f.get('阶段摘要结束楼层').emit('input');
    f.get('阶段摘要开始楼层').value = '2'; f.get('阶段摘要开始楼层').emit('input');
    f.get('确认整理阶段摘要').click(); await f.flush(); assert.equal(f.calls.length, 0);
    assert.equal(f.get('阶段摘要开始楼层').value, '1', 'first partial-range submission only previews whole-slice alignment');
    assert.match(f.get('忆幕').querySelector('.ym-stage-form').textContent, /已对齐完整切片范围，请确认后开始/);
    f.get('确认整理阶段摘要').click(); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'stage', payload: { start: 1, end: 6, expectedRange: { start: 1, end: 6 } } }]);
});

test('manual stage selection shares stage ownership rules including stopped, deleted and invalid stages', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const later = entry({ id: 'slice-later', source: { start: 7, end: 9 } }), last = entry({ id: 'slice-last', source: { start: 10, end: 12 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [] } }); t.after(() => f.view.destroy());
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 17 }, () => ({ mes: 'synthetic' })) } });
    for (const status of ['active', 'excluded', 'deleted', 'invalid']) {
        const overview = stage([one, two], { status });
        f.render({ document: { ...f.state.document, entries: [one, two, later, last, overview] } });
        assert.equal(stageControl(f).disabled, false);
        stageControl(f).click();
        assert.equal(f.get('阶段摘要开始楼层').value, '7'); assert.equal(f.get('阶段摘要结束楼层').value, '12');
        f.get('取消阶段整理').click();
        f.render({ document: { ...f.state.document, entries: [one, two, overview] } });
        assert.equal(stageControl(f).disabled, false, 'the entry remains available so the user can inspect or select another range');
        stageControl(f).click();
        f.get('阶段摘要开始楼层').value = '1'; f.get('阶段摘要结束楼层').value = '6'; f.get('阶段摘要结束楼层').emit('input');
        assert.equal(f.get('确认整理阶段摘要').disabled, ['excluded', 'deleted'].includes(status), `${status} ownership must be respected by the actual confirmation action`);
        f.get('取消阶段整理').click();
    }
    assert.equal(f.calls.length, 0);
});

test('stage controls reject singleton, disjoint, recent and locally invalid fine selections before dispatch', async t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two] } }); t.after(() => f.view.destroy());
    assert.equal(stageControl(f).disabled, false, 'the range editor remains discoverable even when no group is currently valid');
    stageControl(f).click(); assert.equal(f.get('确认整理阶段摘要').disabled, true, 'recent cutoff leaves only one eligible fine slice'); f.get('取消阶段整理').click();
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 14 }, () => ({ mes: 'synthetic' })) } });
    stageControl(f).click();
    assert.equal(f.get('确认整理阶段摘要').disabled, false);
    f.get('阶段摘要结束楼层').value = '3'; f.get('阶段摘要结束楼层').emit('input');
    assert.equal(f.get('确认整理阶段摘要').disabled, true);
    f.get('忆幕').querySelector('.ym-stage-form').requestSubmit(); await f.flush(); assert.equal(f.calls.length, 0);
    f.render({ invalidSourceIds: ['slice-b'] }); assert.equal(f.get('确认整理阶段摘要').disabled, true);
    assert.equal(two.status, 'active', 'derived source invalidity does not mutate stored entries');
    f.render({ invalidSourceIds: [], document: { ...f.state.document, entries: [one, { ...two, source: { start: 7, end: 9 } }] } });
    assert.equal(f.get('确认整理阶段摘要').disabled, true, 'two isolated slices are not a continuous stage group');
});

test('stage grouping and invalidation do not detach an active fine editor mid-composition', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } }), overview = stage([one, two]);
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two] } }); t.after(() => f.view.destroy());
    f.get('编辑第 1–3 层').click(); const editor = f.get('编辑记忆内容'); editor.value = '正在输入'; editor.focus();
    const originalParent = editor.parentNode.parentNode.parentNode;
    f.render({ document: { ...f.state.document, entries: [one, two, overview] } });
    assert.equal(editor.parentNode.parentNode.parentNode, originalParent); assert.equal(f.document.activeElement, editor);
    f.get('取消编辑').click();
    const group = f.get('忆幕').querySelector('.ym-stage-children'); group.open = true;
    f.get('编辑第 1–3 层').click(); const nestedEditor = f.get('编辑记忆内容'); nestedEditor.focus();
    const nestedParent = nestedEditor.parentNode.parentNode.parentNode;
    f.render({ document: { ...f.state.document, entries: [{ ...one, revision: 3 }, two, overview] } });
    assert.equal(nestedEditor.parentNode.parentNode.parentNode, nestedParent); assert.equal(f.document.activeElement, nestedEditor);
    assert.equal(group.open, true); assert.match(group.querySelector('summary').textContent, /编辑中的切片/);
    f.get('取消编辑').click(); assert.equal(group.hidden, true);
    assert.equal(f.get('忆幕').querySelector('.ym-list').children.length, 3);
});

test('stage automatic mode is initially off and persists only through explicit settings save', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const toggle = f.get('自动整理阶段摘要'); assert.equal(toggle.checked, false); assert.equal(f.calls.length, 0);
    toggle.checked = true; toggle.emit('change'); assert.equal(f.calls.length, 0);
    f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { stageAuto: true }, expectedRevision: 0 });
});

test('controlled recall uses one default-on trial switch and saves the existing setting key', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const recall = f.get('自动回查与补充（试用）'); assert.equal(recall.checked, true);
    recall.checked = false; recall.emit('change'); f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { recall: false }, expectedRevision: 0 });
    assert.equal(f.get('按需回查细摘要'), undefined);
});

test('the renamed trial switch preserves old global and chat-level false values without writing a migration', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    f.render({ defaults: { ...f.state.defaults, values: { ...f.state.defaults.values, recall: false } } });
    assert.equal(f.get('自动回查与补充（试用）').checked, false);
    f.render({ document: { ...f.state.document, settings: { recall: true } } });
    assert.equal(f.get('自动回查与补充（试用）').checked, true, 'an explicit chat override wins');
    f.render({ defaults: { ...f.state.defaults, values: { ...f.state.defaults.values, recall: true } }, document: { ...f.state.document, settings: { recall: false } } });
    assert.equal(f.get('自动回查与补充（试用）').checked, false);
    assert.equal(f.calls.length, 0);
});

test('source-backed excerpts show the hydrated quotation and speaker as independent floor-ordered records, not their stored marker', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } }), quote = excerpt({ quoteText: '<img src=x>甲仍未告诉乙。' });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two, stage([one, two]), quote] } }); t.after(() => f.view.destroy());
    assert.equal(sourceLabel(quote), '回查补充 · 第 2 层');
    const card = f.get('忆幕').querySelector('[data-entry-id="excerpt-one"]');
    assert.equal(card.parentNode, f.get('忆幕').querySelector('.ym-list'));
    assert.equal(card.querySelector('.ym-memory-text').textContent, quote.quoteText);
    assert.equal(card.querySelector('.ym-quote-speaker').textContent, '甲');
    assert.doesNotMatch(card.textContent, /原文补充/); assert.equal(card.querySelector('img'), null);
    assert.equal(f.get('重新总结回查补充 · 第 2 层'), undefined);
    assert.ok(f.get('删除回查补充 · 第 2 层')); assert.ok(card.querySelector('.ym-more-actions'));
});

test('a missing excerpt quotation only reports unavailable source and cannot edit or summarize a placeholder', t => {
    const quote = excerpt({ quoteText: undefined, quoteSpeaker: undefined });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [quote] } }); t.after(() => f.view.destroy());
    const card = f.get('忆幕').querySelector('[data-entry-id="excerpt-one"]');
    assert.match(card.textContent, /原文来源暂不可用/); assert.equal(card.querySelector('.ym-memory-text'), null);
    assert.doesNotMatch(card.textContent, /原文补充/); assert.equal(f.get('编辑回查补充 · 第 2 层').disabled, true);
    assert.equal(f.get('重新总结回查补充 · 第 2 层'), undefined);
    f.render({ document: { ...f.state.document, entries: [{ ...quote, status: 'invalid' }] } });
    assert.equal(card.querySelectorAll('.ym-inline-warning').length, 1);
    assert.equal(f.calls.length, 0);
});

test('editing an excerpt starts with the real quotation and sends the normal protected edit action', async t => {
    const quote = excerpt(); const f = fixture({ document: { enabled: true, settings: {}, entries: [quote] } }); t.after(() => f.view.destroy());
    f.get('编辑回查补充 · 第 2 层').click(); const editor = f.get('编辑记忆内容');
    assert.equal(editor.value, quote.quoteText);
    editor.value = '用户确认：乙仍不知道信的内容。'; editor.emit('input'); f.get('保存修订').click(); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'edit', payload: { entryId: quote.id, expectedRevision: quote.revision, text: '用户确认：乙仍不知道信的内容。', scenes: [] } }]);
    f.render({ document: { ...f.state.document, entries: [entry({ id: quote.id, kind: 'manual', source: null, edited: true, text: '用户确认：乙仍不知道信的内容。' })] } });
    assert.ok(f.get('编辑自定义切片')); assert.equal(f.get('重新总结自定义切片'), undefined);
});

test('excerpt deletion, exclusion and undo retain ordinary entry actions without a re-summary route', async t => {
    const quote = excerpt({ history: [{ status: 'active' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [quote] } }); t.after(() => f.view.destroy());
    f.get('更多回查补充 · 第 2 层').click(); f.get('将此切片注入屏蔽').click(); await f.flush();
    f.get('删除回查补充 · 第 2 层').click(); await f.flush();
    f.render({ document: { ...f.state.document, entries: [{ ...quote, status: 'deleted' }] } });
    const removed = f.get('忆幕').querySelector('.ym-deleted');
    assert.match(removed.textContent, /甲将那封信藏进抽屉/); assert.doesNotMatch(removed.textContent, /原文补充/);
    f.get('撤回删除回查补充 · 第 2 层').click(); await f.flush();
    assert.deepEqual(f.calls.map(call => call.payload.action), ['exclude', 'delete', 'undo']);
});

test('stage basis offers three separate units and suggests mode defaults without replacing a custom threshold', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const basis = f.get('阶段整理依据'), threshold = f.get('阶段整理阈值');
    assert.deepEqual(basis.children.map(option => option.value), ['tokens', 'floors', 'slices']); assert.equal(threshold.value, '6000');
    basis.value = 'floors'; basis.emit('change'); assert.equal(threshold.value, '100');
    basis.value = 'slices'; basis.emit('change'); assert.equal(threshold.value, '12');
    threshold.value = '37'; threshold.emit('input'); basis.value = 'tokens'; basis.emit('change'); assert.equal(threshold.value, '37');
    f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload.values, { stageBasis: 'tokens', stageThreshold: 37 });
});

test('deleted memories remain absent from active cards but expose an explicit undo instead of a permanent range ban', async t => {
    const removed = entry({ status: 'deleted', history: [{ status: 'active', text: 'old' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [removed] } }); t.after(() => f.view.destroy());
    assert.equal(f.get('忆幕').querySelector('.ym-list').children.length, 0);
    assert.equal(f.get('忆幕').querySelector('.ym-deleted').open, false);
    f.get('撤回删除第 1–3 层').click(); await f.flush();
    assert.deepEqual(f.calls[0], { type: 'entry', payload: { entryId: 'slice-a', expectedRevision: 2, action: 'undo' } });
});

test('locally stopped but not yet server-confirmed state remains visibly off and cannot start a new summary', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] }, paused: true }); t.after(() => f.view.destroy());
    assert.equal(f.get('启用忆幕').checked, false);
    assert.equal(f.get('开始总结').disabled, true);
    assert.equal(Boolean(f.get('重新总结第 1–3 层').disabled), true);
});

test('all memory, draft and candidate text remains literal text instead of executable markup', t => {
    const dangerous = '<img src=x onerror=alert(1)><script>bad()</script>';
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry({ text: dangerous, candidate: { text: dangerous }, conflicts: [{ id: 'other', text: dangerous }] })] } }); t.after(() => f.view.destroy());
    assert.equal(f.all().filter(node => node.tagName === 'SCRIPT' || node.tagName === 'IMG' && !node.className.includes('ym-avatar')).length, 0);
    assert.ok(f.all().some(node => node.textContent === dangerous));
});

test('entry edits retain the exact editor and original revision during background refresh, then save against that revision', async t => {
    const initial = entry(); const f = fixture({ document: { enabled: true, settings: {}, entries: [initial] } }); t.after(() => f.view.destroy());
    f.get('编辑第 1–3 层').click(); const input = f.get('编辑记忆内容'); input.value = '我的人工修订'; input.emit('input'); input.focus();
    const remote = entry({ revision: 3, text: '另一设备的新版本' });
    f.render({ document: { ...f.state.document, entries: [remote] }, status: '正在整理其他片段…' });
    assert.equal(f.get('编辑记忆内容'), input); assert.equal(f.document.activeElement, input); assert.equal(input.value, '我的人工修订');
    f.get('保存修订').click(); await f.flush();
    assert.deepEqual(f.calls[0], { type: 'edit', payload: { entryId: initial.id, expectedRevision: 2, text: '我的人工修订', scenes: [] } });
    assert.equal(f.get('编辑记忆内容'), undefined);
    assert.ok(f.all().some(node => node.textContent === remote.text));
});

test('a failed edit leaves its draft visible; cancel restores controls without modifying source or saved memory', async t => {
    const initial = entry(); const f = fixture({ document: { enabled: true, settings: {}, entries: [initial] } }, () => { throw Error('保存未确认'); }); t.after(() => f.view.destroy());
    f.get('编辑第 1–3 层').click(); f.get('编辑记忆内容').value = 'draft'; f.get('保存修订').click(); await f.flush();
    assert.equal(f.get('编辑记忆内容').value, 'draft'); assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /保存未确认/);
    f.get('取消编辑').click(); assert.equal(f.get('编辑记忆内容'), undefined); assert.ok(f.get('编辑第 1–3 层'));
    assert.equal(initial.text, '两人第一次约会。甲没有得知乙的秘密。');
});

test('source changes and saved conflict choices appear inline while the active draft and focus stay connected', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry({ edited: true })] } }); t.after(() => f.view.destroy());
    f.get('编辑第 1–3 层').click(); const input = f.get('编辑记忆内容'); input.value = '尚未完成的修订'; input.focus();
    f.render({ document: { ...f.state.document, entries: [entry({ edited: true, revision: 3, status: 'invalid', conflicts: [{ id: 'another', text: '另一端已保存的候选' }] })] } });
    assert.equal(f.get('编辑记忆内容'), input); assert.equal(input.isConnected, true); assert.equal(f.document.activeElement, input);
    assert.equal(input.value, '尚未完成的修订');
    assert.match(f.get('忆幕').querySelector('.ym-memory').textContent, /原文已变化，人工修订已保留/);
    assert.ok(f.get('采用此版本')); assert.ok(f.get('保留已保存版本'));
});

test('candidate and device-conflict decisions explicitly identify the record revision and selected candidate', async t => {
    const current = entry({ edited: true, status: 'invalid', history: [{ text: 'old', revision: 1 }], candidate: { text: '新候选' }, conflicts: [{ id: 'conflict-b', text: '另一端修改' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [current] } }); t.after(() => f.view.destroy());
    f.get('采用候选').click(); await f.flush(); f.get('保留已保存版本').click(); await f.flush();
    f.get('更多第 1–3 层').click(); f.get('撤回上次修改').click(); await f.flush(); f.get('保留为自定义切片').click(); await f.flush();
    assert.deepEqual(f.calls.map(call => call.payload), [
        { entryId: 'slice-a', expectedRevision: 2, action: 'acceptCandidate' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'discardConflict', conflictId: 'conflict-b' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'undoText' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'keepManual' },
    ]);
});

test('current-chat overrides and global defaults save independently, with one form-wide default reset', async t => {
    const f = fixture({ document: { enabled: false, settings: { recent: 7 }, entries: [] } }); t.after(() => f.view.destroy());
    assert.equal(f.get('近期原文层数').value, '7');
    assert.equal(f.get('近期原文层数跟随默认'), undefined);
    f.get('恢复默认设置').click(); assert.equal(f.get('近期原文层数').value, '5');
    f.get('保存设置').click(); await f.flush(); assert.deepEqual(f.calls[0], { type: 'settings', payload: { global: false, values: { recent: null, trigger: null, recall: null, stageAuto: null, stageBasis: null, stageThreshold: null, profileId: null, model: null, batch: null, budget: null }, expectedRevision: 0 } });
    f.get('全局默认').click(); f.get('近期原文层数').value = '8'; f.get('近期原文层数').emit('input');
    f.get('保存设置').click(); await f.flush(); assert.deepEqual(f.calls[1], { type: 'settings', payload: { global: true, values: { recent: 8 }, expectedRevision: 0 } });
    assert.equal(f.state.defaults.values.recent, 5, 'view itself never mutates canonical defaults');
});

test('settings and manual-add drafts survive status refresh; a failed save does not clear them', async t => {
    const f = fixture({}, () => false); t.after(() => f.view.destroy());
    assert.equal(f.get('记忆整理偏好'), undefined);
    f.get('近期原文层数').value = '8'; f.get('近期原文层数').emit('input');
    f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '只有用户确认的背景'; f.get('自定义切片内容').emit('input');
    f.render({ status: '正在整理…' });
    assert.equal(f.get('近期原文层数').value, '8'); assert.equal(f.get('自定义切片内容').value, '只有用户确认的背景');
    f.get('保存自定义切片').click(); await f.flush(); assert.equal(f.get('自定义切片内容').value, '只有用户确认的背景');
});

test('settings retain the edit-start revision across a remote refresh rather than overwriting a newer configuration', async t => {
    const f = fixture({ document: { enabled: true, configRevision: 4, settings: {}, entries: [] } }); t.after(() => f.view.destroy());
    f.get('近期原文层数').value = '12'; f.get('近期原文层数').emit('input');
    f.render({ document: { ...f.state.document, configRevision: 5, settings: { recent: 6 } } });
    f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { recent: 12 }, expectedRevision: 4 });
});

test('a conflicting settings draft can be explicitly discarded and restarted against the latest saved revision', async t => {
    const f = fixture({ document: { enabled: true, configRevision: 4, settings: {}, entries: [] } }, () => false); t.after(() => f.view.destroy());
    f.get('近期原文层数').value = '12'; f.get('近期原文层数').emit('input');
    f.render({ document: { ...f.state.document, configRevision: 5, settings: { recent: 6 } } });
    f.get('保存设置').click(); await f.flush();
    f.get('取消设置修改').click(); assert.equal(f.get('近期原文层数').value, '6');
    f.get('近期原文层数').value = '9'; f.get('近期原文层数').emit('input'); f.get('保存设置').click(); await f.flush();
    assert.equal(f.calls[1].payload.expectedRevision, 5); assert.deepEqual(f.calls[1].payload.values, { recent: 9 });
});

test('the batch capacity accepts zero as default, rejects invalid positive capacity, and saves a larger connection capacity', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const batch = f.get('单次整理上限（token）'); assert.equal(batch.value, '6000'); assert.equal(batch.min, '0');
    batch.value = '255'; batch.emit('input'); f.get('保存设置').click(); await f.flush();
    assert.equal(f.calls.length, 0); assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /单次整理上限.*范围/);
    batch.value = '32000'; batch.emit('input'); f.get('整理连接').value = 'custom-profile'; f.get('整理连接').emit('change');
    f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { batch: 32000, profileId: 'custom-profile' }, expectedRevision: 0 });
});

test('unverified source disables all summary launch controls while keeping manual records editable', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] }, sourceAvailable: false, error: '当前聊天原件尚未通过核对' }); t.after(() => f.view.destroy());
    for (const label of ['开始总结', '重新总结失败部分', '重新总结第 1–3 层']) assert.equal(f.get(label).disabled, true, label);
    assert.equal(f.get('插入自定义切片').disabled, false); assert.equal(f.get('编辑第 1–3 层').disabled, false);
});

test('a successful settings save does not conceal the fact that an unverified chat cannot use memories', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [] }, sourceAvailable: false, status: '已保存' }); t.after(() => f.view.destroy());
    assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /原件尚未通过核对/);
});

test('an unacknowledged source invalidation is visible without changing the canonical entry status', t => {
    const original = entry({ edited: true });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [original] }, sourceAvailable: true, invalidSourceIds: [original.id] }); t.after(() => f.view.destroy());
    assert.match(f.get('忆幕').querySelector('.ym-memory').textContent, /原文已变化，人工修订已保留/);
    assert.equal(original.status, 'active'); assert.ok(f.get('保留为自定义切片'));
});

test('redo controls react to background busy changes without rebuilding or losing an entry editor', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }); t.after(() => f.view.destroy());
    const redo = f.get('重新总结第 1–3 层'); assert.equal(redo.disabled, false);
    f.get('编辑第 1–3 层').click(); const editor = f.get('编辑记忆内容'); editor.value = 'still editing';
    f.render({ busy: true }); assert.equal(redo.disabled, true); assert.equal(f.get('编辑记忆内容'), editor);
    f.render({ busy: false }); assert.equal(redo.disabled, false); assert.equal(editor.value, 'still editing');
});

test('a late failed save cannot overwrite the next chat status or restore an old draft', async t => {
    let reject; const f = fixture({}, () => new Promise((_, fail) => { reject = fail; })); t.after(() => f.view.destroy());
    f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '旧聊天'; f.get('自定义切片内容').emit('input'); f.get('保存自定义切片').click();
    f.render({ snapshot: { ...f.state.snapshot, binding: { ...f.state.snapshot.binding, file: '另一聊天' } }, status: '另一聊天已加载' });
    reject(Error('旧保存错误')); await f.flush();
    assert.equal(f.get('自定义切片内容').value, '');
    assert.equal(f.all().find(node => node.attrs.role === 'status').textContent, '另一聊天已加载');
});

test('dialog restores entry focus on Escape and outside click, retains forms on ordinary close, and does not close for inner clicks', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const trigger = f.document.createElement('button'); f.document.body.append(trigger); trigger.focus(); f.view.open();
    f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '保留草稿';
    const dialog = f.get('忆幕'); dialog.emit('click', { target: f.get('自定义切片内容') }); assert.equal(dialog.open, true);
    dialog.emit('keydown', { key: 'Escape' }); assert.equal(dialog.open, true, 'a subpage returns before closing');
    dialog.emit('keydown', { key: 'Escape' }); assert.equal(dialog.open, false); assert.equal(f.document.activeElement, trigger);
    f.view.open(); assert.equal(f.get('自定义切片内容').value, '保留草稿'); dialog.emit('click'); assert.equal(dialog.open, false);
});

test('loading and unavailable states retain navigation and expose service help in settings', t => {
    const f = fixture({ snapshot: null, document: null, loading: true }); t.after(() => f.view.destroy());
    assert.equal(f.get('忆幕').querySelector('.ym-content').hidden, false);
    assert.equal(f.get('刷新记忆'), undefined);
    assert.equal(f.get('记忆').disabled, false);
    f.render({ loading: false, error: '忆幕服务尚未安装。' });
    assert.equal(f.get('刷新记忆'), undefined); assert.equal(f.get('设置').disabled, false);
    f.view.open(); assert.equal(f.get('忆幕').open, true);
    f.get('设置').click(); const guide = f.get('忆幕安装说明');
    assert.equal(guide.closest('[hidden]'), null); assert.match(guide.getAttribute('href'), /\/yimu\/README\.md#安装与更新$/);
    assert.equal(guide.getAttribute('target'), '_blank'); assert.equal(guide.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(f.calls.length, 0, 'opening the unavailable panel never starts installation');
});

test('service status in settings distinguishes mismatch from unavailable service without a current chat', t => {
    const f = fixture({snapshot: null, document: null, service: {status: 'ok', version: '0.3.0', requiredVersion: '0.3.0'}}); t.after(() => f.view.destroy());
    f.get('设置').click(); const service = f.get('忆幕服务状态');
    assert.equal(service.textContent, '服务：正常 · v0.3.0'); assert.equal(service.closest('[hidden]'), null);
    assert.equal(f.get('忆幕').querySelector('.ym-content').hidden, false);
    f.render({service: {status: 'mismatch', version: '0.2.0', requiredVersion: '0.3.0'}});
    assert.match(service.textContent, /版本不匹配.*v0\.2\.0.*需 v0\.3\.0/); assert.doesNotMatch(service.textContent, /未连接/);
    f.render({service: {status: 'error', version: '', requiredVersion: '0.3.0'}});
    assert.match(service.textContent, /未连接.*配套 v0\.3\.0/); assert.equal(f.calls.length, 0);
});

test('the recent request view uses saved entry snapshots, only labels a request context, and marks token estimates', t => {
    const f = fixture({ lastUsed: { entries: [entry({ text: '请求当时的版本' })], tokens: 134 }, document: { enabled: true, settings: {}, entries: [entry({ text: '后来编辑的版本' })] } }); t.after(() => f.view.destroy());
    const used = f.get('忆幕').querySelector('.ym-last-used');
    assert.equal(used.open, false); assert.match(used.textContent, /请求当时的版本/); assert.doesNotMatch(used.textContent, /后来编辑的版本/);
    assert.match(used.querySelector('p').title, /不代表模型已接收/); assert.match(used.textContent, /134 token（估算）/);
});

test('the recent request view reports verified raw replacement and conservative budget without altering its snapshot', t => {
    const lastUsed = { entries: [entry({ text: '请求核对时的记忆' })], tokens: 134, removedFloors: [1, 2, 3], recentFloors: [10, 11, 12, 13, 14],
        requestTokens: 1234, responseTokens: 2000, contextTokens: 8192 };
    const before = structuredClone(lastUsed), f = fixture({ lastUsed }); t.after(() => f.view.destroy());
    const used = f.get('忆幕').querySelector('.ym-last-used');
    assert.match(used.textContent, /替换原文 3 层 · 保留近期 5 层/);
    assert.match(used.textContent, /请求保守估算 1234 \+ 回复预留 2000 \/ 上下文 8192 token/);
    assert.match(used.querySelector('p').title, /不代表模型已接收/);
    f.render({ document: { enabled: true, settings: {}, entries: [entry({ text: '后续人工修改' })] } });
    assert.match(used.textContent, /请求核对时的记忆/); assert.doesNotMatch(used.textContent, /后续人工修改/);
    assert.deepEqual(lastUsed, before); assert.equal(f.calls.length, 0);
});

test('the recent request shows an excerpt quotation from its saved snapshot, not a pointer marker or a newer hydration', t => {
    const usedQuote = excerpt({ quoteText: '请求当时原文仍是秘密。', quoteSpeaker: '乙' });
    const f = fixture({ lastUsed: { entries: [usedQuote], tokens: 100 }, document: { enabled: true, settings: {}, entries: [excerpt({ quoteText: '之后重新读取的内容。' })] } }); t.after(() => f.view.destroy());
    const used = f.get('忆幕').querySelector('.ym-last-used');
    assert.match(used.textContent, /回查补充 · 第 2 层/); assert.match(used.textContent, /请求当时原文仍是秘密/);
    assert.doesNotMatch(used.textContent, /之后重新读取|原文补充/); assert.match(used.querySelector('p').title, /不代表模型已接收/);
    assert.equal(usedQuote.quoteText, '请求当时原文仍是秘密。');
});

test('host entries sit directly after Qianmu and before Send, share one callback, replace only owned IDs, and dispose cleanly', () => {
    const d = dom(), options = d.document.createElement('div'), menu = d.document.createElement('div'), qianmu = d.document.createElement('a');
    options.id = 'options'; menu.className = 'options-content'; qianmu.dataset.qmStMenu = 'true';
    const later = d.document.createElement('a'); menu.append(qianmu, later); options.append(menu);
    const sender = d.document.createElement('div'), send = d.document.createElement('div'); sender.id = 'rightSendForm'; send.id = 'send_but'; sender.append(send);
    const menuTrigger = d.document.createElement('button'); menuTrigger.id = 'options_button';
    d.document.body.append(options, sender, menuTrigger);
    let opens = 0, closes = 0; menuTrigger.addEventListener('click', () => closes++);
    const firstDispose = mountEntries(() => opens++, { document: d.document });
    const dispose = mountEntries(() => opens++, { document: d.document });
    assert.equal(d.all().filter(node => node.id === 'yimu-menu-entry').length, 1);
    const entry = d.document.getElementById('yimu-menu-entry'), shortcut = d.document.getElementById('yimu-send-entry');
    assert.equal(menu.children[1], entry); assert.equal(sender.children[0], shortcut); assert.equal(sender.children[1], send);
    assert.equal(entry.tagName, 'A'); assert.match(entry.className, /list-group-item/);
    assert.match(entry.children[0].className, /extensionsMenuExtensionButton/);
    assert.equal(shortcut.hidden, true); assert.equal(shortcut.dataset.ymState, 'neutral');
    dispose.update({ showShortcut: true }, state()); assert.equal(shortcut.hidden, false);
    entry.click(); shortcut.click(); assert.equal(opens, 2); assert.equal(closes, 1);
    const key = entry.emit('keydown', { key: 'Enter' });
    assert.equal(key.defaultPrevented, true); assert.equal(opens, 3); assert.equal(closes, 2);
    firstDispose(); assert.equal(entry.isConnected, true, 'old owner cannot delete replacement entries');
    dispose(); assert.equal(entry.isConnected, false); assert.equal(shortcut.isConnected, false); assert.equal(qianmu.isConnected, true); assert.equal(send.isConnected, true);
});

test('shortcut colors distinguish execution failure from unavailable states without changing the menu', () => {
    const d = dom(), menu = d.document.createElement('div'), sender = d.document.createElement('div');
    menu.id = 'options'; sender.id = 'rightSendForm'; d.document.body.append(menu, sender);
    const dispose = mountEntries(() => {}, { document: d.document });
    const shortcut = d.document.getElementById('yimu-send-entry'), entry = d.document.getElementById('yimu-menu-entry');
    const ready = state({ service: { status: 'ok' }, sourceAvailable: true, document: { ...state().document, enabled: true }, snapshot: { ...state().snapshot, mainApi: 'openai' } });
    for (const [patch, tone, message] of [
        [{}, 'ready', '正常'], [{ busy: true }, 'ready', '正在处理'],
        [{ error: '模型返回格式不正确' }, 'failed', '执行失败'],
        [{ backup: { error: '备份压缩数据损坏' }, snapshot: null, document: null }, 'failed', '备份压缩数据损坏'],
        [{ service: { status: 'error' }, error: '连接中断' }, 'neutral', '服务未连接'],
        [{ service: { status: 'mismatch' } }, 'neutral', '版本不匹配'],
        [{ loading: true }, 'neutral', '正在读取'],
        [{ snapshot: null, document: null, error: '请先打开聊天' }, 'neutral', '单人聊天'],
        [{ sourceAvailable: false, error: '来源尚未核对' }, 'neutral', '来源尚未通过核对'],
        [{ document: { ...ready.document, enabled: false } }, 'neutral', '未启用'],
        [{ paused: true }, 'neutral', '未启用'],
        [{ invalidSourceIds: ['stale'] }, 'neutral', '来源已变化'],
        [{ snapshot: { ...ready.snapshot, mainApi: 'textgenerationwebui' } }, 'neutral', '不适用'],
    ]) {
        const s = { ...ready, ...patch };
        assert.equal(shortcutStatus(s).tone, tone);
        dispose.update({ showShortcut: true }, s);
        assert.equal(shortcut.dataset.ymState, tone); assert.ok(shortcut.title.includes(message));
        assert.equal(shortcut.getAttribute('aria-label'), shortcut.title);
        assert.equal(entry.dataset.ymState, undefined); assert.equal(entry.title, '忆幕');
    }
    dispose.update({ showShortcut: false }, ready); assert.equal(shortcut.hidden, true); assert.equal(entry.hidden, false);
    dispose(); dispose.update({ showShortcut: true }, ready); assert.equal(shortcut.isConnected, false);
});

test('boot saves only the account UI preference, defaults off, and retains it across dispose and reboot', async () => {
    const d = dom(), menu = d.document.createElement('div'), sender = d.document.createElement('div');
    menu.id = 'options'; sender.id = 'rightSendForm'; d.document.body.append(menu, sender);
    const previous = Object.fromEntries(['document', 'SillyTavern', 'addEventListener', 'removeEventListener', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const listeners = new Map(); let saves = 0, requests = 0, live;
    const ctx = { extensionSettings: { yimu: { otherPreference: 'keep' } }, saveSettingsDebounced() { saves++; } };
    Object.assign(globalThis, { document: d.document, SillyTavern: { getContext: () => ctx },
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        fetch: async () => { requests++; throw Error('No request is allowed for this preference test'); } });
    try {
        live = boot(); await live.controller.settled();
        assert.equal(boot(), live); assert.equal(saves, 0); assert.equal(requests, 0);
        assert.equal(d.document.getElementById('yimu-send-entry').hidden, true);
        let toggle = d.get('显示输入栏快捷入口'); toggle.checked = true; toggle.emit('change'); await d.flush();
        assert.deepEqual(ctx.extensionSettings.yimu, { otherPreference: 'keep', showShortcut: true });
        assert.equal(saves, 1); assert.equal(requests, 0); assert.equal(live.controller.state.document, null);
        assert.equal(d.document.getElementById('yimu-send-entry').hidden, false);
        live.dispose(); assert.ok([...listeners.values()].every(items => !items.size));
        live = boot(); await live.controller.settled();
        assert.equal(d.all().filter(node => node.id === 'yimu-menu-entry').length, 1);
        assert.equal(d.all().filter(node => node.id === 'yimu-send-entry').length, 1);
        assert.equal(d.document.getElementById('yimu-send-entry').hidden, false);
        assert.equal(saves, 1);
        toggle = d.get('显示输入栏快捷入口'); toggle.checked = false; toggle.emit('change'); await d.flush();
        assert.equal(saves, 2); assert.equal(ctx.extensionSettings.yimu.showShortcut, false);
        assert.equal(d.document.getElementById('yimu-send-entry').hidden, true);
        assert.equal(d.document.getElementById('yimu-menu-entry').hidden, false);
        assert.equal(requests, 0);
        ctx.saveSettingsDebounced = () => { throw Error('合成设置保存失败'); };
        toggle.checked = true; toggle.emit('change'); await d.flush();
        assert.equal(ctx.extensionSettings.yimu.showShortcut, false);
        assert.equal(toggle.checked, false); assert.equal(d.document.getElementById('yimu-send-entry').hidden, true);
        assert.match(d.document.querySelector('.ym-status').textContent, /合成设置保存失败/);
        assert.equal(requests, 0);
    } finally {
        live?.dispose();
        for (const [key, descriptor] of Object.entries(previous)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
});

test('a late-created Qianmu menu entry is followed without a whole-page observer or repeated reordering', () => {
    const d = dom(), observations = [];
    d.document.defaultView.MutationObserver = class {
        constructor(callback) { this.callback = callback; observations.push(this); }
        observe(target, config) { this.target = target; this.config = config; }
        disconnect() { this.disconnected = true; }
    };
    const menu = d.document.createElement('div'); menu.id = 'options'; d.document.body.append(menu);
    const dispose = mountEntries(() => {}, { document: d.document });
    const entry = d.document.getElementById('yimu-menu-entry');
    const qianmu = d.document.createElement('a'); qianmu.dataset.qmStMenu = 'true'; menu.append(qianmu);
    observations[0].callback(); assert.equal(qianmu.nextSibling, entry);
    const order = menu.children.slice(); observations[0].callback(); assert.deepEqual(menu.children, order);
    assert.equal(observations[0].target, menu); assert.deepEqual(observations[0].config, { childList: true });
    dispose(); assert.equal(observations[0].disconnected, true);
});

test('formal pages show one surface at a time and navigating never performs a backend action', t => {
    const f = fixture(); t.after(() => f.view.destroy()); f.view.open();
    const visible = () => f.all().filter(n => n.className === 'ym-page' && !n.hidden).map(n => n.dataset.page);
    assert.deepEqual(visible(), ['overview']);
    f.get('记忆').click(); assert.deepEqual(visible(), ['memory']);
    f.get('设置').click(); assert.deepEqual(visible(), ['settings']);
    f.get('概览').click(); f.get('展开记忆备份').click(); assert.deepEqual(visible(), ['overview']);
    const card = f.get('展开记忆备份').parentElement; assert.equal(card.tagName, 'SECTION');
    const panel = f.get('忆幕').querySelector('#ym-tool-panel-backup');
    assert.equal(f.get('展开记忆备份').getAttribute('aria-expanded'), 'true'); assert.equal(panel.hidden, false);
    assert.equal(f.document.querySelector('.ym-nav').hidden, false);
    f.view.close(); f.view.open(); assert.equal(card.open, true); assert.deepEqual(visible(), ['overview']);
    assert.equal(f.document.querySelector('.ym-nav').hidden, false); assert.equal(panel.hidden, false); assert.deepEqual(f.calls, []);
});

test('navigation and reopening retain each scroll position, search and exact editor nodes', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }); t.after(() => f.view.destroy());
    f.view.open(); f.get('记忆').click();
    const scroller = f.document.querySelector('.ym-scroll'); scroller.scrollTop = 120;
    f.get('编辑第 1–3 层').click(); const editor = f.get('编辑记忆内容'); editor.value = '未保存的修订'; editor.emit('input');
    const search = f.get('搜索记忆'); search.value = '约会'; search.emit('input');
    f.get('设置').click(); scroller.scrollTop = 70;
    f.get('近期原文层数').value = '8'; f.get('近期原文层数').emit('input');
    f.get('记忆').click(); assert.equal(scroller.scrollTop, 120); assert.equal(f.get('编辑记忆内容'), editor);
    assert.equal(editor.value, '未保存的修订'); assert.equal(search.value, '约会');
    f.view.close(); f.view.open(); assert.equal(scroller.scrollTop, 120); assert.equal(f.get('编辑记忆内容'), editor);
    f.get('设置').click(); assert.equal(scroller.scrollTop, 70); assert.equal(f.get('近期原文层数').value, '8');
    assert.deepEqual(f.calls, []);
});

test('search and attention filters do not hide active edits or mutate memory', t => {
    const one = entry(), other = entry({ id: 'other', text: '雨后重逢', status: 'invalid', source: { start: 4, end: 6 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, other] } }); t.after(() => f.view.destroy());
    f.get('记忆').click(); const search = f.get('搜索记忆'); search.value = '雨后'; search.emit('input');
    assert.equal(f.get('编辑第 1–3 层').closest('.ym-memory').hidden, true);
    assert.equal(f.get('编辑第 4–6 层').closest('.ym-memory').hidden, false);
    f.get('编辑第 4–6 层').click(); search.value = '不存在'; search.emit('input');
    assert.equal(f.get('编辑第 4–6 层').closest('.ym-memory').hidden, false, 'active draft stays accessible');
    f.get('取消编辑').click(); search.value = ''; search.emit('input');
    f.get('筛选记忆').value = 'attention'; f.get('筛选记忆').emit('change');
    assert.equal(f.get('编辑第 1–3 层').closest('.ym-memory').hidden, true);
    assert.equal(f.get('编辑第 4–6 层').closest('.ym-memory').hidden, false); assert.deepEqual(f.calls, []);
});

test('a save in flight cannot submit twice or erase newer typing, and subsequent save uses the confirmed revision', async t => {
    let finish; const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }, () => new Promise(resolve => { finish = resolve; }));
    t.after(() => f.view.destroy()); f.get('记忆').click(); f.get('编辑第 1–3 层').click();
    const editor = f.get('编辑记忆内容'); editor.value = '第一版'; editor.emit('input'); f.get('保存修订').click(); await f.flush();
    editor.value = '第一版之后继续输入'; editor.emit('input'); f.get('保存修订').click();
    assert.equal(f.calls.length, 1); assert.equal(f.get('保存修订').disabled, true);
    f.render({ document: { ...f.state.document, entries: [entry({ revision: 3, edited: true, text: '第一版' })] } });
    finish(true); await f.flush(); assert.equal(f.get('编辑记忆内容'), editor); assert.equal(editor.value, '第一版之后继续输入');
    f.get('保存修订').click(); await f.flush(); assert.equal(f.calls[1].payload.expectedRevision, 3);
    finish(true); await f.flush(); assert.equal(f.get('编辑记忆内容'), undefined);
});

test('a previously hidden slice becomes visible inside a newly grouped stage when search is cleared', t => {
    const one = entry(), two = entry({ id: 'two', text: '雨后重逢', source: { start: 4, end: 6 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two] } }); t.after(() => f.view.destroy());
    const search = f.get('搜索记忆'); search.value = '雨后'; search.emit('input');
    assert.equal(f.get('编辑第 1–3 层').closest('.ym-memory').hidden, true);
    f.render({ document: { ...f.state.document, entries: [one, two, stage([one, two])] } });
    search.value = ''; search.emit('input');
    assert.equal(f.get('编辑第 1–3 层').closest('.ym-memory').hidden, false);
    assert.equal(f.get('编辑第 4–6 层').closest('.ym-memory').hidden, false);
});

test('a canceled save finishing late cannot close a newly opened editor for the same memory', async t => {
    let finish; const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }, () => new Promise(resolve => { finish = resolve; }));
    t.after(() => f.view.destroy()); f.get('记忆').click(); f.get('编辑第 1–3 层').click();
    f.get('编辑记忆内容').value = '较早保存'; f.get('保存修订').click(); await f.flush();
    f.get('取消编辑').click(); f.get('编辑第 1–3 层').click(); const fresh = f.get('编辑记忆内容'); fresh.value = '新的未保存草稿';
    finish(true); await f.flush(); assert.equal(f.get('编辑记忆内容'), fresh); assert.equal(fresh.value, '新的未保存草稿');
});

test('finishing a manual save does not pull the reader away from another page', async t => {
    let finish; const f = fixture({}, () => new Promise(resolve => { finish = resolve; })); t.after(() => f.view.destroy());
    f.get('记忆').click(); f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '我的补充'; f.get('自定义切片内容').emit('input');
    f.get('保存自定义切片').click(); await f.flush(); f.get('返回').click(); f.get('设置').click();
    finish(true); await f.flush();
    assert.equal(f.all().find(n => n.dataset.page === 'settings').hidden, false);
    assert.equal(f.get('自定义切片内容').value, '');
});

test('changing chats resets chat drafts and filters but never transfers the last selected manual page', t => {
    const f = fixture(); t.after(() => f.view.destroy()); f.get('记忆').click(); f.get('插入自定义切片').click();
    f.get('自定义切片内容').value = '上一聊天';
    f.render({ snapshot: { ...f.state.snapshot, binding: { ...f.state.snapshot.binding, file: '另一聊天' } } });
    assert.equal(f.all().find(n => n.dataset.page === 'overview').hidden, false);
    assert.equal(f.get('自定义切片内容').value, ''); assert.equal(f.get('搜索记忆').value, ''); assert.deepEqual(f.calls, []);
});

test('an initially empty chat receives usable ranges without replacing an edited range on later refreshes', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [], initialRange: null }, snapshot: { binding: { avatar: 'empty.png', file: 'empty' }, messages: [] } });
    t.after(() => f.view.destroy());
    assert.equal(f.get('手动总结结束楼层').value, '0');
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 8 }, () => ({ mes: '正文' })) } });
    assert.equal(f.get('手动总结结束楼层').value, '8');
    assert.equal(f.get('历史结束楼层').value, '8');
    f.get('手动总结结束楼层').value = '4'; f.get('历史结束楼层').value = '6';
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 10 }, () => ({ mes: '正文' })) } });
    assert.equal(f.get('手动总结结束楼层').value, '4');
    assert.equal(f.get('历史结束楼层').value, '6'); assert.deepEqual(f.calls, []);
});

test('a new custom slice save preserves newer scene-only input and clears the scene editor only after that newer draft is saved', async t => {
    let finish; const f = fixture({}, () => new Promise(resolve => { finish = resolve; })); t.after(() => f.view.destroy());
    f.get('插入自定义切片').click();
    const text = f.get('自定义切片内容'); text.value = '正文不再改变'; text.emit('input');
    f.all().find(node => node.tagName === 'BUTTON' && node.textContent === '添加时空／视角' && node.closest('.ym-manual-form')).click();
    const date = f.get('场景1日期'); date.value = '旧日期';
    f.get('保存自定义切片').click(); await f.flush(); assert.equal(f.calls[0].payload.scenes[0].date, '旧日期');
    date.value = '保存期间新增的日期'; date.emit('input');
    finish(true); await f.flush();
    assert.equal(f.get('自定义切片内容'), text); assert.equal(text.value, '正文不再改变');
    assert.equal(f.get('场景1日期'), date); assert.equal(date.value, '保存期间新增的日期'); assert.equal(date.isConnected, true);
    assert.equal(text.closest('.ym-manual-form').hidden, false);
    f.get('保存自定义切片').click(); await f.flush(); assert.equal(f.calls[1].payload.scenes[0].date, '保存期间新增的日期');
    finish(true); await f.flush(); assert.equal(text.value, ''); assert.equal(date.isConnected, false);
    assert.equal(f.get('场景1日期'), undefined, 'the next new slice must not inherit a previously saved scene');
});

test('an existing slice save retains the exact scene editor and newer scene-only draft until a subsequent confirmed save', async t => {
    let finish; const initial = entry();
    const f = fixture({ document: { enabled: true, settings: {}, entries: [initial] } }, () => new Promise(resolve => { finish = resolve; })); t.after(() => f.view.destroy());
    f.get('编辑第 1–3 层').click(); const text = f.get('编辑记忆内容');
    f.all().find(node => node.tagName === 'BUTTON' && node.textContent === '添加时空／视角' && node.closest('.ym-edit-form')).click();
    const date = f.get('场景1日期'); date.value = '旧日期';
    f.get('保存修订').click(); await f.flush(); assert.equal(f.calls[0].payload.scenes[0].date, '旧日期');
    date.value = '尚未保存的新日期'; date.emit('input');
    f.render({ document: { ...f.state.document, entries: [entry({ revision: 3, edited: true, scenes: f.calls[0].payload.scenes })] } });
    finish(true); await f.flush();
    assert.equal(f.get('编辑记忆内容'), text); assert.equal(f.get('场景1日期'), date); assert.equal(date.value, '尚未保存的新日期');
    assert.equal(date.isConnected, true); assert.equal(text.value, initial.text);
    f.get('保存修订').click(); await f.flush(); assert.equal(f.calls[1].payload.expectedRevision, 3); assert.equal(f.calls[1].payload.scenes[0].date, '尚未保存的新日期');
    finish(true); await f.flush(); assert.equal(f.get('编辑记忆内容'), undefined); assert.equal(date.isConnected, false);
});

test('standalone manifest and styles stay within Yimu and include narrow-screen and reduced-motion handling', async () => {
    const root = new URL('../yimu/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const css = await readFile(new URL('style.css', root), 'utf8');
    assert.equal(manifest.generate_interceptor, 'yimuGenerationInterceptor');
    assert.equal(manifest.js.split('?')[0], 'index.mjs'); assert.equal(manifest.version, pkg.version);
    assert.match(css, /max-width: 480px/); assert.match(css, /100dvh/); assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(css, /(?:^|\n)(?:body|html|#chat|#send_form)\s*[{,]/);
    assert.match(css, /url\('\.\/logo\.svg'\)/);
    assert.match(css, /\.ym-menu-entry \.ym-logo \{ width: 20px; height: 20px; flex: 0 0 20px; color: inherit;/);
    assert.match(css, /\.ym-send-entry\[hidden\] \{ display: none !important;/);
    assert.match(css, /data-ym-state="ready"\] \{ color: #7d98a6;/);
    assert.match(css, /data-ym-state="failed"\] \{ color: #ad858b;/);
    assert.match(css, /data-ym-state="neutral"\] \{ color: #949494;/);
});
