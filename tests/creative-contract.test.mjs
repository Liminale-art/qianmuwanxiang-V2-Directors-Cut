import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCreativeSchema, normalizeCreativeSections, validateCreativePlan,
  pruneInvalidCreativeItems, projectCreativeContinuity,
} from '../qianmu-creative-contract.js';
import { CREATIVE_COUNTS } from '../qianmu-creative-prompts.js';

const OFF = Object.freeze({ interludeEnabled: false, parallelSceneEnabled: false });
const FULL = Object.freeze({ worldChatterEnabled: true, geopoliticsEnabled: true, interludeType: 'phone', personaNames: ['访客', 'Guest'], eligiblePhoneOwners: ['阿岚', '老周'] });
const items = (field, make) => Array.from({ length: CREATIVE_COUNTS[field].min }, (_, i) => make(i));
function complete(options = FULL) {
  const result = {
    story_status: { title: '街角的新日子', directions: items('story_status', i => ({ horizon: i ? 'far' : 'near', title: `脉络${i}`, content: `第${i}片旧城的工会改制会逐步影响下一季的工作选择。` })) },
    quests: items('quests', i => ({ subject: `店铺${i}`, title: `来信${i}`, description: `第${i}家店铺的伙计带来了未取的回信，正等人认领。`, trigger: '听见招呼后可以询问' })),
    character_dynamics: items('character_dynamics', i => ({ title: `抉择${i}`, content: `阿岚把第${i}份旧账暂存在抽屉，打算核清出处后再归还。` })),
    npc_updates: items('npc_updates', i => ({ name: `邻居${i}`, current_goal: `要赶在第${i}次班车离开前把旧物交到失主手中。`, next_action: `向第${i}位门卫问路。` })),
    chain_reactions: items('chain_reactions', i => ({ spark: `第${i}条道路延期修整`, chain: `第${i}家送货铺收到改道通知 → 掌柜延迟发车 → 当天的菜贩调整供货计划` })),
    relation_undercurrents: items('relation_undercurrents', i => ({ parties: [`店主${i}`, `邻居${i}`], tension: `第${i}张借条仍没有拿出来，两人避开了还款日期。` })),
    limitations: [],
  };
  if (options.worldChatterEnabled) result.world_chatter = items('world_chatter', i => ({ text: `第${i}间早餐铺老板掀开蒸笼，招呼伙计添柴。`, who: `铺主${i}`, where: `巷口${i}` }));
  if (options.geopoliticsEnabled) {
    result.factions = items('factions', i => ({ id: `f${i}`, name: `行会${i}`, agenda: `商议第${i}片码头的装卸时限。`, standing: '此前的协议仍有效。', clues: ['布告栏贴出新的值班安排。'] }));
    result.faction_relations = [];
    result.world_events = items('world_events', i => ({ id: `e${i}`, title: `议价${i}`, essence: `第${i}个街区的租约仍在协商，短工先沿用上月工钱。`, status: 'active', touched: 'idle', stage: '酝酿' }));
  }
  if (options.parallelSceneEnabled !== false) result.parallel_scene = { title: '若赶上了那趟车', content: '那次没有误车，他在空座旁重新见到了旧友。' };
  if (options.interludeEnabled !== false) result.interlude = options.interludeType === 'phone'
    ? { type: 'phone', title: '早班群里', owner: '阿岚', conversation_kind: 'group', messages: Array.from({ length: 6 }, (_, i) => ({ sender: i % 2 ? '阿岚' : '老周', content: `第${i}件小事得商量一下。`, time: `08:0${i}` })) }
    : { type: 'forum', title: '街坊的告示板', posts: Array.from({ length: 3 }, (_, i) => ({ author: `街坊${i}`, handle: `小院${i}`, content: `第${i}件日常发现`, time: `午后${i}时`, replies: [{ author: '茶摊老板', content: '待会来看看。' }] })) };
  return result;
}
const parseShape = schema => {
  const start = schema.indexOf('{\n'), end = schema.indexOf('\n\n', start);
  return JSON.parse(schema.slice(start, end));
};

