import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFontLibrary, updateFontLibrary, mergeFontLibraryRecords, fontLibraryTags } from '../qianmu-font-library-state.js';
import { migrateQianmuSettingsV2 } from '../qianmu-data-migrations.js';
import { createLocalFontRecord, exportFontPack, importFontPack } from '../qianmu-font-sources.js';
const font = id => ({ id, name: id, source: { kind: 'web', input: `https://fonts.example/${id}.woff2`, url: `https://fonts.example/${id}.woff2` }, faces: [{ urls: [{ url: `https://fonts.example/${id}.woff2`, format: 'woff2' }], weight: '400', style: 'normal' }] });
const fixture = () => normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [font('a'), font('b')] });

test('legacy management preferences default without reordering or changing font records and applications', () => {
  const legacy = fixture(); delete legacy.pinnedIds; delete legacy.sortBy; delete legacy.sortOrder;
  const before = structuredClone(legacy), normalized = normalizeFontLibrary(legacy);
  assert.deepEqual(normalized, { ...before, pinnedIds: [], sortBy: 'name', sortOrder: 'asc' });
  assert.deepEqual(legacy, before); assert.equal(normalized.version, 1);
  const stale = { ...normalized, pinnedIds: ['b', 'missing', 'a'] };
  assert.deepEqual(normalizeFontLibrary(stale).pinnedIds, ['b', 'a']);
  assert.deepEqual(stale.pinnedIds, ['b', 'missing', 'a']);
  const previousVersion = { ...fixture(), sortOrder: 'desc', pinnedIds: ['b'] }; delete previousVersion.sortBy;
  assert.deepEqual(normalizeFontLibrary(previousVersion), { ...previousVersion, sortBy: 'name' });
});

test('name and added-order preferences change atomically without reordering fonts, pins or dormant applications', () => {
  const original = normalizeFontLibrary({ ...fixture(), enabled: false, pinnedIds: ['b', 'a'], previewText: '保留样字',
    body: { fontId: 'a', enabled: true, weight: '700' }, st: { fontId: 'b', enabled: true }, mode: 'shared', shared: { fontId: 'a', enabled: true } });
  let state = original;
  for (const by of ['added', 'name']) for (const order of ['desc', 'asc']) {
    state = updateFontLibrary(state, 'set-sort-order', { by, order });
    assert.deepEqual(state, { ...original, sortBy: by, sortOrder: order });
    assert.deepEqual(normalizeFontLibrary(JSON.parse(JSON.stringify(state))), state);
  }
  state = updateFontLibrary(state, 'set-sort-order', { by: 'added', order: 'desc' });
  assert.deepEqual(updateFontLibrary(state, 'set-sort-order', { order: 'asc' }), { ...original, sortBy: 'added', sortOrder: 'asc' });
  assert.deepEqual(original.fonts.map(item => item.id), ['a', 'b']); assert.equal(original.sortBy, 'name');
});

test('pinning is ordered, idempotent and independent from name sorting or the original catalogue order', () => {
  let state = updateFontLibrary(fixture(), 'apply-font', { target: 'body', fontId: 'a', weight: '700' });
  state = updateFontLibrary(state, 'apply-font', { target: 'st', fontId: 'b' });
  state = updateFontLibrary(state, 'set-enabled', { enabled: false });
  const original = structuredClone(state);
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: true });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'a', pinned: true });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: true });
  assert.deepEqual(state.pinnedIds, ['b', 'a']);
  for (const order of ['desc', 'asc']) {
    state = updateFontLibrary(state, 'set-sort-order', { order });
    assert.deepEqual(state, { ...original, pinnedIds: ['b', 'a'], sortOrder: order });
  }
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: false });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: false });
  assert.deepEqual(state.pinnedIds, ['a']);
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: true });
  assert.deepEqual(state, { ...original, pinnedIds: ['a', 'b'] });
  assert.deepEqual(original.fonts.map(item => item.id), ['a', 'b']);
});

