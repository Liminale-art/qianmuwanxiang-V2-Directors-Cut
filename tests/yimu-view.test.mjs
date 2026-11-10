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
            const event = { type: name, target: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
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
    const choose=d.get('导入记忆'),picker=d.get('忆幕备份文件');assert.equal(picker.multiple,true);
    let opened=0;picker.addEventListener('click',()=>opened++);choose.click();assert.equal(opened,1);assert.deepEqual(calls,[]);
    const files=[{name:'one.yimu.gz'},{name:'two.yimu.gz'}];picker.files=files;picker.emit('change');await d.flush();
    assert.deepEqual(calls,[['backupImport',{files}]]);assert.equal(d.get('确认上传备份包'),undefined);assert.equal(d.get('已导入备份'),undefined);
    const cancel=picker.emit('cancel');assert.equal(cancel.stopped,true);assert.equal(d.get('忆幕').open,true);view.destroy();
});

test('backup disables actions during processing and toasts completed files without retaining empty result cards', async () => {
    const d=dom(),notices=[],view=createView({document:d.document,onNotice:(...args)=>notices.push(args),onAction:async()=>{}});view.render(state());
    view.render(state({service:{status:'ok'},backup:{busy:true,items:[{id:'a',name:'one.yimu.gz',status:'uploading'},{id:'b',name:'two.yimu.gz',status:'complete',message:'内容相同，已跳过'}]}}));
    assert.equal(d.get('导入记忆').disabled,true);assert.match(d.document.body.textContent,/one.yimu.gz/);assert.match(d.document.body.textContent,/正在读取并核对备份/);assert.deepEqual(notices,[['内容相同，已跳过','success']]);assert.doesNotMatch(d.document.body.textContent,/内容相同，已跳过/);
    view.render(state({service:{status:'error'}}));assert.equal(d.get('导入记忆').disabled,true);view.destroy();
});

test('backup asks once before exporting and originals remain a separate explicit choice', async () => {
    const d=dom(),calls=[],view=createView({document:d.document,onAction:async(...args)=>calls.push(args)});
    const s=state({backup:{exportPlan:{planId:'p',binding:state().snapshot.binding,primarySourceId:'main',sources:[{id:'main',label:'Main',available:true},{id:'ancestor',label:'Ancestor',available:true}]}}});
    view.render(s);assert.equal(d.get('附带ST聊天原件'),undefined);d.get('导出记忆').click();await d.flush();assert.deepEqual(calls,[]);
    d.get('取消导出').click();assert.deepEqual(calls,[]);d.get('导出记忆').click();d.get('否，仅导出记忆').click();await d.flush();assert.deepEqual(calls[0],['backupQuickExport',{includeOriginals:false}]);
    d.get('导出记忆').click();d.get('是，一起打包').click();await d.flush();
    assert.equal(d.get('Main').checked,true);assert.equal(d.get('Ancestor').checked,false);d.get('Ancestor').checked=true;
    d.get('打包并导出').click();await d.flush();assert.deepEqual(calls.at(-1),['backupQuickExport',{includeOriginals:true,planId:'p',sourceIds:['main','ancestor']}]);view.destroy();
});

test('ambiguous imports show only a target choice or cancellation and keep raw text out of the panel', async () => {
    const d=dom(),calls=[],view=createView({document:d.document,onAction:async(...args)=>calls.push(args)});
    const target=state().snapshot.binding;
    view.render(state({backup:{items:[{id:'a',name:'<img>.yimu.gz',status:'selection',archive:{sources:[]},candidates:[{binding:target,label:'原聊天',exact:true}]}]}}));
    const select=d.get('导入目标 <img>.yimu.gz');assert.equal(d.get('确认导入至所选目标').disabled,true);
    select.value='chat:0';select.emit('change');d.get('确认导入至所选目标').click();await d.flush();
    assert.deepEqual(calls[0],['backupResolve',{itemId:'a',targetBinding:target}]);assert.equal(d.document.querySelector('.ym-backup').querySelector('img'),null);view.destroy();
});

function fixture(patch, handler, options = {}) {
    const d = dom(), calls = [], notices = [];
    const view = createView({ onNotice: (...args) => notices.push(args), ...options, document: d.document, onAction: async (type, payload) => { calls.push({ type, payload }); return handler?.(type, payload); } });
    let current = state(patch); view.render(current);
    return { ...d, calls, notices, view, render(next) { current = { ...current, ...next }; view.render(current); }, get state() { return current; } };
}

const storyPlan = (binding, patch = {}) => ({ planId: 'plan-one', sourceBinding: binding, mode: 'continue', cutoff: 9,
    total: 9, recent: 5, bridgeCount: 5, inheritedCount: 2, manualChoices: [], boundaries: [], ...patch });


test('story defaults to the last floor and needs only one create action', async t => {
    const f=fixture();t.after(()=>f.view.destroy());f.view.open();
    assert.equal(f.get('续接楼层').value,'8');assert.equal(f.calls.length,0);assert.equal(f.get('故事延续方式'),undefined);assert.equal(f.get('预览带入内容'),undefined);
    f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.calls,[{type:'storyContinue',payload:{cutoff:9}}]);
});

test('story preserves an edited cutoff across ordinary rendering and validates it before action', async t => {
    const f=fixture();t.after(()=>f.view.destroy());f.get('续接楼层').value='4';f.get('续接楼层').emit('input');f.render({story:{status:''}});
    assert.equal(f.get('续接楼层').value,'4');f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.calls.at(-1),{type:'storyContinue',payload:{cutoff:5}});
    f.get('续接楼层').value='999';f.get('建立新聊天').click();await f.flush();assert.equal(f.calls.length,1);assert.match(f.notices.at(-1)[0],/有效的续接楼层/);
});

test('story never renders artificial choices or cutoff-crossing prose as part of its controls', t => {
    const f=fixture();t.after(()=>f.view.destroy());
    f.render({story:{plan:storyPlan(f.state.snapshot.binding,{manualChoices:[{id:'future',text:'不应显示的未来剧情'}]})}});
    assert.doesNotMatch(f.document.body.textContent,/不应显示的未来剧情/);assert.equal(f.get('人工记忆取舍 future'),undefined);
});

test('unknown story results can only retry the same operation; completed results do not create again', async t => {
    const f=fixture();t.after(()=>f.view.destroy());f.render({story:{pending:true,error:'连接中断'}});
    assert.equal(f.get('建立新聊天').disabled,false);assert.equal(f.get('续接楼层').disabled,true);f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.calls.at(-1),{type:'storyCreate',payload:{retry:true}});
    f.render({story:{result:{receipt:{status:'complete',target:{file:'已确认分支'}}}}});assert.equal(f.get('建立新聊天').disabled,false);
    f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.calls.at(-1),{type:'storyOpen',payload:{}});assert.equal(f.get('打开已建立的聊天'),undefined);
});

test('inherited entries retain source chat labels and edit controls but do not offer automatic rewriting', t => {
    const inherited = entry({ origin: { binding: { file: '原故事' }, offset: 0 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [inherited] } }); t.after(() => f.view.destroy());
    assert.equal(sourceLabel(inherited), '原故事 · 第 0–2 层');
    assert.ok(f.get('编辑原故事 · 第 0–2 层')); assert.equal(f.get('重新总结原故事 · 第 0–2 层'), undefined);
});


test('story failures notify once without adding permanent text inside the story tool', async t => {
    const f=fixture({},async type=>{if(type==='storyContinue')throw Error('故事建立未完成');});t.after(()=>f.view.destroy());
    f.get('建立新聊天').click();await f.flush();assert.deepEqual(f.notices,[['故事建立未完成','error']]);assert.doesNotMatch(f.document.body.textContent,/故事建立未完成/);
});

test('opening a panel only displays its frontend and does not enable, summarize or save', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    f.view.open(); assert.equal(f.get('忆幕').open, true);
    assert.equal(f.calls.length, 0); assert.equal(f.get('启用忆幕').checked, false);
    assert.equal(f.get('整理未覆盖内容'), undefined);
    assert.equal(f.get('开始总结').disabled, true);
    assert.equal(f.get('忆幕').querySelector('.ym-list').children.length, 0);
    assert.equal(f.get('忆幕').querySelector('.ym-deleted').hidden, true);
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
    assert.deepEqual(f.calls, [{type: 'enable', payload: {enabled: true, range: {start: 1, end: 0, total: 9}}}]);
    f.render({document: {...f.state.document, enabled: true, autoSummary: false, initialRange: {start: 1, end: 0, total: 9}}});
    assert.equal(automatic.disabled, false); assert.equal(f.get('开始总结').disabled, false);
    automatic.checked = true; automatic.emit('change'); await f.flush();
    assert.deepEqual(f.calls.at(-1), {type: 'autoSummary', payload: {value: true}});
    assert.equal(f.get('自动总结').closest('.ym-hero-switches'), master.closest('.ym-hero-switches'));
});

test('overview uses the 导览 label and memory page exposes bounded live summary output', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    assert.ok(f.get('导览'));
    assert.equal(f.document.querySelector('.ym-manual-label strong').textContent, '手动总结');
    assert.equal(f.document.querySelector('.ym-manual-label .ym-icon'), null, 'manual summary keeps the heading text-only');
    f.get('记忆').click();
    f.render({ ...f.state, busy: true, streamPreview: '正在生成：两人初见' });
    const preview = f.document.querySelector('.ym-stream-preview');
    assert.equal(preview.hidden, false); assert.match(preview.textContent, /正在生成：两人初见/);
    f.render({ ...f.state, busy: false, streamPreview: '' }); assert.equal(preview.hidden, true);
});

test('API offers the three intended connections and no numeric scope controls can rewrite stored legacy choices', async t => {
    const d = dom(), calls = [], ctx = { extensionSettings: {}, saveSettingsDebounced: async () => {} };
    const connectionApi = createApiSettings({ getContext: () => ctx });
    const view = createView({ document: d.document, connectionApi, onAction: async (type, payload) => { calls.push({type,payload}); } });
    t.after(() => view.destroy());
    view.render(state({ profiles: [{id:'global-profile',name:'全局连接'},{id:'chat-profile',name:'聊天连接'}],
        defaults:{revision:7,values:{...state().defaults.values,profileId:'global-profile',model:'global-model'}},
        document:{...state().document,settings:{profileId:'chat-profile',model:'chat-model'}} }));
    d.get('设置').click();
    const mode=d.get('整理连接方式');assert.deepEqual(mode.children.map(item=>item.value),['st','qianmu','external']);
    assert.equal(connectionApi.read().mode,'inherit');assert.doesNotMatch(d.document.body.textContent,/旧版 ST 连接已保留/);assert.match(d.document.body.textContent,/自定义API/);
    for(const label of ['ST 连接预设','当前聊天','全局默认'])assert.equal(d.get(label),undefined);
    assert.deepEqual(calls,[], 'rendering an old profile cannot submit or migrate it');
    mode.value='st';mode.emit('change');await d.flush();assert.equal(connectionApi.read().mode,'st');assert.deepEqual(calls,[]);
});

test('unacknowledged invalid slices remain in coverage and statistics stay display-only', t => {
    const f=fixture({document:{...state().document,enabled:true,initialRange:{start:1,end:9,total:9},entries:[entry()]},invalidSourceIds:['slice-a']});
    t.after(()=>f.view.destroy());
    const values=f.document.querySelector('.ym-stats').querySelectorAll('b');
    assert.equal(values[0].textContent,'1'); assert.equal(values[1].textContent,'3');
    const stats=f.document.querySelector('.ym-stats');assert.equal(stats.children.length,3);
    assert.ok(stats.children.every(node=>node.tagName==='DIV'));assert.equal(stats.querySelector('button'),null);
    stats.children[2].click();assert.deepEqual(f.calls,[]);
    assert.equal(f.get('手动总结开始楼层').value,'0'); assert.equal(f.get('手动总结结束楼层').value,'8');
});

