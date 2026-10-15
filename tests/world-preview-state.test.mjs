import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { directorPreviewPlan, directorSectionEnabled } from '../qianmu-director-live.js';
import { sanitizeEventStage } from '../qianmu-storyboard-utils.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function fixture() {
  const store = { geoSeq: 7, factions: [{ id: 'saved', name: '旧档案哨兵' }], factionRelations: [], worldEvents: [] };
  const c = vm.createContext({ getChatStore: () => store, directorLiveLog: null, directorPreviewPlan, directorSectionEnabled, settings: { geopoliticsEnabled: true }, sanitizeEventStage,
    uid: () => { throw Error('Preview must not allocate a persistent identity'); } });
  const constants = ['FACTION_RELATION_KINDS', 'FACTION_TRENDS', 'FACTION_SCALES'].map(name => source.match(new RegExp(`^const ${name} = .+;`, 'm'))[0]).join('\n');
  vm.runInContext(constants + '\n' + ['resolveFactionKey', 'mergeGeopolitics', 'directorGeopoliticsState'].map(storyboardFunctionSource).join('\n'), c);
  return { c, store };
}
const plan = { factions: [{ id: 'a', name: '新商会', standing: '核对运单', trend: 'rising' }, { id: 'b', name: '新邻里会', agenda: '安排节庆' }],
  faction_relations: [{ between: ['a', '新邻里会'], kind: '同盟', note: '共同协调临时场地' }],
  world_events: [{ title: '码头改道', essence: '临时渡口开始接驳', stage: '蔓延' }] };

for (const status of ['loading', 'error', 'cancelled']) test(`${status}: closed world preview retains normal graph shapes without mutating saved state`, () => {
  const { c, store } = fixture(), before = JSON.stringify(store);
  c.directorLiveLog = { status, request: 'fixture', response: JSON.stringify(plan).slice(0, -1), creativeOptions: { geopoliticsEnabled: true } };
  const result = c.directorGeopoliticsState();
  assert.equal(result.readOnly, true);
  assert.equal(result.store.factions.length, 2);
  assert.ok(!JSON.stringify(result).includes('旧档案哨兵'));
  assert.equal(result.store.factionRelations.length, 1);
  const ids = new Set(result.store.factions.map(f => f.id));
  assert.ok(ids.has(result.store.factionRelations[0].a) && ids.has(result.store.factionRelations[0].b));
  assert.equal(result.store.worldEvents[0].stage, '蔓延');
  assert.equal(JSON.stringify(c.directorGeopoliticsState()), JSON.stringify(result), 'stable display IDs on re-render');
  assert.equal(JSON.stringify(store), before);
  assert.equal(JSON.stringify(plan.factions[0]), '{"id":"a","name":"新商会","standing":"核对运单","trend":"rising"}');
});

test('loading waits for complete cards, success/no-output failure/reopen return the saved archive', () => {
  const { c, store } = fixture();
  c.directorLiveLog = { status: 'loading', request: 'fixture', response: '{"factions":[{"name":"未闭合' };
  assert.equal(c.directorGeopoliticsState().store.factions.length, 0);
  assert.equal(c.directorGeopoliticsState().readOnly, true);
  for (const log of [null, { status: 'success', response: JSON.stringify(plan) }, { status: 'error', request: 'fixture', response: '' }]) {
    c.directorLiveLog = log;
    assert.equal(c.directorGeopoliticsState().store, store);
    assert.equal(c.directorGeopoliticsState().readOnly, false);
  }
});

test('disabled world output is not promoted into a visible live map', () => {
  const { c, store } = fixture(), before = JSON.stringify(store);
  c.directorLiveLog = { status: 'loading', request: 'fixture', response: JSON.stringify(plan), creativeOptions: { geopoliticsEnabled: false } };
  const state = c.directorGeopoliticsState();
  assert.equal(state.readOnly, true);
  assert.equal(state.store.factions.length, 0);
  assert.equal(state.store.worldEvents.length, 0);
  assert.equal(JSON.stringify(store), before);
});

test('render and interaction use the same normal map data source; live edges repaint without replacing controls', () => {
  const renderer = storyboardFunctionSource('renderGeopoliticsTab');
  assert.doesNotMatch(renderer, /renderDirectorLive/);
  assert.match(renderer, /directorGeopoliticsState\(\)/);
  assert.match(renderer, /readOnly \? '' : '<button[^\n]*sd-geo-clear/);
  assert.match(storyboardFunctionSource('bindGeopoliticsTabEvents'), /const \{ store \} = directorGeopoliticsState\(\)/);
  const refresh = storyboardFunctionSource('refreshDirectorLiveUI');
  assert.match(refresh, /classList\.toggle\('has-content'/);
  assert.match(refresh, /worldBody && worldPage === 'geopolitics'\) bindGeopoliticsTabEvents\(host\)/);
});
