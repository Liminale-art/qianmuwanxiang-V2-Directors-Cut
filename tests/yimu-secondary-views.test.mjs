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

test('backup page retains explicit file/source choices across navigation and ordinary state updates', async () => {
    const d = dom(), calls = [], view = createBackupView({ document: d.document, pageMode: true, onAction: async (...args) => calls.push(args) });
    const s = state({ backup: { exportPlan: { planId: 'export', binding, sources: [{ id: 'main', available: true, label: '原聊天' }], primarySourceId: 'main' } } });
    view.render(s);
    const get = label => d.get(view.node, label), picker = get('忆幕备份文件');
    const file = { name: 'synthetic.yimu.gz' }; picker.files = [file]; picker.emit('change');
    get('同时备份聊天记录').checked = true; get('同时备份聊天记录').emit('change');
    get('主聊天 · 原聊天').checked = true; get('主聊天 · 原聊天').emit('change');
    view.node.hidden = true; view.render({ ...s, busy: false }); view.node.hidden = false;
    assert.equal(get('同时备份聊天记录').checked, true); assert.equal(get('主聊天 · 原聊天').checked, true);
    assert.equal(get('确认上传备份包').disabled, false); assert.deepEqual(calls, []);
    get('下载备份包').click(); await d.flush();
    assert.deepEqual(calls[0], ['backupExport', { includeOriginals: true, sourceIds: ['main'] }]);
    get('确认上传备份包').click(); await d.flush();
    assert.deepEqual(calls[1], ['backupImport', { file }]);
    view.render({ ...s, snapshot: { ...s.snapshot, binding: { ...binding, file: 'Other' } } });
    assert.equal(get('下载备份包').disabled, true, 'export plan must still match the selected chat');
});

test('backup page never imports on selection and preserves actionable failure without losing the file', async () => {
    const d = dom(), calls = [], view = createBackupView({ document: d.document, pageMode: true, onAction: async (...args) => { calls.push(args); throw Error('连接中断'); } });
    view.render(state({ snapshot: null, document: null }));
    const get = label => d.get(view.node, label), picker = get('忆幕备份文件');
    picker.files = [{ name: 'synthetic.yimu.gz' }]; picker.emit('change');
    assert.deepEqual(calls, []); get('确认上传备份包').click(); await d.flush();
    assert.equal(view.node.textContent.split('连接中断').length - 1, 1); assert.equal(get('确认上传备份包').disabled, false);
    view.render(state({ backup: { uploadPending: true } }));
    assert.equal(get('选择忆幕备份包').disabled, true); assert.equal(get('确认上传备份包').hidden, true); assert.equal(get('核对本次上传').hidden, false);
});

test('archived revisions render readable literal text instead of raw data or active controls', () => {
    const d = dom(), view = createBackupView({ document: d.document, pageMode: true });
    view.render(state({ backup: { selected: { id: 'one', sources: [], title: '合成备份' }, document: { entries: [{ kind: 'summary', status: 'active', text: '<img>正文', history: [{ revision: 1, text: '旧修订', source: { hashes: ['private-internal-hash'] } }], conflicts: [{ reason: '另一端已修改', text: '其他版本' }], candidate: { text: '候选版本' } }] } } }));
    assert.match(view.node.textContent, /记忆切片/); assert.match(view.node.textContent, /旧修订/); assert.match(view.node.textContent, /其他版本/); assert.match(view.node.textContent, /候选版本/);
    assert.doesNotMatch(view.node.textContent, /private-internal-hash|"hashes"|已导入资料/);
    assert.equal(view.node.querySelectorAll('img').length, 0); assert.equal(view.node.querySelectorAll('textarea').length, 0);
});

test('story page retains branch draft on return and requires a new preview when cutoff changes', async () => {
    const d = dom(), calls = [], view = createStoryView({ document: d.document, pageMode: true, onAction: async (...args) => calls.push(args) });
    const s = state(); view.render(s); const get = label => d.get(view.node, label);
    get('故事延续方式').value = 'branch'; get('故事延续方式').emit('change');
    get('故事分支截止楼层').value = '4'; get('故事分支截止楼层').emit('input');
    get('预览带入内容').click(); await d.flush(); assert.deepEqual(calls[0], ['storyPlan', { mode: 'branch', cutoff: 4 }]);
    const next = { ...s, story: { plan: { planId: 'p', sourceBinding: binding, mode: 'branch', cutoff: 4, bridgeCount: 4, inheritedCount: 1, manualChoices: [], boundaries: [] } } };
    view.render(next); view.node.hidden = true; view.render(next); view.node.hidden = false;
    assert.equal(get('故事分支截止楼层').value, '4'); assert.equal(get('确认建立新聊天').disabled, false);
    get('故事分支截止楼层').value = '3'; get('故事分支截止楼层').emit('input');
    assert.equal(get('确认建立新聊天').disabled, true); assert.equal(calls.length, 1);
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
