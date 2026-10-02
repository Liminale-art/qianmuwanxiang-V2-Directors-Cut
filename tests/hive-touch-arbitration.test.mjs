import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
function actual(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.slice(start + 1).search(/^function /m);
  return source.slice(start, start + 1 + end);
}

// The real pointer listener runs against a deterministic clock and geometry.
// No ST DOM, user notes, network, localStorage or settings writes are involved.
function fixture({ scale = 1, enabled = true, hidden = false } = {}) {
  let now = 0, timerId = 0;
  const timers = new Map();
  const state = { opened: 0, closed: 0, modal: 0, saves: 0, wheel: false, reveal: 0, conceal: 0 };
  class Element {
    constructor() {
      this.listeners = new Map(); this.dataset = {}; this.isConnected = true;
      this.position = { x: hidden ? -20 : 100, y: 200 }; this.classes = new Set(); this.capture = null;
      this.classList = { contains: key => this.classes.has(key), add: key => this.classes.add(key), remove: key => this.classes.delete(key) };
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setPointerCapture(id) { this.capture = id; }
    releasePointerCapture(id) {
      if (this.capture !== id) return;
      this.capture = null;
      // A synchronous capture-loss callback must not double-save or reopen.
      this.emit('lostpointercapture', { pointerId: id });
    }
    getBoundingClientRect() { return { left: this.position.x, top: this.position.y, width: 42, height: 48 }; }
    emit(type, extras = {}) {
      const event = { pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true, clientX: 110, clientY: 210,
        prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extras };
      this.listeners.get(type)?.(event); return event;
    }
  }
  const btn = new Element();
  const settings = { quickWheelEnabled: enabled, floatPosition: { ...btn.position } };
  const context = vm.createContext({
    Element, settings, QUICK_WHEEL_ID: 'wheel', FLOAT_ID: 'float', floatRevealOutsideHandler: null,
    window: { visualViewport: { scale } },
    document: { getElementById: () => state.wheel ? {} : null, addEventListener() {}, removeEventListener() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clampFloatPosition: () => settings.floatPosition,
    applyFloatPosition: () => { btn.position = { ...settings.floatPosition }; },
    clearFloatRevealTimer() {},
    openQuickWheelFromLongPress() {
      state.wheel = true; state.opened++;
      if (hidden) { btn.position.x = 0; btn.classList.add('sd-float-revealed'); }
    },
    closeQuickWheel() { state.wheel = false; state.closed++; },
    revealFloatButton() { state.reveal++; return false; }, concealFloatButton() { state.conceal++; },
    saveSettings: () => state.saves++, openModal: () => state.modal++,
  });
  vm.runInContext(actual('bindFloatDrag'), context);
  context.bindFloatDrag(btn);
  function tick(ms) {
    const until = now + ms;
    while (true) {
      const pending = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      now = pending[1].at; timers.delete(pending[0]); pending[1].fn();
    }
    now = until;
  }
  return { btn, state, settings, tick };
}

test('short press still opens the panel; desktop hover and leave remain unchanged', () => {
  const f = fixture(); f.btn.emit('pointerdown'); f.tick(80); f.btn.emit('pointerup'); f.btn.emit('click');
  assert.equal(f.state.modal, 1); assert.equal(f.state.saves, 0); f.tick(500); assert.equal(f.state.opened, 0);
  f.btn.emit('pointerenter', { pointerType: 'touch' }); assert.equal(f.state.reveal, 1, 'only the click attempts a reveal');
  f.btn.emit('pointerenter', { pointerType: 'mouse' }); f.btn.emit('pointerleave', { pointerType: 'mouse' });
  assert.equal(f.state.reveal, 2); assert.equal(f.state.conceal, 2);
});

test('touch movement chooses drag before the timer, follows the finger and suppresses its tail click', () => {
  const f = fixture(); f.btn.emit('pointerdown'); f.btn.emit('pointermove', { clientX: 118 }); f.tick(1000);
  assert.equal(f.state.opened, 0); assert.equal(f.btn.position.x, 108);
  f.btn.emit('pointermove', { clientX: 110 }); assert.equal(f.btn.position.x, 100, 'returning inside slop never changes a chosen drag into a hold');
  f.btn.emit('pointerup'); const click = f.btn.emit('click');
  assert.equal(click.prevented, true); assert.equal(f.state.modal, 0); assert.equal(f.state.saves, 1);
  assert.equal(f.btn.capture, null); assert.equal(f.btn.dataset.activePointer, undefined);
});

test('stationary hold accepts natural jitter without moving or closing the hive', () => {
  const f = fixture(); f.btn.emit('pointerdown'); f.btn.emit('pointermove', { clientX: 114, clientY: 213 }); f.tick(300);
  assert.equal(f.state.opened, 1); f.btn.emit('pointermove', { clientX: 116 });
  assert.equal(f.state.closed, 0); assert.equal(f.btn.position.x, 100);
  f.btn.emit('pointerup'); f.btn.emit('click'); assert.equal(f.state.wheel, true); assert.equal(f.state.modal, 0);
});

test('continuing a hold into movement closes the hive and drags in that same gesture', () => {
  const f = fixture(); f.btn.emit('pointerdown'); f.btn.emit('pointermove', { clientX: 116 }); f.tick(300);
  assert.equal(f.state.wheel, true);
  f.btn.emit('pointermove', { clientX: 120 }); assert.equal(f.state.closed, 1); assert.equal(f.btn.position.x, 104);
  f.btn.emit('pointermove', { clientX: 160 }); assert.equal(f.btn.position.x, 144); f.tick(500);
  f.btn.emit('pointerup'); f.btn.emit('click');
  assert.equal(f.state.opened, 1); assert.equal(f.state.modal, 0); assert.equal(f.state.saves, 1);
});

test('a revealed half-hidden hive continues from its actual visible edge without snapping back', () => {
  const f = fixture({ hidden: true }); f.btn.emit('pointerdown'); f.tick(300);
  assert.equal(f.btn.position.x, 0); f.btn.emit('pointermove', { clientX: 120 });
  assert.equal(f.btn.position.x, 10); assert.equal(f.btn.classList.contains('sd-float-revealed'), false);
  f.btn.emit('pointerup'); assert.equal(f.settings.floatPosition.x, 10);
});

test('cancel and capture loss clear pending holds or open hives and permit the next gesture', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) for (const phase of ['pending', 'open', 'drag']) {
    const f = fixture(); f.btn.emit('pointerdown');
    if (phase === 'open') f.tick(300);
    if (phase === 'drag') f.btn.emit('pointermove', { clientX: 150 });
    f.btn.emit(ending); f.tick(500);
    assert.equal(f.state.wheel, false, `${ending}/${phase}`);
    assert.equal(f.btn.capture, null); assert.equal(f.btn.classList.contains('sd-float-dragging'), false);
    assert.equal(f.state.saves, phase === 'drag' ? 1 : 0, 'capture loss reentry must not persist twice');
    f.btn.emit('pointerdown'); f.tick(300); assert.equal(f.state.wheel, true, 'cancel does not leave an active pointer behind');
  }
});

