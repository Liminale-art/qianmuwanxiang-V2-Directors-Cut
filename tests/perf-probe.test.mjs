import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPerfProbe } from '../qianmu-perf-probe.js';

const memory = (initial = {}) => { const data = { ...initial }; return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, removeItem: key => { delete data[key]; } }; };

test('the probe is off by default and records nothing', () => {
  const probe = createPerfProbe({ storage: memory() });
  assert.equal(probe.enabled, false);
  const end = probe.start('便笺'); end('显示'); end.frame('显示'); probe.record('主面板·dashboard', '渲染', 12);
  assert.deepEqual(probe.summary(), []);
  assert.equal(probe.report(), '还没有记录');
});

test('on() persists the switch, spans record several phases, frame() waits for the next frame', () => {
  const storage = memory(); let clock = 0; const frames = [];
  const probe = createPerfProbe({ storage, now: () => clock, raf: fn => frames.push(fn) });
  probe.on();
  assert.equal(storage.data['qianmu.perf'], '1');
  const end = probe.start('便笺');
  clock = 20; end.frame('显示'); clock = 35; frames.shift()();
  clock = 180; end('数据就绪');
  const again = probe.start('便笺'); clock = 190; again('数据就绪');
  probe.record('主面板·theater', '渲染', 7.26); probe.record('主面板·theater', '渲染', NaN);
  assert.deepEqual(probe.summary(), [
    { 位置: '便笺', 阶段: '显示', 次数: 1, 平均ms: 35, 最大ms: 35, 最近ms: 35 },
    { 位置: '便笺', 阶段: '数据就绪', 次数: 2, 平均ms: 95, 最大ms: 180, 最近ms: 10 },
    { 位置: '主面板·theater', 阶段: '渲染', 次数: 1, 平均ms: 7.3, 最大ms: 7.3, 最近ms: 7.3 },
  ]);
  assert.match(probe.text(), /便笺\t数据就绪\t次数 2\t平均 95ms/);
  probe.clear(); assert.deepEqual(probe.summary(), []);
  probe.off(); assert.equal(storage.data['qianmu.perf'], undefined);
  assert.equal(createPerfProbe({ storage: memory({ 'qianmu.perf': '1' }) }).enabled, true);
});

test('rows are bounded and a blocked storage only loses persistence', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const probe = createPerfProbe({ storage: blocked, limit: 3 });
  assert.equal(probe.enabled, false); probe.on(); assert.equal(probe.enabled, true);
  for (let i = 0; i < 10; i++) probe.record('a', 'b', i);
  assert.deepEqual(probe.summary(), [{ 位置: 'a', 阶段: 'b', 次数: 3, 平均ms: 8, 最大ms: 9, 最近ms: 9 }]);
});

test('the entry reaches the probe only through an optional global, and warms first-open code when idle', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /globalThis\.qianmuPerf \|\|= createPerfProbe\(\);/);
  const uses = entry.match(/qianmuPerf\b[^\n]{0,12}/g).filter(use => !use.startsWith('qianmuPerf ||='));
  assert.ok(uses.length >= 5); for (const use of uses) assert.match(use, /^qianmuPerf\?\./, use);
  const extra = entry.slice(entry.indexOf('function scheduleExtraPreload()'), entry.indexOf('function closeFloorNavigator()'));
  for (const piece of ['chatRegex.preload()', 'chatRingtone.preload()', 'loadChatRecoveryCode()', "loadLocalChunk('./qianmu-prose-assistant-conversations.js')", "import('./qianmu-notes-sync-runtime.js?v=1.59.419')"]) assert.ok(extra.includes(piece), piece);
  const notes = await readFile(new URL('../qianmu-notes.js', import.meta.url), 'utf8');
  for (const url of ["import('./qianmu-notes-sync-runtime.js?v=1.59.419')", "import('./qianmu-st-account-storage.js')"]) assert.ok(notes.includes(url) && extra.includes(url), url + ' must stay identical in both places');
  assert.match(entry, /stopExtraPreload\?\.\(\); stopExtraPreload = null;/);
  for (const file of ['features/chat/qianmu-chat-regex.js', 'features/chat/qianmu-chat-ringtone.js']) assert.match(await readFile(new URL('../' + file, import.meta.url), 'utf8'), /const preload = \(\) => loadView\(\)\.then\(\(\) => true, \(\) => false\);/);
});
