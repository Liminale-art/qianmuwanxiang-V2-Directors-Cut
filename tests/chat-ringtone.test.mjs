import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  RINGTONE_PRESETS, RINGTONE_TAB_ICONS, RINGTONE_LIMITS, RINGTONE_DEFAULTS,
  normalizeRingtone, safeSoundUrl, createTabAlert, createChatRingtone, TOAST_STYLES, TOAST_FONT_SIZES, TOAST_DURATIONS, TOAST_STACK_MAX, applyToastSkin, toastCallOptions,
} from '../features/chat/qianmu-chat-ringtone.js';

const root = new URL('../', import.meta.url);

test('normalizeRingtone repairs a missing or malformed shape in place', () => {
  const owner = {};
  const value = normalizeRingtone(owner);
  assert.equal(owner.ringtone, value);
  assert.deepEqual({ ...value }, { ...RINGTONE_DEFAULTS, customIcons: [], localSounds: [] });
  // Out-of-range and wrong-typed fields fall back to safe values.
  const dirty = { ringtone: { soundEnabled: 'yes', soundSource: 'ftp', soundPreset: 'nope', volume: 999, flashText: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳', customIcons: ['x', 'data:image/png;base64,QQ=='] } };
  const fixed = normalizeRingtone(dirty);
  assert.equal(fixed.soundEnabled, false);
  assert.equal(fixed.soundSource, 'builtin');
  assert.equal(fixed.soundPreset, RINGTONE_DEFAULTS.soundPreset);
  assert.equal(fixed.volume, 100);
  assert.equal([...fixed.flashText].length, RINGTONE_LIMITS.flashText);
  assert.deepEqual(fixed.customIcons, ['', 'data:image/png;base64,QQ==']);
});

test('normalizeRingtone migrates the legacy single local sound into the multi-record library', () => {
  const legacy = normalizeRingtone({ ringtone: { soundSource: 'local', localName: '旧铃声.mp3', localSize: 2048 } });
  assert.equal(legacy.localSounds.length, 1);
  assert.equal(legacy.localSounds[0].id, 'message');
  assert.equal(legacy.localSounds[0].name, '旧铃声.mp3');
  assert.equal(legacy.localId, 'message');
  assert.ok(!('localName' in legacy) && !('localSize' in legacy));
  // Bad ids and duplicates are dropped; localId falls back to the first valid entry.
  const multi = normalizeRingtone({ ringtone: { localSounds: [{ id: 'bad id!' }, { id: 'a1', name: 'A', size: 1 }, { id: 'a1', name: 'dup' }, { id: 'b2', name: 'B' }], localId: 'zzz' } });
  assert.deepEqual(multi.localSounds.map(i => i.id), ['a1', 'b2']);
  assert.equal(multi.localId, 'a1');
});

test('safeSoundUrl only accepts http(s) URLs', () => {
  assert.equal(safeSoundUrl('https://a.b/x.mp3'), 'https://a.b/x.mp3');
  assert.equal(safeSoundUrl(' http://a.b/x '), 'http://a.b/x');
  assert.equal(safeSoundUrl('javascript:alert(1)'), '');
  assert.equal(safeSoundUrl('data:audio/mp3;base64,AAA'), '');
  assert.equal(safeSoundUrl(''), '');
});

function fakeDocument() {
  const links = [];
  const doc = {
    title: 'ST',
    hidden: true,
    head: { append(node) { links.push(node); } },
    hasFocus: () => false,
    querySelectorAll: () => links.filter(l => (l.rel || '').split(/\s+/).includes('icon')),
    createElement() {
      const attrs = {}; const node = { dataset: {}, rel: '', set rel(v) { attrs.rel = v; }, };
      return {
        dataset: {}, _attrs: attrs,
        setAttribute(k, v) { attrs[k] = v; if (k === 'rel') this.rel = v; },
        getAttribute(k) { return k in attrs ? attrs[k] : null; },
        removeAttribute(k) { delete attrs[k]; },
        remove() { const i = links.indexOf(this); if (i >= 0) links.splice(i, 1); },
        rel: '',
      };
    },
    addEventListener() {}, removeEventListener() {},
  };
  return { doc, links };
}

test('createTabAlert flashes the title and restores it on stop', () => {
  const { doc } = fakeDocument();
  let fn = null;
  const alert = createTabAlert({ document: doc, setInterval: cb => { fn = cb; return 1; }, clearInterval: () => { fn = null; } });
  assert.equal(alert.start({ text: '新消息', icons: [] }), true);
  assert.equal(doc.title, '【新消息】ST');
  fn(); // next tick returns to base
  assert.equal(doc.title, 'ST');
  assert.equal(alert.active(), true);
  alert.stop();
  assert.equal(doc.title, 'ST');
  assert.equal(alert.active(), false);
});

test('createTabAlert needs either text or an icon to start', () => {
  const { doc } = fakeDocument();
  const alert = createTabAlert({ document: doc, setInterval: () => 1, clearInterval: () => {} });
  assert.equal(alert.start({ text: '', icons: [] }), false);
});

function harness(overrides = {}) {
  const { doc } = fakeDocument();
  const settings = {};
  let chat = [{ is_user: true, mes: 'hi' }, { mes: '回复内容' }];
  const calls = { ring: 0 };
  let clock = 100000;
  const ring = createChatRingtone({
    getOwner: () => settings,
    save: () => {},
    getContext: () => ({ chat }),
    resolveNamespace: () => 'ns',
    notify: () => {},
    isCurrent: () => true,
    document: doc,
    window: { addEventListener() {}, removeEventListener() {} },
    Audio: class { constructor() { this.paused = true; } addEventListener() {} async play() { calls.ring += 1; this.paused = false; } pause() { this.paused = true; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    indexedDB: null,
    loadView: async () => ({ mountChatRingtoneView: () => ({ render() {}, dispose() {}, state: () => null }) }),
    now: () => clock,
    setInterval: () => 1, clearInterval: () => {},
    ...overrides,
  });
  // enable sound so ring() actually plays
  normalizeRingtone(settings); settings.ringtone.soundEnabled = true;
  return { ring, settings, setChat: v => { chat = v; }, calls, tick: n => { clock += n; } };
}

test('message sound requires a real armed generation', async () => {
  const h = harness();
  // No generation started → disarmed → no sound.
  h.ring.events.messageReceived(1, 'normal');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 0);

  // Armed by a real generation.
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.messageReceived(1, 'normal');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 1);
});

test('quiet, dry-run and impersonate generations never arm the sound', async () => {
  for (const [type, options, dry] of [['quiet', {}, false], ['normal', { quiet_prompt: 'x' }, false], ['normal', {}, true], ['impersonate', {}, false]]) {
    const h = harness();
    h.ring.events.generationStarted(type, options, dry);
    h.ring.events.messageReceived(1, 'normal');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(h.calls.ring, 0, `${type} dry=${dry} must not arm`);
  }
});

test('stop, chat change, first_message and user/empty messages suppress the sound', async () => {
  // Stopped generation.
  let h = harness();
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.generationStopped();
  h.ring.events.messageReceived(1, 'normal');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 0);

  // first_message type.
  h = harness();
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.messageReceived(1, 'first_message');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 0);

  // User / empty messages.
  h = harness();
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.messageReceived(0, 'normal'); // index 0 is a user message
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 0);
});

