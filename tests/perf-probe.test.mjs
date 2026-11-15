import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPerfProbe } from '../qianmu-perf-probe.js';

const memory = (initial = {}) => { const data = { ...initial }; return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, removeItem: key => { delete data[key]; } }; };

test('the probe is off by default and records nothing', () => {
  const probe = createPerfProbe({ storage: memory() });
  assert.equal(probe.enabled, false);
  const end = probe.start('便笺'); end('显示'); end.frame('显示'); probe.record('主面板·dashboard', '渲染', 12);
  assert.deepEqual(probe.summary(), []);
  assert.equal(probe.report(), '还没有记录');
});

test('on() persists the switch, spans record several phases, frame() waits for the next frame', () => {
  const storage = memory(); let clock = 0; const frames = [];
  const probe = createPerfProbe({ storage, now: () => clock, raf: fn => frames.push(fn) });
  probe.on();
  assert.equal(storage.data['qianmu.perf'], '1');
  const end = probe.start('便笺');
  clock = 20; end.frame('显示'); clock = 35; frames.shift()();
  clock = 180; end('数据就绪');
  const again = probe.start('便笺'); clock = 190; again('数据就绪');
  probe.record('主面板·theater', '渲染', 7.26); probe.record('主面板·theater', '渲染', NaN);
  assert.deepEqual(probe.summary(), [
    { 位置: '便笺', 阶段: '显示', 次数: 1, 平均ms: 35, 最大ms: 35, 最近ms: 35 },
    { 位置: '便笺', 阶段: '数据就绪', 次数: 2, 平均ms: 95, 最大ms: 180, 最近ms: 10 },
    { 位置: '主面板·theater', 阶段: '渲染', 次数: 1, 平均ms: 7.3, 最大ms: 7.3, 最近ms: 7.3 },
  ]);
  assert.match(probe.text(), /便笺\t数据就绪\t次数 2\t平均 95ms/);
  probe.clear(); assert.deepEqual(probe.summary(), []);
  probe.off(); assert.equal(storage.data['qianmu.perf'], undefined);
  assert.equal(createPerfProbe({ storage: memory({ 'qianmu.perf': '1' }) }).enabled, true);
});

test('watch() records when a host last changed before going quiet, and only while enabled', () => {
  let clock = 0; const timers = new Map(); let seq = 0, observer = null;
  const schedule = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + ms }); return id; }, cancel = id => timers.delete(id);
  const advance = ms => { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock && timers.has(id)) { timers.delete(id); t.fn(); } };
  class Observer { constructor(fn) { this.fn = fn; observer = this; } observe() {} disconnect() { this.off = true; } }
  const node = { addEventListener() {}, removeEventListener() {} };
  const off = createPerfProbe({ storage: memory(), now: () => clock });
  off.watch('分镜·gallery', node, { Observer, schedule, cancel }); assert.equal(observer, null);
  const probe = createPerfProbe({ storage: memory({ 'qianmu.perf': '1' }), now: () => clock });
  probe.watch('分镜·gallery', node, { Observer, schedule, cancel });
  advance(300); observer.fn(); advance(400); observer.fn(); advance(599); assert.deepEqual(probe.summary(), []);
  advance(1); assert.deepEqual(probe.summary(), [{ 位置: '分镜·gallery', 阶段: '内容到齐', 次数: 1, 平均ms: 700, 最大ms: 700, 最近ms: 700 }]);
  assert.equal(observer.off, true);
  probe.watch('分镜·logs', node, { Observer, schedule, cancel }); advance(700);
  assert.equal(probe.summary().length, 1, 'a host that never changed records nothing');
  // Same surface re-rendered (new host node): the measurement continues from the first call.
  probe.watch('分镜·characters', node, { Observer, schedule, cancel }); advance(200);
  probe.watch('分镜·characters', { addEventListener() {}, removeEventListener() {} }, { Observer, schedule, cancel }); advance(300); observer.fn(); advance(600);
  assert.deepEqual(probe.summary()[1], { 位置: '分镜·characters', 阶段: '内容到齐', 次数: 1, 平均ms: 500, 最大ms: 500, 最近ms: 500 });
});

