import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { focusClockFormat, focusClockDateKey, focusClockWeekStart } from '../qianmu-focus-time.js';

test('countdown display rounds up so a live last second never appears finished', () => {
  for (const [value, expected] of [[0,'00:00'],[-100,'00:00'],[1,'00:01'],[999,'00:01'],[1001,'00:02'],[60000,'01:00'],[60001,'01:01'],[14400000,'240:00'],['60000','01:00'],[null,'00:00'],[undefined,'00:00']]) {
    assert.equal(focusClockFormat(value), expected);
  }
});

test('calendar keys use the device calendar, not the UTC date of a reading session', () => {
  assert.equal(focusClockDateKey(new Date(2026, 0, 2, 0, 1)), '2026-01-02');
  assert.equal(focusClockDateKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('Sunday belongs to the preceding Monday and input date is never changed', () => {
  const source = new Date(2026, 8, 13, 18, 25, 49), before = source.getTime();
  const start = focusClockWeekStart(source);
  assert.equal(focusClockDateKey(start), '2026-09-07');
  assert.deepEqual([start.getHours(),start.getMinutes(),start.getSeconds(),start.getMilliseconds()], [0,0,0,0]);
  assert.equal(source.getTime(), before);
  assert.notEqual(start, source);
});

test('weekly history boundaries cross month and year without changing Monday semantics', () => {
  assert.equal(focusClockDateKey(focusClockWeekStart(new Date(2026,0,1,12))), '2025-12-29');
  assert.equal(focusClockDateKey(focusClockWeekStart(new Date(2026,8,14,12))), '2026-09-14');
});

test('moving presentation code preserves legacy invalid-input behavior, not a hidden cleanup', () => {
  assert.equal(focusClockFormat('not-a-number'), 'NaN:NaN');
  assert.equal(focusClockDateKey('not-a-date'), 'NaN-NaN-NaN');
  assert.ok(Number.isNaN(focusClockWeekStart('not-a-date').getTime()));
});

test('entry uses the shipped module; no duplicate helper or reverse entry dependency remains', async () => {
  const [entry, module, release] = await Promise.all(['index.js','qianmu-focus-time.js','release-files.json'].map(file => readFile(new URL(`../${file}`,import.meta.url),'utf8')));
  assert.match(entry, /import \{ focusClockFormat, focusClockDateKey, focusClockWeekStart \} from '\.\/qianmu-focus-time\.js'/);
  assert.doesNotMatch(entry, /function (?:focusClockFormat|focusClockDateKey|focusClockWeekStart)\(/);
  assert.doesNotMatch(module, /\b(?:import|settings|document|localStorage|setInterval|setTimeout)\s*[.(=]/);
  assert.ok(JSON.parse(release).files.includes('qianmu-focus-time.js'));
});