test('a burst of replies rings once within the debounce window', async () => {
  const h = harness();
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.messageReceived(1, 'normal');
  await new Promise(r => setTimeout(r, 0));
  // second reply within 1500ms, re-armed
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.messageReceived(1, 'normal');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 1);
  // after the window it rings again
  h.tick(2000);
  h.ring.events.generationStarted('normal', {}, false);
  h.ring.events.messageReceived(1, 'normal');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.calls.ring, 2);
});

test('every preset maps to a file that exists in assets/ringtones', async () => {
  const dir = new URL('assets/ringtones/', root);
  const onDisk = new Set(await readdir(dir));
  for (const preset of RINGTONE_PRESETS) {
    const name = preset.url.split('/').pop();
    assert.ok(onDisk.has(name), `missing asset for preset ${preset.id}: ${name}`);
  }
  // Preset ids are unique.
  assert.equal(new Set(RINGTONE_PRESETS.map(p => p.id)).size, RINGTONE_PRESETS.length);
  // Both default tab icons exist.
  for (const icon of RINGTONE_TAB_ICONS) assert.ok(await readFile(fileURLToPath(icon)));
});

test('index.js wires the ringtone tab, whitelist and events', async () => {
  const entry = await readFile(new URL('index.js', root), 'utf8');
  assert.ok(entry.includes("from './features/chat/qianmu-chat-ringtone.js?v=1.59.493'"));
  assert.ok(entry.includes('createChatRingtone({'));
  // Four-tab navigation with the ring tab.
  assert.ok(entry.includes('data-floor-tab="ring"'));
  assert.ok(entry.includes('data-floor-view="ring"'));
  assert.ok(entry.includes("['layout', 'recovery', 'ring'].includes("));
  // Event bindings.
  for (const name of ['generationStarted', 'generationStopped', 'messageReceived', 'chatChanged']) {
    assert.ok(entry.includes(`chatRingtone.events[name]`) || entry.includes(name), `missing event binding ${name}`);
  }
  assert.ok(entry.includes('chatRingtone.dispose();'));
  assert.ok(entry.includes('chatRingtone.unmount();'));
});