test('adding, editing and merging retain management preferences while deletion prunes only removed pins', () => {
  let state = updateFontLibrary(fixture(), 'set-sort-order', { by: 'added', order: 'desc' });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: true });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'a', pinned: true });
  const before = structuredClone(state);
  state = mergeFontLibraryRecords(state, [font('c'), { ...font('a'), id: 'duplicate' }], () => 'unused').state;
  assert.deepEqual(state.pinnedIds, ['b', 'a']); assert.equal(state.sortOrder, 'desc'); assert.equal(state.sortBy, 'added');
  assert.deepEqual(state.fonts.map(item => item.id), ['a', 'b', 'c']);
  state = updateFontLibrary(state, 'replace-web', { id: 'b', record: { ...font('replacement'), name: '最先的名称' } });
  state = updateFontLibrary(state, 'update-fonts', { ids: ['a'], name: '最后的名称', tags: ['已改'] });
  assert.deepEqual(state.pinnedIds, ['b', 'a']); assert.equal(state.sortOrder, 'desc'); assert.equal(state.sortBy, 'added');
  assert.deepEqual(state.fonts.map(item => item.id), ['a', 'b', 'c']);
  const edited = structuredClone(state);
  state = mergeFontLibraryRecords(state, [font('c'), { ...font('replacement'), id: 'duplicate-edit' }], () => 'unused').state;
  assert.deepEqual(state, edited, 'reimporting existing sources does not move their original slots');
  state = updateFontLibrary(state, 'delete-fonts', { ids: ['b', 'c'] });
  assert.deepEqual(state.pinnedIds, ['a']); assert.equal(state.sortOrder, 'desc'); assert.equal(state.sortBy, 'added');
  assert.equal(state.fonts[0].id, 'a'); assert.deepEqual(before.pinnedIds, ['b', 'a']);
  state = mergeFontLibraryRecords(state, [font('c'), font('b')], () => 'unused').state;
  assert.deepEqual(state.fonts.map(item => item.id), ['a', 'c', 'b'], 'deleted then re-added fonts append in their new import order');
  assert.deepEqual(state.pinnedIds, ['a']); assert.equal(state.sortBy, 'added'); assert.equal(state.sortOrder, 'desc');
  assert.ok(state.fonts.every(item => !('addedAt' in item) && !('createdAt' in item)), 'no historical timestamps are invented');
});

test('invalid management preferences and stale pin actions reject without mutating the original library', () => {
  const state = fixture(), original = structuredClone(state);
  for (const pinnedIds of [null, 'a', {}, [null], [12], ['../a'], ['a', 'a'], Array(201).fill('a'), Array(1)]) {
    const value = { ...state, pinnedIds }, before = structuredClone(value);
    assert.throws(() => normalizeFontLibrary(value)); assert.deepEqual(value, before);
  }
  for (const order of [null, '', 'ASC', 'random', 1, {}]) {
    assert.throws(() => normalizeFontLibrary({ ...state, sortOrder: order }), /排序设置无效/);
    assert.throws(() => updateFontLibrary(state, 'set-sort-order', { order }), /排序设置无效/);
  }
  for (const by of [null, '', 'NAME', 'time', 'createdAt', 1, true, {}, [], ['added']]) {
    const value = { ...state, sortBy: by }, before = structuredClone(value);
    assert.throws(() => normalizeFontLibrary(value), /排序设置无效/); assert.deepEqual(value, before);
    assert.throws(() => updateFontLibrary(state, 'set-sort-order', { by, order: 'desc' }), /排序设置无效/);
  }
  assert.throws(() => updateFontLibrary(state, 'set-sort-order', { by: 'added' }), /排序设置无效/);
  for (const pinned of [undefined, null, 'true', 1, {}]) assert.throws(() => updateFontLibrary(state, 'set-font-pinned', { id: 'a', pinned }), /置顶设置无效/);
  for (const pinned of [false, true]) assert.throws(() => updateFontLibrary(state, 'set-font-pinned', { id: 'missing', pinned }), /已不在库中/);
  for (const id of [undefined, null, {}, '../a']) assert.throws(() => updateFontLibrary(state, 'set-font-pinned', { id, pinned: true }), /标识无效/);
  assert.deepEqual(state, original);
});

