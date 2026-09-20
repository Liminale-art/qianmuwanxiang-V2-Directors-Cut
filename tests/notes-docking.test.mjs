import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

// Run the actual entry geometry, surface isolation and pointer handlers without
// mounting ST, reading user notes or making persistence/network requests.
function fixture(size = 48) {
  class Element {
    constructor(left = 100, top = 100, width = size, height = size) {
      this.style = { left: `${left}px`, top: `${top}px`, display: 'block', visibility: 'visible' };
      this.width = width; this.height = height; this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        contains: name => this.classes.has(name),
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      };
    }
    getBoundingClientRect() {
      const left = Number.parseFloat(this.style.left), top = Number.parseFloat(this.style.top);
      return { left, top, width: this.width, height: this.height, right: left + this.width, bottom: top + this.height };
    }
    closest() { return null; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    setPointerCapture() {}
    releasePointerCapture() {}
    emit(name, coordinates = {}) {
      this.listeners.get(name)?.({ pointerId: 1, button: 0, clientX: 100, clientY: 100, stopPropagation() {}, preventDefault() {}, ...coordinates });
    }
  }
  const logo = new Element(), entry = new Element(), modal = new Element();
  const state = { noteSettings: { detached: true }, surfaces: [], saved: 0, rendered: 0 };
  const context = vm.createContext({
    Element, FLOAT_ID: 'logo', MODAL_ID: 'modal', NOTES_PANEL_LAYER_ID: 'notes', notesPanelOpen: false,
    document: { getElementById: id => id === 'logo' ? logo : id === 'modal' ? modal : null, querySelectorAll: () => state.surfaces },
    getComputedStyle: node => node.style, clampDetachedNotesEntry: value => value,
    notesFeatureSettings: () => state.noteSettings, persistNotesDevice: () => state.saved++,
    renderFloatingNotes: () => state.rendered++, toast() {}, openNotesPanel() {}, setTimeout() {},
  });
  vm.runInContext(['qianmuDockingSurfaceBusy', 'detachedNoteCanReturnHome', 'bindFloatingNoteEvents'].map(storyboardFunctionSource).join('\n'), context);
  context.bindFloatingNoteEvents({ querySelector: () => entry });
  return { context, state, logo, entry, modal, Element, canDock: () => context.detachedNoteCanReturnHome(entry) };
}

test('hive return allows a bounded finger-placement margin at small, standard and large sizes', () => {
  for (const [size, near, outside] of [[32, 5, 7], [48, 8, 10], [96, 11, 13]]) {
    const f = fixture(size);
    for (const sign of [-1, 1]) {
      f.entry.style.left = `${100 + sign * near}px`; f.entry.style.top = `${100 + sign * near}px`;
      assert.equal(f.canDock(), true, `${size}px: small two-axis inaccuracy remains a deliberate logo drop`);
      f.entry.style.left = `${100 + sign * outside}px`; f.entry.style.top = '100px';
      assert.equal(f.canDock(), false, `${size}px: tolerance must not grow beyond the capped edge zone`);
    }
    f.entry.style.left = `${100 + size * .6}px`;
    assert.equal(f.canDock(), false, `${size}px: passing beside a partially overlapped logo must not absorb the entry`);
  }
});

test('the enlarged return margin never bypasses an open Qianmu, notes or ST panel', () => {
  const f = fixture(); f.entry.style.left = '106px';
  assert.equal(f.canDock(), true);
  f.modal.classList.add('open'); assert.equal(f.canDock(), false);
  f.modal.classList.remove('open'); f.context.notesPanelOpen = true; assert.equal(f.canDock(), false);
  f.context.notesPanelOpen = false;
  const stPanel = new f.Element(0, 0, 300, 400); f.state.surfaces = [stPanel];
  assert.equal(f.canDock(), false, 'a visible host panel remains usable without accidental entry collection');
  stPanel.style.display = 'none'; assert.equal(f.canDock(), true, 'an actually hidden host panel does not block return');
});

test('return commits only on a moved, non-cancelled release and rechecks the active panel', () => {
  for (const mode of ['tap', 'cancel', 'panel-opened', 'drop']) {
    const f = fixture();
    f.entry.emit('pointerdown');
    if (mode !== 'tap') f.entry.emit('pointermove', { clientX: 107, clientY: 107 });
    assert.equal(f.state.noteSettings.detached, true, 'hovering the acceptance zone never commits return');
    if (mode === 'panel-opened') f.modal.classList.add('open');
    f.entry.emit(mode === 'cancel' ? 'pointercancel' : 'pointerup', { clientX: 107, clientY: 107 });
    assert.equal(f.state.noteSettings.detached, mode !== 'drop', mode);
    assert.equal(f.state.rendered, mode === 'drop' ? 1 : 0, mode);
    assert.equal(f.entry.classList.contains('is-return-ready'), false, 'every release clears the hover affordance');
  }
});