test('tab labels read 跳层/排版/备份/通知', async () => {
  const entry = await readFile(new URL('index.js', root), 'utf8');
  const order = ['跳层', '排版', '备份', '通知'].map(label => entry.indexOf(label));
  assert.ok(order.every(i => i >= 0), '四个页签文案齐全');
});

test('the deprecated presets are gone and the two new ringtones are present', () => {
  const ids = new Set(RINGTONE_PRESETS.map(p => p.id));
  assert.ok(!ids.has('get-deluxe-item') && !ids.has('interact-sound'), '已移除旧铃声');
  assert.ok(ids.has('crisp-droplet-echo') && ids.has('crisp-wind-chime'), '已加入两个新铃声');
});

test('toast skin: styles/font size/duration are normalized; position is retired', () => {
  assert.deepEqual(TOAST_STYLES.map(([id, label]) => [id, label]), [['default', '默认'], ['splat', '涂鸦'], ['iris', '虹彩']]);
  assert.deepEqual(TOAST_DURATIONS.map(([, label]) => label), ['3s', '4s', '6s', '10s']);
  assert.equal(normalizeRingtone({ ringtone: { toastStyle: 'arc' } }).toastStyle, 'splat', '旧样式1迁移为涂鸦');
  assert.deepEqual(TOAST_FONT_SIZES.map(([id]) => id), ['sm', 'md', 'lg']);
  assert.ok(TOAST_DURATIONS.every(([seconds]) => Number.isFinite(seconds) && seconds > 0));
  const s = normalizeRingtone({ ringtone: { toastSkin: 'yes', toastPosition: 'top-right', toastStyle: 'mosaic', toastFontSize: 'xl', toastDuration: 99 } });
  assert.equal(s.toastSkin, false);
  assert.equal(s.toastStyle, 'default', '已弃用的马赛克回落为默认');
  assert.equal(s.toastFontSize, RINGTONE_DEFAULTS.toastFontSize);
  assert.equal(s.toastDuration, RINGTONE_DEFAULTS.toastDuration);
  assert.ok(!('toastPosition' in s), '位置设置已移除，固定 ST 原生顶部居中');
});

test('toast skin: html attributes carry style, size, theme and day/night; off removes them all', () => {
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } } };
  applyToastSkin(doc, { toastSkin: true, toastStyle: 'iris', toastFontSize: 'lg' }, { theme: 'glass', mode: 'dark' });
  assert.deepEqual(attrs, { 'data-qm-toast': 'iris', 'data-qm-toast-size': 'lg', 'data-qm-toast-theme': 'glass', 'data-qm-toast-mode': 'dark' });
  applyToastSkin(doc, { toastSkin: true, toastStyle: 'default', toastFontSize: 'md' }, { theme: 'bogus', mode: 'weird' });
  assert.equal(attrs['data-qm-toast-theme'], 'light', '未知主题回落为日间经典');
  assert.equal(attrs['data-qm-toast-mode'], 'light');
  applyToastSkin(doc, { toastSkin: false });
  assert.deepEqual(attrs, {});
  applyToastSkin(doc, null);
  assert.deepEqual(attrs, {});
});

test('toast duration is a per-call option and only while the skin is on', () => {
  assert.equal(toastCallOptions(null), null);
  assert.equal(toastCallOptions({ toastSkin: false, toastDuration: 6 }), null);
  assert.deepEqual(toastCallOptions({ toastSkin: true, toastDuration: 6 }), { timeOut: 6000, extendedTimeOut: 6000 });
  assert.equal(toastCallOptions({ toastSkin: true, toastDuration: 123 }).timeOut, RINGTONE_DEFAULTS.toastDuration * 1000);
});

