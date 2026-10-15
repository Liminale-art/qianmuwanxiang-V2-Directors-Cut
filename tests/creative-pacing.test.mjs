import test from 'node:test';
import assert from 'node:assert/strict';
import { CREATIVE_LAWS, CREATIVE_BLUEPRINT, CREATIVE_GUIDES, CREATIVE_COUNTS, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import { createCreativeSchema } from '../qianmu-creative-contract.js';

// These checks keep approved instructions consistent. They do not score generated
// fiction or claim that a model will obey a scene's intended pacing.
test('genre-neutral trajectory examples permit promises and opportunities without requiring a crime or sealed clue', () => {
  assert.match(CREATIVE_GUIDES.story_status, /承诺兑现、错过、转向、支线并行或关系重组/);
  assert.match(CREATIVE_GUIDES.story_status, /具体选择、尚待回应的约定、新机会或改变后的处境/);
  assert.match(CREATIVE_GUIDES.story_status, /另一方的回应、利益或限制介入/);
  assert.doesNotMatch(CREATIVE_GUIDES.story_status, /再次犯案|未拆开的证物|未启封|钩子与压力/);
  assert.doesNotMatch(CREATIVE_BLUEPRINT, /案件进展顺利/);
  assert.match(CREATIVE_LAWS, /Neither a dark turn nor a reassuring outcome is mandatory/);
});

test('a one-night adventure may place far at a later phase of the same night, not a compulsory week-scale jump', () => {
  for (const text of [CREATIVE_BLUEPRINT, CREATIVE_GUIDES.story_status]) {
    assert.match(text, /far 则从相对 near 更晚的叙事阶段或门槛展开/);
    assert.match(text, /跨度依据主线节奏与因果，不预设必须跨越数周数月/);
    assert.doesNotMatch(text, /更晚节点（数周、数月、季节或更久）/);
  }
  assert.deepEqual(CREATIVE_COUNTS.story_status, { min: 2, max: 2 });
  assert.match(CREATIVE_GUIDES.story_status, /不同的时态与因果重心/);
  assert.match(createCreativeSchema(), /exactly one horizon near and one horizon far/);
  assert.match(createCreativeSchema(), /Far-range trajectory anchored to a named later phase or threshold/);
});

test('a changed commitment or available choice can carry quiet progress; finer gestures alone cannot', () => {
  assert.match(CREATIVE_LAWS, /A small shift in trust, commitment, understanding, or choice counts when it materially changes subsequent possibilities or conditions/);
  assert.match(CREATIVE_LAWS, /ensemble view of intersecting actions and their consequences/);
  assert.match(CREATIVE_LAWS, /not by subdividing glances, gestures, or phrasing/);
  assert.match(CREATIVE_BLUEPRINT, /各方行动的交错、阶段性后果和新条件/);
  assert.match(CREATIVE_BLUEPRINT, /信任、承诺或认知的细小变化，须实际改变后续选择或条件才有推演价值/);
  assert.match(CREATIVE_GUIDES.story_status, /局面出现可验证的新条件/);
  assert.match(CREATIVE_LAWS, /Every run must supply developments beyond the input's existing stopping point/);
});

test('unchanged meals, sleep and transit compress, and an established montage continues from its endpoint', () => {
  assert.match(CREATIVE_LAWS, /time skips or montage in the source: continue from their latest endpoint rather than replay the skipped interval/);
  assert.match(CREATIVE_LAWS, /follow the story's pace and causal requirements: compress meals, sleep, waiting, or travel that add no meaningful change/);
  assert.match(CREATIVE_BLUEPRINT, /无实质变化的吃饭、睡觉、等待和赶路压缩带过/);
  assert.match(CREATIVE_BLUEPRINT, /正文已用概述或蒙太奇跨过的时段，直接承接其新落点/);
  assert.match(CREATIVE_LAWS, /This does not move the mainline clock or complete an unresolved USER decision/);
  assert.match(CREATIVE_BLUEPRINT, /不跳过 \{\{user\}\} 的未决选择/);
});

test('overhead development preserves local preview prose and does not turn living voices or phone pages into plot quotas', () => {
  assert.match(CREATIVE_BLUEPRINT, /预演落笔等局部片段按栏目职责保留，不代替俯瞰走向/);
  assert.match(CREATIVE_GUIDES.quests, /落笔写场景已经开始的第一拍/);
  assert.match(CREATIVE_GUIDES.npc_updates, /每段与姓名前缀独立可读/);
  assert.match(CREATIVE_GUIDES.world_chatter, /这里的价值是生活的声音与人情，不要求藏线索、送情报或推动案件/);
  assert.match(CREATIVE_GUIDES.interlude, /主要话题从说话者自己的生活需求、闲趣和分歧中取材/);
  assert.match(CREATIVE_LAWS, /Situated human speech in 尘寰群生 may instead reveal temperament, an ordinary concern, or a way of living, without supplying a clue or new plot condition/);
  assert.match(CREATIVE_LAWS, /Other sections add distinct information according to their purpose/);
});

test('the normal request includes the revised pacing without weakening USER agency, independent actors or source boundaries', () => {
  const guidance = creativeSectionGuidance({ interludeType: 'forum' });
  assert.ok(guidance.includes(CREATIVE_GUIDES.story_status));
  assert.match(guidance, /至少一条从非 \{\{user\}\}、非 \{\{char\}\} 的人物或群体开始/);
  assert.match(CREATIVE_LAWS, /Do not decide \{\{user\}\}'s thoughts, emotions, positions, or actions/);
  assert.match(CREATIVE_LAWS, /That source supports only the connection it actually establishes/);
  assert.match(CREATIVE_LAWS, /one invented card cannot serve as evidence for another/);
  assert.match(CREATIVE_LAWS, /Do not write these side stories into mainline memory, continuity references, or narrative injection/);
  assert.deepEqual(CREATIVE_COUNTS.quests, { min: 5 });
  assert.deepEqual(CREATIVE_COUNTS.character_dynamics, { min: 2 });
  assert.deepEqual(CREATIVE_COUNTS.npc_updates, { min: 3 });
});
