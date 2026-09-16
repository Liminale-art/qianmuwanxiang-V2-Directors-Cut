import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareQianmuPortalBaseline } from '../qianmu-appearance-portals.js';
import { createQianmuThemeSurfaceController, createQianmuThemeSnapshot } from '../qianmu-theme-surfaces.js';

function element() {
    const styles = new Map(), attrs = new Map();
    return { nodeType: 1, ownerDocument: {}, isConnected: true, className: 'portal', children: ['unchanged'],
        getAttribute: key => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
        style: { getPropertyValue: key => styles.get(key)?.value || '', getPropertyPriority: key => styles.get(key)?.priority || '', setProperty: (key, value, priority = '') => styles.set(key, { value, priority }), removeProperty: key => styles.delete(key) },
    };
}
function fixture({ fail = false } = {}) {
    let probe, attached = 0;
    const document = { createElement: () => (probe = { ...element(), remove() { attached--; } }), body: { appendChild() { attached++; } },
        defaultView: { getComputedStyle: () => { if (fail) throw Error('view gone'); return { getPropertyValue: key => ({ '--sd-text': 'classic-ink', '--sd-accent': 'classic-accent' })[key] || '' }; } } };
    const root = element(); root.ownerDocument = document;
    return { root, document, get probe() { return probe; }, get attached() { return attached; } };
}

test('only copied color aliases are rebaselined; font, geometry and content stay untouched', () => {
    const f = fixture(), root = f.root;
    root.style.setProperty('--sd-text', 'new-ink'); root.style.setProperty('--sd-accent', 'new-accent'); root.style.setProperty('--sd-danger', 'new-danger');
    root.style.setProperty('--sd-font', 'custom-font'); root.style.setProperty('left', '12px');
    prepareQianmuPortalBaseline(root, 'dream');
    assert.equal(root.style.getPropertyValue('--sd-text'), 'classic-ink'); assert.equal(root.style.getPropertyValue('--sd-accent'), 'classic-accent'); assert.equal(root.style.getPropertyValue('--sd-danger'), '');
    assert.equal(root.style.getPropertyValue('--sd-font'), 'custom-font'); assert.equal(root.style.getPropertyValue('left'), '12px'); assert.deepEqual(root.children, ['unchanged']);
    assert.equal(f.probe.id, undefined); assert.equal(f.probe.hidden, true); assert.equal(f.probe.className, 'qm-classic-theme-probe sd-theme-dream'); assert.equal(f.attached, 0);
});

test('probe cleanup is guaranteed and a computed-style failure leaves the portal unchanged', () => {
    const f = fixture({ fail: true }); f.root.style.setProperty('--sd-text', 'before');
    assert.throws(() => prepareQianmuPortalBaseline(f.root, 'dark'), /view gone/);
    assert.equal(f.attached, 0); assert.equal(f.root.style.getPropertyValue('--sd-text'), 'before');
});

test('roots without copied aliases do not create a probe; unknown classic keys fall back safely', () => {
    const f = fixture(); prepareQianmuPortalBaseline(f.root, 'light'); assert.equal(f.probe, undefined);
    f.root.style.setProperty('--sd-text', 'copied'); prepareQianmuPortalBaseline(f.root, 'dark another-class'); assert.equal(f.probe.className, 'qm-classic-theme-probe sd-theme-light'); assert.equal(f.attached, 0);
});

test('reader surfaces remain opaque and restore their original background and portal color', () => {
    const root = element(), controller = createQianmuThemeSurfaceController();
    root.style.setProperty('background-color', '#f3efe7'); root.style.setProperty('--sd-portal-bg', '#f3efe7'); root.style.setProperty('background-image', 'none');
    controller.register(root, { role: 'reader' });
    for (const mode of ['light', 'dark']) {
        const snapshot = controller.setTheme({ theme: 'glass', mode });
        assert.equal(root.style.getPropertyValue('background-color'), snapshot.css['--qm-bg']); assert.equal(root.style.getPropertyPriority('background-color'), 'important');
        assert.equal(root.style.getPropertyValue('--sd-portal-bg'), snapshot.css['--qm-bg']); assert.equal(root.style.getPropertyValue('background-image'), 'none');
    }
    controller.setTheme(null); assert.equal(root.style.getPropertyValue('background-color'), '#f3efe7'); assert.equal(root.style.getPropertyPriority('background-color'), ''); assert.equal(root.style.getPropertyValue('--sd-portal-bg'), '#f3efe7'); controller.dispose();
});

test('media surfaces keep a dark inspection palette without changing the image background or contents', () => {
    const root = element(), controller = createQianmuThemeSurfaceController(); root.style.setProperty('background-color', 'rgba(10,11,12,.78)'); controller.register(root, { role: 'media' });
    for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
        controller.setTheme({ theme, mode, accent: '#123456' }); const expected = createQianmuThemeSnapshot({ theme, mode: 'dark', accent: '#123456' });
        assert.equal(root.getAttribute('data-qm-mode'), 'dark'); assert.equal(root.getAttribute('data-qm-theme'), theme); assert.equal(root.style.getPropertyValue('--sd-text'), expected.tokens['--sd-text']);
        assert.equal(root.style.getPropertyValue('background-color'), 'rgba(10,11,12,.78)'); assert.deepEqual(root.children, ['unchanged']);
    }
    controller.dispose(); assert.equal(root.getAttribute('data-qm-theme'), null); assert.equal(root.style.getPropertyValue('--sd-text'), '');
});

test('every known body portal is explicitly mounted with reader/media roles at its own owner boundary', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const names = ['openFloorNavigator', 'openStorageCleanupDialog', 'openStorageChatCleanupDialog', 'ttsOpenQuickPopup', 'storyboardOpenVideoDraftEditor', 'storyboardOpenFilmViewer', 'storyboardOpenVideoViewer', 'storyboardOpenLightbox', 'coreadTopNotice', 'coreadOpenVoicePopup', 'coreadShowRefillChooser', 'mountReaderPortal', 'openTheaterFullscreen'];
    for (const name of names) {
        const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name);
        const tail = source.slice(start), end = tail.slice(1).search(/^(?:async )?function /m), body = end < 0 ? tail : tail.slice(0, end + 1);
        assert.match(body, /appearanceSession\.mountPortal\(/, name);
        if (['mountReaderPortal','openTheaterFullscreen'].includes(name)) assert.match(body, /role:'reader'/);
        if (['storyboardOpenVideoDraftEditor','storyboardOpenFilmViewer','storyboardOpenVideoViewer','storyboardOpenLightbox'].includes(name)) assert.match(body, /role:'media'/);
    }
});
