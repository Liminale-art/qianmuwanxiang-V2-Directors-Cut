// C-26：快切收尾——预设正则分组随预设导出、出厂开关、一键允许、清空本聊天开关、搜索、重复正则。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createChatRegex, findDuplicateRegex, regexMatchesQuery, snapshotRegexDefaults, diffRegexDefaults, allowPresetRegex,
  PRESET_GROUPS_PATH, PRESET_DEFAULTS_PATH } = await import('../features/chat/qianmu-chat-regex.js');

// 一个按 ST 真实行为建模的预设：extensions 是一个对象，readPresetExtensionField/writePresetExtensionField 按点路径读写。
function world({ presetScripts, global = [], allowed = false } = {}) {
  const presets = {
    甲: { extensions: { regex_scripts: presetScripts || [{ id: 'p1', scriptName: '开场', findRegex: 'a' }, { id: 'p2', scriptName: '结尾', findRegex: 'b' }, { id: 'p3', scriptName: '杂项', findRegex: 'a' }] } },
    乙: { extensions: { regex_scripts: [{ id: 'q1', scriptName: '另一条', findRegex: 'z' }] } },
  };
  let current = '甲';
  const get = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  const set = (obj, path, value) => { const keys = path.split('.'); let o = obj; keys.slice(0, -1).forEach(k => { o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; o = o[k]; }); o[keys.at(-1)] = value; };
  const manager = { apiId: 'openai',
    getAllPresets: () => Object.keys(presets), getSelectedPresetName: () => current,
    findPreset: name => (presets[name] ? name : undefined), selectPreset: async name => { current = name; },
    readPresetExtensionField: ({ path }) => { const v = get(presets[current].extensions, path); return v === undefined ? null : v; },
    writePresetExtensionField: async ({ name, path, value }) => { set(presets[name || current].extensions, path, value); } };
  const ctx = { extensionSettings: { regex: structuredClone(global), preset_allowed_regex: allowed ? { openai: ['甲'] } : {} },
    getPresetManager: () => manager, getCurrentChatId: () => 'c', reloadCurrentChat: async () => {}, saveSettingsDebounced() {} };
  let local = {};
  let binding = { enabled: false, overrides: {} };
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => ctx, timers: { set: () => 1, clear() {} }, notify: (m, t) => notes.push([t, m]),
    readGroups: () => local, writeGroups: v => { local = JSON.parse(JSON.stringify(v)); },
    readBinding: () => binding, writeBinding: v => { binding = JSON.parse(JSON.stringify(v)); } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { ctrl, ctx, presets, notes, settle, get local() { return local; }, set local(v) { local = v; }, get binding() { return binding; }, set binding(v) { binding = v; }, use: name => { current = name; } };
}

test('preset-regex groups are written into the preset itself (ST native export carries them); global groups stay local', async () => {
  const w = world({ global: [{ id: 'g1', scriptName: '全局一' }, { id: 'g2', scriptName: '全局二' }] });
  await w.ctrl.actions.retag({ items: [{ source: 'preset', id: 'p1', name: '开场' }, { source: 'preset', id: 'p2', name: '结尾' }], tag: '收尾' });
  await w.ctrl.actions.retag({ items: [{ source: 'global', id: 'g1', name: '全局一' }], tag: '全局组' });
  await w.settle();
  assert.deepEqual(w.presets.甲.extensions.qianmu.regexGroups, { p1: '收尾', p2: '收尾' }, '写进预设 extensions（ST 原生导出整份预设 JSON）');
  assert.deepEqual(w.local, { g1: '全局组' }, '全局正则分组仍在千幕设置');
  assert.equal(w.ctrl.state().groups.p1, '收尾', '读取时合并');
  w.use('乙');
  assert.equal(w.ctrl.state().groups.p1, undefined, '切到别的预设就读别的预设的分组');
});

