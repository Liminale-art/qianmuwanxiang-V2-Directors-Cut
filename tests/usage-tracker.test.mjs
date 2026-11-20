// 使用时长：只数真正在用的时间；按天与按角色各一份；汇总与面板。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTracker, normalizeUsage, usageSummary, durationText, clockText, dayKey } from '../qianmu-usage-tracker.js';
import { usageMarkup, lastChatText } from '../qianmu-usage-view.js';

const T0 = new Date(2026, 10, 20, 14, 0, 0).getTime(), MIN = 60000;
function fixture(saved = null) {
    let at = T0, who = { key: 'Alice.png', name: '阿澈' }, visible = true, busy = false; const saves = [];
    const tracker = createUsageTracker({ load: () => saved, save: data => saves.push(structuredClone(data)), now: () => at, character: () => who, visible: () => visible, busy: () => busy });
    return { tracker, saves, step(ms) { at += ms; return tracker.tick(); }, set(patch) { if ('who' in patch) who = patch.who; if ('visible' in patch) visible = patch.visible; if ('busy' in patch) busy = patch.busy; }, get at() { return at; } };
}

test('time counts only while the page is visible and there was a recent action; idling past two minutes stops the clock', () => {
    const f = fixture();
    assert.equal(f.step(15000), 0, '还没有任何操作');
    f.tracker.touch();
    assert.equal(f.step(15000), 15000); assert.equal(f.step(15000), 15000);
    // 挂着不动：两分钟内仍算（在看），之后不算。
    for (let i = 0; i < 6; i++) f.step(15000);
    const before = f.tracker.data.days[dayKey(T0)];
    assert.equal(before, 120000);
    assert.equal(f.step(15000), 0); assert.equal(f.step(15000), 0);
    // 切到别的标签页不算；回来操作后接着算。
    f.tracker.touch(); f.set({ visible: false }); assert.equal(f.step(15000), 0);
    f.set({ visible: true }); f.tracker.touch(); assert.equal(f.step(15000), 15000);
    // 标签页被挂起很久后醒来：睡着的时间不算。
    f.tracker.touch(); assert.equal(f.step(3600000), 0);
    // 正在等回复、看流式输出也算在用；节拍被拖得很长时最多补两个节拍。
    f.set({ busy: true }); assert.equal(f.step(15000), 15000); assert.equal(f.step(600000), 30000);
});

test('each character gets their own total, kept by avatar file so it outlives the chat; no character open means only the day total grows', () => {
    const f = fixture();
    f.tracker.touch(); f.step(15000); f.tracker.message();
    f.set({ who: { key: 'Bob.png', name: '店主' } }); f.tracker.touch(); f.step(15000); f.step(15000);
    f.set({ who: null }); f.tracker.touch(); f.step(15000);
    const { chars, days, hours } = f.tracker.data;
    assert.deepEqual(Object.fromEntries(Object.entries(chars).map(([key, item]) => [key, [item.name, item.ms]])), { 'Alice.png': ['阿澈', 15000], 'Bob.png': ['店主', 30000] });
    assert.equal(chars['Alice.png'].last, T0 + 15000); assert.equal(chars['Bob.png'].last, 0);
    assert.equal(days[dayKey(T0)], 60000); assert.equal(hours[14], 60000);
    // 存盘：攒够三分钟存一次，离开页面时也存；读回来接着累计。
    assert.equal(f.saves.length, 0); f.tracker.flush(); assert.equal(f.saves.length, 1);
    const again = fixture(f.saves[0]); again.tracker.touch(); again.step(15000);
    assert.equal(again.tracker.data.chars['Alice.png'].ms, 30000);
    assert.deepEqual(normalizeUsage({ days: { bad: 5, '2026-11-20': -1 }, chars: { '': {}, ok: { ms: 'x' } }, hours: 'no' }), { version: 1, since: 0, days: {}, hours: Array(24).fill(0), chars: { ok: { name: '', ms: 0, last: 0 } } });
});

