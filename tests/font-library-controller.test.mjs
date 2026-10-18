import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontLibrary } from '../qianmu-font-library.js';
import { normalizeFontLibrary } from '../qianmu-font-library-state.js';
import { createLocalFontRecord, exportFontPack, importFontPack, resolveWebFontSource } from '../qianmu-font-sources.js';
const webFont = { name: 'Web', source: { kind: 'web', input: 'https://font.example/font.woff2', url: 'https://font.example/font.woff2' }, faces: [{ urls: [{ url: 'https://font.example/font.woff2', format: 'woff2' }], weight: '400', style: 'normal' }] };
function setup(overrides = {}) {
  let owner = {}, active = true, namespace = 'one'; const saves = [], applies = [], binaries = new Map(), downloads = [];
  const library = createFontLibrary({ getOwner: () => owner, isCurrent: () => active, resolveNamespace: async () => namespace,
    save: current => saves.push(structuredClone(current)), document: { baseURI: 'https://st.example/' }, confirm: async () => true,
    download: (...args) => downloads.push(args), webResolver: async () => [webFont],
    localStoreFactory: ({ namespace }) => ({ get: async id => binaries.get(namespace + id) || null, put: async (id, bytes) => binaries.set(namespace + id, new Blob([bytes])), delete: async ids => ids.forEach(id => binaries.delete(namespace + id)), dispose() {} }),
    runtimeFactory: () => ({ sync: async (state, ids) => applies.push({ state: structuredClone(state), ids }), verifyWebFont: async () => {}, family: id => id, dispose() {} }), ...overrides });
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
async function editableSetup(overrides = {}) {
  const views = [], entry = { addEventListener(_type, handler) { this.click = handler; }, removeEventListener() {}, focus() {} };
  const root = { isConnected: true, classList: { add() {}, remove() {} }, querySelector: selector => selector === '[data-font-library]' ? entry : selector === '.sd-floor-shell' ? { appendChild() {} } : null };
  const f = setup({ document: { baseURI: 'https://st.example/', createElement: () => ({ remove() {}, setAttribute() {} }) },
    viewFactory: options => { const view = { options, render() {}, setStatus() {}, destroy() {} }; views.push(view); return view; }, ...overrides });
  f.library.attach(root); entry.click(); await waitUntil(() => views.length === 1);
  return { ...f, get owner() { return f.owner; }, entries: () => views.at(-1).options.getState().entries };
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

test('Web add accepts normalized tags while duplicate additions preserve original name and classification', async () => {
  const f = setup({ webResolver: resolveWebFontSource });
  await f.library.action('add-web', { source: webFont.source.input, name: ' 原名称 ', tags: [' 衬线 ', '正文', '衬线', ''] });
  const id = f.owner.fontLibrary.fonts[0].id;
  assert.equal(f.owner.fontLibrary.fonts[0].name, '原名称'); assert.deepEqual(f.owner.fontLibrary.fonts[0].tags, ['衬线', '正文']);
  await f.library.action('update-fonts', { ids: [id], folder: '阅读' });
  const original = structuredClone(f.owner.fontLibrary);
  const result = await f.library.action('add-web', { source: webFont.source.input, name: '不应覆盖', tags: [] });
  assert.equal(result.revealFontId, undefined); assert.deepEqual(f.owner.fontLibrary, original); assert.equal(f.binaries.size, 0);
  await f.library.action('add-web', { source: 'https://font.example/another.woff2', tags: ['新条目'] });
  assert.deepEqual(f.owner.fontLibrary.fonts[0], original.fonts[0]); assert.deepEqual(f.owner.fontLibrary.fonts[1].tags, ['新条目']);
  f.stop();
});

test('Web tag edits retain omitted tags, clear explicit arrays and preserve old tags on source or binary failure', async () => {
  let resolveFailure = false, binaryFailure = false, resolutions = 0, verifications = 0;
  const f = setup({ webResolver: async (...args) => { resolutions++; if (resolveFailure) throw Error('来源解析失败'); return resolveWebFontSource(...args); },
    runtimeFactory: () => ({ sync: async () => {}, dispose() {}, verifyWebFont: async () => { verifications++; if (binaryFailure) throw Error('字形加载失败'); } }) });
  await f.library.action('add-web', { source: webFont.source.input, tags: ['原标签'] });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('edit-web', { id, source: webFont.source.input, name: '新名称' });
  assert.deepEqual(f.owner.fontLibrary.fonts[0].tags, ['原标签']);
  await f.library.action('edit-web', { id, source: webFont.source.input, tags: [] });
  assert.deepEqual(f.owner.fontLibrary.fonts[0].tags, []);
  await f.library.action('edit-web', { id, source: webFont.source.input, tags: [' 保留 ', '保留'] });
  assert.deepEqual(f.owner.fontLibrary.fonts[0].tags, ['保留']); assert.equal(resolutions, 1); assert.equal(verifications, 0);
  const original = f.owner.fontLibrary, saves = f.saves.length;
  resolveFailure = true;
  await assert.rejects(f.library.action('edit-web', { id, source: 'https://font.example/fail.woff2', tags: [] }), /来源解析失败/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves);
  resolveFailure = false; binaryFailure = true;
  await assert.rejects(f.library.action('edit-web', { id, source: 'https://font.example/fail.woff2', tags: ['不应覆盖'] }), /字形加载失败/);
  assert.equal(f.owner.fontLibrary, original); assert.deepEqual(original.fonts[0].tags, ['保留']); assert.equal(f.saves.length, saves);
  f.stop();
});

test('invalid Web names and tags are rejected before resolving a source or changing an existing record', async () => {
  let resolutions = 0;
  const f = setup({ webResolver: async (...args) => { resolutions++; return resolveWebFontSource(...args); } });
  for (const invalid of [{ name: {} }, { name: null }, { name: 1 }, { name: '名'.repeat(161) }, { name: '坏\u0000名' }, { tags: null }, { tags: ['字'.repeat(81)] }, { tags: [1] }]) {
    await assert.rejects(f.library.action('add-web', { source: webFont.source.input, ...invalid }), /名称|标签/);
    assert.deepEqual(f.owner, {}); assert.equal(f.saves.length, 0); assert.equal(resolutions, 0);
  }
  await f.library.action('add-web', { source: webFont.source.input, name: '名'.repeat(160), tags: ['保留'] });
  const original = f.owner.fontLibrary, id = original.fonts[0].id, saves = f.saves.length;
  await assert.rejects(f.library.action('edit-web', { id, source: webFont.source.input, name: {}, tags: [] }), /名称/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves); assert.equal(resolutions, 1);
  f.stop();
});

test('local multi-file metadata follows file order and retains original filenames and bytes', async () => {
  const f = setup(), first = fontFile(), second = fontFile();
  second.bytes[31] = 7; second.file.name = '第二份.ttf';
  const result = await f.library.action('add-local', { files: [first.file, second.file], metadata: [{ name: ' 自选正文 ', tags: [' 衬线 ', '衬线'] }, { name: '名'.repeat(160), tags: ['界面'] }] });
  const [a, b] = f.owner.fontLibrary.fonts;
  assert.equal(result.revealFontId, a.id); assert.equal(a.name, '自选正文'); assert.deepEqual(a.tags, ['衬线']);
  assert.equal(b.name, '名'.repeat(160)); assert.deepEqual(b.tags, ['界面']);
  assert.equal(a.source.fileName, '本地.ttf'); assert.equal(b.source.fileName, '第二份.ttf');
  assert.equal(a.id, await digestId(first.bytes)); assert.equal(b.id, await digestId(second.bytes));
  assert.deepEqual(new Uint8Array(await f.binaries.get('one' + a.id).arrayBuffer()), first.bytes);
  assert.deepEqual(new Uint8Array(await f.binaries.get('one' + b.id).arrayBuffer()), second.bytes);
  assert.equal(f.owner.fontLibrary.body.enabled, false); assert.equal(f.owner.fontLibrary.st.enabled, false); assert.equal(f.saves.length, 1);
  f.stop();
});

test('invalid metadata anywhere in a local batch prevents every original-file write and settings save', async () => {
  let reads = 0, puts = 0;
  const f = setup({ localReader: async file => { reads++; return createLocalFontRecord(file); },
    localStoreFactory: () => ({ put: async () => { puts++; }, dispose() {} }) });
  const files = [fontFile().file, fontFile().file], original = normalizeFontLibrary(); f.owner.fontLibrary = original;
  const badItems = [{ tags: null }, { tags: [1] }, { tags: ['字'.repeat(81)] }, { tags: Array(33).fill('标签') }, { name: {} }, { name: null }, { name: 1 }, { name: '名'.repeat(161) }, { name: '坏\u0000名' }, [], null, Object.create({ name: '继承值' })];
  for (const item of badItems) {
    await assert.rejects(f.library.action('add-local', { files, metadata: [{ name: '有效', tags: ['有效'] }, item] }), /名称|标签/);
    assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, 0); assert.equal(puts, 0); assert.equal(reads, 0);
  }
  for (const metadata of [[], [{}], [{}, {}, {}], {}, null, new Array(2)]) {
    await assert.rejects(f.library.action('add-local', { files, metadata }), /名称|标签/);
    assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, 0); assert.equal(puts, 0);
  }
  f.stop();
});

