import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontLibrary } from '../qianmu-font-library.js';
import { normalizeFontLibrary } from '../qianmu-font-library-state.js';
import { createLocalFontRecord, exportFontPack, importFontPack } from '../qianmu-font-sources.js';
const webFont = { name: 'Web', source: { kind: 'web', input: 'https://font.example/font.woff2', url: 'https://font.example/font.woff2' }, faces: [{ urls: [{ url: 'https://font.example/font.woff2', format: 'woff2' }], weight: '400', style: 'normal' }] };
function setup(overrides = {}) {
  let owner = {}, active = true, namespace = 'one'; const saves = [], applies = [], binaries = new Map(), downloads = [];
  const library = createFontLibrary({ getOwner: () => owner, isCurrent: () => active, resolveNamespace: async () => namespace,
    save: current => saves.push(structuredClone(current)), document: { baseURI: 'https://st.example/' }, confirm: async () => true,
    download: (...args) => downloads.push(args), webResolver: async () => [webFont],
    localStoreFactory: ({ namespace }) => ({ get: async id => binaries.get(namespace + id) || null, put: async (id, bytes) => binaries.set(namespace + id, new Blob([bytes])), delete: async ids => ids.forEach(id => binaries.delete(namespace + id)), dispose() {} }),
    runtimeFactory: () => ({ sync: async (state, ids) => applies.push({ state: structuredClone(state), ids }), family: id => id, dispose() {} }), ...overrides });
  return { library, saves, applies, binaries, downloads, get owner() { return owner; }, replace() { owner = {}; namespace = 'two'; }, stop() { active = false; library.dispose(); } };
}
function fontFile() {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1); view.setUint32(20, 28); view.setUint32(24, 4);
  return { bytes, file: { size: bytes.length, name: '本地.ttf', arrayBuffer: async () => bytes.buffer.slice(0) } };
}
const digestId = async bytes => 'local_' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const packFile = value => ({ size: new TextEncoder().encode(value).byteLength, text: async () => value });
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
async function waitUntil(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Expected asynchronous test checkpoint was not reached');
}
test('Web entries use ordinary settings with references only; adding never applies a font', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  assert.equal(f.owner.fontLibrary.fonts.length, 1); assert.equal(f.binaries.size, 0);
  assert.equal(f.owner.fontLibrary.body.enabled, false); assert.equal(f.owner.fontLibrary.st.enabled, false);
  assert.equal(f.saves.length, 1); assert.equal(f.applies.length, 1);
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('set-assignment', { target: 'body', fontId: id, weight: '400' });
  assert.equal(f.applies.at(-1).state.body.fontId, id); assert.equal(f.applies.at(-1).state.st.enabled, false);
  f.stop();
});
test('late Web resolution after an account/settings change never writes to new owner', async () => {
  let finish; const f = setup({ webResolver: () => new Promise(resolve => { finish = resolve; }) });
  const work = f.library.action('add-web', { source: 'https://font.example/test.css' });
  await waitUntil(() => finish); f.replace(); finish([webFont]);
  await assert.rejects(work, /设置已变化/); assert.deepEqual(f.owner, {}); assert.equal(f.saves.length, 0); f.stop();
});
test('preview text is library-only and shared settings do not rewrite independent choices', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('set-assignment', { target: 'body', fontId: id });
  const body = structuredClone(f.owner.fontLibrary.body);
  await f.library.action('set-mode', { mode: 'shared' });
  await f.library.action('set-assignment', { target: 'shared', fontId: id });
  await f.library.action('set-preview', { text: '只变列表里的文案' });
  assert.deepEqual(f.owner.fontLibrary.body, body);
  await f.library.action('set-mode', { mode: 'separate' }); assert.deepEqual(f.owner.fontLibrary.body, body); f.stop();
});
test('complete export retains Web references and never downloads remote font binaries', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  await f.library.action('export', { ids: null });
  assert.equal(f.downloads.length, 1); assert.equal(f.binaries.size, 0);
  const text = await f.downloads[0][0].text(); assert.ok(text.includes(webFont.source.url)); f.stop();
});
test('delete removes only selected entries and resets their assignments', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('set-assignment', { target: 'body', fontId: id });
  await f.library.action('delete-fonts', { ids: [id] });
  assert.equal(f.owner.fontLibrary.fonts.length, 0); assert.equal(f.owner.fontLibrary.body.enabled, false); f.stop();
});

