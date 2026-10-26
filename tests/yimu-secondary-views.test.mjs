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
        addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
        emit(name) { for (const fn of this.events[name] || []) fn({ target: this }); }
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

test('backup selection immediately imports a batch and keeps originals opt-in stable across navigation', async () => {
    const d=dom(),calls=[],view=createBackupView({document:d.document,pageMode:true,onAction:async(...args)=>calls.push(args)});
    const s=state({backup:{exportPlan:{planId:'export',binding,primarySourceId:'main',sources:[{id:'main',available:true,label:'原聊天'}]}}});
    view.render(s);const get=label=>d.get(view.node,label),picker=get('忆幕备份文件');const files=[{name:'a.yimu.gz'},{name:'b.yimu.gz'}];picker.files=files;picker.emit('change');await d.flush();
    assert.deepEqual(calls[0],['backupImport',{files}]);assert.equal(picker.multiple,true);assert.equal(get('附带ST聊天原件').checked,false);
    get('附带ST聊天原件').checked=true;get('附带ST聊天原件').emit('change');await d.flush();
    view.node.hidden=true;view.render(s);view.node.hidden=false;
    assert.equal(get('附带ST聊天原件').checked,true);assert.equal(get('原聊天').checked,true);
    get('导出当前记忆').click();await d.flush();assert.deepEqual(calls.at(-1),['backupQuickExport',{includeOriginals:true,planId:'export',sourceIds:['main']}]);
});

test('backup errors are actionable and completed files retain their independent outcome', async () => {
    const d=dom(),calls=[],view=createBackupView({document:d.document,pageMode:true,onAction:async(...args)=>calls.push(args)});
    view.render(state({backup:{items:[{id:'a',name:'first.yimu.gz',status:'merge-unknown',error:'连接中断'},{id:'b',name:'second.yimu.gz',status:'complete',message:'已导入：另一聊天'}]}}));
    assert.match(view.node.textContent,/连接中断/);assert.match(view.node.textContent,/已导入：另一聊天/);
    d.get(view.node,'核对并继续本次导入').click();await d.flush();assert.deepEqual(calls[0],['backupRetry',{itemId:'a'}]);
    assert.equal(d.get(view.node,'已导入备份'),undefined);
});

test('story keeps one cutoff and one action without a preview stage', async () => {
    const d=dom(),calls=[],view=createStoryView({document:d.document,pageMode:true,onAction:async(...args)=>calls.push(args)});
    const s=state();view.render(s);const get=label=>d.get(view.node,label);
    assert.equal(get('续接楼层').value,'9');get('续接楼层').value='4';get('续接楼层').emit('input');
    view.node.hidden=true;view.render(s);view.node.hidden=false;assert.equal(get('续接楼层').value,'4');
    get('建立新聊天').click();await d.flush();assert.deepEqual(calls[0],['storyContinue',{cutoff:4}]);assert.equal(get('预览带入内容'),undefined);
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
