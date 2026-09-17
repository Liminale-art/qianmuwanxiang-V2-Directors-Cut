import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderQianmuThemeMenu, bindQianmuThemeMenu } from '../qianmu-theme-menu.js';

function fixture() {
    function node(className, parent = null) {
        const events = new Map(), attributes = new Map(), classes = new Set([className]);
        return { className, parent, events, hidden: false, disabled: false, isConnected: true, dataset: {},
            classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
            setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key) ?? null,
            addEventListener(type, listener) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(listener); },
            removeEventListener(type, listener) { events.get(type)?.delete(listener); },
            emit(type, data = {}) { const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...data }; for (const listener of [...events.get(type) || []]) listener(event); return event; },
            contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
            closest(selector) { return selector === '.' + className ? this : parent?.closest(selector); },
            focus() { document.activeElement = this; },
        };
    }
    const document = node('document'), root = node('root'), pick = node('sd-theme-pick', root), trigger = node('sd-theme-btn', pick), menu = node('sd-theme-menu', pick);
    root.ownerDocument = document; root.querySelector = () => pick;
    pick.querySelector = selector => selector === '.sd-theme-btn' ? trigger : menu;
    menu.hidden = true;
    const buttons = ['light', 'dark', 'summer'].map(key => { const button = node('sd-theme-opt', menu); button.dataset.theme = key; button.setAttribute('aria-checked', String(key === 'dark')); return button; });
    menu.querySelectorAll = () => buttons;
    const outside = node('outside');
    return { document, root, pick, trigger, menu, buttons, outside, listenerCount: () => document.events.get('click')?.size || 0 };
}

test('theme markup preserves radio semantics, explicit button types and escaped descriptors', () => {
    const html = renderQianmuThemeMenu([{ key: 'light', name: '日间', dot: '#fff' }, { key: 'dark', name: '<img onerror="x">', dot: '#000' }], 'dark');
    assert.equal((html.match(/type="button"/g) || []).length, 3);
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
    assert.match(html, /aria-haspopup="menu" aria-expanded="false" aria-controls="qianmu-appearance-menu"/);
    assert.match(html, /&lt;img onerror=&quot;x&quot;&gt;/); assert.doesNotMatch(html, /<img/);
    assert.match(html, /data-theme="dark"/); assert.match(html, /role="menu" aria-label="外观主题" hidden/);
});

test('compact menu shows current family controls immediately without disclosure',()=>{
    const themes=['light','dark','summer','candy','kraft','dream'].map(key=>({key,name:key,dot:'#fff'}));
    const html=renderQianmuThemeMenu(themes,'dream',{supported:true,settings:{theme:'dream',appearance:{version:1,family:'glass',mode:'dark'}}});
    for(const {key} of themes)assert.match(html,new RegExp(`data-theme="${key}"`));
    assert.match(html,/data-appearance-family="editorial"/);assert.match(html,/aria-checked="true" data-appearance-family="glass"/);assert.match(html,/data-appearance-family="classic"/);
    assert.equal((html.match(/data-appearance-family=/g)||[]).length,3);
    assert.match(html,/class="sd-theme-details" role="group" aria-label="主题颜色">/);
    assert.match(html,/class="sd-theme-accent-options" role="group" aria-label="强调色">/);
    assert.match(html,/class="sd-theme-classic-options" role="group" aria-label="经典颜色" hidden/);
    assert.doesNotMatch(html,/data-appearance-family="[^"]+" aria-expanded/);
    assert.match(html,/data-appearance-mode-toggle aria-label="切换至日间"/);
    assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/sd-theme-retry/);
    const legacy=renderQianmuThemeMenu(themes,'dark',{supported:false,settings:{appearance:{version:1,family:'glass'}}});assert.doesNotMatch(legacy,/data-appearance-family|data-appearance-mode/);assert.equal((legacy.match(/aria-checked="true"/g)||[]).length,1);
});

test('both new families expose safe curated and custom accent controls, not the legacy palette',()=>{
    for(const family of ['glass','editorial']){
        const html=renderQianmuThemeMenu([], 'light', {supported:true,settings:{appearance:{version:1,family,accent:'#AbC',mode:'light'}}});
        assert.equal((html.match(/data-appearance-accent=/g)||[]).length,6);
        assert.match(html,/type="color" value="#aabbcc" aria-label="自定强调色"/);
        assert.match(html,/sd-theme-custom-color sd-theme-swatch active/);
        assert.match(html,/data-appearance-mode-toggle aria-label="切换至夜间"/);
        assert.doesNotMatch(html,/>日间<|>夜间</);
    }
});

test('the production header no longer renders the tagline in any family',async()=>{
    const entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const start=entry.indexOf('function renderModal()'),render=entry.slice(start,entry.indexOf('\nfunction ',start+1));
    assert.doesNotMatch(render,/一蝶振翅|万象入幕/);
    assert.match(render,/<h2>\$\{EXTENSION_NAME\}<\/h2>/);
});

test('repeated trigger open/close owns at most one document listener', () => {
    const f = fixture(), cleanup = bindQianmuThemeMenu(f.root, () => assert.fail('toggle selected a theme'));
    for (let i = 0; i < 30; i++) {
        f.trigger.emit('click'); assert.equal(f.listenerCount(), 1); assert.equal(f.menu.hidden, false); assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(f.document.activeElement, f.buttons[1]);
        f.trigger.emit('click'); assert.equal(f.listenerCount(), 0); assert.equal(f.menu.hidden, true); assert.equal(f.document.activeElement, f.trigger);
    }
    cleanup(); cleanup(); assert.equal(f.listenerCount(), 0);
});

