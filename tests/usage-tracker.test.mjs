// 使用时长：只数真正在用的时间；按天与按角色各一份；汇总与面板。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTracker, normalizeUsage, usageSummary, heatCells, quarterRange, compactTime, durationText, dayKey, zoneShift, createTokenMeter, estimateTextTokens, tokenSummary, compactTokens, tokenText } from '../qianmu-usage-tracker.js';
import { usageMarkup, lastChatText, DRINKS, timeZoneText } from '../qianmu-usage-view.js';

const T0 = new Date(2026, 10, 20, 14, 0, 0).getTime(), MIN = 60000;
function fixture(saved = null) {
    let at = T0, who = { key: 'Alice.png', name: '阿澈' }, visible = true, busy = false, focused = true; const saves = [];
    const tracker = createUsageTracker({ load: () => saved, save: data => saves.push(structuredClone(data)), now: () => at, character: () => who, visible: () => visible, busy: () => busy, focused: () => focused });
    return { tracker, saves, step(ms) { at += ms; return tracker.tick(); }, set(patch) { if ('who' in patch) who = patch.who; if ('visible' in patch) visible = patch.visible; if ('busy' in patch) busy = patch.busy; if ('focused' in patch) focused = patch.focused; }, get at() { return at; } };
}
const today = f => f.tracker.data.days[dayKey(T0)] || 0;

test('time runs from one action to the next only when they are at most two minutes apart; the idle tail after the last action never counts', () => {
    const f = fixture();
    assert.equal(f.step(15000), 0, '还没有任何操作');
    f.tracker.touch(); assert.equal(f.step(15000), 0, '只有一次操作：还没有可记的一段');
    f.tracker.touch(); assert.equal(f.step(15000), 15000, '两次操作相隔 15 秒：这 15 秒记上');
    // 停下来不动：之后的节拍一秒也不加，哪怕还没满两分钟。
    for (let i = 0; i < 6; i++) assert.equal(f.step(15000), 0);
    assert.equal(today(f), 15000);
    // 停了 105 秒（不到两分钟）又动了一下：中间这段整段补记。
    f.tracker.touch(); assert.equal(f.step(15000), 105000); assert.equal(today(f), 120000);
    // 停了超过两分钟才再动：中间那段不算，从这一下重新起。
    for (let i = 0; i < 8; i++) f.step(15000);
    f.tracker.touch(); assert.equal(f.step(15000), 0);
    f.tracker.touch(); assert.equal(f.step(15000), 15000);
    assert.equal(today(f), 135000);
});

test('hidden pages, an idle unfocused desktop window and a sleeping tab never count; a generating reply counts even without focus', () => {
    const f = fixture();
    // 切到别的标签页：这一段收住，回来后从头起。
    f.tracker.touch(); f.step(15000); f.set({ visible: false }); f.tracker.touch(); assert.equal(f.step(15000), 0);
    f.set({ visible: true }); f.tracker.touch(); assert.equal(f.step(15000), 0); f.tracker.touch(); assert.equal(f.step(15000), 15000);
    // 电脑上切到别的窗口、又没在生成：失焦即收住；失焦期间的操作不算。
    f.tracker.touch(); f.set({ focused: false }); f.tracker.pause(); assert.equal(today(f), 30000, '收住时记到失焦前最后一次操作'); assert.equal(f.step(15000), 0);
    f.tracker.touch(); assert.equal(f.step(15000), 0, '失焦时的操作不算');
    // 生成中照常计，哪怕窗口没有焦点（等回复时可能在别处做事）；失焦也不收住。
    f.set({ busy: true }); assert.equal(f.step(15000), 0, '从这一刻起算'); f.tracker.pause(); assert.equal(f.step(15000), 15000);
    // 生成完了、窗口仍没焦点：只记到最后一个生成节拍，之后不算。
    f.set({ busy: false }); assert.equal(f.step(15000), 0); assert.equal(today(f), 45000);
    f.set({ busy: true, focused: true }); assert.equal(f.step(15000), 0); assert.equal(f.step(15000), 15000);
    // 生成中算在用：每个节拍都是一次操作。
    assert.equal(f.step(15000), 15000);
    // 标签页被挂起很久后醒来：睡着的时间不算，哪怕一直在生成。
    assert.equal(f.step(600000), 0); assert.equal(f.step(15000), 15000);
    // 睡得不到两分钟也一样：节拍断过，就不把那段算进去。
    f.set({ busy: false }); f.tracker.touch(); f.step(0); f.tracker.touch(); assert.equal(f.step(90000), 0); f.tracker.touch(); assert.equal(f.step(15000), 0);
    // 手机上 pause 不收住（focused 一直为真）。
    const m = fixture(); m.tracker.touch(); m.step(10000); m.tracker.pause(); m.tracker.touch(); assert.equal(m.step(0), 10000);
});