test('v1 mixed font packs preserve record order and originals without replacing receiver sorting or application preferences', async () => {
  const bytes = new Uint8Array(32), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x00010000); header.setUint16(4, 1); header.setUint32(20, 28); header.setUint32(24, 4);
  const local = await createLocalFontRecord({ name: '原件.ttf', size: bytes.length, arrayBuffer: async () => bytes.buffer });
  Object.assign(local.record, { id: 'local-pack', folder: '旧资料', tags: ['原件'] });
  const records = [font('c'), { ...font('a'), id: 'duplicate-a', name: '不覆盖原名称' }, local.record, font('d')];
  const text = exportFontPack(records, { localFiles: { 'local-pack': bytes }, previewText: '来源样字', folders: ['旧资料'] });
  const encoded = JSON.parse(text), pack = importFontPack(text);
  assert.equal(encoded.version, 1);
  for (const key of ['sortBy', 'sortOrder', 'pinnedIds', 'mode', 'enabled', 'body', 'st', 'shared']) assert.equal(key in encoded, false);
  assert.deepEqual(pack.records.map(item => item.id), ['c', 'duplicate-a', 'local-pack', 'd']); assert.deepEqual(pack.localFiles['local-pack'], bytes);
  const receiver = normalizeFontLibrary({ ...fixture(), enabled: false, pinnedIds: ['b', 'a'], sortBy: 'added', sortOrder: 'desc', previewText: '接收方样字',
    body: { fontId: 'a', enabled: true }, st: { fontId: 'b', enabled: true }, mode: 'shared', shared: { fontId: 'b', enabled: true } });
  const before = structuredClone(receiver), merged = mergeFontLibraryRecords(receiver, pack.records, () => 'unused');
  assert.deepEqual(merged.state.fonts.map(item => item.id), ['a', 'b', 'c', 'local-pack', 'd']);
  assert.deepEqual(merged.state.fonts.slice(0, 2), before.fonts); assert.equal(merged.mapping.get('duplicate-a'), 'a');
  assert.deepEqual(merged.state.fonts[3], local.record);
  for (const key of ['sortBy', 'sortOrder', 'pinnedIds', 'mode', 'enabled', 'body', 'st', 'shared', 'previewText']) assert.deepEqual(merged.state[key], before[key]);
  assert.deepEqual(mergeFontLibraryRecords(merged.state, pack.records, () => 'unused').state, merged.state, 'reimporting the same pack is order-idempotent');
  assert.deepEqual(importFontPack(exportFontPack(merged.state.fonts, { localFiles: pack.localFiles })).localFiles['local-pack'], bytes);
  assert.deepEqual(receiver, before); assert.deepEqual(pack.localFiles['local-pack'], bytes);
});

test('tag metadata is normalized strictly and an invalid edit cannot mutate the original library', () => {
  assert.deepEqual(fontLibraryTags([' 正文 ', '衬线', '正文', '']), ['正文', '衬线']);
  assert.deepEqual(fontLibraryTags([]), []);
  const state = updateFontLibrary(fixture(), 'update-fonts', { ids: ['a'], folder: '阅读', tags: ['原标签'] });
  const original = structuredClone(state);
  for (const tags of [null, '正文', {}, [null], [123], [{}], ['字'.repeat(81)], ['坏\u0000标签'], Array(33).fill('标签')]) {
    assert.throws(() => fontLibraryTags(tags), /标签/);
    assert.throws(() => updateFontLibrary(state, 'replace-web', { id: 'a', record: font('a'), tags }), /标签/);
    assert.deepEqual(state, original);
  }
});