test('duplicate local uploads retain saved metadata, application and byte contents while missing originals can be restored', async () => {
  const f = setup(), { file, bytes } = fontFile();
  await f.library.action('add-local', { files: [file], metadata: [{ name: '原名称', tags: ['原标签'] }] });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('update-fonts', { ids: [id], folder: '原目录' });
  await f.library.action('apply-font', { target: 'body', fontId: id });
  const original = structuredClone(f.owner.fontLibrary);
  const result = await f.library.action('add-local', { files: [file], metadata: [{ name: '不应覆盖', tags: [] }] });
  assert.equal(result.revealFontId, undefined); assert.deepEqual(f.owner.fontLibrary, original); assert.equal(f.binaries.size, 1);
  assert.deepEqual(new Uint8Array(await f.binaries.get('one' + id).arrayBuffer()), bytes);
  f.binaries.delete('one' + id);
  await f.library.action('add-local', { files: [file], metadata: [{ name: '补回原件', tags: ['不应覆盖'] }] });
  assert.deepEqual(f.owner.fontLibrary, original); assert.deepEqual(new Uint8Array(await f.binaries.get('one' + id).arrayBuffer()), bytes);
  f.stop();
});

test('legacy local payloads and blank optional metadata preserve the derived display name', async () => {
  for (const metadata of [undefined, [{}], [{ name: '  ', tags: [] }]]) {
    const f = setup();
    await f.library.action('add-local', { files: [fontFile().file], ...(metadata === undefined ? {} : { metadata }) });
    assert.equal(f.owner.fontLibrary.fonts[0].name, '本地'); assert.deepEqual(f.owner.fontLibrary.fonts[0].tags, []);
    assert.equal(f.binaries.size, 1); assert.equal(f.saves.length, 1); f.stop();
  }
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

test('pin and sort actions persist only management preferences without changing originals or application choices', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  await f.library.action('add-local', { files: [fontFile().file] });
  const [web, local] = f.owner.fontLibrary.fonts, bytes = f.binaries.get('one' + local.id);
  await f.library.action('apply-font', { target: 'shared', fontId: local.id });
  await f.library.action('set-enabled', { enabled: false });
  const original = structuredClone(f.owner.fontLibrary);
  await f.library.action('set-font-pinned', { id: local.id, pinned: true });
  await f.library.action('set-font-pinned', { id: web.id, pinned: true });
  await f.library.action('set-font-pinned', { id: local.id, pinned: true });
  await f.library.action('set-sort-order', { order: 'desc' });
  assert.deepEqual(f.owner.fontLibrary, { ...original, pinnedIds: [local.id, web.id], sortOrder: 'desc' });
  assert.deepEqual(f.saves.at(-1).fontLibrary, f.owner.fontLibrary); assert.equal(f.binaries.get('one' + local.id), bytes);
  await f.library.action('set-font-pinned', { id: local.id, pinned: false });
  await f.library.action('set-font-pinned', { id: local.id, pinned: true });
  assert.deepEqual(f.owner.fontLibrary.pinnedIds, [web.id, local.id]);
  await f.library.action('edit-web', { id: web.id, source: web.source.input, name: 'ZZZ 新名称' });
  assert.deepEqual(f.owner.fontLibrary.pinnedIds, [web.id, local.id]); assert.equal(f.owner.fontLibrary.sortOrder, 'desc');
  assert.deepEqual(f.owner.fontLibrary.fonts.map(item => item.id), [web.id, local.id]);
  await f.library.action('delete-font', { id: web.id });
  assert.deepEqual(f.owner.fontLibrary.pinnedIds, [local.id]); assert.equal(f.owner.fontLibrary.sortOrder, 'desc');
  assert.deepEqual(f.owner.fontLibrary.shared, original.shared); assert.equal(f.owner.fontLibrary.enabled, false);
  assert.equal(f.binaries.get('one' + local.id), bytes); f.stop();
});

test('invalid and stale pin or sorting actions cannot save over existing records and local originals', async () => {
  const f = setup(); await f.library.action('add-local', { files: [fontFile().file] });
  const original = f.owner.fontLibrary, id = original.fonts[0].id, bytes = f.binaries.get('one' + id), saves = f.saves.length;
  for (const pinned of [undefined, null, 'true', 1]) await assert.rejects(f.library.action('set-font-pinned', { id, pinned }), /置顶设置无效/);
  for (const pinned of [false, true]) await assert.rejects(f.library.action('set-font-pinned', { id: 'stale', pinned }), /已不在库中/);
  for (const order of [null, '', 'random', 1]) await assert.rejects(f.library.action('set-sort-order', { order }), /排序设置无效/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves); assert.equal(f.binaries.get('one' + id), bytes);
  f.owner.fontLibrary = { ...original, pinnedIds: [id, id] }; const malformed = f.owner.fontLibrary;
  await assert.rejects(f.library.action('set-sort-order', { order: 'desc' }), /重复条目/);
  assert.equal(f.owner.fontLibrary, malformed); assert.equal(f.saves.length, saves); assert.equal(f.binaries.get('one' + id), bytes);
  f.stop();
});

test('account changes while preparing a management action cannot write either account preferences', async () => {
  let finish;
  const f = setup({ resolveNamespace: () => new Promise(resolve => { finish = resolve; }) });
  f.owner.fontLibrary = normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [{ ...webFont, id: 'saved' }] });
  const oldOwner = f.owner, original = structuredClone(oldOwner.fontLibrary);
  const work = f.library.action('set-font-pinned', { id: 'saved', pinned: true });
  await waitUntil(() => finish); f.replace(); finish('one');
  await assert.rejects(work, /来源已变化/);
  assert.deepEqual(oldOwner.fontLibrary, original); assert.deepEqual(f.owner, {}); assert.equal(f.saves.length, 0); f.stop();
});

