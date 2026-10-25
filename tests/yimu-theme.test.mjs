import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountTheme } from '../yimu/theme.mjs';

// Isolated surface/observer fixture; this does not claim browser layout validation.
function fixture() {
    const observers = [], nodes = new Map();
    let events = 0;
    const emit = (target, type, attributeName) => {
        if (++events > 200) throw new Error('Observer feedback loop');
        for (const observer of observers) {
            const options = observer.targets.get(target);
            if (options && ((type === 'childList' && options.childList)
                || (type === 'attributes' && options.attributes && options.attributeFilter.includes(attributeName)))) {
                observer.callback([{ target, type, attributeName }]);
            }
        }
    };
    class Observer {
        constructor(callback) { this.callback = callback; this.targets = new Map(); this.disconnects = 0; observers.push(this); }
        observe(target, options) { this.targets.set(target, options); }
        disconnect() { this.targets.clear(); this.disconnects++; }
    }
    function element(id = '', values = {}) {
        const attrs = new Map(), properties = new Map();
        const node = {
            id, isConnected: true, hidden: false, children: [], scrollTop: 0,
            computed: { ...values },
            classList: { contains: value => (attrs.get('class') || '').split(/\s+/).includes(value) },
            getAttribute: name => attrs.get(name) ?? null,
            setAttribute(name, value) { attrs.set(name, String(value)); emit(node, 'attributes', name); },
            removeAttribute(name) { attrs.delete(name); emit(node, 'attributes', name); },
            style: {
                getPropertyValue: name => properties.get(name) || '',
                setProperty(name, value) { properties.set(name, value); emit(node, 'attributes', 'style'); },
                removeProperty(name) { properties.delete(name); emit(node, 'attributes', 'style'); },
            },
        };
        if (id) nodes.set(id, node);
        return node;
    }
    const body = element('body');
    const document = {
        body, getElementById: id => nodes.get(id) || null,
        defaultView: {
            MutationObserver: Observer,
            getComputedStyle: node => ({ getPropertyValue: name => node.computed[name] || '', fontFamily: node.computed.fontFamily || '' }),
        },
    };
    const root = element('yimu');
    root.ownerDocument = document;
    return { root, document, observers, element, emit,
        remove(node) { node.isConnected = false; nodes.delete(node.id); emit(body, 'childList'); },
        insert(node) { nodes.set(node.id, node); node.isConnected = true; emit(body, 'childList'); },
    };
}

test('standalone mounting has no Qianmu dependency and supports the light DOM fixture', () => {
    const empty = mountTheme({}, { document: { defaultView: { getComputedStyle: () => ({ display: 'block' }) } } });
    empty.sync(); empty.destroy();
    const f = fixture(), binding = mountTheme(f.root, { document: f.document });
    assert.equal(f.root.getAttribute('data-ym-theme'), 'classic');
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '');
    assert.equal(f.root.style.getPropertyValue('--ym-font'), '');
    binding.destroy();
});

test('a hidden Qianmu root supplies colors, mode and type sizes without rendering the panel', () => {
    const f = fixture();
    const host = f.element('story-director-modal', { '--qm-ink': '#112233', '--sd-text': '#ffffff', '--qm-bg': '#fafafa', '--qm-line': '#ddd', '--qm-type-body': '12px', '--qm-type-caption': '11px', fontFamily: 'ST serif' });
    host.hidden = true;
    host.setAttribute('data-qm-theme', 'glass'); host.setAttribute('data-qm-mode', 'dark');
    const binding = mountTheme(f.root, { document: f.document });
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '#112233');
    assert.equal(f.root.style.getPropertyValue('--ym-surface'), '#fafafa');
    assert.equal(f.root.style.getPropertyValue('--ym-type-body'), '12px');
    assert.equal(f.root.style.getPropertyValue('--ym-type-caption'), '11px');
    assert.equal(f.root.style.getPropertyValue('--ym-font'), '');
    assert.equal(f.root.getAttribute('data-ym-theme'), 'glass');
    assert.equal(f.root.getAttribute('data-ym-mode'), 'dark');
    assert.equal(host.hidden, true);
    binding.destroy();
});