test('Web tag editing distinguishes omission, replacement and explicit clearing without changing classification or choices', () => {
  let state = updateFontLibrary(fixture(), 'update-fonts', { ids: ['a'], folder: '阅读', tags: ['原标签'] });
  state = updateFontLibrary(state, 'apply-font', { target: 'shared', fontId: 'a', weight: '700' });
  const original = structuredClone(state), record = { ...font('a'), name: '新名称', tags: ['来源默认标签'] };
  const kept = updateFontLibrary(state, 'replace-web', { id: 'a', record });
  assert.deepEqual(kept.fonts[0].tags, ['原标签']);
  const changed = updateFontLibrary(state, 'replace-web', { id: 'a', record, tags: [' 新标签 ', '新标签'] });
  assert.deepEqual(changed.fonts[0].tags, ['新标签']);
  const cleared = updateFontLibrary(state, 'replace-web', { id: 'a', record, tags: [] });
  assert.deepEqual(cleared.fonts[0].tags, []);
  for (const result of [kept, changed, cleared]) {
    assert.equal(result.fonts[0].id, 'a'); assert.equal(result.fonts[0].folder, '阅读');
    for (const target of ['body', 'st', 'shared', 'enabled', 'mode']) assert.deepEqual(result[target], original[target]);
    assert.deepEqual(result.fonts[1], original.fonts[1]);
  }
  assert.deepEqual(state, original);
});

test('merging new metadata never overwrites a duplicate source and renaming shares the 160-character limit', () => {
  const state = updateFontLibrary(fixture(), 'update-fonts', { ids: ['a'], name: '原名称', folder: '原目录', tags: ['原标签'] });
  const original = structuredClone(state);
  const records = [{ ...font('a'), id: 'duplicate', name: '不应覆盖', folder: '新目录', tags: ['新标签'] }, { ...font('c'), name: ' 新字体 ', tags: [' 新标签 ', '新标签'] }];
  const merged = mergeFontLibraryRecords(state, records, () => 'unused');
  assert.deepEqual(merged.state.fonts[0], original.fonts[0]); assert.equal(merged.mapping.get('duplicate'), 'a');
  assert.equal(merged.state.fonts[2].name, '新字体'); assert.deepEqual(merged.state.fonts[2].tags, ['新标签']);
  assert.equal(updateFontLibrary(state, 'update-fonts', { ids: ['a'], name: '名'.repeat(160) }).fonts[0].name.length, 160);
  for (const name of ['名'.repeat(161), {}, 12, null, '坏\u0000名称']) assert.throws(() => updateFontLibrary(state, 'update-fonts', { ids: ['a'], name }), /名称/);
  assert.deepEqual(state, original);
});

test('in-place Web replacement preserves identity/classification and only reconciles unsupported variants', () => {
  let state = updateFontLibrary(fixture(), 'apply-font', { target: 'body', fontId: 'a', weight: '700', style: 'italic' });
  state = updateFontLibrary(state, 'apply-font', { target: 'st', fontId: 'a', weight: '650', style: 'normal' });
  state = updateFontLibrary(state, 'update-fonts', { ids: ['a'], folder: '正文', tags: ['保留'] });
  const original = structuredClone(state);
  const renamed = updateFontLibrary(state, 'replace-web', { id: 'a', record: { ...font('a'), name: '改名字' } });
  assert.deepEqual(renamed.body, original.body, 'name-only edit must not normalize existing preferences');
  const record = { ...font('a'), faces: [{ ...font('a').faces[0], weight: '300 600' }] };
  state = updateFontLibrary(state, 'replace-web', { id: 'a', record });
  assert.deepEqual(state.body, { ...original.body, style: 'normal', weight: '600' });
  assert.deepEqual(state.st, { ...original.st, weight: '600' });
  assert.equal(state.fonts[0].id, 'a'); assert.equal(state.fonts[0].folder, '正文'); assert.deepEqual(state.fonts[0].tags, ['保留']);
  assert.deepEqual(state.fonts[1], original.fonts[1]); assert.deepEqual(original.body, { fontId: 'a', weight: '700', style: 'italic', enabled: true });
  assert.throws(() => updateFontLibrary(state, 'replace-web', { id: 'missing', record }), /已变化/);
});

