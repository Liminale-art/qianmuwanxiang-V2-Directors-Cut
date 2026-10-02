import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createQianmuAppearanceSession } from '../qianmu-appearance-session.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const start = source.indexOf('async function storyboardChooseCaptureMode(');
const chooser = source.slice(start, source.indexOf('\nasync function storyboardEditPrompt(', start));

function element(document) {
    const styles = new Map(), attrs = new Map(), classes = new Set(), listeners = new Map();
    return {
        nodeType: 1, isConnected: true, ownerDocument: document, scrollTop: 0, scrollLeft: 0,
        querySelectorAll: () => [], contains: () => false, setAttribute: (k, v) => attrs.set(k, v), getAttribute: k => attrs.get(k) ?? null, removeAttribute: k => attrs.delete(k),
        classList: { add: k => classes.add(k), contains: k => classes.has(k), remove: k => classes.delete(k) },
        style: { getPropertyValue: k => styles.get(k)?.value || '', getPropertyPriority: k => styles.get(k)?.priority || '', setProperty: (k, value, priority = '') => styles.set(k, { value, priority }), removeProperty: k => styles.delete(k) },
        addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type), listenerCount: () => listeners.size,
    };
}

async function fixture({ settings = { theme: 'light' }, missingDialog = false, mountError = false, text = ['First', 'Second', 'Third'] } = {}) {
    let popup, resolve, reject, shown = false, releaseCount = 0, mountCount = 0;
    const document = {
        body: { appendChild() {} }, createElement() { return { ...element(document), remove() {} }; },
        defaultView: { getComputedStyle: probe => ({ getPropertyValue: key => {
            const dark = probe.className?.includes('sd-theme-dark');
            return { '--sd-text': dark ? '#e8e6e1' : '#3c352e', '--sd-accent': '#5f7a68', '--sd-sticky-bg': dark ? '#26282d' : '#f7f3eb', '--sd-card': '#ffffff' }[key] || '';
        } }) },
    };
    const session = createQianmuAppearanceSession({ document, readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    const count = {}, panel = { hidden: true, querySelector: () => count };
    const rows = text.map((_, i) => {
        const row = { selected: false };
        return { value: String(i), checked: false, closest: () => ({ classList: { toggle: (_, state) => { row.selected = state; } } }), addEventListener(type, fn) { this[type] = fn; }, row };
    });
    const modes = ['auto', 'manual_supplement'].map(value => ({ value, checked: value === 'auto', addEventListener(type, fn) { this[type] = fn; } }));
    const wrap = {
        querySelector: selector => selector.includes('paragraphs') ? panel : modes.find(item => item.checked),
        querySelectorAll: selector => selector.includes('paragraph-row') ? rows : modes,
    };
    const notices = [];
    const environment = vm.createContext({
        document: { createElement: () => wrap },
        storyboardMessageParagraphs: () => text, htmlEscape: value => value, normalizeStoryboardParagraphSelection: value => value,
        toast: (...args) => notices.push(args), promptInput: () => assert.fail('Native fallback must not run after a Popup result'),
        console: { warn() {} },
        appearanceSession: { mountPortal(root, options) {
            mountCount++; assert.equal(shown, true, 'Popup must be attached before theme registration'); assert.equal(options.inheritTheme, true);
            if (mountError) throw Error('Theme unavailable');
            const release = session.mountPortal(root, options);
            return () => { releaseCount++; release(); };
        } },
        ctx: () => ({ POPUP_TYPE: { CONFIRM: 1 }, Popup: class {
            constructor(content, type, value, options) { popup = this; this.dlg = missingDialog ? undefined : element(document); this.options = options; }
            show() { shown = true; return new Promise((yes, no) => { resolve = yes; reject = no; }); }
        } }),
    });
    vm.runInContext(chooser, environment);
    const result = environment.storyboardChooseCaptureMode(2, { mes: 'test' });
    await session.sync();
    return { popup, session, result, resolve, reject, rows, modes, panel, count, notices,
        get mountCount() { return mountCount; }, get releaseCount() { return releaseCount; },
        manual() { modes[0].checked = false; modes[1].checked = true; modes[1].change(); },
    };
}

for (const family of ['classic', 'glass', 'editorial']) for (const mode of ['light', 'dark']) {
    test(`${family}/${mode}: actual capture owner mounts the live Qianmu palette and releases on cancellation`, async () => {
        const settings = { theme: mode, appearance: { version: 1, family, mode } };
        const f = await fixture({ settings });
        assert.ok(f.popup.dlg.classList.contains('sd-storyboard-capture-popup'));
        assert.equal(f.popup.dlg.getAttribute('data-qm-theme'), family === 'classic' ? null : family);
        assert.equal(f.session.size, 1); assert.ok(f.popup.dlg.style.getPropertyValue('--sd-text'));
        assert.equal(f.popup.options.okButton, '继续'); assert.equal(f.popup.options.cancelButton, '取消');
        f.resolve(false); assert.equal(await f.result, null);
        assert.equal(f.releaseCount, 1); assert.equal(f.session.size, 0); assert.equal(f.popup.dlg.listenerCount(), 0);
        assert.equal(f.popup.dlg.getAttribute('data-qm-theme'), null); f.session.reset();
    });
}

test('manual multi-paragraph choice, shift range, count and return values remain unchanged', async () => {
    const f = await fixture(); f.manual(); assert.equal(f.panel.hidden, false);
    f.rows[0].checked = true; f.rows[0].click({ shiftKey: false });
    f.rows[2].checked = true; f.rows[2].click({ shiftKey: true });
    assert.equal(f.count.textContent, '3'); assert.ok(f.rows.every(row => row.row.selected));
    f.resolve(true); const value = await f.result;
    assert.equal(value.mode, 'manual_supplement'); assert.equal(value.paragraphIndex, 2);
    assert.deepEqual(Array.from(value.selection.indexes), [0, 1, 2]); assert.equal(f.releaseCount, 1);
});

test('default auto choice and empty manual choice keep original semantics and both clean up', async () => {
    const auto = await fixture(); auto.resolve(true); const value = await auto.result;
    assert.equal(value.mode, 'auto'); assert.equal(value.selection, null); assert.equal(auto.releaseCount, 1);
    const manual = await fixture(); manual.manual(); manual.resolve(true);
    assert.equal(await manual.result, null); assert.equal(manual.notices.length, 1); assert.equal(manual.releaseCount, 1);
});

test('rejected Popup releases theme; missing dialog or theme failure does not block native confirmation', async () => {
    const rejected = await fixture(); rejected.reject(Error('Cancelled')); assert.equal(await rejected.result, null); assert.equal(rejected.releaseCount, 1);
    for (const options of [{ missingDialog: true }, { mountError: true }]) {
        const f = await fixture(options); f.resolve(true); assert.equal((await f.result).mode, 'auto'); assert.equal(f.session.size, 0);
    }
});

test('capture shell and controls use Qianmu tokens, not ST skin variables or global popup selectors', () => {
    const shell = css.slice(css.indexOf('/* Only the owned capture popup'), css.indexOf('.sd-storyboard-capture-dialog,', css.indexOf('/* Only the owned capture popup')));
    assert.match(shell, /dialog\.sd-storyboard-capture-popup\s*\{/);
    assert.match(shell, /--qm-skin-window/); assert.match(shell, /--sd-sticky-bg/);
    assert.match(shell, /--qm-card-radius/); assert.match(shell, /--qm-button-radius/);
    assert.match(shell, /\.popup-button-ok\s*\{[^}]*--sd-primary-text[^}]*--sd-primary/s);
    assert.match(shell, /focus-visible/); assert.doesNotMatch(shell, /SmartTheme|^dialog\s*\{|^\.popup\b/m);
    const captureRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => selector.includes('sd-storyboard-capture'));
    assert.ok(captureRules.length > 12);
    for (const [, selector, body] of captureRules) assert.doesNotMatch(body, /SmartTheme/, selector.trim());
    assert.match(chooser, /appearanceSession\.mountPortal\(popup\.dlg, \{ inheritTheme: true \}\)/);
    assert.doesNotMatch(chooser, /querySelectorAll\(['"]dialog|MutationObserver|setInterval|fetch\(/);
});
