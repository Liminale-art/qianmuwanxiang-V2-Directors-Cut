import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { attachSettingsPersistence, persistedSettingsView } from '../qianmu-settings-persistence.js';

const scene = (id, content = '正文') => ({ id, source: '', instruction: '', content, isHtml: false, createdAt: '2026-01-01T00:00:00.000Z' });

test('the in-memory settings stay whole; only the serialised form is slimmed, and a reload restores it', () => {
  const latest = scene('s2', '最新一幕'.repeat(50));
  const settings = { enabled: true, _presetGlobalMigrated: true, selectedPresetItems: { 预设: { a: true } },
    selectedPresetItemsByChat: { 旧聊天: { 预设: { a: true } } }, selectedPresetNamesByChat: { 旧聊天: { 预设: true } },
    theater: { instruction: '', lastOutput: latest, recentOutputs: [latest, scene('s1')] } };
  assert.equal(attachSettingsPersistence(settings), settings, 'returns the same object');
  assert.equal(settings.theater.lastOutput, latest, 'memory is untouched');
  assert.deepEqual(settings.selectedPresetItemsByChat, {}, 'migration-only tables are emptied once the migration flag is set');
  assert.deepEqual(settings.selectedPresetItems, { 预设: { a: true } }, 'the live global table is not touched');
  assert.equal(Object.keys(settings).includes('toJSON'), false, 'the hook is not enumerable');
  const written = JSON.parse(JSON.stringify({ extension_settings: { story_director_liminale: settings } })).extension_settings.story_director_liminale;
  assert.equal(written.theater.lastOutput, null);
  assert.deepEqual(written.theater.recentOutputs, [latest, scene('s1')]);
  assert.equal(written.toJSON, undefined);
  // Reload: the restored object has the scene back, as the very same object as the first recent output.
  attachSettingsPersistence(written);
  assert.equal(written.theater.lastOutput, written.theater.recentOutputs[0]);
  assert.deepEqual(written.theater.lastOutput, latest);
  assert.equal(JSON.stringify(written).length, JSON.stringify(settings).length, 'stable across save → load → save');
});

test('anything that is not provably a duplicate is written in full', () => {
  const kept = [
    { lastOutput: scene('a'), recentOutputs: [scene('b')] },                       // different scenes
    { lastOutput: scene('a', '已编辑'), recentOutputs: [scene('a', '未编辑')] },     // same id, drifted content
    { lastOutput: scene('a'), recentOutputs: [] },
    { lastOutput: scene('a') },
    { lastOutput: null, recentOutputs: [scene('a')] },
  ];
  for (const theater of kept) {
    const settings = attachSettingsPersistence({ theater: structuredClone(theater) });
    assert.deepEqual(JSON.parse(JSON.stringify(settings)).theater.lastOutput ?? null, theater.lastOutput ?? null);
  }
  const unmigrated = attachSettingsPersistence({ selectedPresetItemsByChat: { 聊天: { 预设: { a: true } } } });
  assert.deepEqual(unmigrated.selectedPresetItemsByChat, { 聊天: { 预设: { a: true } } }, 'tables still needed by the migration are kept');
});

test('copies stay complete, the hook is idempotent, and a failing step falls back to the full object', () => {
  const latest = scene('s');
  const settings = attachSettingsPersistence({ theater: { lastOutput: latest, recentOutputs: [latest] }, big: 'x' });
  const hook = Object.getOwnPropertyDescriptor(settings, 'toJSON').value;
  attachSettingsPersistence(settings);
  assert.equal(Object.getOwnPropertyDescriptor(settings, 'toJSON').value, hook);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...settings })).theater.lastOutput, latest, 'a spread copy (exports, backups) serialises in full');
  assert.deepEqual(structuredClone(settings).theater.lastOutput, latest);
  const slimmers = [() => { throw new Error('side store unavailable'); }];
  const warn = console.warn; console.warn = () => {};
  try {
    const failing = attachSettingsPersistence({ theater: { lastOutput: latest, recentOutputs: [latest] } }, { slimmers });
    assert.deepEqual(JSON.parse(JSON.stringify(failing)).theater.lastOutput, latest, 'a failing slimmer never costs data');
  } finally { console.warn = warn; }
  assert.equal(persistedSettingsView({ a: 1 }).a, 1);
  for (const odd of [null, undefined, 3, 'x', []]) assert.equal(attachSettingsPersistence(odd), odd);
});

test('the entry returns its settings through the persistence boundary', async () => {
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /return attachSettingsPersistence\(extensionSettings\[MODULE_NAME\], sidecars\);/);
  assert.match(entry, /const fontLibrary=fontFaces\.gate\(createFontLibrary\(/, 'the font library is only reached through the gate');
});
