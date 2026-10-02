import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {openStoryboardCaptureChooser, closeStoryboardCaptureChooser} from '../qianmu-storyboard-capture-view.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../qianmu-storyboard-capture-view.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const paragraphs = ['第一段：花园与窗边。', '第二段：桌上的信。', '第三段：走廊尽头。'];
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
    const dom = textCollectionDom(), trigger = dom.doc.createElement('button'); dom.doc.body.append(trigger); trigger.focus();
    let mounts = 0, releases = 0, current = true;
    const open = patch => openStoryboardCaptureChooser({document: dom.doc, paragraphs, isCurrent: () => current,
        mountPortal: parent => {
            mounts++; assert.equal(parent.className, 'qm-storyboard-capture-portal'); assert.equal(parent.isConnected, true);
            assert.ok(parent.querySelector('dialog')); return () => releases++;
        }, ...options, ...patch});
    const result = open();
    t.after(() => closeStoryboardCaptureChooser(dom.doc));
    return {dom, trigger, result, open, setCurrent: value => current = value,
        get mounts() { return mounts; }, get releases() { return releases; }};
}
const click = (f, label) => { const node = f.dom.get(label); assert.ok(f.dom.visible(node), label); node.click(); return node; };
const dialog = f => f.dom.byClass('qm-storyboard-capture');
const list = f => f.dom.byClass('qm-storyboard-capture-paragraphs');

test('choice is an owned native dialog; paragraph page replaces rather than nests the mode choices', async t => {
    const f = fixture(t); assert.equal(f.mounts, 1); assert.equal(dialog(f).open, true);
    assert.equal(dialog(f).classList.contains('popup'), false);
    click(f, '手动选段补图'); assert.equal(dialog(f).getAttribute('data-page'), 'paragraphs');
    assert.equal(f.dom.visible(f.dom.get('本层重新提取')), false); assert.equal(f.dom.visible(f.dom.get('手动选段补图')), false);
    assert.equal(f.dom.get('继续补图').disabled, true);
    click(f, '选择第 2 段'); assert.equal(f.dom.get('选择第 2 段').getAttribute('aria-pressed'), 'true');
    assert.equal(f.dom.get('继续补图').disabled, false); click(f, '继续补图');
    assert.deepEqual(await f.result, {mode: 'manual_supplement', indexes: [1]});
    assert.equal(f.releases, 1); assert.equal(f.dom.byClass('qm-storyboard-capture-portal'), undefined);
});

test('back retains selections, row identity and scroll; no rerendered copy of the text is introduced', async t => {
    const f = fixture(t); click(f, '手动选段补图'); const row = click(f, '选择第 1 段');
    list(f).scrollTop = 123; click(f, '返回插画方式'); assert.equal(f.dom.visible(row), false);
    click(f, '手动选段补图'); assert.equal(f.dom.get('选择第 1 段'), row);
    assert.equal(row.getAttribute('aria-pressed'), 'true'); assert.equal(list(f).scrollTop, 123);
    click(f, '继续补图'); assert.deepEqual((await f.result).indexes, [0]);
});

test('manual range and deselection preserve sorted paragraph indices', async t => {
    const f = fixture(t); click(f, '手动选段补图'); click(f, '选择第 1 段');
    f.dom.get('选择第 3 段').emit('click', {shiftKey: true});
    assert.equal(f.dom.byClass('qm-storyboard-capture-count').textContent, '已选 3 段');
    click(f, '选择第 2 段'); click(f, '继续补图');
    assert.deepEqual(await f.result, {mode: 'manual_supplement', indexes: [0, 2]});
});

test('whole-floor extraction requires its separate explicit confirmation; returning is non-submitting', async t => {
    const f = fixture(t); let settled = false; f.result.then(() => settled = true);
    click(f, '本层重新提取'); await turn(); assert.equal(settled, false);
    assert.equal(dialog(f).getAttribute('data-page'), 'auto'); assert.equal(f.dom.visible(list(f)), false);
    click(f, '返回插画方式'); await turn(); assert.equal(settled, false);
    click(f, '本层重新提取'); click(f, '继续重新提取');
    assert.deepEqual(await f.result, {mode: 'auto', indexes: []});
});

