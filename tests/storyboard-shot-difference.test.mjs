import assert from 'node:assert/strict';
import {
  STORYBOARD_SCHEMA_VERSION,
  evaluateStoryboardShotDifference,
  prepareStoryboardShotGroup,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 16);

const shot = (id, overrides = {}) => ({
  id,
  sourceParagraphIds: ['p1'],
  narrativePurpose: 'Alice listens to Bob explain the recipe.',
  shotRole: 'relationship',
  shotScale: 'medium_shot',
  subject: 'Alice and Bob',
  scene: 'restaurant kitchen',
  location: 'restaurant kitchen',
  characters: [{ id: 'Alice', name: 'Alice' }, { id: 'Bob', name: 'Bob' }],
  composition: { cameraSide: 'counter side', angle: 'eye level', focus: 'two-shot', framing: ['balanced two-shot'] },
  promptAtoms: {},
  ...overrides,
});

const base = shot('base');
const scaleOnly = shot('scale-only', { shotScale: 'close_up' });
const infoOnly = shot('info-only', { narrativePurpose: 'Alice realizes the missing ingredient changes the plan.' });
const valid = shot('valid', {
  sourceParagraphIds: ['p2'],
  narrativePurpose: 'Alice notices the knife trembling in Bob’s hand.',
  shotRole: 'detail',
  shotScale: 'insert',
  subject: 'Bob’s hand and the knife',
  composition: { cameraSide: 'counter side', angle: 'top down', focus: 'trembling hand', framing: ['tight insert'] },
});

assert.deepEqual(evaluateStoryboardShotDifference(base, scaleOnly).issues, ['no_narrative_increment'], '只换焦段但没有新信息仍属无效镜头');
assert.deepEqual(evaluateStoryboardShotDifference(base, infoOnly).issues, ['no_visual_variation'], '只换描述而画面组织不变仍须重规划');
const validDifference = evaluateStoryboardShotDifference(base, valid);
assert.equal(validDifference.acceptable, true);
assert.equal(validDifference.informationChanged, true);
assert.ok(validDifference.effectiveVisualChanges.includes('scale'));
assert.ok(validDifference.effectiveVisualChanges.includes('subject'));

const automatic = prepareStoryboardShotGroup({ shots: [base, scaleOnly, infoOnly, valid], maxShots: 4 });
assert.deepEqual(automatic.shots.map((item) => item.id), ['base', 'valid']);
assert.deepEqual(automatic.skipped.map((item) => item.reason), ['difference_budget', 'difference_budget']);
assert.ok(automatic.skipped.every((item) => item.requiresReplan), '自动镜组必须在创建生图任务前标记重规划');

const manual = prepareStoryboardShotGroup({ shots: [base, scaleOnly, infoOnly], maxShots: 1, manual: true });
assert.equal(manual.shots.length, 3, '用户手动补画不受自动差异预算拦截');

const transition = shot('street', { scene: 'rainy street', location: 'rainy street' });
assert.equal(evaluateStoryboardShotDifference(base, transition).acceptable, true, '换场镜头不应被同场差异预算拦截');

console.log('Storyboard shot difference budget contract OK');
