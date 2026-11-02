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
    const panel = new Node(), header = new Node(), resize = new Node();
    panel.ownerDocument = document; panel.querySelector = selector => selector === '[data-pa-resize]' ? resize : null;
    let rect = { left: 120, top: 80, width: 410, height: 310 };
    panel.getBoundingClientRect = () => ({ ...rect });
    const setRect = next => { rect = { ...rect, ...next }; };
    return { view, panel, header, resize, store, setRect };
}

test('window drag adopts a native resize before moving and keeps the resized dimensions', () => {
    const f = fixture();
    const dispose = bindProseAssistantWindow(f.panel, { handle: f.header, storageKey: 'qianmu.notes.window.v1', initial: { width: 600, height: 420 } });
    assert.equal(f.panel.style.width, '600px', 'current note size wins over an older window cache');
    assert.equal(f.panel.style.height, '420px');

    f.setRect({ width: 700, height: 500 });
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