test('local upload follows the merged id when an imported Web id collides with its digest', async () => {
  const f = setup(), { bytes, file } = fontFile(), digest = await digestId(bytes);
  f.owner.fontLibrary = { ...normalizeFontLibrary(), fonts: [{ ...webFont, id: digest }] };
  await f.library.action('add-local', { files: [file] });
  const local = f.owner.fontLibrary.fonts.find(font => font.source.kind === 'local');
  assert.notEqual(local.id, digest);
  assert.deepEqual(new Uint8Array(await f.binaries.get('one' + local.id).arrayBuffer()), bytes);
  assert.equal(f.binaries.has('one' + digest), false);
  await f.library.action('export', { ids: [local.id] });
  assert.deepEqual(importFontPack(await f.downloads[0][0].text()).localFiles[local.id], bytes);
  f.stop();
});

test('a failed original-file write never commits dangling font metadata', async () => {
  const f = setup({ localStoreFactory: () => ({ put: async () => { throw new Error('模拟存储不足'); }, dispose() {} }) });
  const original = normalizeFontLibrary(); f.owner.fontLibrary = original;
  await assert.rejects(f.library.action('add-local', { files: [fontFile().file] }), /存储不足/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, 0); assert.equal(f.applies.length, 0);
  f.stop();
});

test('a synchronous settings-save failure rolls back its own staging and keeps local originals', async () => {
  const f = setup({ save: () => { throw new Error('模拟设置保存失败'); } }), original = normalizeFontLibrary();
  f.owner.fontLibrary = original;
  await assert.rejects(f.library.action('add-local', { files: [fontFile().file] }), /保存失败/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.applies.length, 0);
  assert.equal(f.binaries.size, 1); // Recoverable uploaded original is not destroyed on uncertain save failure.
  f.stop();
});

test('save failure cannot overwrite a newer settings value installed during the save callback', async () => {
  const newer = { ...normalizeFontLibrary(), previewText: '更新的编辑' };
  const f = setup({ save: target => { target.fontLibrary = newer; throw new Error('模拟并发保存失败'); } });
  f.owner.fontLibrary = normalizeFontLibrary();
  await assert.rejects(f.library.action('add-web', { source: webFont.source.input }), /并发保存失败/);
  assert.equal(f.owner.fontLibrary, newer); assert.equal(f.applies.length, 0); f.stop();
});

test('import remaps local files by content while preserving active choices and existing sample', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  const webId = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('set-assignment', { target: 'body', fontId: webId, weight: '700' });
  await f.library.action('set-assignment', { target: 'st', fontId: webId });
  await f.library.action('set-preview', { text: '当前预览文案' });
  const choices = structuredClone({ body: f.owner.fontLibrary.body, st: f.owner.fontLibrary.st, shared: f.owner.fontLibrary.shared });
  const { bytes, file } = fontFile(), local = await createLocalFontRecord(file);
  local.record.id = 'foreign_device_id'; local.record.folder = '导入'; local.record.tags = ['完整原件'];
  const text = exportFontPack([local.record], { localFiles: { foreign_device_id: bytes }, folders: ['导入'], previewText: '来自其他设备的文案' });
  await f.library.action('import', { file: packFile(text) });
  const imported = f.owner.fontLibrary.fonts.find(font => font.source.kind === 'local'), expected = await digestId(bytes);
  assert.equal(imported.id, expected); assert.equal(imported.folder, '导入'); assert.deepEqual(imported.tags, ['完整原件']);
  assert.deepEqual(new Uint8Array(await f.binaries.get('one' + expected).arrayBuffer()), bytes);
  assert.equal(f.binaries.has('oneforeign_device_id'), false);
  assert.equal(f.owner.fontLibrary.previewText, '当前预览文案');
  for (const target of ['body', 'st', 'shared']) assert.deepEqual(f.owner.fontLibrary[target], choices[target]);
  await f.library.action('export'); const exported = importFontPack(await f.downloads[0][0].text());
  assert.equal(exported.records.length, 2); assert.deepEqual(exported.localFiles[expected], bytes);
  f.stop();
});

