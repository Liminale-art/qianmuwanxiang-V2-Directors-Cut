import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createView, mountEntries, orderedEntries, sourceLabel, groupMemoryEntries } from '../yimu/view.mjs';

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
        set innerHTML(_) { throw Error('Untrusted markup must not be parsed'); }
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
const entry = (patch = {}) => ({ id: 'slice-a', revision: 2, kind: 'summary', text: '两人第一次约会。甲没有得知乙的秘密。', source: { start: 1, end: 3, hashes: ['a', 'b', 'c'] }, status: 'active', edited: false, history: [], conflicts: [], ...patch });
const stage = (parents, patch = {}) => entry({ id: 'stage-one', kind: 'stage', text: '这段经历改变了两人的关系。', source: { ranges: parents.map(parent => parent.source), parents: parents.map(parent => ({ id: parent.id, revision: parent.revision })) }, ...patch });
const state = (patch = {}) => ({
    snapshot: { binding: { avatar: '角色.png', file: '聊天', integrity: 'uuid-fixture' }, name: '角色', messages: Array.from({ length: 9 }, () => ({ mes: 'fixture' })) },
    document: { enabled: false, configRevision: 0, settings: {}, initialRange: null, entries: [] },
    defaults: { revision: 0, values: { recent: 5, trigger: 4000, batch: 6000, budget: 0, preference: '', profileId: '', model: '' } },
    loading: false, busy: false, error: '', profiles: [{ id: 'custom-profile', name: '独立连接' }], ...patch,
});
function fixture(patch, handler) {
    const d = dom(), calls = [];
    const view = createView({ document: d.document, onAction: async (type, payload) => { calls.push({ type, payload }); return handler?.(type, payload); } });
    let current = state(patch); view.render(current);
    return { ...d, calls, view, render(next) { current = { ...current, ...next }; view.render(current); }, get state() { return current; } };
}

test('opening a panel only displays its frontend and does not enable, summarize or save', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    f.view.open(); assert.equal(f.get('忆幕').open, true);
    assert.equal(f.calls.length, 0); assert.equal(f.get('此聊天启用忆幕').checked, false);
    assert.equal(f.get('整理未覆盖内容').disabled, true);
    assert.equal(f.get('忆幕').querySelectorAll('article').length, 0);
});

test('first enable asks inline for the complete adjustable range, rejects invalid bounds and sends explicit confirmation', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const toggle = f.get('此聊天启用忆幕'); toggle.checked = true; toggle.emit('change');
    assert.equal(f.calls.length, 0); assert.equal(f.get('开始楼层').value, '1'); assert.equal(f.get('结束楼层').value, '9');
    f.get('开始楼层').value = '8'; f.get('结束楼层').value = '3'; f.get('确认并开启').click(); await f.flush();
    assert.equal(f.calls.length, 0); assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /有效的起止/);
    f.get('开始楼层').value = '2'; f.get('结束楼层').value = '8'; f.get('确认并开启').click(); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'enable', payload: { enabled: true, range: { start: 2, end: 8, total: 9 } } }]);
});

test('canceling first-enable scope does not write, while a new empty chat can be enabled without an invalid range', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    f.get('此聊天启用忆幕').checked = true; f.get('此聊天启用忆幕').emit('change'); f.get('取消').click();
    assert.equal(f.calls.length, 0); assert.equal(f.get('此聊天启用忆幕').checked, false);
    f.render({ snapshot: { ...f.state.snapshot, messages: [] } });
    f.get('此聊天启用忆幕').checked = true; f.get('此聊天启用忆幕').emit('change'); await f.flush();
    assert.deepEqual(f.calls[0], { type: 'enable', payload: { enabled: true, range: { start: 1, end: 0, total: 0 } } });
});

test('background work never disables the per-chat off action, and reopening a known chat does not ask initial range again', async t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [], initialRange: { start: 1, end: 9, total: 9 } }, busy: true }); t.after(() => f.view.destroy());
    const toggle = f.get('此聊天启用忆幕'); assert.equal(toggle.disabled, false);
    toggle.checked = false; toggle.emit('change'); await f.flush(); assert.deepEqual(f.calls[0], { type: 'enable', payload: { enabled: false } });
    toggle.checked = true; toggle.emit('change'); await f.flush(); assert.deepEqual(f.calls[1], { type: 'enable', payload: { enabled: true } });
});