test('source changes update only private tokens and retain drafts, children and scroll position', () => {
    const f = fixture();
    const host = f.element('story-director-modal', { '--qm-ink': '#abc', '--qm-glow-1': '#123', fontFamily: 'ST global' });
    host.setAttribute('data-qm-theme', 'glass');
    const input = { value: '未完成的手动修订', selectionStart: 5 };
    f.root.children = [input]; f.root.scrollTop = 133;
    const binding = mountTheme(f.root, { document: f.document });
    host.computed = { '--sd-text': '#def', '--sd-window-bg': '#123', fontFamily: 'Classic user font' };
    host.removeAttribute('data-qm-theme'); host.setAttribute('class', 'sd-theme-dark');
    assert.equal(f.root.getAttribute('data-ym-theme'), 'classic');
    assert.equal(f.root.getAttribute('data-ym-mode'), 'dark');
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '#def');
    assert.equal(f.root.style.getPropertyValue('--ym-font'), 'Classic user font');
    assert.equal(f.root.style.getPropertyValue('--ym-glow-1'), '');
    assert.equal(f.root.children[0], input); assert.equal(input.value, '未完成的手动修订');
    assert.equal(input.selectionStart, 5); assert.equal(f.root.scrollTop, 133);
    binding.destroy();
});

test('late host insertion, preferred modal and floating-root fallback are detected', () => {
    const f = fixture(), binding = mountTheme(f.root, { document: f.document });
    const floating = f.element('story-director-float', { '--sd-text': '#111' });
    f.insert(floating);
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '#111');
    const modal = f.element('story-director-modal', { '--qm-ink': '#222' });
    modal.setAttribute('data-qm-theme', 'editorial'); f.insert(modal);
    assert.equal(f.root.getAttribute('data-ym-theme'), 'editorial');
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '#222');
    f.remove(modal);
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '#111');
    f.remove(floating);
    assert.equal(f.root.getAttribute('data-ym-theme'), 'classic');
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '');
    binding.destroy();
});

test('observers are narrow and never watch their own output or chat subtree', () => {
    const f = fixture(), host = f.element('story-director-modal', { '--sd-text': '#123' });
    const binding = mountTheme(f.root, { document: f.document });
    assert.equal(f.observers.length, 2);
    const sourceOptions = f.observers[0].targets.get(host);
    assert.deepEqual(sourceOptions, { attributes: true, attributeFilter: ['class', 'style', 'data-qm-theme', 'data-qm-mode'] });
    assert.deepEqual(f.observers[1].targets.get(f.document.body), { childList: true });
    assert.equal(f.observers.some(observer => observer.targets.has(f.root)), false);
    for (let i = 0; i < 3; i++) { binding.sync(); host.setAttribute('style', `test-${i}`); }
    binding.destroy();
    assert.ok(f.observers.every(observer => observer.targets.size === 0));
});

test('destroy restores owned values, preserves later external changes and stays disposed', () => {
    const f = fixture(); f.root.style.setProperty('--ym-ink', '#original');
    f.root.setAttribute('data-ym-theme', 'prior');
    const host = f.element('story-director-modal', { '--sd-text': '#123', '--sd-accent': '#456' });
    const binding = mountTheme(f.root, { document: f.document });
    f.root.style.setProperty('--ym-accent', '#external');
    binding.destroy(); binding.destroy(); binding.sync();
    host.computed['--sd-text'] = '#changed';
    for (const observer of f.observers) observer.callback([]);
    assert.equal(f.root.style.getPropertyValue('--ym-ink'), '#original');
    assert.equal(f.root.style.getPropertyValue('--ym-accent'), '#external');
    assert.equal(f.root.getAttribute('data-ym-theme'), 'prior');
    assert.equal(f.root.getAttribute('data-ym-mode'), null);
});

test('surface CSS remains scoped, preserves hidden pages and supports three families and narrow layouts', async () => {
    const css = await readFile(new URL('../yimu/style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /(?:^|\n)\s*(?:body|html|:root|input|button|textarea|select)\b/);
    assert.doesNotMatch(css, /@import|https?:\/\//);
    assert.match(css, /\.ym-dialog:not\(\[open\]\), \.ym-dialog \[hidden\]\s*\{\s*display: none !important/);
    assert.match(css, /data-ym-theme="editorial"[^\n]*KingHwaOldSong/);
    assert.match(css, /data-ym-theme="glass"[^\n]*Sarasa Gothic SC/);
    assert.match(css, /\.ym-scroll[^\n]*min-width: 0/);
    assert.match(css, /\.ym-dialog input\.ym-switch[^\n]*appearance: none !important/);
    assert.match(css, /@media \(max-width: 340px\)/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /data-ym-state="ready"/); assert.match(css, /data-ym-state="failed"/);
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});
