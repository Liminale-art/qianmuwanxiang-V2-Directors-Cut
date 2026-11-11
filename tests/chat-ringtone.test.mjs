import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  RINGTONE_PRESETS, RINGTONE_TAB_ICONS, RINGTONE_LIMITS, RINGTONE_DEFAULTS,
  normalizeRingtone, safeSoundUrl, createTabAlert, createChatRingtone, TOAST_POSITIONS, applyToastSkin,
} from '../features/chat/qianmu-chat-ringtone.js';

const root = new URL('../', import.meta.url);

test('normalizeRingtone repairs a missing or malformed shape in place', () => {
  const owner = {};
  const value = normalizeRingtone(owner);
  assert.equal(owner.ringtone, value);
  assert.deepEqual({ ...value }, { ...RINGTONE_DEFAULTS, customIcons: [], localSounds: [] });
  // Out-of-range and wrong-typed fields fall back to safe values.
  const dirty = { ringtone: { soundEnabled: 'yes', soundSource: 'ftp', soundPreset: 'nope', volume: 999, flashText: '一二三四五六七八九十甲乙丙', customIcons: ['x', 'data:image/png;base64,QQ=='] } };
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
  assert.ok(entry.includes("from './features/chat/qianmu-chat-ringtone.js?v=1.59.490'"));
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

test('toast skin: only three centred positions, normalized and applied through one html attribute', () => {
  assert.deepEqual(TOAST_POSITIONS.map(([id]) => id), ['top', 'bottom', 'middle']);
  const s = normalizeRingtone({ ringtone: { toastSkin: 'yes', toastPosition: 'top-right' } });
  assert.equal(s.toastSkin, false);
  assert.equal(s.toastPosition, 'top');
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } } };
  applyToastSkin(doc, { toastSkin: true, toastPosition: 'middle' });
  assert.equal(attrs['data-qm-toast'], 'middle');
  applyToastSkin(doc, { toastSkin: false, toastPosition: 'middle' });
  assert.ok(!('data-qm-toast' in attrs));
  applyToastSkin(doc, null);
  assert.ok(!('data-qm-toast' in attrs));
});

test('toast skin runtime: activate applies the saved skin, update re-applies, dispose removes it', () => {
  const attrs = {};
  const { doc } = fakeDocument();
  doc.documentElement = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } };
  const settings = { ringtone: { toastSkin: true, toastPosition: 'bottom' } };
  const ring = createChatRingtone({ getOwner: () => settings, save: () => {}, getContext: () => ({ chat: [] }), resolveNamespace: () => 'ns',
    document: doc, window: { addEventListener() {}, removeEventListener() {} }, Audio: class {}, indexedDB: null,
    loadView: async () => ({ mountChatRingtoneView: () => ({ render() {}, dispose() {} }) }), setInterval: () => 1, clearInterval: () => {} });
  assert.ok(!('data-qm-toast' in attrs), '未激活前不改页面');
  ring.activate();
  assert.equal(attrs['data-qm-toast'], 'bottom');
  ring.actions.update({ toastPosition: 'middle' });
  assert.equal(attrs['data-qm-toast'], 'middle');
  ring.actions.update({ toastSkin: false });
  assert.ok(!('data-qm-toast' in attrs));
  ring.actions.update({ toastSkin: true });
  ring.dispose();
  assert.ok(!('data-qm-toast' in attrs), '卸载后还原 ST 原样');
});

test('toast skin never hooks toastr: no observers, polling, or toastr rewrites', async () => {
  const source = await readFile(new URL('features/chat/qianmu-chat-ringtone.js', root), 'utf8');
  const skin = source.slice(source.indexOf('export const TOAST_POSITIONS'), source.indexOf('/** Repairs the stored settings'));
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
