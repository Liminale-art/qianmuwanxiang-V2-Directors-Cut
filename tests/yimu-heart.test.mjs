// 心迹与观察日记：全屏独立页面的开合、三套主题的切换，以及主题模块与源文件一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEART_THEMES } from '../yimu/heart-themes.mjs';
import { mountHeartView, heartData } from '../yimu/heart-view.mjs';
import { renderHeartThemes, HEART_THEME_SOURCES } from '../scripts/generate-yimu-heart.mjs';
import { readFile } from 'node:fs/promises';

test('the bundled themes are exactly what the theme sources say; the default is 燕尾蝶', async () => {
    assert.equal(await readFile(new URL('../yimu/heart-themes.mjs', import.meta.url), 'utf8'), await renderHeartThemes(), '改了 yimu/heart/ 要重新运行 scripts/generate-yimu-heart.mjs');
    assert.deepEqual(HEART_THEMES.map(theme => [theme.id, theme.name]), [['yanweidie', '燕尾蝶'], ['xianying', '显影'], ['sujian', '素笺']]);
    assert.equal(HEART_THEME_SOURCES.length, 3);
    for (const theme of HEART_THEMES) {
        assert.match(theme.html, /id="ym-exit"[^>]*aria-label="退出"/, `${theme.name}：左上角退出`);
        assert.match(theme.html, /id="ym-theme"[^>]*aria-label="切换主题"/, `${theme.name}：右上角切换主题`);
        assert.match(theme.html, /window\.yimuRender = raw =>/);
        assert.ok(!/占位内容|视觉方案/.test(theme.html), `${theme.name}：不含方案稿里的占位说明`);
        assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//.test(theme.html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `${theme.name}：不向外加载任何东西`);
        // 页面文字由数据填入时先转义。
        assert.match(theme.html, /const D = safe\(raw \|\| \{\}\)/);
    }
});

test('the page gets the traces of this chat, newest first; impressions and heart notes are not generated yet', () => {
    const data = heartData({ snapshot: { name: '阿澈', userName: '小满', avatarUrl: '/thumb.png' }, document: { observations: [
        { id: 'a', about: '小满', text: '她又点了辣的。', floor: 2, at: Date.UTC(2026, 10, 1), date: '三月初四' }, { id: 'b', about: '店主', text: '他记得她的口味。', floor: 9, at: new Date(2026, 10, 19).getTime() }] } });
    assert.deepEqual([data.char, data.user, data.avatar], ['阿澈', '小满', '/thumb.png']);
    assert.deepEqual(data.loose, [{ about: '店主', text: '他记得她的口味。', day: '11月19日', floor: 9 }, { about: '小满', text: '她又点了辣的。', day: '三月初四', floor: 2 }]);
    assert.deepEqual([data.impressions, data.thoughts], [[], []]);
    assert.deepEqual(heartData({}).loose, []);
});

function fakeDocument() {
    const listeners = new Map(), body = { children: [], append(node) { node.parent = this; this.children.push(node); } };
    const make = tag => ({ tagName: tag.toUpperCase(), attrs: {}, dataset: {}, children: [], listeners: new Map(), setAttribute(key, value) { this.attrs[key] = String(value); },
        addEventListener(name, fn) { this.listeners.set(name, fn); }, append(node) { node.parent = this; this.children.push(node); },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }, contentWindow: { rendered: [], yimuRender(data) { this.rendered.push(data); } } });
    return { body, createElement: make, querySelector: () => null, defaultView: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }, listeners };
}

test('opening goes full screen in its own frame; the top-right button cycles the three themes and the choice is remembered; top-left exits', () => {
    const document = fakeDocument(), store = new Map();
    const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
    const view = mountHeartView({ document, storage, getState: () => ({ snapshot: { name: '阿澈' }, document: { observations: [] } }) });
    assert.equal(view.opened, false); assert.equal(view.theme, 'yanweidie');
    view.open(); view.open();
    assert.equal(document.body.children.length, 1, '只开一层');
    const layer = document.body.children[0]; assert.equal(layer.className, 'ym-heart-layer');
    let frame = layer.children[0];
    assert.equal(frame.tagName, 'IFRAME'); assert.equal(frame.dataset.theme, 'yanweidie'); assert.equal(frame.srcdoc, HEART_THEMES[0].html);
    frame.listeners.get('load')(); assert.equal(frame.contentWindow.rendered[0].char, '阿澈', '页面加载好后把数据交给它');
    const post = (source, data) => document.listeners.get('message')({ source, data });
    post({}, { yimuHeart: 'exit' }); assert.equal(view.opened, true, '不是这一页发来的消息不理会');
    post(frame.contentWindow, { yimuHeart: 'theme' });
    frame = layer.children[0]; assert.equal(layer.children.length, 1); assert.equal(frame.dataset.theme, 'xianying'); assert.equal(store.get('yimu:heart-theme:v1'), 'xianying');
    post(frame.contentWindow, { yimuHeart: 'theme' }); frame = layer.children[0]; assert.equal(frame.dataset.theme, 'sujian');
    post(frame.contentWindow, { yimuHeart: 'theme' }); frame = layer.children[0]; assert.equal(frame.dataset.theme, 'yanweidie', '三套轮着换');
    post(frame.contentWindow, { yimuHeart: 'theme' }); frame = layer.children[0];
    post(frame.contentWindow, { yimuHeart: 'exit' });
    assert.equal(view.opened, false); assert.equal(document.body.children.length, 0); assert.equal(document.listeners.has('message'), false);
    // 下次打开用上次选的主题；本机存储不可用时用默认的。
    assert.equal(mountHeartView({ document: fakeDocument(), storage }).theme, 'xianying');
    assert.equal(mountHeartView({ document: fakeDocument(), storage: { getItem() { throw new Error('blocked'); } } }).theme, 'yanweidie');
});