test('source ordering excludes deleted entries and preserves explicit source-free manual supplements', () => {
    const items = [entry({ id: 'manual', source: null, kind: 'manual' }), entry({ id: 'later', source: { start: 8, end: 12 } }), entry(), entry({ id: 'deleted', status: 'deleted' })];
    assert.deepEqual(orderedEntries(items).map(item => item.id), ['slice-a', 'later', 'manual']);
    assert.equal(sourceLabel(items[0]), '手动补充'); assert.equal(sourceLabel(items[2]), '第 1–3 层');
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
    assert.equal(group.querySelectorAll('article').length, 2);
    assert.match(group.querySelector('summary').textContent, /细摘要（2）/);
    group.open = true; f.render({ status: '其他条目正在整理' });
    assert.equal(f.get('忆幕').querySelector('.ym-stage-children'), group); assert.equal(group.open, true);
});

test('manual stage selection accepts only full fine boundaries, skips manual revisions, and sends no raw chat data', async t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const revised = entry({ id: 'slice-manual', source: { start: 7, end: 9 }, edited: true });
    const later = entry({ id: 'slice-later', source: { start: 10, end: 12 } }), last = entry({ id: 'slice-last', source: { start: 13, end: 15 } });
    const f = fixture({ sourceAvailable: true, document: { enabled: true, settings: {}, entries: [one, two, revised, later, last] } }); t.after(() => f.view.destroy());
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 20 }, () => ({ mes: 'synthetic' })) } });
    f.get('整理阶段摘要').click();
    assert.equal(f.get('阶段摘要开始楼层').value, '1'); assert.equal(f.get('阶段摘要结束楼层').value, '15');
    f.get('阶段摘要开始楼层').value = '2'; f.get('确认整理阶段摘要').click(); await f.flush(); assert.equal(f.calls.length, 0);
    f.get('阶段摘要开始楼层').value = '1'; f.get('阶段摘要开始楼层').emit('input');
    assert.match(f.get('忆幕').querySelector('.ym-stage-form').textContent, /将整理 4 份细摘要；手动修订保持独立/);
    f.get('确认整理阶段摘要').click(); await f.flush();
    assert.deepEqual(f.calls, [{ type: 'stage', payload: { start: 1, end: 15 } }]);
});

test('manual stage selection shares stage ownership rules including stopped, deleted and invalid stages', t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const later = entry({ id: 'slice-later', source: { start: 7, end: 9 } }), last = entry({ id: 'slice-last', source: { start: 10, end: 12 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [] } }); t.after(() => f.view.destroy());
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 17 }, () => ({ mes: 'synthetic' })) } });
    for (const status of ['active', 'excluded', 'deleted', 'invalid']) {
        const overview = stage([one, two], { status });
        f.render({ document: { ...f.state.document, entries: [one, two, later, last, overview] } });
        assert.equal(f.get('整理阶段摘要').disabled, false);
        f.get('整理阶段摘要').click();
        assert.equal(f.get('阶段摘要开始楼层').value, '7'); assert.equal(f.get('阶段摘要结束楼层').value, '12');
        f.get('取消阶段整理').click();
        f.render({ document: { ...f.state.document, entries: [one, two, overview] } });
        assert.equal(f.get('整理阶段摘要').disabled, true, `${status} parents must not appear as a new group`);
    }
    assert.equal(f.calls.length, 0);
});

