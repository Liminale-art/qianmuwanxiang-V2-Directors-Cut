import {
  STORYBOARD_CONTINUITY_FACT_CATEGORIES,
  STORYBOARD_CONTINUITY_FACT_PERSISTENCE,
  STORYBOARD_NARRATIVE_LAYERS,
  STORYBOARD_RATIOS,
  STORYBOARD_SHOT_ROLES,
  STORYBOARD_SHOT_SCALES,
  normalizeStoryboardShotSpec,
} from './qianmu-storyboard.js';

// LLM 返回协议只负责“把原始 JSON 变成可信结构”，不发请求，也不猜测缺失内容。
export const STORYBOARD_PLAN_RESPONSE_SCHEMA_ID = 'qianmu.storyboard.plan.v1';
export const STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID = 'qianmu.storyboard.safety.v1';
export const STORYBOARD_CONTRACT_MAX_BYTES = 256 * 1024;

const SPATIAL_REGIONS = Object.freeze([
  'far-left', 'left', 'center-left', 'center', 'center-right', 'right', 'far-right', 'background',
]);
const ORIENTATIONS = Object.freeze(['landscape', 'portrait', 'square']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

const stringArraySchema = (maxItems) => ({
  type: 'array',
  maxItems,
  items: { type: 'string' },
});

const currentStateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outfit', 'expression', 'pose', 'action', 'gaze', 'props'],
  properties: {
    outfit: stringArraySchema(20),
    expression: stringArraySchema(12),
    pose: stringArraySchema(12),
    action: stringArraySchema(12),
    gaze: stringArraySchema(8),
    props: stringArraySchema(20),
  },
};

const characterSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['character_id', 'name', 'fixed_identity', 'current_state', 'spatial'],
  properties: {
    character_id: { type: 'string' },
    name: { type: 'string' },
    fixed_identity: stringArraySchema(30),
    current_state: currentStateSchema,
    spatial: {
      type: 'object',
      additionalProperties: false,
      required: ['order', 'region', 'center', 'visible_crop'],
      properties: {
        order: { type: 'integer', minimum: 1, maximum: 12 },
        region: { type: 'string', enum: SPATIAL_REGIONS },
        center: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
        visible_crop: { type: 'string' },
      },
    },
  },
};

const continuityUpdateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'subject', 'key', 'value', 'persistence', 'source_paragraph_ids', 'evidence'],
  properties: {
    category: { type: 'string', enum: STORYBOARD_CONTINUITY_FACT_CATEGORIES },
    subject: { type: 'string' },
    key: { type: 'string' },
    value: { type: 'string' },
    persistence: { type: 'string', enum: STORYBOARD_CONTINUITY_FACT_PERSISTENCE },
    source_paragraph_ids: stringArraySchema(80),
    evidence: { type: 'string' },
  },
};

const safetyCharacterUpdateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['character_id', 'outfit', 'expression', 'pose', 'action', 'gaze', 'props'],
  properties: {
    character_id: { type: 'string' },
    outfit: stringArraySchema(20),
    expression: stringArraySchema(12),
    pose: stringArraySchema(12),
    action: stringArraySchema(12),
    gaze: stringArraySchema(8),
    props: stringArraySchema(20),
  },
};

const shotSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'source_paragraph_ids', 'insert_after', 'narrative_layer', 'narrative_purpose',
    'shot_role', 'shot_scale', 'subject', 'scene', 'characters', 'shared_relations',
    'composition', 'prompt_atoms', 'sensitive', 'safety_notes',
  ],
  properties: {
    source_paragraph_ids: stringArraySchema(80),
    insert_after: { type: 'string' },
    narrative_layer: { type: 'string', enum: STORYBOARD_NARRATIVE_LAYERS },
    narrative_purpose: { type: 'string' },
    shot_role: { type: 'string', enum: STORYBOARD_SHOT_ROLES },
    shot_scale: { type: 'string', enum: STORYBOARD_SHOT_SCALES },
    subject: { type: 'string' },
    scene: {
      type: 'object',
      additionalProperties: false,
      required: ['location', 'time', 'lighting', 'environment'],
      properties: {
        location: { type: 'string' },
        time: { type: 'string' },
        lighting: stringArraySchema(20),
        environment: stringArraySchema(40),
      },
    },
    characters: { type: 'array', maxItems: 12, items: characterSchema },
    shared_relations: stringArraySchema(30),
    composition: {
      type: 'object',
      additionalProperties: false,
      required: ['ratio_id', 'orientation', 'intent', 'continuity_key'],
      properties: {
        ratio_id: { type: 'string', enum: STORYBOARD_RATIOS.map((item) => item.id) },
        orientation: { type: 'string', enum: ORIENTATIONS },
        intent: { type: 'string' },
        continuity_key: { type: 'string' },
      },
    },
    prompt_atoms: {
      type: 'object',
      additionalProperties: false,
      required: ['global', 'character_ids', 'scene_negative'],
      properties: {
        global: stringArraySchema(40),
        character_ids: stringArraySchema(12),
        scene_negative: stringArraySchema(40),
      },
    },
    sensitive: { type: 'boolean' },
    safety_notes: stringArraySchema(20),
  },
};

