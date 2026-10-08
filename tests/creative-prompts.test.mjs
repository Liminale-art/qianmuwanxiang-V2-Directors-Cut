import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CREATIVE_IDENTITY, CREATIVE_LAWS, CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT,
  CREATIVE_GUIDES, CREATIVE_COUNTS, CREATIVE_SECTION_LABELS, creativeSectionGuidance,
} from '../qianmu-creative-prompts.js';

const digest = value => createHash('sha256').update(value).digest('hex');

test('Chinese identity stays exact while progression laws and guides remain separately reviewable', () => {
  assert.equal(digest(CREATIVE_IDENTITY), '03765b3a9e8a4c0172833df171204d23832521b286866796f43a5df21110960e');
  assert.equal(digest(CREATIVE_LAWS), 'a96b4e3d89f7483d25c288a405ae63031481f815a39f6c006cb9b4e0d31be1b2');
  assert.equal(digest(CREATIVE_BLUEPRINT), 'a8321a5e49a730406cae2ef5616d7a78c4bbce3950def2c8923a0ba69fe35a97');
  assert.equal(digest(JSON.stringify(CREATIVE_GUIDES)), 'e42bddfb17c54df84ef18a7b914a9795ba85278f7f5727ee1c38e20b6165d85a');
  assert.equal(CREATIVE_SYSTEM_PROMPT, `## Code of Being\n\n${CREATIVE_IDENTITY}\n\n## Laws of the Ensemble\n\n${CREATIVE_LAWS}`);
  assert.equal(CREATIVE_SECTION_LABELS.character_dynamics, '此间一人');
});

test('progression is mandatory without declaring candidates real or taking USER agency', () => {
  assert.match(CREATIVE_LAWS, /Every run must supply developments beyond the input's existing stopping point/);
  assert.match(CREATIVE_LAWS, /Each encounter must introduce a new, actionable opening/);
  assert.match(CREATIVE_LAWS, /Each CHAR entry must carry one of CHAR's own affairs into a concrete action or consequential next step/);
  assert.match(CREATIVE_LAWS, /Each ripple must extend its cause into a downstream consequence beyond the already narrated chain/);
  assert.match(CREATIVE_LAWS, /Candidate status controls whether a development is established in the mainline, not whether it is written concretely/);
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
  assert.match(CREATIVE_LAWS, /excluding USER; 其他人物动向: at least 3 entries about other non-USER, non-CHAR people/);
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
  assert.match(CREATIVE_GUIDES.chain_reactions, /至少一条体现横向广度/);
  assert.match(CREATIVE_GUIDES.relation_undercurrents, /不能加入第三人规避/);
  assert.match(CREATIVE_GUIDES.world_chatter, /不要求藏线索、送情报或推动案件/);
  assert.match(CREATIVE_LAWS, /Situated human speech in 尘寰群生 may instead reveal temperament, an ordinary concern, or a way of living, without supplying a clue or new plot condition/);
  assert.match(CREATIVE_GUIDES.world_chatter, /纯天气、景色、机械声和动物反应不占名额/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /过去、近未来或遥远未来/);
  assert.match(CREATIVE_GUIDES.parallel_scene, /无须标题/);
  assert.match(CREATIVE_GUIDES.interlude, /所有字段只写安全纯文本，不输出 HTML/);
  assert.match(CREATIVE_GUIDES.interlude, /不固定围绕阴谋、热搜或主角点评/);
  assert.match(CREATIVE_GUIDES.phone, /配角、路人和其他已有姓名者/);
  assert.match(CREATIVE_GUIDES.phone, /已知人物确实有限时自然复用/);
  assert.match(CREATIVE_GUIDES.phone, /群聊时就是群名.*私聊时就是对方的联系人显示名/);
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