test('stage controls reject singleton, disjoint, recent and locally invalid fine selections before dispatch', async t => {
    const one = entry(), two = entry({ id: 'slice-b', source: { start: 4, end: 6 } });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [one, two] } }); t.after(() => f.view.destroy());
    assert.equal(f.get('整理阶段摘要').disabled, true, 'recent cutoff leaves only one eligible fine slice');
    f.render({ snapshot: { ...f.state.snapshot, messages: Array.from({ length: 14 }, () => ({ mes: 'synthetic' })) } });
    f.get('整理阶段摘要').click();
    assert.equal(f.get('确认整理阶段摘要').disabled, false);
    f.get('阶段摘要结束楼层').value = '3'; f.get('阶段摘要结束楼层').emit('input');
    assert.equal(f.get('确认整理阶段摘要').disabled, true);
    f.get('忆幕').querySelector('.ym-stage-form').requestSubmit(); await f.flush(); assert.equal(f.calls.length, 0);
    f.render({ invalidSourceIds: ['slice-b'] }); assert.equal(f.get('整理阶段摘要').disabled, true);
    assert.equal(two.status, 'active', 'derived source invalidity does not mutate stored entries');
    f.render({ invalidSourceIds: [], document: { ...f.state.document, entries: [one, { ...two, source: { start: 7, end: 9 } }] } });
    assert.equal(f.get('整理阶段摘要').disabled, true, 'two isolated slices are not a continuous stage group');
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
    assert.equal(group.open, true); assert.match(group.querySelector('summary').textContent, /编辑中的细摘要/);
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

test('fine-summary recall defaults on but can be disabled without presenting unsupported original-text supplementation', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const recall = f.get('按需回查细摘要'); assert.equal(recall.checked, true);
    recall.checked = false; recall.emit('change'); f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { recall: false }, expectedRevision: 0 });
    assert.doesNotMatch(f.get('忆幕').textContent, /原文自动补充/);
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
    assert.equal(f.get('此聊天启用忆幕').checked, false);
    assert.equal(f.get('整理未覆盖内容').disabled, true);
    assert.equal(Boolean(f.get('重新总结第 1–3 层').disabled), true);
});

test('all memory, draft and candidate text remains literal text instead of executable markup', t => {
    const dangerous = '<img src=x onerror=alert(1)><script>bad()</script>';
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry({ text: dangerous, candidate: { text: dangerous }, conflicts: [{ id: 'other', text: dangerous }] })] } }); t.after(() => f.view.destroy());
    assert.equal(f.all().filter(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length, 0);
    assert.ok(f.all().some(node => node.textContent === dangerous));
});

test('entry edits retain the exact editor and original revision during background refresh, then save against that revision', async t => {
    const initial = entry(); const f = fixture({ document: { enabled: true, settings: {}, entries: [initial] } }); t.after(() => f.view.destroy());
    f.get('编辑第 1–3 层').click(); const input = f.get('编辑记忆内容'); input.value = '我的人工修订'; input.emit('input'); input.focus();
    const remote = entry({ revision: 3, text: '另一设备的新版本' });
    f.render({ document: { ...f.state.document, entries: [remote] }, status: '正在整理其他片段…' });
    assert.equal(f.get('编辑记忆内容'), input); assert.equal(f.document.activeElement, input); assert.equal(input.value, '我的人工修订');
    f.get('保存修订').click(); await f.flush();
    assert.deepEqual(f.calls[0], { type: 'edit', payload: { entryId: initial.id, expectedRevision: 2, text: '我的人工修订' } });
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
    const current = entry({ edited: true, status: 'invalid', history: [{ text: 'old' }], candidate: { text: '新候选' }, conflicts: [{ id: 'conflict-b', text: '另一端修改' }] });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [current] } }); t.after(() => f.view.destroy());
    f.get('采用候选').click(); await f.flush(); f.get('保留已保存版本').click(); await f.flush(); f.get('撤回上次修改').click(); await f.flush(); f.get('保留为手动补充').click(); await f.flush();
    assert.deepEqual(f.calls.map(call => call.payload), [
        { entryId: 'slice-a', expectedRevision: 2, action: 'acceptCandidate' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'discardConflict', conflictId: 'conflict-b' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'undo' },
        { entryId: 'slice-a', expectedRevision: 2, action: 'keepManual' },
    ]);
});

