import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountTheme } from '../yimu/theme.mjs';
import { createYimuIcon, YIMU_ICON_NAMES } from '../yimu/icons.mjs';
import { ICONSAX_ICON_MARKUP, ICONSAX_GLYPH_NAMES } from '../qianmu-icon-renderer.js';
import { READER_PORTAL_BG } from '../qianmu-classic-palettes.js';
import { fontScopeCss } from '../qianmu-font-runtime.js';

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
    assert.equal(f.root.style.getPropertyValue('--ym-font'), 'ST serif');
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

test('classic surfaces use the six reviewed opaque portal colors, never the modal blur tint', () => {
    for (const [key, color] of Object.entries(READER_PORTAL_BG)) {
        const f = fixture();
        const host = f.element('story-director-modal', { '--sd-text': '#123', '--sd-window-bg': 'rgba(1, 2, 3, .08)' });
        host.setAttribute('class', `sd-theme-${key}`);
        const binding = mountTheme(f.root, { document: f.document });
        assert.equal(f.root.style.getPropertyValue('--ym-surface'), color, key);
        assert.equal(f.root.getAttribute('data-ym-mode'), key === 'dark' ? 'dark' : 'light');
        host.computed['--sd-portal-bg'] = '#123456';
        binding.sync();
        assert.equal(f.root.style.getPropertyValue('--ym-surface'), '#123456', 'an actual portal override takes priority');
        binding.destroy();
    }
});

