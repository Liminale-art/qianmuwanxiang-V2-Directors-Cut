import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWorldHeat, heatTier, geoRelationClass, geoRelationLabel } from '../qianmu-storyboard-utils.js';

test('world temperature describes changing conditions without a genre-specific verdict', () => {
  const tiers = [
    [0, 19, 'calm', '平缓', '局面变化较少'],
    [20, 44, 'undercurrent', '起伏', '变化开始交织'],
    [45, 71, 'turmoil', '升温', '各方牵动加深'],
    [72, 100, 'boil', '高涨', '多重变化集中交汇'],
  ];
  for (const [min, max, key, label, desc] of tiers) for (const heat of [min, max]) {
    assert.deepEqual(heatTier(heat), { key, label, desc });
  }
});

test('relation display mapping never changes stored kinds, heat, direction or graph classes', () => {
  const kinds = ['冲突', '同盟', '张力', '中立', '依附'];
  assert.deepEqual(kinds.map(geoRelationLabel), ['冲突', '协作', '张力', '中立', '依赖']);
  assert.deepEqual(kinds.map(geoRelationClass), ['conflict', 'ally', 'tension', 'neutral', 'vassal']);
  const relations = kinds.map((kind, index) => ({ kind, a: 'a', b: String(index) }));
  const before = structuredClone(relations);
  assert.equal(computeWorldHeat(relations, []), 36);
  assert.deepEqual(relations, before);
  assert.equal(geoRelationLabel('旧自定义关系'), '旧自定义关系');
});