test('each character gets their own total, kept by avatar file so it outlives the chat; no character open means only the day total grows', () => {
    const f = fixture(), act = ms => { f.tracker.touch(); f.step(ms); f.tracker.touch(); f.step(0); };
    act(15000); f.tracker.message();
    f.set({ who: { key: 'Bob.png', name: '店主' } }); act(15000); act(15000);
    f.set({ who: null }); act(15000);
    const { chars, days, hours } = f.tracker.data;
    assert.deepEqual(Object.fromEntries(Object.entries(chars).map(([key, item]) => [key, [item.name, item.ms]])), { 'Alice.png': ['阿澈', 15000], 'Bob.png': ['店主', 30000] });
    assert.equal(chars['Alice.png'].last, T0 + 15000); assert.equal(chars['Bob.png'].last, 0);
    assert.equal(days[dayKey(T0)], 60000); assert.equal(hours[14], 60000);
    // 存盘：攒够三分钟存一次，离开页面时也存；读回来接着累计。
    assert.equal(f.saves.length, 0); f.tracker.flush(); assert.equal(f.saves.length, 1);
    const again = fixture(f.saves[0]); again.tracker.touch(); again.step(15000); again.tracker.touch(); again.step(0);
    assert.equal(again.tracker.data.chars['Alice.png'].ms, 30000);
    assert.deepEqual(normalizeUsage({ days: { bad: 5, '2026-11-20': -1 }, chars: { '': {}, ok: { ms: 'x' } }, hours: 'no' }), { version: 1, since: 0, days: {}, hours: Array(24).fill(0), chars: { ok: { name: '', ms: 0, last: 0 } } });
});

test('the summary gives day, week, month, year and all-time totals, streaks, the usual hour and characters ranked by time, plus the one chatted with most recently', () => {
    const day = n => dayKey(T0 - n * 86400000), days = { [day(0)]: 50 * MIN, [day(1)]: 120 * MIN, [day(2)]: 10 * MIN, [day(4)]: 30 * MIN, [day(40)]: 60 * MIN };
    const hours = Array(24).fill(0); hours[22] = 9; hours[14] = 3;
    const data = { since: T0 - 40 * 86400000, days, hours, chars: { 'A.png': { name: '阿澈', ms: 200 * MIN, last: T0 - 9 * 86400000 }, 'B.png': { name: '店主', ms: 20 * MIN, last: T0 - 3600000 }, 'C.png': { name: '没聊过', ms: 0, last: 0 } } };
    const s = usageSummary(data, T0);
    assert.equal(s.today, 50 * MIN); assert.equal(s.week, (50 + 120 + 10 + 30) * MIN, '2026-11-20 是周五，本周从周一 11-16 起'); assert.equal(s.month, 210 * MIN); assert.equal(s.year, 270 * MIN); assert.equal(s.all, 270 * MIN);
    assert.deepEqual([s.streak, s.longest, s.activeDays, s.peak], [3, 3, 5, 22]);
    assert.deepEqual(s.chars.map(item => item.key), ['A.png', 'B.png']); assert.equal(s.top, 200 * MIN); assert.equal(s.recent.key, 'B.png', '最近聊过的那位不一定是时长最长的');
    assert.equal(usageSummary({ days: { [day(1)]: 5, [day(2)]: 5 } }, T0).streak, 2, '今天还没用，昨天之前连着：不算断');
    // 大数字从分钟起步，放不下才换单位。
    assert.deepEqual([compactTime(0), compactTime(59 * MIN), compactTime(9999 * MIN), compactTime(10000 * MIN), compactTime(600000 * MIN), compactTime(1e9 * MIN)],
        [{ value: '0', unit: 'min' }, { value: '59', unit: 'min' }, { value: '9999', unit: 'min' }, { value: '166.7', unit: 'h' }, { value: '417', unit: 'd' }, { value: '694444', unit: 'd' }]);
    assert.deepEqual([durationText(0), durationText(30000), durationText(5 * MIN), durationText(125 * MIN), durationText(120 * MIN)], ['0 分钟', '不到 1 分钟', '5 分钟', '2 小时 5 分', '2 小时']);
});

