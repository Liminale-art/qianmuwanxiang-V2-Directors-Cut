// C-16 s1/s2：快切操作可视化——busy / reloading / 拾取与落定提示 / 落点呼吸 CSS；轻量重绘与回退
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const { createChatRegex, readRegexSources, rerenderRenderedMessages, REGEX_RELOAD_DELAY, REGEX_STRUCTURAL_DELAY } = await import('../features/chat/qianmu-chat-regex.js');

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

test('CSS contains busy row, locked card, status indicator; drop line is static (C-17 s3 removed breathing)', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('.qm-regex-row.is-busy'), 'busy 行样式');
  assert.ok(css.includes('.qm-regex-busy-mark'), 'spinner 图标');
  assert.ok(css.includes('.qm-regex-card.is-locked .qm-regex-list'), '锁定卡列表');
  assert.ok(css.includes('.qm-regex-status'), '状态提示');
  assert.ok(!css.includes('qm-regex-drop-breathe'), 'C-17 s3：去掉呼吸动画');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion');
  assert.match(css, /.qm-regex-drop:hover::before, #story-director-floor-nav .qm-regex-drop:focus-visible::before { opacity: 1; height: 3px; box-shadow:/, '选中插入位置时加粗 + 发光');
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
  const card = walkAll(host).find(n => n.classList?.contains('qm-regex-card') && !n.classList?.contains('qm-regex-card-tools') && n.dataset?.key !== 'recycle');
  assert.ok(card?.classList.contains('is-locked'), 'writing 时卡片 is-locked');
  assert.equal(card?.attrs['aria-busy'], 'true');
  view.render({ ...ctrl.state(), reloading: true });
  const status = walkAll(host).find(n => n.classList?.contains('qm-regex-status'));
  assert.ok(status, 'reloading 时状态指示器');
  assert.ok(walkAll(status).some(n => n.textContent?.includes('刷新聊天中')));
  view.dispose();
});

// ---- C-16 s2：轻量重绘 ----
const fakeChatDoc = ids => ({ querySelectorAll: sel => (sel === '#chat .mes[mesid]' ? ids.map(id => ({ getAttribute: k => (k === 'mesid' ? String(id) : null) })) : []) });

test('rerenderRenderedMessages: updateMessageBlock + MESSAGE_UPDATED per rendered floor, skips unknown ids', async () => {
  const calls = [], emitted = [];
  const ctx = { chat: [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }], updateMessageBlock: (id, m) => calls.push([id, m.mes]),
    eventSource: { emit: async (t, id) => { emitted.push([t, id]); } }, eventTypes: { MESSAGE_UPDATED: 'message_updated' } };
  const n = await rerenderRenderedMessages(ctx, { root: fakeChatDoc([2, 0, 7, 'x']) });
  assert.equal(n, 2);
  assert.deepEqual(calls, [[2, 'c'], [0, 'a']]);
  assert.deepEqual(emitted, [['message_updated', 2], ['message_updated', 0]]);
});

test('rerenderRenderedMessages returns -1 when capability is missing', async () => {
  assert.equal(await rerenderRenderedMessages(null), -1);
  assert.equal(await rerenderRenderedMessages({ chat: [] }, { root: fakeChatDoc([0]) }), -1);
  assert.equal(await rerenderRenderedMessages({ chat: [{}], updateMessageBlock() {} }, { root: {} }), -1);
  const noEmit = await rerenderRenderedMessages({ chat: [{}], updateMessageBlock() {} }, { root: fakeChatDoc([0]) });
  assert.equal(noEmit, 1, '没有 eventSource 仍可重绘');
});

test('flushReload prefers the light path and skips reloadCurrentChat when ST exposes updateMessageBlock', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const updated = [];
  st.ctx.chat = [{ mes: 'x' }, { mes: 'y' }];
  st.ctx.updateMessageBlock = id => updated.push(id);
  const saved = globalThis.document; globalThis.document = fakeChatDoc([0, 1]);
  try {
    const timers = manualTimers();
    const ctrl = createChatRegex({ getContext: () => st.ctx, timers });
    await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
    timers.flush(); await settle(); await settle();
    assert.deepEqual(updated, [0, 1]);
    assert.equal(st.log.reloads, 0, '不走整聊重载');
    assert.equal(ctrl.state().reloading, false);
  } finally { globalThis.document = saved; }
});