test('schema preserves stable fields, count source, enabled world shapes and one fixed card form', () => {
  const schema = createCreativeSchema(FULL), shape = parseShape(schema);
  for (const key of ['story_status', 'quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents', 'world_chatter', 'factions', 'faction_relations', 'world_events', 'parallel_scene', 'interlude', 'limitations']) assert.ok(Object.hasOwn(shape, key), key);
  assert.equal(shape.interlude.type, 'phone');
  assert.equal(typeof shape.story_status.cycle, 'string');
  assert.match(shape.story_status.cycle, /In-story date or time period/);
  assert.match(shape.story_status.directions[0].title, /anchored to a concrete upcoming time window/);
  assert.match(shape.story_status.directions[0].content, /verifiable new condition/);
  assert.match(shape.story_status.directions[1].content, /setup\/payoff or side-character life/);
  assert.match(shape.factions[0].trend, /rising\/stable\/declining\/turbulent/);
  assert.match(shape.factions[0].scale, /城邦内\/区域性\/跨区域\/全局性/);
  assert.doesNotMatch(schema, /world_updates|director_comment|至少1桩跨地域|孤点至多|唯变是传/);
  assert.match(schema, /阿岚/);
  assert.match(schema, /老周/);
  for (const [field, quota] of Object.entries(CREATIVE_COUNTS)) assert.match(schema, new RegExp(`${field} \\([^\n]+${quota.min}`));
  assert.deepEqual(Object.keys(shape.quests[0]), ['subject', 'title', 'description', 'trigger', 'inject_prompt']);
  assert.deepEqual(Object.keys(shape.story_status), ['title', 'current_arc', 'cycle', 'directions']);
  assert.deepEqual(shape.story_status.directions.map(item => item.horizon), ['near', 'far']);
  assert.match(shape.quests[0].trigger, /standalone narrative sentence/i);
  assert.match(shape.quests[0].inject_prompt, /prose, not an instruction/);
  assert.match(shape.interlude.title, /actual group name/);
  assert.ok(!Object.hasOwn(shape.parallel_scene, 'title'));
  assert.ok(!Object.hasOwn(shape.relation_undercurrents[0], 'user_awareness'));
});

test('schema defaults new cards on without silently selecting a type, keeps old world options off', () => {
  const shape = parseShape(createCreativeSchema());
  assert.ok(shape.parallel_scene);
  assert.ok(shape.interlude);
  assert.equal(shape.interlude.type, 'Selected for this run: forum or phone');
  for (const field of ['world_chatter', 'factions', 'world_events', 'faction_relations']) assert.ok(!Object.hasOwn(shape, field));
  const off = parseShape(createCreativeSchema(OFF));
  assert.ok(!Object.hasOwn(off, 'parallel_scene'));
  assert.ok(!Object.hasOwn(off, 'interlude'));
});