export const STORYBOARD_PLAN_RESPONSE_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'should_generate', 'skip_reason', 'shots', 'continuity_updates', 'decisions'],
  properties: {
    schema: { const: STORYBOARD_PLAN_RESPONSE_SCHEMA_ID },
    should_generate: { type: 'boolean' },
    skip_reason: { type: 'string' },
    shots: { type: 'array', maxItems: 4, items: shotSchema },
    continuity_updates: { type: 'array', maxItems: 80, items: continuityUpdateSchema },
    decisions: stringArraySchema(12),
  },
});

export const STORYBOARD_SAFETY_RESPONSE_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID,
  type: 'object',
  additionalProperties: false,
  required: [
    'schema', 'preserved_narrative_purpose', 'replacement_visual', 'character_updates',
    'prompt_atoms', 'adaptation_note',
  ],
  properties: {
    schema: { const: STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID },
    preserved_narrative_purpose: { type: 'string' },
    replacement_visual: { type: 'string' },
    character_updates: { type: 'array', maxItems: 12, items: safetyCharacterUpdateSchema },
    prompt_atoms: {
      type: 'object',
      additionalProperties: false,
      required: ['global', 'scene_negative'],
      properties: {
        global: stringArraySchema(40),
        scene_negative: stringArraySchema(40),
      },
    },
    adaptation_note: { type: 'string' },
  },
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function receivedType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function issue(errors, code, path, message, expected = '', received = undefined) {
  errors.push({
    code,
    path,
    message,
    ...(expected ? { expected } : {}),
    ...(received !== undefined ? { received: receivedType(received) } : {}),
  });
}

function exactKeys(value, allowed, required, path, errors) {
  if (!object(value)) {
    issue(errors, 'type', path, '必须是 JSON 对象', 'object', value);
    return false;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issue(errors, 'additional_property', `${path}.${key}`, '协议未定义此字段');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) issue(errors, 'required', `${path}.${key}`, '缺少必需字段');
  }
  return true;
}

function stringValue(value, path, errors, { required = true, max = 4000 } = {}) {
  if (typeof value !== 'string') {
    issue(errors, 'type', path, '必须是字符串', 'string', value);
    return '';
  }
  const text = value.trim();
  if (required && !text) issue(errors, 'empty', path, '不得为空');
  if (value.length > max) issue(errors, 'max_length', path, `长度不得超过 ${max}`);
  return text;
}

function stringArray(value, path, errors, { min = 0, max = 40, itemMax = 800 } = {}) {
  if (!Array.isArray(value)) {
    issue(errors, 'type', path, '必须是字符串数组', 'array', value);
    return [];
  }
  if (value.length < min) issue(errors, 'min_items', path, `至少需要 ${min} 项`);
  if (value.length > max) issue(errors, 'max_items', path, `最多允许 ${max} 项`);
  value.slice(0, max).forEach((item, index) => stringValue(item, `${path}[${index}]`, errors, { max: itemMax }));
  return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function enumValue(value, allowed, path, errors) {
  const text = stringValue(value, path, errors, { max: 120 });
  if (text && !allowed.includes(text)) issue(errors, 'enum', path, `只允许：${allowed.join(' / ')}`);
  return text;
}

function normalizedTerm(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s,，。；;、:_-]+/g, ' ').trim();
}

