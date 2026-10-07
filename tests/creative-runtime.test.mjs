import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { hashText } from '../qianmu-storyboard-utils.js';
import { CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, validateCreativePlan } from '../qianmu-creative-contract.js';
import { upgradeCreativeDefaults, upgradeCreativeBlueprint, selectCreativeOptions, mergeCreativeRepair } from '../qianmu-creative-runtime.js';

const next = { systemPrompt: CREATIVE_SYSTEM_PROMPT, outputSchemaText: createCreativeSchema(), blueprint: CREATIVE_BLUEPRINT };
test('known defaults migrate, custom identity/schema/templates and backups survive repeated initialization', () => {
  const old = 'known installed default';
  const settings = { systemPrompt: old, appliedPromptDefaultHash: hashText(old), outputSchemaText: 'my schema',
    appliedSchemaDefaultHash: '__legacy__', systemPromptBackup: 'backup identity', outputSchemaBackup: 'backup schema',
    templates: [{ id: 'default-free-blueprint', content: 'my edited built-in' }, { id: 'mine', content: 'custom library' }] };
  upgradeCreativeDefaults(settings, next);
  assert.equal(settings.systemPrompt, next.systemPrompt);
  assert.equal(settings.outputSchemaText, 'my schema');
  assert.equal(settings.templates[0].content, 'my edited built-in');
  assert.equal(settings.templates[1].content, 'custom library');
  settings.systemPrompt = 'my new identity';
  upgradeCreativeDefaults(settings, next);
  assert.equal(settings.systemPrompt, 'my new identity');
  assert.equal(settings.systemPromptBackup, 'backup identity');
  assert.equal(settings.outputSchemaBackup, 'backup schema');
});
test('unknown older text is retained rather than guessing that it was a default', () => {
  const settings = { systemPrompt: 'unknown old prompt', outputSchemaText: 'unknown old schema' };
  upgradeCreativeDefaults(settings, next);
  assert.equal(settings.systemPrompt, 'unknown old prompt');
  assert.equal(settings.outputSchemaText, 'unknown old schema');
  const blank = {}; upgradeCreativeDefaults(blank, next);
  assert.equal(blank.systemPrompt, next.systemPrompt);
  assert.equal(blank.outputSchemaText, next.outputSchemaText);
});
test('chat blueprint marker never authorizes replacing edited or unknown text', () => {
  for (const edited of [true, false]) {
    const store = { blueprint: 'user work', blueprintEdited: edited, blueprintRevision: 0 };
    upgradeCreativeBlueprint(store, next.blueprint, 2);
    assert.equal(store.blueprint, 'user work');
  }
  const store = { blueprint: 'known older blueprint', appliedBlueprintDefaultHash: hashText('known older blueprint') };
  upgradeCreativeBlueprint(store, next.blueprint, 2);
  assert.equal(store.blueprint, next.blueprint);
});
test('interlude is selected once, supports non-speaker story characters, and cannot pick USER as owner', () => {
  let calls = 0;
  const input = { chat: [{ name: '用户别名', is_user: true }, { name: '陈警官', mes: '同事周青正在群聊里询问线索。' }],
    personaNames: ['本名'], characterName: '陈警官', sourceText: '手机 群聊', narrativeText: '周青正在群聊里询问线索。', random: () => { calls++; return .9; } };
  const options = selectCreativeOptions({}, input);
  assert.equal(calls, 1); assert.equal(options.interludeType, 'phone'); assert.ok(Object.isFrozen(options));
  assert.ok(options.personaNames.includes('用户别名'));
  assert.equal(options.eligiblePhoneOwners, undefined);
  assert.equal(options.phoneSourceText, input.narrativeText);
  const theater = selectCreativeOptions({}, { ...input, sourceText: '旧时客栈，众人围炉看戏。' });
  assert.equal(theater.interludeType, 'theater'); assert.equal(calls, 1);
  const off = selectCreativeOptions({ interludeEnabled: false }, input);
  assert.equal(off.interludeType, null); assert.equal(calls, 1);
});
test('repair adds only missing entries and clears resolved limitations without rewriting valid entries', () => {
  const first = { title: '已通过', description: '已有完整情境' };
  const plan = { quests: [first], limitations: [{ field: 'quests', missing: 4, reason: '材料未说明后续联系' }] };
  const additions = Array.from({ length: 6 }, (_, i) => ({ title: `补充${i}`, description: `独立情境${i}` }));
  mergeCreativeRepair(plan, { quests: additions, npc_updates: [{ name: '不在修复范围' }] }, [{ field: 'quests', missing: 4 }]);
  assert.equal(plan.quests.length, 5); assert.equal(plan.quests[0], first);
  assert.equal(plan.npc_updates, undefined); assert.deepEqual(plan.limitations, []);
});
test('range repair selects original valid entries; invalid selection cannot discard records', () => {
  const entries = Array.from({ length: 7 }, (_, i) => ({ name: `组织${i}`, agenda: `诉求${i}` }));
  const issue = { field: 'factions', excess: 1, max: 6, validIndices: entries.map((_, i) => i) };
  const plan = { factions: [...entries] };
  mergeCreativeRepair(plan, { keep_indices: { factions: [0, 1, 2, 3, 4, 4] } }, [issue]);
  assert.equal(plan.factions.length, 7);
  mergeCreativeRepair(plan, { keep_indices: { factions: [0, 1, 2, 3, 4, 6] } }, [issue]);
  assert.equal(plan.factions.length, 6); assert.equal(plan.factions.at(-1), entries[6]);
  assert.equal(entries.length, 7);
});
test('optional relation array and invalid cards can be repaired without touching good siblings', () => {
  const plan = { parallel_scene: { title: '另一幕', content: '已通过正文' }, interlude: null };
  const patch = { parallel_scene: { title: '禁止覆写', content: '不应替换' }, interlude: { type: 'theater', title: '戏台', content: '新片段' }, faction_relations: [] };
  mergeCreativeRepair(plan, patch, [{ field: 'interlude', missing: 1 }, { field: 'faction_relations', missing: 0 }]);
  assert.equal(plan.parallel_scene.title, '另一幕'); assert.equal(plan.interlude.title, '戏台'); assert.deepEqual(plan.faction_relations, []);
});

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
test('real world merger keeps full records and never advances or closes events by round count', () => {
  let id = 0;
  const sandbox = { uid: prefix => `${prefix}${++id}`, sanitizeEventStage: value => value || '酝酿',
    FACTION_TRENDS: ['rising', 'stable', 'declining', 'turbulent'], FACTION_SCALES: ['城邦内', '区域性', '跨区域', '全局性'], FACTION_RELATION_KINDS: ['同盟'] };
  vm.createContext(sandbox);
  vm.runInContext(between('function resolveFactionKey(', 'function buildPlanDigest('), sandbox);
  const long = '完整的过往与选择。'.repeat(50);
  const store = { factions: [{ id: 'old', name: '旧组织', agenda: long, trend: 'declining', scale: '全局性' }], worldEvents: [{ id: 'case', title: '未结案', stage: '酝酿', status: 'active', essence: long }] };
  sandbox.mergeGeopolitics(store, { world_events: [{ id: 'case', title: '未结案', stage: '酝酿', touched: 'advance', essence: long }] });
  assert.equal(store.worldEvents[0].stage, '酝酿'); assert.equal(store.worldEvents[0].essence, long);
  for (let round = 0; round < 20; round++) sandbox.mergeGeopolitics(store, {});
  assert.equal(store.factions.length, 1); assert.equal(store.factions[0].agenda, long);
  assert.equal(store.worldEvents[0].status, 'active');
  store.worldEvents[0].status = 'closed';
  sandbox.mergeGeopolitics(store, { factions: [{ id: 'unknown', name: '旧组织', standing: '仍在变动' }], world_events: [{ id: 'unknown', title: '未结案', content: '明确保留的完整局势' }] });
  assert.equal(store.factions.length, 1); assert.equal(store.factions[0].trend, 'declining'); assert.equal(store.factions[0].scale, '全局性');
  assert.equal(store.worldEvents.length, 1); assert.equal(store.worldEvents[0].status, 'closed'); assert.equal(store.worldEvents[0].essence, '明确保留的完整局势');
});
test('real injection includes CHAR dynamics but not fun, parallel or old review comments', () => {
  const sandbox = { settings: { injectSections: {}, geopoliticsEnabled: false }, snip: value => String(value || ''), INJ_LEN: {}, buildGeopoliticsDigest: () => '' };
  vm.createContext(sandbox);
  vm.runInContext(between('function buildPlanDigest(', '// 当前真正注入的文本'), sandbox);
  const text = sandbox.buildPlanDigest({ character_dynamics: [{ title: '夜班', content: '秦铎正在与同事重新核查证言。' }],
    npc_updates: [{ title: '门房', content: '门房拒收了那封来路不明的信。' }], relation_undercurrents: [{ parties: '甲、乙', content: '甲保留着尚未说明的顾虑。' }],
    parallel_scene: { content: 'PARALLEL_SECRET' }, interlude: { content: 'PHONE_SECRET' }, director_comment: ['OLD_COMMENT'] });
  assert.match(text, /此间一人/); assert.match(text, /重新核查证言/);
  assert.doesNotMatch(text, /PARALLEL_SECRET|PHONE_SECRET|OLD_COMMENT|导演系统/);
  assert.match(text, /门房拒收/); assert.match(text, /尚未说明的顾虑/);
  assert.match(sandbox.buildPlanDigest({ character_dynamics: [{ title: '未言', hidden_agenda: '保留调查的时间' }] }), /保留调查的时间/);
});

test('relation display preserves natural-language awareness, full tension, and escaped content aliases', () => {
  const sandbox = { htmlEscape: value => String(value ?? '').replaceAll('<', '&lt;'), renderDirectorWorldEntryLink: () => '' };
  vm.createContext(sandbox);
  const tail = source.slice(source.indexOf('function renderRelationUndercurrentsCard('));
  vm.runInContext(tail.slice(0, tail.indexOf('\nfunction ', 1)), sandbox);
  const content = '双方正在等待进一步的证据，暂未改变原有立场。'.repeat(12);
  const html = sandbox.renderRelationUndercurrentsCard({ relation_undercurrents: [{ parties: '<甲>、乙', content, tone: '关切与戒备并存', user_awareness: '只听说了最初的争执' }] });
  assert.ok(html.includes(content)); assert.match(html, /只听说了最初的争执/); assert.match(html, /&lt;甲>/);
  assert.match(html, /关切与戒备并存/);
});
