import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as utils from '../qianmu-storyboard-utils.js';
import * as sources from '../qianmu-st-context-sources.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

// Contract checked against unmodified ST 1.19.0, tag 7e8663cd9c184a550b37238218bdd32c6efc68e9.
// No core globals, helper extension, real account, server or generation is required.
function fixture({ official = true } = {}) {
  const calls = [], presets = [{ prompts: [{ identifier: 'one', content: 'saved current' }] }, { prompts: [{ identifier: 'two', content: 'other preset' }] }];
  const state = { selected: 'Current', presets, names: { Current: 0, Other: 1 }, worlds: ['Book file', 'settings'], world: { entries: { 0: { uid: 0, content: 'cached official', extensions: { keep: true } } } } };
  const manager = {
    getSelectedPresetName() { calls.push('selected'); return state.selected; },
    getAllPresets() { calls.push('names'); return Object.keys(state.names); },
    getCompletionPresetByName(name) { calls.push(['preset', name]); return state.presets[state.names[name]]; },
  };
  const context = { mainApi: 'novel', chatCompletionSettings: { preset_settings_openai: 'Current', prompts: [{ identifier: 'one', content: 'unsaved live prompt' }] }, powerUserSettings: { persona_description: 'official USER' }, name1: 'USER',
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'synthetic' }) };
  if (official) Object.assign(context, { getPresetManager(api) { calls.push(['manager', api]); return manager; }, getWorldInfoNames: () => [...state.worlds], loadWorldInfo: async name => { calls.push(['world', name]); return state.world; } });
  const sandbox = vm.createContext({ ...utils, ...sources, console: { warn() {} }, structuredClone, ctx: () => context, MODULE_NAME: 'test',
    document: { querySelector: () => null }, fetch: async (url, request) => { calls.push(['fetch', url, request]); return { ok: true, json: async () => state.response || [] }; },
    normalizeWorldBookEntries: wb => Array.isArray(wb) ? wb : Object.values(wb?.entries || {}),
  });
  const names = ['getCurrentPresetName','getCurrentPresetEntries','listPresetNames','getPresetEntries','getWorldBookEntries','listWorldBooks','detectBoundWorldBookNames','getPersonaDescription','getPersonaName'];
  vm.runInContext(names.map(storyboardFunctionSource).join('\n'), sandbox);
  return { sandbox, context, state, manager, calls, json: value => JSON.parse(JSON.stringify(value)) };
}

test('official preset manager reads CC prompt names and arbitrary presets without global patches or changing the active API', () => {
  const f = fixture(); assert.equal(f.sandbox.getCurrentPresetName(), 'Current');
  assert.deepEqual(f.json(f.sandbox.listPresetNames()), ['Current', 'Other']);
  assert.equal(f.sandbox.getPresetEntries('Other')[0].content, 'other preset');
  assert.ok(f.calls.filter(row => row[0] === 'manager').every(row => row[1] === 'openai')); assert.equal(f.context.mainApi, 'novel');
});

test('official current prompt edits and empty arrays are authoritative, not replaced by saved or stale helper content', () => {
  const f = fixture(); f.sandbox.TavernHelper = { getPreset: () => ({ prompts: [{ content: 'stale helper' }] }) };
  assert.equal(f.sandbox.getPresetEntries('Current')[0].content, 'unsaved live prompt');
  f.context.chatCompletionSettings.prompts = []; assert.deepEqual(f.json(f.sandbox.getPresetEntries('Current')), []);
});

test('official empty/deleted preset inventories never resurrect patched global entries', () => {
  const f = fixture(); f.state.names = {}; f.state.selected = ''; f.context.chatCompletionSettings = {};
  f.sandbox.preset_names = ['stale']; f.sandbox.presets = { stale: { prompts: [{ content: 'stale' }] } };
  assert.deepEqual(f.json(f.sandbox.listPresetNames()), []); assert.deepEqual(f.json(f.sandbox.getPresetEntries('stale')), []);
});

test('official persona settings take precedence over a previous global snapshot', () => {
  const f = fixture(); f.sandbox.power_user = { persona_description: 'stale USER' };
  assert.equal(f.sandbox.getPersonaDescription(), 'official USER'); assert.equal(f.sandbox.getPersonaName(), 'USER');
});

test('official world names include real filenames and avoid the incorrect legacy GET request', async () => {
  const f = fixture(); assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), ['Book file', 'settings']);
  assert.equal(f.calls.some(row => row[0] === 'fetch'), false);
  f.state.worlds = []; f.sandbox.world_names = ['stale']; assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), []);
});

test('official world loading uses the host cache and returns an independent copy rather than mutating ST entries', async () => {
  const f = fixture(); const rows = await f.sandbox.getWorldBookEntries('Book file'); assert.equal(rows[0]?.content, 'cached official');
  rows[0].extensions.keep = false; assert.equal(f.state.world.entries[0].extensions.keep, true); assert.equal(f.calls.some(row => row[0] === 'fetch'), false);
});