test('secondary buttons and other fingers cannot steal, move or finish the active gesture', () => {
  const f = fixture(); f.btn.emit('pointerdown', { isPrimary: false }); f.tick(300); assert.equal(f.state.opened, 0);
  f.btn.emit('pointerdown', { button: 2 }); f.tick(300); assert.equal(f.state.opened, 0);
  f.btn.emit('pointerdown'); f.btn.emit('pointerdown', { pointerId: 2, isPrimary: false });
  f.btn.emit('pointermove', { pointerId: 2, clientX: 300 }); f.btn.emit('pointerup', { pointerId: 2 });
  assert.equal(f.btn.position.x, 100); assert.equal(f.btn.capture, 1); f.tick(300); assert.equal(f.state.opened, 1);
  f.btn.emit('pointercancel'); assert.equal(f.state.wheel, false);
});

test('movement tolerance uses visible pixels during viewport zoom; disabling hive preserves dragging', () => {
  const f = fixture({ scale: 2 }); f.btn.emit('pointerdown'); f.btn.emit('pointermove', { clientX: 114 });
  assert.equal(f.btn.position.x, 104); f.tick(300); assert.equal(f.state.opened, 0);
  const disabled = fixture({ enabled: false }); disabled.btn.emit('pointerdown'); disabled.tick(500);
  assert.equal(disabled.state.opened, 0); disabled.btn.emit('pointermove', { clientX: 150 });
  assert.equal(disabled.btn.position.x, 140);
  const removed = fixture(); removed.btn.emit('pointerdown'); removed.btn.isConnected = false; removed.tick(500);
  assert.equal(removed.state.opened, 0, 'a removed entrance cannot open a ghost hive');
});

test('desktop drag uses its existing small tolerance and a second tap closes an open hive', () => {
  const f = fixture(); f.btn.emit('pointerdown', { pointerType: 'mouse' }); f.btn.emit('pointermove', { pointerType: 'mouse', clientX: 115 });
  assert.equal(f.btn.position.x, 105); f.btn.emit('pointerup'); f.tick(150);
  f.btn.emit('pointerdown'); f.tick(300); f.btn.emit('pointerup'); f.tick(200);
  f.btn.emit('pointerdown'); f.btn.emit('pointerup'); f.btn.emit('click');
  assert.equal(f.state.wheel, false); assert.equal(f.state.modal, 0);
});

test('detached note geometry reaches each visible edge without the old 8px gap or clipping', () => {
  for (const size of [32, 48, 80]) for (const viewport of [undefined, { offsetLeft: 73, offsetTop: 119, width: 190, height: 370, scale: 2 }]) {
    const context = vm.createContext({ window: { visualViewport: viewport, innerWidth: 393, innerHeight: 850 }, getFloatSize: () => size, QUICK_HEX_WIDTH_RATIO: Math.sqrt(3) / 2 });
    vm.runInContext(actual('detachedNotesGeometry') + actual('clampDetachedNotesEntry'), context);
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || 393, height = viewport?.height || 850;
    const first = context.clampDetachedNotesEntry({ x: -9999, y: -9999 });
    assert.equal(first.x, left); assert.equal(first.y, top);
    const last = context.clampDetachedNotesEntry({ x: 9999, y: 9999 });
    assert.equal(last.x + size * Math.sqrt(3) / 2, left + width); assert.equal(last.y + size, top + height);
    const restored = context.clampDetachedNotesEntry({ x: last.x, y: last.y }); assert.equal(restored.x, last.x); assert.equal(restored.y, last.y);
    const fallback = context.clampDetachedNotesEntry({ x: NaN, y: Infinity }); assert.ok(Number.isFinite(fallback.x) && Number.isFinite(fallback.y));
  }
  assert.match(css, /\.sd-detached-notes-entry\.is-dragging\s*\{\s*transform:\s*none;/, 'dragging must not shrink the whole hexagon away from the edge');
});
