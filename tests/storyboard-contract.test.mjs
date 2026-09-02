import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_CONTRACT_MAX_BYTES,
  STORYBOARD_PLAN_RESPONSE_SCHEMA,
  STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  STORYBOARD_SAFETY_RESPONSE_SCHEMA,
  STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,
  adaptStoryboardPlanContract,
  formatStoryboardContractErrors,
  parseStoryboardContractJson,
  parseStoryboardContractResponse,
  validateStoryboardPlanContract,
  validateStoryboardSafetyContract,
} from '../qianmu-storyboard-contract.js';
import { compileStoryboardPrompt } from '../qianmu-storyboard.js';

const character = (id, x, overrides = {}) => ({
  character_id: id,
  name: id === 'character-a' ? '角色A' : '角色B',
  fixed_identity: id === 'character-a' ? ['silver hair'] : ['black hair'],
  current_state: {
    outfit: ['current coat'],
    expression: ['hesitant'],
    pose: ['seated'],
    action: ['pressing an envelope'],
    gaze: ['looking at the envelope'],
    props: ['envelope'],
  },
  spatial: {
    order: id === 'character-a' ? 1 : 2,
    region: id === 'character-a' ? 'center-left' : 'center-right',
    center: { x, y: 0.52 },
    visible_crop: 'hands-and-lower-face',
  },
  ...overrides,
});

const shot = (overrides = {}) => ({
  source_paragraph_ids: ['P2'],
  insert_after: 'P2',
  narrative_layer: 'present',
  narrative_purpose: '表现人物独处时的迟疑',
  shot_role: 'reaction',
  shot_scale: 'close_up',
  subject: '角色A的手指停在未寄出的信上',
  scene: {
    location: '书桌旁',
    time: '夜晚',
    lighting: ['台灯侧光'],
    environment: ['未寄出的信', '窗外雨痕'],
  },
  characters: [character('character-a', 0.38)],
  shared_relations: [],
  composition: {
    ratio_id: '3:2',
    orientation: 'landscape',
    intent: '保留信封前方的负空间',
    continuity_key: 'scene-12',
  },
  prompt_atoms: {
    global: ['night interior', 'desk', 'side lighting'],
    character_ids: ['character-a'],
    scene_negative: ['extra people'],
  },
  sensitive: false,
  safety_notes: [],
  ...overrides,
});

const plan = (overrides = {}) => ({
  schema: STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  should_generate: true,
  skip_reason: '',
  shots: [shot()],
  continuity_updates: [{
    category: 'prop',
    subject: 'character-a',
    key: 'held-object',
    value: '未寄出的信封',
    persistence: 'persistent',
    source_paragraph_ids: ['P2'],
    evidence: '角色A的手指压住信封',
  }],
  decisions: ['选择单人回忆落点'],
  ...overrides,
});

const validationOptions = {
  allowedParagraphIds: ['P1', 'P2', 'P3'],
  allowedCharacterIds: ['character-a', 'character-b'],
  allowedRatioIds: ['3:2', '2:3'],
  characterTermsById: {
    'character-a': ['silver hair', 'pressing an envelope'],
    'character-b': ['black hair', 'holding a cup'],
  },
};

assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.additionalProperties, false);
assert.equal(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.maxItems, 4);
assert.equal(Object.isFrozen(STORYBOARD_PLAN_RESPONSE_SCHEMA.properties.shots.items), true);
assert.equal(STORYBOARD_SAFETY_RESPONSE_SCHEMA.additionalProperties, false);
assert.equal(STORYBOARD_CONTRACT_MAX_BYTES, 256 * 1024);

const valid = validateStoryboardPlanContract(plan(), validationOptions);
assert.equal(valid.ok, true, formatStoryboardContractErrors(valid.errors));

