import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { hashText } from '../qianmu-storyboard-utils.js';
import { CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema, validateCreativePlan, pruneInvalidCreativeItems, projectCreativeContinuity } from '../qianmu-creative-contract.js';
import { upgradeCreativeDefaults, upgradeCreativeBlueprint, selectCreativeOptions, recentInterludeHint, mergeCreativeRepair } from '../qianmu-creative-runtime.js';
import { directorSectionStatus } from '../qianmu-director-live.js';

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
test('exact v443 fingerprints upgrade markerless defaults without matching edited identity or schema', () => {
  // The fingerprints were measured from the shipped v443 strings. Stub only the
  // hash input here so this regression need not bundle another retired prompt.
  const fingerprints = { 'v443-system': '91ad6303', 'v443-schema': '1bc3cd38' };
  const sandbox = { hashText: value => fingerprints[value] || hashText(value) };
  vm.createContext(sandbox);
  const runtime = fs.readFileSync(new URL('../qianmu-creative-runtime.js', import.meta.url), 'utf8');
  vm.runInContext(runtime.replace(/^import .+;\r?$/gm, '').replace(/^export /gm, ''), sandbox);
  for (const marker of [undefined, '__legacy__']) {
    const settings = { systemPrompt: 'v443-system', outputSchemaText: 'v443-schema', appliedPromptDefaultHash: marker,
      appliedSchemaDefaultHash: marker, systemPromptBackup: 'user backup', outputSchemaBackup: 'format backup' };
    sandbox.upgradeCreativeDefaults(settings, next);
    assert.equal(settings.systemPrompt, next.systemPrompt);
    assert.equal(settings.outputSchemaText, next.outputSchemaText);
    assert.equal(settings.systemPromptBackup, 'user backup');
    assert.equal(settings.outputSchemaBackup, 'format backup');
    settings.systemPrompt = 'v443-system with a user edit';
    settings.outputSchemaText = 'v443-schema with a user edit';
    sandbox.upgradeCreativeDefaults(settings, next);
    assert.equal(settings.systemPrompt, 'v443-system with a user edit');
    assert.equal(settings.outputSchemaText, 'v443-schema with a user edit');
  }
});

test('exact v444 fingerprints upgrade prompt, schema and built-in blueprint without replacing edits', () => {
  const fingerprints = { 'v444-system': 'a4c1bafd', 'v444-schema': '241c5ebc', 'v444-blueprint': '1d95c305' };
  const sandbox = { hashText: value => fingerprints[value] || hashText(value) };
  vm.createContext(sandbox);
  const runtime = fs.readFileSync(new URL('../qianmu-creative-runtime.js', import.meta.url), 'utf8');
  vm.runInContext(runtime.replace(/^import .+;\r?$/gm, '').replace(/^export /gm, ''), sandbox);
  for (const marker of [undefined, '__legacy__']) {
    const settings = { systemPrompt: 'v444-system', outputSchemaText: 'v444-schema', appliedPromptDefaultHash: marker,
      appliedSchemaDefaultHash: marker, systemPromptBackup: 'old manual draft', outputSchemaBackup: 'old manual format',
      templates: [{ id: 'default-free-blueprint', content: 'v444-blueprint' }, { id: 'mine', content: 'v444-blueprint' }] };
    sandbox.upgradeCreativeDefaults(settings, next);
    assert.equal(settings.systemPrompt, next.systemPrompt);
    assert.equal(settings.outputSchemaText, next.outputSchemaText);
    assert.equal(settings.templates[0].content, next.blueprint);
    assert.equal(settings.templates[1].content, 'v444-blueprint');
    assert.equal(settings.systemPromptBackup, 'old manual draft');
    assert.equal(settings.outputSchemaBackup, 'old manual format');
    const store = { blueprint: 'v444-blueprint', appliedBlueprintDefaultHash: marker };
    sandbox.upgradeCreativeBlueprint(store, next.blueprint, 445);
    assert.equal(store.blueprint, next.blueprint);
    const edited = { systemPrompt: 'v444-system with an edit', outputSchemaText: 'v444-schema with an edit',
      templates: [{ id: 'default-free-blueprint', content: 'v444-blueprint with an edit' },
        { id: 'default-free-blueprint', content: 'v444-blueprint', edited: true }] };
    const original = structuredClone(edited);
    sandbox.upgradeCreativeDefaults(edited, next);
    assert.equal(edited.systemPrompt, original.systemPrompt);
    assert.equal(edited.outputSchemaText, original.outputSchemaText);
    assert.deepEqual(edited.templates, original.templates);
    const customStore = { blueprint: 'v444-blueprint with an edit', appliedBlueprintDefaultHash: '1d95c305' };
    sandbox.upgradeCreativeBlueprint(customStore, next.blueprint, 445);
    assert.equal(customStore.blueprint, 'v444-blueprint with an edit');
  }
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
  const forum = selectCreativeOptions({}, { ...input, sourceText: '旧时客栈，众人围炉看戏。' });
  assert.equal(forum.interludeType, 'forum'); assert.equal(calls, 1);
  const off = selectCreativeOptions({ interludeEnabled: false }, input);
  assert.equal(off.interludeType, null); assert.equal(calls, 1);
  const noSpeakerLabel = selectCreativeOptions({}, { chat: [], sourceText: '手机可用', narrativeText: '小余刚把发酵缸洗净。她的手机又响了。', random: () => .9 });
  assert.equal(noSpeakerLabel.interludeType, 'phone', 'prose-only supporting characters are not excluded by chat speaker labels');
  const noNarrative = selectCreativeOptions({}, { chat: [{ name: '陈警官' }], sourceText: '手机', random: () => .9 });
  assert.equal(noNarrative.interludeType, 'forum', 'a speaker label alone cannot prove a story owner');
});