test('the heat grid defaults to thirteen whole weeks ending today, follows any chosen range, and is darker for longer days', () => {
    const q = quarterRange(T0);
    // 2026-11-20 是周五：从十二周前的周一起，到今天止；往前翻一段是紧挨着的十三个整周。
    assert.deepEqual([new Date(q.from).toDateString(), new Date(q.to).toDateString()], [new Date(2026, 7, 24).toDateString(), new Date(2026, 10, 20).toDateString()]);
    const before = quarterRange(T0, -1);
    assert.deepEqual([new Date(before.from).toDateString(), new Date(before.to).toDateString()], [new Date(2026, 4, 25).toDateString(), new Date(2026, 7, 23).toDateString()]);
    const day = n => dayKey(T0 - n * 86400000), data = { days: { [day(0)]: 10 * MIN, [day(1)]: 40 * MIN, [day(2)]: 80 * MIN, [day(3)]: 160 * MIN } };
    const heat = heatCells(data, q.from, q.to, T0);
    assert.equal(heat.weeks, 13); assert.equal(heat.cells.length, 91); assert.equal(heat.total, 290 * MIN);
    const at = n => heat.cells.find(cell => cell.time === new Date(T0 - n * 86400000).setHours(0, 0, 0, 0));
    assert.ok(at(3).level > at(2).level && at(2).level > at(0).level, '越久越深'); assert.equal(at(3).level, 4); assert.equal(at(0).today, true);
    assert.equal(heat.cells.filter(cell => cell.time > new Date(T0).setHours(0, 0, 0, 0)).every(cell => cell.level === -1), true, '还没到的日子不画');
    assert.equal(heat.cells[0].level, 0, '从整周起头，前面没有空着的格子');
    assert.deepEqual(heat.cells.filter(cell => cell.level === -1).length, 2, '只有本周还没到的两天不画');
    assert.equal(heatCells(data, T0 - 9 * 86400000, T0, T0).cells[0].level, -1, '自选范围不从周一起时，前面补齐的那几天不画');
    const week = heatCells(data, T0 - 6 * 86400000, T0, T0); assert.ok(week.weeks <= 2);
    const year = heatCells(data, T0 - 364 * 86400000, T0, T0); assert.ok(year.weeks >= 52);
});

