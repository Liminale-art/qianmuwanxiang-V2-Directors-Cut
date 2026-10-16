import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { htmlEscape, geoStableHash, geoRelationLabel } from '../qianmu-storyboard-utils.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const context = vm.createContext({
  htmlEscape, geoStableHash, geoRelationLabel,
  geoRelationKindsSelected: () => ['同盟', '冲突', '依附'],
  GEO_TREND_ICON: { stable: '＝' }, GEO_TREND_CN: { stable: '稳守' },
});
vm.runInContext(['renderFactionDossierBody', 'renderFactionListView'].map(storyboardFunctionSource).join('\n'), context);
const factions = [
  { id: 'a', name: '沿岸港口商会', type: '商业组织', scale: '区域性', standing: '长篇当下事实'.repeat(20), agenda: '需要维持的独立诉求', clues: ['第一条线索', '第二条完整线索'] },
  { id: 'b', name: '林地联盟', trend: 'stable' },
];
const relations = [
  { a: 'a', b: 'b', kind: '同盟', note: '长篇关系说明'.repeat(20) },
  { a: 'b', b: 'a', kind: '依附', note: '反向依附' },
  { a: 'a', b: 'b', kind: '张力', note: '筛选隐藏但记录保留' },
];

test('map and list share full prose while clues remain exclusively in the star-map bubbles', () => {
  const list = context.renderFactionDossierBody(factions[0], factions, relations);
  const map = context.renderFactionDossierBody(factions[0], factions, relations, 'map');
  assert.equal(map.replaceAll(/sd-geo-d-rel(?=[ "])/g, 'sd-geo-list-rel'), list);
  for (const text of [factions[0].standing, factions[0].agenda, ...relations.map((r) => r.note)]) assert.ok(map.includes(text), text);
  for (const text of factions[0].clues) assert.ok(!map.includes(text), text);
  assert.doesNotMatch(map, /sd-geo-dossier-clues|<h5>线索/);
  assert.deepEqual(factions[0].clues, ['第一条线索', '第二条完整线索']);
  assert.match(storyboardFunctionSource('renderFactionStarMap'), /f\.clues/);
  assert.match(map, /sd-geo-dossier-relation-head[^]*<strong>林地联盟<\/strong><span class="sd-geo-d-kind">协作<\/span><\/div>\s*<p class="sd-geo-d-rtext">/);
  assert.match(map, /林地联盟 依赖于此/);
  assert.match(map, /sd-kind-hidden" data-kind="张力"/);
  assert.match(map, /sd-geo-d-kind">协作<\/span>/);
});

test('dossier content is escaped and empty sections do not produce placeholder cards', () => {
  const minimal = context.renderFactionDossierBody({ id: 'a' }, factions, []);
  assert.doesNotMatch(minimal, /<section|暂无|sd-geo-d-meta/);
  const unsafe = context.renderFactionDossierBody({ ...factions[0], standing: '<script>unsafe()</script>', clues: ['<img src=x onerror=x>'] }, factions, []);
  assert.doesNotMatch(unsafe, /<script|<img/);
  assert.match(unsafe, /&lt;script&gt;/);
});

test('list keeps stable accordion identifiers and delegates its content to the shared dossier', () => {
  const html = context.renderFactionListView(factions, relations);
  assert.match(html, /data-acc="geo-list-a"/);
  assert.match(html, /data-acc="geo-list-b"/);
  assert.match(storyboardFunctionSource('renderFactionListView'), /renderFactionDossierBody\(f, factions, rels\)/);
  assert.match(storyboardFunctionSource('bindGeopoliticsTabEvents'), /renderFactionDossierBody\(f, factions, rels, 'map'\)/);
  assert.doesNotMatch(source, /桩进行中/);
  assert.match(html, /sd-geo-unit-title"><strong>林地联盟<\/strong><span class="sd-geo-d-trend/);
  assert.match(storyboardFunctionSource('bindGeopoliticsTabEvents'), /sd-geo-unit-title"><h4>\$\{htmlEscape\(f\.name\)\}<\/h4>\$\{trendChip\}/);
});

test('world edge cue only invites entry from the front while return controls remain available', () => {
  const edges = vm.createContext({ getChatStore: () => ({ factions }), settings: { geopoliticsEnabled: true }, worldPage: 'front', directorLiveLog: null, directorPreviewPlan: () => null });
  vm.runInContext(storyboardFunctionSource('directorGeopoliticsState'), edges);
  vm.runInContext(storyboardFunctionSource('renderWorldPageEdges'), edges);
  assert.equal((edges.renderWorldPageEdges().match(/has-content/g) || []).length, 2);
  edges.worldPage = 'geopolitics';
  assert.doesNotMatch(edges.renderWorldPageEdges(), /has-content/);
  assert.equal((edges.renderWorldPageEdges().match(/aria-label="返回世界正面"/g) || []).length, 2);
  edges.settings.geopoliticsEnabled = false;
  assert.ok(edges.renderWorldPageEdges());
  edges.worldPage = 'front';
  assert.equal(edges.renderWorldPageEdges(), '');
});
