// 头像清晰化：缩略图地址换成原图地址；取不到原图时退回缩略图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharpImageUrl, sharpBackground, startSharpAvatars } from '../qianmu-sharp-avatars.js';

const BASE = 'http://127.0.0.1:8000/';

test('avatar and persona thumbnails map to the original files; everything else is left alone', () => {
    assert.equal(sharpImageUrl('/thumbnail?type=avatar&file=Alice%20B.png', BASE), '/characters/Alice%20B.png');
    assert.equal(sharpImageUrl('thumbnail?type=persona&file=me.png&t=17', BASE), '/User%20Avatars/me.png?t=17');
    assert.equal(sharpImageUrl('http://127.0.0.1:8000/st/thumbnail?type=avatar&file=%E9%98%BF%E6%BE%88.png', BASE), '/st/characters/%E9%98%BF%E6%BE%88.png', 'a sub-path install keeps its prefix');
    assert.equal(sharpImageUrl('/thumbnail?type=bg&file=sky.jpg', BASE), '', 'background thumbnails stay: they only fill the picker list');
    assert.equal(sharpImageUrl('/thumbnail?type=avatar&file=../secrets.json', BASE), '');
    assert.equal(sharpImageUrl('/thumbnail?type=avatar', BASE), '');
    assert.equal(sharpImageUrl('https://elsewhere.example/thumbnail?type=avatar&file=a.png', BASE), '', 'other sites are not ours to rewrite');
    assert.equal(sharpImageUrl('/characters/Alice.png', BASE), '');
    assert.equal(sharpImageUrl('/img/thumbnail-placeholder.png', BASE), '');
    assert.equal(sharpImageUrl(null, BASE), '');
    assert.equal(sharpBackground('url("/thumbnail?type=avatar&file=a.png"), url(/img/x.png)', BASE), 'url("/characters/a.png"), url(/img/x.png)');
    assert.equal(sharpBackground('url(/img/x.png)', BASE), '');
    assert.equal(sharpBackground('url("/thumbnail?type=avatar&file=a.png")', BASE, new Set(['/characters/a.png'])), '', 'an original that failed once is not tried again');
});

function image(src) {
    const node = { nodeType: 1, tagName: 'IMG', attrs: { src }, listeners: {}, style: {},
        getAttribute(name) { return this.attrs[name] ?? null; }, setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(name, run) { this.listeners[name] = run; }, querySelectorAll: () => [] };
    return node;
}

test('existing and later images are swapped; a missing original falls back to the thumbnail for good', () => {
    const first = image('/thumbnail?type=avatar&file=a.png'), plain = image('/img/logo.png');
    const styled = { nodeType: 1, tagName: 'DIV', style: { backgroundImage: 'url("/thumbnail?type=persona&file=me.png")' }, querySelectorAll: () => [] };
    const root = { nodeType: 1, tagName: 'HTML', style: {}, querySelectorAll: selector => selector.startsWith('img') ? [first, plain] : [styled] };
    let observer = null;
    class Observer { constructor(run) { this.run = run; observer = this; } observe(target, options) { this.options = options; } disconnect() { this.off = true; } }
    const stop = startSharpAvatars({ document: { documentElement: root, baseURI: BASE }, window: { MutationObserver: Observer } });
    assert.equal(first.attrs.src, '/characters/a.png'); assert.equal(plain.attrs.src, '/img/logo.png');
    assert.equal(styled.style.backgroundImage, 'url("/User%20Avatars/me.png")');
    assert.deepEqual(observer.options.attributeFilter, ['src', 'style']);
    // 之后插入的节点、之后改了地址的图片。
    const later = image('/thumbnail?type=avatar&file=b.png');
    observer.run([{ type: 'childList', addedNodes: [later, { nodeType: 3 }] }]);
    assert.equal(later.attrs.src, '/characters/b.png');
    first.attrs.src = '/thumbnail?type=avatar&file=c.png'; observer.run([{ type: 'attributes', target: first }]);
    assert.equal(first.attrs.src, '/characters/c.png');
    // 原图取不到：退回缩略图；退回引起的那次变动不会再把它换回去。
    later.listeners.error();
    assert.equal(later.attrs.src, '/thumbnail?type=avatar&file=b.png');
    observer.run([{ type: 'attributes', target: later }]);
    assert.equal(later.attrs.src, '/thumbnail?type=avatar&file=b.png');
    const same = image('/thumbnail?type=avatar&file=b.png'); observer.run([{ type: 'childList', addedNodes: [same] }]);
    assert.equal(same.attrs.src, '/thumbnail?type=avatar&file=b.png', 'the same missing file is not tried again elsewhere');
    stop(); assert.equal(observer.off, true);
    assert.equal(typeof startSharpAvatars({ document: {}, window: {} }), 'function', 'no document or observer: nothing to do, nothing thrown');
});
