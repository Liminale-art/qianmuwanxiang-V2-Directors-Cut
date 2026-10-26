import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupView } from '../yimu/backup-view.mjs';
import { createStoryView } from '../yimu/story-view.mjs';
import { mountCompanionView } from '../yimu/companion-view.mjs';

// Behavior fixture only. Real sizing and theme checks belong to the browser pass.
function dom() {
    const all = node => node.children.flatMap(child => [child, ...all(child)]);
    class Node {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.events = {}; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.className = ''; this._text = ''; }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; }
        remove() { this.removed = true; }
        set textContent(value) { this._text = String(value); this.children = []; }
        get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
        set innerHTML(_) { throw Error('User content must remain text'); }
        setAttribute(name, value) { this.attrs[name] = String(value); }
        getAttribute(name) { return this.attrs[name]; }
        removeAttribute(name) { delete this.attrs[name]; }
        showModal() { this.open = true; this.modalOpens = (this.modalOpens || 0) + 1; }
        close() { this.open = false; }
        addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
        emit(name, details = {}) { const event = { target: this, ...details, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } }; for (const fn of this.events[name] || []) fn(event); return event; }
        click() { if (!this.disabled) this.emit('click'); }
        querySelectorAll(selector) { return all(this).filter(n => selector.split(',').some(tag => n.tagName.toLowerCase() === tag.trim())); }
    }
    const document = { createElement: tag => new Node(tag) };
    const el = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };
    const button = (label, callback) => { const n = el('button', 'ym-button', label); n.setAttribute('aria-label', label); n.addEventListener('click', callback); return n; };
    return { document, el, button, all, get: (root, label) => all(root).find(n => n.attrs['aria-label'] === label), async flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); } };
}
const binding = { avatar: 'Synthetic.png', file: 'Synthetic', integrity: 'synthetic_identity' };
const state = (patch = {}) => ({ snapshot: { binding, name: '合成角色', messages: Array.from({ length: 9 }, () => ({ mes: '仅用于本地验证' })) }, document: { enabled: false, entries: [], settings: {} }, defaults: { values: { recent: 5 } }, sourceAvailable: true, loading: false, service: { status: 'ok' }, ...patch });

test('secondary views default to collapsible cards but page mode has no duplicate outer heading', () => {
    const d = dom();
    for (const create of [createBackupView, createStoryView]) {
        const folded = create({ document: d.document });
        assert.equal(folded.node.tagName, 'DETAILS'); assert.equal(folded.node.children[0].tagName, 'SUMMARY');
        const page = create({ document: d.document, pageMode: true });
        assert.equal(page.node.tagName, 'SECTION'); assert.equal(page.node.children.some(n => n.tagName === 'SUMMARY'), false);
        assert.match(page.node.className, /ym-subpage-section/);
    }
    const companion = mountCompanionView({ ...d, onAction: async () => {}, pageMode: true });
    assert.equal(companion.element.tagName, 'SECTION'); assert.equal(companion.element.children.some(n => n.tagName === 'SUMMARY'), false);
});

test('backup exposes two same-row actions and export cancellation never becomes a memory-only download',async()=>{
    const d=dom(),calls=[],view=createBackupView({document:d.document,pageMode:true,onAction:async(...args)=>calls.push(args)});view.render(state());
    const get=label=>d.get(view.node,label),row=d.all(view.node).find(node=>node.className.includes('ym-backup-actions'));
    assert.deepEqual(row.children.map(node=>node.textContent),['导出记忆','导入记忆']);
    get('导出记忆').click();assert.deepEqual(calls,[]);assert.match(view.node.textContent,/是否将相关聊天文件一起打包/);
    get('取消导出').click();await d.flush();assert.deepEqual(calls,[]);
    get('导出记忆').click();get('否，仅导出记忆').click();await d.flush();assert.deepEqual(calls,[['backupQuickExport',{includeOriginals:false}]]);
    const files=[{name:'a.yimu.gz'},{name:'b.yimu.gz'}],picker=get('忆幕备份文件');picker.files=files;picker.emit('change');await d.flush();
    assert.equal(picker.multiple,true);assert.deepEqual(calls.at(-1),['backupImport',{files}]);assert.equal(get('附带ST聊天原件'),undefined);
});