test('pending floor card keeps the kept-raw explanation on hover only', t => {
    const f=fixture({document:{...state().document,enabled:true,entries:[entry()]}});t.after(()=>f.view.destroy());
    const pending=f.document.querySelector('.ym-stats').children[2];
    assert.equal(pending.querySelector('.ym-stat-note'),null);assert.doesNotMatch(pending.textContent,/保留原文/);
    assert.match(pending.textContent,/^\d+待整理层$/);assert.match(pending.title,/最新 5 层作为近期原文保留/);
});

test('history is organized from the manual card: floors per batch is its own saved preference and a run can pause', async t => {
    const f = fixture({document: {...state().document, enabled: true, initialRange: {start: 1, end: 0, total: 9}}}); t.after(() => f.view.destroy());
    assert.equal(f.document.querySelector('.ym-history-range'), null, 'no separate history question');
    assert.equal(f.get('确认整理历史'), undefined); assert.equal(f.get('不整理历史'), undefined);
    const perBatch = f.get('手动总结每批层数');
    assert.ok(perBatch.closest('.ym-manual-range')); assert.equal(perBatch.value, '20');
    // Invalid counts are refused locally and never saved or sent.
    perBatch.value = '0'; perBatch.emit('change'); await f.flush();
    assert.deepEqual(f.calls, []); assert.equal(perBatch.value, '20');
    perBatch.value = '3'; perBatch.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0], {type: 'uiSettings', payload: {manualBatchFloors: 3}});
    f.render({ui: {showShortcut: false, manualBatchFloors: 3}});
    assert.equal(perBatch.value, '3');
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls[1], {type: 'summarizeRange', payload: {range: {start: 1, end: 9}, expectedRange: {start: 1, end: 9}, batchFloors: 3}});
    // While a manual run is active: progress shows, Pause replaces Start, and the count and auto switch are locked.
    f.render({busy: true, manualJob: {done: 1, total: 3, pausing: false}});
    const pause = f.get('暂停');
    assert.equal(pause.hidden, false); assert.equal(pause.disabled, false); assert.equal(f.get('开始总结').hidden, true);
    assert.equal(perBatch.disabled, true); assert.equal(f.get('自动总结').disabled, true);
    assert.match(f.document.querySelector('.ym-manual-progress').textContent, /已完成 1／3 批/);
    pause.click(); await f.flush();
    assert.deepEqual(f.calls[2], {type: 'pauseManual', payload: {}});
    f.render({manualJob: {done: 1, total: 3, pausing: true}});
    assert.equal(pause.disabled, true); assert.match(f.document.querySelector('.ym-manual-progress').textContent, /本批完成后暂停/);
    f.render({busy: false, manualJob: null});
    assert.equal(pause.hidden, true); assert.equal(f.get('开始总结').hidden, false); assert.equal(perBatch.disabled, false);
    assert.equal(f.document.querySelector('.ym-manual-progress').textContent, '');
});

test('hidden prose remains available for explicit summary and the panel never changes its ST flags', async t => {
    const messages = Array.from({length:11},(_,i)=>({mes:'正文'+i,is_system:i<5}));
    const original = structuredClone(messages);
    const f = fixture({snapshot:{...state().snapshot,messages},document:{...state().document,enabled:true,autoSummary:false}});
    t.after(()=>f.view.destroy());
    f.get('手动总结开始楼层').value='0'; f.get('手动总结结束楼层').value='4';
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls[0], {type:'summarizeRange',payload:{range:{start:1,end:5},expectedRange:{start:1,end:5},batchFloors:20}});
    assert.deepEqual(messages,original); assert.doesNotMatch(f.document.body.textContent,/已被 ST 隐藏.*不参与整理/);
});

test('partial slice selection is visibly expanded and requires another explicit start before any call', async t => {
    const f=fixture({document:{...state().document,enabled:true,entries:[entry({source:{start:1,end:3}})]}});
    t.after(()=>f.view.destroy());
    f.get('手动总结开始楼层').value='1'; f.get('手动总结结束楼层').value='1';
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls,[]); assert.equal(f.get('手动总结开始楼层').value,'0');
    assert.equal(f.get('手动总结结束楼层').value,'2');
    assert.match(f.document.querySelector('.ym-manual-range').textContent,/请确认后开始/);
    f.get('开始总结').click(); await f.flush();
    assert.deepEqual(f.calls[0],{type:'summarizeRange',payload:{range:{start:1,end:3},expectedRange:{start:1,end:3},batchFloors:20}});
});

test('manual range controls are disabled by the master switch and no hidden enabling is submitted', async t => {
    const f=fixture(); t.after(()=>f.view.destroy());
    f.get('开始总结').click(); f.get('自动总结').click();
    await f.flush(); assert.deepEqual(f.calls,[]);
    f.render({snapshot:{...f.state.snapshot,messages:[]}});
    const master=f.get('启用忆幕'); master.checked=true; master.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0],{type:'enable',payload:{enabled:true,range:{start:1,end:0,total:0}}},'an empty chat follows from its first floor');
});

test('a new chat with only its opening floor skips the history question and counts every floor as new', async t => {
    const f=fixture({snapshot:{...state().snapshot,messages:[{mes:'开场白'}]}}); t.after(()=>f.view.destroy());
    const master=f.get('启用忆幕'); master.checked=true; master.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0],{type:'enable',payload:{enabled:true,range:{start:1,end:0,total:0}}});
    // Before the enable result arrives (or after an older enable without a scope), turning auto on also supplies it.
    f.render({document:{...f.state.document,enabled:true}});
    const auto=f.get('自动总结'); auto.checked=true; auto.emit('change'); await f.flush();
    assert.deepEqual(f.calls[1],{type:'autoSummary',payload:{value:true,initialRange:{start:1,end:0,total:0}}});
    // Once a scope exists, nothing is resent; turning auto off never sends one.
    f.render({document:{...f.state.document,autoSummary:true,initialRange:{start:1,end:0,total:0}}});
    auto.checked=false; auto.emit('change'); await f.flush();
    assert.deepEqual(f.calls[2],{type:'autoSummary',payload:{value:false}});
});

test('an existing multi-floor chat is never asked about history: automatic summary starts after its current floors', async t => {
    const f=fixture(); t.after(()=>f.view.destroy());
    const master=f.get('启用忆幕'); master.checked=true; master.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0],{type:'enable',payload:{enabled:true,range:{start:1,end:0,total:9}}});
    // An older chat enabled without a scope records it when auto is turned on.
    f.render({document:{...f.state.document,enabled:true}});
    const auto=f.get('自动总结'); auto.checked=true; auto.emit('change'); await f.flush();
    assert.deepEqual(f.calls[1],{type:'autoSummary',payload:{value:true,initialRange:{start:1,end:0,total:9}}});
    f.render({document:{...f.state.document,autoSummary:true,initialRange:{start:1,end:0,total:9}}});
    assert.equal(f.get('开始总结').disabled,false,'earlier floors stay available to manual summary');
    assert.match(f.document.querySelector('.ym-stats').children[2].title,/开启前的第 0–8 层不自动整理/);
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
    assert.equal(sourceLabel(items[0]), '自定义切片'); assert.equal(sourceLabel(items[2]), '第 0–2 层');
});

test('stage labels retain genuine gaps instead of falsely claiming the whole min-max interval', () => {
    const first = entry(), next = entry({ id: 'slice-b', source: { start: 7, end: 9, hashes: ['d', 'e', 'f'] } });
    assert.equal(sourceLabel(stage([first, next])), '阶段摘要 · 第 0–2、6–8 层');
    const adjacent = entry({ id: 'slice-c', source: { start: 4, end: 6, hashes: ['x', 'y', 'z'] } });
    assert.equal(sourceLabel(stage([first, adjacent])), '阶段摘要 · 第 0–5 层');
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
    assert.equal(f.get('阶段摘要开始楼层').value, '0'); assert.equal(f.get('阶段摘要结束楼层').value, '14');
    assert.equal(f.get('开始阶段总结').disabled, true, 'a single manual range cannot skip an artificial hole around a protected slice');
    f.get('阶段摘要结束楼层').value = '5'; f.get('阶段摘要结束楼层').emit('input');
    f.get('阶段摘要开始楼层').value = '1'; f.get('阶段摘要开始楼层').emit('input');
    f.get('开始阶段总结').click(); await f.flush(); assert.equal(f.calls.length, 0);
    assert.equal(f.get('阶段摘要开始楼层').value, '0', 'first partial-range submission only previews whole-slice alignment');
    assert.match(f.get('忆幕').querySelector('.ym-stage-form').textContent, /已对齐完整切片范围，请确认后开始/);
    f.get('开始阶段总结').click(); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'stage', payload: { start: 1, end: 6, includeCustom: false, expectedRange: { start: 1, end: 6 } } }]);
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
        assert.equal(f.get('阶段摘要开始楼层').value, '6'); assert.equal(f.get('阶段摘要结束楼层').value, '11');
        stageControl(f).click();
        f.render({ document: { ...f.state.document, entries: [one, two, overview] } });
        assert.equal(stageControl(f).disabled, false, 'the entry remains available so the user can inspect or select another range');
        stageControl(f).click();
        f.get('阶段摘要开始楼层').value = '0'; f.get('阶段摘要结束楼层').value = '5'; f.get('阶段摘要结束楼层').emit('input');
        assert.equal(f.get('开始阶段总结').disabled, ['excluded', 'deleted'].includes(status), `${status} ownership must be respected by the actual confirmation action`);
        stageControl(f).click();
    }
    assert.equal(f.calls.length, 0);
});

test('stage controls reject singleton, disjoint, recent and locally invalid fine selections before dispatch', async t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two] } }); t.after(() => f.view.destroy());
    assert.equal(stageControl(f).disabled, false, 'the range editor remains discoverable even when no group is currently valid');
    stageControl(f).click(); assert.equal(f.get('开始阶段总结').disabled, true, 'recent cutoff leaves only one eligible fine slice'); stageControl(f).click();
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 14 }, () => ({ mes: 'synthetic' })) } });
    stageControl(f).click();
    assert.equal(f.get('开始阶段总结').disabled, false);
    f.get('阶段摘要结束楼层').value = '2'; f.get('阶段摘要结束楼层').emit('input');
    assert.equal(f.get('开始阶段总结').disabled, true);
    f.get('忆幕').querySelector('.ym-stage-form').requestSubmit(); await f.flush(); assert.equal(f.calls.length, 0);
    f.render({ invalidSourceIds: ['slice-b'] }); assert.equal(f.get('开始阶段总结').disabled, true);
    assert.equal(two.status, 'active', 'derived source invalidity does not mutate stored entries');
    f.render({ invalidSourceIds: [], document: { ...f.state.document, entries: [one, { ...two, source: { start: 7, end: 9 } }] } });
    assert.equal(f.get('开始阶段总结').disabled, true, 'two isolated slices are not a continuous stage group');
});