test('master application gate defaults on for legacy libraries and strictly preserves dormant choices', () => {
  const legacy = fixture(); delete legacy.enabled;
  assert.equal(normalizeFontLibrary(legacy).enabled, true);
  let state = updateFontLibrary(legacy, 'apply-font', { target: 'body', fontId: 'a', weight: '700' });
  state = updateFontLibrary(state, 'apply-font', { target: 'st', fontId: 'b' });
  state = updateFontLibrary(state, 'apply-font', { target: 'shared', fontId: 'a' });
  const original = structuredClone(state);
  state = updateFontLibrary(state, 'set-enabled', { enabled: false });
  assert.deepEqual(state, { ...original, enabled: false });
  state = updateFontLibrary(state, 'apply-font', { target: 'body', fontId: 'b' });
  assert.equal(state.enabled, false);
  assert.deepEqual(state.shared, original.shared);
  state = mergeFontLibraryRecords(state, [font('c')], () => 'c').state;
  assert.equal(state.enabled, false);
  state = updateFontLibrary(state, 'delete-fonts', { ids: ['c'] });
  assert.equal(state.enabled, false);
  state = updateFontLibrary(state, 'set-enabled', { enabled: true });
  assert.equal(state.body.fontId, 'b'); assert.equal(state.mode, 'separate');
  for (const enabled of [null, 'false', 0, {}]) {
    assert.throws(() => updateFontLibrary(state, 'set-enabled', { enabled }), /启用设置无效/);
    assert.throws(() => normalizeFontLibrary({ ...state, enabled }), /启用设置无效/);
  }
});

test('new sample replaces only known legacy defaults and preserves custom or blank samples', () => {
  assert.equal(normalizeFontLibrary().previewText, '一念起幕，万象成诗。 AaBbCc123456');
  const state = fixture();
  for (const previewText of ['风过长街，故事仍在继续。The quick brown fox 0123456789.', '一蝶振翅，万象入幕。', '一蝶振翅，千幕万象。 AaBbCc123456']) {
    const original = { ...state, previewText };
    assert.equal(normalizeFontLibrary(original).previewText, '一念起幕，万象成诗。 AaBbCc123456');
    assert.equal(original.previewText, previewText, 'normalization does not mutate the saved input');
  }
  for (const previewText of ['', '人间万象 Aa 0123', '一蝶振翅，万象入幕。 Abc 012345', '一蝶振翅，千幕万象。 自定文案', '一念起幕，万象成诗。 AaBbCc123456']) assert.equal(normalizeFontLibrary({ ...state, previewText }).previewText, previewText);
});

test('ordinary settings migration retains the full font catalogue and unrelated existing data', () => {
  const original = { fontLibrary: fixture(), proseLayout: { fontSize: 20 }, logHistory: [{ response: '保留原记录' }], custom: { untouched: true } };
  const before = structuredClone(original), result = migrateQianmuSettingsV2(original);
  assert.equal(result.failed, false);
  for (const key of Object.keys(before)) assert.deepEqual(result.value[key], before[key]);
  assert.deepEqual(original, before);
  assert.equal(migrateQianmuSettingsV2(result.value).value, result.value);
});
test('separate choices survive shared mode and disabling does not delete fonts or sizes', () => {
  let state = fixture();
  state = updateFontLibrary(state, 'set-assignment', { target: 'body', fontId: 'a', weight: '400' });
  state = updateFontLibrary(state, 'set-assignment', { target: 'st', fontId: 'b', weight: '400' });
  const separate = structuredClone(state);
  state = updateFontLibrary(state, 'set-mode', { mode: 'shared' });
  state = updateFontLibrary(state, 'set-assignment', { target: 'shared', fontId: 'b', weight: '400' });
  state = updateFontLibrary(state, 'set-mode', { mode: 'separate' });
  assert.deepEqual(state.body, separate.body); assert.deepEqual(state.st, separate.st);
  state = updateFontLibrary(state, 'set-assignment', { target: 'body', fontId: '', enabled: false });
  assert.equal(state.body.enabled, false); assert.equal(state.fonts.length, 2);
  assert.ok(!JSON.stringify(state).includes('fontSize'));
});
test('library classification and selection changes are local and preserve unrelated selections', () => {
  let state = updateFontLibrary(fixture(), 'set-assignment', { target: 'st', fontId: 'b' });
  state = updateFontLibrary(state, 'update-fonts', { ids: ['a'], folder: '小说', tags: ['衬线', '正文'] });
  assert.deepEqual(state.fonts[0].tags, ['衬线', '正文']); assert.ok(state.folders.includes('小说'));
  state = updateFontLibrary(state, 'set-preview', { text: '自定义文案' });
  assert.equal(state.previewText, '自定义文案'); assert.equal(state.st.fontId, 'b');
  state = updateFontLibrary(state, 'delete-fonts', { ids: ['a'] });
  assert.equal(state.fonts.length, 1); assert.equal(state.st.fontId, 'b');
});