test('toast skin runtime: activate applies, update and refreshLook re-apply, dispose removes', () => {
  const attrs = {};
  const { doc } = fakeDocument();
  doc.documentElement = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } };
  const settings = { ringtone: { toastSkin: true, toastStyle: 'splat' } };
  let look = { theme: 'summer', mode: 'light' };
  const ring = createChatRingtone({ getOwner: () => settings, save: () => {}, getContext: () => ({ chat: [] }), resolveNamespace: () => 'ns',
    document: doc, window: { addEventListener() {}, removeEventListener() {} }, Audio: class {}, indexedDB: null, getLook: () => look,
    loadView: async () => ({ mountChatRingtoneView: () => ({ render() {}, dispose() {} }) }), setInterval: () => 1, clearInterval: () => {} });
  assert.ok(!('data-qm-toast' in attrs), '未激活前不改页面');
  ring.activate();
  assert.equal(attrs['data-qm-toast'], 'splat');
  assert.equal(attrs['data-qm-toast-theme'], 'summer');
  ring.actions.update({ toastStyle: 'iris', toastFontSize: 'sm' });
  assert.equal(attrs['data-qm-toast'], 'iris');
  assert.equal(attrs['data-qm-toast-size'], 'sm');
  look = { theme: 'dark', mode: 'dark' };
  ring.refreshLook();
  assert.equal(attrs['data-qm-toast-mode'], 'dark', '切换主题/日夜后默认样式跟随');
  ring.actions.update({ toastSkin: false });
  assert.ok(!('data-qm-toast' in attrs));
  ring.actions.update({ toastSkin: true });
  ring.dispose();
  assert.deepEqual(attrs, {}, '卸载后还原 ST 原样');
});

test('toast preview copy', async () => {
  const shown = [];
  const h = harness({ notify: (message, type) => shown.push([message, type]) });
  h.ring.actions.previewToast();
  assert.deepEqual(shown, [['(｡･∀･)ﾉﾞoi，这是一条提示框预览', 'info']]);
});

test('index.js passes the duration per call and re-syncs the toast look on theme changes', async () => {
  const entry = await readFile(new URL('index.js', root), 'utf8');
  assert.ok(entry.includes('toastCallOptions(settings?.ringtone)'), 'toast() 按单次调用传入停留时间');
  assert.ok(entry.includes('getLook:qianmuToastLook'), '提示框读取千幕主题与日夜间');
  assert.ok((entry.match(/chatRingtone\.refreshLook\(\)/g) || []).length >= 3, '经典主题/旧路径/新外观切换后都重同步');
});

test('ringtone list sub-page takes over the toolkit panel at the 通知 page height', async () => {
  const view = await readFile(new URL('features/chat/qianmu-chat-ringtone-view.js', root), 'utf8');
  assert.ok(view.includes("closest?.('.sd-floor-panel')") && view.includes('qm-ring-subpage-open') && view.includes('--qm-ring-lock-h'));
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(css.includes('.sd-floor-panel.qm-ring-subpage-open > :is(header, .sd-floor-tabs) { display: none; }'), '列表页隐藏标题与页签');
  assert.ok(/qm-ring-subpage-open \.qm-ring-list \{[^}]*overflow-y: auto/.test(css), '超出在列表内滚动');
  assert.ok(!css.includes('qm-toast-style="mosaic"') && !css.includes(':not(.popup *)'), '马赛克与自定定位层已移除');
});