test('one selected mixed-font pack restores every selected original and metadata without replacing recipient choices', async () => {
  const source = setup({ webResolver: resolveWebFontSource }), originals = [fontFile(), fontFile(), fontFile()];
  originals.forEach((item, index) => { item.bytes[31] = index + 1; item.file.name = `本地${index + 1}.ttf`; });
  for (const [index, url] of ['first', 'second', 'not-selected'].entries()) {
    await source.library.action('add-web', { source: `https://font.example/${url}.woff2`, name: `网络${index + 1}`, tags: ['Web', `第${index + 1}款`] });
  }
  await source.library.action('add-local', { files: originals.map(item => item.file), metadata: originals.map((_item, index) => ({ name: `自定本地${index + 1}`, tags: ['本地', `第${index + 1}款`] })) });
  const all = source.owner.fontLibrary.fonts, selected = [all[0], all[1], all[3], all[4]], excluded = [all[2], all[5]];
  await source.library.action('update-fonts', { ids: [selected[0].id, selected[2].id], folder: '旧版阅读目录' });
  await source.library.action('add-folder', { name: '旧版空目录' });
  await source.library.action('set-preview', { text: '发送方预览，不替换接收方已有文案' });
  await source.library.action('set-font-pinned', { id: selected[2].id, pinned: true });
  await source.library.action('set-sort-order', { order: 'desc' });
  const senderBefore = structuredClone(source.owner.fontLibrary), senderSaves = source.saves.length;
  await source.library.action('export', { ids: selected.map(font => font.id).reverse() });
  assert.equal(source.downloads.length, 1, 'all selected fonts share one download');
  const [blob, filename] = source.downloads[0];
  assert.equal(blob.type, 'application/json'); assert.match(filename, /^qianmu-fonts-\d+\.json$/);
  const packedText = await blob.text(), packed = importFontPack(packedText), rawPack = JSON.parse(packedText);
  const expected = senderBefore.fonts.filter(font => selected.some(item => item.id === font.id));
  assert.deepEqual(packed.records, expected); assert.equal(packed.records.length, 4);
  assert.deepEqual(Object.keys(packed.localFiles).sort(), selected.filter(font => font.source.kind === 'local').map(font => font.id).sort());
  assert.deepEqual(packed.localFiles[selected[2].id], originals[0].bytes);
  assert.deepEqual(packed.localFiles[selected[3].id], originals[1].bytes);
  assert.deepEqual(packed.folders, senderBefore.folders, 'legacy folder metadata remains portable even without folder controls');
  for (const font of excluded) { assert.ok(!packed.records.some(record => record.id === font.id)); assert.ok(!Object.hasOwn(packed.localFiles, font.id)); }
  for (const key of ['body', 'st', 'shared', 'mode', 'enabled', 'pinnedIds', 'sortOrder']) assert.equal(Object.hasOwn(rawPack, key), false);
  assert.deepEqual(source.owner.fontLibrary, senderBefore); assert.equal(source.saves.length, senderSaves);

  for (const mode of ['separate', 'shared']) for (const enabled of [true, false]) {
    const receiver = setup({ webResolver: resolveWebFontSource });
    await receiver.library.action('add-web', { source: 'https://font.example/recipient-body.woff2', name: '接收方正文', tags: ['原有'] });
    await receiver.library.action('add-web', { source: 'https://font.example/recipient-ui.woff2', name: '接收方界面' });
    const [body, st] = receiver.owner.fontLibrary.fonts;
    await receiver.library.action('set-assignment', { target: 'body', fontId: body.id, weight: '700', style: 'italic' });
    await receiver.library.action('set-assignment', { target: 'st', fontId: st.id, weight: '500' });
    await receiver.library.action('set-assignment', { target: 'shared', fontId: body.id, weight: '600' });
    await receiver.library.action('set-mode', { mode });
    await receiver.library.action('set-enabled', { enabled });
    await receiver.library.action('set-preview', { text: '接收方自己的样字' });
    await receiver.library.action('add-folder', { name: '接收方旧目录' });
    await receiver.library.action('set-font-pinned', { id: st.id, pinned: true });
    await receiver.library.action('set-font-pinned', { id: body.id, pinned: true });
    await receiver.library.action('set-sort-order', { order: mode === 'shared' ? 'desc' : 'asc' });
    const before = structuredClone(receiver.owner.fontLibrary), saves = receiver.saves.length;
    await receiver.library.action('import', { file: packFile(packedText) });
    const after = receiver.owner.fontLibrary;
    for (const key of ['body', 'st', 'shared', 'mode', 'enabled', 'previewText', 'pinnedIds', 'sortOrder']) assert.deepEqual(after[key], before[key], `${mode}/${enabled}: ${key}`);
    assert.deepEqual(after.fonts.slice(0, before.fonts.length), before.fonts);
    assert.deepEqual(after.fonts.slice(before.fonts.length), expected);
    assert.deepEqual(after.folders, [...before.folders, ...packed.folders]);
    assert.equal(receiver.binaries.size, 2); assert.equal(receiver.saves.length, saves + 1);
    for (const font of expected.filter(item => item.source.kind === 'local')) {
      assert.deepEqual(new Uint8Array(await receiver.binaries.get('one' + font.id).arrayBuffer()), packed.localFiles[font.id]);
    }
    for (const font of excluded) assert.ok(!after.fonts.some(item => item.id === font.id));
    assert.equal(receiver.applies.at(-1).state.enabled, enabled); assert.equal(receiver.applies.at(-1).state.mode, mode);
    receiver.stop();
  }
  source.stop();
});

