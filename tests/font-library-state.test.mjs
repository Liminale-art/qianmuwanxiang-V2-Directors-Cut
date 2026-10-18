import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFontLibrary, updateFontLibrary, mergeFontLibraryRecords } from '../qianmu-font-library-state.js';
import { migrateQianmuSettingsV2 } from '../qianmu-data-migrations.js';
const font = id => ({ id, name: id, source: { kind: 'web', input: `https://fonts.example/${id}.woff2`, url: `https://fonts.example/${id}.woff2` }, faces: [{ urls: [{ url: `https://fonts.example/${id}.woff2`, format: 'woff2' }], weight: '400', style: 'normal' }] });
const fixture = () => normalizeFontLibrary({ ...normalizeFontLibrary(), fonts: [font('a'), font('b')] });

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