test('toast skin never hooks toastr: no observers, polling, or toastr rewrites', async () => {
  const source = await readFile(new URL('features/chat/qianmu-chat-ringtone.js', root), 'utf8');
  const skin = source.slice(source.indexOf('export const TOAST_STYLES'), source.indexOf('/** Repairs the stored settings'));
  for (const banned of ['MutationObserver', 'setInterval', 'setTimeout', 'requestAnimationFrame', 'toastr', 'querySelector']) {
    assert.ok(!skin.includes(banned), `提示框美化不得使用 ${banned}`);
  }
  assert.ok(!/toastr\s*\.\s*(options|subscribe|\w+\s*=)/.test(source), '不得改写 toastr 配置或方法');
  const css = await readFile(new URL('style.css', root), 'utf8');
  const rules = css.split('\n').filter(line => line.includes('#toast-container') && !line.startsWith('html body'))
    .map(line => line.replace(/^@media[^{]*\{\s*/, ''));
  assert.ok(rules.length > 0 && rules.every(line => line.startsWith('html[data-qm-toast')), '所有换皮规则都挂在 html[data-qm-toast] 下');
  assert.ok(css.includes('var(--qm-interface-font, var(--mainFontFamily'), '字体跟随字体库界面设置');
  assert.ok(!/data-qm-toast="(?:left|right|top-left|top-right|bottom-left|bottom-right)"/.test(css), '不提供偏左右位置');
});

test('list rows audition on select: selectPreset/selectLocal persist the pick and play it; stopSound halts', async () => {
  const played = [];
  let paused = 0;
  const h = harness({ Audio: class { constructor() { this.paused = true; } addEventListener() {} async play() { played.push(this.src); this.paused = false; } pause() { paused += 1; this.paused = true; } } });
  const target = RINGTONE_PRESETS[RINGTONE_PRESETS.length - 1];
  await h.ring.actions.selectPreset(target.id);
  assert.equal(h.settings.ringtone.soundPreset, target.id, '点选即保存');
  assert.equal(played.length, 1, '点选即试听');
  await h.ring.actions.selectPreset('no-such-preset');
  assert.equal(h.settings.ringtone.soundPreset, target.id, '未知项不改选择');
  assert.equal(played.length, 1);
  await h.ring.actions.selectLocal('missing');
  assert.equal(played.length, 1, '不存在的本地铃声不播放');
  h.ring.actions.stopSound();
  assert.ok(paused >= 1, '返回时停止试听');
  assert.ok(!('preview' in h.ring.actions), '不再提供单独的试听按钮动作');
});

test('ringtone view has no separate preview button or bottom-sheet list', async () => {
  const view = await readFile(new URL('features/chat/qianmu-chat-ringtone-view.js', root), 'utf8');
  for (const gone of ['qm-ring-preview', 'qm-ring-sheet']) assert.ok(!view.includes(gone), `已移除 ${gone}`);
  assert.ok(!/actions\.preview\(/.test(view), '已移除铃声试听动作（提示框预览 previewToast 保留）');
  assert.ok(view.includes("openList('builtin')") && view.includes("openList('local')"), '内置/本地都进入面板内列表子页');
  assert.ok(view.includes('actions.stopSound()'), '返回主页时停止试听');
});

test('paper (editorial) theme squares the toolkit notice/backup controls but keeps round dots and switches', async () => {
  const skins = await readFile(new URL('qianmu-theme-skins.css', root), 'utf8');
  const start = skins.indexOf('[data-qm-theme="editorial"] :is(');
  const list = skins.slice(start, skins.indexOf(') { border-radius: 0 !important; }', start));
  for (const cls of ['.qm-ring-sources', '.qm-ring-list', '.qm-ring-card', '.qm-recovery-native-policy', '.qm-recovery-role-picker', '.qm-recovery-status', '.qm-recovery-receipt']) {
    assert.ok(list.includes(cls), `纸间直角覆盖 ${cls}`);
  }
  for (const round of ['.qm-ring-cap-track', '.qm-ring-cap-knob', '.qm-ring-radio', '.qm-ring-icon', '.qm-recovery-loading-dot']) {
    assert.ok(!list.includes(round), `${round} 保持圆形`);
  }
});

test('ringtone defaults: new reminder copy fits the limit; background note removed; preview sits in the style row', async () => {
  assert.equal(RINGTONE_DEFAULTS.flashText, '( •̀ .̫ •́ )✧叮咚，您有新订单啦~');
  assert.ok([...RINGTONE_DEFAULTS.flashText].length <= RINGTONE_LIMITS.flashText);
  assert.equal(normalizeRingtone({}).flashText, RINGTONE_DEFAULTS.flashText, '默认文案不被截断');
  const view = await readFile(new URL('features/chat/qianmu-chat-ringtone-view.js', root), 'utf8');
  assert.ok(!view.includes('只有当浏览器标签切到后台时才会响铃'), '后台响铃说明已去除');
  const toast = view.slice(view.indexOf('function toastCard'), view.indexOf('function render'));
  assert.ok(toast.indexOf('qm-ring-toast-test') < toast.indexOf('card.append(styles)'), '预览图标与样式同排');
  const css = await readFile(new URL('style.css', root), 'utf8');
  assert.ok(/qm-ring-list {[^}]*scrollbar-width: none/.test(css) && css.includes('.qm-ring-list::-webkit-scrollbar { width: 0; height: 0; }'), '列表隐藏滚动条但保留滚动');
});

test('list rows mark the pick before the audition finishes loading', async () => {
  const { mountChatRingtoneView } = await import('../features/chat/qianmu-chat-ringtone-view.js');
  const nodes = [];
  const make = tag => {
    const node = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, className: '', textContent: '', style: { setProperty() {}, removeProperty() {} },
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }, toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); } },
      append(...kids) { this.children.push(...kids); }, appendChild(kid) { this.children.push(kid); }, replaceChildren(...kids) { this.children = kids; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector() { return null; }, contains() { return false; }, closest() { return null; } };
    Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
    nodes.push(node); return node;
  };
  const host = make('div'); host.ownerDocument = { createElement: make, activeElement: null };
  let release;
  const actions = { presets: RINGTONE_PRESETS.slice(0, 3), limits: RINGTONE_LIMITS, stopSound() {}, iconFrames: () => [], toastStyles: TOAST_STYLES, toastFontSizes: TOAST_FONT_SIZES, toastDurations: TOAST_DURATIONS,
    selectPreset: () => new Promise(resolve => { release = resolve; }) };
  const view = mountChatRingtoneView({ root: host, actions });
  const s = normalizeRingtone({});
  view.render(s);
  nodes.find(n => n.classList.contains('qm-ring-picker')).listeners.click();
  await new Promise(r => setTimeout(r, 0));
  const rows = nodes.filter(n => n.classList.contains('qm-ring-list-item'));
  const target = rows.find(n => n.dataset.id !== s.soundPreset);
  target.listeners.click();
  assert.ok(target.classList.contains('is-active'), '点下即显示选中，不等音频');
  assert.equal(target.attrs['aria-checked'], 'true');
  release();
});