test('English output protocol keeps narrative language, Chinese enums and established contract boundaries', () => {
  const schema = createCreativeSchema(FULL), shape = parseShape(schema);
  assert.match(schema, /Write narrative text in the current chat's language; default to Chinese when no language is established/);
  assert.match(schema, /English instructions and field descriptions do not require English story output/);
  assert.match(schema, /Preserve JSON keys and enum values exactly/);
  assert.equal(shape.faction_relations[0].kind, '冲突/同盟/张力/中立/依附');
  assert.equal(shape.world_events[0].stage, '酝酿/爆发/蔓延/消退/落定');
  assert.equal(shape.world_events[0].touched, 'advance/mention/idle');
  assert.equal(shape.world_events[0].status, 'active/closed');
  assert.match(shape.limitations[0].reason, /missing is the actual positive-integer shortfall; use limitations: \[\] when complete/);
  assert.match(schema, /reporting a shortfall does not satisfy the required count/);
  assert.match(schema, /Distinguish possibilities from established experiences/);
  assert.match(schema, /未映之幕 and 幕间拾趣 are independent and have no narrative-injection fields/);
  assert.match(shape.parallel_scene.content, /3–6 paragraphs with a turn and changed condition/);
  assert.match(schema, /specific ending; it is not a synopsis, branch analysis, or moral epilogue/);
  assert.match(schema, /Exclude USER and every alias; do not invent an owner when the list is empty/);
  assert.match(shape.quests[0].inject_prompt, /no action decided for USER/);
});

test('output descriptions request concrete progression and explicit multi-CHAR subjects without changing quotas', () => {
  const schema = createCreativeSchema({ ...FULL, characterNames: ['阿岚', '老周'] }), shape = parseShape(schema);
  assert.match(shape.quests[0].description, /new opening beyond the source stopping point/);
  assert.match(shape.character_dynamics[0].name, /never USER or an alias; group chats may include several CHARs/);
  assert.match(shape.character_dynamics[0].content, /concrete action or changed conditions/);
  assert.match(shape.npc_updates[0].name, /excluding USER and every CHAR/);
  assert.match(shape.npc_updates[0].hidden_agenda, /Leave blank unless/);
  assert.match(shape.chain_reactions[0].chain, /downstream consequence not yet present in the narrative/);
  assert.match(schema, /Confirmed CHAR names for this request: \["阿岚","老周"\]/);
  assert.match(schema, /They may appear in an interaction without becoming its subject/);
  assert.match(schema, /character_dynamics \(此间一人\): at least 2/);
  assert.match(schema, /npc_updates \(其他人物动向\): at least 3/);
  assert.match(schema, /Write candidates concretely without turning them into mainline facts/);
});

test('complete core and all enabled optional sections pass without a world echo quota', () => {
  assert.deepEqual(validateCreativePlan(complete(), FULL), []);
  assert.deepEqual(validateCreativePlan(complete(OFF), OFF), []);
  const plan = complete(OFF);
  plan.world_updates = [{ title: '历史回声', content: '真实旧资料保留。' }];
  plan.director_comment = ['历史旧点评'];
  assert.deepEqual(validateCreativePlan(plan, OFF), []);
});

test('every core quantity is independently enforced; genuine limitation is still a visible shortfall', () => {
  for (const field of ['quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents']) {
    const plan = complete(OFF);
    plan[field].pop();
    plan.limitations = [{ field, missing: 1, reason: '封闭场景的已出现人物不足且明确禁止新增人物。' }];
    const issue = validateCreativePlan(plan, OFF).find(item => item.field === field && item.missing);
    assert.equal(issue.missing, 1, field);
    assert.equal(issue.validIndices.length, CREATIVE_COUNTS[field].min - 1);
  }
});

test('empty, placeholder and same-field repeated bodies do not count, valid entries survive pruning', () => {
  const plan = complete(OFF), first = structuredClone(plan.quests[0]);
  plan.quests = [first, {}, { description: '暂无内容' }, { ...first, title: '仅改标题不能变成新条目' }, { subject: '另一家店', description: '另一家店正在寻找错拿的伞。' }];
  const issues = validateCreativePlan(plan, OFF).filter(item => item.field === 'quests');
  assert.deepEqual(issues.find(item => item.reason.includes('空白')).indices, [1, 2]);
  assert.deepEqual(issues.find(item => item.reason.includes('重复')).indices, [3]);
  assert.equal(issues.find(item => item.missing).missing, 3);
  const result = pruneInvalidCreativeItems(plan, OFF);
  assert.deepEqual(result.plan.quests, [first, plan.quests[4]]);
  assert.deepEqual(result.removed.filter(item => item.field === 'quests').map(item => item.index), [1, 2, 3]);
  assert.equal(plan.quests.length, 5, 'input untouched');
  assert.deepEqual(result.plan.npc_updates, plan.npc_updates);
});

test('same event across fields and persistent valid states are not forcibly replaced', () => {
  const plan = complete(OFF);
  const shared = '旧店仍在等那封回信，掌柜今日又核对了投递时间。';
  plan.character_dynamics[0].content = shared;
  plan.npc_updates[0].current_goal = shared;
  plan.quests[0].description = shared;
  assert.deepEqual(validateCreativePlan(plan, OFF), []);
  assert.deepEqual(pruneInvalidCreativeItems(plan, OFF).plan, normalizeCreativeSections(plan));
});

test('explicit character subjects stay separate from USER and NPCs across fields, including group chats', () => {
  const options = { ...OFF, characterNames: ['阿岚', '老周'], personaNames: ['访客', 'Guest'] };
  const plan = complete(OFF);
  plan.character_dynamics[0].name = '阿岚';
  plan.character_dynamics[1].name = ' 老周 ';
  assert.deepEqual(validateCreativePlan(plan, options), []);
  for (const field of ['character_dynamics', 'npc_updates']) for (const subject of ['访客', ' Guest ', 'USER', '{{user}}']) {
    const bad = structuredClone(plan); bad[field][0].name = subject;
    const issue = validateCreativePlan(bad, options).find(item => item.field === field && item.reason.includes('USER'));
    assert.deepEqual(issue.indices, [0], `${field}: ${subject}`);
    assert.equal(pruneInvalidCreativeItems(bad, options).plan[field].length, plan[field].length - 1);
    assert.equal(bad[field].length, plan[field].length, 'input history remains untouched');
  }
  for (const subject of ['阿岚', '老周']) {
    const bad = structuredClone(plan); bad.npc_updates[1].name = subject;
    assert.ok(validateCreativePlan(bad, options).some(issue => issue.field === 'npc_updates' && issue.reason.includes('此间一人')));
  }
  const wrongSection = structuredClone(plan); wrongSection.character_dynamics[0].name = '邻居0';
  assert.ok(validateCreativePlan(wrongSection, options).some(issue => issue.field === 'character_dynamics' && issue.reason.includes('CHAR')));
});

test('role checks use explicit subject data, never guess from titles, mentions or literary wording', () => {
  const plan = complete(OFF), options = { ...OFF, characterNames: ['阿岚'], personaNames: ['访客'] };
  plan.character_dynamics[0] = { name: '阿岚', title: '访客与老周', content: '阿岚给访客留了口信。他有所察觉，但尚不能确定缘由，决定先核对证据。' };
  plan.character_dynamics[1] = { title: '访客眼中的巷口', content: '自定义旧格式没有明确人物主体，不能仅凭标题判定。' };
  plan.npc_updates[0].current_goal = '和阿岚、访客分别谈过后，开始检查窗台。';
  assert.deepEqual(validateCreativePlan(plan, options), []);
  assert.deepEqual(pruneInvalidCreativeItems(plan, options).plan, normalizeCreativeSections(plan));
  const unknownGroup = { ...options, characterName: '群聊名称', characterNames: [] };
  plan.character_dynamics[1].name = '老周';
  assert.deepEqual(validateCreativePlan(plan, unknownGroup), [], 'an unavailable group roster does not become a false singleton');
  const single = { ...OFF, characterName: '阿岚' };
  assert.ok(validateCreativePlan(plan, single).some(issue => issue.field === 'character_dynamics'));
});

test('range ceilings are reported but qualified records are never arbitrarily truncated', () => {
  for (const field of ['world_chatter', 'factions', 'world_events']) {
    const plan = complete(), seed = plan[field][0];
    plan[field] = Array.from({ length: CREATIVE_COUNTS[field].max + 1 }, (_, i) => ({ ...seed,
      text: `街角${i}传来卖花人的报价。`, agenda: `组织正在核验第${i}份合同。`, essence: `第${i}个区域的协议仍在商谈。` }));
    const issues = validateCreativePlan(plan, FULL).filter(item => item.field === field);
    assert.equal(issues.find(item => item.excess).excess, 1, field);
    assert.equal(pruneInvalidCreativeItems(plan, FULL).plan[field].length, plan[field].length);
    assert.equal(normalizeCreativeSections(plan)[field].length, plan[field].length);
  }
});

test('disabled outputs are not silently accepted while normalization keeps saved history readable', () => {
  const plan = complete();
  const offIssues = validateCreativePlan(plan, OFF);
  for (const field of ['world_chatter', 'factions', 'world_events', 'parallel_scene', 'interlude']) assert.ok(offIssues.some(item => item.field === field && item.disabled));
  assert.deepEqual(normalizeCreativeSections(plan, OFF).interlude, plan.interlude);
  const pruned = pruneInvalidCreativeItems(plan, OFF).plan;
  assert.equal(pruned.interlude, null);
  assert.equal(pruned.parallel_scene, null);
  assert.deepEqual(pruned.world_chatter, []);
  assert.deepEqual(validateCreativePlan(pruned, OFF), []);
});

test('one parallel card is independent of one interlude card; invalid cards are repaired whole', () => {
  const plan = complete();
  delete plan.parallel_scene;
  assert.equal(validateCreativePlan(plan, FULL).find(item => item.field === 'parallel_scene').missing, 1);
  assert.ok(!validateCreativePlan(plan, FULL).some(item => item.field === 'interlude'));
  plan.parallel_scene = [{ title: '第一幕', content: '街角换了一个方向。' }, { title: '第二幕', content: '远处的信先到了。' }];
  assert.ok(validateCreativePlan(plan, FULL).some(item => item.field === 'parallel_scene'));
  assert.equal(pruneInvalidCreativeItems(plan, FULL).plan.parallel_scene, null);
  assert.deepEqual(pruneInvalidCreativeItems(plan, FULL).plan.interlude, plan.interlude);
});

test('interlude type must match the caller; normalizer never corrects invalid type or invents content', () => {
  for (const type of [undefined, null, '', 'both', 'theater']) {
    const plan = complete();
    plan.interlude.type = type;
    const normalized = normalizeCreativeSections(plan, FULL);
    assert.equal(normalized.interlude.type, type);
    assert.ok(validateCreativePlan(normalized, FULL).some(item => item.field === 'interlude'));
  }
  assert.ok(validateCreativePlan(complete(), { ...FULL, interludeType: undefined }).some(item => item.field === 'interlude'));
  const plan = complete();
  plan.interlude = { type: 'phone', owner: '阿岚' };
  assert.ok(validateCreativePlan(normalizeCreativeSections(plan), FULL).some(item => item.field === 'interlude'));
});

test('phone excludes USER aliases before checking eligible non-USER owners', () => {
  for (const owner of ['{{user}}', 'USER', '用户', '访客', ' Guest ', 'GUEST']) {
    const plan = complete();
    plan.interlude.owner = owner;
    assert.ok(validateCreativePlan(plan, { ...FULL, eligiblePhoneOwners: [...FULL.eligiblePhoneOwners, owner] }).some(item => item.field === 'interlude' && item.reason.includes('USER')), owner);
  }
  for (const owners of [[], ['老周']]) assert.ok(validateCreativePlan(complete(), { ...FULL, eligiblePhoneOwners: owners }).some(item => item.field === 'interlude' && item.reason.includes('名单')));
  const plan = complete();
  plan.interlude.owner = ' 阿岚 ';
  assert.deepEqual(validateCreativePlan(plan, FULL), []);
});

test('new normalization is lossless for legacy fields, full text, unknown data and invalid shapes', () => {
  const long = '甲'.repeat(12000);
  const plan = { quests: [{ id: 'old', objective: long, reward: '旧奖励', custom: { keep: true } }], world_updates: [{ content: '旧回声' }], director_comment: ['旧1', '旧2', '旧3', '旧4'], extra: { interlude: '仅存储，不允许继续投喂' }, character_dynamics: { name: '阿岚', next_action: long }, interlude: { type: 'bad', content: long } };
  const copy = structuredClone(plan), normalized = normalizeCreativeSections(plan);
  assert.deepEqual(plan, copy);
  assert.equal(normalized.quests[0].description, long);
  assert.equal(normalized.quests[0].objective, long);
  assert.deepEqual(normalized.extra, plan.extra);
  assert.deepEqual(normalized.director_comment, plan.director_comment);
  assert.deepEqual(normalized.world_updates, plan.world_updates);
  assert.equal(normalized.character_dynamics[0].next_action, long);
  assert.equal(normalized.interlude.type, 'bad');
  normalized.quests[0].custom.keep = false;
  assert.equal(plan.quests[0].custom.keep, true);
  assert.deepEqual(normalizeCreativeSections({ quests: ['来信已寄到街口。'], character_dynamics: ['新的去向。'] }).quests, [{ description: '来信已寄到街口。' }]);
});

test('phone owners may come from narrative or effective memory without being chat speakers', () => {
  const plan = complete();
  plan.interlude.owner = '老周';
  const options = { ...FULL, eligiblePhoneOwners: undefined, phoneSourceText: '阿岚想起旧日那场争执。老周曾把钥匙留在桌上。SOURCE_PRIVATE_MARKER' };
  assert.deepEqual(validateCreativePlan(plan, options), []);
  assert.ok(!createCreativeSchema(options).includes('SOURCE_PRIVATE_MARKER'));
  assert.match(createCreativeSchema(options), /non-USER characters already present in this run's narrative or valid memory/);
  assert.ok(validateCreativePlan(plan, { ...options, phoneSourceText: '阿岚在等回信。' }).some(issue => issue.field === 'interlude'));
  assert.ok(validateCreativePlan(plan, { ...options, phoneSourceText: '' }).some(issue => issue.field === 'interlude'));
  assert.ok(validateCreativePlan(plan, { ...options, personaNames: ['老周'] }).some(issue => issue.field === 'interlude' && issue.reason.includes('USER')));
  assert.ok(validateCreativePlan(plan, { ...options, eligiblePhoneOwners: ['阿岚'] }).some(issue => issue.field === 'interlude' && issue.reason.includes('名单')));
  plan.interlude.owner = 'Ann';
  assert.ok(validateCreativePlan(plan, { ...options, phoneSourceText: 'The annual meeting has ended.' }).some(issue => issue.field === 'interlude'));
  assert.deepEqual(validateCreativePlan(plan, { ...options, phoneSourceText: 'Ann: the meeting has ended.' }), []);
});

test('limitations remain explicit, structurally valid and cannot waive quantity checks', () => {
  const plan = complete(OFF);
  plan.quests = [];
  plan.limitations = [{ field: 'quests', missing: 5, reason: '必需来源缺失且未授权补写来源事实。' }];
  assert.ok(validateCreativePlan(plan, OFF).some(item => item.field === 'quests' && item.missing === 5));
  assert.ok(!validateCreativePlan(plan, OFF).some(item => item.field === 'limitations'));
  plan.limitations.push({ field: 'parallel_scene', missing: 1, reason: '关闭栏目不应报告缺口。' }, { field: 'quests', missing: 0, reason: '暂无内容' });
  assert.deepEqual(validateCreativePlan(plan, OFF).find(item => item.field === 'limitations').indices, [1, 2]);
  plan.limitations = [{ field: 'quests', missing: 2, reason: '实际缺口不同。' }, { field: 'npc_updates', missing: 1, reason: '已经完整的栏目不应报告缺口。' }, { field: 'constructor', missing: 1, reason: '未知栏目不能通过。' }];
  assert.deepEqual(validateCreativePlan(plan, OFF).find(item => item.field === 'limitations').indices, [0, 1, 2]);
});

test('continuity is an allowlist projection with explicit candidate status and no side stories', () => {
  const plan = complete();
  plan.world_updates = [{ content: '旧回声仍可读取', inject_prompt: '不直接复制执行提示' }];
  plan.director_comment = ['旧点评'];
  plan.custom = { renamed_fun: plan.interlude };
  plan.quests[0].renamed_fun = plan.interlude;
  plan.quests[0].inject_prompt = '隐藏执行词';
  plan.npc_updates[0].content = { interlude: plan.interlude };
  plan.factions[0].clues.push({ phone: '污染线索' });
  const projected = projectCreativeContinuity(plan);
  assert.equal(projected.reference_kind, 'candidate_reference');
  for (const key of ['parallel_scene', 'interlude', 'director_comment', 'world_chatter', 'limitations', 'custom']) assert.ok(!Object.hasOwn(projected, key), key);
  assert.ok(!Object.hasOwn(projected.quests[0], 'renamed_fun'));
  assert.ok(!Object.hasOwn(projected.quests[0], 'inject_prompt'));
  assert.ok(!Object.hasOwn(projected.npc_updates[0], 'content'));
  assert.deepEqual(projected.factions[0].clues, ['布告栏贴出新的值班安排。']);
  assert.deepEqual(projected.world_updates, [{ content: '旧回声仍可读取' }]);
  assert.equal(projected.quests[0].description, plan.quests[0].description);
  projected.quests[0].description = '修改投影';
  assert.notEqual(projected.quests[0].description, plan.quests[0].description);
});

test('empty and malformed inputs do not throw or gain false completeness', () => {
  for (const value of [null, undefined, false, '', [], 0]) {
    assert.doesNotThrow(() => normalizeCreativeSections(value));
    assert.ok(validateCreativePlan(value, OFF).length);
    assert.deepEqual(projectCreativeContinuity(value), { reference_kind: 'candidate_reference' });
  }
});

test('directions enforce one near and one far entry while preserving old status anchors', () => {
  const plan = complete(OFF);
  plan.story_status.summary = '历史存档摘要不丢弃';
  plan.story_status.directions.push({ horizon: 'near', title: '重复标题', content: plan.story_status.directions[0].content });
  const issues = validateCreativePlan(plan, OFF);
  assert.ok(issues.some(issue => issue.field === 'story_status' && issue.reason.includes('重复')));
  const pruned = pruneInvalidCreativeItems(plan, OFF).plan;
  assert.equal(pruned.story_status.directions.length, 2);
  assert.equal(pruned.story_status.summary, '历史存档摘要不丢弃');
  assert.equal(projectCreativeContinuity(pruned).story_status.directions[0].content, plan.story_status.directions[0].content);
  assert.equal(projectCreativeContinuity(pruned).story_status.directions[1].horizon, 'far');
  plan.story_status.directions = Array.from({ length: 3 }, (_, i) => ({ horizon: 'near', title: `近线${i}`, content: `条件${i}会改变这次谈话。` }));
  const sameHorizonIssues = validateCreativePlan(plan, OFF).filter(issue => issue.field === 'story_status');
  assert.ok(sameHorizonIssues.some(issue => issue.reason.includes('各一条')));
  assert.ok(sameHorizonIssues.some(issue => issue.missing === 1));
  assert.equal(pruneInvalidCreativeItems(plan, OFF).plan.story_status.directions.length, 1);
  assert.equal(plan.story_status.directions.length, 3, 'source response is not mutated');
  plan.story_status.directions = [{ horizon: 'future', title: '未知', content: '不会擅自转成远线' }];
  assert.ok(validateCreativePlan(plan, OFF).some(issue => issue.field === 'story_status' && issue.missing === 2));
  const legacy = { story_status: { current_stage: '旧阶段', summary: '旧摘要' } };
  assert.deepEqual(normalizeCreativeSections(legacy).story_status, legacy.story_status);
  assert.ok(validateCreativePlan(legacy, OFF).some(issue => issue.field === 'story_status' && issue.missing === 2));
  const oldDirections = { story_status: { directions: [{ title: '旧方向', content: '未经标记的历史正文' }] } };
  assert.deepEqual(normalizeCreativeSections(oldDirections).story_status, oldDirections.story_status, 'historical reading never invents a horizon');
});

test('preview subjects are explicit and ripple node counts do not pretend to assess literature', () => {
  const plan = complete(OFF);
  delete plan.quests[0].subject;
  assert.ok(validateCreativePlan(plan, OFF).some(issue => issue.field === 'quests' && issue.indices?.includes(0)));
  assert.ok(!Object.hasOwn(normalizeCreativeSections(plan).quests[0], 'subject'), 'do not infer the subject from a title');
  plan.quests[0].subject = '城中送信事务';
  assert.deepEqual(validateCreativePlan(plan, OFF), []);
  for (const chain of ['一处起因 → 一处后果', '甲 → 乙 → 丙 → 丁 → 戊 → 己', '甲 →  → 丙']) {
    plan.chain_reactions[0].chain = chain;
    assert.ok(validateCreativePlan(plan, OFF).some(issue => issue.field === 'chain_reactions' && issue.indices?.includes(0)));
  }
  plan.chain_reactions[0].chain = '送货停下 → 当事人联系店主 → 新的发货条件形成';
  assert.deepEqual(validateCreativePlan(plan, OFF), [], 'structural checks do not score whether lateral breadth is artistically sufficient');
});

test('relations exclude USER–CHAR pairs even with a third party and require two supporting-only links', () => {
  const options = { ...OFF, personaNames: ['访客'], characterNames: ['阿岚', '老周'] };
  const plan = complete(OFF);
  for (const parties of [['访客', '阿岚'], ['邻居', '老周', '访客'], ['{{user}}', '{{char}}', '甲']]) {
    plan.relation_undercurrents[0].parties = parties;
    assert.ok(validateCreativePlan(plan, options).some(issue => issue.field === 'relation_undercurrents' && issue.reason.includes('USER–CHAR')));
  }
  plan.relation_undercurrents[0].parties = ['阿岚', '配角甲'];
  assert.deepEqual(validateCreativePlan(plan, options), []);
  plan.relation_undercurrents[1].parties = ['老周', '配角乙', '配角丙'];
  assert.ok(validateCreativePlan(plan, options).some(issue => issue.field === 'relation_undercurrents' && issue.reason.includes('至少两条') && issue.missing === 1));
  assert.equal(pruneInvalidCreativeItems(plan, options).plan.relation_undercurrents.length, 3, 'supporting shortfall must not delete otherwise valid entries');
  const legacy = { relation_undercurrents: [{ parties: '甲、乙', tension: '旧关系', user_awareness: '旧记录' }] };
  assert.deepEqual(normalizeCreativeSections(legacy).relation_undercurrents, legacy.relation_undercurrents, 'legacy text remains unsplit and untouched');
});

test('forum bounds and complete replies are enforced, while legacy theater remains readable but not valid new output', () => {
  const options = { ...FULL, interludeType: 'forum' }, plan = complete(options);
  assert.deepEqual(validateCreativePlan(plan, options), []);
  for (const count of [2, 6]) {
    const bad = structuredClone(plan);
    bad.interlude.posts = Array.from({ length: count }, (_, i) => ({ ...plan.interlude.posts[0], content: `主题${i}` }));
    assert.ok(validateCreativePlan(bad, options).some(issue => issue.field === 'interlude'));
  }
  for (const replies of [[], [{ author: '甲' }], Array.from({ length: 4 }, () => ({ author: '甲', content: '回复' }))]) {
    const bad = structuredClone(plan); bad.interlude.posts[0].replies = replies;
    assert.ok(validateCreativePlan(bad, options).some(issue => issue.field === 'interlude'));
  }
  const old = { type: 'theater', title: '戏中戏', content: '旧版存档正文' };
  plan.interlude = old;
  assert.deepEqual(normalizeCreativeSections(plan).interlude, old);
  assert.ok(validateCreativePlan(plan, options).some(issue => issue.field === 'interlude'));
});

test('phone requires 6–10 messages and multiple speakers but permits natural repeated short replies', () => {
  const plan = complete();
  plan.interlude.messages[0].content = '好'; plan.interlude.messages[1].content = '好';
  assert.deepEqual(validateCreativePlan(plan, FULL), []);
  for (const count of [5, 11]) {
    const bad = structuredClone(plan);
    bad.interlude.messages = Array.from({ length: count }, (_, i) => ({ ...plan.interlude.messages[i % 6], time: `09:${i}` }));
    assert.ok(validateCreativePlan(bad, FULL).some(issue => issue.field === 'interlude'));
  }
  const solo = structuredClone(plan); solo.interlude.messages.forEach(message => { message.sender = '阿岚'; });
  assert.ok(validateCreativePlan(solo, FULL).some(issue => issue.field === 'interlude' && issue.reason.includes('两位')));
  const exactDuplicate = structuredClone(plan); exactDuplicate.interlude.messages[5] = structuredClone(exactDuplicate.interlude.messages[0]);
  assert.ok(validateCreativePlan(exactDuplicate, FULL).some(issue => issue.field === 'interlude' && issue.reason.includes('完全相同')));
  const missingTime = structuredClone(plan); delete missingTime.interlude.messages[0].time;
  assert.ok(validateCreativePlan(missingTime, FULL).some(issue => issue.field === 'interlude'));
  const direct = structuredClone(plan); direct.interlude.conversation_kind = 'direct';
  assert.deepEqual(validateCreativePlan(direct, FULL), []);
  direct.interlude.messages[5].sender = '邻居';
  assert.ok(validateCreativePlan(direct, FULL).some(issue => issue.field === 'interlude' && issue.reason.includes('私聊')));
  direct.interlude.conversation_kind = 'group';
  assert.deepEqual(validateCreativePlan(direct, FULL), [], 'group may have more than two speakers');
});