test('a missing second selected original blocks the entire pack, while unselected missing originals do not block export', async () => {
  const f = setup({ webResolver: resolveWebFontSource }), first = fontFile(), second = fontFile(); second.bytes[31] = 9;
  await f.library.action('add-local', { files: [first.file, second.file], metadata: [{ name: '完整原件', tags: ['保留'] }, { name: '缺失原件', tags: ['保留'] }] });
  await f.library.action('add-web', { source: webFont.source.input, tags: ['网络'] });
  const [complete, missing, web] = f.owner.fontLibrary.fonts, before = structuredClone(f.owner.fontLibrary), saves = f.saves.length;
  f.binaries.delete('one' + missing.id);
  await assert.rejects(f.library.action('export', { ids: [complete.id, web.id, missing.id] }), /缺少.*缺失原件.*原件/);
  assert.equal(f.downloads.length, 0); assert.equal(f.saves.length, saves); assert.deepEqual(f.owner.fontLibrary, before);
  await f.library.action('export', { ids: [web.id, complete.id] });
  assert.equal(f.downloads.length, 1);
  const packed = importFontPack(await f.downloads[0][0].text());
  assert.deepEqual(packed.records.map(font => font.id), [complete.id, web.id]);
  assert.deepEqual(Object.keys(packed.localFiles), [complete.id]); assert.deepEqual(packed.localFiles[complete.id], first.bytes);
  assert.equal(f.binaries.size, 1); assert.deepEqual(f.owner.fontLibrary, before); assert.equal(f.saves.length, saves); f.stop();
});