test('toast stack count: normalized, mirrored to an html attribute, enforced by CSS only', async () => {
  assert.equal(RINGTONE_DEFAULTS.toastStack, 0, '默认不限，保持 ST 原样');
  assert.equal(normalizeRingtone({ ringtone: { toastStack: 3 } }).toastStack, 3);
  for (const bad of [-1, 2.5, 'x', TOAST_STACK_MAX + 1]) assert.equal(normalizeRingtone({ ringtone: { toastStack: bad } }).toastStack, 0);
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } } };
  applyToastSkin(doc, { toastSkin: true, toastStyle: 'splat', toastFontSize: 'md', toastStack: 2 }, { theme: 'light', mode: 'light' });
  assert.equal(attrs['data-qm-toast-stack'], '2');
  applyToastSkin(doc, { toastSkin: true, toastStyle: 'splat', toastFontSize: 'md', toastStack: 0 }, null);
  assert.ok(!('data-qm-toast-stack' in attrs), '0 为不限');
  applyToastSkin(doc, { toastSkin: true, toastStyle: 'splat', toastFontSize: 'md', toastStack: 4 }, null);
  applyToastSkin(doc, { toastSkin: false });
  assert.deepEqual(attrs, {});
  const css = await readFile(new URL('style.css', root), 'utf8');
  for (let n = 1; n <= TOAST_STACK_MAX; n += 1) {
    assert.ok(css.includes(`html[data-qm-toast-stack="${n}"] body #toast-container > div:nth-child(n+${n + 1}) { display: none !important; }`), `堆叠 ${n} 规则`);
  }
  const view = await readFile(new URL('features/chat/qianmu-chat-ringtone-view.js', root), 'utf8');
  assert.ok(view.includes("stack.type = 'number'") && view.includes('toastStack'), '堆叠数量为输入框');
});

test('涂鸦 style: day/night only, per-status clash colours, outside square bar, pop-in', async () => {
  const css = await readFile(new URL('style.css', root), 'utf8');
  const splat = css.split('\n').filter(line => line.includes('data-qm-toast="splat"')).join('\n');
  assert.ok(!splat.includes('--qm-toast-accent') && !splat.includes('data-qm-toast-theme'), '不跟随主题强调色，只按日夜');
  for (const status of ['.toast-success', '.toast-warning', '.toast-error']) assert.ok(splat.includes(status), `${status} 有独立配色`);
  assert.ok(/::before \{ left: -\d+px[^}]*border-radius: 0/.test(splat), '竖条在框外且直角');
  assert.ok(splat.includes('animation: qm-toast-splat') && /@keyframes qm-toast-splat \{ 0% \{[^}]*scale\(\.6\)/.test(css), '由小到大弹出');
  assert.ok(!css.includes('data-qm-toast="arc"'), '旧样式1规则已替换');
});
