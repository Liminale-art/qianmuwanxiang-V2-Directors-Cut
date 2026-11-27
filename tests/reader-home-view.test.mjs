import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReaderShell, renderReaderHome, renderReaderStats, readerPageOf, homeCardOrder, moveHomeCard, toggleHomeCard, renderReaderHeat } from '../features/reader/qianmu-reader-home-view.js';
import { readerSummary } from '../features/reader/qianmu-reader-log.js';

const esc = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const now = new Date(2026, 10, 28, 21, 0, 0).getTime();
const log = {
  time: { days: { '2026-11-28': 30 * 60000 }, chars: { 'a.png': { name: '书友甲', ms: 30 * 60000, last: 0 }, 'b.png': { name: '书友乙', ms: 10 * 60000, last: 0 } } },
  books: { b1: { ms: 30 * 60000, chars: 5200, last: now, done: now } },
  days: { '2026-11-28': 5200 },
  pals: { 'a.png': { name: '书友甲', chars: 5200, last: now - 1000 }, 'b.png': { name: '书友乙', chars: 0, last: now } },
  talk: { bookId: 'b1', at: now, pal: { key: 'a.png', name: '书友甲' }, user: '我', lines: [{ who: 'user', text: '<这一段>' }, { who: 'pal', text: '嗯' }] },
};
const books = [{ id: 'b1', title: '一本书', author: '某人', progress: 42, lastReadAt: now }];

test('shell has the three pages, back and close; unknown pages fall back to home', () => {
  const html = renderReaderShell('stats', '<p>x</p>');
  for (const page of ['home', 'shelf', 'stats']) assert.match(html, new RegExp(`data-coread-page="${page}"`));
  assert.match(html, /sd-coread-nav-tab active" data-coread-page="stats"/);
  assert.match(html, /sd-coread-back/); assert.match(html, /sd-coread-close/);
  assert.equal(readerPageOf('nope'), 'home');
});

test('home shows continue reading, today, the last companion with ranking, the latest talk and the calendar', () => {
  const summary = readerSummary(log, books, now);
  const html = renderReaderHome(summary, { current: books[0], time: log.time, now, esc, cover: () => '<i class="cover"></i>' });
  assert.match(html, /一本书/); assert.match(html, /42%/); assert.match(html, /data-book="b1"/);
  assert.match(html, /30 分钟/); assert.match(html, /5200 字/);
  assert.match(html, /书友乙/);                                   // 最后伴读的是乙
  assert.match(html, /sd-coread-rank-row is-top/);
  assert.match(html, /&lt;这一段&gt;/);                            // 对话原文转义
  assert.match(html, /sd-coread-heat/);
  assert.equal((html.match(/data-today/g) || []).length, 1);
});

test('home without any book offers the shelf; stats lists books and companions', () => {
  const empty = renderReaderHome(readerSummary(null, [], now), { now, esc });
  assert.match(empty, /data-coread-page="shelf"/);
  assert.doesNotMatch(empty, /sd-coread-talk/);
  const stats = renderReaderStats(readerSummary(log, books, now), { time: log.time, now, esc });
  assert.match(stats, /一本书 <i class="fa-solid fa-check"><\/i>/);
  assert.match(stats, /书友甲/); assert.match(stats, /读完 1 本/);
});

test('home cards: order is normalized, can move and hide; editing shows tools and placeholders for empty cards', () => {
  assert.deepEqual(homeCardOrder([{ id: 'talk' }, { id: 'nope' }, { id: 'talk', hidden: true }]).map(c => c.id), ['talk', 'continue', 'today', 'pal', 'calendar']);
  let order = moveHomeCard(null, 'calendar', -1);
  assert.deepEqual(order.map(c => c.id), ['continue', 'today', 'pal', 'calendar', 'talk']);
  assert.deepEqual(moveHomeCard(order, 'continue', -1), order);          // 到头了不动
  order = toggleHomeCard(order, 'today');
  const summary = readerSummary(log, books, now);
  const html = renderReaderHome(summary, { current: books[0], time: log.time, days: log.days, now, esc, cards: order });
  assert.doesNotMatch(html, /sd-coread-today/);                           // 藏起来了
  assert.ok(html.indexOf('sd-coread-calendar') < html.indexOf('sd-coread-talk'));
  const editing = renderReaderHome(readerSummary(null, [], now), { now, esc, cards: order, editing: true });
  assert.match(editing, /sd-coread-slot-today is-hidden/);
  assert.match(editing, /sd-coread-talk sd-coread-placeholder/);         // 没有对话也露出位置
  assert.match(editing, /data-home-move="-1" data-card="continue" aria-label="前移" disabled/);
});

test('calendar cells carry their day text; the line under the grid starts on today', () => {
  const html = renderReaderHeat(log.time, now, log.days);
  assert.match(html, /class="on" title="11月28日 · 30 分钟 · 5200 字"/);
  assert.match(html, /<p class="sd-coread-heat-day" aria-live="polite">11月28日 · 30 分钟 · 5200 字<\/p>/);
  assert.match(html, /data-text="[^"]*没读"/);
});