const fenced = parseStoryboardContractResponse(`\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``, validationOptions);
assert.equal(fenced.ok, true, formatStoryboardContractErrors(fenced.errors));
assert.equal(fenced.kind, 'plan');

const adapted = adaptStoryboardPlanContract(fenced.data, {
  paragraphIndexById: { P1: 0, P2: 1, P3: 2 },
});
assert.equal(adapted.shots[0].paragraph_index, 1);
assert.equal(adapted.shots[0].shotSpec.narrativeLayer, 'present');
assert.equal(adapted.shots[0].shotSpec.shotScale, 'close_up');
assert.equal(adapted.shots[0].shotSpec.composition.ratioId, '3:2');
assert.deepEqual(adapted.shots[0].shotSpec.characters[0].identity, ['silver hair']);
assert.deepEqual(adapted.shots[0].shotSpec.characters[0].spatial.center, [0.38, 0.52]);
assert.equal(adapted.shots[0].shotSpec.characters[0].spatial.crop, 'detail');
assert.deepEqual(adapted.shots[0].shotSpec.promptAtoms.negative, ['extra people']);
assert.equal(adapted.shots[0].shotSpec.continuityUpdates.facts[0].value, '未寄出的信封');
assert.ok(adapted.shots[0].shotSpec.id === '', 'the adapter must not mint a reusable cross-plan shot id');
const compiled = compileStoryboardPrompt({
  providerId: 'novel',
  modelId: 'nai-diffusion-5-full',
  shot: adapted.shots[0].shotSpec,
});
assert.doesNotMatch(compiled.prompt, /silver hair/, 'character-exclusive identity must stay outside the public NAI V5 caption');
assert.match(compiled.characterBlocks[0], /silver hair/, 'character identity must enter its own NAI V5 character caption');

const validSkip = validateStoryboardPlanContract(plan({
  should_generate: false,
  skip_reason: '没有新增的视觉信息',
  shots: [],
}), validationOptions);
assert.equal(validSkip.ok, true, formatStoryboardContractErrors(validSkip.errors));

const safety = {
  schema: STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,
  preserved_narrative_purpose: '保留关系变化',
  replacement_visual: '两人隔着雨幕对望',
  character_updates: [{
    character_id: 'character-a',
    outfit: ['buttoned coat'],
    expression: ['restrained'],
    pose: ['standing'],
    action: ['turning away'],
    gaze: ['toward the window'],
    props: [],
  }],
  prompt_atoms: { global: ['rainy window'], scene_negative: ['explicit content'] },
  adaptation_note: '以安全意象替代表现',
};
assert.equal(validateStoryboardSafetyContract(safety, validationOptions).ok, true);
assert.equal(parseStoryboardContractResponse(JSON.stringify(safety), validationOptions).kind, 'safety');

const narration = parseStoryboardContractJson(`以下是结果：\n${JSON.stringify(plan())}`);
assert.equal(narration.ok, false, 'strict contract parser must reject prose outside JSON');
assert.equal(narration.errors[0].code, 'json_syntax');
const missingComma = parseStoryboardContractJson('{"schema":"qianmu.storyboard.plan.v1" "shots":[]}');
assert.equal(missingComma.ok, false, 'contract parser must not guess missing punctuation');
assert.equal(parseStoryboardContractJson('x'.repeat(STORYBOARD_CONTRACT_MAX_BYTES + 1)).errors[0].code, 'max_bytes');

const unknownRoot = validateStoryboardPlanContract({ ...plan(), explanation: 'hidden reasoning' }, validationOptions);
assert.equal(unknownRoot.ok, false);
assert.ok(unknownRoot.errors.some((entry) => entry.code === 'additional_property' && entry.path === '$.explanation'));

const wrongParagraph = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P99'], insert_after: 'P99' })],
}), validationOptions);
assert.ok(wrongParagraph.errors.some((entry) => entry.code === 'unknown_paragraph'));
assert.ok(wrongParagraph.errors.some((entry) => entry.code === 'unknown_insert_anchor'));

const wrongContinuityParagraph = validateStoryboardPlanContract(plan({
  continuity_updates: [{ ...plan().continuity_updates[0], source_paragraph_ids: ['P404'] }],
}), validationOptions);
assert.ok(wrongContinuityParagraph.errors.some((entry) => entry.code === 'unknown_paragraph' && entry.path.startsWith('$.continuity_updates')));

const mismatchedAnchor = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P1'], insert_after: 'P2' })],
}), validationOptions);
assert.ok(mismatchedAnchor.errors.some((entry) => entry.code === 'insert_anchor_not_sourced'));

const badRatio = validateStoryboardPlanContract(plan({
  shots: [shot({ composition: { ...shot().composition, ratio_id: '2:3', orientation: 'landscape' } })],
}), validationOptions);
assert.ok(badRatio.errors.some((entry) => entry.code === 'ratio_orientation'));

const overlapping = validateStoryboardPlanContract(plan({
  shots: [shot({
    characters: [character('character-a', 0.5), character('character-b', 0.51)],
    prompt_atoms: { ...shot().prompt_atoms, character_ids: ['character-a', 'character-b'] },
  })],
}), validationOptions);
assert.ok(overlapping.errors.some((entry) => entry.code === 'overlapping_characters'));

const pollutedGlobal = validateStoryboardPlanContract(plan({
  shots: [shot({ prompt_atoms: { ...shot().prompt_atoms, global: ['night room', 'silver hair'] } })],
}), validationOptions);
assert.ok(pollutedGlobal.errors.some((entry) => entry.code === 'global_character_pollution'));

const crossedIdentity = validateStoryboardPlanContract(plan({
  shots: [shot({ characters: [character('character-a', 0.38, { fixed_identity: ['black hair'] })] })],
}), validationOptions);
assert.ok(crossedIdentity.errors.some((entry) => entry.code === 'character_cross_assignment'));

const manualRejected = validateStoryboardPlanContract(plan({
  should_generate: false,
  skip_reason: '不想生成',
  shots: [],
}), { ...validationOptions, manualSupplement: true, requiredInsertAfter: 'P2', maxShots: 1 });
assert.ok(manualRejected.errors.some((entry) => entry.code === 'manual_must_generate'));
assert.ok(manualRejected.errors.some((entry) => entry.code === 'manual_single_shot'));

const manualAnchor = validateStoryboardPlanContract(plan({
  shots: [shot({ source_paragraph_ids: ['P1'], insert_after: 'P1' })],
}), { ...validationOptions, manualSupplement: true, requiredInsertAfter: 'P2', maxShots: 1 });
assert.ok(manualAnchor.errors.some((entry) => entry.code === 'manual_insert_anchor'));

assert.match(formatStoryboardContractErrors(wrongParagraph.errors, 1), /^\$\.shots\[0\]/);

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(indexSource, /storyboardContract:[\s\S]*import\('\.\/qianmu-storyboard-contract\.js\?v=1\.58\.58'\)/, 'the contract validator must stay outside the startup graph');
assert.match(indexSource, /async function storyboardCompilerResult[\s\S]*const declaresPlanContract = \/"schema"[\s\S]*featureRuntime\.load\('storyboardContract'\)/, 'only explicitly versioned contract responses should enter strict validation');
assert.match(indexSource, /const result = await storyboardCompilerResult\(/, 'the lazy validator must finish before compiler output is accepted');

console.log('Storyboard strict response contract OK');