test('stage grouping and invalidation do not detach an active fine editor mid-composition', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } }), overview = stage([one, two]);
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two] } }); t.after(() => f.view.destroy());
    f.get('编辑第 0–2 层').click(); const editor = f.get('编辑记忆内容'); editor.value = '正在输入'; editor.focus();
    const originalParent = editor.parentNode.parentNode.parentNode;
    f.render({ document: { ...f.state.document, entries: [one, two, overview] } });
    assert.equal(editor.parentNode.parentNode.parentNode, originalParent); assert.equal(f.document.activeElement, editor);
    f.get('取消编辑').click();
    const group = f.get('忆幕').querySelector('.ym-stage-children'); group.open = true;
    f.get('编辑第 0–2 层').click(); const nestedEditor = f.get('编辑记忆内容'); nestedEditor.focus();
    const nestedParent = nestedEditor.parentNode.parentNode.parentNode;
    f.render({ document: { ...f.state.document, entries: [{ ...one, revision: 3 }, two, overview] } });
    assert.equal(nestedEditor.parentNode.parentNode.parentNode, nestedParent); assert.equal(f.document.activeElement, nestedEditor);
    assert.equal(group.open, true); assert.match(group.querySelector('summary').textContent, /编辑中的切片/);
    f.get('取消编辑').click(); assert.equal(group.hidden, true);
    assert.equal(f.get('忆幕').querySelector('.ym-list').children.length, 3);
});

test('stage automatic mode is initially off and deliberately toggling it autosaves the current chat', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const toggle = f.get('自动阶段总结'); assert.equal(toggle.checked, false); assert.equal(f.calls.length, 0);
    toggle.checked = true; toggle.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { stageAuto: true }, expectedRevision: 0 });
});

test('controlled recall uses one default-on trial switch and saves the existing setting key', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const recall = f.get('原文回查与补充'); assert.equal(recall.checked, true);
    assert.equal(recall.closest('details'),null);assert.equal(recall.closest('.ym-extra-settings').tagName.toLowerCase(),'section');recall.checked = false; recall.emit('change'); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { recall: false }, expectedRevision: 0 });
    assert.equal(f.get('按需回查细摘要'), undefined);
});

test('custom-slice sharing is an explicit Yimu setting and defaults off', async t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [] } }); t.after(() => f.view.destroy());
    const control = f.get('允许伴读使用自定义切片');
    assert.equal(control.checked, false);
    control.checked = true; control.emit('change'); await f.flush();
    assert.deepEqual(f.calls.at(-1).payload.values, { companionShareCustom: true });
});

test('the renamed trial switch preserves old global and chat-level false values without writing a migration', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    f.render({ defaults: { ...f.state.defaults, values: { ...f.state.defaults.values, recall: false } } });
    assert.equal(f.get('原文回查与补充').checked, false);
    f.render({ document: { ...f.state.document, settings: { recall: true } } });
    assert.equal(f.get('原文回查与补充').checked, true, 'an explicit chat override wins');
    f.render({ defaults: { ...f.state.defaults, values: { ...f.state.defaults.values, recall: true } }, document: { ...f.state.document, settings: { recall: false } } });
    assert.equal(f.get('原文回查与补充').checked, false);
    assert.equal(f.calls.length, 0);
});

test('source-backed excerpts show the hydrated quotation and speaker as independent floor-ordered records, not their stored marker', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } }), quote = excerpt({ quoteText: '<img src=x>甲仍未告诉乙。' });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two, stage([one, two]), quote] } }); t.after(() => f.view.destroy());
    assert.equal(sourceLabel(quote), '回查补充 · 第 1 层');
    const card = f.get('忆幕').querySelector('[data-entry-id="excerpt-one"]');
    assert.equal(card.parentNode, f.get('忆幕').querySelector('.ym-list'));
    assert.equal(card.querySelector('.ym-memory-text').textContent, quote.quoteText);
    assert.equal(card.querySelector('.ym-quote-speaker').textContent, '甲');
    assert.doesNotMatch(card.textContent, /原文补充/); assert.equal(card.querySelector('img'), null);
    assert.equal(f.get('重新总结回查补充 · 第 1 层'), undefined);
    assert.ok(f.get('删除回查补充 · 第 1 层')); assert.ok(card.querySelector('.ym-more-actions'));
});

test('a missing excerpt quotation only reports unavailable source and cannot edit or summarize a placeholder', t => {
    const quote = excerpt({ quoteText: undefined, quoteSpeaker: undefined });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [quote] } }); t.after(() => f.view.destroy());
    const card = f.get('忆幕').querySelector('[data-entry-id="excerpt-one"]');
    assert.match(card.textContent, /原文来源暂不可用/); assert.equal(card.querySelector('.ym-memory-text'), null);
    assert.doesNotMatch(card.textContent, /原文补充/); assert.equal(f.get('编辑回查补充 · 第 1 层').disabled, true);
    assert.equal(f.get('重新总结回查补充 · 第 1 层'), undefined);
    f.render({ document: { ...f.state.document, entries: [{ ...quote, status: 'invalid' }] } });
    assert.equal(card.querySelectorAll('.ym-inline-warning').length, 1);
    assert.equal(f.calls.length, 0);
});

test('editing an excerpt starts with the real quotation and sends the normal protected edit action', async t => {
    const quote = excerpt(); const f = fixture({ document: { enabled: true, settings: {}, entries: [quote] } }); t.after(() => f.view.destroy());
    f.get('编辑回查补充 · 第 1 层').click(); const editor = f.get('编辑记忆内容');
    assert.equal(editor.value, quote.quoteText);
    editor.value = '用户确认：乙仍不知道信的内容。'; editor.emit('input'); f.get('保存修订').click(); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'edit', payload: { entryId: quote.id, expectedRevision: quote.revision, text: '用户确认：乙仍不知道信的内容。', scenes: [] } }]);
    f.render({ document: { ...f.state.document, entries: [entry({ id: quote.id, kind: 'manual', source: null, edited: true, text: '用户确认：乙仍不知道信的内容。' })] } });
    assert.ok(f.get('编辑自定义切片')); assert.equal(f.get('重新总结自定义切片'), undefined);
});

test('excerpt deletion, exclusion and undo retain ordinary entry actions without a re-summary route', async t => {
    const quote = excerpt({ history: [{ status: 'active' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [quote] } }); t.after(() => f.view.destroy());
    f.get('更多回查补充 · 第 1 层').click(); f.get('将此切片注入屏蔽').click(); await f.flush();
    f.get('删除回查补充 · 第 1 层').click(); await f.flush();
    f.render({ document: { ...f.state.document, entries: [{ ...quote, status: 'deleted' }] } });
    const removed = f.get('忆幕').querySelector('.ym-deleted');
    assert.match(removed.textContent, /甲将那封信藏进抽屉/); assert.doesNotMatch(removed.textContent, /原文补充/);
    f.get('撤回删除回查补充 · 第 1 层').click(); await f.flush();
    assert.deepEqual(f.calls.map(call => call.payload.action), ['exclude', 'delete', 'undo']);
});

test('stage basis switches between token and slice units without replacing focused select nodes or resetting the chosen mode', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const basis = f.get('阶段整理方式'), threshold = f.get('阶段总结触发');
    assert.deepEqual(basis.children.map(option => option.value), ['tokens', 'slices']); assert.equal(threshold.value, '65000');
    const options=[...basis.children];basis.focus();
    for(const [value,limit] of [['slices',12],['tokens',65000]]){
        basis.value=value;basis.emit('change');assert.equal(threshold.value,String(limit));assert.equal(basis.value,value);
        const call=f.calls.at(-1);assert.deepEqual(call.payload.values,{stageThreshold:limit,stageBasis:value});
        f.render({document:{...f.state.document,configRevision:(f.state.document.configRevision||0)+1,settings:{...f.state.document.settings,...call.payload.values}}});
        await f.flush();assert.equal(basis.value,value);assert.deepEqual(basis.children,options);assert.equal(f.document.activeElement,basis);
    }
    threshold.value='37000';threshold.emit('change');await f.flush();assert.equal(f.calls.at(-1).payload.values.stageThreshold,37000);
});

test('deleted memories remain absent from active cards but expose an explicit undo instead of a permanent range ban', async t => {
    const removed = entry({ status: 'deleted', history: [{ status: 'active', text: 'old' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [removed] } }); t.after(() => f.view.destroy());
    assert.equal(f.get('忆幕').querySelector('.ym-list').children.length, 0);
    assert.equal(f.get('忆幕').querySelector('.ym-deleted').open, false);
    f.get('撤回删除第 0–2 层').click(); await f.flush();
    assert.deepEqual(f.calls[0], { type: 'entry', payload: { entryId: 'slice-a', expectedRevision: 2, action: 'undo' } });
});

test('locally stopped but not yet server-confirmed state remains visibly off and cannot start a new summary', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] }, paused: true }); t.after(() => f.view.destroy());
    assert.equal(f.get('启用忆幕').checked, false);
    assert.equal(f.get('开始总结').disabled, true);
    assert.equal(Boolean(f.get('重新总结第 0–2 层').disabled), true);
});

test('all memory, draft and candidate text remains literal text instead of executable markup', t => {
    const dangerous = '<img src=x onerror=alert(1)><script>bad()</script>';
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry({ text: dangerous, candidate: { text: dangerous }, conflicts: [{ id: 'other', text: dangerous }] })] } }); t.after(() => f.view.destroy());
    assert.equal(f.all().filter(node => node.tagName === 'SCRIPT' || node.tagName === 'IMG' && !node.className.includes('ym-avatar')).length, 0);
    assert.ok(f.all().some(node => node.textContent === dangerous));
});

test('entry edits retain the exact editor and original revision during background refresh, then save against that revision', async t => {
    const initial = entry(); const f = fixture({ document: { enabled: true, settings: {}, entries: [initial] } }); t.after(() => f.view.destroy());
    f.get('编辑第 0–2 层').click(); const input = f.get('编辑记忆内容'); input.value = '我的人工修订'; input.emit('input'); input.focus();
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
    f.get('编辑第 0–2 层').click(); f.get('编辑记忆内容').value = 'draft'; f.get('保存修订').click(); await f.flush();
    assert.equal(f.get('编辑记忆内容').value, 'draft'); assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /保存未确认/);
    f.get('取消编辑').click(); assert.equal(f.get('编辑记忆内容'), undefined); assert.ok(f.get('编辑第 0–2 层'));
    assert.equal(initial.text, '两人第一次约会。甲没有得知乙的秘密。');
});

test('source changes and saved conflict choices appear inline while the active draft and focus stay connected', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry({ edited: true })] } }); t.after(() => f.view.destroy());
    f.get('编辑第 0–2 层').click(); const input = f.get('编辑记忆内容'); input.value = '尚未完成的修订'; input.focus();
    f.render({ document: { ...f.state.document, entries: [entry({ edited: true, revision: 3, status: 'invalid', conflicts: [{ id: 'another', text: '另一端已保存的候选' }] })] } });
    assert.equal(f.get('编辑记忆内容'), input); assert.equal(input.isConnected, true); assert.equal(f.document.activeElement, input);
    assert.equal(input.value, '尚未完成的修订');
    assert.match(f.get('忆幕').querySelector('.ym-memory').textContent, /正文发生变化/);
    assert.ok(f.get('采用此版本')); assert.ok(f.get('保留已保存版本'));
});

