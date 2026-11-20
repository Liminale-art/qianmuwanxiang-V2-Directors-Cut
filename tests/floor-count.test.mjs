// 楼层计数：只增不减、按角色记、所有聊天合计；微醺记录的楼层排行与红线；心迹页的两个数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FLOOR_KEY, normalizeFloors, recordChat, recordList, chatFloors, floorTotal, floorRanking, createFloorCounter } from '../qianmu-floor-count.js';
import { usageMarkup, threadMarkup } from '../qianmu-usage-view.js';
import { heartData } from '../yimu/heart-view.mjs';

test('the copy shipped with Yimu is the same file', async () => {
    const [a, b] = await Promise.all(['../qianmu-floor-count.js', '../yimu/floor-count.mjs'].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
    assert.equal(a.replace(/\r\n/g, '\n'), b.replace(/\r\n/g, '\n'));
});

test('a chat only ever counts up; deleting floors or the chat file never lowers the total', () => {
    const store = normalizeFloors(null);
    assert.equal(recordChat(store, 'A.png', { file: 'chat one.jsonl', count: 30, name: '阿澈' }), true);
    assert.equal(recordChat(store, 'A.png', { file: 'chat one', count: 12 }), false, 'floors were deleted: the high-water mark stays');
    assert.equal(chatFloors(store, 'A.png', 'chat one'), 30);
    recordChat(store, 'A.png', { file: 'chat one', count: 31 }); recordChat(store, 'A.png', { file: 'chat two', count: 8 });
    assert.equal(floorTotal(store, 'A.png'), 39);
    // 酒馆的聊天列表：chat one 已经被删掉了，列表里只剩 chat two 和一个没打开过的聊天。
    assert.equal(recordList(store, 'A.png', [{ file_name: 'chat two.jsonl', chat_items: 9 }, { file_name: 'old branch.jsonl', chat_items: 100 }, { file_name: 'empty.jsonl', chat_items: 0 }]), true);
    assert.equal(floorTotal(store, 'A.png'), 31 + 9 + 100, 'the deleted chat still counts; every chat window is included');
    assert.equal(recordList(store, 'A.png', [{ file_name: 'chat two.jsonl', chat_items: 9 }]), false);
    assert.equal(floorTotal(store, 'B.png'), 0); assert.equal(chatFloors(store, 'A.png', 'nope'), 0);
    assert.equal(recordChat(store, '', { file: 'x', count: 3 }), false); assert.equal(recordChat(store, 'A.png', { file: '', count: 3 }), false);
});

test('a renamed chat is recognised by its own id and is not counted twice', () => {
    const store = normalizeFloors(null);
    recordChat(store, 'A.png', { file: 'before', count: 40, id: 'uuid-1' });
    recordChat(store, 'A.png', { file: 'after', count: 41, id: 'uuid-1' });
    assert.equal(floorTotal(store, 'A.png'), 41); assert.equal(chatFloors(store, 'A.png', 'before'), 0);
    // 列表先看到了新名字（还不知道是同一个），打开后才认出来：合成一份。
    recordList(store, 'A.png', [{ file_name: 'third.jsonl', chat_items: 41 }]);
    assert.equal(floorTotal(store, 'A.png'), 82);
    recordChat(store, 'A.png', { file: 'third', count: 41, id: 'uuid-1' });
    assert.equal(floorTotal(store, 'A.png'), 41);
});

test('stored counts survive a round trip and broken parts are dropped without throwing', () => {
    const store = normalizeFloors(null); recordChat(store, 'A.png', { file: 'c', count: 5, id: 'i', name: '阿澈' });
    assert.deepEqual(normalizeFloors(JSON.parse(JSON.stringify(store))), store);
    assert.deepEqual(normalizeFloors({ chars: { 'A.png': { chats: { c: -3, d: 'x', e: 2.5, f: 7 }, ids: { i: 'gone', j: 'f' } }, '': {}, 'B.png': 7 } }).chars, { 'A.png': { name: '', chats: { f: 7 }, ids: { j: 'f' } }, 'B.png': { name: '', chats: {}, ids: {} } });
    assert.deepEqual(normalizeFloors('nonsense'), { version: 1, chars: {} });
    recordChat(store, 'B.png', { file: 'c', count: 50, name: '店主' });
    assert.deepEqual(floorRanking(store), [{ key: 'B.png', name: '店主', floors: 50 }, { key: 'A.png', name: '阿澈', floors: 5 }]);
});

function tavern({ persona = 'me.png' } = {}) {
    const saves = [], calls = [];
    const ctx = { extensionSettings: {}, characters: [{ avatar: 'A.png', name: '阿澈' }], characterId: 0, chatId: 'story', chat: Array(12).fill({}), chatMetadata: { integrity: 'uuid-9' }, user_avatar: persona,
        saveSettingsDebounced: () => saves.push(1), getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) };
    let list = [{ file_name: 'story.jsonl', chat_items: 12 }, { file_name: 'other.jsonl', chat_items: 30 }];
    const fetch = async (url, options) => { calls.push([url, JSON.parse(options.body), options.headers['X-CSRF-Token']]); return { ok: true, json: async () => list }; };
    let at = 1000;
    const counter = createFloorCounter({ getContext: () => ctx, fetch, now: () => at });
    return { ctx, saves, calls, counter, tick(ms) { at += ms; }, setList(next) { list = next; } };
}

