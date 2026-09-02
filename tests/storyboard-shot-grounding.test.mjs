import assert from 'node:assert/strict';
import {
  STORYBOARD_SCHEMA_VERSION,
  normalizeStoryboardShotSpec,
  prepareStoryboardShotGroup,
  validateStoryboardShotGrounding,
} from '../qianmu-storyboard.js';

assert.equal(STORYBOARD_SCHEMA_VERSION, 22);

const grounded = normalizeStoryboardShotSpec({
  id: 'flower',
  sourceParagraphIds: ['p7'],
  narrativeLayer: 'present',
  narrativePurpose: '用桌上被雨打落的一朵花承接两人谈话后的冷场。',
  shotPattern: 'insert',
  shotRole: 'detail',
  shotScale: 'insert',
  subjectKind: 'object',
  subject: 'a rain-beaten flower on the table',
  scene: 'restaurant kitchen',
  location: 'restaurant kitchen',
  composition: { focus: 'flower', angle: 'table level' },
  evidence: { type: 'explicit', paragraphIds: ['p7'], quote: '一朵沾雨的花倒在餐桌边。' },
  promptAtoms: {},
});
assert.equal(grounded.visualDuty, 'detail');
assert.equal(grounded.subjectKind, 'object');
assert.deepEqual(grounded.sourceParagraphIds, ['p7']);
assert.equal(validateStoryboardShotGrounding(grounded, { strict: true }).valid, true);

const symbolic = {
  ...grounded,
  id: 'symbolic',
  sourceParagraphIds: ['p8'],
  shotPattern: 'atmosphere',
  visualDuty: 'motif',
  subjectKind: 'symbolic',
  subject: 'steam dissolving between two empty chairs',
  narrativePurpose: '把关系疏离转化为不新增事实的视觉母题。',
  evidence: { type: 'symbolic', paragraphIds: ['p8'], quote: '两人都没有再说话。', rationale: '蒸汽消散只表达沉默与距离，不代表新剧情事件。' },
};
assert.equal(validateStoryboardShotGrounding(symbolic, { strict: true }).valid, true, '有证据与说明的意象表达必须被允许');

const invented = {
  ...grounded,
  id: 'invented',
  sourceParagraphIds: [],
  subjectKind: 'environment',
  visualDuty: 'atmosphere',
  narrativePurpose: '',
  evidence: { type: 'inferred', paragraphIds: [], quote: '', rationale: '' },
};
const invalid = validateStoryboardShotGrounding(invented, { strict: true });
assert.equal(invalid.valid, false);
assert.match(invalid.errors.join('\n'), /正文段落或原文证据/);
assert.match(invalid.errors.join('\n'), /叙事目的/);

const automatic = prepareStoryboardShotGroup({ shots: [invented], maxShots: 1 });
assert.equal(automatic.shots.length, 0);
assert.equal(automatic.skipped[0].reason, 'ungrounded_shot');
assert.equal(automatic.skipped[0].requiresReplan, true);

const manual = prepareStoryboardShotGroup({ shots: [invented], maxShots: 1, manual: true });
assert.equal(manual.shots.length, 1, '手动导演选择保留覆盖权');

console.log('Storyboard shot grounding contract OK');