function containsTerm(haystack, needle) {
  const text = normalizedTerm(haystack);
  const term = normalizedTerm(needle);
  return term.length >= 2 && text.includes(term);
}

function validateCurrentState(value, path, errors) {
  const keys = ['outfit', 'expression', 'pose', 'action', 'gaze', 'props'];
  if (!exactKeys(value, keys, keys, path, errors)) return;
  stringArray(value.outfit, `${path}.outfit`, errors, { max: 20, itemMax: 500 });
  stringArray(value.expression, `${path}.expression`, errors, { max: 12, itemMax: 300 });
  stringArray(value.pose, `${path}.pose`, errors, { max: 12, itemMax: 500 });
  stringArray(value.action, `${path}.action`, errors, { max: 12, itemMax: 500 });
  stringArray(value.gaze, `${path}.gaze`, errors, { max: 8, itemMax: 300 });
  stringArray(value.props, `${path}.props`, errors, { max: 20, itemMax: 300 });
}

function validateSpatial(value, path, errors) {
  const keys = ['order', 'region', 'center', 'visible_crop'];
  if (!exactKeys(value, keys, keys, path, errors)) return;
  if (!Number.isInteger(value.order) || value.order < 1 || value.order > 12) {
    issue(errors, 'range', `${path}.order`, '必须是 1 到 12 的整数');
  }
  enumValue(value.region, SPATIAL_REGIONS, `${path}.region`, errors);
  stringValue(value.visible_crop, `${path}.visible_crop`, errors, { max: 120 });
  if (!exactKeys(value.center, ['x', 'y'], ['x', 'y'], `${path}.center`, errors)) return;
  for (const axis of ['x', 'y']) {
    const coordinate = value.center?.[axis];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
      issue(errors, 'range', `${path}.center.${axis}`, '必须是 0 到 1 的数字');
    }
  }
}

function validateCharacter(value, index, options, errors) {
  const path = `$.shots[${options.shotIndex}].characters[${index}]`;
  const keys = ['character_id', 'name', 'fixed_identity', 'current_state', 'spatial'];
  if (!exactKeys(value, keys, keys, path, errors)) return null;
  const id = stringValue(value.character_id, `${path}.character_id`, errors, { max: 160 });
  stringValue(value.name, `${path}.name`, errors, { max: 120 });
  stringArray(value.fixed_identity, `${path}.fixed_identity`, errors, { max: 30, itemMax: 500 });
  validateCurrentState(value.current_state, `${path}.current_state`, errors);
  validateSpatial(value.spatial, `${path}.spatial`, errors);
  if (options.allowedCharacterIds.size && id && !options.allowedCharacterIds.has(id)) {
    issue(errors, 'unknown_character', `${path}.character_id`, `角色 ${id} 不在可信输入中`);
  }
  const authoritativeTerms = options.characterTermsById[id] || [];
  const authored = [
    ...(Array.isArray(value.fixed_identity) ? value.fixed_identity : []),
    ...Object.values(object(value.current_state) ? value.current_state : {}).flatMap((part) => Array.isArray(part) ? part : []),
  ];
  for (const [ownerId, terms] of Object.entries(options.characterTermsById)) {
    if (ownerId === id) continue;
    for (const term of terms) {
      if (authored.some((entry) => containsTerm(entry, term))) {
        issue(errors, 'character_cross_assignment', path, `检测到属于角色 ${ownerId} 的专属特征或状态：${term}`);
      }
    }
  }
  if (authoritativeTerms.length && !authored.length) {
    issue(errors, 'missing_character_state', path, `角色 ${id} 缺少可编译的人物状态`);
  }
  return id;
}

function ratioOrientation(ratioId) {
  const ratio = STORYBOARD_RATIOS.find((item) => item.id === ratioId)?.value;
  if (!Number.isFinite(ratio)) return '';
  if (Math.abs(ratio - 1) < 0.001) return 'square';
  return ratio > 1 ? 'landscape' : 'portrait';
}