test('in the tavern: the open chat is recorded without any request; the chat list is fetched on demand, at most once per ten minutes; the user persona never matters', async () => {
    const f = tavern();
    assert.deepEqual(f.counter.touch(), { chat: 12, total: 12 }); assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 1);
    assert.deepEqual(f.counter.touch(), { chat: 12, total: 12 }); assert.equal(f.saves.length, 1, 'nothing changed: nothing saved');
    assert.equal(await f.counter.sync(), true);
    assert.deepEqual(f.calls, [['/api/characters/chats', { avatar_url: 'A.png' }, 't']]);
    assert.deepEqual(f.counter.touch(), { chat: 12, total: 42 });
    assert.equal(await f.counter.sync(), false); assert.equal(f.calls.length, 1, 'throttled');
    f.tick(600001); f.setList([{ file_name: 'story.jsonl', chat_items: 12 }]); // other.jsonl 被删了
    assert.equal(await f.counter.sync(), false); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.counter.touch(), { chat: 12, total: 42 }, 'a deleted chat keeps its floors');
    // 换了用户身份、又聊了三层：只按角色记。
    f.ctx.user_avatar = 'someone-else.png'; f.ctx.name1 = '另一个身份'; f.ctx.chat = Array(15).fill({});
    assert.deepEqual(f.counter.touch(), { chat: 15, total: 45 });
    assert.deepEqual(Object.keys(f.ctx.extensionSettings[FLOOR_KEY].chars), ['A.png']);
    assert.deepEqual(floorRanking(f.counter.store()), [{ key: 'A.png', name: '阿澈', floors: 45 }]);
    // 群聊、没开角色：不记也不报错。
    f.ctx.groupId = 'g1'; assert.equal(f.counter.touch(), null); assert.equal(await f.counter.sync(true), false);
    assert.equal(createFloorCounter({ getContext: () => null }).touch(), null);
});

test('a failed chat list request is reported in the console and tried again next time', async t => {
    const f = tavern(), warned = []; const warn = console.warn; console.warn = (...args) => warned.push(args); t.after(() => { console.warn = warn; });
    const failing = createFloorCounter({ getContext: () => f.ctx, fetch: async () => ({ ok: false, status: 500 }), now: () => 5 });
    assert.equal(await failing.sync(), false); assert.equal(warned.length, 1);
    assert.equal(await failing.sync(), false); assert.equal(warned.length, 2, 'not throttled after a failure');
});

const T0 = new Date(2026, 10, 20, 14, 0, 0).getTime(), MIN = 60000;
const usage = { days: {}, hours: Array(24).fill(0), chars: { 'A.png': { name: '阿澈', ms: 100 * MIN, last: T0 - 86400000 }, 'B.png': { name: '店主', ms: 25 * MIN, last: T0 - 60000 } } };