test('master off survives import, selection changes and reopen without deleting local originals', async () => {
  const f = setup(); await f.library.action('add-local', { files: [fontFile().file] });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('apply-font', { target: 'shared', fontId: id });
  const original = structuredClone(f.owner.fontLibrary), originalBytes = f.binaries.get('one' + id);
  await f.library.action('set-enabled', { enabled: false });
  assert.deepEqual(f.owner.fontLibrary, { ...original, enabled: false });
  const packed = exportFontPack([{ ...webFont, id: 'imported' }]);
  await f.library.action('import', { file: packFile(packed) });
  await f.library.action('apply-font', { target: 'body', fontId: 'imported' });
  await f.library.sync();
  assert.equal(f.applies.at(-1).state.enabled, false);
  assert.equal(f.binaries.get('one' + id), originalBytes);
  await f.library.action('set-enabled', { enabled: true });
  assert.equal(f.applies.at(-1).state.enabled, true);
  assert.equal(f.owner.fontLibrary.body.fontId, 'imported');
  assert.deepEqual(f.owner.fontLibrary.shared, original.shared);
  f.stop();
});
test('delete removes only selected entries and resets their assignments', async () => {
  const f = setup(); await f.library.action('add-web', { source: webFont.source.input });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('set-assignment', { target: 'body', fontId: id });
  await f.library.action('delete-fonts', { ids: [id] });
  assert.equal(f.owner.fontLibrary.fonts.length, 0); assert.equal(f.owner.fontLibrary.body.enabled, false); f.stop();
});

test('single delete skips confirmation and removes only its exact entry and local original', async () => {
  let confirmations = 0;
  const f = setup({ confirm: async () => { confirmations++; return false; } });
  await f.library.action('add-web', { source: webFont.source.input });
  const first = fontFile(), second = fontFile(); second.bytes[28] = 1;
  await f.library.action('add-local', { files: [first.file, second.file] });
  const [web, remove, keep] = structuredClone(f.owner.fontLibrary.fonts), keptBytes = f.binaries.get('one' + keep.id);
  await f.library.action('apply-font', { target: 'body', fontId: remove.id });
  await f.library.action('apply-font', { target: 'st', fontId: keep.id });
  await f.library.action('delete-font', { id: remove.id, ids: [web.id, keep.id] });
  assert.equal(confirmations, 0); assert.deepEqual(f.owner.fontLibrary.fonts, [web, keep]);
  assert.equal(f.owner.fontLibrary.body.enabled, false); assert.equal(f.owner.fontLibrary.st.fontId, keep.id);
  assert.equal(f.binaries.has('one' + remove.id), false); assert.equal(f.binaries.get('one' + keep.id), keptBytes);
  const original = f.owner.fontLibrary, saves = f.saves.length;
  for (const id of [undefined, null, '', '../all', {}]) await assert.rejects(f.library.action('delete-font', { id }), /标识无效/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves); assert.equal(f.binaries.get('one' + keep.id), keptBytes);
  f.stop();
});

test('bulk delete keeps confirmation even for a one-row selection and cancellation preserves original files', async () => {
  let allowed = false, confirmations = 0;
  const f = setup({ confirm: async () => { confirmations++; return allowed; } });
  await f.library.action('add-local', { files: [fontFile().file] });
  const original = f.owner.fontLibrary, id = original.fonts[0].id, bytes = f.binaries.get('one' + id), saves = f.saves.length;
  await f.library.action('delete-fonts', { ids: [id] });
  assert.equal(confirmations, 1); assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves);
  assert.equal(f.binaries.get('one' + id), bytes);
  allowed = true; await f.library.action('delete-fonts', { ids: [id] });
  assert.equal(confirmations, 2); assert.equal(f.owner.fontLibrary.fonts.length, 0); assert.equal(f.binaries.has('one' + id), false);
  f.stop();
});

