import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFontLibrary, updateFontLibrary, mergeFontLibraryRecords, fontLibraryTags } from '../qianmu-font-library-state.js';
import { migrateQianmuSettingsV2 } from '../qianmu-data-migrations.js';
const font = id => ({ id, name: id, source: { kind: 'web', input: `https://fonts.example/${id}.woff2`, url: `https://fonts.example/${id}.woff2` }, faces: [{ urls: [{ url: `https://fonts.example/${id}.woff2`, format: 'woff2' }], weight: '400', style: 'normal' }] });
const fixture = () => normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [font('a'), font('b')] });

test('legacy management preferences default without reordering or changing font records and applications', () => {
  const legacy = fixture(); delete legacy.pinnedIds; delete legacy.sortOrder;
  const before = structuredClone(legacy), normalized = normalizeFontLibrary(legacy);
  assert.deepEqual(normalized, { ...before, pinnedIds: [], sortOrder: 'asc' });
  assert.deepEqual(legacy, before); assert.equal(normalized.version, 1);
  const stale = { ...normalized, pinnedIds: ['b', 'missing', 'a'] };
  assert.deepEqual(normalizeFontLibrary(stale).pinnedIds, ['b', 'a']);
  assert.deepEqual(stale.pinnedIds, ['b', 'missing', 'a']);
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
  let state = updateFontLibrary(fixture(), 'set-sort-order', { order: 'desc' });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'b', pinned: true });
  state = updateFontLibrary(state, 'set-font-pinned', { id: 'a', pinned: true });
  const before = structuredClone(state);
  state = mergeFontLibraryRecords(state, [font('c'), { ...font('a'), id: 'duplicate' }], () => 'unused').state;
  assert.deepEqual(state.pinnedIds, ['b', 'a']); assert.equal(state.sortOrder, 'desc');
  assert.deepEqual(state.fonts.map(item => item.id), ['a', 'b', 'c']);
  state = updateFontLibrary(state, 'replace-web', { id: 'b', record: { ...font('replacement'), name: '最先的名称' } });
  state = updateFontLibrary(state, 'update-fonts', { ids: ['a'], name: '最后的名称', tags: ['已改'] });
  assert.deepEqual(state.pinnedIds, ['b', 'a']); assert.equal(state.sortOrder, 'desc');
  assert.deepEqual(state.fonts.map(item => item.id), ['a', 'b', 'c']);
  state = updateFontLibrary(state, 'delete-fonts', { ids: ['b', 'c'] });
  assert.deepEqual(state.pinnedIds, ['a']); assert.equal(state.sortOrder, 'desc');
  assert.equal(state.fonts[0].id, 'a'); assert.deepEqual(before.pinnedIds, ['b', 'a']);
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
  for (const pinned of [undefined, null, 'true', 1, {}]) assert.throws(() => updateFontLibrary(state, 'set-font-pinned', { id: 'a', pinned }), /置顶设置无效/);
  for (const pinned of [false, true]) assert.throws(() => updateFontLibrary(state, 'set-font-pinned', { id: 'missing', pinned }), /已不在库中/);
  for (const id of [undefined, null, {}, '../a']) assert.throws(() => updateFontLibrary(state, 'set-font-pinned', { id, pinned: true }), /标识无效/);
  assert.deepEqual(state, original);
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

test('new sample replaces only the known legacy default and preserves custom or blank samples', () => {
  assert.equal(normalizeFontLibrary().previewText, '一蝶振翅，万象入幕。');
  const state = fixture();
  assert.equal(normalizeFontLibrary({ ...state, previewText: '风过长街，故事仍在继续。The quick brown fox 0123456789.' }).previewText, '一蝶振翅，万象入幕。');
  for (const previewText of ['', '人间万象 Aa 0123']) assert.equal(normalizeFontLibrary({ ...state, previewText }).previewText, previewText);
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
