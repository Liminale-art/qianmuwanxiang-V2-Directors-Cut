import test from 'node:test';
import assert from 'node:assert/strict';
import { mountQianmuInputBoundary } from '../qianmu-input-boundary.js';

function rootFixture() {
    const listeners = new Map();
    const root = { nodeType: 1, tagName: 'DIV', addEventListener(type, fn, capture) {
        assert.equal(capture, undefined); const group = listeners.get(type) || new Set(); group.add(fn); listeners.set(type, group);
    }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
    function dispatch(type, target = root, options = {}) {
        const event = { target, type, stopped: 0, defaultPrevented: false, ...options,
            stopPropagation() { this.stopped++; }, preventDefault() { assert.fail('native editing default must remain available'); }, stopImmediatePropagation() { assert.fail('own root listeners must remain available'); } };
        for (const handler of listeners.get(type) || []) handler(event);
        return event;
    }
    return { root, dispatch, listeners };
}

test('every keyboard event stays owned, including buttons, composition and modifier combinations', () => {
    const f = rootFixture(), off = mountQianmuInputBoundary(f.root);
    for (const type of ['keydown', 'keyup', 'keypress']) {
        for (const tagName of ['TEXTAREA', 'INPUT', 'BUTTON', 'DIV']) {
            assert.equal(f.dispatch(type, { tagName, nodeType: 1, parentNode: f.root }, { key: 'Enter', ctrlKey: true, isComposing: true }).stopped, 1);
        }
    }
    off(); assert.equal(f.dispatch('keydown').stopped, 0);
});

test('editor bubbling is isolated without cancelling Chinese IME, clipboard, selection or focus defaults', () => {
    const f = rootFixture(), off = mountQianmuInputBoundary(f.root);
    const editable = { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentNode: f.root };
    const text = { nodeType: 3, parentNode: editable };
    for (const type of ['beforeinput', 'input', 'change', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut', 'focusin', 'focusout', 'pointerdown', 'mousedown', 'touchstart', 'click']) {
        const event = f.dispatch(type, text, { data: '中文测试', isComposing: type.startsWith('composition') });
        assert.equal(event.stopped, 1, type); assert.equal(event.defaultPrevented, false);
        assert.equal(f.dispatch(type, { nodeType: 1, tagName: 'BUTTON', parentNode: f.root }).stopped, 0, `${type} ordinary controls`);
    }
    off();
});

test('composed paths find retargeted editors but never count editors outside the owned root', () => {
    const f = rootFixture(), off = mountQianmuInputBoundary(f.root), editor = { nodeType: 1, tagName: 'INPUT' };
    assert.equal(f.dispatch('input', f.root, { composedPath: () => [editor, f.root] }).stopped, 1);
    assert.equal(f.dispatch('input', f.root, { composedPath: () => [f.root, editor] }).stopped, 0);
    off();
});

test('mount and cleanup are idempotent, no duplicate listeners, same-root handlers still run', () => {
    const f = rootFixture(), off = mountQianmuInputBoundary(f.root);
    assert.equal(mountQianmuInputBoundary(f.root), off);
    assert.equal(f.listeners.get('keydown').size, 1);
    let own = 0; f.root.addEventListener('keydown', () => own++);
    assert.equal(f.dispatch('keydown').stopped, 1); assert.equal(own, 1);
    off(); off(); assert.equal(f.dispatch('keydown').stopped, 0); assert.equal(own, 2);
    const next = mountQianmuInputBoundary(f.root); assert.notEqual(next, off);
    assert.equal(f.dispatch('keydown').stopped, 1); next();
    assert.doesNotThrow(() => mountQianmuInputBoundary(null)());
});
