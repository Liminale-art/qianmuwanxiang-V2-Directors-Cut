import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORAGE_TRANSFER_ITEMS, detectStorageFile, buildStoragePack, isStoragePack, openStoragePack, runStorageExport, runStorageImport } from '../qianmu-storage-transfer.js';

const bytesOf = async blob => [...new Uint8Array(await blob.arrayBuffer())];
const json = (value, name) => new File([JSON.stringify(value)], name, { type: 'application/json' });
const SAMPLES = {
  config: { version: 2, type: 'qianmu-config', settings: {} },
  notes: { type: 'qianmu-notes', version: 1, notes: [] },
  collection: { type: 'qianmu-text-collection', version: 1, document: {} },
  favorites: { type: 'qianmu-tts-favorites', version: 1, entries: [] },
  audio: { version: 1, type: 'qianmu-tts-audio-cache', entries: [] },
  reader: { type: 'qianmu-coread', version: 5, books: [] },
  assistant: { type: 'qianmu-assistant-library', version: 1, histories: [] },
  focus: { schema: 'qianmu.focus.library.v1', credentialsIncluded: false, items: [] },
  ringtones: { type: 'qianmu-ringtones', version: 1, sounds: [] },
};
const sample = (key, name = `${key}.json`) => json(SAMPLES[key], name);

// dialogs 假件：记录每次弹窗的参数，按 answer(options) 给出勾选结果。
function fakeDialogs(answer) {
  const calls = [];
  return { calls, choose: async options => { calls.push(options); return answer(options); } };
}
const allIds = options => options.items.map(item => item.id);
function notices() {
  const list = [];
  return { list, notify: (text, kind) => list.push([text, kind]) };
}

// ── 打包 ──

test('a pack round-trips names and bytes, including a non-ASCII filename and an empty file', async () => {
  const binary = new Uint8Array(70000); for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + 7) & 0xff;
  const files = [
    { name: 'qianmu-notes-1.json', blob: new Blob(['{"type":"qianmu-notes","notes":["甲"]}']) },
    { name: 'qianmu-语音收藏-2.json', blob: new Blob([binary]) },
    { name: 'empty.json', blob: new Blob([]) },
  ];
  const pack = await buildStoragePack(files);
  assert.equal(pack.type, 'application/zip');
  assert.equal(await isStoragePack(pack), true);
  const opened = await openStoragePack(pack);
  assert.deepEqual(opened.map(file => file.name), files.map(file => file.name));
  for (let index = 0; index < files.length; index++) {
    assert.ok(opened[index] instanceof File);
    assert.deepEqual(await bytesOf(opened[index]), await bytesOf(files[index].blob));
  }
});

test('the pack is a plain stored zip: sizes, offsets, UTF-8 flag and CRC-32 are what other tools expect', async () => {
  const name = '备份.json', label = new TextEncoder().encode(name);
  const pack = await buildStoragePack([{ name, blob: new Blob(['123456789']) }]);
  const view = new DataView(await pack.arrayBuffer());
  assert.equal(view.byteLength, 30 + label.length + 9 + 46 + label.length + 22);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0800);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.equal(view.getUint32(18, true), 9);
  assert.equal(view.getUint32(22, true), 9);
  assert.equal(view.getUint16(26, true), label.length);
  const central = 30 + label.length + 9;
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint16(central + 8, true), 0x0800);
  assert.equal(view.getUint32(central + 16, true), 0xcbf43926);
  assert.equal(view.getUint32(central + 42, true), 0);
  const end = central + 46 + label.length;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 8, true), 1);
  assert.equal(view.getUint16(end + 10, true), 1);
  assert.equal(view.getUint32(end + 12, true), 46 + label.length);
  assert.equal(view.getUint32(end + 16, true), central);
});

test('a path inside a pack is reduced to its file name', async () => {
  const [file] = await openStoragePack(await buildStoragePack([{ name: 'nested/dir/notes.json', blob: new Blob(['{}']) }]));
  assert.equal(file.name, 'notes.json');
});