test('import also respects merge-id remapping after a deterministic local id collision', async () => {
  const f = setup(), { bytes, file } = fontFile(), local = await createLocalFontRecord(file), digest = await digestId(bytes);
  f.owner.fontLibrary = { ...normalizeFontLibrary(), fonts: [{ ...webFont, id: digest }] };
  local.record.id = 'external';
  await f.library.action('import', { file: packFile(exportFontPack([local.record], { localFiles: { external: bytes } })) });
  const imported = f.owner.fontLibrary.fonts.find(font => font.source.kind === 'local');
  assert.notEqual(imported.id, digest); assert.equal(f.binaries.has('one' + imported.id), true);
  assert.equal(f.binaries.has('one' + digest), false); f.stop();
});

test('missing original prevents an incomplete export and does not mutate the library', async () => {
  const f = setup(), local = await createLocalFontRecord(fontFile().file); local.record.id = 'missing';
  const original = { ...normalizeFontLibrary(), fonts: [local.record] }; f.owner.fontLibrary = original;
  await assert.rejects(f.library.action('export'), /缺少.*原件/);
  assert.equal(f.downloads.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.owner.fontLibrary, original); f.stop();
});

test('account change during original storage leaves bytes with the old owner and never commits to the new one', async () => {
  let finish; const writes = [];
  const f = setup({ localStoreFactory: ({ namespace }) => ({ put: (id, bytes) => new Promise(resolve => { writes.push({ namespace, id, bytes }); finish = resolve; }), dispose() {} }) });
  const oldOwner = f.owner, work = f.library.action('add-local', { files: [fontFile().file] });
  await waitUntil(() => finish);
  f.replace(); finish();
  await assert.rejects(work, /设置已变化/);
  assert.equal(writes[0].namespace, 'one'); assert.deepEqual(f.owner, {}); assert.deepEqual(oldOwner, {}); assert.equal(f.saves.length, 0); f.stop();
});

test('dispose blocks an outstanding identity lookup even while the host still reports active', async () => {
  let finish, created = 0;
  const f = setup({ resolveNamespace: () => new Promise(resolve => { finish = resolve; }),
    runtimeFactory: () => { created++; return { sync: async () => {}, dispose() {} }; } });
  const work = f.library.action('add-web', { source: webFont.source.input });
  await waitUntil(() => finish); f.library.dispose(); finish('one');
  await assert.rejects(work, /来源已变化/);
  assert.equal(created, 0); assert.equal(f.saves.length, 0); assert.deepEqual(f.owner, {});
  await assert.rejects(f.library.action('add-folder', { name: '禁用期间' }), /已关闭/); f.stop();
});

test('dispose cannot schedule a close-triggered sync that resurrects the runtime', async () => {
  let created = 0, destroyed = 0, applied = 0;
  const f = setup({ runtimeFactory: () => { created++; return { sync: async () => { applied++; }, dispose() { destroyed++; } }; } });
  await f.library.action('add-web', { source: webFont.source.input });
  assert.equal(created, 1); assert.equal(applied, 1);
  f.library.dispose(); await settle();
  assert.equal(created, 1); assert.equal(destroyed, 1); assert.equal(applied, 1);
  await f.library.sync(); assert.equal(created, 1); f.stop();
});

test('explicit activate restores operation but cannot revive an old ensure or unlock an in-flight newer action', async () => {
  const resolves = [];
  const f = setup({ resolveNamespace: () => new Promise(resolve => resolves.push(resolve)) });
  const oldWork = f.library.action('add-web', { source: webFont.source.input });
  await waitUntil(() => resolves.length >= 1);
  f.library.dispose(); f.library.activate();
  const nextWork = f.library.action('add-web', { source: webFont.source.input });
  await waitUntil(() => resolves.length >= 2);
  resolves[0]('one'); await assert.rejects(oldWork, /来源已变化/);
  await assert.rejects(f.library.action('add-folder', { name: '应仍忙碌' }), /尚未完成/);
  resolves[1]('one');
  await waitUntil(() => resolves.length >= 3); // Post-commit sync performs its own identity check.
  resolves[2]('one'); await nextWork;
  assert.equal(f.saves.length, 1); assert.equal(f.owner.fontLibrary.fonts.length, 1); f.stop();
});