test('current-chat overrides and global defaults save independently, with explicit per-field follow-default resets', async t => {
    const f = fixture({ document: { enabled: false, settings: { recent: 7 }, entries: [] } }); t.after(() => f.view.destroy());
    assert.equal(f.get('近期原文层数').value, '7');
    f.get('近期原文层数跟随默认').click(); assert.equal(f.get('近期原文层数').value, '5');
    f.get('保存设置').click(); await f.flush(); assert.deepEqual(f.calls[0], { type: 'settings', payload: { global: false, values: { recent: null }, expectedRevision: 0 } });
    f.get('全局默认').click(); f.get('近期原文层数').value = '8'; f.get('近期原文层数').emit('input');
    f.get('保存设置').click(); await f.flush(); assert.deepEqual(f.calls[1], { type: 'settings', payload: { global: true, values: { recent: 8 }, expectedRevision: 0 } });
    assert.equal(f.state.defaults.values.recent, 5, 'view itself never mutates canonical defaults');
});

test('settings and manual-add drafts survive status refresh; a failed save does not clear them', async t => {
    const f = fixture({}, () => false); t.after(() => f.view.destroy());
    f.get('记忆整理偏好').value = '保留关系变化'; f.get('记忆整理偏好').emit('input');
    f.get('手动补充').click(); f.get('手动补充内容').value = '只有用户确认的背景'; f.get('手动补充内容').emit('input');
    f.render({ status: '正在整理…' });
    assert.equal(f.get('记忆整理偏好').value, '保留关系变化'); assert.equal(f.get('手动补充内容').value, '只有用户确认的背景');
    f.get('保存补充').click(); await f.flush(); assert.equal(f.get('手动补充内容').value, '只有用户确认的背景');
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

test('the batch capacity follows the default, rejects values below 256, and saves a larger standalone-connection capacity', async t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const batch = f.get('单次整理上限（token）'); assert.equal(batch.value, '6000'); assert.equal(batch.min, '256');
    batch.value = '255'; batch.emit('input'); f.get('保存设置').click(); await f.flush();
    assert.equal(f.calls.length, 0); assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /不小于 256/);
    batch.value = '32000'; batch.emit('input'); f.get('整理连接').value = 'custom-profile'; f.get('整理连接').emit('change');
    f.get('保存设置').click(); await f.flush();
    assert.deepEqual(f.calls[0].payload, { global: false, values: { batch: 32000, profileId: 'custom-profile' }, expectedRevision: 0 });
});

test('unverified source disables all summary launch controls while keeping manual records editable', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [entry()] }, sourceAvailable: false, error: '当前聊天原件尚未通过核对' }); t.after(() => f.view.destroy());
    for (const label of ['整理未覆盖内容', '重试本次整理', '重新总结第 1–3 层']) assert.equal(f.get(label).disabled, true, label);
    assert.equal(f.get('手动补充').disabled, false); assert.equal(f.get('编辑第 1–3 层').disabled, false);
});

test('a successful settings save does not conceal the fact that an unverified chat cannot use memories', t => {
    const f = fixture({ document: { enabled: true, settings: {}, entries: [] }, sourceAvailable: false, status: '已保存' }); t.after(() => f.view.destroy());
    assert.match(f.all().find(node => node.attrs.role === 'status').textContent, /原件尚未通过核对/);
});

test('an unacknowledged source invalidation is visible without changing the canonical entry status', t => {
    const original = entry({ edited: true });
    const f = fixture({ document: { enabled: true, settings: {}, entries: [original] }, sourceAvailable: true, invalidSourceIds: [original.id] }); t.after(() => f.view.destroy());
    assert.match(f.get('忆幕').querySelector('.ym-memory').textContent, /原文已变化，人工修订已保留/);
    assert.equal(original.status, 'active'); assert.ok(f.get('保留为手动补充'));
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
    f.get('手动补充').click(); f.get('手动补充内容').value = '旧聊天'; f.get('手动补充内容').emit('input'); f.get('保存补充').click();
    f.render({ snapshot: { ...f.state.snapshot, binding: { ...f.state.snapshot.binding, file: '另一聊天' } }, status: '另一聊天已加载' });
    reject(Error('旧保存错误')); await f.flush();
    assert.equal(f.get('手动补充内容').value, '');
    assert.equal(f.all().find(node => node.attrs.role === 'status').textContent, '另一聊天已加载');
});