test('the summary gives day, week, month, year totals, streaks, the usual hour, a week-per-column heat grid and characters ranked by time', () => {
    const day = n => dayKey(T0 - n * 86400000), days = { [day(0)]: 50 * MIN, [day(1)]: 120 * MIN, [day(2)]: 10 * MIN, [day(4)]: 30 * MIN, [day(40)]: 60 * MIN };
    const hours = Array(24).fill(0); hours[22] = 9; hours[14] = 3;
    const data = { since: T0 - 40 * 86400000, days, hours, chars: { 'A.png': { name: '阿澈', ms: 200 * MIN, last: T0 - 3600000 }, 'B.png': { name: '店主', ms: 20 * MIN, last: T0 - 9 * 86400000 }, 'C.png': { name: '没聊过', ms: 0, last: 0 } } };
    const s = usageSummary(data, T0, { weeks: 8 });
    assert.equal(s.today, 50 * MIN); assert.equal(s.week, (50 + 120 + 10 + 30) * MIN, '2026-11-20 是周五，本周从周一 11-16 起'); assert.equal(s.month, 210 * MIN); assert.equal(s.year, 270 * MIN);
    assert.deepEqual([s.streak, s.longest, s.activeDays, s.peak], [3, 3, 5, 22]);
    assert.equal(s.cells.length, 56); assert.equal(s.cells.at(-1).level, -1, '本周还没到的日子不画');
    const todayCell = s.cells.find(cell => cell.time === new Date(T0).setHours(0, 0, 0, 0)); assert.deepEqual([todayCell.column, todayCell.row, todayCell.level], [7, 4, 2]);
    assert.equal(Math.max(...s.cells.map(cell => cell.level)), 4);
    assert.deepEqual(s.chars.map(item => item.key), ['A.png', 'B.png']); assert.equal(s.top, 200 * MIN);
    assert.deepEqual([durationText(0), durationText(30000), durationText(5 * MIN), durationText(125 * MIN), durationText(120 * MIN), clockText(170 * MIN)], ['0 分钟', '不到 1 分钟', '5 分钟', '2 小时 5 分', '2 小时', '2:50']);
    // 今天还没用，昨天之前连着：不算断。
    assert.equal(usageSummary({ days: { [day(1)]: 5, [day(2)]: 5 } }, T0).streak, 2);
});

test('the panel markup: heat grid and six cards on the home page; the character page lists face, name, a bar, total time and the last chat; text is escaped', () => {
    const data = { since: T0 - 86400000, days: { [dayKey(T0)]: 170 * MIN }, hours: Array(24).fill(0), chars: { 'A.png': { name: '<b>阿澈</b>', ms: 100 * MIN, last: T0 - 86400000 }, 'B.png': { name: '店主', ms: 25 * MIN, last: 0 } } };
    const home = usageMarkup(data, { now: T0 });
    assert.match(home, /<h3>时长<\/h3>/); assert.equal((home.match(/class="qm-usage-card"/g) || []).length, 6); assert.equal((home.match(/<i data-level=/g) || []).length, 140);
    assert.match(home, /<em>今日<\/em><strong>2:50<\/strong>/); assert.match(home, /data-usage-page="chars"><span>角色时长<\/span><span>2 位/);
    assert.match(home, /data-usage-shift="1" aria-label="更早" disabled/);
    const chars = usageMarkup(data, { now: T0, page: 'chars' });
    assert.match(chars, /<h3>角色时长<\/h3>/); assert.ok(chars.includes('&lt;b&gt;阿澈&lt;/b&gt;') && !chars.includes('<b>阿澈</b>'));
    assert.match(chars, /1 小时 40 分/); assert.match(chars, /--p:100%/); assert.match(chars, /--p:25%/); assert.match(chars, /最后一次聊天：昨天 14:00/); assert.match(chars, /最后一次聊天：还没有聊过/);
    assert.match(chars, /src="\/thumbnail\?type=avatar&amp;file=A\.png"/);
    assert.match(usageMarkup({}, { now: T0, page: 'chars' }), /还没有和谁聊过/);
    assert.deepEqual([lastChatText(T0 - 60000, T0), lastChatText(T0 - 3 * 86400000, T0), lastChatText(new Date(2026, 9, 1, 8).getTime(), T0)], ['今天 13:59', '3 天前', '2026年10月1日']);
});