test('import plus body Web editing stays short across repeated edits while preserving every remote face', async () => {
  const source = '@import url("https://fonts.example/578/main/result.css");\nbody {font-family:"AR PL New Sung";font-weight:normal;}';
  const remote = Array.from({ length: 200 }, (_, index) => `@font-face {font-family:"AR PL New Sung";src:url("./${index}.woff2");font-weight:100 900;unicode-range:U+${(0x4e00 + index).toString(16)};}`).join('\n');
  let resolutions = 0, fetches = 0, verifications = 0;
  const f = await editableSetup({ webResolver: (input, options) => { resolutions++; return resolveWebFontSource(input, { ...options, fetchImpl: async url => { fetches++; return { ok: true, url, headers: { get: () => null }, text: async () => remote }; } }); },
    runtimeFactory: () => ({ sync: async () => {}, dispose() {}, verifyWebFont: async () => { verifications++; } }) });
  await f.library.action('add-web', { source });
  const id = f.owner.fontLibrary.fonts[0].id, faces = structuredClone(f.owner.fontLibrary.fonts[0].faces);
  assert.equal(faces.length, 200);
  await f.library.action('apply-font', { target: 'shared', fontId: id, weight: '600' });
  const applied = structuredClone(f.owner.fontLibrary.shared);
  for (let index = 0; index < 3; index++) {
    const entry = f.entries()[0];
    assert.equal(entry.editableSource, source); assert.equal(entry.editableSourceMissing, false);
    await f.library.action('edit-web', { id, source: entry.editableSource, name: `新名称${index}`, tags: ['正文'] });
    assert.deepEqual(f.owner.fontLibrary.fonts[0].faces, faces);
    assert.equal(f.owner.fontLibrary.fonts[0].source.input, source);
  }
  assert.equal(resolutions, 1); assert.equal(fetches, 1); assert.equal(verifications, 0);
  assert.deepEqual(f.owner.fontLibrary.shared, applied);
  await f.library.action('export'); const pack = importFontPack(await f.downloads[0][0].text());
  assert.equal(pack.records[0].source.input, source); assert.deepEqual(pack.records[0].faces, faces);
  f.stop();
});

test('legacy inline source stays blank; empty edits retain validated faces and do not guess or fetch origins', async () => {
  let resolutions = 0, verifications = 0;
  const f = await editableSetup({ webResolver: (...args) => { resolutions++; return resolveWebFontSource(...args); },
    runtimeFactory: () => ({ sync: async () => {}, dispose() {}, verifyWebFont: async () => { verifications++; } }) });
  await f.library.action('add-local', { files: [fontFile().file] });
  const local = structuredClone(f.owner.fontLibrary.fonts[0]), bytes = f.binaries.get('one' + local.id);
  const faces = Array.from({ length: 200 }, (_, index) => ({ urls: [{ url: `https://fonts.example/${index}.woff2`, format: 'woff2' }], weight: '100 900', style: 'normal', unicodeRange: `U+${(0x4e00 + index).toString(16)}` }));
  const legacy = { ...webFont, id: 'legacy', name: '旧字体', folder: '兼容旧目录', tags: ['旧标签'], source: { kind: 'web', input: '内嵌字体样式' }, faces };
  f.owner.fontLibrary = normalizeFontLibrary({ ...f.owner.fontLibrary, fonts: [legacy, local] });
  await f.library.action('apply-font', { target: 'body', fontId: legacy.id, weight: '700' });
  const applied = structuredClone(f.owner.fontLibrary.body);
  for (const source of ['', ' \n ']) {
    const entry = f.entries()[0]; assert.equal(entry.editableSource, ''); assert.equal(entry.editableSourceMissing, true);
    await f.library.action('edit-web', { id: legacy.id, source, name: '只改名字', tags: ['新标签'] });
    assert.deepEqual(f.owner.fontLibrary.fonts[0], { ...legacy, name: '只改名字', tags: ['新标签'] });
  }
  assert.equal(resolutions, 0); assert.equal(verifications, 0); assert.deepEqual(f.owner.fontLibrary.body, applied);
  assert.deepEqual(f.owner.fontLibrary.fonts[1], local); assert.equal(f.binaries.get('one' + local.id), bytes);
  const original = f.owner.fontLibrary, saves = f.saves.length;
  await assert.rejects(f.library.action('add-web', { source: '' }), /填写/);
  await assert.rejects(f.library.action('edit-web', { id: legacy.id, source: '@font-face {font-family:"broken', tags: [] }));
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves); assert.equal(verifications, 0);
  f.stop();
});

test('stylesheet URLs remain the editable source instead of expanded subset declarations', async () => {
  let resolutions = 0;
  const f = await editableSetup({ webResolver: (source, options) => { resolutions++; return resolveWebFontSource(source, { ...options,
    fetchImpl: async () => ({ ok: true, url: 'https://cdn.example/font.css', headers: { get: () => null }, text: async () => '@font-face {font-family:"URL font";src:url("./font.woff2");}' }) }); } });
  const source = 'https://fonts.example/styles.css'; await f.library.action('add-web', { source });
  const entry = f.entries()[0]; assert.equal(entry.editableSource, source); assert.equal(entry.editableSourceMissing, false);
  await f.library.action('edit-web', { id: entry.id, source: entry.editableSource, name: '仅重命名' });
  assert.equal(resolutions, 1); assert.equal(f.owner.fontLibrary.fonts[0].source.url, source); f.stop();
});