test('the panel: heat grid with a range line and a custom picker, the most recent character right below it, eight counters with small English units; the regulars page lists face, name, bar, total and last chat', () => {
    const data = { since: T0 - 86400000, days: { [dayKey(T0)]: 170 * MIN }, hours: Object.assign(Array(24).fill(0), { 14: 5 }), chars: { 'A.png': { name: '<b>阿澈</b>', ms: 100 * MIN, last: T0 - 86400000 }, 'B.png': { name: '店主', ms: 25 * MIN, last: T0 - 60000 } } };
    const home = usageMarkup(data, { now: T0, drink: 'Negroni', zones: ['Asia/Tokyo', 'Europe/London'] });
    assert.match(home, /<h3>微醺记录<\/h3>/);
    assert.equal((home.match(/class="qm-usage-card"/g) || []).length, 8);
    assert.match(home, /<em>今日<\/em><strong><i data-count="170">170<\/i><span>min<\/span><\/strong><\/section>/, '分钟起步、英文小单位、下面不再重复小字');
    assert.ok(!home.includes('qm-usage-bar'), '进度条只给常客名单用');
    assert.match(home, /<em>今日来杯 Negroni<\/em>.*<small>始于 <b>11月19日<\/b><\/small>/s);
    // 时区那行小字本身就是下拉：默认跟随系统。
    assert.match(home, /<em>最常在<\/em><strong><span>下午<\/span><i>14:00<\/i><\/strong><small><span class="qm-usage-zone">[^<]*UTC[+-]\d[^<]*<select data-usage-zone aria-label="时区"><option value="" selected>跟随系统<\/option><option value="Asia\/Tokyo">Asia\/Tokyo<\/option><option value="Europe\/London">Europe\/London<\/option><\/select><\/span><\/small>/);
    assert.ok(!home.includes('qm-usage-tip') && !home.includes('自选<'), '热力格下面没有每日小字，也没有单独的自选按钮');
    assert.match(home, /<button type="button" class="qm-usage-span" data-usage-custom aria-label="自选范围" aria-expanded="false">2026\.8\.24 — 2026\.11\.20<\/button>/, '日期区间就是自选范围的开关'); assert.match(home, /class="qm-usage-pick" hidden/);
    // 最近聊过的那位紧跟热力格：没有标题与人数，点进去就是名单。
    const heatAt = home.indexOf('qm-usage-heat'), lastAt = home.indexOf('qm-usage-last'), cardsAt = home.indexOf('qm-usage-cards');
    assert.ok(heatAt < lastAt && lastAt < cardsAt);
    assert.match(home, /class="qm-usage-last" data-usage-page="chars"[^>]*>.*<strong>店主<\/strong>.*<small>今天 13:59 聊过<\/small>/s);
    assert.ok(!/位 ›|角色时长/.test(home));
    const custom = usageMarkup(data, { now: T0, range: { from: T0 - 6 * 86400000, to: T0, custom: true } });
    assert.match(custom, /data-usage-custom aria-label="自选范围" aria-expanded="true"/); assert.match(custom, /data-usage-from aria-label="开始日期" value="2026-11-14"/); assert.ok(!custom.includes('class="qm-usage-pick" hidden'));
    const chars = usageMarkup(data, { now: T0, page: 'chars' });
    assert.match(chars, /<h3>宿缘<\/h3>/); assert.ok(chars.includes('&lt;b&gt;阿澈&lt;/b&gt;') && !chars.includes('<b>阿澈</b>'));
    assert.match(chars, /1 小时 40 分/); assert.match(chars, /--p:100%/); assert.match(chars, /--p:25%/); assert.match(chars, /最后一次聊天：昨天 14:00/);
    assert.match(chars, /src="\/characters\/A\.png"/, '原图，不是缩略图');
    assert.match(usageMarkup({}, { now: T0, page: 'chars' }), /还没有和谁聊过/);
    assert.ok(!usageMarkup({}, { now: T0 }).includes('qm-usage-last'), '还没聊过谁就不放那一格');
    assert.deepEqual([lastChatText(T0 - 60000, T0), lastChatText(T0 - 3 * 86400000, T0), lastChatText(new Date(2026, 9, 1, 8).getTime(), T0)], ['今天 13:59', '3 天前', '2026年10月1日']);
    // 酒名都短得放得进半宽的格子。
    assert.ok(DRINKS.length >= 30 && DRINKS.every(name => name.length <= 9) && new Set(DRINKS).size === DRINKS.length);
    assert.match(timeZoneText(new Date(T0)), /UTC[+-]\d/);
});