test('isStoragePack only accepts the zip local-header signature', async () => {
  assert.equal(await isStoragePack(new Blob(['{"type":"qianmu-notes"}'])), false);
  assert.equal(await isStoragePack(new Blob([])), false);
  assert.equal(await isStoragePack(new Blob(['PK'])), false);
  assert.equal(await isStoragePack(new Blob([new Uint8Array([0x50, 0x4b, 5, 6])])), false);
  assert.equal(await isStoragePack(new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 9, 9])])), true);
});

test('garbage, truncated and compressed zips are rejected instead of guessed at', async () => {
  const garbage = new Blob([new Uint8Array([0x50, 0x4b, 3, 4]), 'this is not a zip archive at all, only a header that looks like one']);
  assert.equal(await isStoragePack(garbage), true);
  await assert.rejects(openStoragePack(garbage), /不是千幕的打包备份/);
  await assert.rejects(openStoragePack(new Blob([new Uint8Array([0x50, 0x4b, 3, 4])])), /不是千幕的打包备份/);

  const pack = await buildStoragePack([{ name: 'a.json', blob: new Blob(['{"type":"qianmu-notes"}']) }, { name: 'b.json', blob: new Blob(['{"type":"qianmu-config"}']) }]);
  await assert.rejects(openStoragePack(pack.slice(0, pack.size - 5)), /不是千幕的打包备份/);

  const bytes = new Uint8Array(await pack.arrayBuffer()), view = new DataView(bytes.buffer);
  const directory = view.getUint32(bytes.length - 22 + 16, true);
  const deflated = bytes.slice(); new DataView(deflated.buffer).setUint16(directory + 10, 8, true);
  await assert.rejects(openStoragePack(new Blob([deflated])), /不是千幕的打包备份/);

  const broken = bytes.slice(); broken[0] = 0;
  await assert.rejects(openStoragePack(new Blob([broken])), /打包备份已损坏/);

  const overlong = bytes.slice(); new DataView(overlong.buffer).setUint32(directory + 24, bytes.length, true);
  await assert.rejects(openStoragePack(new Blob([overlong])), /打包备份不完整/);
});

// ── 识别 ──

test('every backup kind is recognised from its own marker', async () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), STORAGE_TRANSFER_ITEMS.map(([key]) => key).sort());
  for (const key of Object.keys(SAMPLES)) {
    assert.equal(await detectStorageFile(sample(key)), key, key);
    assert.equal(await detectStorageFile(new File([JSON.stringify(SAMPLES[key], null, 2)], 'pretty.json')), key, `${key} (indented)`);
  }
});

test('files without a marker in their head are unknown', async () => {
  assert.equal(await detectStorageFile(json({ type: 'something-else', items: [] }, 'other.json')), '');
  assert.equal(await detectStorageFile(new File(['plain text'], 'note.txt')), '');
  assert.equal(await detectStorageFile(new File([], 'empty.json')), '');
  assert.equal(await detectStorageFile(json({ type: 'qianmu-config-extra' }, 'near.json')), '');
  assert.equal(await detectStorageFile(json({ kind: 'qianmu-notes' }, 'wrong-key.json')), '');
  // Only the head is read; a marker that first appears later does not count.
  assert.equal(await detectStorageFile(new File([`{"pad":"${'x'.repeat(5000)}","type":"qianmu-notes"}`], 'late.json')), '');
});

// ── 导出 ──

// 与入口文件的做法一致：work 期间各项把要下载的文件放进 sink，结束后交还。
function exportHarness(answer, exports) {
  const sink = { files: null }, downloads = [], log = notices(), dialogs = fakeDialogs(answer);
  let captures = 0;
  const emit = (name, text) => { if (sink.files) sink.files.push({ blob: new Blob([text]), name }); else downloads.push({ name, direct: true }); };
  const capture = async work => { captures++; sink.files = []; try { await work(); } finally { var files = sink.files; sink.files = null; } return files; };
  const download = (blob, name) => downloads.push({ blob, name });
  const button = { id: 'export-button' };
  const run = () => runStorageExport({ dialogs, exports: exports(emit), capture, download, notify: log.notify, stamp: () => 'STAMP', button });
  return { run, dialogs, downloads, notices: log.list, button, captures: () => captures };
}