test('flushReload falls back to reloadCurrentChat when the light path is unavailable or throws', async () => {
  const saved = globalThis.document;
  try {
    const a = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
    globalThis.document = fakeChatDoc([0]);
    const t1 = manualTimers(); const c1 = createChatRegex({ getContext: () => a.ctx, timers: t1 });
    await c1.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
    t1.flush(); await settle(); await settle();
    assert.equal(a.log.reloads, 1, '无 updateMessageBlock → 整聊重载');

    const b = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
    b.ctx.chat = [{ mes: 'x' }]; b.ctx.updateMessageBlock = () => { throw new Error('boom'); };
    const t2 = manualTimers(); const c2 = createChatRegex({ getContext: () => b.ctx, timers: t2 });
    await c2.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
    t2.flush(); await settle(); await settle();
    assert.equal(b.log.reloads, 1, '轻量路径抛错 → 整聊重载');
  } finally { globalThis.document = saved; }
});

test('structural writes schedule a short reload while toggles keep the 700ms debounce; canReload=false still defers', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }, { id: 'g2', scriptName: 'B', disabled: false }] });
  const timers = manualTimers();
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers });
  await ctrl.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  assert.equal(timers.last.ms, REGEX_RELOAD_DELAY);
  await ctrl.actions.removeMany({ items: [{ source: 'global', id: 'g2', name: 'B' }] });
  assert.equal(timers.last.ms, REGEX_STRUCTURAL_DELAY);
  assert.ok(REGEX_STRUCTURAL_DELAY < REGEX_RELOAD_DELAY);

  const st2 = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }] });
  const t2 = manualTimers();
  const c2 = createChatRegex({ getContext: () => st2.ctx, timers: t2, canReload: () => false });
  await c2.actions.toggle({ source: 'global', id: 'g1', name: 'A', enabled: false });
  t2.flush(); await settle();
  assert.equal(st2.log.reloads, 0);
  assert.equal(t2.size, 1, '顺延一个定时器');
});

// ---- C-16 s3：预设 ↔ 全局跨源移动 ----
test('dropMove across sources inserts into the target (keeping id) before the anchor, then removes from the source', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }, { id: 'g2', scriptName: 'B', disabled: true }],
    preset: [{ id: 'p1', scriptName: 'P1' }, { id: 'p2', scriptName: 'P2' }] });
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, k) => notes.push([m, k]) });
  ctrl.actions.pickMove({ source: 'global', items: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }] });
  assert.equal(ctrl.state().picking.length, 2);
  const out = await ctrl.actions.dropMove({ source: 'preset', before: { id: 'p2', name: 'P2' } });
  assert.equal(out, 2);
  assert.deepEqual(st.preset().map(s => s.id), ['p1', 'g1', 'g2', 'p2'], '目标源在锚点前插入，id 不变');
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), [], '源头删除');
  assert.equal(ctrl.state().picking.length, 0);
  assert.equal(ctrl.state().recycle.count, 0, '跨源移动不进回收站');
  assert.ok(notes.some(([m, k]) => /2 项已移至预设/.test(m) && k === 'success'));
  // 反向：预设 → 全局末尾
  ctrl.actions.pickMove({ source: 'preset', items: [{ id: 'g2', name: 'B' }] });
  assert.equal(await ctrl.actions.dropMove({ source: 'global', before: null }), 1);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g2']);
  assert.deepEqual(st.preset().map(s => s.id), ['p1', 'g1', 'p2']);
});

test('cross-source move migrates binding override and default keys from src:id to dst:id', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A', disabled: false }], preset: [{ id: 'p1', scriptName: 'P1' }] });
  let binding = { enabled: true, overrides: { 'global:g1': { enabled: false }, 'preset:p1': { enabled: true } } };
  let defaults = { 'global:g1': { enabled: true } };
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(),
    readBinding: () => binding, writeBinding: v => { binding = v; }, readDefaults: () => defaults, writeDefaults: v => { defaults = v; } });
  ctrl.actions.pickMove({ source: 'global', items: [{ id: 'g1', name: 'A' }] });
  await ctrl.actions.dropMove({ source: 'preset', before: null });
  assert.deepEqual(binding.overrides, { 'preset:p1': { enabled: true }, 'preset:g1': { enabled: false } });
  assert.deepEqual(defaults, { 'preset:g1': { enabled: true } });
});