test('candidate and device-conflict decisions explicitly identify the record revision and selected candidate', async t => {
    const current = entry({ edited: true, status: 'invalid', history: [{ text: 'old', revision: 1 }], candidate: { text: '新候选' }, conflicts: [{ id: 'conflict-b', text: '另一端修改' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [current] } }); t.after(() => f.view.destroy());
    f.get('采用候选').click(); await f.flush(); f.get('保留已保存版本').click(); await f.flush();
    f.get('更多第 0–2 层').click(); f.get('撤回上次修改').click(); await f.flush(); f.get('保留为自定义切片').click(); await f.flush();
    assert.deepEqual(f.calls.map(call => call.payload), [
        { entryId: 'slice-a', expectedRevision: 2, action: 'acceptCandidate' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'discardConflict', conflictId: 'conflict-b' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'undoText' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'keepManual' },
    ]);
});

test('clearing an individual setting restores its default without rewriting other settings or global defaults', async t => {
    const f = fixture({ document: { enabled: false, settings: { recent: 7 }, entries: [] } }); t.after(() => f.view.destroy());
    const recent=f.get('正文保留层数');assert.equal(recent.value, '7');
    for(const label of ['近期原文层数跟随默认','恢复默认设置','保存设置','全局默认','当前聊天','取消设置修改'])assert.equal(f.get(label),undefined);
    recent.value='';recent.emit('change');await f.flush();assert.deepEqual(f.calls[0],{type:'settings',payload:{global:false,values:{recent:null},expectedRevision:0}});
    f.render({document:{...f.state.document,configRevision:1,settings:{}}});assert.equal(recent.value,'5');
    recent.value='8';recent.emit('change');await f.flush();assert.deepEqual(f.calls[1],{type:'settings',payload:{global:false,values:{recent:8},expectedRevision:1}});
    assert.equal(f.state.defaults.values.recent, 5, 'view itself never mutates canonical defaults');
});

test('settings and manual-add drafts survive status refresh; a failed save does not clear them', async t => {
    const f = fixture({}, () => false); t.after(() => f.view.destroy());
    assert.equal(f.get('记忆整理偏好'), undefined);
    f.get('正文保留层数').value = '8'; f.get('正文保留层数').emit('input');
    f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '只有用户确认的背景'; f.get('自定义切片内容').emit('input');
    f.render({ status: '正在整理…' });
    assert.equal(f.get('正文保留层数').value, '8'); assert.equal(f.get('自定义切片内容').value, '只有用户确认的背景');
    f.get('正文保留层数').emit('blur');await f.flush();assert.equal(f.get('正文保留层数').value,'8');
    f.get('保存自定义切片').click(); await f.flush(); assert.equal(f.get('自定义切片内容').value, '只有用户确认的背景');
});

test('settings retain the edit-start revision across a remote refresh rather than overwriting a newer configuration', async t => {
    const f = fixture({ document: { enabled: true, configRevision: 4, settings: {}, entries: [] } }); t.after(() => f.view.destroy());
    f.get('正文保留层数').value = '12'; f.get('正文保留层数').emit('input');
    f.render({ document: { ...f.state.document, configRevision: 5, settings: { recent: 6 } } });
    f.get('正文保留层数').emit('blur'); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { recent: 12 }, expectedRevision: 4 });
});

test('a failed settings draft is retained and only a new deliberate edit can retry against the latest revision', async t => {
    const f = fixture({ document: { enabled: true, configRevision: 4, settings: {}, entries: [] } }, () => false); t.after(() => f.view.destroy());
    f.get('正文保留层数').value = '12'; f.get('正文保留层数').emit('input');
    f.render({ document: { ...f.state.document, configRevision: 5, settings: { recent: 6 } } });
    f.get('正文保留层数').emit('blur'); await f.flush();assert.equal(f.get('正文保留层数').value,'12');assert.equal(f.calls.length,1);
    f.render({status:'后台状态刷新'});await f.flush();assert.equal(f.calls.length,1);
    f.get('正文保留层数').emit('blur');await f.flush();assert.equal(f.calls.length,1,'another blur without editing must not repeat a failed write');
    f.get('正文保留层数').value = '9'; f.get('正文保留层数').emit('change'); await f.flush();
    assert.equal(f.calls[1].payload.expectedRevision, 5); assert.deepEqual(f.calls[1].payload.values, { recent: 9 });
});

test('there is no redundant batch setting and the two per-entry limits are validated as characters', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    assert.equal(f.get('单次整理上限（token）'),undefined);f.get('设置').click();
    const slice=f.get('每条切片字数上限'),stage=f.get('每条阶段总结字数上限');assert.equal(slice.value,'2000');assert.equal(stage.value,'3000');
    slice.value='0';slice.emit('change');await f.flush();assert.equal(f.calls.length,0);assert.match(f.document.querySelector('.ym-status').textContent,/每条切片字数上限.*范围/);
    slice.value='2500';slice.emit('change');await f.flush();assert.deepEqual(f.calls[0].payload,{global:false,values:{sliceChars:2500},expectedRevision:0});
    assert.doesNotMatch(slice.parentNode.parentNode.textContent,/单位：字|token 因模型而异/);
});

test('unverified source disables all summary launch controls while keeping manual records editable', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] }, sourceAvailable: false, error: '当前聊天原件尚未通过核对' }); t.after(() => f.view.destroy());
    for (const label of ['开始总结', '重新总结失败部分', '重新总结第 0–2 层']) assert.equal(f.get(label).disabled, true, label);
    assert.equal(f.get('插入自定义切片').disabled, false); assert.equal(f.get('编辑第 0–2 层').disabled, false);
});

test('a successful settings save does not conceal the fact that an unverified chat cannot use memories', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [] }, sourceAvailable: false, status: '已保存' }); t.after(() => f.view.destroy());
    assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /原件尚未通过核对/);
});

test('an unacknowledged source invalidation is visible without changing the canonical entry status', t => {
    const original = entry({ edited: true });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [original] }, sourceAvailable: true, invalidSourceIds: [original.id] }); t.after(() => f.view.destroy());
    const card = f.get('忆幕').querySelector('.ym-memory');
    assert.match(card.textContent, /正文发生变化/);
    assert.match(card.className, /ym-source-stale/);
    assert.ok(card.querySelector('.ym-memory-text'));
    assert.equal(original.status, 'active'); assert.ok(f.get('保留为自定义切片'));
});

test('a stage source change keeps the review border but does not show a misleading source warning', t => {
    const parent = entry({ id: 'parent', revision: 2 });
    const stageEntry = stage([parent], { status: 'invalid' });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [parent, stageEntry] } }); t.after(() => f.view.destroy());
    const card = f.get('忆幕').querySelectorAll('.ym-memory').find(node => node.dataset.entryId === 'stage-one');
    assert.ok(card); assert.match(card.className, /ym-source-stale/);
    assert.doesNotMatch(card.textContent, /正文发生变化|所含切片发生变化/);
});

test('redo controls react to background busy changes without rebuilding or losing an entry editor', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }); t.after(() => f.view.destroy());
    const redo = f.get('重新总结第 0–2 层'); assert.equal(redo.disabled, false);
    f.get('编辑第 0–2 层').click(); const editor = f.get('编辑记忆内容'); editor.value = 'still editing';
    f.render({ busy: true }); assert.equal(redo.disabled, true); assert.equal(f.get('编辑记忆内容'), editor);
    f.render({ busy: false }); assert.equal(redo.disabled, false); assert.equal(editor.value, 'still editing');
});

test('a late failed save cannot overwrite the next chat status or restore an old draft', async t => {
    let reject; const f = fixture({}, () => new Promise((_, fail) => { reject = fail; })); t.after(() => f.view.destroy());
    f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '旧聊天'; f.get('自定义切片内容').emit('input'); f.get('保存自定义切片').click();
    f.render({ snapshot: { ...f.state.snapshot, binding: { ...f.state.snapshot.binding, file: '另一聊天' } }, status: '另一聊天已加载' });
    reject(Error('旧保存错误')); await f.flush();
    assert.equal(f.get('自定义切片内容').value, '');
    assert.equal(f.document.querySelector('.ym-status').textContent, '');assert.equal(f.document.querySelector('.ym-status').hidden,true);
});

test('dialog restores entry focus on Escape and outside click, retains forms on ordinary close, and does not close for inner clicks', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const trigger = f.document.createElement('button'); f.document.body.append(trigger); trigger.focus(); f.view.open();
    const backdrop = f.document.querySelector('.ym-dialog-backdrop');
    assert.equal(backdrop.hidden, false); assert.equal(backdrop.getAttribute('data-open'), '');
    f.get('插入自定义切片').click(); f.get('自定义切片内容').value = '保留草稿';
    const dialog = f.get('忆幕'); assert.equal(dialog.tagName, 'DIV'); assert.equal(dialog.parentNode, backdrop, 'the panel is centered by the body-level flex backdrop'); dialog.emit('click', { target: f.get('自定义切片内容') }); assert.equal(dialog.open, true);
    dialog.emit('keydown', { key: 'Escape' }); assert.equal(dialog.open, true, 'a subpage returns before closing');
    dialog.emit('keydown', { key: 'Escape' }); assert.equal(dialog.open, false); assert.equal(backdrop.hidden, true); assert.equal(backdrop.getAttribute('data-open'), null); assert.equal(f.document.activeElement, trigger);
    f.view.open(); assert.equal(f.get('自定义切片内容').value, '保留草稿'); backdrop.emit('click'); assert.equal(dialog.open, false);
    f.view.open(); dialog.emit('click'); assert.equal(dialog.open, false);
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
    assert.equal(service.querySelector('.ym-service-badge').textContent,'正常');assert.equal(service.querySelector('.ym-service-badge').dataset.tone,'ready');
    assert.equal(service.querySelector('.ym-service-versions'), null);assert.equal(service.closest('[hidden]'), null);
    assert.equal(f.get('忆幕').querySelector('.ym-content').hidden, false);
    f.render({service: {status: 'mismatch', version: '0.2.0', requiredVersion: '0.3.0'}});
    assert.match(service.textContent, /有可用更新/);assert.equal(service.querySelector('.ym-service-badge').dataset.tone,'warning');assert.doesNotMatch(service.textContent, /未连接/);
    f.render({service: {status: 'error', version: '', requiredVersion: '0.3.0'}});
    assert.match(service.textContent, /未连接/);assert.equal(service.querySelector('.ym-service-badge').dataset.tone,'error');assert.equal(f.calls.length, 0);
});

test('a newer published yimu service shows a soft update notice while the running service stays usable', t => {
    const f = fixture({snapshot: null, document: null, service: {status: 'ok', version: '0.8.9', requiredVersion: '0.8.9'}}); t.after(() => f.view.destroy());
    f.get('设置').click(); const service = f.get('忆幕服务状态'), badge = service.querySelector('.ym-service-badge');
    assert.equal(badge.textContent, '正常'); assert.equal(badge.title, '');
    f.render({service: {status: 'ok', version: '0.8.9', requiredVersion: '0.8.9', latest: '0.8.10'}});
    assert.equal(badge.textContent, '有可用更新'); assert.equal(badge.dataset.tone, 'warning');
    assert.match(badge.title, /v0.8.9 → v0.8.10/);
    assert.equal(service.querySelector('.ym-install-link').dataset.highlight, 'true');
    assert.equal(f.calls.length, 0, 'the notice never starts an update by itself');
});

