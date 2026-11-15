// C-20：1.59.507 反馈——移动失效、页面位置记忆、编辑页保存闪动/等待态、固定分组聚拢标记。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createChatRegex } = await import('../features/chat/qianmu-chat-regex.js');
const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');

const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };
function fakeDom() {
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', type: '', placeholder: '', scrollTop: 0, hidden: false, isConnected: true,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(...cs) { cs.forEach(c => this.set.delete(c)); }, contains(c) { return this.set.has(c); },
        toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); return this.set.has(c); } },
      style: { setProperty() {}, removeProperty() {} },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {},
      contains(other) { return walkAll(this).includes(other); }, focus() {}, select() {},
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        if (sel === '[data-key]') return walkAll(this).filter(n => n.dataset?.key);
        const cls = String(sel).replace(/^\./, '');
        return walkAll(this).filter(n => n !== this && n.classList?.contains(cls));
      },
      closest() { return null; }, getBoundingClientRect() { return { height: 400 }; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const host = make('div');
  host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }), defaultView: {}, addEventListener() {}, removeEventListener() {} };
  return host;
}
const byKey = (host, key) => walkAll(host).find(n => n.dataset?.key === key);
const settle = () => new Promise(resolve => setImmediate(resolve));
const timers = () => ({ set: () => 1, clear() {} });

async function setup(global, options = {}) {
  const host = fakeDom();
  const notes = [];
  const groups = { order: [], members: {} };
  const ctx = { extensionSettings: { regex: structuredClone(global) }, getCurrentChatId: () => 'c', reloadCurrentChat: async () => {}, saveSettingsDebounced() {} };
  const ctrl = createChatRegex({ getContext: () => ctx, timers: timers(), notify: (m, t) => notes.push([t, m]),
    readGroups: options.readGroups || (() => groups),
    writeGroups: options.writeGroups || (value => { groups.order = [...value.order]; groups.members = { ...value.members }; }) });
  // 用控制器自己的 mount，让 refresh() 真的驱动视图（否则拾取后的重绘不会发生）。
  await ctrl.mount(host);
  return { host, ctrl, ctx, notes, groups, names: () => ctx.extensionSettings.regex.map(s => s.scriptName) };
}
const rowOrder = host => walkAll(host).filter(n => n.classList?.contains('qm-regex-row')).map(n => n.dataset.id);

test('C-20: picking a row and clicking a drop line really reorders ST (and the list on screen)', async () => {
  const f = await setup([{ id: 'a', scriptName: '甲' }, { id: 'b', scriptName: '乙' }, { id: 'c', scriptName: '丙' }]);
  assert.deepEqual(f.names(), ['甲', '乙', '丙']);
  byKey(f.host, 'pick:global:c').listeners.click(); await settle();
  assert.deepEqual(f.ctrl.state().picking.map(p => p.id), ['c'], '拾起成功');
  const drop = byKey(f.host, 'drop:global:a');
  assert.ok(drop, '拾取后出现落点');
  drop.listeners.click(); await settle(); await settle();
  assert.deepEqual(f.names(), ['丙', '甲', '乙'], 'ST 里的顺序真的变了');
  assert.deepEqual(rowOrder(f.host).slice(0, 3), ['c', 'a', 'b'], '屏幕上的顺序也变了');
  assert.equal(f.notes.at(-1)[0], 'success', '提示成功');
  f.ctrl.dispose();
});

test('C-20: a rapid second tap on the same grip does not cancel the pick (the old "cannot move" symptom)', async () => {
  const f = await setup([{ id: 'a', scriptName: '甲' }, { id: 'b', scriptName: '乙' }, { id: 'c', scriptName: '丙' }]);
  const grip = byKey(f.host, 'pick:global:c');
  grip.listeners.click(); grip.listeners.click(); await settle();
  assert.deepEqual(f.ctrl.state().picking.map(p => p.id), ['c'], '连点两次仍是拾起态，不会把落点收走');
  assert.ok(byKey(f.host, 'drop:global:a'), '落点还在，接着点即可落定');
  f.ctrl.dispose();
});

test('C-20: moving inside a group lands at that place and keeps the group intact', async () => {
  const f = await setup([
    { id: 'g1', scriptName: '群聊-外框' }, { id: 'g2', scriptName: '群聊-正文' },
    { id: 'x', scriptName: '独立' }, { id: 'g3', scriptName: '群聊-功能' },
  ]);
  byKey(f.host, 'pick:global:x').listeners.click(); await settle();
  const end = byKey(f.host, 'drop:global:groupend:群聊');
  assert.ok(end, '组内末尾落点存在');
  end.listeners.click(); await settle(); await settle();
  assert.deepEqual(f.names(), ['群聊-外框', '群聊-正文', '群聊-功能', '独立'], '挪到组末尾');
  assert.deepEqual([...f.groups.members['群聊']], ['g1', 'g2', 'x', 'g3'], '连同原组成员一起记进固定分组（C-21）');
  assert.equal(f.notes.at(-1)[0], 'success');
  f.ctrl.dispose();
});

test('C-20: the list remembers where the page was after leaving the editor and after re-renders', async () => {
  const f = await setup([{ id: 'a', scriptName: '甲' }, { id: 'b', scriptName: '乙' }]);
  f.host.scrollTop = 260;
  f.host.listeners.scroll?.({ target: f.host });
  // 进编辑页：先记下列表位置，再渲染成编辑页
  f.ctrl.actions.openEditor({ source: 'global', id: 'a', name: '甲' });
  f.ctrl.actions.closeEditor();
  assert.equal(f.host.scrollTop, 260, '返回列表回到上次停留的位置');
  // 切页签再回来（隐藏时 scrollTop 会变 0）也算
  f.host.scrollTop = 0;
  f.ctrl.actions.reload();
  assert.equal(f.host.scrollTop, 260, '重新渲染后仍回到上次位置');
  f.ctrl.dispose();
});
