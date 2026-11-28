import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderLog, normalizeReaderLog, readAdvance, readerSummary, READ_JUMP_CHARS } from '../features/reader/qianmu-reader-log.js';

const MIN = 60000;
const TICK = 15000;
// 节拍每 15 秒一次（与真实一致）；每 every 毫秒有一次操作。
const read = (c, log, ms, every = MIN) => { for (let t = TICK; t <= ms; t += TICK) { c.go(TICK); if (t % every === 0) log.touch(); log.tick(); } };
const clock = (start = new Date(2026, 10, 28, 20, 0, 0).getTime()) => { let at = start; return { now: () => at, go: ms => { at += ms; } }; };

test('readAdvance counts forward reading once, ignores back-flips, re-reads and jumps', () => {
  let s = readAdvance({ mark: 0, last: null, pos: 100 });
  assert.deepEqual(s, { add: 0, mark: 0, last: 100 });                  // 第一次只定起点
  s = readAdvance({ mark: s.mark, last: s.last, pos: 900 });
  assert.equal(s.add, 800); assert.equal(s.mark, 900);
  s = readAdvance({ mark: s.mark, last: s.last, pos: 300 });            // 往回翻
  assert.equal(s.add, 0); assert.equal(s.mark, 900);
  s = readAdvance({ mark: s.mark, last: s.last, pos: 1000 });           // 重读到原处之前的不算
  assert.equal(s.add, 100);
  s = readAdvance({ mark: s.mark, last: s.last, pos: 1000 + READ_JUMP_CHARS + 1 });   // 跳得太远
  assert.equal(s.add, 0); assert.equal(s.mark, 1000);
  s = readAdvance({ mark: s.mark, last: s.last, pos: s.last + 500 });   // 跳过去以后接着读的照算
  assert.equal(s.add, 500);
});

test('reading time follows the usage rules and is booked per day, per book and per companion', () => {
  const c = clock(); let saved = null;
  const log = createReaderLog({ load: () => null, save: data => { saved = data; }, now: c.now });
  const pal = { key: 'pal.png', name: '书友甲' };
  read(c, log, MIN);                                       // 没开书：不算
  log.open('b1', { pal, pos: 0 });
  read(c, log, 4 * MIN);                                  // 四分钟里每分钟有操作
  read(c, log, 10 * MIN, Infinity);                       // 之后挂着不动：不算
  log.close();
  const data = normalizeReaderLog(saved);
  assert.equal(data.books.b1.ms, 4 * MIN);
  assert.equal(Object.values(data.time.days)[0], 4 * MIN);
  assert.equal(data.time.chars['pal.png'].ms, 4 * MIN);
  assert.equal(data.time.chars['pal.png'].name, '书友甲');
  // 关书后紧接着开另一本：关书前后的那段空当不算到新书上
  c.go(5000); log.open('b2', { pos: 0 }); read(c, log, MIN); log.close();
  assert.equal(normalizeReaderLog(saved).books.b2.ms, MIN);
});

test('characters read and finished books are recorded', () => {
  const c = clock(); let saved = null;
  const log = createReaderLog({ save: data => { saved = data; }, now: c.now });
  log.open('b1', { pal: { key: 'pal.png', name: '甲' }, pos: 0 });
  log.progress(2000); log.progress(1500); log.progress(4000, { done: true });
  log.close();
  const data = normalizeReaderLog(saved);
  assert.equal(data.books.b1.chars, 4000);
  assert.equal(data.pals['pal.png'].chars, 4000);
  assert.equal(Object.values(data.days)[0], 4000);
  assert.ok(data.books.b1.done > 0);
  // 再打开从头重读：已经算过的字不重复算
  log.open('b1', { pos: 0 }); log.progress(3000); log.close();
  assert.equal(normalizeReaderLog(saved).books.b1.chars, 4000);
});

test('talk keeps only the last few short lines, summary only counts books still on the shelf', () => {
  const c = clock(); let saved = null;
  const log = createReaderLog({ save: data => { saved = data; }, now: c.now });
  log.open('b1', { pal: { key: 'pal.png', name: '甲' } }); read(c, log, MIN); log.progress(0); log.progress(800); log.close();
  log.open('gone', {}); read(c, log, MIN); log.close();
  log.talk({ bookId: 'b1', pal: { key: 'pal.png', name: '甲' }, user: '我', lines: [1, 2, 3, 4, 5].map(n => ({ who: n % 2 ? 'user' : 'pal', text: `第${n}句`.padEnd(400, '。') })) });
  const s = readerSummary(saved, [{ id: 'b1', title: '书' }], c.now());
  assert.equal(s.read, 1);
  assert.equal(s.books[0].id, 'b1');
  assert.equal(s.today.chars, 800);
  assert.equal(s.lastPal.name, '甲');
  assert.equal(s.talk.lines.length, 4);
  assert.equal(s.talk.lines[0].text.slice(0, 3), '第2句');
  assert.ok(s.talk.lines.every(line => line.text.length <= 160));
  assert.equal(s.talk.book.title, '书');
  assert.equal(readerSummary(saved, [], c.now()).talk, null);
});

test('normalizeReaderLog drops malformed parts without throwing', () => {
  const data = normalizeReaderLog({ books: { b: { ms: -5, chars: 'x' }, '': {} }, days: { bad: 3, '2026-11-28': 10 }, pals: { p: null }, talk: { bookId: 'b', lines: [] } });
  assert.deepEqual(data.books, { b: { ms: 0, chars: 0, mark: 0, last: 0 } });
  assert.deepEqual(data.days, { '2026-11-28': 10 });
  assert.deepEqual(data.pals, {});
  assert.equal(data.talk, null);
  assert.doesNotThrow(() => normalizeReaderLog('nope'));
});

// 导入伴读整包会把 coread.readLog 换成一份新对象；运行中的阅读记录如果还拿着旧的那份，下一次存就把导入的统计写回旧值。
test('an import that replaces the stored record is not overwritten by the live copy after reload', () => {
  const c = clock(), host = { readLog: { books: { local: { ms: 1000, chars: 10, mark: 10, last: 1 } }, days: {}, pals: {} } };
  const options = { load: () => host.readLog, save: data => { host.readLog = data; }, now: c.now };
  const stale = createReaderLog(options);
  host.readLog = stale.data;
  host.readLog = { books: { imported: { ms: 90000, chars: 3400, mark: 3400, last: 2 } }, days: { '2026-11-24': 3400 }, pals: {} };
  stale.open('local'); stale.close();
  assert.equal(host.readLog.books.imported, undefined, 'without reload the live copy writes the old record back');

  const c2 = clock(), host2 = { readLog: { books: { local: { ms: 1000, chars: 10, mark: 10, last: 1 } }, days: {}, pals: {} } };
  const log = createReaderLog({ load: () => host2.readLog, save: data => { host2.readLog = data; }, now: c2.now });
  host2.readLog = log.data;
  const before = log.data;
  host2.readLog = { books: { imported: { ms: 90000, chars: 3400, mark: 3400, last: 2 } }, days: { '2026-11-24': 3400 }, pals: {} };
  log.reload();
  assert.equal(before.books.local.ms, 1000, 'reload does not rewrite the previous object (a compensating restore can still put it back)');
  log.open('imported'); log.progress(3400); log.progress(3500); log.close();
  assert.equal(host2.readLog.books.imported.chars, 3500);
  assert.equal(host2.readLog.days['2026-11-24'], 3400);
  assert.equal(host2.readLog.books.local, undefined);
  read(c2, log, MIN);
  log.reload();
  assert.equal(log.reading, '', 'reload ends an open session without writing it over the reloaded record');
});
