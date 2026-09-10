import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { focusWeekHistory, focusTodayHistory, focusWeekStats } from '../qianmu-focus-history.js';

const time = (day, hour = 12) => new Date(2026,8,day,hour).getTime();
const row = (day, extra = {}) => Object.freeze({kind:'focus',finishedAt:time(day),durationMs:60000,activity:'task',...extra});

test('read-only projections preserve rows and ordering without trimming or rewriting stored history', () => {
  const records = Object.freeze([row(10),row(6),row(7),row(9,{kind:'shortBreak'}),null]);
  const before = JSON.stringify(records);
  assert.deepEqual(focusWeekHistory(records,time(10)),[records[0],records[2]]);
  assert.deepEqual(focusTodayHistory(records,time(10)),[records[0]]);
  assert.equal(JSON.stringify(records),before);
});

test('seven-day counts keep per-record minute rounding and reading totals, not rounded aggregate time', () => {
  const records = Object.freeze([row(7,{durationMs:1000}),row(7,{durationMs:89000,activity:'reading'}),row(13,{durationMs:90000,activity:'reading'})]);
  const stats = focusWeekStats(records,time(10));
  assert.equal(stats.days.length,7);
  assert.deepEqual(stats.days.map(day=>day.key),['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13']);
  assert.deepEqual([stats.minutes,stats.count,stats.readingMinutes],[4,3,3]);
  assert.deepEqual([stats.days[0].minutes,stats.days[0].count,stats.days[0].readingMinutes],[2,2,1]);
});

test('legacy missing completion dates use start time; null rows and non-focus phases do not count', () => {
  const record=row(1,{finishedAt:0,startedAt:time(10),durationMs:0,activity:'reading'});
  const records=[record,null,row(10,{kind:'longBreak'}),row(10,{finishedAt:'invalid'})];
  assert.deepEqual(focusTodayHistory(records,time(10)),[record]);
  assert.deepEqual(focusWeekHistory(records,time(10)),[record]);
  const stats=focusWeekStats(records,time(10));
  assert.deepEqual([stats.minutes,stats.count,stats.readingMinutes],[1,1,1]);
});

test('existing future-row policy is preserved: retained by history projection, excluded from this week chart', () => {
  const future=row(14);
  const stats=focusWeekStats([future],time(10));
  assert.deepEqual(stats.history,[future]);
  assert.equal(stats.count,0);
});

test('empty history and year-crossing week have seven days and no fabricated completed sessions', () => {
  const stats=focusWeekStats([],new Date(2026,0,1,12).getTime());
  assert.equal(stats.days[0].key,'2025-12-29');
  assert.equal(stats.days[6].key,'2026-01-04');
  assert.deepEqual([stats.minutes,stats.count,stats.readingMinutes],[0,0,0]);
});

test('history module has only the calendar dependency and ships with a thin state-owning entry adapter', async () => {
  const [source,entry,release]=await Promise.all(['qianmu-focus-history.js','index.js','release-files.json'].map(file=>readFile(new URL(`../${file}`,import.meta.url),'utf8')));
  assert.match(source,/from '\.\/qianmu-focus-time\.js'/);
  assert.doesNotMatch(source,/\b(?:settings|document|saveSettings|localStorage|setInterval|fetch)\b/);
  for(const name of ['WeekHistory','TodayHistory','WeekStats']) {
    assert.ok(entry.includes(`return focus${name}(state.history);`));
  }
  assert.ok(JSON.parse(release).files.includes('qianmu-focus-history.js'));
});