function validateShot(value, index, options, errors) {
  const path = `$.shots[${index}]`;
  const keys = [
    'source_paragraph_ids', 'insert_after', 'narrative_layer', 'narrative_purpose',
    'shot_role', 'shot_scale', 'subject', 'scene', 'characters', 'shared_relations',
    'composition', 'prompt_atoms', 'sensitive', 'safety_notes',
  ];
  if (!exactKeys(value, keys, keys, path, errors)) return;
  const paragraphIds = stringArray(value.source_paragraph_ids, `${path}.source_paragraph_ids`, errors, { min: 1, max: 80, itemMax: 160 });
  const insertAfter = stringValue(value.insert_after, `${path}.insert_after`, errors, { max: 160 });
  for (const paragraphId of paragraphIds) {
    if (options.allowedParagraphIds.size && !options.allowedParagraphIds.has(paragraphId)) {
      issue(errors, 'unknown_paragraph', `${path}.source_paragraph_ids`, `段落 ${paragraphId} 不在本次可信输入中`);
    }
  }
  if (options.allowedParagraphIds.size && insertAfter && !options.allowedParagraphIds.has(insertAfter)) {
    issue(errors, 'unknown_insert_anchor', `${path}.insert_after`, `插入锚点 ${insertAfter} 不在本次可选段落中`);
  }
  if (insertAfter && paragraphIds.length && !paragraphIds.includes(insertAfter)) {
    issue(errors, 'insert_anchor_not_sourced', `${path}.insert_after`, '插入锚点必须属于本镜头引用的段落');
  }
  if (options.requiredInsertAfter && insertAfter !== options.requiredInsertAfter) {
    issue(errors, 'manual_insert_anchor', `${path}.insert_after`, `手动补画必须插在 ${options.requiredInsertAfter} 后`);
  }
  enumValue(value.narrative_layer, STORYBOARD_NARRATIVE_LAYERS, `${path}.narrative_layer`, errors);
  stringValue(value.narrative_purpose, `${path}.narrative_purpose`, errors, { max: 800 });
  enumValue(value.shot_role, STORYBOARD_SHOT_ROLES, `${path}.shot_role`, errors);
  enumValue(value.shot_scale, STORYBOARD_SHOT_SCALES, `${path}.shot_scale`, errors);
  stringValue(value.subject, `${path}.subject`, errors, { max: 1000 });

  const sceneKeys = ['location', 'time', 'lighting', 'environment'];
  if (exactKeys(value.scene, sceneKeys, sceneKeys, `${path}.scene`, errors)) {
    stringValue(value.scene.location, `${path}.scene.location`, errors, { max: 1000 });
    stringValue(value.scene.time, `${path}.scene.time`, errors, { max: 240 });
    stringArray(value.scene.lighting, `${path}.scene.lighting`, errors, { max: 20, itemMax: 500 });
    stringArray(value.scene.environment, `${path}.scene.environment`, errors, { max: 40, itemMax: 800 });
  }

  const characterIds = [];
  if (!Array.isArray(value.characters)) issue(errors, 'type', `${path}.characters`, '必须是人物数组', 'array', value.characters);
  else {
    if (value.characters.length > 12) issue(errors, 'max_items', `${path}.characters`, '最多允许 12 个人物');
    value.characters.slice(0, 12).forEach((character, characterIndex) => {
      const id = validateCharacter(character, characterIndex, { ...options, shotIndex: index }, errors);
      if (id) characterIds.push(id);
    });
    const duplicates = characterIds.filter((id, characterIndex) => characterIds.indexOf(id) !== characterIndex);
    if (duplicates.length) issue(errors, 'duplicate_character', `${path}.characters`, `人物 ID 重复：${[...new Set(duplicates)].join('、')}`);
    for (let left = 0; left < value.characters.length; left += 1) {
      for (let right = left + 1; right < value.characters.length; right += 1) {
        const a = value.characters[left]?.spatial?.center;
        const b = value.characters[right]?.spatial?.center;
        if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < 0.05) {
          issue(errors, 'overlapping_characters', `${path}.characters[${right}].spatial.center`, '多人物空间中心不可重叠');
        }
      }
    }
  }
  stringArray(value.shared_relations, `${path}.shared_relations`, errors, { max: 30, itemMax: 800 });

  const compositionKeys = ['ratio_id', 'orientation', 'intent', 'continuity_key'];
  if (exactKeys(value.composition, compositionKeys, compositionKeys, `${path}.composition`, errors)) {
    const allowedRatios = options.allowedRatioIds.size ? [...options.allowedRatioIds] : STORYBOARD_RATIOS.map((item) => item.id);
    const ratioId = enumValue(value.composition.ratio_id, allowedRatios, `${path}.composition.ratio_id`, errors);
    const orientation = enumValue(value.composition.orientation, ORIENTATIONS, `${path}.composition.orientation`, errors);
    const expectedOrientation = ratioOrientation(ratioId);
    if (ratioId && orientation && expectedOrientation && orientation !== expectedOrientation) {
      issue(errors, 'ratio_orientation', `${path}.composition.orientation`, `比例 ${ratioId} 应使用 ${expectedOrientation}`);
    }
    stringValue(value.composition.intent, `${path}.composition.intent`, errors, { max: 1000 });
    stringValue(value.composition.continuity_key, `${path}.composition.continuity_key`, errors, { max: 240 });
  }

  const promptKeys = ['global', 'character_ids', 'scene_negative'];
  if (exactKeys(value.prompt_atoms, promptKeys, promptKeys, `${path}.prompt_atoms`, errors)) {
    const globalAtoms = stringArray(value.prompt_atoms.global, `${path}.prompt_atoms.global`, errors, { max: 40, itemMax: 800 });
    const promptCharacterIds = stringArray(value.prompt_atoms.character_ids, `${path}.prompt_atoms.character_ids`, errors, { max: 12, itemMax: 160 });
    stringArray(value.prompt_atoms.scene_negative, `${path}.prompt_atoms.scene_negative`, errors, { max: 40, itemMax: 500 });
    for (const id of promptCharacterIds) {
      if (!characterIds.includes(id)) issue(errors, 'unknown_prompt_character', `${path}.prompt_atoms.character_ids`, `提示词人物 ${id} 不在本镜头人物列表中`);
    }
    for (const id of characterIds) {
      if (!promptCharacterIds.includes(id)) issue(errors, 'missing_prompt_character', `${path}.prompt_atoms.character_ids`, `缺少本镜头人物 ${id}`);
    }
    const exclusiveTerms = Object.values(options.characterTermsById).flat();
    for (const term of exclusiveTerms) {
      if (globalAtoms.some((entry) => containsTerm(entry, term))) {
        issue(errors, 'global_character_pollution', `${path}.prompt_atoms.global`, `公共提示词包含人物专属特征或状态：${term}`);
      }
    }
  }
  if (typeof value.sensitive !== 'boolean') issue(errors, 'type', `${path}.sensitive`, '必须是布尔值', 'boolean', value.sensitive);
  stringArray(value.safety_notes, `${path}.safety_notes`, errors, { max: 20, itemMax: 500 });
}

