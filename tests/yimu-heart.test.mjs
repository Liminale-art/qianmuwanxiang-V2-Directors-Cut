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
        assert.match(theme.html, /window\.yimuPaint = /, `${theme.name}：换日期时可以重画`);
        assert.ok(!/占位内容|视觉方案|@@HEART_/.test(theme.html), `${theme.name}：不含方案稿里的占位说明，共用部分已并入`);
        // 字体固定用指定的网络字体（不随设备变）：页面只向外加载这一处的字体样式表，别的一概不加载。
        const outside = theme.html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '').match(/https?:\/\/[^"')\s]+/g) || [];
        assert.ok(outside.length >= 1 && outside.every(url => /^https:\/\/fontsapi\.zeoseven\.com\/\d+\/main\/result\.css$/.test(url)), `${theme.name}：只加载字体样式表`);
        assert.ok(!/<script[^>]+src=|@import/.test(theme.html));
        // 页面在内嵌框里：「#锚点」链接会让内嵌框去加载外面的整个页面（显影切换版块时卡死黑屏的原因）。
        assert.ok(!/href\s*=\s*["']#/.test(theme.html), `${theme.name}：不用锚点链接`);
        // 页面文字由数据填入时先转义；三个版块与日期条都在。
        assert.match(theme.html, /window\.yimuPaint\?\.\(safe\(picked\(YM\.raw\)\), YM\.raw\)/);
        assert.match(theme.html, /id="ym-date"/); assert.match(theme.html, /年\s?表/);
        // 印象、心迹、年表三样各有一个删除入口，「还在留意的」没有；页面发出的是 remove 消息。
        for (const kind of ['impression', 'thought', 'event']) assert.equal(theme.html.split(`\${rm('${kind}', `).length, 2, `${theme.name}：${kind} 各有一处删除入口`);
        assert.equal(theme.html.split('${rm(').length, 4, `${theme.name}：别处没有删除入口`);
        assert.match(theme.html, /parent\.postMessage\(\{ yimuHeart: 'remove', kind: button\.dataset\.rmKind, id: button\.dataset\.rmId \}, '\*'\)/);
        assert.match(theme.html, /\.ym-rm \{ all: unset; position: absolute;/);
    }
});

test('the page gets what is still being noticed, newest first, each with the moment it was written down', () => {
    const data = heartData({ snapshot: { name: '阿澈', userName: '小满', avatarUrl: '/thumb.png' }, document: { observations: [
        { id: 'a', about: '小满', text: '她又点了辣的。', floor: 2, at: Date.UTC(2026, 10, 1), date: '三月初四' }, { id: 'b', about: '店主', text: '他记得她的口味。', floor: 9, at: new Date(2026, 10, 19).getTime() },
        { id: 'c', about: '小满', text: '已经归进印象的不再算留意。', floor: 3, at: 5, used: true }] } });
    assert.deepEqual([data.char, data.user, data.avatar], ['阿澈', '小满', '/thumb.png']);
    assert.deepEqual(data.loose, [{ kind: 'trace', id: 'b', about: '店主', text: '他记得她的口味。', day: '11月19日', floor: 9, at: new Date(2026, 10, 19).getTime() }, { kind: 'trace', id: 'a', about: '小满', text: '她又点了辣的。', day: '三月初四', floor: 2, at: Date.UTC(2026, 10, 1) }]);
    assert.deepEqual([data.impressions, data.thoughts, data.events], [[], [], []]);
    assert.deepEqual(heartData({}).loose, []);
});

test('impressions show once seen on enough different days; fewer days stay under "still noticing"; notes are newest first and the chronicle is in story order', () => {
    const day = n => ({ day: `第${n}天`, text: `第${n}天看见的`, at: n * 1000 });
    const data = heartData({ snapshot: { name: '阿澈', userName: '小满' }, document: { heart: { eventFloor: 0, thoughtFloor: 0,
        impressions: [{ id: 'i1', about: '小满', text: '她离不开辣。', days: [1, 2, 3, 4, 5, 6].map(day), was: '她好像爱吃辣。', at: 1, updatedAt: 6000 },
            { id: 'i2', about: '店主', text: '他好像记得熟客。', days: [1, 2].map(day), at: 1, updatedAt: 2000 }, { id: 'i3', about: '小满', text: '她也许怕冷场。', days: [1, 2, 3].map(day), at: 1, updatedAt: 9000 }],
        thoughts: [{ id: 't1', group: 'you', about: '小满', text: '甲', floor: 30, at: new Date(2026, 10, 2).getTime() }, { id: 't2', group: 'books', about: '雪国', text: '乙', floor: 70, at: new Date(2026, 10, 9).getTime() }],
        events: [{ id: 'e1', title: '相遇', text: '丙', floor: 2, at: 1, date: '三月初四' }, { id: 'e2', title: '约定', text: '丁', floor: 40, at: 2 }] } } });
    assert.deepEqual(data.impressions.map(item => [item.id, item.sure, item.word, item.days.length, item.was]), [['i3', 1, '也许', 3, undefined], ['i1', 3, '笃定', 6, '她好像爱吃辣。']]);
    assert.deepEqual(data.impressions[1].days[0], ['第1天', '第1天看见的']);
    assert.deepEqual(data.loose.map(item => [item.about, item.text, item.day]), [['店主', '他好像记得熟客。', '第2天']]);
    assert.deepEqual(data.thoughts.map(item => [item.id, item.about, item.when, item.say]), [['t2', '读《雪国》', '11月9日', '乙'], ['t1', '对小满', '11月2日', '甲']]);
    assert.deepEqual(data.events.map(item => [item.title, item.date, item.floor]), [['相遇', '三月初四', 2], ['约定', '', 40]]);
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

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const heartState = events => ({ snapshot: { name: '阿澈', userName: '小满' }, document: { heart: { impressions: [], eventFloor: 0, thoughtFloor: 0,
    thoughts: [{ id: 't1', group: 'you', about: '小满', text: '甲', floor: 30, at: 5 }], events: events.map((id, index) => ({ id, title: `节点${id}`, text: '丙', floor: index + 1, at: index + 1 })) } } });

test('a remove message from the page deletes that one item through the panel action, and the page gets the new data once the state has changed', async t => {
    const document = fakeDocument(), calls = [], warned = [];
    const warn = console.warn; console.warn = (...args) => warned.push(args); t.after(() => { console.warn = warn; });
    let state = heartState(['e1', 'e2']), outcome = 'ok';
    // 面板的做法：动作成功时状态先变，面板随即刷新（刷新里会叫 update），之后动作才返回。
    const view = mountHeartView({ document, storage: null, getState: () => state, onAction: async (type, payload) => {
        calls.push([type, payload]);
        if (outcome === 'throw') throw new Error('合成故障');
        if (outcome === 'refused') return false;
        state = heartState(state.document.heart.events.map(item => item.id).filter(id => id !== payload.itemId)); view.update();
        return true;
    } });
    view.update(); assert.equal(document.body.children.length, 0, '没打开时状态变化不做任何事');
    view.open();
    const frame = document.body.children[0].children[0], page = frame.contentWindow;
    frame.listeners.get('load')();
    assert.deepEqual(page.rendered.map(data => data.events.map(item => item.id)), [['e1', 'e2']]);
    const post = (source, data) => document.listeners.get('message')({ source, data });

    post({}, { yimuHeart: 'remove', kind: 'event', id: 'e1' }); await flush();
    assert.deepEqual(calls, [], '不是这一页发来的消息不理会');
    for (const data of [{ yimuHeart: 'remove', kind: 'loose', id: 'e1' }, { yimuHeart: 'remove', kind: 'event' }, { yimuHeart: 'remove', kind: 'event', id: 7 }]) post(page, data);
    await flush(); assert.deepEqual(calls, [], '类别不对或没有标识的不发');

    post(page, { yimuHeart: 'remove', kind: 'event', id: 'e1' }); await flush();
    assert.deepEqual(calls, [['heartRemove', { kind: 'event', itemId: 'e1' }]]);
    assert.deepEqual(page.rendered.map(data => data.events.map(item => item.id)), [['e1', 'e2'], ['e2']], '状态变了之后页面收到新数据，而且只重画一次');
    post(page, { yimuHeart: 'remove', kind: 'thought', id: 't1' }); post(page, { yimuHeart: 'remove', kind: 'impression', id: 'i9' }); await flush();
    assert.deepEqual(calls.slice(1).map(call => call[1]), [{ kind: 'thought', itemId: 't1' }, { kind: 'impression', itemId: 'i9' }]);

    // 面板别处改了数据（比如刚整理完日记）：开着的页面跟着更新；数据没变就不重画。
    const before = page.rendered.length;
    view.update(); assert.equal(page.rendered.length, before);
    state = heartState(['e2', 'e3']); view.update();
    assert.deepEqual(page.rendered.at(-1).events.map(item => item.id), ['e2', 'e3']); assert.equal(page.rendered.length, before + 1);

    // 没删成（被拒绝或出错）：数据原样重交一次，让页面上那个按钮复原；出错留一行记录。
    outcome = 'refused'; post(page, { yimuHeart: 'remove', kind: 'event', id: 'e2' }); await flush();
    assert.equal(page.rendered.length, before + 2); assert.deepEqual(page.rendered.at(-1).events.map(item => item.id), ['e2', 'e3']);
    outcome = 'throw'; post(page, { yimuHeart: 'remove', kind: 'event', id: 'e2' }); await flush();
    assert.equal(page.rendered.length, before + 3); assert.equal(warned.length, 1); assert.match(String(warned[0][1]?.message), /合成故障/);

    // 换了主题是一张新页面：加载好后照常收到数据。关掉以后不再理会。
    post(page, { yimuHeart: 'theme' });
    const next = document.body.children[0].children[0]; next.listeners.get('load')();
    assert.deepEqual(next.contentWindow.rendered.map(data => data.events.map(item => item.id)), [['e2', 'e3']]);
    view.close(); state = heartState([]); view.update();
    assert.equal(next.contentWindow.rendered.length, 1);
});

test('on the page the small × asks once more before sending; a click elsewhere or a few seconds cancel it', async () => {
    const source = await readFile(new URL('../yimu/heart/shared.js', import.meta.url), 'utf8');
    const handlers = [], sent = [], timers = [];
    const stub = () => ({ addEventListener() {}, innerHTML: '' });
    const fakeDocument = { getElementById: () => stub(), addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture: capture === true }) };
    const run = new Function('document', 'parent', 'addEventListener', 'window', 'setTimeout', 'clearTimeout', `${source}\nreturn { rm };`);
    const page = run(fakeDocument, { postMessage: (data, target) => sent.push([data, target]) }, () => {}, {}, fn => { timers.push(fn); return timers.length; }, () => {});
    assert.equal(page.rm('event', 'op_e0'), '<button type="button" class="ym-rm" data-rm-kind="event" data-rm-id="op_e0" aria-label="删除">×</button>');
    assert.equal(page.rm('event', ''), '', '没有标识的条目不给删除入口');
    const capture = handlers.find(item => item.type === 'click' && item.capture).fn;
    const button = (kind, id) => { const node = { dataset: { rmKind: kind, rmId: id }, attrs: { 'aria-label': '删除' }, textContent: '×', disabled: false,
        setAttribute(key, value) { this.attrs[key] = String(value); }, removeAttribute(key) { delete this.attrs[key]; }, closest: selector => selector === '.ym-rm' ? node : null }; return node; };
    const click = target => { const event = { target, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } }; capture(event); return event; };
    const first = button('thought', 't1'), second = button('event', 'e1');
    assert.equal(click(first).stopped, true, '点删除不会连带触发条目自己的展开');
    assert.deepEqual([first.textContent, first.attrs['data-armed'], sent.length], ['再点删除', 'true', 0]);
    click(second);
    assert.deepEqual([first.textContent, first.attrs['data-armed'], second.textContent], ['×', undefined, '再点删除'], '同时只有一条在等确认');
    assert.equal(click({ closest: () => null }).stopped, false); assert.equal(second.textContent, '×', '点别处就取消');
    click(second); timers.at(-1)(); assert.equal(second.textContent, '×', '几秒不点也取消'); assert.equal(sent.length, 0);
    click(second); click(second);
    assert.deepEqual(sent, [[{ yimuHeart: 'remove', kind: 'event', id: 'e1' }, '*']]); assert.equal(second.disabled, true); assert.equal(second.textContent, '×');
});

test('the floor line under the date bar reads 本卷同叙 N 节・共织故事 M 章, and goes away when there is no total', async () => {
    const source = await readFile(new URL('../yimu/heart/shared.js', import.meta.url), 'utf8');
    const make = () => { const node = { children: [], textContent: '', removed: false,
        append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, remove() { this.removed = true; placed = null; },
        get text() { return this.children.map(item => typeof item === 'string' ? item : item.children.length ? item.text : item.textContent).join(''); } }; return node; };
    let placed = null;
    const host = { addEventListener() {}, innerHTML: '', after(node) { placed = node; } };
    const fakeDocument = { getElementById: id => id === 'ym-floors' ? placed : host, addEventListener() {}, createElement: make };
    const page = {};
    new Function('document', 'parent', 'addEventListener', 'window', source)(fakeDocument, { postMessage() {} }, () => {}, page);
    page.yimuRender({ floors: { chat: 12, total: 340 } });
    assert.equal(placed.text, '本卷同叙 12 节・共织故事 340 章');
    page.yimuRender({ floors: { chat: 0, total: 7 } });
    assert.equal(placed.text, '本卷同叙 0 节・共织故事 7 章', '本聊天还没有楼层时照样两段都写');
    page.yimuRender({});
    assert.equal(placed, null, '没有累计数就不显示这一行');
});