test('the export dialog offers only the items that can be exported, audio cache unticked', async () => {
  const harness = exportHarness(() => null, () => ({ notes: async () => {}, audio: async () => {}, config: async () => {} }));
  await harness.run();
  assert.equal(harness.dialogs.calls.length, 1);
  const [options] = harness.dialogs.calls;
  assert.equal(options.title, '导出');
  assert.equal(options.action, '导出');
  assert.deepEqual(options.items, [{ id: 'config', label: '配置', checked: true }, { id: 'notes', label: '便笺', checked: true }, { id: 'audio', label: '音频缓存', checked: false }]);
});

test('one selected item is exported directly, without packing', async () => {
  const calls = [];
  const harness = exportHarness(() => ['notes'], emit => ({ notes: async button => { calls.push(button); emit('qianmu-notes-1.json', '{}'); }, config: async () => calls.push('config') }));
  await harness.run();
  assert.deepEqual(calls, [harness.button]);
  assert.equal(harness.captures(), 0);
  assert.deepEqual(harness.downloads, [{ name: 'qianmu-notes-1.json', direct: true }]);
  assert.deepEqual(harness.notices, []);
});

test('several selected items become one zip download holding each item’s own backup file', async () => {
  const order = [];
  const harness = exportHarness(() => ['config', 'notes', 'reader'], emit => ({
    config: async button => { order.push(['config', button]); emit('qianmu-config-1.json', JSON.stringify(SAMPLES.config)); },
    notes: async button => { order.push(['notes', button]); emit('qianmu-notes-1.json', JSON.stringify(SAMPLES.notes)); },
    reader: async button => { order.push(['reader', button]); emit('qianmu-伴读-1.json', JSON.stringify(SAMPLES.reader)); },
    audio: async () => order.push(['audio']),
  }));
  await harness.run();
  assert.deepEqual(order, [['config', harness.button], ['notes', harness.button], ['reader', harness.button]]);
  assert.equal(harness.captures(), 1);
  assert.equal(harness.downloads.length, 1);
  const [{ blob, name }] = harness.downloads;
  assert.equal(name, 'qianmu-backup-STAMP.zip');
  assert.match(name, /^qianmu-backup-.+\.zip$/);
  assert.equal(await isStoragePack(blob), true);
  const opened = await openStoragePack(blob);
  assert.deepEqual(opened.map(file => file.name), ['qianmu-config-1.json', 'qianmu-notes-1.json', 'qianmu-伴读-1.json']);
  assert.deepEqual(await Promise.all(opened.map(detectStorageFile)), ['config', 'notes', 'reader']);
  assert.equal(await opened[1].text(), JSON.stringify(SAMPLES.notes));
  assert.deepEqual(harness.notices, [['已打包导出 3 个文件。', 'success']]);
});

test('files that share a name are kept apart inside the pack', async () => {
  const harness = exportHarness(() => ['config', 'notes', 'reader'], emit => ({
    config: async () => emit('backup.json', 'one'), notes: async () => emit('backup.json', 'two'), reader: async () => emit('backup.json', 'three'),
  }));
  await harness.run();
  const opened = await openStoragePack(harness.downloads[0].blob);
  assert.deepEqual(opened.map(file => file.name), ['backup.json', 'backup-2.json', 'backup-3.json']);
  assert.deepEqual(await Promise.all(opened.map(file => file.text())), ['one', 'two', 'three']);
});

test('several selected but only one file produced: that file is downloaded as itself', async () => {
  const harness = exportHarness(() => ['config', 'notes'], emit => ({ config: async () => {}, notes: async () => emit('qianmu-notes-1.json', 'only') }));
  await harness.run();
  assert.equal(harness.downloads.length, 1);
  assert.equal(harness.downloads[0].name, 'qianmu-notes-1.json');
  assert.equal(await harness.downloads[0].blob.text(), 'only');
  assert.deepEqual(harness.notices, []);
});

