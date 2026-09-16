import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bindQianmuStoryboardNavigation, preserveQianmuStoryboardNav } from '../qianmu-storyboard-nav-lifecycle.js';

class Button extends EventTarget {
    constructor(key) { super(); this.dataset = { storyboardView: key }; this.disabled = false; }
    click() { this.dispatchEvent(new Event('click')); }
}

test('rebinding a retained nav dispatches exactly once to the current route closure', () => {
    const button = new Button('gallery'), calls = [], root = { querySelectorAll: () => [button] };
    for (let i = 0; i < 30; i++) bindQianmuStoryboardNavigation(root, current => calls.push([i, current.dataset.storyboardView]));
    button.click(); assert.deepEqual(calls, [[29, 'gallery']]);
});

test('route ownership leaves unrelated listeners and non-nav shortcuts intact', () => {
    const nav = new Button('characters'), shortcut = new Button('gallery'), calls = [];
    nav.addEventListener('click', () => calls.push('other owner'));
    const root = { querySelectorAll: () => [nav, shortcut] };
    bindQianmuStoryboardNavigation(root, button => calls.push('old:' + button.dataset.storyboardView));
    bindQianmuStoryboardNavigation(root, button => calls.push(button.dataset.storyboardView));
    nav.click(); shortcut.click(); assert.deepEqual(calls, ['other owner', 'characters', 'gallery']);
});

test('separate roots and replacement buttons cannot inherit stale listeners', () => {
    const a = new Button('create'), b = new Button('create'), calls = [];
    bindQianmuStoryboardNavigation({ querySelectorAll: () => [a] }, () => calls.push('a'));
    bindQianmuStoryboardNavigation({ querySelectorAll: () => [b] }, () => calls.push('b'));
    a.click(); b.click(); assert.deepEqual(calls, ['a', 'b']);
    b.disabled = true; b.click(); assert.deepEqual(calls, ['a', 'b']);
});

test('classic, editorial and non-storyboard renders never touch navigation', () => {
    for (const theme of [null, 'editorial', 'unknown']) {
        const root = { getAttribute: () => theme, querySelector() { throw Error('classic nav queried'); } };
        assert.equal(preserveQianmuStoryboardNav(root, true)(), false);
    }
    assert.equal(preserveQianmuStoryboardNav({ getAttribute() { throw Error('unrelated page queried'); } }, false)(), false);
});

test('modal restoration and route binding are placed at their production boundaries', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('function renderModal()'), end = source.indexOf('\nfunction ', start + 1), render = source.slice(start, end);
    assert.ok(render.indexOf('preserveQianmuStoryboardNav(modal, storyboardLayout)') < render.indexOf('modal.innerHTML ='));
    assert.ok(render.indexOf('restoreStoryboardNav();') > render.indexOf('modal.innerHTML ='));
    assert.ok(render.indexOf('restoreStoryboardNav();') < render.indexOf('applyQianmuIcons(modal)'));
    assert.ok(render.indexOf('restoreStoryboardNav();') < render.indexOf('bindActiveTabEvents(modal)'));
    assert.match(source, /bindQianmuStoryboardNavigation\(root, \(button\) => \{\s*if \(state.view === 'create'\) storyboardCaptureWorkbench\(root\);/);
    assert.doesNotMatch(source, /querySelectorAll\('\[data-storyboard-view\]'\)\.forEach/);
    const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
    assert.ok(JSON.stringify(release).includes('qianmu-storyboard-nav-lifecycle.js'));
});