test('cross-source move never loses entries: when the source delete fails the copy stays in the target', async () => {
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }], preset: [{ id: 'p1', scriptName: 'P1' }] });
  let writes = 0;
  const manager = st.ctx.getPresetManager();
  const realWrite = manager.writePresetExtensionField;
  manager.writePresetExtensionField = async args => { writes += 1; if (writes === 2) throw new Error('disk full'); return realWrite(args); };
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers(), notify: (m, k) => notes.push([m, k]) });
  // 预设 → 全局：第一步写全局成功，第二步写预设（删除）失败
  ctrl.actions.pickMove({ source: 'preset', items: [{ id: 'p1', name: 'P1' }] });
  st.ctx.saveSettingsDebounced = () => { writes += 1; };
  assert.equal(await ctrl.actions.dropMove({ source: 'global', before: null }), null);
  assert.deepEqual(st.ctx.extensionSettings.regex.map(s => s.id), ['g1', 'p1'], '目标已有副本');
  assert.deepEqual(st.preset().map(s => s.id), ['p1'], '源头仍在，未丢失');
  assert.ok(notes.some(([, k]) => k === 'warning'));
  assert.equal(ctrl.state().writing, false);
});

test('view shows drop targets on both writable cards while picking; foreign card targets are marked is-across', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }], preset: [{ id: 'p1', scriptName: 'P1' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const calls = [];
  const stub = { ...ctrl.actions, dropMove: (...args) => { calls.push(args); return null; } };
  const host = fakeDom();
  const view = mountChatRegexView({ root: host, actions: stub });
  view.render(Object.freeze({ ...ctrl.state(), managing: true, picking: [{ source: 'global', id: 'g1', name: 'A' }] }));
  const all = walkAll(host);
  const presetDrops = all.filter(n => n.dataset?.key?.startsWith?.('drop:preset:'));
  const globalDrops = all.filter(n => n.dataset?.key?.startsWith?.('drop:global:'));
  assert.ok(globalDrops.length >= 1 && presetDrops.length >= 2, '两张卡都有落点');
  assert.ok(presetDrops.every(n => n.classList.contains('is-across')), '异源落点标 is-across');
  assert.ok(globalDrops.every(n => !n.classList.contains('is-across')));
  const target = presetDrops.find(n => n.dataset.key === 'drop:preset:p1');
  assert.match(target.attrs['aria-label'], /移入预设/);
  target.listeners.click(); await settle();
  assert.deepEqual(calls.at(-1), [{ source: 'preset', before: { id: 'p1', name: 'P1' } }]);
  // 空列表的异源卡也给一个末尾落点
  const empty = fakeST({ global: [{ id: 'g1', scriptName: 'A' }], preset: [] });
  const c2 = createChatRegex({ getContext: () => empty.ctx, timers: manualTimers() });
  const h2 = fakeDom(); mountChatRegexView({ root: h2, actions: c2.actions }).render(Object.freeze({ ...c2.state(), managing: true, picking: [{ source: 'global', id: 'g1', name: 'A' }] }));
  assert.ok(walkAll(h2).some(n => n.dataset?.key === 'drop:preset:end'));
});

