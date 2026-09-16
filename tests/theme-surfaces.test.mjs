import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createQianmuThemeSnapshot, createQianmuThemeSurfaceController } from '../qianmu-theme-surfaces.js';

function element() {
    const styles = new Map(), attrs = new Map(); let writes = 0;
    return { nodeType: 1, ownerDocument: {}, styles, attrs, children: [{ text: 'draft' }],
        className: 'sd-theme-dream open', scrollTop: 120,
        get writes() { return writes; },
        getAttribute: name => attrs.get(name) ?? null,
        setAttribute(name, value) { writes++; attrs.set(name, value); },
        removeAttribute(name) { writes++; attrs.delete(name); },
        style: {
            getPropertyValue: name => styles.get(name)?.value || '',
            getPropertyPriority: name => styles.get(name)?.priority || '',
            setProperty(name, value, priority = '') { writes++; styles.set(name, { value, priority }); },
            removeProperty(name) { writes++; styles.delete(name); },
        },
    };
}

test('immutable snapshots map existing roles without losing opaque palette contrast', () => {
    for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
        const value = createQianmuThemeSnapshot({ theme, mode, accent: '#05f' });
        assert.equal(value.accent, '#0055ff');
        assert.equal(value.tokens['--sd-text'], value.css['--qm-ink']);
        assert.equal(value.tokens['--sd-primary-text'], value.css['--qm-on-accent']);
        assert.equal(value.tokens['--sd-danger'], value.css['--qm-danger']);
        assert.notEqual(value.tokens['--sd-danger'], value.tokens['--sd-accent']);
        assert.ok(value.contrast.text >= 4.5 && value.contrast.muted >= 4.5 && value.contrast.action >= 4.5);
        assert.ok(Object.isFrozen(value) && Object.isFrozen(value.tokens));
        assert.ok(Object.isFrozen(value.hive.light) && Object.isFrozen(value.hive.dark.edges));
        assert.throws(() => { value.tokens['--sd-text'] = 'red'; }, TypeError);
    }
});

test('registered surfaces update together; no panel is needed to mount a late portal', () => {
    const controller = createQianmuThemeSurfaceController(), a = element(), b = element();
    const child = a.children[0]; controller.register(a);
    assert.equal(a.writes, 0, 'registration is inert in classic mode');
    const snapshot = controller.setTheme({ theme: 'glass', mode: 'dark' });
    controller.register(b);
    for (const root of [a, b]) {
        assert.equal(root.getAttribute('data-qm-theme'), 'glass');
        assert.equal(root.style.getPropertyValue('--sd-text'), snapshot.tokens['--sd-text']);
    }
    assert.equal(a.children[0], child); assert.equal(a.scrollTop, 120); assert.equal(a.className, 'sd-theme-dream open');
    assert.equal(controller.size, 2);
});

test('classic reset restores exact original values and priorities, including attributes', () => {
    const root = element(), controller = createQianmuThemeSurfaceController();
    root.style.setProperty('--sd-text', '#123456', 'important'); root.style.setProperty('left', '31px');
    root.setAttribute('data-qm-mode', 'host-value'); controller.register(root);
    controller.setTheme({ theme: 'glass' }); controller.setTheme({ theme: 'editorial', mode: 'dark' });
    controller.setTheme(null);
    assert.deepEqual(root.styles.get('--sd-text'), { value: '#123456', priority: 'important' });
    assert.equal(root.style.getPropertyValue('left'), '31px'); assert.equal(root.getAttribute('data-qm-mode'), 'host-value');
    assert.equal(root.getAttribute('data-qm-theme'), null); assert.equal(root.styles.size, 2);
    controller.setTheme({ mode: 'light' }); assert.equal(root.getAttribute('data-qm-mode'), 'light');
});

test('hive entries preserve requested tone/index and restore inline background locks', () => {
    const controller = createQianmuThemeSurfaceController(), root = element();
    root.style.setProperty('background-color', 'red', 'important'); root.style.setProperty('top', '140px');
    root.style.setProperty('background-image', 'linear-gradient(red, blue)');
    const off = controller.register(root, { role: 'hive-entry', tone: 'light', edgeIndex: 4 });
    const snapshot = controller.setTheme({ theme: 'glass', mode: 'dark' });
    assert.equal(root.style.getPropertyValue('--sd-wheel-edge'), snapshot.hive.light.edges[1]);
    assert.equal(root.style.getPropertyValue('--sd-wheel-icon'), snapshot.hive.light.icon);
    assert.equal(root.style.getPropertyPriority('--sd-wheel-icon'), 'important');
    assert.equal(root.style.getPropertyValue('background-color'), snapshot.hive.light.fill);
    assert.equal(root.style.getPropertyValue('background-image'), 'linear-gradient(red, blue)');
    off(); off(); assert.equal(controller.size, 0);
    assert.deepEqual(root.styles.get('background-color'), { value: 'red', priority: 'important' });
    assert.equal(root.styles.size, 3);
});