test('adding reveals the first new entry, while duplicate addition never misreports a new font', async () => {
  const f = setup(); const first = await f.library.action('add-web', { source: webFont.source.input });
  assert.equal(first.revealFontId, f.owner.fontLibrary.fonts[0].id);
  assert.equal((await f.library.action('add-web', { source: webFont.source.input })).revealFontId, undefined);
  const local = await f.library.action('add-local', { files: [fontFile().file] });
  assert.equal(local.revealFontId, f.owner.fontLibrary.fonts[1].id); f.stop();
});

test('Web editing replaces exactly one source in place and preserves target, classification and master-off', async () => {
  let replacement = webFont, loads = 0;
  const f = setup({ webResolver: async () => { loads++; return [replacement]; } });
  await f.library.action('add-web', { source: webFont.source.input });
  const id = f.owner.fontLibrary.fonts[0].id;
  await f.library.action('update-fonts', { ids: [id], folder: '阅读', tags: ['衬线'] });
  await f.library.action('apply-font', { target: 'body', fontId: id });
  await f.library.action('set-enabled', { enabled: false });
  const before = structuredClone(f.owner.fontLibrary);
  const renamed = await f.library.action('edit-web', { id, name: '新名称', source: webFont.source.input });
  assert.equal(renamed.editedFontId, id); assert.equal(loads, 1, 'name-only edit does not need network');
  assert.equal(f.owner.fontLibrary.fonts[0].name, '新名称');
  replacement = { ...webFont, name: '新来源', source: { kind: 'web', input: 'https://font.example/new.woff2', url: 'https://font.example/new.woff2' }, faces: [{ ...webFont.faces[0], urls: [{ url: 'https://font.example/new.woff2' }] }] };
  await f.library.action('edit-web', { id, name: '新来源', source: replacement.source.input });
  const edited = f.owner.fontLibrary;
  assert.equal(edited.fonts.length, 1); assert.equal(edited.fonts[0].id, id);
  assert.deepEqual(edited.fonts[0].faces, replacement.faces);
  assert.equal(edited.fonts[0].folder, '阅读'); assert.deepEqual(edited.fonts[0].tags, ['衬线']);
  for (const key of ['body', 'st', 'shared', 'enabled', 'mode']) assert.deepEqual(edited[key], before[key]);
  f.stop();
});

test('failed or ambiguous Web edits and changed owners leave original records untouched', async () => {
  let resolver = async () => [webFont];
  const f = setup({ webResolver: (...args) => resolver(...args) });
  await f.library.action('add-web', { source: webFont.source.input });
  const original = f.owner.fontLibrary, id = original.fonts[0].id, saves = f.saves.length;
  resolver = async () => { throw Error('503'); };
  await assert.rejects(f.library.action('edit-web', { id, source: 'https://font.example/bad.css' }), /503/);
  assert.equal(f.owner.fontLibrary, original);
  resolver = async () => [webFont, { ...webFont, name: '另一款' }];
  await assert.rejects(f.library.action('edit-web', { id, source: 'https://font.example/multi.css' }), /多个字体/);
  assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves);
  let finish; resolver = () => new Promise(resolve => { finish = resolve; });
  const pending = f.library.action('edit-web', { id, source: 'https://font.example/new.css' });
  await waitUntil(() => finish); f.replace(); finish([webFont]);
  await assert.rejects(pending, /设置已变化/); assert.deepEqual(f.owner, {});
  assert.equal(original.fonts[0].source.url, webFont.source.url); f.stop();
});

test('local rename changes metadata only; source replacement refuses local originals', async () => {
  const f = setup(); await f.library.action('add-local', { files: [fontFile().file] });
  const font = structuredClone(f.owner.fontLibrary.fonts[0]), bytes = f.binaries.get('one' + font.id);
  await f.library.action('update-fonts', { ids: [font.id], name: '新名字' });
  assert.deepEqual(f.owner.fontLibrary.fonts[0], { ...font, name: '新名字' });
  assert.equal(f.binaries.get('one' + font.id), bytes);
  await assert.rejects(f.library.action('edit-web', { id: font.id, source: webFont.source.input }), /已变化/);
  assert.equal(f.binaries.get('one' + font.id), bytes); f.stop();
});

test('unloadable Web replacement never commits over the saved source or clears the edit', async () => {
  let replacement = webFont, verifies = 0;
  const f = setup({ webResolver: async () => [replacement], runtimeFactory: () => ({ sync: async () => {}, dispose() {}, verifyWebFont: async () => { verifies++; throw Error('字体文件不可加载'); } }) });
  await f.library.action('add-web', { source: webFont.source.input });
  const original = f.owner.fontLibrary, id = original.fonts[0].id, saves = f.saves.length;
  replacement = { ...webFont, faces: [{ ...webFont.faces[0], urls: [{ url: 'https://font.example/missing.woff2' }] }] };
  await assert.rejects(f.library.action('edit-web', { id, source: 'https://font.example/missing.woff2' }), /不可加载/);
  assert.equal(verifies, 1); assert.equal(f.owner.fontLibrary, original); assert.equal(f.saves.length, saves); f.stop();
});