function validateContinuityUpdate(value, index, options, errors) {
  const path = `$.continuity_updates[${index}]`;
  const keys = ['category', 'subject', 'key', 'value', 'persistence', 'source_paragraph_ids', 'evidence'];
  if (!exactKeys(value, keys, keys, path, errors)) return;
  enumValue(value.category, STORYBOARD_CONTINUITY_FACT_CATEGORIES, `${path}.category`, errors);
  stringValue(value.subject, `${path}.subject`, errors, { max: 160 });
  stringValue(value.key, `${path}.key`, errors, { max: 120 });
  stringValue(value.value, `${path}.value`, errors, { max: 1000 });
  enumValue(value.persistence, STORYBOARD_CONTINUITY_FACT_PERSISTENCE, `${path}.persistence`, errors);
  const paragraphIds = stringArray(value.source_paragraph_ids, `${path}.source_paragraph_ids`, errors, { min: 1, max: 80, itemMax: 160 });
  for (const paragraphId of paragraphIds) {
    if (options.allowedParagraphIds.size && !options.allowedParagraphIds.has(paragraphId)) {
      issue(errors, 'unknown_paragraph', `${path}.source_paragraph_ids`, `段落 ${paragraphId} 不在本次可信输入中`);
    }
  }
  stringValue(value.evidence, `${path}.evidence`, errors, { max: 1000 });
}