test('rows are bounded and a blocked storage only loses persistence', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const probe = createPerfProbe({ storage: blocked, limit: 3 });
  assert.equal(probe.enabled, false); probe.on(); assert.equal(probe.enabled, true);
  for (let i = 0; i < 10; i++) probe.record('a', 'b', i);
  assert.deepEqual(probe.summary(), [{ 位置: 'a', 阶段: 'b', 次数: 3, 平均ms: 8, 最大ms: 9, 最近ms: 9 }]);
});

test('the entry reaches the probe only through an optional global, and warms first-open code when idle', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /globalThis\.qianmuPerf \|\|= createPerfProbe\(\);/);
  const uses = entry.match(/qianmuPerf\b[^\n]{0,12}/g).filter(use => !use.startsWith('qianmuPerf ||='));
  assert.ok(uses.length >= 5); // Direct access is only allowed inside the "if (laps)" block, which exists only when the probe is on.
  for (const use of uses) assert.match(use, /^qianmuPerf(\?\.|\.record\(surf)/, use);
  assert.match(entry, /const laps = globalThis\.qianmuPerf\?\.enabled \? \[\] : null;/);
  const extra = entry.slice(entry.indexOf('function scheduleExtraPreload()'), entry.indexOf('function closeFloorNavigator()'));
  assert.match(extra, /loadLocalChunk\('\.\/qianmu-text-collection-view\.js\?v=1\.59\.419'\)[\s\S]*warmStyle\(panel\.TEXT_COLLECTION_STYLESHEET\.href\)/);
  for (const piece of ['chatRegex.preload()', 'chatRingtone.preload()', 'loadChatRecoveryCode()', "loadLocalChunk('./qianmu-prose-assistant-conversations.js')", "import('./qianmu-notes-sync-runtime.js?v=1.59.419')"]) assert.ok(extra.includes(piece), piece);
  const notes = await readFile(new URL('../qianmu-notes.js', import.meta.url), 'utf8');
  for (const url of ["import('./qianmu-notes-sync-runtime.js?v=1.59.419')", "import('./qianmu-st-account-storage.js')"]) assert.ok(notes.includes(url) && extra.includes(url), url + ' must stay identical in both places');
  assert.match(entry, /stopExtraPreload\?\.\(\); stopExtraPreload = null;/);
  for (const file of ['features/chat/qianmu-chat-regex.js', 'features/chat/qianmu-chat-ringtone.js']) assert.match(await readFile(new URL('../' + file, import.meta.url), 'utf8'), /const preload = \(\) => loadView\(\)\.then\(\(\) => true, \(\) => false\);/);
});