test('account change during binary verification cannot commit the edited source to either owner', async () => {
  let finish;
  const replacement = { ...webFont, faces: [{ ...webFont.faces[0], urls: [{ url: 'https://font.example/new.woff2' }] }] };
  const f = setup({ webResolver: async () => [replacement], runtimeFactory: () => ({ sync: async () => {}, dispose() {}, verifyWebFont: () => new Promise(resolve => { finish = resolve; }) }) });
  const original = normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [{ ...webFont, id: 'original' }] }); f.owner.fontLibrary = original;
  const oldOwner = f.owner, pending = f.library.action('edit-web', { id: 'original', source: 'https://font.example/new.woff2' });
  await waitUntil(() => finish); f.replace(); finish(); await assert.rejects(pending, /设置已变化/);
  assert.equal(oldOwner.fontLibrary, original); assert.deepEqual(f.owner, {}); assert.equal(f.saves.length, 0); f.stop();
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

test('library return restores only its same-account view session and release cannot leak it to another owner', async () => {
  const views = [], classes = new Set(), entry = { addEventListener(_type, handler) { this.click = handler; }, removeEventListener() {}, focus() {} };
  const summary = { textContent: '' }, shell = { appendChild() {} };
  const root = { isConnected: true, classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    querySelector: selector => selector === '[data-font-library]' ? entry : selector === '[data-font-library-summary]' ? summary : selector === '.sd-floor-shell' ? shell : null };
  const snapshot = { query: 'reading', page: 2, scrollTop: 120, variants: { test: { weight: '700' } } };
  let fontSize = 19;
  const f = setup({ getPreviewFontSize: () => fontSize, document: { baseURI: 'https://st.example/', createElement: () => ({ remove() {}, setAttribute() {} }) },
    viewFactory: options => { const view = { options, destroyed: false, captureSession: () => structuredClone(snapshot), destroy() { this.destroyed = true; } }; views.push(view); return view; } });
  f.library.attach(root); assert.match(summary.textContent, /^当前：/);
  entry.click(); await waitUntil(() => views.length === 1);
  assert.equal(views[0].options.getState().defaultPreviewSize, 19);
  f.owner.fontLibrary = normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [{ ...webFont, id: 'inline', name: '含"引号', source: { kind: 'web', input: '内嵌字体样式' } }] });
  const editable = views[0].options.getState().entries[0];
  assert.equal(editable.editableSource, ''); assert.equal(editable.editableSourceMissing, true);
  assert.deepEqual(editable.faces, webFont.faces); assert.equal(editable.name, '含"引号');
  fontSize = 22;
  assert.equal(views[0].options.getState().defaultPreviewSize, 22);
  fontSize = NaN;
  assert.equal(views[0].options.getState().defaultPreviewSize, 18);
  assert.equal(views[0].options.initialSession, null); assert.ok(classes.has('qm-font-library-open'));
  views[0].options.onBack(); assert.equal(views[0].destroyed, true); assert.equal(classes.has('qm-font-library-open'), false);
  entry.click(); await waitUntil(() => views.length === 2);
  assert.deepEqual(views[1].options.initialSession, snapshot);
  f.replace(); await f.library.sync();
  assert.equal(views[1].destroyed, true); assert.equal(classes.has('qm-font-library-open'), false);
  entry.click(); await waitUntil(() => views.length === 3);
  assert.equal(views[2].options.initialSession, null); assert.equal(f.saves.length, 0);
  f.stop();
});

test('a successful closed legacy edit clears only its matching draft including the missing-source hint', async () => {
  const views = [], entry = { addEventListener(_type, handler) { this.click = handler; }, removeEventListener() {}, focus() {} };
  const root = { isConnected: true, classList: { add() {}, remove() {} }, querySelector: selector => selector === '[data-font-library]' ? entry : selector === '.sd-floor-shell' ? { appendChild() {} } : null };
  const snapshot = { query: '保留筛选', scrollTop: 80, webSource: '', webName: '新名字', webTags: '中文', editWebId: 'legacy', editWebSourceMissing: true };
  const f = setup({ document: { baseURI: 'https://st.example/', createElement: () => ({ remove() {}, setAttribute() {} }) },
    viewFactory: options => { const view = { options, captureSession: () => structuredClone(snapshot), destroy() {} }; views.push(view); return view; } });
  f.owner.fontLibrary = normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [{ ...webFont, id: 'legacy', source: { kind: 'web', input: '内嵌字体样式' } }] });
  f.library.attach(root); entry.click(); await waitUntil(() => views.length === 1);
  const pending = f.library.action('edit-web', { id: 'legacy', source: '', name: '新名字', tags: ['中文'] });
  views[0].options.onBack(); await pending;
  entry.click(); await waitUntil(() => views.length === 2);
  assert.deepEqual(views[1].options.initialSession, { ...snapshot, webSource: '', webName: '', webTags: '', editWebId: '', editWebSourceMissing: false });
  assert.equal(f.owner.fontLibrary.fonts[0].name, '新名字'); assert.deepEqual(f.owner.fontLibrary.fonts[0].faces, webFont.faces);
  f.stop();
});
