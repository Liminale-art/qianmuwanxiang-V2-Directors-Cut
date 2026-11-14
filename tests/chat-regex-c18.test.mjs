// C-18：1.59.505 反馈——移入分组/编辑页分组要真正入组、条目可落到组内末尾、双击改名、
// 预设目录行 = 预设名 + 版本号、管理栏纯图标。
import test from 'node:test';
import assert from 'node:assert/strict';

const { groupAdjacentRegex, fitRegexGroupName, joinRegexGroup, createChatRegex } = await import('../features/chat/qianmu-chat-regex.js');
const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');

const scripts = (...names) => names.map((scriptName, i) => ({ id: `s${i}`, scriptName }));
const rows = list => list.map(s => ({ id: s.id, name: s.scriptName }));
const shape = list => groupAdjacentRegex(rows(list)).map(r => [r.label, r.items.map(i => i.name)]);

test('a 【tag】 row joins the auto group of the same name instead of standing apart', () => {
  assert.deepEqual(shape(scripts('群聊-外框', '群聊-正文', '【群聊】不发送')), [['群聊', ['群聊-外框', '群聊-正文', '【群聊】不发送']]]);
  assert.deepEqual(shape(scripts('【群聊】不发送', '群聊-外框', '群聊-正文')), [['群聊', ['【群聊】不发送', '群聊-外框', '群聊-正文']]]);
  assert.deepEqual(shape(scripts('【排版】甲', '【排版】乙', '排版-丙')).map(r => r[1].length), [3], '手动标签组也收同名自动成员');
  assert.deepEqual(shape(scripts('群聊-外框', '群聊-正文', '【其他】丙')).map(r => r[0]), ['群聊', ''], '别的标签仍不混入');
});

test('fitRegexGroupName tags only when the name does not already belong to the group', () => {
  assert.equal(fitRegexGroupName('不发送', '群聊'), '【群聊】不发送');
  assert.equal(fitRegexGroupName('群聊-外框', '群聊'), '群聊-外框', '本来就属于该组：不加标签');
  assert.equal(fitRegexGroupName('【旧】群聊-外框', '群聊'), '群聊-外框', '并去掉旧标签');
  assert.equal(fitRegexGroupName('【旧】甲', ''), '甲');
});

test('joinRegexGroup really puts the rows into the group: renamed and moved to the end of its members', () => {
  const list = scripts('独立', '群聊-外框', '群聊-正文', '状态栏-a', '状态栏-b', '不发送');
  const next = joinRegexGroup(list, [5, 0], '群聊');
  assert.deepEqual(next.map(s => s.scriptName), ['群聊-外框', '群聊-正文', '【群聊】独立', '【群聊】不发送', '状态栏-a', '状态栏-b']);
  assert.deepEqual(shape(next).map(r => [r[0], r[1].length]), [['群聊', 4], ['状态栏', 2]], '不再只是多了个前缀');
  assert.deepEqual(next.map(s => s.id).sort(), list.map(s => s.id).sort(), '不丢不重');
  // 组还不存在：把这批收拢到第一条的位置，成为新组
  const fresh = joinRegexGroup(scripts('甲', '隔', '乙'), [0, 2], '新组');
  assert.deepEqual(fresh.map(s => s.scriptName), ['【新组】甲', '【新组】乙', '隔']);
  assert.deepEqual(shape(fresh)[0], ['新组', ['【新组】甲', '【新组】乙']]);
  // 留空 = 去掉标签、不挪位置；已在组内 = 无变化
  assert.deepEqual(joinRegexGroup(scripts('【组】甲', '乙'), [0], '').map(s => s.scriptName), ['甲', '乙']);
  assert.equal(joinRegexGroup(scripts('群聊-外框', '群聊-正文'), [1], '群聊'), null);
});

