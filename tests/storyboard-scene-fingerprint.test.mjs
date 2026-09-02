import assert from 'node:assert/strict';
import {
  STORYBOARD_SCHEMA_VERSION,
  buildStoryboardSceneCoverageMap,
  compareStoryboardSceneFingerprints,
  normalizeStoryboardSceneFingerprint,
  prepareStoryboardShotGroup,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 19);

const kitchenA = normalizeStoryboardSceneFingerprint({
  location: 'restaurant kitchen', time: 'evening', narrativeLayer: 'present', castIds: ['Alice', 'Bob'], anchors: ['floor-10'],
});
const kitchenB = normalizeStoryboardSceneFingerprint({
  location: 'restaurant kitchen', time: 'evening', narrativeLayer: 'present', castIds: ['Alice'], anchors: ['floor-11'],
});
assert.equal(compareStoryboardSceneFingerprints(kitchenA, kitchenB).sameScene, true, '跨楼层仍在同一地点时必须允许延续场景');

const street = normalizeStoryboardSceneFingerprint({
  location: 'rainy street', time: 'evening', narrativeLayer: 'present', castIds: ['Alice', 'Bob'],
});
assert.equal(compareStoryboardSceneFingerprints(kitchenA, street).sameScene, false, '相同角色换地点不得误判为同场');

const castOnlyA = normalizeStoryboardSceneFingerprint({ castIds: ['Alice', 'Bob'] });
const castOnlyB = normalizeStoryboardSceneFingerprint({ castIds: ['Alice', 'Bob'] });
assert.equal(compareStoryboardSceneFingerprints(castOnlyA, castOnlyB).sameScene, false, '角色集合不能单独决定场景延续');

const memory = normalizeStoryboardSceneFingerprint({ location: 'restaurant kitchen', narrativeLayer: 'memory', castIds: ['Alice'] });
assert.equal(compareStoryboardSceneFingerprints(kitchenA, memory).sameScene, false, '回忆与当下必须分属不同叙事场');

const shot = (id, scene, location, overrides = {}) => ({
  id, sourceParagraphIds: [id], narrativePurpose: 'Alice prepares dinner', shotRole: 'action', shotScale: 'medium_shot',
  subject: 'Alice', scene, location, characters: [{ id: 'Alice', name: 'Alice' }], composition: {}, promptAtoms: {}, ...overrides,
});
const grouped = prepareStoryboardShotGroup({
  maxShots: 4,
  shots: [
    shot('kitchen-1', 'Alice cooks in the restaurant kitchen.', 'restaurant kitchen'),
    shot('street-1', 'Alice walks on a rainy street.', 'rainy street'),
  ],
});
assert.equal(grouped.shots.length, 2, '不同场景中的相同人物与职责不得被旧粗略签名去重');
assert.equal(grouped.sceneGroups.length, 2, '换场必须产生新的连续场景组');
assert.equal(grouped.coverageMap[1].transition, true);
assert.ok(grouped.coverageMap[1].transitionReasons.includes('location_changed'));

const coverage = buildStoryboardSceneCoverageMap([
  shot('wide', 'restaurant kitchen', 'restaurant kitchen', { shotRole: 'establishing', shotScale: 'wide_shot', narrativePurpose: 'establish the cooking space' }),
  shot('hands', 'restaurant kitchen', 'restaurant kitchen', { shotRole: 'detail', shotScale: 'insert', subject: 'hands slicing vegetables', narrativePurpose: 'show the decisive cut', composition: { angle: 'top_down', focus: 'knife and hands' } }),
]);
assert.equal(coverage[1].transition, false);
assert.equal(coverage[1].informationChanged, true);
assert.ok(coverage[1].visualChanges.includes('scale'));
assert.equal(coverage[1].duplicateCoverage, false);

console.log('Storyboard scene fingerprint and coverage map contract OK');
