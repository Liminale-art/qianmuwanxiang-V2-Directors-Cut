import assert from 'node:assert/strict';
import {
  STORYBOARD_SCHEMA_VERSION,
  evaluateStoryboardShotRhythm,
  planStoryboardStaticSceneRhythm,
  prepareStoryboardShotGroup,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 21);

const dialogue = planStoryboardStaticSceneRhythm({
  sceneType: 'dialogue', castIds: ['Alice', 'Bob'], axis: 'kitchen counter', maxShots: 6,
});
assert.deepEqual(dialogue.beats.map((beat) => beat.pattern), ['master', 'two_shot', 'over_shoulder', 'single_reaction', 'insert', 'atmosphere']);
assert.deepEqual(dialogue.beats[0].subjectIds, ['Alice', 'Bob']);
assert.deepEqual(dialogue.beats[2].foregroundIds, ['Alice']);
assert.deepEqual(dialogue.beats[2].subjectIds, ['Bob']);
assert.equal(dialogue.guidance.thirtyDegreeRule, 'heuristic', '30° 变化只能作为启发式建议');
assert.equal(dialogue.guidance.axisContinuity, true);

const continued = planStoryboardStaticSceneRhythm({ sceneType: 'dialogue', castIds: ['Alice', 'Bob'], maxShots: 3, sceneContinuation: true, lastPattern: 'master' });
assert.notEqual(continued.beats[0].pattern, 'master', '跨楼层续接不得机械重复上一镜节拍');

const base = {
  sourceParagraphIds: ['p1'], scene: 'restaurant kitchen', location: 'restaurant kitchen', narrativeLayer: 'present',
  characters: [{ id: 'Alice', name: 'Alice' }, { id: 'Bob', name: 'Bob' }], promptAtoms: {}, composition: {},
};
const shots = [
  { ...base, id: 'master', shotPattern: 'master', shotRole: 'establishing', shotScale: 'wide_shot', subject: 'Alice and Bob', narrativePurpose: 'establish their places', continuityUpdates: { axis: 'kitchen counter' } },
  { ...base, id: 'ots', sourceParagraphIds: ['p2'], shotPattern: 'over_shoulder', shotRole: 'relationship', shotScale: 'medium_close_up', subject: 'Bob', narrativePurpose: 'Bob explains the recipe', composition: { cameraSide: 'axis_side_a', framing: ['Alice shoulder foreground'] }, continuityUpdates: { axis: 'kitchen counter' } },
  { ...base, id: 'insert', sourceParagraphIds: ['p3'], shotPattern: 'insert', shotRole: 'detail', shotScale: 'insert', subject: 'knife and vegetables', narrativePurpose: 'the knife pauses over the missing ingredient', composition: { angle: 'top_down', focus: 'hands and knife' }, continuityUpdates: { axis: 'kitchen counter' } },
];
const rhythm = evaluateStoryboardShotRhythm(shots);
assert.equal(rhythm.valid, true);
assert.equal(rhythm.coverage.spatial, true);
assert.equal(rhythm.coverage.relationship, true);
assert.equal(rhythm.coverage.detail, true);

const repeated = evaluateStoryboardShotRhythm([shots[1], { ...shots[1], id: 'ots-copy', sourceParagraphIds: ['p4'], narrativePurpose: 'Alice asks a follow-up question' }]);
assert.equal(repeated.valid, false);
assert.equal(repeated.violations[0].code, 'repeated_pattern');

const prepared = prepareStoryboardShotGroup({ shots, maxShots: 4 });
assert.deepEqual(prepared.rhythm.patterns, ['master', 'over_shoulder', 'insert']);

console.log('Storyboard static-scene rhythm contract OK');