test('the roster has a second ranking by floors; the first place is highlighted in either', () => {
    const floors = [{ key: 'B.png', name: '店主', floors: 900 }, { key: 'C.png', name: '<i>旅人</i>', floors: 300 }, { key: 'A.png', name: '阿澈', floors: 120 }];
    const byTime = usageMarkup(usage, { now: T0, page: 'chars', floors });
    assert.match(byTime, /<h3>宿缘<\/h3><button type="button" class="qm-usage-icon" data-usage-rank="floors" aria-label="按楼层排"/);
    assert.deepEqual([...byTime.matchAll(/<article class="qm-usage-char([^"]*)"/g)].map(match => match[1]), [' is-top', '']);
    assert.match(byTime, /1 小时 40 分/); assert.ok(!byTime.includes('qm-usage-thread'), 'different first places: no thread');
    const byFloors = usageMarkup(usage, { now: T0, page: 'chars', floors, rank: 'floors' });
    assert.match(byFloors, /data-usage-rank="time" aria-label="按时长排"/);
    assert.deepEqual([...byFloors.matchAll(/<div class="who"><span>([^<]*)<\/span><span>([^<]*)<\/span>/g)].map(match => [match[1], match[2]]), [['店主', '900 层'], ['&lt;i&gt;旅人&lt;/i&gt;', '300 层'], ['阿澈', '120 层']]);
    assert.match(byFloors, /--p:100%/); assert.match(byFloors, /--p:33%/); assert.match(byFloors, /--p:13%/);
    assert.match(byFloors, /旅人.*最后一次聊天：还没有聊过/s, 'a character known only by floors still gets a row');
    // 没有楼层数据时没有切换钮，名单照旧按时长。
    const plain = usageMarkup(usage, { now: T0, page: 'chars', rank: 'floors' });
    assert.ok(!plain.includes('data-usage-rank')); assert.match(plain, /1 小时 40 分/);
});

test('first in both rankings: that one row is tied with the red thread, in either view', () => {
    const floors = [{ key: 'A.png', name: '阿澈', floors: 900 }, { key: 'B.png', name: '店主', floors: 300 }];
    for (const rank of ['time', 'floors']) {
        const html = usageMarkup(usage, { now: T0, page: 'chars', floors, rank });
        assert.deepEqual([...html.matchAll(/<article class="qm-usage-char([^"]*)"/g)].map(match => match[1]), [' is-top is-fated', '']);
        assert.equal((html.match(/class="qm-usage-thread"/g) || []).length, 1);
        // 线本身要量过这一行的尺寸才画，名单里先留一个位置；莫比乌斯环是固定的一小枚，直接在名单里。
        assert.match(html, /is-fated" style="--n:0"><span class="qm-usage-thread" aria-hidden="true"><\/span><svg class="qm-usage-mobius" viewBox="0 0 26 15" aria-hidden="true"><path pathLength="1" d="M13\.00,7\.50L/);
        assert.equal((html.match(/class="qm-usage-mobius"/g) || []).length, 1);
    }
    assert.ok(!usageMarkup({ days: {}, hours: [], chars: {} }, { now: T0, page: 'chars', floors }).includes('is-fated'), 'no time recorded yet: nobody is first in both');
});

test('the heart page carries the two counts only when there is something to show', () => {
    assert.deepEqual(heartData({}, { chat: 12, total: 45 }).floors, { chat: 12, total: 45 });
    assert.ok(!('floors' in heartData({}, null))); assert.ok(!('floors' in heartData({}, { chat: 0, total: 0 }))); assert.ok(!('floors' in heartData({})));
});

test('the thread is one tapered ribbon from beyond the left edge to beyond the right, pale to deep, with twenty motes around it', () => {
    const html = threadMarkup({ left: -20, right: 380, face: { cx: 29, cy: 35, r: 23 }, nameY: 22, barY: 37 });
    assert.equal((html.match(/<polygon class="qm-usage-silk"/g) || []).length, 1);
    assert.equal((html.match(/class="qm-usage-mote"/g) || []).length, 20);
    assert.match(html, /<linearGradient id="qm-usage-silk-ink" gradientUnits="userSpaceOnUse" x1="-20\.0" y1="0" x2="380\.0" y2="0"><stop offset="0" style="stop-color:var\(--u-fate-pale\)"\/>.*<stop offset="1" style="stop-color:var\(--u-fate-deep\)"\/>/);
    const line = html.match(/class="qm-usage-reveal" pathLength="1" d="M([^"]+)"/)[1].split('L').map(pair => pair.split(',').map(Number));
    assert.ok(line[0][0] < -20 && line.at(-1)[0] > 380, 'it comes out of the left edge and leaves past the right one');
    assert.ok(line.every(point => point.every(Number.isFinite)));
    // 掠过头像的下半边，不绕头像一圈：经过头像那一段都在圆心以下。
    const over = line.filter(([x]) => x > 6 && x < 52);
    assert.ok(over.length > 5 && over.every(([, y]) => y > 35 && y < 35 + 23 + 4));
    // 两头收成尖：飘带在起笔与收笔处的宽度趋近于零。
    const ribbon = html.match(/points="([^"]+)"/)[1].split(' ').map(pair => pair.split(',').map(Number)), half = ribbon.length / 2;
    const widthAt = i => Math.hypot(ribbon[i][0] - ribbon[ribbon.length - 1 - i][0], ribbon[i][1] - ribbon[ribbon.length - 1 - i][1]);
    assert.ok(widthAt(0) < .2 && widthAt(half - 1) < .2); assert.ok(Math.max(...Array.from({ length: half }, (_, i) => widthAt(i))) > 1.6);
    assert.equal(threadMarkup({ left: -20, right: 380 }), threadMarkup({ left: -20, right: 380 }), 'the motes are placed the same every time');
});