test('the recent request view uses saved entry snapshots, only labels a request context, and marks token estimates', t => {
    const f = fixture({ lastUsed: { entries: [entry({ text: '请求当时的版本' })], tokens: 134 }, document: { enabled: true, settings: {}, entries: [entry({ text: '后来编辑的版本' })] } }); t.after(() => f.view.destroy());
    assert.doesNotMatch(f.get('展开记忆调阅').textContent,/token|134/);
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

test('a fully reverted round explains why nothing was rewritten, a 保底 round says memory still reached the model', t => {
    const reverted = fixture({ lastUsed: null, lastSkip: { stage: 'boundary', reason: 'text-completion-boundary-unavailable', at: 1 } });
    t.after(() => reverted.view.destroy());
    const r = reverted.get('忆幕').querySelector('.ym-last-used');
    assert.match(r.textContent, /回退到 ST 原上下文/);
    assert.match(r.textContent, /Chat Completion/);
    assert.doesNotMatch(r.textContent, /保底|仍送达|附加记忆/);
    assert.match(r.querySelector('.ym-skip-head').title, /text-completion-boundary-unavailable/);

    const offered = fixture({ lastUsed: null, lastSkip: { stage: 'apply', reason: 'unsupported-tools-or-schema', at: 2, offered: true } });
    t.after(() => offered.view.destroy());
    const o = offered.get('忆幕').querySelector('.ym-last-used');
    assert.match(o.textContent, /保底方式附加记忆，未隐藏旧楼/);
    assert.match(o.textContent, /已作为附加资料加入本轮请求/);
    assert.match(o.textContent, /工具调用 \/ 函数 \/ 结构化输出/);
    assert.doesNotMatch(o.textContent, /回退到 ST 原上下文/);
});

test('the recent request shows an excerpt quotation from its saved snapshot, not a pointer marker or a newer hydration', t => {
    const usedQuote = excerpt({ quoteText: '请求当时原文仍是秘密。', quoteSpeaker: '乙' });
    const f = fixture({ lastUsed: { entries: [usedQuote], tokens: 100 }, document: { enabled: true, settings: {}, entries: [excerpt({ quoteText: '之后重新读取的内容。' })] } }); t.after(() => f.view.destroy());
    const used = f.get('忆幕').querySelector('.ym-last-used');
    assert.match(used.textContent, /回查补充 · 第 1 层/); assert.match(used.textContent, /请求当时原文仍是秘密/);
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
    assert.equal(entry.tagName, 'A'); assert.doesNotMatch(entry.className, /list-group-item/); assert.match(entry.className, /interactable/);
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
        [{}, 'ready', '正常'], [{ busy: true, status: '正在整理第 1—2 层' }, 'ready', '正在处理'],
        [{ error: '模型返回格式不正确' }, 'failed', '执行失败'],
        [{ backup: { error: '备份压缩数据损坏' }, snapshot: null, document: null }, 'failed', '备份压缩数据损坏'],
        [{ service: { status: 'error' }, error: '连接中断' }, 'neutral', '服务未连接'],
        [{ service: { status: 'mismatch' } }, 'neutral', '服务有可用更新'],
        [{ loading: true }, 'neutral', '正在读取'],
        [{ snapshot: null, document: null, error: '请先打开聊天' }, 'neutral', '单人聊天'],
        [{ sourceAvailable: false, error: '来源尚未核对' }, 'neutral', '来源尚未通过核对'],
        [{ document: { ...ready.document, enabled: false } }, 'neutral', '未启用'],
        [{ paused: true }, 'neutral', '未启用'],
        [{ invalidSourceIds: ['stale'] }, 'ready', '正常'],
        [{ snapshot: { ...ready.snapshot, mainApi: 'textgenerationwebui' } }, 'neutral', '不适用'],
    ]) {
        const s = { ...ready, ...patch };
        assert.equal(shortcutStatus(s).tone, tone);
        dispose.update({ showShortcut: true }, s);
        assert.equal(shortcut.dataset.ymState, tone); assert.ok(shortcut.title.includes(message));
        assert.equal(shortcut.dataset.ymBusy, String(Boolean(s.busy && /正在(?:整理|重试|核对)/.test(String(s.status || '')))));
        assert.equal(shortcut.getAttribute('aria-label'), shortcut.title);
        assert.equal(entry.dataset.ymState, undefined); assert.equal(entry.title, '忆幕');
    }
    dispose.update({ showShortcut: false }, ready); assert.equal(shortcut.hidden, true); assert.equal(entry.hidden, false);
    dispose(); dispose.update({ showShortcut: true }, ready); assert.equal(shortcut.isConnected, false);
});

test('trigger floor count sits right after the token trigger with its own hint and shows the factory default', t => {
    const f = fixture({ document: { ...state().document, enabled: true } }); t.after(() => f.view.destroy());
    const trigger = f.get('自动总结触发'), floors = f.get('自动总结触发楼层数');
    const group = floors.closest('.ym-settings-group'), rows = group.querySelectorAll('.ym-setting-row');
    assert.equal(group, trigger.closest('.ym-settings-group')); assert.match(group.textContent, /切片总结/);
    assert.equal(rows.indexOf(floors.closest('.ym-setting-row')), rows.indexOf(trigger.closest('.ym-setting-row')) + 1);
    assert.equal(floors.type, 'number'); assert.equal(floors.min, '0'); assert.equal(floors.placeholder, '10');
    assert.equal(floors.closest('.ym-setting-row').title, '未总结楼层（含正文保留层）达到此数 +1 时，总结保留层以外的全部楼层；与 token 阈值先到先触发；填 0 仅按 token');
    assert.match(trigger.closest('.ym-setting-row').title, /待整理正文.*token/);
    assert.equal(floors.value, '10');
    f.render({ document: { ...f.state.document, configRevision: 1, settings: { triggerFloors: 12 } } }); assert.equal(floors.value, '12');
    f.render({ document: { ...f.state.document, configRevision: 2, settings: { triggerFloors: 0 } } }); assert.equal(floors.value, '0');
});