test('cancel, native close and explicit owner disposal settle null and restore the originating focus once', async t => {
    for (const action of ['cancel', 'close', 'dispose']) {
        const f = fixture(t); const panel = dialog(f);
        if (action === 'cancel') { const event = panel.emit('cancel'); assert.equal(event.defaultPrevented, true); }
        else if (action === 'close') { panel.open = false; panel.emit('close'); }
        else closeStoryboardCaptureChooser(f.dom.doc);
        assert.equal(await f.result, null); assert.equal(f.releases, 1); assert.equal(f.dom.doc.activeElement, f.trigger);
        panel.emit('close'); closeStoryboardCaptureChooser(f.dom.doc); assert.equal(f.releases, 1);
    }
});

test('aborted or retired owner cannot return a selection; replacement closes only its own prior panel', async t => {
    const abort = new AbortController(), f = fixture(t, {signal: abort.signal}); abort.abort();
    assert.equal(await f.result, null); assert.equal(f.releases, 1);
    const g = fixture(t); const old = dialog(g), next = g.open(); assert.equal(await g.result, null);
    await turn(); assert.equal(old.open, false); assert.equal(dialog(g).open, true);
    g.setCurrent(false); click(g, '手动选段补图'); assert.equal(await next, null); assert.equal(g.releases, 2);
});

test('keyboard events stay inside the chooser without preventing native Tab, Enter or Space', async t => {
    const f = fixture(t); let bubbled = 0; f.dom.doc.body.addEventListener('keydown', () => bubbled++);
    click(f, '手动选段补图'); const row = f.dom.get('选择第 1 段');
    for (const key of ['Tab', 'Enter', ' ']) assert.equal(row.emit('keydown', {key}).defaultPrevented, false);
    assert.equal(bubbled, 0); click(f, '关闭本层插画'); assert.equal(await f.result, null);
});

test('paragraph text is literal, empty paragraphs disable manual mode, and mount errors are not swallowed', async t => {
    const raw = '<script>not markup</script>\n  原始空格', f = fixture(t, {paragraphs: [raw]});
    click(f, '手动选段补图'); assert.equal(f.dom.get('选择第 1 段').textContent, raw);
    closeStoryboardCaptureChooser(f.dom.doc); await f.result;
    const empty = fixture(t, {paragraphs: []}); assert.equal(empty.dom.get('手动选段补图').disabled, true);
    const dom = textCollectionDom(); await assert.rejects(openStoryboardCaptureChooser({document: dom.doc, paragraphs,
        isCurrent: () => true, mountPortal: () => { throw Error('mount failed'); }}), /mount failed/);
    assert.equal(dom.byClass('qm-storyboard-capture-portal'), undefined);
});