test('export is a separate modal and Escape/cancel never propagates to the memory panel or starts export',async()=>{
    const d=dom(),calls=[],view=createBackupView({document:d.document,pageMode:true,onAction:async(...args)=>calls.push(args)});view.render(state());
    const get=label=>d.get(view.node,label),modal=d.all(view.node).find(node=>node.tagName==='DIALOG');
    get('导出记忆').click();assert.equal(modal.open,true);assert.equal(modal.hidden,false);
    view.render(state());assert.equal(modal.modalOpens,1);
    const escape=modal.emit('keydown',{key:'Escape'});assert.equal(escape.defaultPrevented,true);assert.equal(escape.propagationStopped,true);assert.equal(modal.open,false);
    get('导出记忆').click();const cancel=modal.emit('cancel');assert.equal(cancel.defaultPrevented,true);assert.equal(cancel.propagationStopped,true);assert.equal(modal.open,false);
    assert.equal(view.node.removed,undefined);await d.flush();assert.deepEqual(calls,[]);
    const picker=get('忆幕备份文件'),fileCancel=picker.emit('cancel');assert.equal(fileCancel.propagationStopped,true);assert.deepEqual(calls,[]);
});

test('yes exports a sole main original directly but ancestors remain individual necessary selections',async()=>{
    const d=dom(),calls=[];let view,plan={planId:'export',binding,primarySourceId:'main',sources:[{id:'main',available:true,label:'原聊天'}]};
    const s=()=>state({backup:{exportPlan:plan}});view=createBackupView({document:d.document,pageMode:true,onAction:async(type,payload)=>{calls.push([type,payload]);if(type==='backupPlan'){view.render(s());return plan;}}});view.render(s());
    const get=label=>d.get(view.node,label);get('导出记忆').click();get('是，一起打包').click();await d.flush();
    assert.deepEqual(calls,[['backupPlan',{}],['backupQuickExport',{includeOriginals:true,planId:'export',sourceIds:['main']}]]);
    plan={...plan,planId:'ancestors',sources:[...plan.sources,{id:'ancestor',available:true,label:'祖先聊天'},{id:'missing',available:false,label:'未恢复来源'}]};view.render(s());
    get('导出记忆').click();get('是，一起打包').click();await d.flush();assert.equal(calls.length,3);
    assert.equal(get('原聊天').checked,true);assert.equal(get('祖先聊天').checked,false);assert.equal(get('未恢复来源').disabled,true);
    get('祖先聊天').checked=true;get('祖先聊天').emit('change');view.node.hidden=true;view.render(s());view.node.hidden=false;assert.equal(get('祖先聊天').checked,true);
    get('打包并导出').click();await d.flush();assert.deepEqual(calls.at(-1),['backupQuickExport',{includeOriginals:true,planId:'ancestors',sourceIds:['main','ancestor']}]);
});

test('cancel or a changed chat while original planning is pending never starts a download',async()=>{
    const d=dom(),calls=[];let release;const plan={planId:'p',primarySourceId:'main',sources:[{id:'main',available:true}]};
    const view=createBackupView({document:d.document,onAction:async(type,payload)=>{calls.push([type,payload]);if(type==='backupPlan')return new Promise(resolve=>{release=()=>resolve(plan);});}});view.render(state());
    const get=label=>d.get(view.node,label);get('导出记忆').click();get('是，一起打包').click();get('取消导出').click();release();await d.flush();assert.equal(calls.length,1);
    get('导出记忆').click();get('是，一起打包').click();view.render(state({snapshot:{...state().snapshot,binding:{...binding,file:'other'}}}));release();await d.flush();assert.equal(calls.length,2);
});