function fakeST(global) {
  const log = { saves: 0 };
  const ctx = { extensionSettings: { regex: structuredClone(global) }, getCurrentChatId: () => 'c', reloadCurrentChat: async () => {}, saveSettingsDebounced: () => { log.saves += 1; } };
  return { ctx, log, names: () => ctx.extensionSettings.regex.map(s => s.scriptName) };
}
const timers = () => ({ set: () => 1, clear() {} });

test('controller: retag joins the group, dropMove with a group lands at the group end, rename only changes the name', async () => {
  const st = fakeST(scripts('独立', '群聊-外框', '群聊-正文', '尾巴'));
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: timers() });
  assert.equal(await ctrl.actions.retag({ items: [{ source: 'global', id: 's0', name: '独立' }], tag: '群聊' }), 1);
  assert.deepEqual(st.names(), ['群聊-外框', '群聊-正文', '【群聊】独立', '尾巴']);
  // 把「尾巴」拖到组内末尾：位置在组最后一条之后，并归入该组
  ctrl.actions.pickMove({ source: 'global', items: [{ id: 's3', name: '尾巴' }] });
  await ctrl.actions.dropMove({ source: 'global', before: null, group: '群聊' });
  assert.deepEqual(st.names(), ['群聊-外框', '群聊-正文', '【群聊】独立', '【群聊】尾巴']);
  assert.deepEqual(groupAdjacentRegex(rows(st.ctx.extensionSettings.regex)).map(r => r.items.length), [4]);
  // 不带 group 的落点 = 只移动，不改名
  ctrl.actions.pickMove({ source: 'global', items: [{ id: 's1', name: '群聊-外框' }] });
  await ctrl.actions.dropMove({ source: 'global', before: null });
  assert.equal(st.names().at(-1), '群聊-外框');
  const before = structuredClone(st.ctx.extensionSettings.regex.find(s => s.id === 's2'));
  await ctrl.actions.rename({ source: 'global', id: 's2', name: '群聊-正文', to: '群聊-主体' });
  assert.deepEqual(st.ctx.extensionSettings.regex.find(s => s.id === 's2'), { ...before, scriptName: '群聊-主体' });
  const saves = st.log.saves;
  assert.equal(await ctrl.actions.rename({ source: 'global', id: 's2', name: '群聊-主体', to: ' 群聊-主体 ' }), false);
  assert.equal(st.log.saves, saves, '名字没变不写盘');
});

// —— 视图 ——
const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };
function fakeDom() {
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', type: '', placeholder: '', scrollTop: 0,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(...cs) { cs.forEach(c => this.set.delete(c)); }, contains(c) { return this.set.has(c); },
        toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); return this.set.has(c); } },
      style: { setProperty() {}, removeProperty() {} },
      append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {},
      contains(other) { return walkAll(this).includes(other); }, focus() {}, select() {},
      querySelectorAll(sel) { const cls = String(sel).replace(/^\./, ''); return sel === '[data-key]' ? walkAll(this).filter(n => n.dataset?.key) : walkAll(this).filter(n => n !== this && n.classList?.contains(cls)); },
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
function mount(global, state = {}, extra = {}) {
  const host = fakeDom(), st = fakeST(global), calls = [];
  const ctrl = createChatRegex({ getContext: () => st.ctx, timers: timers() });
  // 真控制器的 setFolded 会触发重绘；桩里照做。
  const full = Object.freeze({ ...ctrl.state(), ...state });
  let view = null;
  const stub = { ...ctrl.actions, rename: a => { calls.push(['rename', a]); return true; }, retag: a => { calls.push(['retag', a]); return 1; },
    setFolded: (...a) => { calls.push(['fold', a]); view.render(full); }, ...extra };
  view = mountChatRegexView({ root: host, actions: stub });
  view.render(full);
  return { host, view, calls };
}
const nameOf = (host, id) => walkAll(host).find(n => n.classList?.contains('qm-regex-row') && n.dataset.id === id).children.find(n => n.classList?.contains('qm-regex-name'));