test('outside close does not consume the outside action or steal its focus', () => {
    const f = fixture(); bindQianmuThemeMenu(f.root, () => {}); f.trigger.emit('click');
    f.document.activeElement = f.outside;
    const event = f.document.emit('click', { target: f.outside });
    assert.equal(f.menu.hidden, true); assert.equal(f.listenerCount(), 0); assert.equal(event.stopped, undefined); assert.equal(f.document.activeElement, f.outside);
});

test('keyboard navigation skips unavailable options and Escape/Tab restore the trigger', () => {
    const f = fixture(); bindQianmuThemeMenu(f.root, () => {}); f.buttons[0].disabled = true;
    f.pick.emit('keydown', { target: f.trigger, key: 'ArrowDown' }); assert.equal(f.document.activeElement, f.buttons[1]);
    f.pick.emit('keydown', { key: 'ArrowDown' }); assert.equal(f.document.activeElement, f.buttons[2]);
    f.pick.emit('keydown', { key: 'ArrowDown' }); assert.equal(f.document.activeElement, f.buttons[1]);
    f.pick.emit('keydown', { key: 'End' }); assert.equal(f.document.activeElement, f.buttons[2]);
    f.pick.emit('keydown', { key: 'Home' }); assert.equal(f.document.activeElement, f.buttons[1]);
    const escape = f.pick.emit('keydown', { key: 'Escape' }); assert.equal(escape.stopped, true); assert.equal(f.document.activeElement, f.trigger); assert.equal(f.listenerCount(), 0);
    f.pick.emit('keydown', { target: f.trigger, key: 'ArrowUp' }); assert.equal(f.document.activeElement, f.buttons[2]);
    const tab = f.pick.emit('keydown', { key: 'Tab' }); assert.equal(tab.prevented, undefined); assert.equal(f.document.activeElement, f.trigger); assert.equal(f.listenerCount(), 0);
});

test('selection closes before calling its owner and rejects disabled or mutated options', () => {
    const f = fixture(), chosen = [];
    bindQianmuThemeMenu(f.root, key => { assert.equal(f.menu.hidden, true); assert.equal(f.listenerCount(), 0); chosen.push(key); });
    f.menu.emit('click', { target: f.buttons[0] }); assert.deepEqual(chosen, []);
    f.trigger.emit('click'); f.buttons[0].disabled = true; f.menu.emit('click', { target: f.buttons[0] });
    f.buttons[1].dataset.theme = 'unknown'; f.menu.emit('click', { target: f.buttons[1] }); assert.deepEqual(chosen, []);
    f.menu.emit('click', { target: f.buttons[2] }); assert.deepEqual(chosen, ['summer']);
});

test('disposal releases all owned listeners, does not refocus and is reentrant-safe', () => {
    const f = fixture(); let count = 0;
    const cleanup = bindQianmuThemeMenu(f.root, () => { count++; cleanup(); });
    f.trigger.emit('click'); f.menu.emit('click', { target: f.buttons[0] });
    assert.equal(count, 1); assert.equal(f.listenerCount(), 0);
    for (const [node, event] of [[f.trigger, 'click'], [f.menu, 'click'], [f.pick, 'keydown']]) assert.equal(node.events.get(event)?.size || 0, 0);
    f.trigger.emit('click'); f.menu.emit('click', { target: f.buttons[2] }); assert.equal(count, 1);
    cleanup();
    const g = fixture(), release = bindQianmuThemeMenu(g.root, () => {}); g.trigger.emit('click'); g.document.activeElement = g.outside; release();
    assert.equal(g.document.activeElement, g.outside); assert.equal(g.menu.hidden, true); assert.equal(g.listenerCount(), 0);
});

test('absent menu on storyboard pages is an inert disposer', () => {
    const cleanup = bindQianmuThemeMenu({ querySelector: () => null }, () => assert.fail()); cleanup(); cleanup();
});

test('successful in-place selection updates radio state and returns focus, a rejected action keeps the old radio',()=>{
    for(const accepted of [true,false]){
        const f=fixture();bindQianmuThemeMenu(f.root,()=>accepted);f.trigger.emit('click');f.menu.emit('click',{target:f.buttons[2]});
        assert.equal(f.document.activeElement,f.trigger);assert.equal(f.buttons[2].getAttribute('aria-checked'),String(accepted));assert.equal(f.buttons[1].getAttribute('aria-checked'),String(!accepted));
    }
});

test('production rerender, allowed close and extension disposal all release menu ownership', async () => {
    const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(entry, /function closeModal\(\) \{\s*if \(focusClockBlockExit\(\)\) return;\s*document.getElementById\(MODAL_ID\)\?\._sdThemeMenuCleanup\?\.\(\);/);
    assert.match(entry, /modal\._sdThemeMenuCleanup\?\.\(\);\s*storyboardCaptureTagDraft/);
    assert.match(entry, /clean\('panels', \(\) => \{\s*document.getElementById\(MODAL_ID\)\?\._sdThemeMenuCleanup\?\.\(\);/);
    assert.match(entry, /renderQianmuThemeMenu\(THEMES, themeKey, \{settings,supported:appearanceSession.supported\}\)/);
    const start = entry.indexOf('function renderModal()'), render = entry.slice(start, entry.indexOf('\nfunction ', start + 1));
    assert.equal(/const themePick =|const closeOnce =/.test(render), false, 'the old leaking menu binder must be removed from renderModal');
    const module = await readFile(new URL('../qianmu-theme-menu.js', import.meta.url), 'utf8');
    assert.doesNotMatch(module, /localStorage|indexedDB|fetch\(|renderModal|saveSettings|MutationObserver/);
});