test('reading preset material cannot modify live host prompts or stored presets', () => {
  const f = fixture(); const current = f.sandbox.getPresetEntries('Current'), other = f.sandbox.getPresetEntries('Other');
  assert.equal(other[0]?.content, 'other preset'); current[0].content = 'modified local copy'; other[0].content = 'modified local copy';
  assert.equal(f.context.chatCompletionSettings.prompts[0].content, 'unsaved live prompt'); assert.equal(f.state.presets[1].prompts[0].content, 'other preset');
});

test('older host endpoint fallback uses POST and file_id instead of the worldbook display name', async () => {
  const f = fixture({ official: false }); f.state.response = [{ file_id: 'canonical-file', name: 'Display name', extensions: {} }, { file_id: 'settings', name: 'Another label' }];
  assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), ['canonical-file', 'settings']);
  const call = f.calls.find(row => row[0] === 'fetch'); assert.equal(call[1], '/api/worldinfo/list'); assert.equal(call[2].method, 'POST'); assert.equal(call[2].headers['X-CSRF-Token'], 'synthetic');
});

test('worldbook inventory does not become the bound set used for narrative injection', async () => {
  const f = fixture(); f.context.characters = [{ data: { extensions: { world: 'Bound' } } }]; f.context.characterId = 0;
  await f.sandbox.listWorldBooks(); assert.deepEqual(f.json(f.sandbox.detectBoundWorldBookNames()), ['Bound']);
});

test('legacy helper and globals remain read-only fallbacks only when official preset access is absent', () => {
  const f = fixture({ official: false }); f.context.chatCompletionSettings = {}; f.sandbox.oai_settings = { preset_settings: 'Legacy', presets: { Legacy: { prompts: [{ content: 'legacy prompt' }] } } };
  assert.equal(f.sandbox.getCurrentPresetName(), 'Legacy'); assert.ok(f.sandbox.listPresetNames().includes('Legacy')); assert.equal(f.sandbox.getPresetEntries('Legacy')[0].content, 'legacy prompt');
});

test('official methods that fail or are not initialized never fall back to a stale global snapshot', async () => {
  const f = fixture(); f.manager.getAllPresets = () => { throw Error('not ready'); }; f.manager.getCompletionPresetByName = () => { throw Error('not ready'); };
  f.context.loadWorldInfo = async () => { throw Error('temporary failure'); }; f.context.getWorldInfoNames = () => { throw Error('not ready'); };
  f.sandbox.world_names = ['stale']; f.sandbox.presets = { Other: { prompts: [{ content: 'stale' }] } };
  assert.deepEqual(f.json(f.sandbox.listPresetNames()), ['Current']); assert.deepEqual(f.json(f.sandbox.getPresetEntries('Other')), []);
  assert.deepEqual(f.json(await f.sandbox.getWorldBookEntries('Book file')), []); assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), []);
  assert.equal(f.calls.some(row => row[0] === 'fetch'), false);
});

test('official field fallback recognizes preset_settings_openai when the preset manager is not mounted', () => {
  const f = fixture(); f.context.getPresetManager = () => null; f.sandbox.oai_settings = { preset_settings: 'stale' };
  assert.equal(f.sandbox.getCurrentPresetName(), 'Current'); assert.deepEqual(f.json(f.sandbox.listPresetNames()), ['Current']);
  assert.deepEqual(f.json(f.sandbox.getPresetEntries('Other')), []);
});

test('readers do not cache preset/world/persona snapshots across a host context change', async () => {
  const f = fixture(); f.sandbox.getCurrentPresetName(); await f.sandbox.listWorldBooks();
  f.state.selected = 'Other'; f.state.worlds = ['Other account book']; f.context.powerUserSettings = { persona_description: 'new USER' };
  assert.equal(f.sandbox.getCurrentPresetName(), 'Other'); assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), ['Other account book']); assert.equal(f.sandbox.getPersonaDescription(), 'new USER');
});

test('fallback does not turn metadata keys, invalid IDs or file display aliases into worldbook names', async () => {
  const f = fixture({ official: false }); f.state.response = [{ file_id: '', name: 'do not guess' }, { file_id: 12, name: 'do not guess' }, null, { extensions: {} }, 'plain filename'];
  assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), ['plain filename']);
  f.state.response = { settings: { secret: 'synthetic' }, entries: [] }; assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), []);
});

test('legacy worldbook helper remains available only on hosts without official readers', async () => {
  const f = fixture({ official: false }); f.sandbox.fetch = async () => { throw Error('unavailable'); };
  f.sandbox.TavernHelper = { getWorldbookNames: async () => ['Legacy file'], getWorldbook: async () => [{ uid: 1, content: 'legacy world' }] };
  assert.deepEqual(f.json(await f.sandbox.listWorldBooks()), ['Legacy file']); assert.equal((await f.sandbox.getWorldBookEntries('Legacy file'))[0].content, 'legacy world');
});
