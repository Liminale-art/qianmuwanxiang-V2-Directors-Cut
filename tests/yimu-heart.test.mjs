// 心迹与观察日记：全屏独立页面的开合、三套主题的切换，以及主题模块与源文件一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEART_THEMES } from '../yimu/heart-themes.mjs';
import { mountHeartView, heartData } from '../yimu/heart-view.mjs';
import { renderHeartThemes, HEART_THEME_SOURCES } from '../scripts/generate-yimu-heart.mjs';
import { readFile } from 'node:fs/promises';

test('the bundled themes are exactly what the theme sources say; the default is 素笺', async () => {
    assert.equal(await readFile(new URL('../yimu/heart-themes.mjs', import.meta.url), 'utf8'), await renderHeartThemes(), '改了 yimu/heart/ 要重新运行 scripts/generate-yimu-heart.mjs');
    assert.deepEqual(HEART_THEMES.map(theme => [theme.id, theme.name]), [['sujian', '素笺'], ['xianying', '显影']]);
    assert.equal(HEART_THEME_SOURCES.length, 2);
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
        // 笔和叉由同一个小框（.ym-acts）摆位置：主题写位置时连小框一起写。
        assert.match(theme.html, /:is\(\.ym-acts, \.ym-rm\) \{ top: /, `${theme.name}：位置写给小框`);
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

test('impressions show once seen on enough different days; fewer days stay under "still noticing"; notes and the chronicle are newest first', () => {
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
    assert.deepEqual(data.events.map(item => [item.title, item.date, item.floor]), [['约定', '', 40], ['相遇', '三月初四', 2]], '年表按楼层倒着排，最新的在上');
});

function fakeDocument() {
    const listeners = new Map(), body = { children: [], append(node) { node.parent = this; this.children.push(node); } };
    const make = tag => ({ tagName: tag.toUpperCase(), attrs: {}, dataset: {}, children: [], listeners: new Map(), setAttribute(key, value) { this.attrs[key] = String(value); },
        addEventListener(name, fn) { this.listeners.set(name, fn); }, append(node) { node.parent = this; this.children.push(node); },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }, contentWindow: { rendered: [], yimuRender(data) { this.rendered.push(data); } } });
    return { body, createElement: make, querySelector: () => null, defaultView: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }, listeners };
}

test('opening goes full screen in its own frame; the top-right button cycles the themes and the choice is remembered; top-left exits', () => {
    const document = fakeDocument(), store = new Map();
    const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
    const view = mountHeartView({ document, storage, getState: () => ({ snapshot: { name: '阿澈' }, document: { observations: [] } }) });
    assert.equal(view.opened, false); assert.equal(view.theme, 'sujian');
    view.open(); view.open();
    assert.equal(document.body.children.length, 1, '只开一层');
    const layer = document.body.children[0]; assert.equal(layer.className, 'ym-heart-layer');
    let frame = layer.children[0];
    assert.equal(frame.tagName, 'IFRAME'); assert.equal(frame.dataset.theme, 'sujian'); assert.equal(frame.srcdoc, HEART_THEMES[0].html);
    frame.listeners.get('load')(); assert.equal(frame.contentWindow.rendered[0].char, '阿澈', '页面加载好后把数据交给它');
    const post = (source, data) => document.listeners.get('message')({ source, data });
    post({}, { yimuHeart: 'exit' }); assert.equal(view.opened, true, '不是这一页发来的消息不理会');
    post(frame.contentWindow, { yimuHeart: 'theme' });
    frame = layer.children[0]; assert.equal(layer.children.length, 1); assert.equal(frame.dataset.theme, 'xianying'); assert.equal(store.get('yimu:heart-theme:v1'), 'xianying');
    post(frame.contentWindow, { yimuHeart: 'theme' }); frame = layer.children[0]; assert.equal(frame.dataset.theme, 'sujian', '两套轮着换');
    post(frame.contentWindow, { yimuHeart: 'theme' }); frame = layer.children[0];
    post(frame.contentWindow, { yimuHeart: 'exit' });
    assert.equal(view.opened, false); assert.equal(document.body.children.length, 0); assert.equal(document.listeners.has('message'), false);
    // 下次打开用上次选的主题；本机存储不可用时用默认的。
    assert.equal(mountHeartView({ document: fakeDocument(), storage }).theme, 'xianying');
    assert.equal(mountHeartView({ document: fakeDocument(), storage: { getItem() { throw new Error('blocked'); } } }).theme, 'sujian');
    // 记着的是已经撤掉的那套主题：落到默认的素笺，照常打开。
    const gone = mountHeartView({ document: fakeDocument(), storage: { getItem: () => 'yanweidie', setItem() {} } });
    assert.equal(gone.theme, 'sujian'); gone.open(); assert.equal(gone.opened, true);
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
    assert.deepEqual(page.rendered.map(data => data.events.map(item => item.id)), [['e2', 'e1']]);
    const post = (source, data) => document.listeners.get('message')({ source, data });

    post({}, { yimuHeart: 'remove', kind: 'event', id: 'e1' }); await flush();
    assert.deepEqual(calls, [], '不是这一页发来的消息不理会');
    for (const data of [{ yimuHeart: 'remove', kind: 'loose', id: 'e1' }, { yimuHeart: 'remove', kind: 'event' }, { yimuHeart: 'remove', kind: 'event', id: 7 }]) post(page, data);
    await flush(); assert.deepEqual(calls, [], '类别不对或没有标识的不发');

    post(page, { yimuHeart: 'remove', kind: 'event', id: 'e1' }); await flush();
    assert.deepEqual(calls, [['heartRemove', { kind: 'event', itemId: 'e1' }]]);
    assert.deepEqual(page.rendered.map(data => data.events.map(item => item.id)), [['e2', 'e1'], ['e2']], '状态变了之后页面收到新数据，而且只重画一次');
    post(page, { yimuHeart: 'remove', kind: 'thought', id: 't1' }); post(page, { yimuHeart: 'remove', kind: 'impression', id: 'i9' }); await flush();
    assert.deepEqual(calls.slice(1).map(call => call[1]), [{ kind: 'thought', itemId: 't1' }, { kind: 'impression', itemId: 'i9' }]);

    // 面板别处改了数据（比如刚整理完日记）：开着的页面跟着更新；数据没变就不重画。
    const before = page.rendered.length;
    view.update(); assert.equal(page.rendered.length, before);
    state = heartState(['e2', 'e3']); view.update();
    assert.deepEqual(page.rendered.at(-1).events.map(item => item.id), ['e3', 'e2']); assert.equal(page.rendered.length, before + 1);

    // 没删成（被拒绝或出错）：数据原样重交一次，让页面上那个按钮复原；出错留一行记录。
    outcome = 'refused'; post(page, { yimuHeart: 'remove', kind: 'event', id: 'e2' }); await flush();
    assert.equal(page.rendered.length, before + 2); assert.deepEqual(page.rendered.at(-1).events.map(item => item.id), ['e3', 'e2']);
    outcome = 'throw'; post(page, { yimuHeart: 'remove', kind: 'event', id: 'e2' }); await flush();
    assert.equal(page.rendered.length, before + 3); assert.equal(warned.length, 1); assert.match(String(warned[0][1]?.message), /合成故障/);

    // 换了主题是一张新页面：加载好后照常收到数据。关掉以后不再理会。
    post(page, { yimuHeart: 'theme' });
    const next = document.body.children[0].children[0]; next.listeners.get('load')();
    assert.deepEqual(next.contentWindow.rendered.map(data => data.events.map(item => item.id)), [['e3', 'e2']]);
    view.close(); state = heartState([]); view.update();
    assert.equal(next.contentWindow.rendered.length, 1);
});

test('on the page one click on the small × deletes that entry straight away, without opening the entry', async () => {
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
    assert.deepEqual(sent, [[{ yimuHeart: 'remove', kind: 'thought', id: 't1' }, '*']], '点一下就删，不再问一次');
    assert.deepEqual([first.disabled, first.textContent, first.attrs['data-armed']], [true, '×', undefined]);
    assert.equal(click({ closest: () => null }).stopped, false); assert.equal(sent.length, 1, '点别处什么都不发');
    click(second);
    assert.deepEqual(sent.at(-1), [{ yimuHeart: 'remove', kind: 'event', id: 'e1' }, '*']); assert.equal(second.disabled, true);
});

test('the pen and the × sit side by side in one small box, also in sections that are hidden when the page is drawn', async () => {
    const source = await readFile(new URL('../yimu/heart/shared.js', import.meta.url), 'utf8');
    // 简易元素：没切到的版块是隐藏的，量出来的宽都是 0。
    const element = (tag, className = '') => ({ tagName: tag.toUpperCase(), className, dataset: {}, attrs: {}, children: [], parentElement: null, offsetWidth: 0, style: {},
        classList: { contains(name) { return this.owner.className.split(' ').includes(name); } },
        setAttribute(key, value) { this.attrs[key] = String(value); },
        append(...nodes) { for (const node of nodes) { node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1); node.parentElement = this; this.children.push(node); } },
        before(node) { const parent = this.parentElement; node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, node); } });
    const make = (tag, className) => { const node = element(tag, className); node.classList.owner = node; return node; };
    const entries = ['impression', 'thought', 'event'].map(kind => { const item = make('article'), rm = make('button', 'ym-rm'); rm.dataset.rmKind = kind; rm.dataset.rmId = `${kind}-1`; item.append(rm); return { item, rm }; });
    const stub = () => ({ addEventListener() {}, innerHTML: '' });
    const fakeDocument = { getElementById: id => id === 'ym-floors' ? null : stub(), addEventListener() {}, createElement: tag => make(tag),
        querySelectorAll: selector => selector === '.ym-rm:not(.ym-rmq)' ? entries.map(entry => entry.rm) : [] };
    const page = {};
    new Function('document', 'parent', 'addEventListener', 'window', source)(fakeDocument, { postMessage() {} }, () => {}, page);
    page.yimuRender({ events: [{ id: 'event-1', at: 1 }] });
    page.yimuRender({ events: [{ id: 'event-1', at: 1 }] });
    for (const { item, rm } of entries) {
        assert.equal(item.children.length, 1, '条目里只有一个小框，重画不会再套一层');
        const box = item.children[0];
        assert.equal(box.className, 'ym-acts');
        assert.deepEqual(box.children.map(node => node.className), ['ym-ed', 'ym-rm'], '笔在左、叉在右，同在一个框里');
        assert.equal(box.children[1], rm); assert.deepEqual(box.children[0].dataset, { edKind: rm.dataset.rmKind, edId: rm.dataset.rmId });
        assert.deepEqual(box.children[0].style, {}, '笔的位置不靠量出来的宽');
    }
    const css = await readFile(new URL('../yimu/heart/shared.css', import.meta.url), 'utf8');
    assert.match(css, /\.ym-acts \{ position: absolute;[^}]*display: flex;/);
    assert.match(css, /\.ym-acts > \.ym-rm\.ym-rm \{ position: static; \}/);
    assert.ok(!/\.ym-ed \{[^}]*position: absolute/.test(css), '笔自己不再单独定位');
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

// 简易页面：元素只认「.类名」「#编号」两种 closest／querySelector；querySelectorAll 由各测试按选择器给。
function miniPage(source, pick) {
    const handlers = [], sent = [], timers = [];
    const element = (tag, className = '') => {
        const node = { tagName: tag.toUpperCase(), className, id: '', dataset: {}, attrs: {}, children: [], parentElement: null, disabled: false, textContent: '', hidden: false,
            setAttribute(key, value) { this.attrs[key] = String(value); }, removeAttribute(key) { delete this.attrs[key]; }, hasAttribute(key) { return key in this.attrs; },
            append(...nodes) { for (const child of nodes) { child.parentElement = this; this.children.push(child); } },
            remove() { const parent = this.parentElement; if (parent) parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; },
            before(child) { child.remove(); const parent = this.parentElement; child.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, child); },
            matches(selector) { return selector.split(',').map(part => part.trim()).some(part => part.startsWith('#') ? this.id === part.slice(1) : part.startsWith('.') ? this.className.split(' ').includes(part.slice(1)) : this.tagName === part.toUpperCase()); },
            closest(selector) { for (let at = this; at; at = at.parentElement) if (at.matches(selector)) return at; return null; },
            querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const deep = child.querySelector(selector); if (deep) return deep; } return null; },
            querySelectorAll(selector) { const found = []; for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; },
            classList: null };
        node.classList = { contains: name => node.className.split(' ').includes(name) };
        return node;
    };
    const stub = () => ({ addEventListener() {}, innerHTML: '' });
    const fakeDocument = { getElementById: id => id === 'ym-floors' ? null : stub(), createElement: tag => element(tag), querySelectorAll: selector => pick(selector) || [],
        addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture: capture === true }) };
    const page = {};
    new Function('document', 'parent', 'addEventListener', 'window', 'setTimeout', 'clearTimeout', 'matchMedia', source)(fakeDocument, { postMessage: data => sent.push(data) }, () => {}, page,
        fn => { timers.push(fn); return timers.length; }, () => {}, undefined);
    // 和浏览器一样：先跑捕获阶段的，再跑冒泡阶段的；同一处的监听都会跑到。
    const click = target => { const event = { target, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
        for (const { fn } of handlers.filter(item => item.type === 'click' && item.capture)) fn(event);
        if (!event.stopped) for (const { fn } of handlers.filter(item => item.type === 'click' && !item.capture)) fn(event); return event; };
    return { page, sent, timers, click, element };
}