test('reopening a loaded chat refreshes quietly while a cold or failed open uses the full refresh', async () => {
    const d = dom(), menu = d.document.createElement('div'); menu.id = 'options'; d.document.body.append(menu);
    const previous = Object.fromEntries(['document', 'SillyTavern', 'addEventListener', 'removeEventListener', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const ctx = { extensionSettings: {}, saveSettingsDebounced() {} }; let live;
    Object.assign(globalThis, { document: d.document, SillyTavern: { getContext: () => ctx }, addEventListener() {}, removeEventListener() {},
        fetch: async () => { throw Error('Synthetic unavailable service'); } });
    try {
        live = boot(); await live.controller.settled();
        const calls = []; let current = { snapshot: null, document: null, loading: false, error: '' };
        live.controller.refresh = async options => { calls.push(options); };
        Object.defineProperty(live.controller, 'state', { configurable: true, get: () => current });
        const entry = d.document.getElementById('yimu-menu-entry');
        entry.click(); assert.deepEqual(calls.pop(), {});
        current = { ...state(), loading: false, error: '' };
        entry.click(); assert.deepEqual(calls.pop(), { quiet: true, auto: false });
        current = { ...state(), loading: true }; entry.click(); assert.deepEqual(calls.pop(), {});
        current = { ...state(), error: '合成读取失败' }; entry.click(); assert.deepEqual(calls.pop(), {});
    } finally {
        live?.dispose();
        for (const [key, descriptor] of Object.entries(previous)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
});

test('quiet re-renders of a loaded chat never set loading or disable controls', t => {
    const f = fixture({ document: { ...state().document, enabled: true, entries: [entry()] } }); t.after(() => f.view.destroy());
    const labels = ['启用忆幕', '手动总结开始楼层', '手动总结结束楼层', '自动总结触发', '自动总结触发楼层数'];
    const controls = labels.map(label => f.get(label));
    const flips = [];
    for (const node of controls) {
        let value = node.disabled;
        Object.defineProperty(node, 'disabled', { configurable: true, get: () => value, set: next => { if (next) flips.push(node.getAttribute('aria-label')); value = next; } });
    }
    const status = f.document.querySelector('.ym-status').textContent;
    for (const patch of [{}, { snapshot: { ...f.state.snapshot } }, { document: { ...f.state.document } }]) {
        f.render({ ...patch, loading: false });
        assert.ok(controls.every(node => !node.disabled));
    }
    assert.deepEqual(flips, []); assert.equal(f.document.querySelector('.ym-status').textContent, status);
});

test('boot saves only the account UI preference, defaults off, and retains it across dispose and reboot', async () => {
    const d = dom(), menu = d.document.createElement('div'), sender = d.document.createElement('div');
    menu.id = 'options'; sender.id = 'rightSendForm'; d.document.body.append(menu, sender);
    const previous = Object.fromEntries(['document', 'SillyTavern', 'addEventListener', 'removeEventListener', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const listeners = new Map(), requests=[]; let saves = 0, live;
    const ctx = { extensionSettings: { yimu: { otherPreference: 'keep' } }, saveSettingsDebounced() { saves++; } };
    Object.assign(globalThis, { document: d.document, SillyTavern: { getContext: () => ctx },
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        fetch: async (url,options) => { requests.push({url,method:options?.method});assert.equal(url,'/api/plugins/yimu/health');assert.equal(options?.method,'GET');throw Error('Synthetic unavailable service'); } });
    try {
        live = boot(); await live.controller.settled();
        assert.equal(boot(), live); assert.equal(saves, 0); assert.equal(requests.length, 0);
        assert.equal(d.document.getElementById('yimu-send-entry').hidden, true);
        let toggle = d.get('显示输入栏快捷入口'); toggle.checked = true; toggle.emit('change'); await d.flush();
        assert.deepEqual(ctx.extensionSettings.yimu, { otherPreference: 'keep', showShortcut: true });
        assert.equal(saves, 1); assert.equal(requests.length, 0); assert.equal(live.controller.state.document, null);
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
        assert.equal(requests.length, 0);
        ctx.saveSettingsDebounced = () => { throw Error('合成设置保存失败'); };
        toggle.checked = true; toggle.emit('change'); await d.flush();
        assert.equal(ctx.extensionSettings.yimu.showShortcut, false);
        assert.equal(toggle.checked, false); assert.equal(d.document.getElementById('yimu-send-entry').hidden, true);
        assert.match(d.document.querySelector('.ym-status').textContent, /合成设置保存失败/);
        assert.equal(requests.length, 0,'quiet homepage startup and shortcut preferences never make a server write or model request');
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
    f.get('导览').click(); f.get('展开记忆备份').click(); assert.deepEqual(visible(), ['overview']);
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
    f.get('编辑第 0–2 层').click(); const editor = f.get('编辑记忆内容'); editor.value = '未保存的修订'; editor.emit('input');
    const search = f.get('搜索记忆'); search.value = '约会'; search.emit('input');
    f.get('设置').click(); scroller.scrollTop = 70;
    f.get('正文保留层数').value = '8'; f.get('正文保留层数').emit('input');
    f.get('记忆').click(); assert.equal(scroller.scrollTop, 120); assert.equal(f.get('编辑记忆内容'), editor);
    assert.equal(editor.value, '未保存的修订'); assert.equal(search.value, '约会');
    f.view.close(); f.view.open(); assert.equal(scroller.scrollTop, 120); assert.equal(f.get('编辑记忆内容'), editor);
    f.get('设置').click(); assert.equal(scroller.scrollTop, 70); assert.equal(f.get('正文保留层数').value, '8');
    assert.deepEqual(f.calls, []);
});

test('retrieval page sits between memory and settings and reports planned vector stages without backend calls', t => {
    const f = fixture(); t.after(() => f.view.destroy()); f.view.open();
    const visible = () => f.all().filter(n => n.className === 'ym-page' && !n.hidden).map(n => n.dataset.page);
    f.get('检索').click();
    assert.deepEqual(visible(), ['retrieval']);
    assert.match(f.document.body.textContent, /检查链路/);
    assert.match(f.document.body.textContent, /向量/);
    assert.match(f.document.body.textContent, /关键词召回/);
    assert.match(f.document.body.textContent, /待接入/);
    assert.match(f.document.body.textContent, /暂无候选记录/);
    assert.deepEqual(f.calls, []);
    f.get('设置').click(); assert.deepEqual(visible(), ['settings']);
});

test('keyword recall reads 可召回 and never mentions source recall in its row', t => {
    for (const sourceRecall of [false, true]) {
        const f = fixture({ retrieval: { mode: 'lexical', sourceRecall, vector: { status: 'disabled' }, rerank: { status: 'disabled' }, candidates: [] } });
        f.view.open(); f.get('检索').click();
        const row = f.document.querySelector('.ym-retrieval-status-row');
        assert.equal(row.textContent, '关键词召回可召回当前默认候选路径');
        assert.equal(row.querySelector('.ym-retrieval-badge').dataset.tone, 'ready');
        assert.doesNotMatch(f.document.querySelector('.ym-retrieval-status-card').textContent, /原文回查/);
        f.view.destroy();
    }
});

test('vector and rerank rows map runtime reasons to one short clause per status', t => {
    const reasons = { vector: '尚未配置向量候选接口，已回退关键词召回', rerank: '尚未配置重排候选接口，已保留当前顺序' };
    const cases = [
        ['unavailable', '未配置向量接口，已回退关键词召回', '未配置重排接口，保留原顺序', '不可用'],
        ['error', '向量请求失败，已回退关键词召回', '重排请求失败，保留原顺序', '不可用'],
        ['disabled', '当前聊天未启用', '当前聊天未启用', '未启用'],
        ['ready', '已接入候选发现', '已接入排序', '可用'],
        ['planned', '等待本轮整理', '等待本轮整理', '待接入'],
    ];
    for (const [status, vectorText, rerankText, badge] of cases) {
        const f = fixture({ retrieval: { mode: 'lexical', vector: { status, reason: reasons.vector }, rerank: { status, reason: reasons.rerank }, candidates: [] } });
        f.view.open(); f.get('检索').click();
        const [, vector, rerank] = f.document.querySelector('.ym-retrieval-status-card').querySelectorAll('.ym-retrieval-status-row');
        assert.equal(vector.querySelector('.ym-retrieval-status-detail').textContent, vectorText);
        assert.equal(rerank.querySelector('.ym-retrieval-status-detail').textContent, rerankText);
        assert.equal(vector.querySelector('.ym-retrieval-badge').textContent, badge);
        for (const text of [vectorText, rerankText]) assert.ok(text.replace(/[，,]/g, '').length <= 16, text);
        assert.doesNotMatch(f.document.querySelector('.ym-retrieval-status-card').textContent, /尚未配置/);
        f.view.destroy();
    }
});

test('retrieval timeout is shown as one shared account control and saves in seconds', async t => {
    const d = dom(), ctx = { extensionSettings: { yimu: {} }, async saveSettingsDebounced() {} };
    const connectionApi = createApiSettings({ getContext: () => ctx });
    const view = createView({ document: d.document, connectionApi, onAction: async () => {} });
    t.after(() => view.destroy()); view.render(state()); view.open(); d.get('检索').click();
    const timeout = d.get('候选请求超时（秒）');
    assert.equal(timeout.value, '15'); assert.equal(timeout.min, '5'); assert.equal(timeout.max, '60');
    assert.doesNotMatch(d.document.body.textContent, /等待时间/);
    const timeoutCard = d.all().find(node => node.className.includes('ym-retrieval-timeout-card'));
    const candidateCard = d.all().find(node => node.className.includes('ym-retrieval-candidates'));
    assert.ok(timeoutCard && candidateCard && timeoutCard.parentNode.children.indexOf(timeoutCard) < timeoutCard.parentNode.children.indexOf(candidateCard));
    assert.equal(timeout.closest('.ym-retrieval-card-heading'), timeoutCard.querySelector('.ym-retrieval-card-heading'));
    timeout.value = '25'; timeout.emit('change'); await d.flush();
    assert.equal(ctx.extensionSettings.yimu.retrievalTimeoutMs, 25000);
    view.render(state()); assert.equal(d.get('候选请求超时（秒）').value, '25');
});

test('retrieval provider cards use companion field names, presets and compact status-first layout', async t => {
    const d = dom(), ctx = { extensionSettings: { yimu: {} }, async saveSettingsDebounced() {} }, notices = [];
    const connectionApi = createApiSettings({ getContext: () => ctx, createId: () => 'preset-fixture' });
    const view = createView({ document: d.document, connectionApi, onNotice: (...args) => notices.push(args), onAction: async () => {} });
    t.after(() => view.destroy()); view.render(state()); view.open(); d.get('检索').click();
    assert.ok(d.get('向量预设')); assert.ok(d.get('重排预设'));
    assert.equal(d.get('API URL').placeholder, 'https://api.siliconflow.cn/v1');
    assert.equal(d.all().filter(node => node.attrs['aria-label'] === 'API URL')[1].placeholder, 'https://api.siliconflow.cn/v1');
    assert.equal(d.get('API Key').placeholder, '输入 API Key');
    assert.equal(d.all().filter(node => node.attrs['aria-label'] === 'API Key')[1].placeholder, '输入 API Key');
    const providerNodes = label => d.all().filter(node => node.attrs['aria-label'] === label && node.closest('.ym-retrieval-provider'));
    assert.equal(providerNodes('测试连接').length, 2);
    assert.equal(providerNodes('拉取模型').length, 2);
    assert.equal(providerNodes('显示 API Key').length, 2);
    assert.equal(d.all().filter(node => node.tagName === 'SELECT' && node.attrs['aria-label'] === '模型').length, 2);
    assert.equal(providerNodes('手动填写模型').length, 0);
    const key = d.get('API Key'), eye = providerNodes('显示 API Key')[0];
    assert.equal(key.type, 'password'); assert.equal(eye.querySelector('.ym-icon').attrs['data-ym-icon'], 'eye');
    eye.click(); assert.equal(key.type, 'text'); assert.equal(eye.getAttribute('aria-label'), '隐藏 API Key'); assert.equal(eye.querySelector('.ym-icon').attrs['data-ym-icon'], 'eye-off');
    eye.click(); assert.equal(key.type, 'password'); assert.equal(eye.getAttribute('aria-label'), '显示 API Key'); assert.equal(eye.querySelector('.ym-icon').attrs['data-ym-icon'], 'eye');
    const statusCard = d.all().find(node => node.className.includes('ym-retrieval-status-card'));
    assert.equal(statusCard?.parentNode?.children[0], statusCard);
    assert.equal(d.all().filter(node => node.className.includes('ym-retrieval-provider-status')).length, 0);
    assert.doesNotMatch(d.document.body.textContent, /先看候选从哪里来|可选增强|自动回退，不影响正常整理/);
    assert.doesNotMatch(d.document.body.textContent, /text-embedding-3-small|bge-reranker-v2-m3/);

    d.get('保存预设').click();
    const presetName = d.get('向量预设名称');
    presetName.value = '现场配置'; d.all().filter(node => node.attrs['aria-label'] === '确认保存预设')[0].click(); await d.flush();
    assert.equal(d.get('向量预设').children.some(option => option.textContent === '现场配置'), true);
    assert.deepEqual(notices.at(-1), ['预设已保存', 'success']);
});

test('search and attention filters do not hide active edits or mutate memory', t => {
    const one = entry(), other = entry({ id: 'other', text: '雨后重逢', status: 'invalid', source: { start: 4, end: 6 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, other] } }); t.after(() => f.view.destroy());
    f.get('记忆').click(); const search = f.get('搜索记忆'); search.value = '雨后'; search.emit('input');
    assert.equal(f.get('编辑第 0–2 层').closest('.ym-memory').hidden, true);
    assert.equal(f.get('编辑第 3–5 层').closest('.ym-memory').hidden, false);
    f.get('编辑第 3–5 层').click(); search.value = '不存在'; search.emit('input');
    assert.equal(f.get('编辑第 3–5 层').closest('.ym-memory').hidden, false, 'active draft stays accessible');
    f.get('取消编辑').click(); search.value = ''; search.emit('input');
    f.get('筛选记忆').value = 'attention'; f.get('筛选记忆').emit('change');
    assert.equal(f.get('编辑第 0–2 层').closest('.ym-memory').hidden, true);
    assert.equal(f.get('编辑第 3–5 层').closest('.ym-memory').hidden, false); assert.deepEqual(f.calls, []);
});

test('a save in flight cannot submit twice or erase newer typing, and subsequent save uses the confirmed revision', async t => {
    let finish; const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }, () => new Promise(resolve => { finish = resolve; }));
    t.after(() => f.view.destroy()); f.get('记忆').click(); f.get('编辑第 0–2 层').click();
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
    assert.equal(f.get('编辑第 0–2 层').closest('.ym-memory').hidden, true);
    f.render({ document: { ...f.state.document, entries: [one, two, stage([one, two])] } });
    search.value = ''; search.emit('input');
    assert.equal(f.get('编辑第 0–2 层').closest('.ym-memory').hidden, false);
    assert.equal(f.get('编辑第 3–5 层').closest('.ym-memory').hidden, false);
});

test('a canceled save finishing late cannot close a newly opened editor for the same memory', async t => {
    let finish; const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] } }, () => new Promise(resolve => { finish = resolve; }));
    t.after(() => f.view.destroy()); f.get('记忆').click(); f.get('编辑第 0–2 层').click();
    f.get('编辑记忆内容').value = '较早保存'; f.get('保存修订').click(); await f.flush();
    f.get('取消编辑').click(); f.get('编辑第 0–2 层').click(); const fresh = f.get('编辑记忆内容'); fresh.value = '新的未保存草稿';
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

test('manual summary default follows the unsummarized range until the user edits it', t => {
    const messages = n => Array.from({ length: n }, () => ({ mes: '正文' }));
    const f = fixture({ document: { ...state().document, enabled: true, entries: [entry({ source: { start: 1, end: 3 } })] } });
    t.after(() => f.view.destroy());
    assert.equal(f.get('手动总结开始楼层').value, '3'); assert.equal(f.get('手动总结结束楼层').value, '8');
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(11) } });
    assert.equal(f.get('手动总结开始楼层').value, '3'); assert.equal(f.get('手动总结结束楼层').value, '10');
    f.render({ document: { ...f.state.document, entries: [entry({ source: { start: 1, end: 3 } }), entry({ id: 'slice-b', source: { start: 4, end: 6 } })] } });
    assert.equal(f.get('手动总结开始楼层').value, '6'); assert.equal(f.get('手动总结结束楼层').value, '10');
    f.get('手动总结开始楼层').value = '1';
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(12) } });
    assert.equal(f.get('手动总结开始楼层').value, '1'); assert.equal(f.get('手动总结结束楼层').value, '10');
    assert.deepEqual(f.calls, []);
});

test('manual summary range follows deleted floors and resets an edit that no longer fits', t => {
    const messages = n => Array.from({ length: n }, () => ({ mes: '正文' }));
    const f = fixture({ document: { ...state().document, enabled: true, entries: [entry({ source: { start: 1, end: 3 } })] } });
    t.after(() => f.view.destroy());
    const start = f.get('手动总结开始楼层'), end = f.get('手动总结结束楼层');
    assert.equal(start.value, '3'); assert.equal(end.value, '8');
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(7) } });
    assert.equal(start.value, '3'); assert.equal(end.value, '6'); assert.equal(end.max, '6');
    // A swipe/edit that keeps the count leaves the default as is.
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(7) } });
    assert.equal(start.value, '3'); assert.equal(end.value, '6');
    // A typed range that still fits is kept after a deletion.
    start.value = '1'; end.value = '4';
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(6) } });
    assert.equal(start.value, '1'); assert.equal(end.value, '4');
    // Once the deletion leaves it out of range it is replaced by the new default.
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(4) } });
    assert.equal(start.value, '3'); assert.equal(end.value, '3');
    // The replacement is auto again, so later floors are followed.
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(8) } });
    assert.equal(start.value, '3'); assert.equal(end.value, '7');
    // Deleting into summarized floors falls back to the whole remaining chat.
    start.value = '5'; end.value = '7';
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(3) } });
    assert.equal(start.value, '2'); assert.equal(end.value, '2');
    f.render({ snapshot: { ...f.state.snapshot, messages: [] } });
    assert.equal(start.value, '0'); assert.equal(end.value, '', 'an empty chat has no last floor to show');
    assert.deepEqual(f.calls, []);
});

