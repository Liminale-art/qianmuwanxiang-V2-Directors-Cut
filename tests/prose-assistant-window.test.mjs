import test from 'node:test';
import assert from 'node:assert/strict';
import { bindProseAssistantWindow } from '../qianmu-prose-assistant-window.js';

class Node extends EventTarget {
    constructor() { super(); this.style = { setProperty: (name, value) => { this.style[name] = value; }, removeProperty: name => { delete this.style[name]; } }; this.ownerDocument = null; this.closest = () => null; this.setPointerCapture = () => {}; this.releasePointerCapture = () => {}; }
    fire(type, values = {}) { const event = new Event(type, { cancelable: true }); Object.assign(event, values); this.dispatchEvent(event); return event; }
}

function fixture() {
    const viewport = new Node();
    const store = new Map([['qianmu.notes.window.v1', JSON.stringify({ x: 120, y: 80, width: 410, height: 310 })]]);
    const view = new Node();
    Object.assign(view, { innerWidth: 1200, innerHeight: 800, visualViewport: Object.assign(viewport, { offsetLeft: 0, offsetTop: 0, width: 1200, height: 800 }),
        localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } });
    const document = { defaultView: view };
    const panel = new Node(), header = new Node(), resize = new Node(), notesResize = new Node();
    panel.ownerDocument = document; panel.querySelector = selector => selector === '[data-pa-resize]' ? resize : selector === '[data-notes-resize]' ? notesResize : null;
    panel.getBoundingClientRect = () => ({ left: 120, top: 80, width: 410, height: 310 });
    return { view, panel, header, resize, notesResize, store };
}

test('shared pointer geometry keeps a resized note movable without snapping back', () => {
    const f = fixture();
    const dispose = bindProseAssistantWindow(f.panel, { handle: f.header, storageKey: 'qianmu.notes.window.v1', initial: { width: 600, height: 420 } });
    assert.equal(f.panel.style.width, '600px', 'current note size wins over an older window cache');
    assert.equal(f.panel.style.height, '420px');

    f.resize.fire('pointerdown', { pointerId: 1, clientX: 600, clientY: 420, button: 0, isPrimary: true });
    f.view.fire('pointermove', { pointerId: 1, clientX: 700, clientY: 500 });
    f.view.fire('pointerup', { pointerId: 1, clientX: 700, clientY: 500 });
    assert.equal(f.panel.style.width, '700px');
    assert.equal(f.panel.style.height, '500px');

    f.header.fire('pointerdown', { pointerId: 1, clientX: 120, clientY: 80, button: 0, isPrimary: true });
    f.view.fire('pointermove', { pointerId: 1, clientX: 150, clientY: 110 });
    f.view.fire('pointerup', { pointerId: 1, clientX: 150, clientY: 110 });

    assert.equal(f.panel.style.width, '700px');
    assert.equal(f.panel.style.height, '500px');
    assert.equal(f.panel.style.left, '150px');
    assert.equal(f.panel.style.top, '110px');
    assert.equal(JSON.parse(f.store.get('qianmu.notes.window.v1')).width, 700);
    dispose();
});

test('a lost pointer capture cancels an in-flight move instead of committing a partial geometry', () => {
    const f = fixture();
    const dispose = bindProseAssistantWindow(f.panel, { handle: f.header, storageKey: 'qianmu.notes.window.v1' });
    f.header.fire('pointerdown', { pointerId: 3, clientX: 120, clientY: 80, button: 0, isPrimary: true });
    f.view.fire('pointermove', { pointerId: 3, clientX: 190, clientY: 160 });
    f.header.fire('lostpointercapture', { pointerId: 3 });
    assert.equal(f.panel.style.left, '120px');
    assert.equal(f.panel.style.top, '80px');
    assert.equal(JSON.parse(f.store.get('qianmu.notes.window.v1')).x, 120);
    dispose();
});

test('the shared geometry controller accepts feature-specific resize handles', () => {
    const f = fixture();
    const dispose = bindProseAssistantWindow(f.panel, {
        handle: f.header,
        resizeSelector: '[data-notes-resize]',
        storageKey: 'qianmu.notes.window.v1',
        initial: { width: 600, height: 420 },
    });
    f.notesResize.fire('pointerdown', { pointerId: 2, clientX: 600, clientY: 420, button: 0, isPrimary: true });
    f.view.fire('pointermove', { pointerId: 2, clientX: 660, clientY: 470 });
    f.view.fire('pointerup', { pointerId: 2, clientX: 660, clientY: 470 });
    assert.equal(f.panel.style.width, '660px');
    assert.equal(f.panel.style.height, '470px');
    dispose();
});
