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
  assert.equal(digest(CREATIVE_LAWS), '69c59a415c4b91466429d51642cd66f58352df61398e844d6faaddcad42276c7');
  assert.equal(digest(CREATIVE_BLUEPRINT), '1f7c02a2ab51647f6cef2f72b599fd1fc1925562e4ae850b4af90fd7abdeb75b');
  assert.equal(digest(JSON.stringify(CREATIVE_GUIDES)), 'c8796895a675c1d451cc951f5dc8de7b9f810aac92a422ec3582cfc5356270af');
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
  assert.match(CREATIVE_GUIDES.quests, /每条必须提供一个正文现有落点之外的新切入口/);
  assert.match(CREATIVE_GUIDES.character_dynamics, /只以本聊天的 CHAR 为动态主体/);
  assert.match(CREATIVE_GUIDES.character_dynamics, /群聊中的多个 CHAR/);
  assert.match(CREATIVE_GUIDES.npc_updates, /至少一条即使暂时移除主角也能成立/);
  assert.match(CREATIVE_GUIDES.chain_reactions, /至少延伸出一项正文尚未发生的后续影响/);
  assert.match(CREATIVE_GUIDES.relation_undercurrents, /既有配角关系具备展开空间时/);
  assert.match(CREATIVE_LAWS, /A changed viewpoint, title, or emotional metaphor alone does not make a retelling new content/);
  assert.match(CREATIVE_LAWS, /Do not turn an ordinary remark, coincidence, or lack of information into evidence of guilt, a conspiracy/);
  assert.match(CREATIVE_LAWS, /Neither a dark turn nor a reassuring outcome is mandatory/);
  assert.match(CREATIVE_LAWS, /excluding USER; 其他人物动向: at least 3 entries about other non-USER, non-CHAR people/);
});

test('count source is frozen and rendered in approved laws without an invented world echo quota', () => {
  assert.ok(Object.isFrozen(CREATIVE_COUNTS));
  for (const count of Object.values(CREATIVE_COUNTS)) assert.ok(Object.isFrozen(count));
  assert.deepEqual(Object.fromEntries(Object.entries(CREATIVE_COUNTS).map(([key, value]) => [key, value.min])), {
    quests: 5, character_dynamics: 2, npc_updates: 3, chain_reactions: 3, relation_undercurrents: 3,
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
  for (const type of ['theater', 'phone']) {
    const result = creativeSectionGuidance({ interludeType: type });
    assert.ok(result.includes(CREATIVE_GUIDES.parallel_scene));
    assert.ok(result.includes(CREATIVE_GUIDES.interlude));
    assert.ok(result.includes(CREATIVE_GUIDES[type]));
    assert.ok(!result.includes(CREATIVE_GUIDES[type === 'theater' ? 'phone' : 'theater']));
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
  assert.ok(!result.includes(CREATIVE_GUIDES.theater));
  assert.ok(!result.includes(CREATIVE_GUIDES.phone));
  for (const key of ['character_dynamics', 'npc_updates', 'quests', 'chain_reactions', 'relation_undercurrents']) assert.ok(result.includes(CREATIVE_GUIDES[key]));
});

test('caller must fix one interlude form; pure guide never silently selects or repairs it', () => {
  for (const type of [undefined, null, '', 'both', 'mobile']) assert.throws(() => creativeSectionGuidance({ interludeType: type }), { code: 'creative_interlude_type_required' });
  const options = Object.freeze({ interludeType: 'phone' });
  assert.equal(creativeSectionGuidance(options), creativeSectionGuidance(options));
  assert.doesNotThrow(() => creativeSectionGuidance({ interludeEnabled: false }));
});
