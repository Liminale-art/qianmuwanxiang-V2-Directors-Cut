// C-17 千幕万象 V2 feedback batch 1.59.505
// Tests for all C-17 feedback items across features
// Some items (chat regex) are covered in tests/chat-regex-c17.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createChatRecovery } = await import('../features/chat/qianmu-chat-recovery.js');
const { mountChatRecoveryView } = await import('../features/chat/qianmu-chat-recovery-view.js');

// Test file marker for C-17 feedback items
// s7: Recovery backup role list fixed height for ≥8 rows, click-outside close

function fakeDom() {
    const make = tag => {
        const node = {
            tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '', disabled: false, hidden: false, value: '', type: '', placeholder: '', scrollTop: 0,
            classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }, toggle(c, force) { force === undefined ? (this.set.has(c) ? this.set.delete(c) : this.set.add(c)) : (force ? this.set.add(c) : this.set.delete(c)); } },
            style: { setProperty() {}, removeProperty() {} },
            append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; },
            setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(type, fn, opts) { this.listeners[type] = fn; }, removeEventListener(type, fn, opts) { delete this.listeners[type]; },
            contains(other) { return walkAll(this).includes(other); }, closest() { return null; }, getBoundingClientRect() { return { height: 400 }; }, focus() {}, scrollIntoView() {}, remove() {}, click() { this.listeners.click?.({ target: this }); }
        };
        Object.defineProperty(node, 'className', { get() { return [...node.classList.set].join(' '); }, set(v) { node.classList.set = new Set(String(v).split(' ').filter(Boolean)); } });
        return node;
    };
    const host = make('div');
    const documentListeners = { click: [] };
    host.ownerDocument = {
        createElement: make, createTextNode: t => ({ text: t }),
        defaultView: { addEventListener() {}, removeEventListener() {}, getComputedStyle: node => ({ maxHeight: node.classList.contains('has-many') ? '440px' : 'min(60vh, 420px)' }) },
        body: make('body'),
        addEventListener(type, fn, opts) { if (opts?.capture && type === 'click') documentListeners.click.push(fn); },
        removeEventListener(type, fn, opts) { if (opts?.capture && type === 'click') documentListeners.click = documentListeners.click.filter(l => l !== fn); },
        simulateClickOutside(target) { documentListeners.click.forEach(fn => fn({ target })); }
    };
    return host;
}

const walkAll = (node, out = []) => { out.push(node); (node.children || []).forEach(k => walkAll(k, out)); return out; };

function fakeRecoveryController(characters = []) {
    let snapshot = { phase: 'ready', characters, backups: [], nativeBackupPolicy: { availability: 'known', value: 50 } };
    return {
        snapshot: () => snapshot,
        load: async () => snapshot,
        applyBinding: () => {},
        actions: {}
    };
}

test('C-17 s7: Recovery role picker has fixed height when ≥8 characters available', () => {
    const characters = Array.from({ length: 10 }, (_, i) => ({ avatar: `char${i}.png`, name: `角色${i}` }));
    const controller = fakeRecoveryController(characters);
    const host = fakeDom();
    const view = mountChatRecoveryView({ root: host, controller, getCharacters: () => characters, confirm: () => false });

    view.render();

    const picker = walkAll(host).find(n => n.classList?.contains('qm-recovery-role-picker'));
    assert.ok(picker, 'picker must exist');

    // Open the picker
    const characterIcon = walkAll(host).find(n => n.classList?.contains('qm-recovery-icon-button') && n.listeners.click);
    assert.ok(characterIcon, 'character icon must exist');
    characterIcon.click();

    assert.strictEqual(picker.hidden, false, 'picker must be visible when opened');
    assert.ok(picker.classList.contains('has-many'), 'picker must have has-many class when ≥8 rows');

    const style = host.ownerDocument.defaultView.getComputedStyle(picker);
    assert.strictEqual(style.maxHeight, '440px', 'picker must have fixed max-height of 440px');

    view.dispose();
});

test('C-17 s7: Recovery role picker closes on click outside', () => {
    const characters = Array.from({ length: 5 }, (_, i) => ({ avatar: `char${i}.png`, name: `角色${i}` }));
    const controller = fakeRecoveryController(characters);
    const host = fakeDom();
    const view = mountChatRecoveryView({ root: host, controller, getCharacters: () => characters, confirm: () => false });

    view.render();

    const picker = walkAll(host).find(n => n.classList?.contains('qm-recovery-role-picker'));
    const characterControl = walkAll(host).find(n => n.classList?.contains('qm-recovery-character-control'));
    const characterIcon = walkAll(host).find(n => n.classList?.contains('qm-recovery-icon-button') && n.listeners.click);

    // Open the picker
    characterIcon.click();
    assert.strictEqual(picker.hidden, false, 'picker must be visible');

    // Click outside
    host.ownerDocument.simulateClickOutside(host.ownerDocument.body);
    view.render();
    assert.strictEqual(picker.hidden, true, 'picker must close on click outside');

    // Open again
    characterIcon.click();
    assert.strictEqual(picker.hidden, false, 'picker must open again');

    // Click inside picker - should not close
    host.ownerDocument.simulateClickOutside(picker);
    view.render();
    assert.strictEqual(picker.hidden, false, 'picker must stay open when clicking inside picker');

    // Click on control - should not trigger outside click
    host.ownerDocument.simulateClickOutside(characterControl);
    view.render();
    assert.strictEqual(picker.hidden, false, 'picker must stay open when clicking inside characterControl');

    view.dispose();
});

test('C-17 s7: Recovery role picker does not have fixed height when <8 characters', () => {
    const characters = Array.from({ length: 5 }, (_, i) => ({ avatar: `char${i}.png`, name: `角色${i}` }));
    const controller = fakeRecoveryController(characters);
    const host = fakeDom();
    const view = mountChatRecoveryView({ root: host, controller, getCharacters: () => characters, confirm: () => false });

    view.render();

    const picker = walkAll(host).find(n => n.classList?.contains('qm-recovery-role-picker'));
    const characterIcon = walkAll(host).find(n => n.classList?.contains('qm-recovery-icon-button') && n.listeners.click);

    characterIcon.click();

    assert.strictEqual(picker.hidden, false, 'picker must be visible');
    assert.strictEqual(picker.classList.contains('has-many'), false, 'picker must not have has-many class when <8 rows');

    view.dispose();
});

// s8, s9: TBD in future commits