test('double-clicking a row name renames it in place (Enter commits, Esc cancels, single click does nothing)', async () => {
  const { host, view, calls } = mount(scripts('甲', '乙'));
  nameOf(host, 's0').listeners.click({ timeStamp: 1000 });
  assert.equal(byKey(host, 'rename:global:s0'), undefined, '单击不进入改名');
  nameOf(host, 's0').listeners.click({ timeStamp: 1200 });
  const field = byKey(host, 'rename:global:s0');
  assert.equal(field.value, '甲', '触屏双点进入改名');
  field.value = '新名'; field.listeners.keydown({ key: 'Enter', preventDefault() {} }); await settle();
  assert.deepEqual(calls.at(-1), ['rename', { source: 'global', id: 's0', name: '甲', to: '新名' }]);
  field.listeners.blur(); await settle();
  assert.equal(calls.filter(c => c[0] === 'rename').length, 1, 'Enter 后失焦不重复提交');
  nameOf(host, 's1').listeners.dblclick();
  const f2 = byKey(host, 'rename:global:s1'); f2.value = '别的'; f2.listeners.keydown({ key: 'Escape', preventDefault() {} }); await settle();
  assert.equal(calls.filter(c => c[0] === 'rename').length, 1, 'Esc 不提交');
  assert.equal(byKey(host, 'rename:global:s1'), undefined);
  view.dispose();
});

test('inside its group a row hides the redundant 【tag】 and keeps it when renamed; group names rename by double-click too', async () => {
  const { host, view, calls } = mount(scripts('群聊-外框', '群聊-正文', '【群聊】不发送'));
  assert.equal(nameOf(host, 's2').textContent, '不发送', '组内不重复显示【群聊】');
  nameOf(host, 's2').listeners.dblclick();
  const field = byKey(host, 'rename:global:s2');
  field.value = '不发送群聊'; field.listeners.keydown({ key: 'Enter', preventDefault() {} }); await settle();
  assert.equal(calls.at(-1)[1].to, '【群聊】不发送群聊', '改名后仍在本组');
  const head = walkAll(host).find(n => n.classList?.contains('qm-regex-group'));
  head.listeners.click({ timeStamp: 5000, target: null });
  head.listeners.click({ timeStamp: 5200, target: null });
  const gf = byKey(host, 'rename:group:global:群聊');
  assert.ok(gf, '非管理态组名双击进入改名');
  gf.value = '群组'; gf.listeners.keydown({ key: 'Enter', preventDefault() {} }); await settle();
  assert.equal(calls.at(-1)[0], 'retag');
  assert.equal(calls.at(-1)[1].tag, '群组');
  assert.deepEqual(calls.at(-1)[1].items.map(i => i.id), ['s0', 's1', 's2']);
  view.dispose();
});

test('preset rows show name + version tag; manage bar actions are icon-only with accessible names', () => {
  const presets = { available: true, names: ['写作 v1', '写作 v2', '独立'], current: '写作 v1' };
  const { host, view } = mount(scripts('甲'), { presets, managing: true, selected: ['global:s0'] }, { selectPreset: () => {} });
  const trigger = byKey(host, 'preset');
  assert.deepEqual(trigger.children.map(n => n.tagName), ['span', 'span'], '「预设目录」前没有箭头');
  const option = walkAll(host).find(n => n.dataset?.value === '写作 v2');
  assert.deepEqual(option.children.filter(n => /name|ver/.test(n.className)).map(n => n.textContent), ['写作', 'v2'], '预设名 + 版本号');
  for (const key of ['export', 'del', 'copy', 'group', 'cancel']) {
    const b = byKey(host, `sel-act:${key}`);
    assert.ok(b.classList.contains('is-icon') && b.attrs['aria-label'], key);
    assert.deepEqual(b.children.map(n => n.tagName), ['i'], `${key} 只有图标`);
  }
  view.dispose();
});
