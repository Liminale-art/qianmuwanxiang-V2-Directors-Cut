import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { mountTheme } from '../yimu/theme.mjs';

test('float bounds are measured once, reused until the window resizes, and re-measured on the next frame', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const source = entry.slice(entry.indexOf('function floatViewportBounds() {'), entry.indexOf('function clampFloatPosition() {'));
  let layoutReads = 0, barBottom = 40; const frames = [], listeners = {};
  class Element {}
  const bar = Object.assign(new Element(), { getBoundingClientRect: () => { layoutReads++; return { left: 0, right: 800, top: 0, bottom: barBottom, height: barBottom }; } });
  const window = { innerWidth: 800, innerHeight: 600, visualViewport: { get offsetLeft() { layoutReads++; return 0; }, offsetTop: 0, width: 800, height: 600, addEventListener: (type, fn) => { listeners['vv:' + type] = fn; } },
    addEventListener: (type, fn) => { listeners[type] = fn; } };
  const context = vm.createContext({ window, Element, document: { querySelectorAll: () => [bar] }, Number, Math, Set });
  context.globalThis = context; context.getComputedStyle = () => ({ display: 'block', visibility: 'visible' }); context.requestAnimationFrame = fn => { frames.push(fn); };
  vm.runInContext(source, context);
  const first = context.floatViewportBounds();
  assert.equal(first.safeTop, 44); assert.equal(first.width, 800);
  const readsAfterFirst = layoutReads;
  for (let i = 0; i < 5; i++) assert.deepEqual({ ...context.floatViewportBounds() }, { ...first });
  assert.equal(layoutReads, readsAfterFirst, 'repeat calls read no layout');
  assert.equal(frames.length, 1, 'one deferred re-measure is scheduled, not one per call');
  const copy = context.floatViewportBounds(); copy.safeTop = 999; assert.equal(context.floatViewportBounds().safeTop, 44, 'callers get a copy');
  barBottom = 60; frames.shift()(); assert.equal(context.floatViewportBounds().safeTop, 64, 'the next-frame measurement is used afterwards');
  for (const type of ['resize', 'orientationchange', 'vv:resize', 'vv:scroll']) assert.equal(typeof listeners[type], 'function', type);
  window.visualViewport.width = 400; listeners.resize(); assert.equal(context.floatViewportBounds().width, 400, 'a resize discards the remembered bounds');
});

test('忆幕 theme: observer-driven syncs wait for the next frame and coalesce; an explicit sync is immediate', () => {
  const observers = []; const frames = []; let reads = 0;
  class Observer { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} }
  const style = () => { const map = new Map(); return { getPropertyValue: name => map.get(name) || '', setProperty: (name, value) => map.set(name, value), removeProperty: name => map.delete(name) }; };
  const node = id => { const attrs = new Map(); return { id, isConnected: true, style: style(), classList: { contains: () => false }, getAttribute: name => attrs.get(name) ?? null, setAttribute: (name, value) => attrs.set(name, String(value)), removeAttribute: name => attrs.delete(name) }; };
  const sourceNode = node('story-director-modal');
  const document = { body: node('body'), getElementById: id => id === 'story-director-modal' ? sourceNode : null,
    defaultView: { MutationObserver: Observer, requestAnimationFrame: fn => { frames.push(fn); }, getComputedStyle: () => { reads++; return { getPropertyValue: name => name === '--sd-text' ? '#222' : '', fontFamily: 'serif' }; } } };
  const theme = mountTheme(node('yimu'), { document });
  const afterMount = reads; assert.ok(afterMount >= 1, 'mounting syncs at once');
  for (let i = 0; i < 4; i++) observers[0].callback([]);
  assert.equal(reads, afterMount, 'nothing is read inside the observer callback'); assert.equal(frames.length, 1);
  frames.shift()(); assert.equal(reads, afterMount + 1);
  theme.sync(); assert.equal(reads, afterMount + 2, 'explicit sync stays immediate');
  theme.destroy();
});
