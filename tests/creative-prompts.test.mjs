import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CREATIVE_IDENTITY, CREATIVE_LAWS, CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT,
  CREATIVE_GUIDES, CREATIVE_COUNTS, CREATIVE_DETAIL_COUNTS, CREATIVE_SECTION_LABELS, creativeSectionGuidance,
} from '../qianmu-creative-prompts.js';
import { createCreativeSchema } from '../qianmu-creative-contract.js';

const digest = value => createHash('sha256').update(value).digest('hex');

test('relationship guidance and output contract agree on two or three people without a mandatory batch mix', () => {
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.relationParties, { min: 2, max: 3 });
  assert.equal(CREATIVE_COUNTS.relation_undercurrents.min, 3);
  assert.equal(CREATIVE_DETAIL_COUNTS.supportingRelations.min, 2);
  assert.match(CREATIVE_LAWS, /Choose participants for the relationship and its narrative value; do not add people merely to vary group sizes/);
  assert.match(CREATIVE_GUIDES.relation_undercurrents, /每条围绕 2–3 位明确参与者/);
  assert.match(CREATIVE_GUIDES.relation_undercurrents, /人数依人物关系与叙事价值自然决定，不为凑齐双人、三人组合硬添参与者/);
  for (const options of [{}, { interludeEnabled: false, parallelSceneEnabled: false }, { geopoliticsEnabled: true }]) {
    const schema = createCreativeSchema(options);
    assert.match(schema, /Every relation uses an array of 2–3 exact participant names, chosen for the relationship and its narrative value rather than a required mix of group sizes/);
    assert.match(schema, /at least two relations include neither USER nor CHAR/);
    assert.doesNotMatch([CREATIVE_LAWS, CREATIVE_GUIDES.relation_undercurrents, schema].join('\n'), /mixed set with at least one|include both a two-person and a three-person|三条中至少一条是双人关系/);
  }
});

test('Chinese identity stays exact while progression laws and guides remain separately reviewable', () => {
  assert.equal(digest(CREATIVE_IDENTITY), '03765b3a9e8a4c0172833df171204d23832521b286866796f43a5df21110960e');
  assert.equal(digest(CREATIVE_LAWS), '5a7b5d2a96641ec91b1bd34a6efc76970ac6d81239e93f4a889a46f22c1e9501');
  assert.equal(digest(CREATIVE_BLUEPRINT), 'e2451abdca74390ae2608a3edcf118993d247074a311348998a5eeb64f91a8e2');
  assert.equal(digest(JSON.stringify(CREATIVE_GUIDES)), '6984f7f5017097132f16018e5016b99ae9c230ed384605e76cb896dec08e2943');
  assert.equal(CREATIVE_SYSTEM_PROMPT, `## Code of Being\n\n${CREATIVE_IDENTITY}\n\n## Laws of the Ensemble\n\n${CREATIVE_LAWS}`);
  assert.equal(CREATIVE_SECTION_LABELS.character_dynamics, '此间一人');
  assert.equal(CREATIVE_SECTION_LABELS.npc_updates, '各自人间');
  assert.doesNotMatch([CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, creativeSectionGuidance({ interludeType: 'forum' }), createCreativeSchema()].join('\n'), /其他人物动向/);
});