test('a chosen time zone decides which day and hour time is booked under, from then on, and the panel reads the clock the same way', () => {
    const east = 'Pacific/Kiritimati', west = 'Pacific/Pago_Pago'; // 相差二十五小时：同一刻在两地永远不是同一天
    assert.equal(zoneShift(T0, ''), 0); assert.equal(zoneShift(T0, 'No/Such_Zone'), 0);
    assert.equal(zoneShift(T0, east) - zoneShift(T0, west), 25 * 3600000);
    const book = zone => { const f = fixture(); f.tracker.touch(); f.tracker.setZone(zone); f.tracker.touch(); f.step(15000); f.tracker.touch(); f.step(0); return { data: f.tracker.data, saves: f.saves }; };
    const a = book(east), b = book(west);
    assert.deepEqual(Object.keys(a.data.days), [dayKey(T0 + 15000 + zoneShift(T0, east))]);
    assert.deepEqual(Object.keys(b.data.days), [dayKey(T0 + 15000 + zoneShift(T0, west))]);
    assert.notDeepEqual(Object.keys(a.data.days), Object.keys(b.data.days));
    assert.equal(a.data.hours[new Date(T0 + zoneShift(T0, east)).getHours()], 15000);
    assert.equal(a.data.zone, east); assert.equal(a.saves.at(-1).zone, east, 'the choice is saved at once');
    assert.equal(normalizeUsage(a.data).zone, east); assert.ok(!('zone' in normalizeUsage({ zone: 7 })));
    const f = fixture({ zone: east }); f.tracker.setZone('No/Such_Zone'); assert.ok(!('zone' in f.tracker.data), 'an unknown zone falls back to the system one');
    f.tracker.setZone(west); f.tracker.setZone(''); assert.ok(!('zone' in f.tracker.data));
    // 面板：选中的那一项、小字里的城市名与偏移、「今天」都跟着所选时区走。
    const data = { zone: east, days: { [dayKey(T0 + zoneShift(T0, east))]: 30 * MIN }, hours: Array(24).fill(0), chars: {} };
    const home = usageMarkup(data, { now: T0, zones: [east, west] });
    assert.match(home, /<span class="qm-usage-zone">Kiritimati · UTC\+14<select/);
    assert.match(home, /<option value="Pacific\/Kiritimati" selected>/); assert.match(home, /<option value="">跟随系统<\/option>/);
    assert.match(home, /<em>今日<\/em><strong><i data-count="30">30<\/i>/);
    assert.match(home, new RegExp(`data-today title="${new Date(T0 + zoneShift(T0, east)).getMonth() + 1}月${new Date(T0 + zoneShift(T0, east)).getDate()}日 · 30 分钟"`));
});

test('each day in the heat grid carries its date and time, and the line under the grid starts on today', () => {
    const data = { days: { [dayKey(T0)]: 30 * MIN, [dayKey(T0 - 86400000)]: 0 }, hours: Array(24).fill(0), chars: {} };
    const home = usageMarkup(data, { now: T0, zones: [] }), d = new Date(T0), today = `${d.getMonth() + 1}月${d.getDate()}日`;
    assert.match(home, new RegExp(`data-today title="${today} · 30 分钟" class="on" data-day="${today}" data-spent="30 分钟"`));
    assert.match(home, /data-day="[^"]+" data-spent="没喝"/, '没记录的日子也点得出来');
    assert.match(home, new RegExp(`<p class="qm-usage-day" aria-live="polite"><i data-level="\\d"></i><span>${today}</span><b>30 分钟</b></p>`));
    // 今天不在所选范围里：那一行先空着，点了才有。
    const past = usageMarkup(data, { now: T0, zones: [], range: { from: T0 - 40 * 86400000, to: T0 - 20 * 86400000, custom: true } });
    assert.match(past, /<p class="qm-usage-day" aria-live="polite"><\/p>/);
});