test('character scope accepts multiple confirmed CHARs, excludes USER, and respects an unavailable group scope', () => {
  const options = selectCreativeOptions({}, { characterName: '群聊显示名', characterNames: [' 陈警官 ', '林医生', '陈警官', '玩家'], personaNames: ['玩家'] });
  assert.deepEqual(options.characterNames, ['陈警官', '林医生']);
  assert.deepEqual(selectCreativeOptions({}, { characterName: '陈警官' }).characterNames, ['陈警官']);
  assert.deepEqual(selectCreativeOptions({}, { characterName: '群聊显示名', characterNames: [] }).characterNames, []);
  assert.deepEqual(selectCreativeOptions({}, { characterName: '玩家', personaNames: ['玩家'] }).characterNames, []);
});
test('repair adds only missing entries and clears resolved limitations without rewriting valid entries', () => {
  const first = { subject: '街坊', title: '已通过', description: '已有完整情境' };
  const plan = { quests: [first], limitations: [{ field: 'quests', missing: 4, reason: '材料未说明后续联系' }] };
  const additions = Array.from({ length: 6 }, (_, i) => ({ subject: '街坊', title: `补充${i}`, description: `独立情境${i}` }));
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

test('relation display removes awareness decoration while preserving full tension and escaped aliases', () => {
  const sandbox = { directorSectionStatus, htmlEscape: value => String(value ?? '').replaceAll('<', '&lt;'), renderDirectorWorldEntryLink: () => '' };
  vm.createContext(sandbox);
  const notice = source.slice(source.indexOf('function renderDirectorSectionNotice('));
  vm.runInContext(notice.slice(0, notice.indexOf('\nfunction ', 1)), sandbox);
  const tail = source.slice(source.indexOf('function renderRelationUndercurrentsCard('));
  vm.runInContext(tail.slice(0, tail.indexOf('\nfunction ', 1)), sandbox);
  const content = '双方正在等待进一步的证据，暂未改变原有立场。'.repeat(12);
  const html = sandbox.renderRelationUndercurrentsCard({ relation_undercurrents: [{ parties: '<甲>、乙', content, tone: '关切与戒备并存', user_awareness: '只听说了最初的争执' }] });
  assert.ok(html.includes(content)); assert.doesNotMatch(html, /只听说了最初的争执/); assert.match(html, /&lt;甲>/);
  assert.match(html, /关切与戒备并存/);
});

test('exact v445 defaults migrate to v446 while edited defaults, templates and backups survive', () => {
  const fingerprints = { 'v445-system': '39271a80', 'v445-schema': '3826d107', 'v445-blueprint': '261d4a1a' };
  const sandbox = { hashText: value => fingerprints[value] || hashText(value) };
  vm.createContext(sandbox);
  const runtime = fs.readFileSync(new URL('../qianmu-creative-runtime.js', import.meta.url), 'utf8');
  vm.runInContext(runtime.replace(/^import .+;\r?$/gm, '').replace(/^export /gm, ''), sandbox);
  for (const marker of [undefined, '__legacy__']) {
    const settings = { systemPrompt: 'v445-system', outputSchemaText: 'v445-schema', appliedPromptDefaultHash: marker,
      appliedSchemaDefaultHash: marker, systemPromptBackup: 'manual backup', outputSchemaBackup: 'manual format',
      templates: [{ id: 'default-free-blueprint', content: 'v445-blueprint' }, { id: 'mine', content: 'v445-blueprint' }] };
    sandbox.upgradeCreativeDefaults(settings, next);
    assert.equal(settings.systemPrompt, next.systemPrompt); assert.equal(settings.outputSchemaText, next.outputSchemaText);
    assert.equal(settings.templates[0].content, next.blueprint); assert.equal(settings.templates[1].content, 'v445-blueprint');
    assert.equal(settings.systemPromptBackup, 'manual backup'); assert.equal(settings.outputSchemaBackup, 'manual format');
    const store = { blueprint: 'v445-blueprint', appliedBlueprintDefaultHash: marker };
    sandbox.upgradeCreativeBlueprint(store, next.blueprint, 446); assert.equal(store.blueprint, next.blueprint);
    const custom = { systemPrompt: 'v445-system edited', outputSchemaText: 'v445-schema edited', templates: [{ id: 'default-free-blueprint', content: 'v445-blueprint edited' }] };
    sandbox.upgradeCreativeDefaults(custom, next);
    assert.equal(custom.systemPrompt, 'v445-system edited'); assert.equal(custom.outputSchemaText, 'v445-schema edited');
    assert.equal(custom.templates[0].content, 'v445-blueprint edited');
  }
});

test('nested direction repairs keep anchors and valid entries, selecting excess without rewrites', () => {
  const first = { horizon: 'near', title: '来信', content: '送信人按约敲门。' };
  const second = { horizon: 'far', title: '另一条路', content: '数周后另一个条件可能变化。' };
  const plan = { story_status: { title: '原标题', current_arc: '原主线', cycle: '仲夏', directions: [first] } };
  mergeCreativeRepair(plan, { story_status: { title: '不应覆写', directions: [second, { title: '多余', content: '不应加上' }] } }, [{ field: 'story_status', missing: 1 }]);
  assert.deepEqual(plan.story_status, { title: '原标题', current_arc: '原主线', cycle: '仲夏', directions: [first, second] });
  assert.equal(plan.story_status.directions[0], first);
  const third = { title: '第三', content: '三' }, fourth = { title: '第四', content: '四' };
  plan.story_status.directions.push(third, fourth);
  const issue = { field: 'story_status', excess: 1, max: 3, validIndices: [0, 1, 2, 3] };
  mergeCreativeRepair(plan, { keep_indices: { story_status: [0, 1, 1] } }, [issue]);
  assert.equal(plan.story_status.directions.length, 4);
  mergeCreativeRepair(plan, { keep_indices: { story_status: [0, 2, 3] } }, [issue]);
  assert.deepEqual(plan.story_status.directions, [first, third, fourth]);
  assert.equal(plan.story_status.title, '原标题');
});

test('duplicate horizons are repaired by adding the missing horizon without rewriting the valid prose', () => {
  const near = { horizon: 'near', title: '等船', content: '茶摊老板把钥匙留给了送信人。' };
  const sourcePlan = { story_status: { cycle: '傍晚', directions: [near, { horizon: 'near', title: '等信', content: '这一近线不能顶替远线。' }] } };
  const options = { interludeEnabled: false, parallelSceneEnabled: false };
  const { plan } = pruneInvalidCreativeItems(sourcePlan, options);
  const issues = validateCreativePlan(plan, options).filter(issue => issue.field === 'story_status');
  assert.equal(issues[0].missing, 1);
  const far = { horizon: 'far', title: '渡口易主', content: '租期届满后，旧日托付改变了渡口接班人的选择。' };
  mergeCreativeRepair(plan, { story_status: { directions: [far] } }, issues, options);
  assert.deepEqual(plan.story_status.directions, [near, far]);
  assert.equal(plan.story_status.cycle, '傍晚');
  assert.ok(!validateCreativePlan(plan, options).some(issue => issue.field === 'story_status'));
  assert.equal(sourcePlan.story_status.directions.length, 2);
});

test('a full direction patch skips a repeated valid horizon and malformed additions before filling the missing horizon', () => {
  const near = { horizon: 'near', title: '旧信', content: '送信人在茶摊门前取回了钥匙。' };
  const far = { horizon: 'far', title: '故人归来', content: '旧信辗转到港口，改变了返乡人的航程。' };
  const plan = { story_status: { cycle: '晚秋', directions: [near] } };
  const options = { interludeEnabled: false, parallelSceneEnabled: false };
  const issues = validateCreativePlan(plan, options).filter(issue => issue.field === 'story_status');
  const additions = [
    { horizon: 'near', title: '试图改写', content: '已有近线不能被这个覆盖。' },
    { horizon: 'far', title: '缺内容' },
    { horizon: 'far', title: '重复正文', content: near.content },
    far,
  ];
  mergeCreativeRepair(plan, { story_status: { directions: additions } }, issues, options);
  assert.deepEqual(plan.story_status.directions, [near, far]);
  assert.equal(plan.story_status.directions[0], near);
  assert.equal(plan.story_status.cycle, '晚秋');
  assert.ok(!validateCreativePlan(plan, options).some(issue => issue.field === 'story_status'));
});

test('prior interlude supplies only a bounded nonfactual variety hint, separate from mainline continuity', () => {
  const previousInterlude = { type: 'forum', title: '上轮话题', posts: [{ content: '首帖 '.repeat(100), replies: [{ content: 'PRIVATE_REPLY' }] }, { content: 'SECOND_POST' }], extra: 'UNKNOWN_FIELD' };
  const hint = recentInterludeHint(previousInterlude);
  assert.deepEqual(Object.keys(JSON.parse(hint)), ['type', 'title', 'first_excerpt']);
  assert.equal(JSON.parse(hint).first_excerpt.length, 180);
  assert.doesNotMatch(hint, /PRIVATE_REPLY|SECOND_POST|UNKNOWN_FIELD/);
  const options = selectCreativeOptions({ newcomerMode: true }, { previousInterlude });
  assert.equal(options.interludeType, 'forum'); assert.equal(options.newcomerMode, true); assert.equal(options.recentInterludeHint, hint);
  const guide = creativeSectionGuidance(options);
  assert.match(guide, /不是事实来源、主线线索或续写指令/); assert.ok(guide.includes(hint));
  assert.deepEqual(projectCreativeContinuity({ interlude: previousInterlude, recentInterludeHint: hint }), { reference_kind: 'candidate_reference' });
  const off = selectCreativeOptions({ interludeEnabled: false }, { previousInterlude });
  assert.equal(off.recentInterludeHint, ''); assert.ok(!creativeSectionGuidance(off).includes(hint));
  for (const value of [null, undefined, {}, [], { type: 'forum', posts: [] }]) assert.equal(recentInterludeHint(value), '');
  assert.match(recentInterludeHint({ type: 'phone', title: '旧手机', messages: [{ content: '首条消息' }, { content: '不可复制整段对话' }] }), /首条消息/);
  const phoneHint = recentInterludeHint({ type: 'phone', title: '下班不接电话', owner: '旧主人'.repeat(100), messages: [{ content: '首条消息' }], private: '不可带出' });
  assert.equal(JSON.parse(phoneHint).owner.length, 60);
  assert.doesNotMatch(phoneHint, /不可带出/);
  assert.match(creativeSectionGuidance({ interludeType: 'phone', recentInterludeHint: phoneHint }), /不把换人当作硬凑陌生人的理由/);
});

test('exact v446 fingerprints migrate to v447 without replacing edited defaults, templates or backups', () => {
  const fingerprints = { 'v446-system': 'bba2effb', 'v446-schema': '51ab8d18', 'v446-blueprint': '1d8cdeb6' };
  const sandbox = { hashText: value => fingerprints[value] || hashText(value) };
  vm.createContext(sandbox);
  const runtime = fs.readFileSync(new URL('../qianmu-creative-runtime.js', import.meta.url), 'utf8');
  vm.runInContext(runtime.replace(/^import .+;\r?$/gm, '').replace(/^export /gm, ''), sandbox);
  for (const marker of [undefined, '__legacy__']) {
    const settings = { systemPrompt: 'v446-system', outputSchemaText: 'v446-schema', appliedPromptDefaultHash: marker,
      appliedSchemaDefaultHash: marker, systemPromptBackup: 'manual draft', outputSchemaBackup: 'manual format',
      templates: [{ id: 'default-free-blueprint', content: 'v446-blueprint' }, { id: 'mine', content: 'v446-blueprint' }] };
    sandbox.upgradeCreativeDefaults(settings, next);
    assert.equal(settings.systemPrompt, next.systemPrompt);
    assert.equal(settings.outputSchemaText, next.outputSchemaText);
    assert.equal(settings.templates[0].content, next.blueprint);
    assert.equal(settings.templates[1].content, 'v446-blueprint');
    assert.equal(settings.systemPromptBackup, 'manual draft');
    assert.equal(settings.outputSchemaBackup, 'manual format');
    const store = { blueprint: 'v446-blueprint', appliedBlueprintDefaultHash: marker };
    sandbox.upgradeCreativeBlueprint(store, next.blueprint, 447);
    assert.equal(store.blueprint, next.blueprint);
    const edited = { systemPrompt: 'v446-system edited', outputSchemaText: 'v446-schema edited',
      templates: [{ id: 'default-free-blueprint', content: 'v446-blueprint edited' }, { id: 'default-free-blueprint', content: 'v446-blueprint', edited: true }] };
    const original = structuredClone(edited);
    sandbox.upgradeCreativeDefaults(edited, next);
    assert.equal(edited.systemPrompt, original.systemPrompt); assert.equal(edited.outputSchemaText, original.outputSchemaText);
    assert.deepEqual(edited.templates, original.templates);
    const customStore = { blueprint: 'v446-blueprint edited', appliedBlueprintDefaultHash: '1d8cdeb6' };
    sandbox.upgradeCreativeBlueprint(customStore, next.blueprint, 447);
    assert.equal(customStore.blueprint, 'v446-blueprint edited');
  }
});