test('list application atomically chooses its mode and retains independent preferences', () => {
  let state = updateFontLibrary(fixture(), 'apply-font', { target: 'body', fontId: 'a', weight: '700' });
  state = updateFontLibrary(state, 'apply-font', { target: 'st', fontId: 'b' });
  const separate = structuredClone(state);
  state = updateFontLibrary(state, 'apply-font', { target: 'shared', fontId: 'a' });
  assert.equal(state.mode, 'shared');
  assert.deepEqual(state.body, separate.body); assert.deepEqual(state.st, separate.st);
  state = updateFontLibrary(state, 'apply-font', { target: 'body', fontId: 'b' });
  assert.equal(state.mode, 'separate'); assert.equal(state.body.fontId, 'b'); assert.deepEqual(state.st, separate.st);
  assert.throws(() => updateFontLibrary(state, 'apply-font', { target: 'body', fontId: 'missing' }));
});

test('restore actions preserve other scopes and ignore stale or dormant choices', () => {
  let state = updateFontLibrary(fixture(), 'apply-font', { target: 'body', fontId: 'a' });
  state = updateFontLibrary(state, 'apply-font', { target: 'st', fontId: 'b' });
  assert.deepEqual(updateFontLibrary(state, 'restore-font', { target: 'body', fontId: 'b' }), state);
  const separate = structuredClone(state);
  state = updateFontLibrary(state, 'apply-font', { target: 'shared', fontId: 'b' });
  assert.deepEqual(updateFontLibrary(state, 'restore-font', { target: 'body', fontId: 'a' }), state);
  state = updateFontLibrary(state, 'restore-font', { target: 'shared', fontId: 'b' });
  assert.equal(state.mode, 'separate'); assert.deepEqual(state.body, separate.body); assert.deepEqual(state.st, separate.st);
  state = updateFontLibrary(state, 'restore-font', { target: 'body', fontId: 'a' });
  assert.equal(state.body.enabled, false); assert.deepEqual(state.st, separate.st); assert.equal(state.fonts.length, 2);
});
test('imports deduplicate sources, remap collisions and do not activate fonts', () => {
  const base = fixture();
  const duplicate = { ...font('a'), id: 'other', name: '另一个名字' };
  const collision = { ...font('new'), id: 'b' };
  const result = mergeFontLibraryRecords(base, [duplicate, collision], () => 'newid');
  assert.equal(result.state.fonts.length, 3);
  assert.equal(result.mapping.get('other'), 'a'); assert.equal(result.mapping.get('b'), 'newid');
  assert.equal(result.state.body.enabled, false); assert.deepEqual(base, fixture());
});
test('bad configurations fail without mutating or silently truncating existing data', () => {
  for (const value of [{ version: 2, fonts: [] }, { ...fixture(), fonts: [font('a'), font('a')] }, { ...fixture(), previewText: '字'.repeat(501) }]) {
    const original = structuredClone(value); assert.throws(() => normalizeFontLibrary(value)); assert.deepEqual(value, original);
  }
  assert.throws(() => updateFontLibrary(fixture(), 'set-assignment', { target: 'body', fontId: 'missing' }));
  assert.throws(() => updateFontLibrary(fixture(), 'set-assignment', { target: 'body', fontId: 'a', weight: '400;}' }));
});