function normalizedOptions(options = {}) {
  const maxShots = Math.max(1, Math.min(4, Number(options.maxShots) || 4));
  const characterTermsById = object(options.characterTermsById)
    ? Object.fromEntries(Object.entries(options.characterTermsById).map(([id, terms]) => [String(id), Array.isArray(terms) ? terms.map(String).filter(Boolean).slice(0, 120) : []]))
    : {};
  return {
    maxShots,
    manualSupplement: options.manualSupplement === true,
    requiredInsertAfter: String(options.requiredInsertAfter || ''),
    allowedParagraphIds: new Set(Array.isArray(options.allowedParagraphIds) ? options.allowedParagraphIds.map(String) : []),
    allowedCharacterIds: new Set(Array.isArray(options.allowedCharacterIds) ? options.allowedCharacterIds.map(String) : []),
    allowedRatioIds: new Set(Array.isArray(options.allowedRatioIds) ? options.allowedRatioIds.map(String) : []),
    characterTermsById,
  };
}

export function validateStoryboardPlanContract(value, rawOptions = {}) {
  const errors = [];
  const options = normalizedOptions(rawOptions);
  const keys = ['schema', 'should_generate', 'skip_reason', 'shots', 'continuity_updates', 'decisions'];
  if (!exactKeys(value, keys, keys, '$', errors)) return { ok: false, data: null, errors };
  if (value.schema !== STORYBOARD_PLAN_RESPONSE_SCHEMA_ID) {
    issue(errors, 'schema', '$.schema', `必须是 ${STORYBOARD_PLAN_RESPONSE_SCHEMA_ID}`);
  }
  if (typeof value.should_generate !== 'boolean') issue(errors, 'type', '$.should_generate', '必须是布尔值', 'boolean', value.should_generate);
  const skipReason = stringValue(value.skip_reason, '$.skip_reason', errors, { required: false, max: 500 });
  if (!Array.isArray(value.shots)) issue(errors, 'type', '$.shots', '必须是镜头数组', 'array', value.shots);
  else {
    if (value.shots.length > options.maxShots) issue(errors, 'max_items', '$.shots', `本次最多允许 ${options.maxShots} 个镜头`);
    if (value.should_generate === true && !value.shots.length) issue(errors, 'min_items', '$.shots', '决定生成时至少需要一个镜头');
    if (value.should_generate === false && value.shots.length) issue(errors, 'unexpected_shots', '$.shots', '决定不生成时镜头数组必须为空');
    if (options.manualSupplement && value.should_generate !== true) issue(errors, 'manual_must_generate', '$.should_generate', '手动补画不得返回不生成');
    if (options.manualSupplement && value.shots.length !== 1) issue(errors, 'manual_single_shot', '$.shots', '手动补画必须恰好返回一个镜头');
    value.shots.slice(0, options.maxShots).forEach((shot, index) => validateShot(shot, index, options, errors));
  }
  if (value.should_generate === false && !skipReason) issue(errors, 'skip_reason', '$.skip_reason', '决定不生成时必须说明简短原因');
  if (!Array.isArray(value.continuity_updates)) issue(errors, 'type', '$.continuity_updates', '必须是数组', 'array', value.continuity_updates);
  else {
    if (value.continuity_updates.length > 80) issue(errors, 'max_items', '$.continuity_updates', '连续性更新最多 80 项');
    value.continuity_updates.forEach((entry, index) => validateContinuityUpdate(entry, index, options, errors));
  }
  stringArray(value.decisions, '$.decisions', errors, { max: 12, itemMax: 500 });
  return { ok: errors.length === 0, data: errors.length ? null : value, errors };
}

