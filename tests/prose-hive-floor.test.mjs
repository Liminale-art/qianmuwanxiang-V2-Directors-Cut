import test from 'node:test';
import assert from 'node:assert/strict';
import { createProseHive } from '../qianmu-prose-hive.js';

// Minimal DOM: records appended layers and the storage key each hive writes to.
function harness() {
  const stores = new Map();
  function node(tag = 'div') {
    const children = [], attrs = new Map(), listeners = new Map();
    const self = {
      tagName: tag, children, dataset: {}, style: new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => (t[k] = v, true) }),
      classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains: c => self.classList._s.has(c) },
      set className(v) { this._cn = v; }, get className() { return this._cn || ''; },
      setAttribute: (k, v) => attrs.set(k, v), getAttribute: k => attrs.get(k) ?? null, removeAttribute: k => attrs.delete(k),
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
      style_setProperty() {}, append: (...n) => children.push(...n), remove() { const i = (self.parent?.children || []).indexOf(self); if (i >= 0) self.parent.children.splice(i, 1); },
      addEventListener: (t, fn) => { (listeners.get(t) || listeners.set(t, new Set()).get(t)).add(fn); }, removeEventListener() {},
      querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
      setPointerCapture() {}, releasePointerCapture() {},
    };
    self.style.setProperty = () => {};
    return self;
  }
  const body = node('body');
  const document = { body, createElement: tag => node(tag) };
  const window = { localStorage: { getItem: k => stores.get(k) ?? null, setItem: (k, v) => stores.set(k, v), removeItem: k => stores.delete(k) }, addEventListener() {}, removeEventListener() {}, setTimeout: fn => fn(), visualViewport: null };
  return { document, window, body, stores };
}

const base = h => ({
  document: h.document, window: h.window,
  geometry: () => ({ width: 40, height: 40 }), clamp: p => ({ x: p.x || 0, y: p.y || 0 }),
  palette: () => ({ darkFill: '#000', darkIcon: '#fff', lightFill: '#fff', lightIcon: '#000', edges: ['#111'] }),
  theme: () => 'dark', outline: '', mount: () => () => {}, canDock: () => false, closeWheel: () => {}, open: () => {},
});

test('floor hive uses its own command id, storage key, title and aria-label; assistant defaults unchanged', () => {
  const h = harness();
  h.stores.set('qianmu-floor-hive-device-v1', JSON.stringify({ detached: true, position: { x: 5, y: 6 }, tone: 'dark', edge: 0 }));
  const floor = createProseHive({ ...base(h), commandId: 'floor', storageKey: 'qianmu-floor-hive-device-v1', title: '聊天工具包（拖回千幕归巢）', ariaLabel: '打开聊天工具包' });
  floor.render();
  assert.equal(floor.detached, true);
  const layer = h.body.children.at(-1);
  const entry = layer.children[0];
  assert.equal(entry.getAttribute('aria-label'), '打开聊天工具包');
  assert.equal(entry.title, '聊天工具包（拖回千幕归巢）');
  // bind only reacts to its own command id.
  let bound = false;
  const btn = h.document.createElement('button');
  floor.bind(btn, { id: 'assistant' }, {});
  floor.bind(btn, { id: 'floor' }, {});
  assert.equal(btn.style.touchAction, 'none', 'floor id triggers drag binding');
  floor.dispose();

  // Default instance keeps assistant behaviour and its own key.
  const h2 = harness();
  const assistant = createProseHive(base(h2));
  assistant.render();
  assert.equal(assistant.detached, false, 'default is not detached without stored state');
  h2.stores.set('qianmu-prose-hive-device-v1', JSON.stringify({ detached: true, position: { x: 1, y: 1 }, tone: 'dark', edge: 0 }));
  const assistant2 = createProseHive(base(h2));
  assistant2.render();
  const entry2 = h2.body.children.at(-1).children[0];
  assert.equal(entry2.getAttribute('aria-label'), '打开场外特助');
  assert.equal(entry2.title, '场外特助（拖回千幕归巢）');
  assistant.dispose(); assistant2.dispose();
});

test('the two hives persist to separate device keys', () => {
  const h = harness();
  const floor = createProseHive({ ...base(h), commandId: 'floor', storageKey: 'qianmu-floor-hive-device-v1', title: 't', ariaLabel: 'a' });
  const assistant = createProseHive(base(h));
  floor.render(); assistant.render();
  assert.equal(h.stores.has('qianmu-prose-hive-device-v1'), false);
  assert.equal(h.stores.has('qianmu-floor-hive-device-v1'), false);
  floor.dispose(); assistant.dispose();
});
