import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CREATIVE_IDENTITY, CREATIVE_LAWS, CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT,
  CREATIVE_GUIDES, CREATIVE_COUNTS, CREATIVE_SECTION_LABELS, creativeSectionGuidance,
} from '../qianmu-creative-prompts.js';

const digest = value => createHash('sha256').update(value).digest('hex');

test('approved identity, laws, blueprint and guide bodies retain their reviewed text', () => {
  assert.equal(digest(CREATIVE_IDENTITY), '03765b3a9e8a4c0172833df171204d23832521b286866796f43a5df21110960e');
  assert.equal(digest(CREATIVE_LAWS), '3abadfe81c33689e24038cc367d9609a54bf2b1017f1998120861f91c0001260');
  assert.equal(digest(CREATIVE_BLUEPRINT), '05fe16a12a9532f018685009a9c4eaa1f4f29fb9aef50ca778eb78459553dc76');
  assert.equal(digest(JSON.stringify(CREATIVE_GUIDES)), 'a77f2eb0894ce463f66e4efe2523662b52588ba90437f610d0b4a071b63325de');
  assert.equal(CREATIVE_SYSTEM_PROMPT, `## 千幕身份\n\n${CREATIVE_IDENTITY}\n\n## 剧组之律\n\n${CREATIVE_LAWS}`);
  assert.equal(CREATIVE_SECTION_LABELS.character_dynamics, '此间一人');
});

test('count source is frozen and rendered in approved laws without an invented world echo quota', () => {
  assert.ok(Object.isFrozen(CREATIVE_COUNTS));
  for (const count of Object.values(CREATIVE_COUNTS)) assert.ok(Object.isFrozen(count));
  assert.deepEqual(Object.fromEntries(Object.entries(CREATIVE_COUNTS).map(([key, value]) => [key, value.min])), {
    quests: 5, character_dynamics: 2, npc_updates: 3, chain_reactions: 3, relation_undercurrents: 3,
    world_chatter: 8, factions: 3, world_events: 2, parallel_scene: 1, interlude: 1,
  });
  assert.ok(!Object.hasOwn(CREATIVE_COUNTS, 'world_updates'));
  assert.ok(CREATIVE_LAWS.includes(`此间一人：至少 ${CREATIVE_COUNTS.character_dynamics.min} 条`));
  assert.ok(CREATIVE_LAWS.includes(`尘寰群生：${CREATIVE_COUNTS.world_chatter.min}–${CREATIVE_COUNTS.world_chatter.max}`));
  assert.ok(CREATIVE_LAWS.includes(`世界格局：${CREATIVE_COUNTS.factions.min}–${CREATIVE_COUNTS.factions.max}`));
  assert.ok(CREATIVE_LAWS.includes(`${CREATIVE_COUNTS.world_events.min}–${CREATIVE_COUNTS.world_events.max} 项局势`));
});

test('runtime prose excludes private editorial notes and superseded occupational framing', () => {
  const result = [CREATIVE_SYSTEM_PROMPT, CREATIVE_BLUEPRINT, ...Object.values(CREATIVE_GUIDES)].join('\n');
  assert.doesNotMatch(result, /接入与同步说明|后续接入复核要点|待用户校|待审|D:[/\\]|你是.*(?:剧作家|导演)/);
  assert.match(CREATIVE_LAWS, /与已知事实相容的往事/);
  assert.match(CREATIVE_LAWS, /不冒称正文或记忆早有记载/);
  assert.match(CREATIVE_LAWS, /禁止替 \{\{user\}\} 决定思想、情绪、立场与行动/);
  assert.match(CREATIVE_LAWS, /禁止将这些番外写入主线记忆、连续性参考或正文注入/);
  assert.match(CREATIVE_GUIDES.phone, /排除 \{\{user\}\} 及其别名与身份映射/);
  assert.match(CREATIVE_GUIDES.phone, /不得借转发、截图或他人复述/);
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