test('metadata catalogues above the old 3 MiB threshold remain usable while the 8 MiB guard protects settings', () => {
  const faces = family => Array.from({ length: 2048 }, (_, index) => ({
    urls: [{ url: `https://fonts.example/${family}/${'subset-'.repeat(70)}${index}.woff2`, format: 'woff2' }],
    weight: '400', style: 'normal', unicodeRange: `U+${(0x4e00 + index).toString(16)}`,
  }));
  const fonts = Array.from({ length: 4 }, (_, family) => ({ id: `catalog-${family}`, name: `catalog-${family}`,
    source: { kind: 'web', input: `https://fonts.example/catalog-${family}.css`, url: `https://fonts.example/catalog-${family}.css` }, faces: faces(family) }));
  const value = { ...normalizeFontLibrary(), fonts };
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).byteLength > 3 * 1024 * 1024);
  assert.doesNotThrow(() => normalizeFontLibrary(value));
  const tooLarge = { ...value, previewText: '扩'.repeat(500) };
  tooLarge.fonts = tooLarge.fonts.map(font => ({ ...font, faces: font.faces.map(face => ({ ...face, urls: face.urls.map(item => ({ ...item, url: `${item.url}${'x'.repeat(900)}` })) })) }));
  assert.throws(() => normalizeFontLibrary(tooLarge), /字体目录资料超过 8 MB/);
});

test('larger per-font subsets retain all metadata and choices while over-limit records fail without replacing old state', () => {
  const large = { ...font('large-cjk'), folder: '旧目录', tags: ['中文'], faces: Array.from({ length: 2048 }, (_, index) => ({ urls: [{ url: `https://fonts.example/cjk/${index}.woff2`, format: 'woff2' }], weight: '200 900', style: 'normal', unicodeRange: `U+${(0x4e00 + index).toString(16)}` })) };
  const original = normalizeFontLibrary({ ...fixture(), fonts: [...fixture().fonts, large], pinnedIds: ['large-cjk', 'a'], sortOrder: 'desc', body: { fontId: 'large-cjk', weight: '600', style: 'normal', enabled: true } });
  const before = structuredClone(original), readBack = normalizeFontLibrary(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(readBack, before); assert.equal(readBack.fonts[2].faces.length, 2048);
  const invalid = { ...large, faces: [...large.faces, { ...large.faces[0], urls: [{ url: 'https://fonts.example/cjk/extra.woff2' }] }] };
  assert.throws(() => mergeFontLibraryRecords(original, [invalid], () => 'unused'), /分片数量不正确/);
  assert.throws(() => updateFontLibrary(original, 'replace-web', { id: 'large-cjk', record: invalid }), /分片数量不正确/);
  assert.deepEqual(original, before);
});

test('reading existing libraries does not add a new aggregate face gate intended only for portable packs', () => {
  // Twenty 512-face families were valid before the compatibility change. Keep
  // them readable even though exporting all at once exceeds a pack's budget.
  const fonts = Array.from({ length: 20 }, (_, family) => ({ ...font(`old-${family}`), faces: Array.from({ length: 512 }, (_, index) => ({ urls: [{ url: `https://fonts.example/${family}/${index}.woff2` }], weight: '400', style: 'normal' })) }));
  const value = { ...normalizeFontLibrary(), fonts, pinnedIds: ['old-19', 'old-0'], sortOrder: 'desc' }, before = structuredClone(value);
  const normalized = normalizeFontLibrary(value);
  assert.equal(normalized.fonts.reduce((count, item) => count + item.faces.length, 0), 10240);
  assert.deepEqual(normalized.pinnedIds, value.pinnedIds); assert.equal(normalized.sortOrder, 'desc');
  assert.deepEqual(normalized.fonts.map(item => item.faces), fonts.map(item => item.faces)); assert.deepEqual(value, before);
});