test('several selected but nothing produced: a notice, no download', async () => {
  const harness = exportHarness(() => ['config', 'notes'], () => ({ config: async () => {}, notes: async () => {} }));
  await harness.run();
  assert.deepEqual(harness.downloads, []);
  assert.deepEqual(harness.notices, [['没有可导出的内容。', 'info']]);
});

test('cancelling the export dialog, or confirming nothing, exports nothing', async () => {
  for (const answer of [null, []]) {
    let called = 0;
    const harness = exportHarness(() => answer, () => ({ config: async () => called++, notes: async () => called++ }));
    await harness.run();
    assert.equal(called, 0);
    assert.equal(harness.captures(), 0);
    assert.deepEqual(harness.downloads, []);
    assert.deepEqual(harness.notices, []);
  }
});

test('an item that fails to export is reported and the rest still go out', async () => {
  const harness = exportHarness(() => ['config', 'notes', 'reader'], emit => ({
    config: async () => emit('qianmu-config-1.json', 'c'), notes: async () => { throw new Error('读不到'); }, reader: async () => emit('qianmu-reader-1.json', 'r'),
  }));
  await harness.run();
  assert.deepEqual((await openStoragePack(harness.downloads[0].blob)).map(file => file.name), ['qianmu-config-1.json', 'qianmu-reader-1.json']);
  assert.deepEqual(harness.notices, [['便笺导出未完成：读不到', 'warning'], ['已打包导出 2 个文件。', 'success']]);

  const single = exportHarness(() => ['notes'], () => ({ notes: async () => { throw new Error('读不到'); } }));
  await single.run();
  assert.deepEqual(single.notices, [['便笺导出未完成：读不到', 'warning']]);
});

// ── 导入 ──

function importHarness(answer, keys = Object.keys(SAMPLES), behaviour = {}) {
  const calls = [], log = notices(), dialogs = fakeDialogs(answer);
  const imports = Object.fromEntries(keys.map(key => [key, async (file, input, event) => { calls.push({ key, name: file.name, text: await file.text(), input, event }); await behaviour[key]?.(); }]));
  const run = (files, extra = {}) => runStorageImport({ dialogs, imports, files, notify: log.notify, ...extra });
  return { run, calls, dialogs, notices: log.list };
}

test('loose files and a pack are each routed to their own importer, config last, unknown files skipped', async () => {
  const pack = new File([await buildStoragePack([
    { name: 'qianmu-reader-1.json', blob: sample('reader') }, { name: 'qianmu-专注-1.json', blob: sample('focus') }, { name: 'readme.txt', blob: new Blob(['hello']) },
  ])], 'qianmu-backup-1.zip', { type: 'application/zip' });
  const harness = importHarness(allIds);
  await harness.run([sample('config', 'my-config.json'), sample('notes', 'my-notes.json'), pack, new File(['not a backup'], 'stray.json'), sample('ringtones', 'rings.json')]);

  assert.equal(harness.dialogs.calls.length, 1);
  const [options] = harness.dialogs.calls;
  assert.equal(options.title, '导入');
  assert.equal(options.action, '导入');
  assert.deepEqual(options.items, [
    { id: '0', label: '配置', meta: 'my-config.json', checked: true }, { id: '1', label: '便笺', meta: 'my-notes.json', checked: true },
    { id: '2', label: '伴读资料', meta: 'qianmu-reader-1.json', checked: true }, { id: '3', label: '专注语音库', meta: 'qianmu-专注-1.json', checked: true },
    { id: '4', label: '来电铃声', meta: 'rings.json', checked: true },
  ]);
  assert.deepEqual(harness.calls.map(call => [call.key, call.name]), [
    ['notes', 'my-notes.json'], ['reader', 'qianmu-reader-1.json'], ['focus', 'qianmu-专注-1.json'], ['ringtones', 'rings.json'], ['config', 'my-config.json'],
  ]);
  for (const call of harness.calls) assert.equal(call.text, JSON.stringify(SAMPLES[call.key]));
  assert.deepEqual(harness.notices, [['2 个文件不是千幕的备份，已略过。', 'info']]);
});