test('the token ledger counts only chat generations: the final request goes out, the reply that lands in the chat comes back', () => {
    const recorded = [], queue = [], chat = [{ is_user: true, mes: 'hi' }];
    const meter = createTokenMeter({ getContext: () => ({ chat }), record: counts => recorded.push(counts), defer: fn => queue.push(fn) });
    const run = () => { while (queue.length) queue.shift()(); };
    assert.equal(estimateTextTokens('你好'), 2); assert.equal(estimateTextTokens('abcdefghij'), 4); assert.equal(estimateTextTokens(''), 0);
    // 普通生成：发出按最终消息估算（图片块不算），收到按落进聊天的回复（连同思考）。
    meter.generationStarted('normal', {}, false);
    meter.afterData({ prompt: [{ role: 'system', content: '设定' }, { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'image_url', image_url: { url: 'x' } }] }] }, false);
    assert.equal(recorded.length, 0, '估算放到事件之后，不拖慢生成'); run();
    assert.deepEqual(recorded, [{ sent: 4 }]);
    chat.push({ is_user: false, mes: '晚上好', extra: { reasoning: '想想' } }); meter.messageReceived(1, 'normal'); run();
    assert.deepEqual(recorded.at(-1), { received: 5 });
    // 只拼不发的（dryRun）、后台生成、插件自己发的都不记；后台生成插在正文生成途中时这一次分不清，宁可不记。
    const before = recorded.length;
    meter.generationStarted('normal', {}, true); meter.afterData({ prompt: 'x'.repeat(100) }, true);
    meter.generationStarted('quiet', { quiet_prompt: 'sum up' }, false); meter.afterData({ prompt: 'x'.repeat(100) }, false);
    meter.generationStarted('normal', { quiet_prompt: 'q' }, false); meter.afterData({ prompt: 'abc' }, false);
    meter.generationStarted('swipe', {}, false); meter.generationStarted('quiet', {}, false); meter.afterData({ prompt: 'abc' }, false);
    meter.messageReceived(1, 'normal'); meter.messageReceived(1, 'extension'); run();
    assert.equal(recorded.length, before, '这些一个都不记');
    // 文本补全：整段提示词。继续：只算接上的那一截。
    meter.generationStarted('continue', {}, false); meter.afterData({ prompt: 'abcdefghij' }, false); run();
    assert.deepEqual(recorded.at(-1), { sent: 4 });
    chat[1].mes = '晚上好，今天'; meter.messageReceived(1, 'continue'); run();
    assert.deepEqual(recorded.at(-1), { received: 3 });
    // 别处发来的消息（命令、首条、图片扩展）不算回复；聊天换了就作废。
    meter.generationStarted('regenerate', {}, false); meter.afterData({ prompt: 'a' }, false); run();
    const settled = recorded.length;
    meter.messageReceived(1, 'command'); meter.messageReceived(1, 'first_message'); meter.chatChanged(); meter.messageReceived(1, 'regenerate'); run();
    assert.equal(recorded.length, settled);
    // 代拟：填进输入框的那段。
    meter.generationStarted('impersonate', {}, false); meter.afterData({ prompt: 'ab' }, false); meter.messageReceived(1, 'normal'); meter.impersonateReady('我来说'); run();
    assert.deepEqual(recorded.slice(-2), [{ sent: 1 }, { received: 3 }]);
});

test('tokens are booked per day, saved on the same throttle as time, trimmed the same way, and summed for the panel', () => {
    const f = fixture();
    f.tracker.addTokens({ sent: 1200, received: 300 }); f.tracker.addTokens({ sent: -5, received: 'x' });
    assert.deepEqual(f.tracker.data.tokens.days[dayKey(T0)], { sent: 1200, received: 300 }); assert.equal(f.tracker.data.tokens.since, T0);
    assert.equal(f.saves.length, 0, '刚开始不存，等节流');
    f.step(180000); assert.equal(f.saves.length, 1, '满三分钟就存'); assert.deepEqual(f.saves[0].tokens.days[dayKey(T0)], { sent: 1200, received: 300 });
    f.tracker.addTokens({ sent: 1 }); assert.equal(f.saves.length, 1); f.tracker.flush(); assert.equal(f.saves.length, 2, '离开页面时也存');
    assert.deepEqual(normalizeUsage({ tokens: { days: { bad: { sent: 1 }, '2026-11-20': { sent: 'x', received: -1 }, '2026-11-19': { sent: 5 } } } }).tokens, { since: 0, days: { '2026-11-19': { sent: 5, received: 0 } } });
    const days = {}; for (let i = 0; i < 805; i++) days[dayKey(T0 - i * 86400000)] = { sent: 1, received: 1 };
    const big = fixture({ tokens: { since: 1, days } }); big.tracker.addTokens({ sent: 1 }); big.tracker.flush();
    assert.equal(Object.keys(big.saves.at(-1).tokens.days).length, 800, '和时长一样最多留 800 天');
    const day = n => dayKey(T0 - n * 86400000);
    const s = tokenSummary({ tokens: { since: T0 - 40 * 86400000, days: { [day(0)]: { sent: 100, received: 20 }, [day(1)]: { sent: 1000, received: 500 }, [day(40)]: { sent: 10, received: 0 } } } }, T0);
    assert.deepEqual([s.today.total, s.today.sent, s.today.received, s.week.total, s.month.total, s.all.total, s.activeDays, s.average], [120, 100, 20, 1620, 1620, 1630, 3, 543]);
    assert.equal(s.peak.total, 1500); assert.equal(new Date(s.peak.day).getDate(), new Date(T0 - 86400000).getDate());
    assert.deepEqual([0, 999, 1000, 12345, 123456, 1234567, 2.5e9].map(n => compactTokens(n)), [{ value: '0', unit: 'tok' }, { value: '999', unit: 'tok' }, { value: '1', unit: 'k' }, { value: '12.3', unit: 'k' }, { value: '123', unit: 'k' }, { value: '1.2', unit: 'M' }, { value: '2.5', unit: 'B' }]);
    assert.deepEqual([tokenText(800), tokenText(4567)], ['800', '4.5k']);
});