test('hive tone can follow appearance mode when not explicitly pinned', () => {
    const controller = createQianmuThemeSurfaceController(), root = element();
    controller.register(root, { role: 'hive-entry' });
    for (const mode of ['light', 'dark']) {
        const s = controller.setTheme({ mode });
        assert.equal(root.style.getPropertyValue('--sd-wheel-icon'), s.hive[mode].icon);
    }
});

test('same snapshot causes no redundant DOM writes', () => {
    const controller = createQianmuThemeSurfaceController(), root = element();
    controller.register(root); controller.setTheme({ accent: '#abc' }); const writes = root.writes;
    controller.setTheme({ accent: '#aabbcc' }); assert.equal(root.writes, writes);
});

test('later owner changes are not overwritten by unregister or dispose', () => {
    const controller = createQianmuThemeSurfaceController(), root = element();
    const off = controller.register(root); controller.setTheme({});
    root.style.setProperty('--sd-text', 'blue', 'important'); root.setAttribute('data-qm-theme', 'owner');
    off(); assert.equal(root.style.getPropertyValue('--sd-text'), 'blue'); assert.equal(root.getAttribute('data-qm-theme'), 'owner');
    controller.dispose(); assert.equal(root.style.getPropertyPriority('--sd-text'), 'important');
});

test('owner edits between theme changes become the updated restoration baseline', () => {
    const controller = createQianmuThemeSurfaceController(), root = element(); controller.register(root); controller.setTheme({});
    root.style.setProperty('--sd-text', 'blue'); root.setAttribute('data-qm-mode', 'owner');
    controller.setTheme({ mode: 'dark' }); controller.setTheme(null);
    assert.equal(root.style.getPropertyValue('--sd-text'), 'blue'); assert.equal(root.getAttribute('data-qm-mode'), 'owner');
});

test('invalid palettes fail before any surface mutation', () => {
    const controller = createQianmuThemeSurfaceController(), root = element(); controller.register(root); const s = controller.setTheme({}); const writes = root.writes;
    for (const options of [{ theme: 'bad' }, { mode: 'invalid' }, { accent: 'url(secret)' }]) assert.throws(() => controller.setTheme(options), TypeError);
    assert.equal(controller.snapshot, s); assert.equal(root.writes, writes);
});

test('root and registration boundaries reject host document, duplicate and malformed roles', () => {
    const controller = createQianmuThemeSurfaceController(), root = element();
    root.ownerDocument.body = root; assert.throws(() => controller.register(root), TypeError);
    root.ownerDocument.body = null; root.ownerDocument.documentElement = root; assert.throws(() => controller.register(root), TypeError);
    root.ownerDocument.documentElement = null;
    for (const options of [{ role: 'body' }, { tone: 'bad' }, { edgeIndex: -1 }, { edgeIndex: Infinity }, { edgeIndex: 1.5 }]) assert.throws(() => controller.register(root, options), TypeError);
    assert.equal(controller.size, 0); controller.register(root); assert.throws(() => controller.register(root), /already/);
});

test('unregistered roots are no longer updated and dispose is idempotent', () => {
    const controller = createQianmuThemeSurfaceController(), root = element();
    const off = controller.register(root); controller.setTheme({}); off(); const writes = root.writes;
    controller.setTheme({ mode: 'dark' }); assert.equal(root.writes, writes);
    controller.register(root); controller.dispose(); controller.dispose(); off();
    assert.equal(controller.size, 0); assert.equal(controller.snapshot, null); assert.equal(root.styles.size, 0);
    assert.throws(() => controller.setTheme({}), /disposed/); assert.throws(() => controller.register(element()), /disposed/);
});

test('surface adapter is not a renderer, observer, persistence or host-global integration', async () => {
    const source = await readFile(new URL('../qianmu-theme-surfaces.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /innerHTML|replaceChildren|replaceWith|\.focus\(|setSelectionRange|MutationObserver|querySelector|localStorage|indexedDB|fetch\(|className\s*=/);
});