test('only the ticked files are imported', async () => {
  const harness = importHarness(() => ['2', '0']);
  await harness.run([sample('config'), sample('notes'), sample('favorites')]);
  assert.deepEqual(harness.calls.map(call => call.key), ['favorites', 'config']);
});

test('cancelling the import dialog, or confirming nothing, imports nothing', async () => {
  for (const answer of [null, []]) {
    const harness = importHarness(() => answer);
    await harness.run([sample('config'), sample('notes')]);
    assert.equal(harness.dialogs.calls.length, 1);
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.notices, []);
  }
});

test('when nothing is recognised there is no dialog, only a notice', async () => {
  const unknown = importHarness(allIds);
  await unknown.run([new File(['x'], 'a.txt'), json({ type: 'other' }, 'b.json')]);
  assert.deepEqual(unknown.dialogs.calls, []);
  assert.deepEqual(unknown.calls, []);
  assert.deepEqual(unknown.notices, [['选中的文件不是千幕的备份。', 'warning']]);

  const none = importHarness(allIds);
  await none.run([]);
  assert.deepEqual(none.dialogs.calls, []);
  assert.deepEqual(none.notices, [['没有可导入的内容。', 'warning']]);
});

test('a recognised kind without an importer counts as unknown', async () => {
  const harness = importHarness(allIds, ['notes']);
  await harness.run([sample('notes'), sample('audio', 'cache.json')]);
  assert.deepEqual(harness.dialogs.calls[0].items.map(item => item.meta), ['notes.json']);
  assert.deepEqual(harness.calls.map(call => call.key), ['notes']);
  assert.deepEqual(harness.notices, [['1 个文件不是千幕的备份，已略过。', 'info']]);
});

test('a zip that is not a pack is reported by name and the other files still import', async () => {
  const fake = new File([new Uint8Array([0x50, 0x4b, 3, 4]), 'garbage garbage garbage garbage'], 'photos.zip');
  const harness = importHarness(allIds);
  await harness.run([fake, sample('notes')]);
  assert.deepEqual(harness.calls.map(call => call.key), ['notes']);
  assert.deepEqual(harness.notices, [['photos.zip：不是千幕的打包备份', 'warning'], ['1 个文件不是千幕的备份，已略过。', 'info']]);
});

test('each file is handed over through the slot input, which is emptied afterwards', async () => {
  class FakeTransfer { constructor() { const files = []; this.files = files; this.items = { add: file => files.push(file) }; } }
  const slot = { value: 'stale', files: null }, seen = [];
  const harness = importHarness(allIds, ['notes', 'config'], { notes: async () => seen.push({ files: [...slot.files], value: slot.value }), config: async () => { seen.push({ files: [...slot.files] }); throw new Error('格式不对'); } });
  await harness.run([sample('config'), sample('notes')], { slot, DataTransferClass: FakeTransfer });
  assert.deepEqual(seen.map(item => item.files.map(file => file.name)), [['notes.json'], ['config.json']]);
  for (const call of harness.calls) { assert.equal(call.input, slot); assert.equal(call.event.target, slot); assert.equal(call.event.currentTarget, slot); }
  assert.equal(slot.value, '');
  assert.deepEqual(harness.notices, [['配置导入未完成：格式不对', 'warning']]);
});

test('an importer that fails does not stop the ones after it', async () => {
  const harness = importHarness(allIds, ['notes', 'reader', 'config'], { notes: async () => { throw new Error('坏了'); } });
  await harness.run([sample('config'), sample('reader'), sample('notes')]);
  assert.deepEqual(harness.calls.map(call => call.key), ['notes', 'reader', 'config']);
  assert.deepEqual(harness.notices, [['便笺导入未完成：坏了', 'warning']]);
});