test('token mode: same heat grid shaded by the day total, the line under it splits sent and received, eight token counters, no regulars', () => {
    const data = { days: { [dayKey(T0)]: 30 * MIN }, hours: Array(24).fill(0), chars: { 'A.png': { name: '阿澈', ms: 100 * MIN, last: T0 - 60000 } },
        tokens: { since: T0 - 86400000, days: { [dayKey(T0)]: { sent: 12345, received: 678 }, [dayKey(T0 - 86400000)]: { sent: 100, received: 0 } } } };
    const home = usageMarkup(data, { now: T0, zones: [], mode: 'tokens' }), d = new Date(T0), today = `${d.getMonth() + 1}月${d.getDate()}日`;
    assert.match(home, /<button type="button" data-usage-mode="time" aria-pressed="false">时长<\/button><button type="button" data-usage-mode="tokens" aria-pressed="true">token<\/button>/);
    assert.match(home, new RegExp(`<p class="qm-usage-day" aria-live="polite"><i data-level="4"></i><span>${today}</span><b>发出 12.3k · 收到 678</b></p>`));
    assert.match(home, /data-spent="发出 100 · 收到 0"/); assert.match(home, /data-spent="没喝"/);
    assert.equal((home.match(/class="qm-usage-card"/g) || []).length, 8);
    assert.match(home, /<em>今日<\/em><strong><i data-count="13">13<\/i><span>k<\/span><\/strong><small>发出 12.3k · 收到 678<\/small>/);
    assert.match(home, /<em>日均<\/em>/); assert.match(home, /<em>记录天数<\/em><strong><i data-count="2">2<\/i><span>days<\/span><\/strong><small>始于 /); assert.match(home, /<em>最多一天<\/em>/);
    assert.ok(!home.includes('qm-usage-last') && !home.includes('宿缘') && !home.includes('最常在') && !home.includes('今日来杯'), 'token 模式没有角色名单与时长专属的格子');
    assert.ok(!usageMarkup(data, { now: T0, zones: [], mode: 'tokens', page: 'chars' }).includes('<h3>宿缘</h3>'));
    const time = usageMarkup(data, { now: T0, zones: [] });
    assert.match(time, /data-usage-mode="time" aria-pressed="true"/); assert.match(time, /qm-usage-last/);
    assert.match(usageMarkup({}, { now: T0, zones: [], mode: 'tokens' }), /<em>最多一天<\/em><strong>—<\/strong>/);
});

test('heat cells bounce once instead of staying enlarged, and the picked day keeps an outline', async () => {
    const { readFile } = await import('node:fs/promises');
    const view = await readFile(new URL('../qianmu-usage-view.js', import.meta.url), 'utf8');
    assert.ok(!/i\.on \{[^}]*transform: scale/.test(view) && !/i:hover[^{]*\{[^}]*transform: scale/.test(view), '不再停在放大的样子');
    assert.match(view, /@keyframes qm-usage-tap \{ 0%, 100% \{ scale: 1; \} 40% \{ scale: 1\.5; \} \}/);
    assert.match(view, /i:is\(:hover, \.on\) \{[^}]*qm-usage-pop[^}]*, qm-usage-tap/, '弹动叠在入场动画后面，取消选中不会重播入场');
    assert.match(view, /\.qm-usage-grid i\.on \{[^}]*outline: 1\.5px solid/);
});