test('dialog restores entry focus on Escape and outside click, retains forms on ordinary close, and does not close for inner clicks', t => {
    const f = fixture(); t.after(() => f.view.destroy());
    const trigger = f.document.createElement('button'); f.document.body.append(trigger); trigger.focus(); f.view.open();
    f.get('手动补充').click(); f.get('手动补充内容').value = '保留草稿';
    const dialog = f.get('忆幕'); dialog.emit('click', { target: f.get('手动补充内容') }); assert.equal(dialog.open, true);
    dialog.emit('keydown', { key: 'Escape' }); assert.equal(dialog.open, false); assert.equal(f.document.activeElement, trigger);
    f.view.open(); assert.equal(f.get('手动补充内容').value, '保留草稿'); dialog.emit('click'); assert.equal(dialog.open, false);
});

test('loading and unavailable states hide body cards but retain a usable refresh action', t => {
    const f = fixture({ snapshot: null, document: null, loading: true }); t.after(() => f.view.destroy());
    assert.equal(f.get('忆幕').querySelector('.ym-content').hidden, true);
    assert.equal(f.get('刷新记忆').disabled, true);
    f.render({ loading: false, error: '忆幕服务尚未安装。' });
    assert.equal(f.get('刷新记忆').disabled, false); assert.equal(f.get('刷新记忆').closest('[hidden]'), null);
});

test('the recent request view uses saved entry snapshots, only labels a request context, and marks token estimates', t => {
    const f = fixture({ lastUsed: { entries: [entry({ text: '请求当时的版本' })], tokens: 134 }, document: { enabled: true, settings: {}, entries: [entry({ text: '后来编辑的版本' })] } }); t.after(() => f.view.destroy());
    const used = f.get('忆幕').querySelector('.ym-last-used');
    assert.equal(used.open, false); assert.match(used.textContent, /请求当时的版本/); assert.doesNotMatch(used.textContent, /后来编辑的版本/);
    assert.match(used.textContent, /不代表模型已接收/); assert.match(used.textContent, /134 token（估算）/);
});

test('the recent request view reports verified raw replacement and conservative budget without altering its snapshot', t => {
    const lastUsed = { entries: [entry({ text: '请求核对时的记忆' })], tokens: 134, removedFloors: [1, 2, 3], recentFloors: [10, 11, 12, 13, 14],
        requestTokens: 1234, responseTokens: 2000, contextTokens: 8192 };
    const before = structuredClone(lastUsed), f = fixture({ lastUsed }); t.after(() => f.view.destroy());
    const used = f.get('忆幕').querySelector('.ym-last-used');
    assert.match(used.textContent, /本次请求替换 3 层旧原文，保留近期 5 层；聊天文件未改动/);
    assert.match(used.textContent, /请求保守估算 1234 \+ 回复预留 2000 \/ 上下文 8192 token/);
    assert.match(used.textContent, /不代表模型已接收/);
    f.render({ document: { enabled: true, settings: {}, entries: [entry({ text: '后续人工修改' })] } });
    assert.match(used.textContent, /请求核对时的记忆/); assert.doesNotMatch(used.textContent, /后续人工修改/);
    assert.deepEqual(lastUsed, before); assert.equal(f.calls.length, 0);
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
    entry.click(); shortcut.click(); assert.equal(opens, 2); assert.equal(closes, 1);
    firstDispose(); assert.equal(entry.isConnected, true, 'old owner cannot delete replacement entries');
    dispose(); assert.equal(entry.isConnected, false); assert.equal(shortcut.isConnected, false); assert.equal(qianmu.isConnected, true); assert.equal(send.isConnected, true);
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

test('standalone manifest and styles stay within Yimu and include narrow-screen and reduced-motion handling', async () => {
    const root = new URL('../yimu/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const css = await readFile(new URL('style.css', root), 'utf8');
    assert.equal(manifest.generate_interceptor, 'yimuGenerationInterceptor');
    assert.equal(manifest.js.split('?')[0], 'index.mjs'); assert.equal(manifest.version, pkg.version);
    assert.match(css, /max-width: 420px/); assert.match(css, /100dvh/); assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(css, /(?:^|\n)(?:body|html|#chat|#send_form)\s*[{,]/);
    assert.match(css, /url\('\.\/logo\.svg'\)/);
});