test('a focused manual range field is not rewritten until the user leaves it', t => {
    const messages = n => Array.from({ length: n }, () => ({ mes: '正文' }));
    const f = fixture({ document: { ...state().document, enabled: true } }); t.after(() => f.view.destroy());
    const end = f.get('手动总结结束楼层'); end.focus(); end.value = '8';
    f.render({ snapshot: { ...f.state.snapshot, messages: messages(5) } });
    assert.equal(end.value, '8');
    f.document.activeElement = null; f.render({ snapshot: { ...f.state.snapshot, messages: messages(5) } });
    assert.equal(end.value, '4');
});

test('an initially empty chat receives usable ranges without replacing an edited range on later refreshes', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [], initialRange: null }, snapshot: { binding: { avatar: 'empty.png', file: 'empty' }, messages: [] } });
    t.after(() => f.view.destroy());
    assert.equal(f.get('手动总结结束楼层').value, '');
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 8 }, () => ({ mes: '正文' })) } });
    assert.equal(f.get('手动总结结束楼层').value, '7');
    f.get('手动总结结束楼层').value = '3';
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 10 }, () => ({ mes: '正文' })) } });
    assert.equal(f.get('手动总结结束楼层').value, '3'); assert.deepEqual(f.calls, []);
});

test('a new custom slice save retains newer time and prose edits in the same editor until confirmed', async t => {
    let finish; const f = fixture({}, () => new Promise(resolve => { finish = resolve; })); t.after(() => f.view.destroy());
    f.get('插入自定义切片').click();
    const text = f.get('自定义切片内容'); text.value = '五月十日，车站。\n正文不再改变'; text.emit('input');
    assert.equal(f.get('场景1日期'),undefined);assert.equal(f.document.querySelector('.ym-scene-editor'),null);
    f.get('保存自定义切片').click(); await f.flush(); assert.equal(f.calls[0].payload.text,text.value);assert.deepEqual(f.calls[0].payload.scenes,[]);
    text.value = '五月十一日，车站。\n正文不再改变'; text.emit('input');
    finish(true); await f.flush();
    assert.equal(f.get('自定义切片内容'), text); assert.equal(text.value, '五月十一日，车站。\n正文不再改变');assert.equal(text.isConnected,true);
    assert.equal(text.closest('.ym-manual-form').hidden, false);
    f.get('保存自定义切片').click(); await f.flush(); assert.equal(f.calls[1].payload.text,text.value);
    finish(true); await f.flush(); assert.equal(text.value, '');assert.equal(f.get('场景1日期'), undefined);
});

test('an existing slice edits time and prose in place and keeps newer typing across an in-flight save', async t => {
    let finish; const initial = entry({scenes:[{date:'五月十日',period:'清晨',place:'车站',characters:['甲'],nature:'present',event:'告别',evidence:{floors:[1]}}]});
    const f = fixture({ document: { enabled: true, settings: {}, entries: [initial] } }, () => new Promise(resolve => { finish = resolve; })); t.after(() => f.view.destroy());
    f.get('编辑第 0–2 层').click(); const text = f.get('编辑记忆内容');
    const card=f.get('编辑第 0–2 层').closest('.ym-memory');assert.equal(card.querySelectorAll('textarea').length,1);
    assert.equal(card.querySelector('.ym-memory-content').hidden,true);assert.ok(f.get('保存修订').closest('.ym-memory-head'));assert.equal(f.get('保存修订').textContent,'');
    assert.match(text.value,/五月十日.*清晨.*车站/);assert.equal(f.get('场景1日期'),undefined);
    text.value=text.value.replace('五月十日','五月十一日');text.emit('input');
    f.get('保存修订').click(); await f.flush(); assert.deepEqual(f.calls[0].payload.scenes,[]);assert.match(f.calls[0].payload.text,/五月十一日/);
    text.value=text.value.replace('五月十一日','五月十二日');text.emit('input');
    f.render({ document: { ...f.state.document, entries: [entry({ revision: 3, edited: true, text:f.calls[0].payload.text,scenes: [] })] } });
    finish(true); await f.flush();
    assert.equal(f.get('编辑记忆内容'), text);assert.equal(text.isConnected,true);assert.match(text.value,/五月十二日/);
    f.get('保存修订').click(); await f.flush(); assert.equal(f.calls[1].payload.expectedRevision, 3); assert.match(f.calls[1].payload.text,/五月十二日/);assert.deepEqual(f.calls[1].payload.scenes,[]);
    finish(true); await f.flush(); assert.equal(f.get('编辑记忆内容'), undefined); assert.equal(text.isConnected, false);
});

test('empty-chat controls remain visible and disabled while default prompt editing is available without a chat', async t => {
    const f=fixture({snapshot:null,document:null,defaults:{revision:7,values:state().defaults.values},service:{status:'ok'}});t.after(()=>f.view.destroy());
    for(const label of ['启用忆幕','自动总结','手动总结开始楼层','手动总结结束楼层','开始总结']){
        const node=f.get(label);assert.ok(node,label);assert.equal(node.closest('[hidden]'),null,label);assert.equal(node.disabled,true,label);
    }
    assert.equal(f.document.querySelector('.ym-hero').dataset.empty,'true');assert.equal(f.document.querySelector('.ym-overview-name').textContent,'请选择一个聊天打开');
    const stats=f.document.querySelector('.ym-stats');assert.equal(stats.hidden,false);assert.deepEqual(stats.querySelectorAll('b').map(n=>n.textContent),['0','0','0']);
    for(const label of ['展开记忆调阅','展开故事续接','展开关联伴读'])assert.equal(f.get(label).disabled,true,label);
    assert.equal(f.get('展开记忆备份').disabled,false);assert.equal(f.get('导入记忆').disabled,false);assert.equal(f.get('导出记忆').disabled,true);
    assert.equal(f.get('续接楼层').disabled,true);assert.equal(f.get('建立新聊天').disabled,true);
    f.get('记忆').click();assert.equal(f.get('搜索记忆').disabled,true);assert.equal(f.get('筛选记忆').disabled,true);assert.equal(stageControl(f).disabled,true);
    f.get('导览').click();const promptFolder=f.get('展开总结提示词');assert.equal(promptFolder.querySelector('[data-ym-icon="expand"]'), null);promptFolder.click();const text=f.get('叙事与依据提示词正文');assert.equal(text.disabled,false);
    text.value='仅依据正文，保留人物所知的区别。';text.emit('input');f.get('保存叙事与依据').click();await f.flush();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'settings');assert.equal(f.calls[0].payload.global,true);assert.equal(f.calls[0].payload.expectedRevision,7);
    assert.equal(f.calls[0].payload.values.prompts.groups.summary[0].text,text.value);
    for(const label of ['载入提示词预设','恢复内置默认','保存提示词','取消提示词修改'])assert.equal(f.get(label),undefined);
});

test('tool folders are exclusive within each row and retain independent state across the other row and reopening', t => {
    const f=fixture();t.after(()=>f.view.destroy());f.view.open();
    const used=f.get('展开记忆调阅'),story=f.get('展开故事续接'),companion=f.get('展开关联伴读'),backup=f.get('展开记忆备份');
    used.click();assert.equal(used.getAttribute('aria-expanded'),'true');assert.equal(story.getAttribute('aria-expanded'),'false');
    story.click();assert.equal(used.getAttribute('aria-expanded'),'false');assert.equal(story.getAttribute('aria-expanded'),'true');
    assert.equal(story.closest('.ym-tool-group').dataset.side,'right');
    companion.click();assert.equal(story.getAttribute('aria-expanded'),'true');assert.equal(companion.getAttribute('aria-expanded'),'true');
    backup.click();assert.equal(companion.getAttribute('aria-expanded'),'false');assert.equal(backup.getAttribute('aria-expanded'),'true');
    f.view.close();f.view.open();assert.equal(story.getAttribute('aria-expanded'),'true');assert.equal(backup.getAttribute('aria-expanded'),'true');
    backup.click();assert.equal(backup.getAttribute('aria-expanded'),'false');assert.deepEqual(f.calls,[]);
});

test('memory notices stay out of settings and disappear when the pending choice is resolved', t => {
    const f=fixture({document:{...state().document,entries:[entry({candidate:{text:'新稿'}})]},status:'两版记忆，请确认采用哪一版'});t.after(()=>f.view.destroy());
    const notice=f.document.querySelector('.ym-status');assert.match(notice.textContent,/两版/);assert.equal(notice.hidden,false);
    f.get('设置').click();assert.equal(notice.hidden,true);assert.equal(notice.textContent,'');
    f.get('记忆').click();assert.match(notice.textContent,/两版/);
    f.render({document:{...f.state.document,entries:[entry()]}});assert.equal(notice.hidden,true);
    f.render({status:'已保存'});assert.equal(notice.hidden,true);
    f.render({error:'总结未完成',errorPage:'memory'});assert.match(notice.textContent,/总结未完成/);
    f.get('设置').click();assert.equal(notice.hidden,true);
});

test('the paired update notice is visible in settings without leaking a memory notice into settings', async t => {
    const d=dom(),requests=[],actions=[];
    d.document.defaultView.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({version:'0.0.0'})};};
    const view=createView({document:d.document,onAction:async(...args)=>actions.push(args)});t.after(()=>view.destroy());
    view.render(state({document:{...state().document,entries:[entry({candidate:{text:'新稿'}})]},status:'两版记忆，请确认采用哪一版'}));
    d.get('设置').click();const notice=d.document.querySelector('.ym-status');assert.equal(notice.hidden,true);
    d.document.querySelector('.ym-version-tag').click();await d.flush();
    assert.equal(notice.hidden,false);assert.equal(notice.textContent,'忆幕前端 v0.8.29 的修订请使用忆幕安装器落盘；服务端未变更时无需单独升级服务端功能。');assert.equal(requests.length,0);assert.deepEqual(actions,[]);
    d.get('记忆').click();assert.equal(notice.hidden,true);d.get('设置').click();assert.equal(notice.hidden,false);
    view.render(state({document:{...state().document,entries:[entry({candidate:{text:'新稿'}})]},status:'两版记忆，请确认采用哪一版'}));
    assert.equal(notice.hidden,true);assert.doesNotMatch(notice.textContent,/两版/);
});

test('the same redo button can stop its own pending action without submitting another model job', async t => {
    let finish;const f=fixture({document:{...state().document,enabled:true,entries:[entry()]}},type=>type==='redo'?new Promise(resolve=>{finish=resolve;}):true);t.after(()=>f.view.destroy());
    f.get('记忆').click();const redo=f.get('重新总结第 0–2 层');redo.click();await f.flush();assert.equal(f.calls.length,1);assert.equal(redo.disabled,true);
    f.render({busy:true,activeEntryId:'slice-a'});assert.equal(redo.disabled,false);assert.match(redo.getAttribute('aria-label'),/停止总结/);
    redo.click();await f.flush();assert.deepEqual(f.calls.map(item=>item.type),['redo','stop']);assert.equal(f.calls[1].payload.entryId,'slice-a');
    f.render({busy:false,activeEntryId:null});finish(true);await f.flush();assert.equal(redo.disabled,false);assert.match(redo.getAttribute('aria-label'),/重新总结/);
});