// ---- C-16 s5：快切行/工具栏布局（反馈项 3/4/5） ----
test('item3: non-managing group header is clickable on the blank area, not only the arrow', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const st = fakeST({ global: [{ id: 'g1', scriptName: '状态栏-隐藏' }, { id: 'g2', scriptName: '状态栏-美化' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const folds = [];
  const stub = { ...ctrl.actions, setFolded: (key, on) => folds.push([key, on]) };
  const host = fakeDom();
  const view = mountChatRegexView({ root: host, actions: stub });
  view.render(ctrl.state());
  const head = walkAll(host).find(n => n.classList?.contains('qm-regex-group'));
  assert.ok(head, '有分组头');
  assert.equal(typeof head.listeners.click, 'function', '组头整体可点');
  head.listeners.click({ target: head });
  assert.equal(folds.length, 1, '点空白区触发折叠');
  assert.match(folds[0][0], /^group:global:/);
  view.dispose();
});

test('item4: non-managing writable row keeps the toggle and adds a single-item menu with edit/copy/delete', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const opened = [], copied = [];
  const stub = { ...ctrl.actions, openEditor: a => opened.push(a), copyMany: a => { copied.push(a); return null; } };
  const host = fakeDom();
  const view = mountChatRegexView({ root: host, actions: stub });
  view.render(ctrl.state());
  const all = walkAll(host);
  assert.ok(all.some(n => n.classList?.contains('qm-regex-switch')), '拨杆仍在');
  const menu = all.find(n => n.dataset?.key === 'rowmenu:global:g1');
  assert.ok(menu, '有单条菜单按钮');
  const pop = all.find(n => n.classList?.contains('qm-regex-rowstrip'));
  assert.ok(pop, '有横向展开条（C-17 s3）');
  assert.ok(!pop.classList.contains('is-open'), '默认收起');
  menu.listeners.click();
  assert.ok(pop.classList.contains('is-open'), '点击展开');
  const edit = walkAll(pop).find(n => n.dataset?.key === 'rowedit:global:g1');
  const copy = walkAll(pop).find(n => n.dataset?.key === 'rowcopy:global:g1');
  const del = walkAll(pop).find(n => n.dataset?.key === 'rowdel:global:g1');
  assert.ok(edit && copy && del, '编辑/复制/删除俱全');
  edit.listeners.click(); await settle();
  assert.deepEqual(opened.at(-1), { source: 'global', id: 'g1', name: 'A' });
  copy.listeners.click(); await settle();
  assert.deepEqual(copied.at(-1), { items: [{ source: 'global', id: 'g1', name: 'A' }] });
  view.dispose();
});

test('item5: recycle toggle shows even when empty; clicking 管理 while recycle open returns to the list', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const calls = [];
  const stub = { ...ctrl.actions, setRecycle: v => calls.push(['recycle', v]), setManaging: v => calls.push(['manage', v]) };
  const host = fakeDom();
  const view = mountChatRegexView({ root: host, actions: stub });
  // 空回收站也显示控件
  view.render(ctrl.state());
  assert.ok(walkAll(host).some(n => n.dataset?.key === 'recycle'), '空回收站也有入口');
  // 回收站打开时点「管理」先关回收站再进管理
  view.render(Object.freeze({ ...ctrl.state(), recycle: { open: true, count: 2, items: [] } }));
  const manage = walkAll(host).find(n => n.dataset?.key === 'manage');
  manage.listeners.click();
  assert.ok(calls.some(c => c[0] === 'recycle' && c[1] === false), '先关回收站');
  assert.ok(calls.some(c => c[0] === 'manage'), '再切管理');
  view.dispose();
});

test('item5: deleted preset attribution renders as gray small-text group name, not parentheses', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const st = fakeST({ global: [{ id: 'g1', scriptName: 'A' }] });
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: manualTimers() });
  const host = fakeDom();
  const view = mountChatRegexView({ root: host, actions: ctrl.actions });
  view.render(Object.freeze({ ...ctrl.state(), recycle: { open: true, count: 1,
    items: [{ key: 'trash-1', source: 'preset', preset: '预设甲', name: '被删正则' }] } }));
  const origin = walkAll(host).find(n => n.classList?.contains('qm-regex-trash-origin'));
  assert.ok(origin, '归属用独立 span');
  assert.equal(origin.textContent, '预设甲', '只显示组名，无括号');
  assert.ok(!walkAll(host).some(n => typeof n.text === 'string' && n.text.includes('（预设「')), '不再是括号形式');
  view.dispose();
});

test('item5: tools row spreads across the full width (space-between), recycle animation respects reduced-motion', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  const tools = css.match(/\.qm-regex-tools\s*\{[^}]*\}/)?.[0] || '';
  assert.match(tools, /justify-content:\s*space-between/, '工具行整行铺开');
  assert.ok(css.includes('.qm-regex-trash-origin'), '归属小字样式');
  assert.ok(css.includes('.qm-regex-rowstrip.is-open'), '单条横向展开条样式');
});
