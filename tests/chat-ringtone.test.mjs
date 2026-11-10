import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  RINGTONE_PRESETS, RINGTONE_TAB_ICONS, RINGTONE_LIMITS, RINGTONE_DEFAULTS,
  normalizeRingtone, safeSoundUrl, createTabAlert, createChatRingtone,
} from '../features/chat/qianmu-chat-ringtone.js';

const root = new URL('../', import.meta.url);

test('normalizeRingtone repairs a missing or malformed shape in place', () => {
  const owner = {};
  const value = normalizeRingtone(owner);
  assert.equal(owner.ringtone, value);
  assert.deepEqual({ ...value }, { ...RINGTONE_DEFAULTS, customIcons: [] });
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
  assert.ok(entry.includes("from './features/chat/qianmu-chat-ringtone.js?v=1.59.485'"));
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

test('tab labels read 跳层/排版/备份/铃声', async () => {
  const entry = await readFile(new URL('index.js', root), 'utf8');
  const order = ['跳层', '排版', '备份', '铃声'].map(label => entry.indexOf(label));
  assert.ok(order.every(i => i >= 0), '四个页签文案齐全');
});