test('after a click on ×, that entry waits (faded, nothing clickable) until the panel hands the data back; other entries stay as they are', async () => {
    const source = await readFile(new URL('../yimu/heart/shared.js', import.meta.url), 'utf8');
    let rms = [];
    const { page, sent, timers, click, element } = miniPage(source, selector => selector === '.ym-rm' ? rms : []);
    const entry = (kind, id) => { const item = element('article'), acts = element('span', 'ym-acts'), pen = element('button', 'ym-ed'), rm = element('button', 'ym-rm');
        rm.dataset.rmKind = kind; rm.dataset.rmId = id; rm.textContent = '×'; item.append(acts); acts.append(pen, rm); return { item, pen, rm }; };
    const first = entry('impression', 'i1'), second = entry('event', 'e1');
    rms = [first.rm, second.rm];
    page.yimuRender({ impressions: [{ id: 'i1', at: 1 }], events: [{ id: 'e1', at: 1 }] });
    click(first.rm);
    assert.deepEqual(sent, [{ yimuHeart: 'remove', kind: 'impression', id: 'i1' }]);
    assert.ok('data-ym-busy' in first.item.attrs && first.item.attrs['aria-busy'] === 'true', '那一条进入处理中');
    assert.ok(first.rm.disabled && first.pen.disabled && 'data-busy' in first.rm.attrs, '笔和叉都不能再点，叉换成等待记号');
    assert.equal(first.rm.textContent, '×', '叉的字不改（等待记号由样式画），位置不动');
    assert.ok(!('data-ym-busy' in second.item.attrs) && !second.rm.disabled, '别的条目照常');
    click(first.rm); assert.equal(sent.length, 1, '处理中再点不会再发');
    // 面板把数据重交过来（没删成时原样重交）：重画出来的这一条又能点了。
    const again = entry('impression', 'i1'); rms = [again.rm, second.rm];
    page.yimuRender({ impressions: [{ id: 'i1', at: 1 }], events: [{ id: 'e1', at: 1 }] });
    assert.ok(!('data-ym-busy' in again.item.attrs) && !again.rm.disabled);
    // 一直没有回音：过一会儿也恢复（定时器里重画，不再标处理中）。
    click(again.rm); const late = entry('impression', 'i1'); rms = [late.rm, second.rm];
    timers.at(-1)(); assert.ok(!('data-ym-busy' in late.item.attrs) && !late.rm.disabled);
});

