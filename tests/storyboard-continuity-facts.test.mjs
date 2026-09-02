import assert from 'node:assert/strict';
import {
  STORYBOARD_SCHEMA_VERSION,
  normalizeStoryboardContinuityLedger,
  normalizeStoryboardContinuityFact,
  prepareStoryboardShotGroup,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 17);

const legacy = normalizeStoryboardContinuityLedger({
  outfit: { Alice: 'black coat' },
  props: { umbrella: 'Alice' },
});
assert.equal(legacy.outfit.Alice, 'black coat', '旧版服装记录必须原样保留');
assert.equal(legacy.props.umbrella, 'Alice', '旧版道具记录必须原样保留');
assert.deepEqual(legacy.facts, [], '旧记录无需伪造连续性事实');

const deterministicA = normalizeStoryboardContinuityFact({ category: 'outfit', subject: 'Alice', key: 'outerwear', value: 'black coat on' });
const deterministicB = normalizeStoryboardContinuityFact({ category: 'outfit', subject: 'Alice', key: 'outerwear', value: 'black coat on' });
assert.equal(deterministicA.id, deterministicB.id, '相同事实必须得到稳定 ID');

const baseShot = {
  sourceParagraphIds: ['p1'], narrativePurpose: 'continuity test', shotRole: 'action', shotScale: 'medium_shot',
  subject: 'Alice', scene: 'restaurant kitchen', characters: [], composition: {}, promptAtoms: {},
};
const sequence = prepareStoryboardShotGroup({
  manual: true,
  maxShots: 4,
  shots: [
    { ...baseShot, id: 'shot-1', continuityUpdates: { facts: [
      { id: 'coat-on', category: 'outfit', subject: 'Alice', key: 'outerwear', value: 'black coat on', persistence: 'persistent' },
      { id: 'glance', category: 'action', subject: 'Alice', key: 'gesture', value: 'glances at Bob', persistence: 'momentary' },
    ] } },
    { ...baseShot, id: 'shot-2', narrativePurpose: 'hold the conversation', shotRole: 'relationship' },
    { ...baseShot, id: 'shot-3', narrativePurpose: 'continue after cooking', continuityUpdates: { facts: [
      { id: 'coat-off', category: 'outfit', subject: 'Alice', key: 'outerwear', value: 'black coat removed', persistence: 'persistent', evidence: 'Alice takes off her coat.' },
    ] } },
  ],
});

const facts = Object.fromEntries(sequence.continuityLedger.facts.map((fact) => [fact.id, fact]));
assert.equal(facts['coat-on'].status, 'superseded', '同一人物同一服装槽位的旧事实必须被后续事实替代');
assert.equal(facts['coat-on'].replacedBy, 'coat-off');
assert.equal(facts['coat-off'].status, 'active');
assert.deepEqual(facts['coat-off'].supersedes, ['coat-on']);
assert.equal(facts.glance.status, 'expired', '瞬时动作不得跨镜头继续生效');

const roundTrip = normalizeStoryboardContinuityLedger(sequence.continuityLedger);
assert.deepEqual(roundTrip.facts, sequence.continuityLedger.facts, '连续性事实必须可稳定序列化并再次读取');

console.log('Storyboard continuity fact lifecycle contract OK');