test('only custom slices have a leading drag handle and deleted records use the same collapsible card structure', async t => {
    const normal=entry(),custom=entry({id:'custom',kind:'manual',source:null,text:'自定义补充'}),removed=entry({id:'gone',source:{start:5,end:6},status:'deleted',history:[{status:'active'}]});
    const f=fixture({document:{...state().document,enabled:true,entries:[normal,custom,removed]}});t.after(()=>f.view.destroy());
    const ordinary=f.document.querySelector('[data-entry-id="slice-a"]'),manual=f.document.querySelector('[data-entry-id="custom"]');
    assert.equal(ordinary.querySelector('.ym-custom-drag'),null);assert.equal(manual.querySelector('summary').children[0],manual.querySelector('.ym-custom-drag'));
    assert.equal(manual.querySelector('.ym-custom-drag').draggable,true);
    const deleted=f.document.querySelector('[data-entry-id="gone"]');assert.equal(deleted.tagName,'DETAILS');assert.equal(deleted.open,false);
    const undo=f.get('撤回删除第 4–5 层');assert.equal(undo.closest('.ym-memory-head'),deleted.querySelector('summary'));assert.equal(undo.textContent,'撤回');
    deleted.open=true;f.render({status:'后台刷新'});assert.equal(f.document.querySelector('[data-entry-id="gone"]').open,true);
    f.get('撤回删除第 4–5 层').click();await f.flush();assert.equal(f.calls[0].payload.action,'undo');
});

test('autosave coalesces typing and drains newer edits only after the earlier save is acknowledged', async t => {
    let finish;const f=fixture({},()=>new Promise(resolve=>{finish=resolve;}),{saveDelayMs:0});t.after(()=>f.view.destroy());
    f.get('设置').click();const input=f.get('正文保留层数');input.value='7';input.emit('input');input.value='8';input.emit('input');
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.values.recent,8);
    input.value='9';input.emit('input');input.emit('blur');assert.equal(f.calls.length,1);
    f.render({document:{...f.state.document,configRevision:1,settings:{recent:8}}});finish(true);await f.flush();
    assert.equal(input.value,'9');assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].payload,{global:false,values:{recent:9},expectedRevision:1});
    f.render({document:{...f.state.document,configRevision:2,settings:{recent:9}}});finish(true);await f.flush();assert.equal(input.value,'9');assert.equal(f.calls.length,2);
});

test('a prior-chat save failure never overwrites the next chat draft and does not strand its deliberate save', async t => {
    let reject;const f=fixture({},()=>f.calls.length===1?new Promise((_,fail)=>{reject=fail;}):true);t.after(()=>f.view.destroy());
    f.get('设置').click();const input=f.get('正文保留层数');input.value='8';input.emit('change');await f.flush();
    f.render({snapshot:{...f.state.snapshot,binding:{...f.state.snapshot.binding,file:'新的聊天'}},document:{...f.state.document,configRevision:5,settings:{recent:6}}});
    f.get('设置').click();input.value='10';input.emit('change');await f.flush();assert.equal(f.calls.length,1);
    reject(Error('旧聊天保存失败'));await f.flush();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].payload,{global:false,values:{recent:10},expectedRevision:5});
    assert.doesNotMatch(f.document.querySelector('.ym-status').textContent,/旧聊天/);
});

test('export confirmation Escape closes only the secondary dialog without changing the main page or writing anything', t => {
    const f=fixture();t.after(()=>f.view.destroy());f.view.open();f.get('展开记忆备份').click();f.get('导出记忆').click();
    const question=f.document.querySelector('.ym-backup-question');assert.equal(question.tagName,'DIALOG');assert.equal(question.open,true);
    const event=question.emit('keydown',{key:'Escape'});assert.equal(event.stopped,true);assert.equal(question.open,false);assert.equal(f.get('忆幕').open,true);assert.deepEqual(f.calls,[]);
});

test('stage expands inline, toggles off with the same icon, and explicitly submits the custom inclusion choice', async t => {
    const first=entry(),second=entry({id:'b',source:{start:4,end:6}});
    const f=fixture({sourceAvailable:true,document:{...state().document,enabled:true,entries:[first,second]},snapshot:{...state().snapshot,messages:Array.from({length:11},()=>({mes:'synthetic'}))}});t.after(()=>f.view.destroy());
    f.get('记忆').click();const icon=stageControl(f),panel=f.document.querySelector('.ym-stage-form');
    icon.click();assert.equal(panel.hidden,false);assert.equal(panel.parentNode.dataset.page,'memory');assert.equal(f.get('导览').getAttribute('aria-selected'),'false');
    assert.equal(f.get('取消阶段整理'),undefined);assert.equal(f.get('包含自定义切片').getAttribute('aria-pressed'),'false');
    icon.click();assert.equal(panel.hidden,true);assert.equal(icon.getAttribute('aria-expanded'),'false');
    icon.click();f.get('包含自定义切片').click();assert.equal(f.get('包含自定义切片').getAttribute('aria-pressed'),'true');
    f.get('开始阶段总结').click();await f.flush();assert.equal(f.calls.at(-1).payload.includeCustom,true);assert.equal(panel.hidden,true);
    const add=f.get('插入自定义切片');assert.equal(add.parentNode,f.get('筛选记忆').parentNode);assert.equal(add.textContent,'');
});

test('budget auto is blank with a concise placeholder and remains per-chat autosave',async t=>{
    const f=fixture();t.after(()=>f.view.destroy());f.get('设置').click();const input=f.get('记忆注入上限');
    assert.equal(input.value,'');assert.equal(input.placeholder,'留空自动');assert.equal(f.get('记忆注入值上限'),undefined);
    input.value='16000';input.emit('change');await f.flush();assert.equal(f.calls.at(-1).payload.values.budget,16000);
    input.value='';input.emit('change');await f.flush();assert.equal(f.calls.at(-1).payload.values.budget,null);
    assert.doesNotMatch(f.document.body.textContent,/token 因模型而异|按需回看相关正文/);
    assert.equal(f.get('阶段总结触发').parentNode.children[0].textContent,'阶段总结触发');
});

test('stage submission freezes its range and custom choice and cannot dismiss a reopened form', async t => {
    let release;
    const f = fixture({sourceAvailable:true,document:{...state().document,enabled:true,entries:[entry(),entry({id:'b',source:{start:4,end:6}})]},snapshot:{...state().snapshot,messages:Array.from({length:11},()=>({mes:'synthetic'}))}}, () => new Promise(resolve => { release = resolve; }));
    t.after(() => f.view.destroy()); f.get('记忆').click(); const icon = stageControl(f), panel = f.document.querySelector('.ym-stage-form'); icon.click();
    f.get('开始阶段总结').click(); await f.flush();
    const choice = f.get('包含自定义切片');
    assert.equal(choice.disabled,true); assert.equal(f.get('阶段摘要开始楼层').disabled,true); assert.equal(f.get('阶段摘要结束楼层').disabled,true);
    choice.click(); assert.equal(choice.getAttribute('aria-pressed'),'false'); assert.equal(f.calls[0].payload.includeCustom,false);
    f.render({status:'后台处理中'}); assert.equal(choice.disabled,true);
    icon.click(); icon.click(); assert.equal(panel.hidden,false);
    release(true); await f.flush(); assert.equal(panel.hidden,false); assert.equal(choice.disabled,false);
});

test('title-only conflict and candidate choices disclose the pending name as safe text', t => {
    const custom = entry({kind:'manual',source:null,title:'本机名称',text:'相同正文',candidate:{title:'候选名称',text:'相同正文'},conflicts:[{id:'rename',title:'<b>名称',text:'相同正文'}]});
    const f = fixture({document:{...state().document,entries:[custom]}}); t.after(() => f.view.destroy());
    const names = f.document.body.querySelectorAll('.ym-candidate-name').map(node => node.textContent);
    assert.deepEqual(names,['名称：候选名称','名称：<b>名称']);
    assert.ok(f.document.body.querySelectorAll('.ym-candidate-name').every(node => node.children.length === 0));
});

test('custom names are edited with prose and late acknowledgement preserves a newer name',async t=>{
    let release;const custom=entry({id:'custom',kind:'manual',source:null,title:'旧标题',text:'固定正文'});
    const f=fixture({document:{...state().document,entries:[custom]}},()=>new Promise(resolve=>{release=resolve;}));t.after(()=>f.view.destroy());
    f.get('编辑自定义切片').click();const title=f.get('编辑自定义切片名称');title.value='新标题';f.get('保存修订').click();await f.flush();
    assert.equal(f.calls[0].payload.title,'新标题');title.value='随后输入';release(true);await f.flush();assert.equal(f.get('编辑自定义切片名称'),title);assert.equal(title.value,'随后输入');
    f.get('取消编辑').click();assert.equal(f.get('编辑自定义切片名称'),undefined);
});

test('slice headings have short names, custom accent class and at most ten recoverable deleted rows',t=>{
    const summary=entry({title:'雨夜重逢'}),custom=entry({id:'custom',kind:'manual',source:null,title:'我的补充'});
    const removed=Array.from({length:12},(_,i)=>entry({id:`removed${i}`,status:'deleted',deletedRevision:i,history:[{status:'active'}]}));
    const marker=entry({id:'discarded',text:'已删除',status:'deleted',discarded:true});
    const replaced=entry({id:'internal-stage',kind:'stage',status:'deleted',replacedBy:'new-stage',deletedRevision:999,history:[{status:'active'}]});
    const f=fixture({document:{...state().document,entries:[summary,custom,...removed,marker,replaced]}});t.after(()=>f.view.destroy());
    const first=f.document.querySelector('[data-entry-id="slice-a"]');assert.equal(first.querySelector('.ym-entry-range').textContent,'楼层0-2');assert.equal(first.querySelector('.ym-entry-name').textContent,'雨夜重逢');
    assert.ok(f.document.querySelector('[data-entry-id="custom"]').querySelector('.ym-custom-name'));
    const rows=f.document.querySelector('.ym-deleted-body').children;assert.equal(rows.length,10);assert.equal(rows[0].dataset.entryId,'removed11');
    assert.equal(f.document.querySelector('[data-entry-id="discarded"]'),null);assert.equal(rows[0].querySelector('.ym-undo-tag').textContent,'撤回');
    assert.equal(f.document.querySelector('[data-entry-id="internal-stage"]'),null);
});

test('standalone manifest and styles stay within Yimu and include narrow-screen and reduced-motion handling', async () => {
    const root = new URL('../yimu/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const css = await readFile(new URL('style.css', root), 'utf8');
    assert.equal(manifest.generate_interceptor, 'yimuGenerationInterceptor');
    assert.equal(manifest.js, `index.mjs?v=${manifest.version}`); assert.equal(manifest.css, `style.css?v=${manifest.version}`); assert.equal(manifest.version, '0.8.29'); assert.equal(pkg.version, '0.8.10');
    assert.match(css, /max-width: 480px/); assert.match(css, /100dvh/); assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(css, /(?:^|\n)(?:body|html|#chat|#send_form)\s*[{,]/);
    assert.match(css, /url\('\.\/logo\.svg'\)/);
    assert.match(css, /\.ym-menu-entry \.ym-logo \{ width: 20px; height: 20px; flex: 0 0 20px; align-self: center; color: inherit;/);
    assert.match(css, /\.ym-send-entry\[hidden\] \{ display: none !important;/);
    assert.match(css, /data-ym-state="ready"\] \{ color: #7d98a6;/);
    assert.match(css, /data-ym-state="failed"\] \{ color: #ad858b;/);
    assert.match(css, /data-ym-state="neutral"\] \{ color: #949494;/);
    assert.match(css, /@keyframes ym-shortcut-breathe/);
    assert.match(css, /\.ym-send-entry\[data-ym-busy="true"\] \{ animation: ym-shortcut-breathe/);
});