test('legacy preset groups kept in qianmu settings are moved into the preset on the first write', async () => {
  const w = world();
  w.local = { p1: '旧组', p2: '旧组', g9: '全局' };
  assert.equal(w.ctrl.state().groups.p1, '旧组', '预设里还没有字段时仍读得到旧分组');
  await w.ctrl.actions.retag({ items: [{ source: 'preset', id: 'p3', name: '杂项' }], tag: '旧组' });
  await w.settle();
  assert.deepEqual(w.presets.甲.extensions.qianmu.regexGroups, { p1: '旧组', p2: '旧组', p3: '旧组' }, '整批搬进预设');
  assert.deepEqual(w.local, { g9: '全局' }, '千幕设置里只剩全局正则');
});

test('factory defaults: save the current switches into the preset, restore them later, and clearing chat overrides works', async () => {
  const w = world({ allowed: true });
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p2', name: '结尾', enabled: false });
  assert.equal(await w.ctrl.actions.saveFactoryDefaults(), 3);
  assert.deepEqual(w.presets.甲.extensions.qianmu.regexDefaults, { p1: true, p2: false, p3: true }, '出厂开关写进预设');
  assert.equal(w.ctrl.state().sources.preset.hasFactory, true);
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p1', name: '开场', enabled: false });
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p2', name: '结尾', enabled: true });
  assert.equal(await w.ctrl.actions.restoreFactoryDefaults(), 2);
  assert.deepEqual(w.ctrl.state().sources.preset.items.map(i => i.enabled), [true, false, true], '拨回出厂值');
  assert.equal(await w.ctrl.actions.restoreFactoryDefaults(), 0, '已是出厂开关');
  // 绑定开着时恢复也记入本聊天；清空 = 删掉本聊天全部覆盖
  w.binding = { enabled: true, overrides: {}, preset: '甲' };
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p3', name: '杂项', enabled: false });
  assert.equal(Object.keys(w.binding.overrides).length, 1);
  assert.equal(w.ctrl.actions.clearBindingOverrides(), 1);
  assert.deepEqual(w.binding.overrides, {});
  assert.equal(w.binding.enabled, true, '预设绑定与绑定开关不变');
});

test('allow: writes ST\'s own allow list once', () => {
  const w = world();
  assert.equal(w.ctrl.state().sources.preset.allowed, false);
  w.ctrl.actions.allowPreset();
  assert.deepEqual(w.ctx.extensionSettings.preset_allowed_regex, { openai: ['甲'] });
  assert.equal(w.ctrl.state().sources.preset.allowed, true);
  assert.equal(allowPresetRegex(w.ctx), false, '已允许不重复写');
});

test('pure helpers: duplicates, search, snapshots', () => {
  assert.deepEqual(findDuplicateRegex([{ id: 'a', scriptName: '一', findRegex: ' x ' }, { id: 'b', scriptName: '二', findRegex: 'x' }, { id: 'c', scriptName: '三', findRegex: 'y' }, { id: 'd', findRegex: '' }]),
    { a: ['二'], b: ['一'] }, '查找表达式相同（去首尾空白）');
  // C-27：查找相同但替换不同 = 同一匹配的不同处理，不算重复；两者都相同（去首尾空白）才算
  assert.deepEqual(findDuplicateRegex([{ id: 'a', findRegex: 'x', replaceString: '1' }, { id: 'b', findRegex: 'x', replaceString: '2' }, { id: 'c', findRegex: 'x', replaceString: ' 1 ' }]),
    { a: ['（未命名）'], c: ['（未命名）'] });
  assert.equal(regexMatchesQuery({ name: '开场白' }, '', '开场'), true);
  assert.equal(regexMatchesQuery({ name: '开场白' }, '收尾', '收尾'), true, '组名也能搜');
  assert.equal(regexMatchesQuery({ name: '开场白' }, '', '开场 结尾'), false, '多个词需全部命中');
  assert.equal(regexMatchesQuery({ name: 'Status' }, '', 'stat'), true, '不区分大小写');
  assert.deepEqual(snapshotRegexDefaults([{ id: 'a', enabled: true }, { id: '#2', enabled: false }]), { a: true }, '只收真实 id');
  assert.deepEqual(diffRegexDefaults([{ id: 'a', enabled: false }, { id: 'n', enabled: false }], { a: true }), [{ id: 'a', name: undefined, enabled: true }], '新增条目没有出厂值，不算差异');
  assert.equal(PRESET_GROUPS_PATH, 'qianmu.regexGroups');
  assert.equal(PRESET_DEFAULTS_PATH, 'qianmu.regexDefaults');
});