test('「待凝定的印象」: each item gets a pen next to its ×, the title gets 清空 (click twice) that clears only this column, and its items can be edited', async () => {
    const source = await readFile(new URL('../yimu/heart/shared.js', import.meta.url), 'utf8');
    let title = null, rmqs = [], looses = [];
    const pick = selector => ({ '.drift h4, .strip-label': title ? [title] : [], '.ym-rmq': rmqs, '.ym-rm': rmqs, '.ym-loose': looses, '.ym-clear-loose': title ? title.querySelectorAll('.ym-clear-loose') : [] })[selector];
    const { page, sent, click, element } = miniPage(`${source}\nwindow.sheetItem = sheetItem; window.sheetFields = sheetFields;`, pick);
    title = element('h4');
    const loose = (kind, id) => { const item = element('span', 'ym-loose'), rm = element('button', 'ym-rm ym-rmq'); rm.dataset.rmKind = kind; rm.dataset.rmId = id; item.append(rm); return { item, rm }; };
    const trace = loose('trace', 't1'), unformed = loose('impression', 'i9');
    rmqs = [trace.rm, unformed.rm]; looses = [trace.item, unformed.item];
    const data = { tools: { ready: true, pending: 1 }, impressions: [{ id: 'i1', about: '甲', say: '已凝定', at: 1 }],
        loose: [{ kind: 'trace', id: 't1', about: '乙', text: '她又点了辣的。', at: 2 }, { kind: 'impression', id: 'i9', about: '丙', text: '他好像在等谁。', at: 3 }] };
    page.yimuRender(data);
    for (const { item, rm } of [trace, unformed]) {
        const box = item.children[0];
        assert.equal(box.className, 'ym-acts ym-actsq', '小笔小叉放进字后面的小框');
        assert.deepEqual(box.children.map(node => node.className), ['ym-ed', 'ym-rm ym-rmq']);
        assert.deepEqual(box.children[0].dataset, { edKind: rm.dataset.rmKind, edId: rm.dataset.rmId });
    }
    assert.deepEqual(title.children.map(node => [node.className, node.textContent]), [['ym-bind', '合订'], ['ym-clear-loose', '清空']]);
    // 改：痕迹与还没凝定的印象都按原来的字段（写的是谁、内容）放进小纸条。
    assert.deepEqual(page.sheetItem('trace', 't1'), { item: { about: '乙', say: '她又点了辣的。' }, name: '印象' });
    assert.deepEqual(page.sheetItem('impression', 'i9'), { item: { about: '丙', say: '他好像在等谁。' }, name: '印象' });
    assert.equal(page.sheetItem('impression', 'i1').name, '日记', '存照里的印象照旧');
    assert.equal(page.sheetItem('trace', 'nope'), null);
    assert.deepEqual([...page.sheetFields('trace', page.sheetItem('trace', 't1').item).matchAll(/name="(\w+)"/g)].map(match => match[1]), ['about', 'text']);
    // 清空：点一下变「再点清空」，点别处收回；再点才发，这一栏处理中，存照不动。
    click(title.children[1]);
    assert.deepEqual([title.children[1].textContent, sent.length], ['再点清空', 0]);
    click(element('div')); assert.equal(title.children[1].textContent, '清空', '点别处收回');
    click(title.children[1]); click(title.children[1]);
    assert.deepEqual(sent, [{ yimuHeart: 'clearLoose' }]);
    const [bind, wipe] = title.children;
    assert.deepEqual([wipe.textContent, wipe.disabled, bind.disabled], ['清空中', true, true]);
    assert.ok([trace.item, unformed.item].every(item => 'data-ym-busy' in item.attrs), '整栏处理中');
    page.yimuRender({ ...data, loose: [] });
    assert.deepEqual(title.children.map(node => node.className), ['ym-bind'], '这一栏没有条目了就不出清空');
});