// C-28 L3：便笺打开链路——重渲染不重复做主题同步；首读无变化不重渲染；开合面板不重画蜂巢。
test('notes panel re-renders skip the theme sync, and opening or closing leaves the hives alone', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const cut = (from, to) => entry.slice(entry.indexOf(from), entry.indexOf(to, entry.indexOf(from) + 1));
  const portal = cut('function renderNotesPanelPortal()', 'function detachedNotesGeometry()');
  assert.match(portal, /if \(layer\.qmNotesThemeSig !== themeSig\) \{ syncNotesTheme\(\); layer\.qmNotesThemeSig = themeSig; \}/);
  assert.equal(portal.match(/syncNotesTheme\(\)/g).length, 1, 'the only theme sync in the portal is the guarded one');
  for (const input of ['settings.theme', 'currentHiveThemeKey()', 'readAppearancePreferences(settings)', 'notesFeatureSettings().appearance', 'appearanceSession.status']) assert.ok(portal.includes(input), input);

  // Behaviour: same signature → one sync across two renders; a changed theme → a second sync.
  const calls = { sync: 0 }, layer = { style: { setProperty() {} }, innerHTML: '', querySelector: () => null };
  const state = { theme: 'light' };
  const sandbox = { notesPanelOpen: true, notesFeatureEnabled: () => true, NOTES_PANEL_LAYER_ID: 'layer', document: { getElementById: () => layer, body: {} },
    settings: state, currentHiveThemeKey: () => state.theme, readAppearancePreferences: () => ({ family: 'classic' }), notesFeatureSettings: () => ({ appearance: { tone: 'dark' }, editorFontSize: 14 }),
    appearanceSession: { status: 'idle' }, syncNotesTheme: () => { calls.sync++; }, getComputedStyle: () => ({ fontFamily: 'x' }), stopNotesPanelResizeTracking() {}, renderNotesPanel: () => '',
    applyQianmuIcons() {}, bindNotesPanelEvents() {}, bindNotesPanelResize() {}, notesSyncControls: () => ({ mount() {} }), JSON };
  const { default: vm } = await import('node:vm');
  vm.runInNewContext(portal, sandbox);
  sandbox.renderNotesPanelPortal(); sandbox.renderNotesPanelPortal(); assert.equal(calls.sync, 1);
  state.theme = 'night'; sandbox.renderNotesPanelPortal(); assert.equal(calls.sync, 2);

  const hydrate = cut('async function hydrateNotesRuntime(', 'async function persistNoteRuntime(');
  // The first read always redraws once: the list shows a "正在读取便笺…" row until then.
  assert.match(hydrate, /!previouslyLoaded ||/); assert.match(hydrate, /hydrateNotesRuntime.failed = true;/);
  assert.match(cut('function renderNotesPanel()', 'const NOTES_THEME_VARIABLES'), /const waiting = notesLoaded ? '' :[sS]*正在读取便笺…[sS]*${list || waiting}/);
  assert.match(cut('function openNotesPanel()', 'function closeNotesPanel()'), /renderFloatingNotes\(\{ hives: false \}\);/);
  assert.match(cut('function closeNotesPanel()', 'function noteExcerpt('), /renderFloatingNotes\(\{ hives: false \}\);/);
  assert.match(entry, /function renderFloatingNotes\(\{ hives = true \} = \{\}\) \{[\s\S]{0,200}?if \(hives\) \{ proseFloorTools\.renderHive\(\); floorHive\?\.render\(\); \}/);
});

// C-28：图标按「符号」只解析一次，之后克隆；克隆彼此独立，且与逐个构建的结果一致。
test('icon elements are built once per symbol and cloned afterwards', async () => {
  const { qianmuIconElement } = await import('../qianmu-icon-renderer.js');
  let built = 0;
  const make = (source = null) => {
    const node = { attrs: new Map(source ? source.attrs : []), html: source ? source.html : '', classes: new Set(source ? source.classes : []),
      classList: { add: name => node.classes.add(name) }, setAttribute: (key, value) => node.attrs.set(key, String(value)), getAttribute: key => node.attrs.get(key) ?? null,
      get innerHTML() { return node.html; }, set innerHTML(value) { node.html = String(value); }, get firstElementChild() { return node.html ? {} : null; },
      cloneNode: () => make(node) };
    return node;
  };
  const doc = { createElementNS: () => { built++; return make(); } };
  const first = qianmuIconElement('qm-regular-star', { document: doc }), second = qianmuIconElement('qm-regular-star', { document: doc }), other = qianmuIconElement('qm-fill-star', { document: doc });
  assert.equal(built, 2, 'one build per distinct symbol');
  assert.notEqual(first, second); assert.equal(second.innerHTML, first.innerHTML); assert.ok(first.innerHTML.length > 0);
  assert.deepEqual([...second.attrs], [...first.attrs]); assert.notEqual(other.innerHTML, first.innerHTML);
  second.setAttribute('data-x', '1'); assert.equal(qianmuIconElement('qm-regular-star', { document: doc }).getAttribute('data-x'), null, 'a caller cannot mutate the template');
  assert.equal(qianmuIconElement('qm-regular-star', { document: { createElementNS: () => { built++; return make(); } } }).innerHTML, first.innerHTML);
  assert.equal(built, 3, 'templates are per document');
});
