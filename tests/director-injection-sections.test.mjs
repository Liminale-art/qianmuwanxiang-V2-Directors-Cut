import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source extraction: ${start}`);
  return source.slice(a, b);
}
const injectSource = between('function buildPlanDigest(', 'function clearDirectorInjection(');
const renderSource = between('function renderInjectSections(', 'function renderInjectPreview(');
const toggleSource = between("  root.querySelectorAll('.sd-inject-section-toggle').forEach", '  // 自动推演开关');
const allOff = { quests: false, nodes: false, npc: false, relations: false, world: false, geopolitics: false };
const markers = ['QUEST_ONLY', 'RIPPLE_ONLY', 'CHAR_ONLY', 'NPC_ONLY', 'RELATION_ONLY', 'LEGACY_WORLD_ONLY', 'GEOPOLITICS_ONLY'];

function fixture() {
  const applied = [], store = {
    plan: {
      quests: [{ title: '来客', description: 'QUEST_ONLY' }],
      chain_reactions: [{ spark: '改道', chain: 'RIPPLE_ONLY' }],
      character_dynamics: [{ title: '交接', content: 'CHAR_ONLY' }],
      npc_updates: [{ name: '邻居', next_action: 'NPC_ONLY' }],
      relation_undercurrents: [{ parties: '甲乙', tension: 'RELATION_ONLY' }],
      world_chatter: [{ who: '铺主', text: 'DISPLAY_ONLY_CHATTER' }],
      parallel_scene: { content: 'DISPLAY_ONLY_PARALLEL' },
      interlude: { type: 'phone', content: 'DISPLAY_ONLY_PHONE' },
    },
    factions: [{ id: 'f1', name: '街坊会' }],
    worldEvents: [{ title: '道路修缮', stage: '展开', essence: 'GEOPOLITICS_ONLY', status: 'active' },
      { title: '已完工', essence: 'CLOSED_EVENT', status: 'closed' }],
  };
  const c = vm.createContext({
    settings: { enabled: true, injectEnabled: true, injectSections: { ...allOff }, geopoliticsEnabled: true, injectDepth: 2 },
    getChatStore: () => store, currentPlan: () => store.plan, INJ_LEN: {}, MODULE_NAME: 'qianmu',
    snip: value => String(value || ''), htmlEscape: value => String(value || ''),
    ctx: () => ({ chat: [], setExtensionPrompt: (...args) => applied.push(args) }), console,
  });
  vm.runInContext(injectSource + '\n' + renderSource, c);
  return { c, store, applied };
}

test('each injection switch owns only its actual source, including separate ripple and geopolitical events', () => {
  const { c, store } = fixture();
  store.plan.world_updates = [{ title: '历史世界条目', content: 'LEGACY_WORLD_ONLY' }];
  const before = JSON.stringify(store);
  const owned = { quests: ['QUEST_ONLY'], nodes: ['RIPPLE_ONLY'], npc: ['CHAR_ONLY', 'NPC_ONLY'],
    relations: ['RELATION_ONLY'], world: ['LEGACY_WORLD_ONLY'], geopolitics: ['GEOPOLITICS_ONLY'] };
  for (const [key, expected] of Object.entries(owned)) {
    c.settings.injectSections = { ...allOff, [key]: true };
    const text = c.buildPlanDigest(store.plan);
    for (const marker of markers) assert.equal(text.includes(marker), expected.includes(marker), `${key}: ${marker}`);
    assert.doesNotMatch(text, /DISPLAY_ONLY_|CLOSED_EVENT/);
  }
  c.settings.injectSections = { ...allOff, nodes: true, geopolitics: true };
  assert.match(c.buildPlanDigest(store.plan), /RIPPLE_ONLY[\s\S]*GEOPOLITICS_ONLY/);
  c.settings.geopoliticsEnabled = false;
  assert.match(c.buildPlanDigest(store.plan), /RIPPLE_ONLY/);
  assert.doesNotMatch(c.buildPlanDigest(store.plan), /GEOPOLITICS_ONLY/);
  assert.equal(JSON.stringify(store), before, 'reading injection never rewrites old plans or world archives');
});

test('new or empty plans do not render the retired world switch, even with unrelated world fields present', () => {
  const { c, store } = fixture();
  c.settings.injectSections.world = true;
  for (const legacy of [undefined, [], [{}], [{ title: '', content: '', timing: '' }]]) {
    store.plan.world_updates = legacy;
    store.plan.world_events = [{ title: '本轮事件', content: 'not the legacy world source' }];
    const html = c.renderInjectSections();
    assert.doesNotMatch(html, /data-key="world"|世界涟漪/);
    assert.match(html, /data-key="nodes"/); assert.match(html, /data-key="geopolitics"/);
    assert.equal(c.settings.injectSections.world, true, 'hidden legacy preference remains intact');
  }
  store.plan = null;
  assert.doesNotMatch(c.renderInjectSections(), /data-key="world"/);
});

test('historical world material exposes only its own old-version switch and honors its existing value', () => {
  const { c, store } = fixture();
  store.plan.world_updates = [{ title: '历史世界条目', content: 'LEGACY_WORLD_ONLY' }];
  let html = c.renderInjectSections();
  assert.match(html, /data-key="world" ><span>世界涟漪（旧版）/);
  assert.doesNotMatch(c.buildPlanDigest(store.plan), /LEGACY_WORLD_ONLY/);
  c.settings.injectSections.world = true;
  html = c.renderInjectSections();
  assert.match(html, /data-key="world" checked><span>世界涟漪（旧版）/);
  assert.match(c.buildPlanDigest(store.plan), /LEGACY_WORLD_ONLY/);
  delete c.settings.injectSections.world;
  assert.match(c.renderInjectSections(), /data-key="world" checked/);
  assert.match(c.buildPlanDigest(store.plan), /LEGACY_WORLD_ONLY/, 'legacy absent preference retains the established default');
});

test('actual category toggles update live injection independently and preserve custom or intentionally empty overrides', async () => {
  const { c, store, applied } = fixture();
  let handler, saves = 0, renders = 0;
  const element = { dataset: { key: 'nodes' }, checked: true, addEventListener: (_event, run) => { handler = run; } };
  Object.assign(c, { root: { querySelectorAll: selector => selector === '.sd-inject-section-toggle' ? [element] : [] },
    saveSettings: () => { saves++; }, renderModal: () => { renders++; }, activeTab: 'settings' });
  vm.runInContext(toggleSource, c);
  await handler();
  assert.match(applied.at(-1)[1], /RIPPLE_ONLY/); assert.doesNotMatch(applied.at(-1)[1], /GEOPOLITICS_ONLY/);
  element.dataset.key = 'geopolitics';
  await handler();
  assert.match(applied.at(-1)[1], /RIPPLE_ONLY[\s\S]*GEOPOLITICS_ONLY/);
  element.dataset.key = 'nodes'; element.checked = false;
  await handler();
  assert.doesNotMatch(applied.at(-1)[1], /RIPPLE_ONLY/); assert.match(applied.at(-1)[1], /GEOPOLITICS_ONLY/);
  for (const override of ['手动保留的正文引导', '']) {
    store.injectOverride = override;
    element.dataset.key = 'world'; element.checked = true;
    await handler();
    assert.equal(applied.at(-1)[1], override);
    assert.equal(store.injectOverride, override, 'scope changes do not silently discard manual editing');
  }
  assert.equal(saves, 5); assert.equal(renders, 5);
});