test('backup errors retain retry controls while completed files notify only once and leave no card', async () => {
    const d=dom(),calls=[],notices=[],view=createBackupView({document:d.document,pageMode:true,onNotice:(...args)=>notices.push(args),onAction:async(...args)=>calls.push(args)});view.render(state());
    view.render(state({backup:{items:[{id:'a',name:'first.yimu.gz',status:'merge-unknown',error:'连接中断'},{id:'b',name:'second.yimu.gz',status:'complete',message:'已导入：另一聊天'}]}}));
    assert.match(view.node.textContent,/连接中断/);assert.doesNotMatch(view.node.textContent,/已导入：另一聊天/);assert.deepEqual(notices,[['已导入：另一聊天','success']]);
    d.get(view.node,'核对并继续本次导入').click();await d.flush();assert.deepEqual(calls[0],['backupRetry',{itemId:'a'}]);
    assert.equal(d.get(view.node,'已导入备份'),undefined);
});

test('an export source check failure stays visible inside the modal with memory-only fallback',async()=>{
    const d=dom(),calls=[],view=createBackupView({document:d.document,pageMode:true,onAction:async(type,payload)=>{calls.push([type,payload]);if(type==='backupPlan')throw new Error('聊天文件当前不可读取');}});view.render(state());
    const get=label=>d.get(view.node,label);get('导出记忆').click();get('是，一起打包').click();await d.flush();
    const modal=d.all(view.node).find(node=>node.tagName==='DIALOG');assert.equal(modal.open,true);
    assert.ok(modal.children.some(node=>!node.hidden&&node.textContent==='聊天文件当前不可读取'));
    get('否，仅导出记忆').click();await d.flush();assert.equal(modal.open,false);assert.deepEqual(calls.at(-1),['backupQuickExport',{includeOriginals:false}]);
});

test('story keeps one cutoff and one action without a preview stage', async () => {
    const d=dom(),calls=[],view=createStoryView({document:d.document,pageMode:true,onAction:async(...args)=>calls.push(args)});
    const s=state();view.render(s);const get=label=>d.get(view.node,label);
    const row=d.all(view.node).find(node=>node.className==='ym-story-controls');assert.ok(row.children.includes(get('建立新聊天')));assert.ok(row.children[0].children.includes(get('续接楼层')));
    assert.equal(get('续接楼层').value,'9');get('续接楼层').value='4';get('续接楼层').emit('input');
    view.node.hidden=true;view.render(s);view.node.hidden=false;assert.equal(get('续接楼层').value,'4');
    get('建立新聊天').click();await d.flush();assert.deepEqual(calls[0],['storyContinue',{cutoff:4}]);assert.equal(get('预览带入内容'),undefined);
});

test('story omissions appear once in an ST warning, never as a permanent row; complete transfers stay success', async () => {
    for (const transferNote of [undefined, '2 份人工记忆、3 层较早正文留在原聊天']) {
        const d = dom(), notices = [], result = {receipt: {status: 'complete'}, openResult: {opened: true}, ...(transferNote ? {transferNote} : {})};
        const view = createStoryView({document: d.document, pageMode: true, onNotice: (...args) => notices.push(args), onAction: async () => result});
        const s = state(); view.render(s); d.get(view.node, '建立新聊天').click(); await d.flush();
        assert.deepEqual(notices, [[transferNote ? `已建立忆幕续接聊天；${transferNote}。` : '已建立忆幕续接聊天。', transferNote ? 'warning' : 'success']]);
        view.render(s); view.render(s); assert.equal(notices.length, 1);
        assert.doesNotMatch(view.node.textContent, /留在原聊天|已建立忆幕续接聊天/);
        view.destroy();
    }
});