test('progression is mandatory without declaring candidates real or taking USER agency', () => {
  assert.match(CREATIVE_LAWS, /Every run must supply developments beyond the input's existing stopping point/);
  assert.match(CREATIVE_LAWS, /Each encounter must introduce a new, actionable opening/);
  assert.match(CREATIVE_LAWS, /Each CHAR entry must carry one of CHAR's own affairs into a concrete action or consequential next step/);
  assert.match(CREATIVE_LAWS, /Each ripple must extend its cause into a downstream consequence beyond the already narrated chain/);
  assert.match(CREATIVE_LAWS, /Candidate status controls whether a development is established in the mainline, not whether it is written concretely/);
  assert.match(CREATIVE_LAWS, /causal dramatic beat/);
  assert.match(CREATIVE_LAWS, /non-USER, non-CHAR actor or group/);
  assert.match(CREATIVE_LAWS, /concrete event, choice, discovery, or changed circumstance/);
  assert.match(CREATIVE_LAWS, /This does not move the mainline clock or complete an unresolved USER decision/);
  assert.match(CREATIVE_LAWS, /enduring organizations, unresolved tensions, and quiet lives need not undergo an artificial reversal/);
  assert.doesNotMatch(CREATIVE_LAWS, /Do not force growth, warmer relationships, mainline advancement/);
  assert.match(CREATIVE_BLUEPRINT, /承接是让旧事产生新作用/);
  assert.match(CREATIVE_BLUEPRINT, /不把“接下来如何推进”的工作交还给读者/);
});

test('section responsibilities reject recaps, protagonist monopoly and unsupported conspiracy without a forced tone', () => {
  assert.match(CREATIVE_GUIDES.quests, /每条预演提供一个正文现有落点之外、可以接近和回应的近景情境/);
  assert.match(CREATIVE_GUIDES.character_dynamics, /只以本聊天的 CHAR 为动态主体/);
  assert.match(CREATIVE_GUIDES.character_dynamics, /群聊中的多个 CHAR/);
  assert.match(CREATIVE_GUIDES.npc_updates, /即使暂时移除主角仍会进行/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /至少延伸到正文尚未呈现的一处结果/);
  assert.match(CREATIVE_GUIDES.relation_undercurrents, /至少两条是配角之间的关系/);
  assert.match(CREATIVE_LAWS, /A changed viewpoint, title, or emotional metaphor alone does not make a retelling new content/);
  assert.match(CREATIVE_LAWS, /Do not turn an ordinary remark, coincidence, or lack of information into evidence of guilt, a conspiracy/);
  assert.match(CREATIVE_LAWS, /Neither a dark turn nor a reassuring outcome is mandatory/);
  assert.match(CREATIVE_LAWS, /excluding USER; 各自人间: at least 3 entries about other non-USER, non-CHAR people/);
});

test('count source is frozen and rendered in approved laws without an invented world echo quota', () => {
  assert.ok(Object.isFrozen(CREATIVE_COUNTS));
  for (const count of Object.values(CREATIVE_COUNTS)) assert.ok(Object.isFrozen(count));
  assert.deepEqual(Object.fromEntries(Object.entries(CREATIVE_COUNTS).map(([key, value]) => [key, value.min])), {
    story_status: 2, quests: 5, character_dynamics: 2, npc_updates: 3, chain_reactions: 3, relation_undercurrents: 3,
    world_chatter: 8, factions: 3, world_events: 2, parallel_scene: 1, interlude: 1,
  });
  assert.ok(!Object.hasOwn(CREATIVE_COUNTS, 'world_updates'));
  assert.ok(CREATIVE_LAWS.includes(`此间一人: at least ${CREATIVE_COUNTS.character_dynamics.min} entries`));
  assert.ok(CREATIVE_LAWS.includes(`尘寰群生: ${CREATIVE_COUNTS.world_chatter.min}–${CREATIVE_COUNTS.world_chatter.max}`));
  assert.ok(CREATIVE_LAWS.includes(`世界格局: ${CREATIVE_COUNTS.factions.min}–${CREATIVE_COUNTS.factions.max}`));
  assert.ok(CREATIVE_LAWS.includes(`${CREATIVE_COUNTS.world_events.min}–${CREATIVE_COUNTS.world_events.max} ongoing situations`));
});

test('runtime prose excludes private editorial notes and superseded occupational framing', () => {
  const result = [CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, ...Object.values(CREATIVE_GUIDES)].join('\n');
  assert.doesNotMatch(result, /接入与同步说明|后续接入复核要点|待用户校|待审|D:[/\\]|你是.*(?:剧作家|导演)/);
  assert.match(CREATIVE_LAWS, /previously unstated past experiences compatible with known facts/);
  assert.match(CREATIVE_LAWS, /do not falsely claim that the narrative or memory already recorded it/);
  assert.match(CREATIVE_LAWS, /Do not decide \{\{user\}\}'s thoughts, emotions, positions, or actions/);
  assert.match(CREATIVE_LAWS, /Do not write these side stories into mainline memory, continuity references, or narrative injection/);
  assert.match(CREATIVE_GUIDES.phone, /排除 \{\{user\}\} 及其别名与身份映射/);
  assert.match(CREATIVE_GUIDES.phone, /不得借转发、截图或他人复述/);
});

test('English laws preserve authorization, knowledge, story-time and limited-shortfall boundaries', () => {
  const withoutProductNames = Object.values(CREATIVE_SECTION_LABELS).reduce((body, label) => body.replaceAll(label, ''), CREATIVE_LAWS);
  assert.doesNotMatch(withoutProductNames, /\p{Script=Han}/u, 'only unchanged product labels remain Chinese in the laws');
  assert.match(CREATIVE_LAWS, /explicit user corrections, the actual narrative, and valid memory/);
  assert.match(CREATIVE_LAWS, /follow the corrections to any corrected summary/);
  assert.match(CREATIVE_LAWS, /Do not alter established events or fabricate source quotations or evidence of provenance/);
  assert.match(CREATIVE_LAWS, /Possibilities that have not been adopted or authorized must not overwrite the narrative or become established mainline events/);
  assert.match(CREATIVE_LAWS, /Knowledge of secrets or another person's inner thoughts must rest on actual experience, a channel through which it was learned, or an established ability/);
  assert.match(CREATIVE_LAWS, /generation runs or a long absence of mention is not evidence that time has passed or an event has been resolved/);
  assert.match(CREATIVE_LAWS, /Do not reveal central mysteries through an interlude card's body, title, character labels, or metaphors/);
  assert.match(CREATIVE_LAWS, /Only when an explicit closed setting, character constraint, or missing required source makes doing so necessarily cross a boundary/);
  assert.match(CREATIVE_LAWS, /Do not alter source facts to fill a quota or claim that an actual shortfall is complete output/);
  assert.match(CREATIVE_LAWS, /Upper limits apply only to this run's output/);
  assert.match(CREATIVE_LAWS, /without deleting or changing unselected long-term records/);
});

test('default guides include separate parallel scene and exactly the fixed interlude form', () => {
  for (const type of ['forum', 'phone']) {
    const result = creativeSectionGuidance({ interludeType: type });
    assert.ok(result.includes(CREATIVE_GUIDES.parallel_scene));
    assert.ok(result.includes(CREATIVE_GUIDES.interlude));
    assert.ok(result.includes(CREATIVE_GUIDES[type]));
    assert.ok(!result.includes(CREATIVE_GUIDES[type === 'forum' ? 'phone' : 'forum']));
    assert.ok(!result.includes(CREATIVE_GUIDES.world_chatter));
    assert.ok(!result.includes(CREATIVE_GUIDES.geopolitics));
  }
});

test('each optional guide honors its own switch without consuming another quota', () => {
  const options = Object.freeze({ worldChatterEnabled: true, geopoliticsEnabled: true, parallelSceneEnabled: false, interludeEnabled: false });
  const result = creativeSectionGuidance(options);
  assert.ok(result.includes(CREATIVE_GUIDES.world_chatter));
  assert.ok(result.includes(CREATIVE_GUIDES.geopolitics));
  assert.ok(!result.includes(CREATIVE_GUIDES.parallel_scene));
  assert.ok(!result.includes(CREATIVE_GUIDES.interlude));
  assert.ok(!result.includes(CREATIVE_GUIDES.forum));
  assert.ok(!result.includes(CREATIVE_GUIDES.phone));
  for (const key of ['character_dynamics', 'npc_updates', 'quests', 'chain_reactions', 'relation_undercurrents']) assert.ok(result.includes(CREATIVE_GUIDES[key]));
});

test('caller must fix one interlude form; pure guide never silently selects or repairs it', () => {
  for (const type of [undefined, null, '', 'both', 'mobile']) assert.throws(() => creativeSectionGuidance({ interludeType: type }), { code: 'creative_interlude_type_required' });
  const options = Object.freeze({ interludeType: 'phone' });
  assert.equal(creativeSectionGuidance(options), creativeSectionGuidance(options));
  assert.doesNotThrow(() => creativeSectionGuidance({ interludeEnabled: false }));
});

test('phone guidance follows the fixed request mode and never re-closes the world to an existing cast list', () => {
  for (const kind of ['direct', 'group']) {
    const options = Object.freeze({ interludeType: 'phone', phoneConversationKind: kind });
    const result = creativeSectionGuidance(options);
    assert.match(result, new RegExp(`固定为 ${kind}`));
    assert.ok(result.includes(CREATIVE_GUIDES.phone));
    assert.equal(result, creativeSectionGuidance(options));
  }
  const forum = creativeSectionGuidance({ interludeType: 'forum', phoneConversationKind: 'direct' });
  assert.ok(!forum.includes('本轮手机会话形式固定为'));
  const disabled = creativeSectionGuidance({ interludeEnabled: false, interludeType: 'phone', phoneConversationKind: 'direct' });
  assert.ok(!disabled.includes('本轮手机会话形式固定为'));
  const hint = creativeSectionGuidance({ interludeType: 'phone', phoneConversationKind: 'direct', recentInterludeHint: '{"owner":"前页人物"}' });
  assert.match(hint, /另一处合理的生活圈/);
  for (const guide of [CREATIVE_GUIDES.interlude, CREATIVE_GUIDES.phone, hint]) {
    assert.doesNotMatch(guide, /只从正文或有效记忆已经出现|另一位已出现人物|不为扩大视角凭空制造/);
  }
});

test('v447 responsibilities weave near/far trajectories, lived voices and varied social viewpoints', () => {
  assert.equal(CREATIVE_SECTION_LABELS.quests, '预演');
  assert.equal(CREATIVE_SECTION_LABELS.interlude, '幕间拾趣');
  assert.equal(CREATIVE_SECTION_LABELS.story_status, '命运之脉');
  assert.deepEqual(CREATIVE_COUNTS.story_status, { min: 2, max: 2 });
  assert.match(CREATIVE_GUIDES.story_status, /near.*far/);
  assert.match(CREATIVE_GUIDES.story_status, /行动如何遇见另一人的打算/);
  assert.match(CREATIVE_GUIDES.story_status, /而非按人物职业或固有人设分派任务/);
  assert.match(CREATIVE_GUIDES.quests, /subject 明确写本条主体/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /3–5 个简短节点/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /至少一条体现真正的横向广度/);
  assert.match(CREATIVE_GUIDES.relation_undercurrents, /不能加入第三人规避/);
  assert.match(CREATIVE_GUIDES.world_chatter, /不要求藏线索、送情报或推动案件/);
  assert.match(CREATIVE_LAWS, /Situated human speech in 尘寰群生 may instead reveal temperament, an ordinary concern, or a way of living, without supplying a clue or new plot condition/);
  assert.match(CREATIVE_GUIDES.world_chatter, /纯天气、景色、机械声和动物反应不占名额/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /过去、近未来或遥远未来/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /无须标题/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /3–6 个有呼吸的出版式段落/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /不要用抽象升华/);
  assert.match(CREATIVE_GUIDES.story_status, /near 与 far 只由时态锚定/);
  assert.match(CREATIVE_GUIDES.story_status, /至少一条从非 \{\{user\}\}、非 \{\{char\}\} 的人物或群体开始/);
  assert.match(CREATIVE_GUIDES.story_status, /不连续堆叠“可能、也许、应该、似乎”/);
  assert.match(CREATIVE_GUIDES.interlude, /所有字段只写安全纯文本，不输出 HTML/);
  assert.match(CREATIVE_GUIDES.interlude, /不固定围绕阴谋、热搜或主角点评/);
  assert.match(CREATIVE_GUIDES.phone, /已有配角、路人或 CHAR.*也可创作符合世界的旁页人物/);
  assert.match(CREATIVE_GUIDES.phone, /不要求每张卡都换人或造新人/);
  assert.match(CREATIVE_GUIDES.phone, /已有角色也可与家人、朋友或同好聊私人关切/);
  assert.match(CREATIVE_GUIDES.phone, /不只是把工作汇报改群名、改人数/);
  assert.match(CREATIVE_GUIDES.phone_chat, /群聊时就是群名.*私聊时就是对方的联系人显示名/);
  assert.match(CREATIVE_GUIDES.forum, /带一点在地性与网感/);
  assert.match(CREATIVE_LAWS, /Write selectable narrative passages as third-person authorial prose/);
  assert.match(CREATIVE_LAWS, /do not repeat them as bracketed labels/);
  assert.match(CREATIVE_GUIDES.quests, /人物带着具体言行进入场景的短小落笔/);
});

test('newcomer requirement is included only for enabled runs and honors actual closed settings', () => {
  const off = creativeSectionGuidance({ interludeEnabled: false });
  const on = creativeSectionGuidance({ interludeEnabled: false, newcomerMode: true });
  assert.ok(!off.includes(CREATIVE_GUIDES.newcomer));
  assert.ok(on.includes(CREATIVE_GUIDES.newcomer));
  assert.match(CREATIVE_GUIDES.newcomer, /此前尚未出现的全新人物/);
  assert.match(CREATIVE_GUIDES.newcomer, /已有线索、事务、人物关系或行动后果/);
  assert.match(CREATIVE_GUIDES.newcomer, /不要求世界级大事件/);
  assert.match(CREATIVE_GUIDES.newcomer, /明确封闭设定或人物禁限/);
});

// These are prompt-contract regressions, not measurements of model prose quality.
test('causal design distinguishes a spoken cover story, thematic resonance and actual evidence', () => {
  assert.match(CREATIVE_LAWS, /A cover story or guess establishes that someone said it, not that its contents are physically true/);
  assert.match(CREATIVE_LAWS, /Build the underlying affair from its participants' own motives, opportunities, constraints, and actions/);
  assert.match(CREATIVE_LAWS, /occupation, origin, craft, or unusual perception can explain what they notice and how they respond/);
  assert.match(CREATIVE_LAWS, /a personal causal connection requires an established action, contact, shared stake, or explicit source fact/);
  assert.match(CREATIVE_LAWS, /Biography alone must not generate a matching victim history, object provenance, culprit, local custom, or convenient expert problem/);
  assert.match(CREATIVE_LAWS, /Keep a chance first encounter a first encounter unless a separate source history supports more/);
  assert.match(CREATIVE_LAWS, /choose other people's backgrounds and affairs for their own stakes, not as disguised versions of USER's biography/);
  assert.match(CREATIVE_LAWS, /preserving suspicion, observation, and demonstrated connection as distinct/);
  assert.match(CREATIVE_BLUEPRINT, /先让一件事凭当事人的动机、机会和行动自行成立/);
  assert.match(CREATIVE_BLUEPRINT, /人设决定人物如何看见和应对/);
  assert.match(CREATIVE_BLUEPRINT, /初遇可以只是初遇，呼应不必变成同源证据/);
  assert.match(CREATIVE_BLUEPRINT, /呼应不必变成同源证据/);
});

test('mystery restraint still permits supported history, quiet lives and fresh situated people', () => {
  assert.match(CREATIVE_LAWS, /An unresolved origin can remain unresolved while choices and consequences advance/);
  assert.match(CREATIVE_LAWS, /not a ban on surprise, supported personal stakes, ordinary intimacy, or newly invented supporting lives/);
  assert.match(CREATIVE_LAWS, /previously unstated past experiences compatible with known facts/);
  assert.match(CREATIVE_LAWS, /enduring organizations, unresolved tensions, and quiet lives need not undergo an artificial reversal/);
  assert.match(CREATIVE_LAWS, /a concrete responsibility, exchange, shared resource, or disagreement gives them a place and an interest of their own/);
  assert.match(CREATIVE_LAWS, /The supplied cast is not the whole population unless the setting explicitly says so/);
  assert.match(CREATIVE_LAWS, /a disabled newcomer requirement does not close the world/);
  const regularGuidance = creativeSectionGuidance({ interludeEnabled: false, newcomerMode: false });
  assert.ok(regularGuidance.includes(CREATIVE_GUIDES.relation_undercurrents));
  assert.match(regularGuidance, /新联系也可在当下建立，不必倒造与主角的旧缘/);
  assert.match(regularGuidance, /明确封闭设定仍优先/);
  assert.ok(!regularGuidance.includes(CREATIVE_GUIDES.newcomer), 'permission for new lives is not an extra mandatory new-character quota');
  assert.match(CREATIVE_GUIDES.phone, /不限于已出场名单/);
  assert.match(CREATIVE_GUIDES.phone, /不默认与 USER\/CHAR 相识，其经历不是正文既定事实/);
});

test('a parallel scene cannot manufacture the evidence that another card uses to solve an active mystery', () => {
  assert.match(CREATIVE_LAWS, /a shared place, an ordinary consequence, or a contrasting choice/);
  assert.match(CREATIVE_LAWS, /one invented card cannot serve as evidence for another/);
  assert.match(CREATIVE_LAWS, /Do not write these side stories into mainline memory, continuity references, or narrative injection/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /同一地点的另一段生活、某项行动的日常余波或彼此映照的选择/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /不借回溯补齐未获来源支持的身份、责任与事件起因/);
  assert.match(createCreativeSchema(), /Preserve active mainline mysteries instead of inventing their definitive past/);
  assert.doesNotMatch(createCreativeSchema(), /concrete alternate fact/);
});

test('NPC supplied subject anchor replaces routine name repetition without weakening standalone prose', () => {
  const schema = createCreativeSchema();
  const shape = JSON.parse(schema.slice(schema.indexOf('\n{') + 1, schema.indexOf('\n\n', schema.indexOf('\n{'))));
  const npc = shape.npc_updates[0];
  assert.match(npc.name, /supplies the subject prefix/);
  assert.doesNotMatch(npc.current_goal, /naming this person/);
  assert.match(npc.current_goal, /do not restart with their name in every field/);
  assert.match(npc.next_action, /readable with the subject prefix alone and flowing with adjacent selected fields/);
  assert.match(npc.relations, /identify other participants and disambiguate subject changes/);
  assert.match(npc.inject_prompt, /name them only when needed for clarity/);
  assert.match(schema, /each passage must read independently with that prefix and flow when combined/);
  assert.match(CREATIVE_LAWS, /without depending on an unselected paragraph/);
  assert.match(CREATIVE_LAWS, /sections without a subject prefix still identify their actor/);
  assert.match(shape.character_dynamics[0].content, /naming CHAR/);
  assert.match(CREATIVE_BLUEPRINT, /单段连同姓名前缀可读，多段合选也不反复介绍同一人/);
  assert.match(CREATIVE_GUIDES.npc_updates, /人物切换时保留必要点名/);
});

test('personal causal relevance applies to the whole batch and cannot be supplied by invented intermediaries', () => {
  const schema = createCreativeSchema({ worldChatterEnabled: true, geopoliticsEnabled: true, interludeType: 'forum' });
  assert.match(CREATIVE_LAWS, /Across every enabled section, treat USER's persona as living background, not a checklist/);
  assert.ok(CREATIVE_LAWS.indexOf('### Personal Relevance Across Sections') < CREATIVE_LAWS.indexOf('### Dramatic Design and Multiple Lines'), 'the source-scope rule governs all sections, not just the two dramatic trajectories');
  assert.match(CREATIVE_LAWS, /That source supports only the connection it actually establishes/);
  assert.match(CREATIVE_LAWS, /presence, contact, or a public disturbance does not establish shared origin, former acquaintance, or another person's pre-existing background/);
  assert.match(CREATIVE_BLUEPRINT, /只支持其实际范围内的联系/);
  assert.match(CREATIVE_BLUEPRINT, /在场或惊动旁人可产生此后的后果，却不倒证同源、旧缘或他人生前背景/);
  assert.match(CREATIVE_LAWS, /Inventing an intermediary, synonym, or another card that repeats the motif does not supply that missing basis/);
  assert.match(CREATIVE_LAWS, /New people and independently motivated affairs may create their own consequences within a coherent candidate/);
  assert.match(CREATIVE_LAWS, /including earlier unadopted candidates, is not established source evidence for USER's hidden ties/);
  assert.match(CREATIVE_LAWS, /the encounter itself can create new consequences from now on/);
  assert.match(schema, /Across all enabled sections, do not turn USER's biography into a required causal theme/);
  assert.match(schema, /only within that source's actual scope: contact does not prove shared origin or another person's past/);
  assert.match(schema, /A newly invented intermediary, paraphrased motif or another candidate card is not independent evidence/);
  assert.match(schema, /Preserve supported personal connections/);
  assert.match(schema, /Concrete cause from an established source or a clearly candidate, independently motivated new affair/);
  const runtimeText = [CREATIVE_LAWS, CREATIVE_BLUEPRINT, ...Object.values(CREATIVE_GUIDES), schema].join('\n');
  assert.doesNotMatch(runtimeText, /岩彩|晋北|酆霁钰|秦铎/, 'the case must not become a production keyword blacklist');
});

test('ripple breadth requires an independent destination and social breadth follows speakers own lives', () => {
  assert.match(CREATIVE_LAWS, /At least one chain must begin in other people's own affairs and carry its downstream stakes within their lives/);
  assert.match(CREATIVE_LAWS, /without returning to USER's identity, reputation, special abilities, or next encounter/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /结尾仍属于他们，不回流为/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /职业近义词或材料别名，不算独立因果/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /其他链可以承接 USER 实际行动造成的后果/);
  for (const interludeType of ['forum', 'phone']) {
    const guidance = creativeSectionGuidance({ interludeType });
    assert.match(guidance, /主要话题从说话者自己的生活需求、闲趣和分歧中取材/);
    assert.match(guidance, /主线相关的交流须有真实传播路径，角色私密人设不自动成为公共知识/);
  }
});

test('CHAR emotional metadata is not requested anywhere while NPC emotional cues remain', () => {
  const schema = createCreativeSchema();
  const start = schema.indexOf('\n{') + 1;
  const shape = JSON.parse(schema.slice(start, schema.indexOf('\n\n', start)));
  assert.equal(Object.hasOwn(shape.character_dynamics[0], 'emotional_state'), false);
  assert.equal(Object.hasOwn(shape.npc_updates[0], 'emotional_state'), true);
  assert.match(CREATIVE_GUIDES.character_dynamics, /本栏不产出 emotional_state 或独立情绪摘要/);
  assert.match(schema, /Only npc_updates may include emotional_state/);
  assert.match(schema, /character_dynamics must omit emotional_state and any separate emotion summary/);
  assert.doesNotMatch(schema, /Each CHAR and NPC emotional_state/);
});

test('NPC labels use shared generation ceilings without minimum padding or a forced short emotion target', () => {
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.roleChars, { max: 16 });
  assert.deepEqual(CREATIVE_DETAIL_COUNTS.emotionChars, { max: 18 });
  assert.ok(Object.isFrozen(CREATIVE_DETAIL_COUNTS.roleChars));
  assert.ok(Object.isFrozen(CREATIVE_DETAIL_COUNTS.emotionChars));
  const schema = createCreativeSchema();
  const start = schema.indexOf('\n{') + 1;
  const shape = JSON.parse(schema.slice(start, schema.indexOf('\n\n', start)));
  assert.match(shape.npc_updates[0].role, /complete identity label, at most 16 characters/);
  assert.match(shape.npc_updates[0].emotional_state, /current emotion, at most 18 characters/);
  assert.match(schema, /Neither label has a minimum to pad toward/);
  assert.match(CREATIVE_GUIDES.npc_updates, /role 是精简而完整的身份标签，不超过 16 字/);
  assert.match(CREATIVE_GUIDES.npc_updates, /emotional_state 用不超过 18 字的自然短语表达当前情绪/);
  assert.match(CREATIVE_GUIDES.npc_updates, /不堆履历、缘由或复合长句，也不为凑字数添词/);
  assert.doesNotMatch([CREATIVE_LAWS, CREATIVE_GUIDES.npc_updates, schema].join('\n'), /4–32|4–8|8–12/);
});