test('search state is held by the controller and filters the view without regrouping', async () => {
  const { mountChatRegexView } = await import('../features/chat/qianmu-chat-regex-view.js');
  const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, value: '', scrollTop: 0, hidden: false,
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }, toggle(c, on) { if (on === undefined ? this.set.has(c) : !on) this.set.delete(c); else this.set.add(c); } },
      style: { setProperty() {}, removeProperty() {} }, append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = k; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, addEventListener(t, fn) { this.listeners[t] = fn; }, removeEventListener() {},
      contains(o) { return walkAll(this).includes(o); }, querySelectorAll() { return []; }, closest() { return null; }, getBoundingClientRect() { return { height: 400 }; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    return node;
  };
  const host = make('div'); host.ownerDocument = { createElement: make, createTextNode: t => ({ text: t }), defaultView: {}, addEventListener() {}, removeEventListener() {} };
  const w = world({ allowed: true });
  const view = mountChatRegexView({ root: host, actions: w.ctrl.actions });
  w.ctrl.actions.setQuery('结尾');
  view.render(w.ctrl.state());
  const rows = walkAll(host).filter(n => n.classList?.contains('qm-regex-row')).map(n => n.dataset.id);
  assert.deepEqual(rows, ['p2'], '只显示命中的条目');
  assert.ok(walkAll(host).some(n => n.dataset?.key === 'search'), '有搜索框');
  // 重复标记
  w.ctrl.actions.setQuery('');
  view.render(w.ctrl.state());
  const dupRows = walkAll(host).filter(n => n.classList?.contains('qm-regex-row') && n.classList.contains('is-duplicate')).map(n => n.dataset.id);
  assert.deepEqual(dupRows, ['p1', 'p3'], '查找表达式相同的两条带重复标记');
  view.dispose();
});

test('C-27: themed toolkit panel uses the window background; the manage bar uses the same card material as other cards', async () => {
  const { readFile } = await import('node:fs/promises');
  const skins = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
  const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(skins, /#story-director-floor-nav\[data-qm-theme\] \.sd-floor-panel \{\s*background: var\(--qm-skin-window\) !important;/, '工具包面板 = 窗体底色（与千幕主窗体一致）');
  assert.ok(!skins.includes(':is(.sd-storage-cleanup-dialog, .sd-floor-panel,'), '面板不再按卡片材质着色');
  assert.ok(css.includes('#story-director-floor-nav[data-qm-theme] .qm-regex-selbar { background: var(--qm-skin-material, var(--sd-card)) !important;'), '管理展开条 = 卡片材质');
  assert.ok(!/\.qm-regex-selbar \{[^}]*--qm-skin-window/.test(css), '管理展开条不再用窗体渐变');
});

test('C-27: saving defaults shows the waiting state on the preset switches, not on the button', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const presets = { 甲: { extensions: { regex_scripts: [{ id: 'p1', scriptName: '一' }, { id: 'p2', scriptName: '二' }] } } };
  const manager = { apiId: 'openai', getAllPresets: () => ['甲'], getSelectedPresetName: () => '甲', findPreset: n => n, selectPreset: async () => {},
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? presets.甲.extensions.regex_scripts : null),
    writePresetExtensionField: async () => { await gate; } };
  const ctx = { extensionSettings: { regex: [] }, getPresetManager: () => manager, getCurrentChatId: () => 'c', saveSettingsDebounced() {} };
  const ctrl = createChatRegex({ getContext: () => ctx, timers: { set: () => 1, clear() {} } });
  const run = ctrl.actions.saveFactoryDefaults();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...ctrl.state().pending].sort(), ['preset:p1', 'preset:p2'], '保存期间预设正则的开关处于等待态');
  release(); await run;
  assert.deepEqual([...ctrl.state().pending], [], '完成后恢复');
});