test('companion page preserves selected cutoff but never carries consent to another chat', () => {
    const d = dom(), view = mountCompanionView({ ...d, pageMode: true, onAction: async () => {} });
    const s = state({ companion: { list: { items: [{ key: 'synthetic', title: '合成书', readTo: 20, avatar: 'Synthetic.png', persona: 'User' }] } } });
    view.render(s); const get = label => d.get(view.element, label);
    get('共同已读位置').value = '15'; get('共同已读位置').emit('input');
    get('确认伴读记录与已读位置').checked = true; get('确认伴读记录与已读位置').emit('change');
    view.element.hidden = true; view.render({ ...s, companion: { ...s.companion, busy: true } }); view.element.hidden = false;
    assert.equal(get('共同已读位置').value, '15'); assert.equal(get('确认伴读记录与已读位置').checked, true); assert.equal(get('读取并预览摘要').disabled, true);
    view.render({ ...s, snapshot: { ...s.snapshot, binding: { ...binding, file: 'Other' } } });
    assert.equal(get('确认伴读记录与已读位置').checked, false); assert.equal(get('读取并预览摘要').disabled, true);
});

test('backup outcomes toast once, no completed cards or empty idle result grid remain',()=>{
    const d=dom(),notices=[],view=createBackupView({document:d.document,onNotice:(...args)=>notices.push(args)});view.render(state());
    const completed=state({backup:{items:[{id:'a',name:'one.yimu.gz',status:'complete',message:'记忆已导入'}]}});
    view.render(completed);view.render(structuredClone(completed));assert.deepEqual(notices,[['记忆已导入','success']]);
    const grid=d.all(view.node).find(n=>n.className==='ym-backup-list');assert.equal(grid.hidden,true);assert.equal(grid.children.length,0);
    const exportDone=state({backup:{status:'备份已生成，已发起下载。'}});view.render(exportDone);view.render(exportDone);assert.equal(notices.length,2);
});

test('backup state published before promise rejection reports one error, while a deliberate retry can report again',async()=>{
    const d=dom(),notices=[];let view;
    view=createBackupView({document:d.document,onNotice:(...args)=>notices.push(args),onAction:async()=>{
        view.render(state({backup:{busy:true,error:''}}));
        view.render(state({backup:{busy:false,error:'网络中断'}}));
        throw new Error('网络中断');
    }});
    view.render(state());const get=label=>d.get(view.node,label);
    for(let attempt=1;attempt<=2;attempt++){
        get('导出记忆').click();get('否，仅导出记忆').click();await d.flush();
        assert.equal(notices.length,attempt);assert.deepEqual(notices.at(-1),['网络中断','error']);
    }
});

test('backup promise rejection without a published error still notifies once',async()=>{
    const d=dom(),notices=[],view=createBackupView({document:d.document,onNotice:(...args)=>notices.push(args),onAction:async()=>{throw new Error('读取失败');}});
    view.render(state());d.get(view.node,'导出记忆').click();d.get(view.node,'否，仅导出记忆').click();await d.flush();
    assert.deepEqual(notices,[['读取失败','error']]);
    view.render(state({backup:{error:'读取失败'}}));assert.equal(notices.length,1);
});

test('companion preview preserves ownership through cloned refreshes and selection changes invalidate confirmation',()=>{
    const d=dom(),view=mountCompanionView({...d,onAction:async()=>{},pageMode:true});
    const list={items:[{key:'a',title:'书A',readTo:10},{key:'b',title:'书B',readTo:30}]};
    const initial=state({companion:{list}});view.render(initial);let get=label=>d.get(view.element,label);
    get('共同已读位置').value='8';get('共同已读位置').emit('input');get('确认伴读记录与已读位置').checked=true;get('确认伴读记录与已读位置').emit('change');
    const preview=structuredClone(initial);preview.companion.query={key:'a',confirmedReadTo:8};preview.companion.preview={entries:[{kind:'book',text:'截至八层的书中背景'},{kind:'dialogue',text:'共同讨论的约定'}]};
    view.render(preview);assert.equal(get('共同已读位置').value,'8');assert.equal(get('确认关联以上摘要').disabled,false);
    get('伴读记录').value='b';get('伴读记录').emit('change');assert.equal(get('共同已读位置').value,'30');assert.equal(get('确认关联以上摘要').disabled,true);assert.equal(get('读取并预览摘要').disabled,true);
});