test('actual entry forwards the same normalized selection contract without Popup or silent native fallback', async () => {
    const start = entry.indexOf('async function storyboardChooseCaptureMode(');
    const chooser = entry.slice(start, entry.indexOf('\nasync function storyboardEditPrompt(', start));
    for (const choice of [null, {mode: 'auto', indexes: []}, {mode: 'manual_supplement', indexes: [0, 2]}]) {
        const message = {mes: 'text'};
        const context = vm.createContext({storyboardCaptureView: null, initialized: true, isRuntimeOwner: () => true,
            getChatKey: () => 'chat-a', ctx: () => ({chat: [null, null, message]}),
            storyboardMessageParagraphs: () => paragraphs, normalizeStoryboardParagraphSelection: value => ({...value, normalized: true}),
            document: {querySelector: () => null}, appearanceSession: {mountPortal() {}},
            loadLocalChunk: async path => { assert.match(path, /qianmu-storyboard-capture-view\.js\?v=/); return {openStoryboardCaptureChooser: async options => { assert.deepEqual(options.paragraphs, paragraphs); assert.equal(options.isCurrent(), true); return choice; }}; }});
        vm.runInContext(chooser, context); const value = await context.storyboardChooseCaptureMode(2, message);
        if (!choice) assert.equal(value, null);
        else { assert.equal(value.mode, choice.mode); assert.equal(value.paragraphIndex, choice.mode === 'auto' ? null : 2);
            assert.equal(value.selection?.normalized ?? null, choice.mode === 'auto' ? null : true); }
    }
    assert.doesNotMatch(chooser, /Popup|promptInput|catch\s*\(/);
});

test('only owned native classes are styled, selected paragraphs have opaque paired colors, legacy Popup styling is removed', () => {
    const block = css.slice(css.indexOf('/* Owned native panel'), css.indexOf('.sd-storyboard-prompt-editor-dialog {', css.indexOf('/* Owned native panel')));
    assert.match(block, /\.qm-storyboard-capture-portal \.qm-storyboard-capture/);
    assert.match(block, /background: var\(--sd-sticky-bg/); assert.match(block, /--qm-card-radius/); assert.match(block, /--qm-button-radius/);
    assert.match(block, /\.qm-storyboard-capture-paragraph\[aria-pressed="true"\]\s*\{[^}]*color: var\(--sd-primary-text[^}]*background: var\(--sd-primary/s);
    assert.doesNotMatch(block, /SmartTheme|color-mix|\.popup|:hover/);
    assert.doesNotMatch(css, /sd-storyboard-capture-(?:popup|dialog|choices|paragraphs|paragraph-row)/);
    assert.doesNotMatch(source, /\.Popup|innerHTML|fetch\(|setInterval|MutationObserver|localStorage/);
    assert.match(source, /document\.body\.append\(parent\); release = mountPortal\(parent\)/);
});

test('chat, text or swipe changes while the chooser chunk loads retire its original floor before display', async () => {
    const start = entry.indexOf('async function storyboardChooseCaptureMode(');
    const chooser = entry.slice(start, entry.indexOf('\nasync function storyboardEditPrompt(', start));
    for (const change of ['chat', 'text', 'swipe', 'message']) {
        let key = 'chat-a', resume, current;
        const message = {mes: 'text', swipe_id: 0}, chat = [message];
        const context = vm.createContext({storyboardCaptureView: null, initialized: true, isRuntimeOwner: () => true,
            getChatKey: () => key, ctx: () => ({chat}), storyboardMessageParagraphs: () => paragraphs,
            document: {querySelector: () => null}, appearanceSession: {},
            loadLocalChunk: () => new Promise(resolve => { resume = () => resolve({openStoryboardCaptureChooser: async options => { current = options.isCurrent(); return null; }}); })});
        vm.runInContext(chooser, context);
        const result = context.storyboardChooseCaptureMode(0, message);
        if (change === 'chat') key = 'chat-b';
        if (change === 'text') message.mes = 'changed';
        if (change === 'swipe') message.swipe_id = 1;
        if (change === 'message') chat[0] = {...message};
        resume(); assert.equal(await result, null); assert.equal(current, false);
    }
});

test('host chat rerender and full plugin cleanup close the chooser before retiring appearance ownership', () => {
    const handlerStart = entry.indexOf('const rerenderHandler =');
    assert.ok(handlerStart >= 0);
    const handler = entry.slice(handlerStart, entry.indexOf('\n  };', handlerStart) + 5);
    assert.match(handler, /storyboardCaptureView\?\.closeStoryboardCaptureChooser\(document\)/);
    const cleanupStart = entry.indexOf('function cleanupRuntime(');
    assert.ok(cleanupStart >= 0);
    const cleanup = entry.slice(cleanupStart);
    const close = cleanup.indexOf("clean('capture chooser', () => storyboardCaptureView?.closeStoryboardCaptureChooser(document))");
    const appearance = cleanup.indexOf("clean('appearance', () => appearanceSession.reset())");
    assert.ok(close >= 0 && appearance > close);
});
