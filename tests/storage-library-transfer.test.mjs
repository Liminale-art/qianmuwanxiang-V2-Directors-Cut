import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStorageLibraryTransfer, planVibeBatches, planFocusBatches } from '../qianmu-storage-library-transfer.js';

const MB = 1024 * 1024;

test('Vibe originals are split at 16 files or about 56 MB per file, keeping order', () => {
  assert.deepEqual(planVibeBatches([]), []);
  const many = Array.from({ length: 35 }, (_, index) => ({ id: `v${index}`, bytes: 10 }));
  assert.deepEqual(planVibeBatches(many).map(batch => batch.length), [16, 16, 3]);
  assert.deepEqual(planVibeBatches(many).flat(), many.map(item => item.id));
  const heavy = [{ id: 'a', bytes: 30 * MB }, { id: 'b', bytes: 30 * MB }, { id: 'c', bytes: 10 * MB }, { id: 'd', bytes: 70 * MB }];
  assert.deepEqual(planVibeBatches(heavy), [['a'], ['b', 'c'], ['d']]);
});

test('focus voices are split under the backup size and count limits; an oversized clip is set aside', () => {
  const limit = 32 * MB, row = (id, audioBytes) => ({ id, audioBytes });
  const plan = planFocusBatches([row('a', 12 * MB), row('b', 12 * MB), row('c', 1 * MB), row('huge', 30 * MB)], { limit, clips: 512 });
  assert.deepEqual(plan.batches.map(batch => batch.map(item => item.id)), [['a'], ['b', 'c']]);
  assert.deepEqual(plan.skipped.map(item => item.id), ['huge']);
  for (const batch of plan.batches) assert.ok(batch.reduce((sum, item) => sum + Math.ceil(item.audioBytes / 3) * 4 + 8192, 256) <= limit);
  const counted = planFocusBatches(Array.from({ length: 5 }, (_, index) => row(`r${index}`, 10)), { limit, clips: 2 });
  assert.deepEqual(counted.batches.map(batch => batch.length), [2, 2, 1]);
  assert.deepEqual(planFocusBatches([], { limit, clips: 512 }), { batches: [], skipped: [] });
});

function fixture(extra = {}) {
  const notes = [], saved = [], confirms = [];
  let namespace = 'st-user:a';
  const transfer = createStorageLibraryTransfer({ resolveNamespace: async () => namespace, confirm: async (title, text) => { confirms.push([title, text]); return true; },
    download: (blob, name) => saved.push([name, blob]), notify: (text, kind) => notes.push([kind, text]), ...extra });
  return { transfer, notes, saved, confirms, setNamespace: value => { namespace = value; } };
}

test('font rows call the library controller for the whole library and surface its user message on failure', async () => {
  const calls = [], fonts = { action: async (name, options) => { calls.push([name, options]); if (options?.file === 'bad') throw Object.assign(new Error('internal'), { userMessage: '字体包无法读取' }); } };
  const f = fixture({ fonts });
  await f.transfer.exports.fonts(); await f.transfer.imports.fonts('file'); await f.transfer.imports.fonts('bad');
  assert.deepEqual(calls, [['export', undefined], ['import', { file: 'file' }], ['import', { file: 'bad' }]]);
  assert.deepEqual(f.notes, [['warning', '字体库导入未完成：字体包无法读取']]);
});

test('only one library transfer runs at a time and the lock is released afterwards', async () => {
  let release; const calls = [], fonts = { action: name => { calls.push(name); return new Promise(resolve => { release = resolve; }); } };
  const f = fixture({ fonts }), first = f.transfer.exports.fonts();
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.transfer.exports.fonts();
  assert.deepEqual(calls, ['export']); assert.match(f.notes[0][1], /还在进行/);
  release(); await first;
  const again = f.transfer.exports.fonts(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 2); release(); await again;
});

test('Vibe export downloads one file per batch and restore refuses nothing-to-do or no-room plans without writing', async () => {
  const items = Array.from({ length: 18 }, (_, index) => ({ id: `v${index}`, bytes: 100 })), exported = [], restored = [];
  let plan = { missingCount: 0, fits: true };
  const actions = { list: async () => ({ items }), export: async (_snapshot, ids) => { exported.push(ids.length); return new Blob(['x']); },
    inspectRestore: async () => plan, restore: async (value, file, confirm) => { restored.push(file); assert.equal(typeof confirm, 'function'); return { restored: value.missingCount }; } };
  const made = [], storage = { createVibeStorageActions: options => { made.push(options); return actions; } };
  const f = fixture({ vibe: async () => ({ call: 'call', storage, items: () => [] }) });
  await f.transfer.exports.vibes();
  assert.deepEqual(exported, [16, 2]);
  assert.deepEqual(f.saved.map(([name]) => name), ['qianmu-vibe-backup-1of2.naiv4vibeBundle', 'qianmu-vibe-backup-2of2.naiv4vibeBundle']);
  assert.match(f.confirms[0][1], /18 份[\s\S]*2 个文件/); assert.equal(made[0].namespace, 'st-user:a'); assert.equal(made[0].call, 'call');
  await f.transfer.imports.vibes('same'); assert.deepEqual(restored, []); assert.match(f.notes.at(-1)[1], /无需恢复/);
  plan = { missingCount: 3, fits: false }; await f.transfer.imports.vibes('big'); assert.deepEqual(restored, []); assert.match(f.notes.at(-1)[1], /放不下/);
  plan = { missingCount: 3, fits: true }; await f.transfer.imports.vibes('ok'); assert.deepEqual(restored, ['ok']); assert.deepEqual(f.notes.at(-1), ['success', '已恢复 3 份 Vibe 原件。']);
});

test('an account switch during a transfer stops it before anything is saved', async () => {
  const f = fixture({ vibe: async () => { f.setNamespace('st-user:b'); return { call: null, storage: { createVibeStorageActions: () => assert.fail('must not reach the library') }, items: () => [] }; } });
  await f.transfer.exports.vibes();
  assert.deepEqual(f.saved, []); assert.match(f.notes[0][1], /账户已变化/);
});

test('focus rows stay closed while another data task holds the voice library', async () => {
  const f = fixture({ focusFree: () => false });
  await f.transfer.exports.focus(); await f.transfer.imports.focus('file');
  assert.equal(f.notes.length, 2); for (const [, text] of f.notes) assert.match(text, /请先结束当前任务/);
  assert.deepEqual(f.saved, []);
});