test('all families consume the actual Qianmu font resources rather than duplicating their stacks', () => {
    const f = fixture();
    const host = f.element('story-director-modal', {
        '--sd-text': '#123', '--qm-interface-font': 'Interface Font', '--sd-font': 'Classic Font', '--mainFontFamily': 'ST Font', fontFamily: 'Computed Font',
    });
    const binding = mountTheme(f.root, { document: f.document });
    for (const [remove, expected] of [[null, 'Interface Font'], ['--qm-interface-font', 'Classic Font'], ['--sd-font', 'ST Font'], ['--mainFontFamily', 'Computed Font']]) {
        if (remove) delete host.computed[remove];
        binding.sync();
        assert.equal(f.root.style.getPropertyValue('--ym-font'), expected);
    }
    for (const family of ['editorial', 'glass']) {
        host.computed[`--qm-${family === 'glass' ? 'glass' : 'editorial'}-font`] = `Actual ${family} Font`;
        host.setAttribute('data-qm-theme', family);
        assert.equal(f.root.style.getPropertyValue('--ym-font'), `Actual ${family} Font`, family);
    }
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

test('font isolation joins the real Qianmu owned-surface boundary and restores only its own class', () => {
    const f = fixture(); f.root.setAttribute('class', 'ym-dialog caller-owned');
    const binding = mountTheme(f.root, { document: f.document });
    assert.equal(f.root.getAttribute('class'), 'ym-dialog caller-owned qm-yimu-surface');
    // This is the production ST font rule, including its cascade layer. A
    // stronger unlayered .ym-dialog font rule cannot repair this conflict.
    const hostRule = fontScopeCss('st', 'QianmuFont_host');
    assert.match(hostRule, /@layer qianmu-font-application/);
    assert.match(hostRule, /\[class\^="qm-"\], \[class\*=" qm-"\]/);
    assert.match(hostRule, /font-family:"QianmuFont_host"[^}]*!important/);
    f.root.setAttribute('class', `${f.root.getAttribute('class')} added-later`);
    binding.destroy();
    assert.equal(f.root.getAttribute('class'), 'ym-dialog caller-owned added-later');
    const owned = fixture(); owned.root.setAttribute('class', 'ym-dialog qm-yimu-surface');
    mountTheme(owned.root, { document: owned.document }).destroy();
    assert.equal(owned.root.getAttribute('class'), 'ym-dialog qm-yimu-surface', 'a pre-existing caller marker is not removed');
});

test('surface CSS remains scoped, preserves hidden pages and supports three families and narrow layouts', async () => {
    const css = await readFile(new URL('../yimu/style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /(?:^|\n)\s*(?:body|html|:root|input|button|textarea|select)\b/);
    assert.doesNotMatch(css, /@import|https?:\/\//);
    assert.match(css, /\.ym-dialog:not\(\[open\]\), \.ym-dialog \[hidden\]\s*\{\s*display: none !important/);
    assert.match(css, /data-ym-theme="editorial"/);
    assert.match(css, /data-ym-theme="glass"/);
    assert.doesNotMatch(css, /KingHwaOldSong|Sarasa Gothic SC|Qianmu Glass Local Heiti/, 'font resources are consumed from Qianmu, not redefined');
    assert.match(css, /width: min\(660px, calc\(100vw - 28px\)\)/);
    assert.match(css, /height: min\(760px, calc\(100dvh - 28px\)\)/);
    assert.match(css, /height: calc\(100dvh - 108px\)/);
    assert.match(css, /\.ym-scroll[^\n]*min-width: 0/);
    assert.match(css, /\.ym-dialog input\.ym-switch[^\n]*appearance: none !important/);
    assert.match(css, /@media \(max-width: 340px\)/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /data-ym-state="ready"/); assert.match(css, /data-ym-state="failed"/);
    assert.match(css, /--ym-surface: #f3efe7/);
    assert.doesNotMatch(css, /--ym-surface: var\(--SmartThemeBlurTintColor/);
    assert.match(css, /\.ym-stats[^\n]*border: 0/);
    assert.match(css, /\.ym-dialog \.ym-stat[^\n]*min-height: 88px/);
    assert.doesNotMatch(css, /button\.ym-stat/);
    assert.match(css, /\.ym-hero-switches[^\n]*flex-wrap: wrap/);
    assert.match(css, /\.ym-hero-switches \{[^\n]*gap: 10px 28px/);
    assert.match(css, /\.ym-hero-switches > \.ym-switch-row \{[^\n]*flex: 1 1 104px[^\n]*font: 600 var\(--ym-type-card-title\)\/1\.5 var\(--ym-font\)/);
    assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.ym-hero-switches \{ gap: 10px 20px/);
    assert.match(css, /\.ym-setting-row:has\(> small\)[^\n]*flex-direction: column[^\n]*align-items: stretch/);
    assert.match(css, /\.ym-setting-numeric > \.ym-field[^\n]*display: flex[^\n]*align-items: center/);
    assert.match(css, /\.ym-dialog \.ym-setting-numeric > \.ym-field > input[^\n]*width: var\(--ym-setting-value-width\)/);
    assert.match(css, /\.ym-dialog \.ym-budget-group[^\n]*display: flex[^\n]*align-items: center/);
    assert.match(css, /@media \(max-width: 380px\)[\s\S]*\.ym-dialog \.ym-api-params input\[type="number"\][^\n]*padding-inline: 4px[^\n]*appearance: textfield/);
    assert.match(css, /\.ym-dialog \.ym-api-params input\[type="number"\]::-webkit-outer-spin-button[^\n]*-webkit-appearance: none/);
    assert.match(css, /\.ym-dialog \.ym-prompt-item-head[^\n]*display: grid[^\n]*minmax\(0, 1fr\)/);
    assert.match(css, /\.ym-tool-row \.ym-tool-summary strong[^\n]*white-space: nowrap/);
    assert.match(css, /\.ym-backup-question \{[^\n]*width: min\(460px, calc\(100vw - 40px\)\)/);
    assert.match(css, /\.ym-avatar[^\n]*aspect-ratio: 1[^\n]*border-radius: var\(--ym-control-radius\)/);
    assert.match(css, /data-ym-theme="editorial"[^\n]*--ym-icon-bold-display: inline/);
    assert.match(css, /data-ym-theme="glass"[^\n]*--ym-icon-twotone-display: inline/);
    assert.match(css, /\.ym-tool-summary\[aria-expanded="true"\][^\n]*rotate\(180deg\)/);
    assert.match(css, /\.ym-dialog details\[open\] > summary[^\n]*rotate\(180deg\)/);
    assert.match(css, /\.ym-tool-group\[data-side="left"\][^\n]*border-start-start-radius: 0/);
    assert.match(css, /\.ym-tool-group\[data-side="right"\][^\n]*border-start-end-radius: 0/);
    assert.doesNotMatch(css, /\.ym-folder-body::before/, 'the folder is connected to its real heading, not a decorative fake tab');
    assert.match(css, /\.ym-dialog summary::marker \{ content: ''/);
    assert.match(css, /\.ym-menu-entry[^\n]*column-gap: 10px/);
    assert.match(css, /\.ym-menu-entry \.ym-logo[^\n]*align-self: center/, 'mask icon has no text baseline and must not push the menu label down');
    assert.match(css, /\.ym-heading \.ym-logo[^\n]*width: 29px/);
    assert.match(css, /\.ym-tool-group:is\(\[data-side="left"\], \[data-side="right"\]\) > \.ym-tool-row[^\n]*margin-bottom: 8px/);
    assert.match(css, /\.ym-prompt-groups[^\n]*grid-auto-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.ym-stage-actions[^\n]*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.ym-entry-name[^\n]*text-overflow: ellipsis[^\n]*white-space: nowrap/);
    assert.match(css, /\.ym-memory-toolbar[^\n]*flex-wrap: nowrap/);
    assert.match(css, /\.ym-memory-toolbar input[^\n]*flex: 1 1 0/);
    assert.match(css, /\.ym-overview\[data-empty="true"\][^\n]*text-align: center/);
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});

test('functional icons preserve Qianmu artwork except the explicit Yimu floppy-disk save glyph', async () => {
    const names = { edit: 'pencil-simple', check: 'check', close: 'x', expand: 'caret-down', trash: 'trash', refresh: 'arrows-clockwise', play: 'play', back: 'arrow-left', settings: 'gear', eye: 'eye', plus: 'plus', download: 'download-simple', upload: 'upload-simple', book: 'book-open', link: 'link', more: 'dots-three', drag: 'list', up: 'caret-up', down: 'caret-down', save: 'floppy-disk', help: 'question', stop: 'stop', layers: 'stack' };
    assert.deepEqual(YIMU_ICON_NAMES, Object.keys(names));
    const document = { createElement(tag) { return { tagName: tag, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }; } };
    for (const [name, upstream] of Object.entries(names)) {
        const element = createYimuIcon(name, { document });
        assert.equal(element.className, 'ym-icon');
        assert.equal(element.attributes['aria-hidden'], 'true');
        assert.equal(element.attributes['data-ym-icon'], name);
        assert.match(element.innerHTML, /viewBox="0 0 24 24"/);
        const original = ICONSAX_ICON_MARKUP[ICONSAX_GLYPH_NAMES[upstream]];
        if (name === 'save') {
            assert.match(element.innerHTML, /M5 3h11l5 5/);
            assert.match(element.innerHTML, /stroke-width="2\.5"/);
            assert.match(element.innerHTML, /fill="currentColor"/);
            assert.ok(!element.innerHTML.includes(original.outline), 'Yimu save is a floppy disk, not Qianmu’s bookmark');
            for (const variant of ['outline', 'bold', 'twotone']) assert.ok(element.innerHTML.includes(`class="ym-icon-${variant}"`));
            continue;
        }
        for (const variant of ['outline', 'bold', 'twotone']) {
            assert.ok(element.innerHTML.includes(`<g class="ym-icon-${variant}">${original[variant] || original.outline}</g>`), `${name}/${variant}`);
        }
        assert.doesNotMatch(element.innerHTML, /<(?:script|foreignObject)|\b(?:id|href|onload|onclick)=|url\(/i);
    }
    assert.throws(() => createYimuIcon('constructor', { document }), /Unknown Yimu icon/);
    assert.throws(() => createYimuIcon('edit', { document: {} }), /document is required/);
    const source = await readFile(new URL('../yimu/icons.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import\s|\bfetch\(/m);
    assert.match(source, /Copyright Iconsax/);
    assert.match(source, /ISC License/);
    assert.match(source, /Copyright \(c\) 2013-present Cole Bemis/);
});

test('all literal view icon consumers resolve to registered local artwork', async () => {
    for (const file of ['view.mjs', 'api-view.mjs', 'prompt-view.mjs', 'scene-view.mjs']) {
        const source = await readFile(new URL(`../yimu/${file}`, import.meta.url), 'utf8');
        const names = [
            ...[...source.matchAll(/\bcreateYimuIcon\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]),
            ...[...source.matchAll(/\b(?:iconButton|button)\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/g)].map(match => match[1]),
        ];
        for (const name of names) assert.ok(YIMU_ICON_NAMES.includes(name), `${file}: ${name} must be registered before the panel mounts`);
    }
});
