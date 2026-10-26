import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { mountYimuNavigation } from '../yimu/nav.mjs';

function fixture(family = 'classic', reduced = false) {
    const dom = textCollectionDom(), calls = [], selected = [];
    dom.parent.setAttribute('data-ym-theme', family);
    dom.doc.defaultView.matchMedia = () => ({ matches: reduced });
    dom.doc.defaultView.getComputedStyle = () => ({ opacity: '1' });
    const nav = dom.doc.createElement('nav'); dom.parent.append(nav);
    const view = mountYimuNavigation(nav, { document: dom.doc, tabs: [['a', '概览'], ['b', '记忆'], ['c', '设置']], selected: 'a', onNavigate: id => { selected.push(id); view.select(id); } });
    for (const [index, node] of dom.all().entries()) { node.getBoundingClientRect = () => ({ left: index * 10, right: index * 10 + 60, width: 60 });
        node.animate = (frames, options) => { const animation = { playState: 'running', cancel() { this.playState = 'idle'; } }; calls.push({ node, frames, options, animation }); return animation; }; }
    return { ...dom, nav, view, calls, selected };
}
test('three tabs keep a fixed hitbox and shared Qianmu decoration structure', () => {
    const f = fixture();
    assert.equal(f.view.buttons.get('a').getAttribute('aria-selected'), 'true');
    assert.equal(f.view.buttons.get('b').id, 'ym-tab-b');
    f.view.buttons.get('b').click(); assert.deepEqual(f.selected, ['b']);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.options.duration === 360 && call.node.tagName === 'SPAN'));
    const bar = f.nav.children[0]; bar.emit('keydown', { key: 'ArrowRight' }); assert.deepEqual(f.selected, ['b', 'c']);
    assert.equal(f.doc.activeElement, f.view.buttons.get('c')); f.view.destroy(); assert.equal(f.nav.children.length, 0);
});
test('paper and glass preserve the actual 300ms and 380ms animations, reduced motion stays static', () => {
    for (const [theme, count, duration] of [['editorial', 2, 300], ['glass', 1, 380]]) {
        const f = fixture(theme); f.view.select('b'); assert.equal(f.calls.length, count); assert.ok(f.calls.every(call => call.options.duration === duration)); f.view.destroy();
    }
    const f = fixture('glass', true); f.view.select('b'); assert.deepEqual(f.calls, []); f.view.destroy();
});
test('source remains standalone and CSS selection geometry matches Qianmu', async () => {
    const source = await readFile(new URL('../yimu/nav.mjs', import.meta.url), 'utf8'), css = await readFile(new URL('../yimu/style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import|fetch\(|#story-director-modal/m);
    assert.match(css, /width: min\(48px, calc\(100% - 12px\)\); height: 2\.5px/);
    assert.match(css, /\.ym-nav-capsule rect \{ fill: none; stroke: currentColor; stroke-width: 1\.5px/);
    assert.match(css, /\.ym-dialog \.ym-nav-button[^\n]*flex: 1 1 0; min-width: 0/, 'all navigation hitboxes share the full row equally');
    assert.match(css, /\.ym-nav \{[^\n]*width: 100%/);
});