export function validateStoryboardSafetyContract(value, rawOptions = {}) {
  const errors = [];
  const options = normalizedOptions(rawOptions);
  const keys = ['schema', 'preserved_narrative_purpose', 'replacement_visual', 'character_updates', 'prompt_atoms', 'adaptation_note'];
  if (!exactKeys(value, keys, keys, '$', errors)) return { ok: false, data: null, errors };
  if (value.schema !== STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID) {
    issue(errors, 'schema', '$.schema', `必须是 ${STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID}`);
  }
  stringValue(value.preserved_narrative_purpose, '$.preserved_narrative_purpose', errors, { max: 800 });
  stringValue(value.replacement_visual, '$.replacement_visual', errors, { max: 4000 });
  if (!Array.isArray(value.character_updates)) issue(errors, 'type', '$.character_updates', '必须是数组', 'array', value.character_updates);
  else {
    if (value.character_updates.length > 12) issue(errors, 'max_items', '$.character_updates', '人物更新最多 12 项');
    const ids = [];
    value.character_updates.forEach((entry, index) => {
      const path = `$.character_updates[${index}]`;
      const fields = ['character_id', 'outfit', 'expression', 'pose', 'action', 'gaze', 'props'];
      if (!exactKeys(entry, fields, fields, path, errors)) return;
      const id = stringValue(entry.character_id, `${path}.character_id`, errors, { max: 160 });
      if (id) ids.push(id);
      if (options.allowedCharacterIds.size && id && !options.allowedCharacterIds.has(id)) {
        issue(errors, 'unknown_character', `${path}.character_id`, `角色 ${id} 不在可信输入中`);
      }
      stringArray(entry.outfit, `${path}.outfit`, errors, { max: 20, itemMax: 500 });
      stringArray(entry.expression, `${path}.expression`, errors, { max: 12, itemMax: 300 });
      stringArray(entry.pose, `${path}.pose`, errors, { max: 12, itemMax: 500 });
      stringArray(entry.action, `${path}.action`, errors, { max: 12, itemMax: 500 });
      stringArray(entry.gaze, `${path}.gaze`, errors, { max: 8, itemMax: 300 });
      stringArray(entry.props, `${path}.props`, errors, { max: 20, itemMax: 300 });
    });
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length) issue(errors, 'duplicate_character', '$.character_updates', `人物 ID 重复：${[...new Set(duplicates)].join('、')}`);
  }
  if (exactKeys(value.prompt_atoms, ['global', 'scene_negative'], ['global', 'scene_negative'], '$.prompt_atoms', errors)) {
    stringArray(value.prompt_atoms.global, '$.prompt_atoms.global', errors, { max: 40, itemMax: 800 });
    stringArray(value.prompt_atoms.scene_negative, '$.prompt_atoms.scene_negative', errors, { max: 40, itemMax: 500 });
  }
  stringValue(value.adaptation_note, '$.adaptation_note', errors, { max: 800 });
  return { ok: errors.length === 0, data: errors.length ? null : value, errors };
}

export function parseStoryboardContractJson(raw) {
  const source = String(raw ?? '');
  if (new TextEncoder().encode(source).byteLength > STORYBOARD_CONTRACT_MAX_BYTES) {
    return { ok: false, data: null, errors: [{ code: 'max_bytes', path: '$', message: `返回内容不得超过 ${STORYBOARD_CONTRACT_MAX_BYTES} 字节` }] };
  }
  let text = source.trim();
  const fenced = text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) text = fenced[1].trim();
  if (!text) return { ok: false, data: null, errors: [{ code: 'empty', path: '$', message: '模型没有返回 JSON' }] };
  try {
    const data = JSON.parse(text);
    if (!object(data)) return { ok: false, data: null, errors: [{ code: 'root_type', path: '$', message: 'JSON 顶层必须是对象' }] };
    return { ok: true, data, errors: [] };
  } catch (error) {
    return { ok: false, data: null, errors: [{ code: 'json_syntax', path: '$', message: String(error?.message || 'JSON 语法错误').slice(0, 500) }] };
  }
}

export function parseStoryboardContractResponse(raw, options = {}) {
  const parsed = parseStoryboardContractJson(raw);
  if (!parsed.ok) return { ...parsed, kind: '', requiresRepair: true };
  const kind = options.kind || (parsed.data.schema === STORYBOARD_SAFETY_RESPONSE_SCHEMA_ID ? 'safety' : 'plan');
  const validated = kind === 'safety'
    ? validateStoryboardSafetyContract(parsed.data, options)
    : validateStoryboardPlanContract(parsed.data, options);
  return { ...validated, kind, requiresRepair: !validated.ok };
}

export function formatStoryboardContractErrors(errors, limit = 12) {
  return (Array.isArray(errors) ? errors : []).slice(0, Math.max(1, limit)).map((entry) => {
    const path = String(entry?.path || '$');
    const message = String(entry?.message || entry?.code || '格式不符合协议');
    return `${path}: ${message}`;
  }).join('\n');
}

function spatialRegionForShotSpec(value) {
  return String(value || 'center').replaceAll('-', '_');
}

