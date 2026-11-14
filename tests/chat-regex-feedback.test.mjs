// C-16 s1：快切操作可视化——busy / reloading / 拾取与落定提示 / 落点呼吸 CSS
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const { createChatRegex, readRegexSources } = await import('../features/chat/qianmu-chat-regex.js');

function fakeST({ global = [], preset = [], writePreset = true, save = true } = {}) {
  const log = { saves: 0, presetWrites: [], reloads: 0 };
  let presetList = structuredClone(preset);
  const manager = { apiId: 'openai', getSelectedPresetName: () => '预设A',
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? presetList : null) };
  if (writePreset) manager.writePresetExtensionField = async ({ path, value }) => { log.presetWrites.push({ path, value }); presetList = value; };
  const ctx = { extensionSettings: { regex: structuredClone(global) }, getPresetManager: () => manager,
    getCurrentChatId: () => 'chat-1', reloadCurrentChat: async () => { log.reloads += 1; } };
  if (save) ctx.saveSettingsDebounced = () => { log.saves += 1; };
  return { ctx, log, preset: () => presetList };
}
const manualTimers = () => {
  const queue = new Map(); let next = 1;
  return { set(fn, ms) { const id = next++; queue.set(id, { fn, ms }); return id; }, clear(id) { queue.delete(id); },
    get size() { return queue.size; }, get last() { return [...queue.values()].at(-1); },
    flush() { const all = [...queue.values()]; queue.clear(); all.forEach(t => t.fn()); } };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
function fakeDom() {
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', type: '', placeholder: '', scrollTop: 0,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      style: { setProperty() {}, removeProperty() {} },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { this.listeners[type] = fn; },
      closest() { return null; }, getBoundingClientRect() { return { height: 400 }; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const host = make('div');
  host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }), defaultView: {} };
  return host;
}
const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };

test('structural operations fill busy with keys, clear on finally, and expose them in state', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  assert.deepEqual(ctrl.state().busy, []);
  const p = ctrl.actions.removeMany({ items: [{ source: 'global', id: 'g1', name: 'A' }] });
  assert.deepEqual(ctrl.state().busy, ['global:g1'], 'writing=true 时 busy 填入');
  await p;
  assert.deepEqual(ctrl.state().busy, [], 'finally 清空');
  assert.equal(ctrl.state().writing, false);
});

test('reloading flag is set before reloadCurrentChat and cleared after, exposed in state', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const timers = manualTimers();
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers });
  await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  assert.equal(ctrl.state().reloading, false, '防抖未触发');
  assert.equal(timers.size, 1);
  let snap = null;
  const old = st.ctx.reloadCurrentChat;
  st.ctx.reloadCurrentChat = async () => { snap = ctrl.state().reloading; await old(); };
  timers.flush(); await settle();
  assert.equal(snap, true, 'reloadCurrentChat 调用中 reloading=true');
  assert.equal(ctrl.state().reloading, false, '完成后 false');
});

test('pickMove entering a pick notifies "请选择移动位置" (info)', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, notify: (m, t) => notes.push([m, t]) });
  ctrl.actions.pickMove({ source: 'global', items: [{ source: 'global', id: 'g1', name: 'A' }] });
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], '请选择移动位置');
  assert.equal(notes[0][1], 'info');
});

test('dropMove on success notifies "N 项已移至指定位置" (success)', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }, { id: 'g2', scriptName: 'B' }] });
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, t) => notes.push([m, t]) });
  ctrl.actions.pickMove({ source: 'global', items: [{ source: 'global', id: 'g2', name: 'B' }] });
  await ctrl.actions.dropMove({ source: 'global', before: { id: 'g1', name: 'A' } });
  const success = notes.filter(n => n[1] === 'success');
  assert.equal(success.length, 1);
  assert.match(success[0][0], /1 项已移至指定位置/);
});

test('CSS contains busy row, locked card, status indicator, breathing animation and reduced-motion override', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('.qm-regex-row.is-busy'), 'busy 行样式');
  assert.ok(css.includes('.qm-regex-busy-mark'), 'spinner 图标');
  assert.ok(css.includes('.qm-regex-card.is-locked .qm-regex-list'), '锁定卡列表');
  assert.ok(css.includes('.qm-regex-status'), '状态提示');
  assert.ok(css.includes('@keyframes qm-regex-drop-breathe'), '呼吸动画');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion');
  assert.ok(css.includes('animation: qm-regex-drop-breathe'), '落点线使用动画');
});

test('view renders busy rows with spinner and is-busy class, buttons disabled', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }, { id: 'g2', scriptName: 'B', disabled: false }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: ctrl.actions });
  view.render({ ...ctrl.state(), busy: ['global:g1'] });
  const rows = walkAll(host).filter(n => n.classList?.contains('qm-regex-row'));
  const busyRow = rows.find(r => r.dataset?.id === 'g1');
  assert.ok(busyRow.classList.contains('is-busy'), 'is-busy class');
  assert.equal(busyRow.attrs['aria-busy'], 'true');
  const spinner = walkAll(busyRow).find(n => n.classList?.contains('fa-spinner'));
  assert.ok(spinner, 'spinner icon');
  const toggleBtn = walkAll(busyRow).find(n => n.classList?.contains('qm-regex-switch'));
  assert.equal(toggleBtn.disabled, true, 'toggle disabled');
  view.dispose();
});

test('view renders writing=true with locked card and reloading=true with status indicator', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const host = fakeDom();
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx });
  const view = mountChatRegexView({ root: host, actions: ctrl.actions });
  view.render({ ...ctrl.state(), writing: true });
  const card = walkAll(host).find(n => n.classList?.contains('qm-regex-card') && n.dataset?.key !== 'recycle');
  assert.ok(card?.classList.contains('is-locked'), 'writing 时卡片 is-locked');
  assert.equal(card?.attrs['aria-busy'], 'true');
  view.render({ ...ctrl.state(), reloading: true });
  const status = walkAll(host).find(n => n.classList?.contains('qm-regex-status'));
  assert.ok(status, 'reloading 时状态指示器');
  assert.ok(walkAll(status).some(n => n.textContent?.includes('刷新聊天中')));
  view.dispose();
});