function cropForShotSpec(value) {
  const crop = normalizedTerm(value);
  if (!crop) return 'full';
  if (crop.includes('detail') || crop.includes('hand') || crop.includes('object')) return 'detail';
  if (crop.includes('face')) return 'face';
  if (crop.includes('shoulder')) return 'shoulders';
  if (crop.includes('chest') || crop.includes('bust')) return 'chest';
  if (crop.includes('waist')) return 'waist';
  if (crop.includes('knee')) return 'knees';
  return 'full';
}

function paragraphIndexFor(id, options = {}) {
  const lookup = options.paragraphIndexById;
  if (lookup instanceof Map && lookup.has(id)) return lookup.get(id);
  if (object(lookup) && Number.isInteger(lookup[id])) return lookup[id];
  return Number.isInteger(options.fallbackParagraphIndex) ? options.fallbackParagraphIndex : 0;
}

function legacyShotType(shot) {
  if (shot.shot_role === 'detail' || ['extreme_close_up', 'close_up', 'insert'].includes(shot.shot_scale)) return 'closeup';
  if (shot.shot_role === 'action') return 'action';
  if (!shot.characters.length) return shot.shot_role === 'detail' ? 'object' : 'environment';
  return shot.characters.length > 1 ? 'group' : 'portrait';
}

export function adaptStoryboardPlanContract(value, options = {}) {
  if (!object(value) || value.schema !== STORYBOARD_PLAN_RESPONSE_SCHEMA_ID) return null;
  const shots = (Array.isArray(value.shots) ? value.shots : []).map((shot, index) => {
    const sceneText = [shot.scene?.location, shot.scene?.time, ...(shot.scene?.lighting || []), ...(shot.scene?.environment || [])]
      .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
    const characters = (shot.characters || []).map((character) => ({
      id: character.character_id,
      name: character.name,
      identity: character.fixed_identity,
      outfit: character.current_state?.outfit,
      expression: character.current_state?.expression,
      pose: character.current_state?.pose,
      action: character.current_state?.action,
      gaze: character.current_state?.gaze,
      props: character.current_state?.props,
      spatial: {
        order: character.spatial?.order,
        region: spatialRegionForShotSpec(character.spatial?.region),
        center: [character.spatial?.center?.x, character.spatial?.center?.y],
        crop: cropForShotSpec(character.spatial?.visible_crop),
      },
    }));
    const shotSpec = normalizeStoryboardShotSpec({
      sourceParagraphIds: shot.source_paragraph_ids,
      insertAfter: shot.insert_after,
      narrativeLayer: shot.narrative_layer,
      narrativePurpose: shot.narrative_purpose,
      shotRole: shot.shot_role,
      shotScale: shot.shot_scale,
      subject: shot.subject,
      scene: sceneText,
      sceneId: shot.composition?.continuity_key,
      location: shot.scene?.location,
      characters,
      sharedRelations: shot.shared_relations,
      composition: {
        ratioId: shot.composition?.ratio_id,
        framing: [shot.composition?.intent].filter(Boolean),
        rationale: shot.composition?.intent,
      },
      promptAtoms: {
        global: shot.prompt_atoms?.global,
        camera: [shot.shot_scale, shot.composition?.intent].filter(Boolean),
        environment: shot.scene?.environment,
        negative: shot.prompt_atoms?.scene_negative,
      },
      continuityUpdates: {
        time: shot.scene?.time,
        light: (shot.scene?.lighting || []).join(', '),
        facts: value.continuity_updates,
      },
      sensitive: shot.sensitive,
      safetyNotes: shot.safety_notes,
      decisions: value.decisions,
    });
    return {
      title: `镜头 ${index + 1}`,
      shot_role: shot.shot_role,
      purpose: shot.narrative_purpose,
      prompt: '',
      safe_prompt: '',
      negative: (shot.prompt_atoms?.scene_negative || []).join(', '),
      paragraph_index: paragraphIndexFor(shot.insert_after, options),
      shot_type: legacyShotType(shot),
      sensitive: shot.sensitive,
      shotSpec,
    };
  });
  return {
    should_generate: value.should_generate,
    skip_reason: value.skip_reason,
    shots,
    continuity_updates: value.continuity_updates,
    decisions: value.decisions,
  };
}
