// Representation is not routing, content permission, or workflow execution permission.
// No translation requests, guessed formats, or workflow edits are performed here.
export const STORYBOARD_PROMPT_FORMATS = Object.freeze(['tags', 'natural_language', 'character_blocks']);
export const STORYBOARD_RENDERINGS_SCHEMA = 'qianmu.storyboard.renderings.v1';
export const STORYBOARD_RENDERINGS_MAX_BYTES = 48 * 1024;
export const STORYBOARD_PROMPT_FORMAT_DESCRIPTIONS = Object.freeze({
  tags: 'Concise English visual tags, comma-separated. Keep individual identity and current state in their own character entry.',
  natural_language: 'Concrete visual sentences, with each character described separately by character_id.',
  character_blocks: 'Self-contained named character descriptions; shared content stays global. This is text layout, not a request to create workflow nodes.',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_prompt_format' }); };
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function normalizeStoryboardPromptFormats(value = []) {
  if (!Array.isArray(value) || value.length > 3 || value.some(format => !STORYBOARD_PROMPT_FORMATS.includes(format))) fail('提示表达格式无效，请核对工作流分类');
  return STORYBOARD_PROMPT_FORMATS.filter(format => value.includes(format));
}

// Supply only reachable, pinned/verified route declarations, never the whole library.
// Unknown Comfy formats remain unknown; a model/checkpoint name cannot declare them.
export function negotiateStoryboardPromptFormats(destinations = []) {
  if (!Array.isArray(destinations) || destinations.length > 64) fail('本次提示格式的目标范围无效');
  const formats = new Set(), unclassified = [];
  destinations.forEach((destination, index) => {
    if (!object(destination)) fail('提示格式目标无效');
    let format;
    if (destination.providerId === 'comfy') {
      if (destination.promptFormat == null || destination.promptFormat === '') { unclassified.push(index); return; }
      [format] = normalizeStoryboardPromptFormats([destination.promptFormat]);
    } else if (destination.providerId === 'novel') format = 'tags';
    else if (['banana', 'openai', 'seedream'].includes(destination.providerId)) format = 'natural_language';
    else fail('未知生图渠道，无法确定提示表达格式');
    formats.add(format);
  });
  return freeze({ formats: normalizeStoryboardPromptFormats([...formats]), unclassified, executionAuthorized: false });
}

export function storyboardPromptRenderingsSchema(formatsInput) {
  const formats = normalizeStoryboardPromptFormats(formatsInput);
  return {
    type: 'object', additionalProperties: false, required: formats,
    properties: Object.fromEntries(formats.map(format => [format, {
      type: 'object', additionalProperties: false, required: ['global', 'characters', 'negative'], description: STORYBOARD_PROMPT_FORMAT_DESCRIPTIONS[format],
      properties: {
        global: { type: 'string', maxLength: 4000, description: 'Render this same shot: shared scene, lighting, camera, framing and relations only. No individual traits, artist names, or new narrative facts. Do not encode numeric aspect ratio; output geometry is controlled by the workflow.' },
        characters: { type: 'array', maxItems: 12, items: {
          type: 'object', additionalProperties: false, required: ['character_id', 'positive'],
          properties: {
            character_id: { type: 'string', minLength: 1, maxLength: 160, description: 'Exactly one entry for each visible character ID of this shot. No new or absent characters.' },
            positive: { type: 'string', minLength: 1, maxLength: 1600, description: 'Only this character: existing identity, current outfit/action/expression/props and spatial placement. Preserve ownership.' },
          },
        } },
        negative: { type: 'string', maxLength: 2000, description: 'Scene exclusions only; do not include another character\'s positive traits.' },
      },
    }])),
  };
}

// Check structural fidelity, not linguistic quality or semantic truth. LLM quality still needs evaluation.
export function validateStoryboardPromptRenderings(value, { formats: requested = [], characterIds = [], path = '$.prompt_renderings' } = {}) {
  const formats = normalizeStoryboardPromptFormats(requested), errors = [];
  const add = (code, location, message) => errors.push({ code, path: location, message });
  const exact = (item, keys, location) => {
    if (!object(item)) { add('prompt_format_type', location, '必须是提示表达对象'); return false; }
    for (const key of keys) if (!Object.hasOwn(item, key)) add('prompt_format_missing', `${location}.${key}`, '缺少所需的提示表达字段');
    for (const key of Object.keys(item)) if (!keys.includes(key)) add('prompt_format_extra', `${location}.${key}`, '不接受未请求的格式或字段');
    return true;
  };
  const string = (item, max, required, location) => {
    if (typeof item !== 'string' || item.length > max || required && !item.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)) {
      add('prompt_format_text', location, '提示表达文本为空、过长或包含无效字符'); return '';
    }
    return item.trim();
  };
  if (!Array.isArray(characterIds) || characterIds.length > 12 || new Set(characterIds).size !== characterIds.length
    || characterIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 160)) {
    add('prompt_format_cast', path, '本镜人物 ID 无效，不能绑定提示表达'); return { ok: false, data: null, errors };
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > STORYBOARD_RENDERINGS_MAX_BYTES) {
      add('max_bytes', path, '本镜提示表达超过 48 KB，请精简'); return { ok: false, data: null, errors };
    }
  } catch (_) { add('prompt_format_type', path, '提示表达必须是可序列化对象'); return { ok: false, data: null, errors }; }
  const data = {};
  if (exact(value, formats, path)) for (const format of formats) {
    const rendering = value[format], location = `${path}.${format}`;
    if (!exact(rendering, ['global', 'characters', 'negative'], location)) continue;
    const global = string(rendering.global, 4000, characterIds.length === 0, `${location}.global`);
    const negative = string(rendering.negative, 2000, false, `${location}.negative`), byId = new Map();
    if (!Array.isArray(rendering.characters) || rendering.characters.length > 12) add('prompt_format_cast', `${location}.characters`, '人物表达须为不超过 12 项的数组');
    else rendering.characters.forEach((character, index) => {
      const charPath = `${location}.characters[${index}]`;
      if (!exact(character, ['character_id', 'positive'], charPath)) return;
      const id = string(character.character_id, 160, true, `${charPath}.character_id`);
      const positive = string(character.positive, 1600, true, `${charPath}.positive`);
      if (!characterIds.includes(id)) add('prompt_format_unknown_character', `${charPath}.character_id`, '提示表达包含本镜未出镜人物');
      if (byId.has(id)) add('prompt_format_duplicate_character', `${charPath}.character_id`, '提示表达中人物 ID 重复');
      byId.set(id, positive);
    });
    for (const id of characterIds) if (!byId.has(id)) add('prompt_format_missing_character', `${location}.characters`, `提示表达缺少本镜人物 ${id}`);
    data[format] = { global, characters: characterIds.map(id => ({ character_id: id, positive: byId.get(id) || '' })), negative };
  }
  return { ok: !errors.length, data: errors.length ? null : data, errors };
}

// The hash detects stale renderings after visual/safety changes. It is NOT execution authorization.
// Call with a normalized ShotSpec. Exclude archive blobs/credentials, insertion anchors and job status.
function shotProjection(shot) {
  if (!object(shot) || shot.schema !== 'qianmu.storyboard.plan.v1' || !Array.isArray(shot.characters) || shot.characters.length > 12) fail('镜头事实尚未规范化');
  const fields = ['subject', 'scene', 'narrativeLayer', 'narrativePurpose', 'shotRole', 'shotScale', 'shotPattern', 'visualDuty', 'subjectKind', 'primarySubjectId', 'sharedRelations', 'composition', 'promptAtoms', 'sensitive', 'safetyNotes'];
  const characterFields = ['id', 'name', 'identity', 'outfit', 'temporaryState', 'expression', 'pose', 'action', 'gaze', 'props', 'spatial'];
  const { ratioId: ignoredRatio, ratioLocked: ignoredLock, ...composition } = shot.composition || {};
  return { ...Object.fromEntries(fields.map(key => [key, shot[key]])), composition, characters: shot.characters.map(character =>
    Object.fromEntries(characterFields.map(key => [key, character[key]]))) };
}
function captureProjection(shot) {
  const text = JSON.stringify(shotProjection(shot));
  if (new TextEncoder().encode(text).byteLength > 128 * 1024) fail('本镜事实过长，请精简后重新提取');
  return JSON.parse(text);
}
async function digest(value) {
  if (!globalThis.crypto?.subtle) fail('当前环境无法核对提示表达，请使用 HTTPS 或本机地址');
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function storyboardPromptFormatBudget(formats, maxShots = 1) {
  const count = normalizeStoryboardPromptFormats(formats).length;
  if (!count) return 2200;
  if (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 4) fail('本次取景数量预算无效');
  // A bounded output allowance, not a promise about model quality or a second translation request.
  return Math.min(16384, maxShots * (1600 + 1000 * count));
}

export function retainStoryboardPromptRenderingPack(value, characterIds) {
  try {
    if (!object(value) || value.invalid || value.schema !== STORYBOARD_RENDERINGS_SCHEMA || !/^[a-f0-9]{64}$/.test(value.sourceHash || '')) fail('提示表达快照无效');
    const formats = normalizeStoryboardPromptFormats(Object.keys(value.renderings || {}));
    if (!formats.length) fail('提示表达为空');
    const checked = validateStoryboardPromptRenderings(value.renderings, { formats, characterIds });
    if (!checked.ok) fail(checked.errors[0].message);
    return {schema:STORYBOARD_RENDERINGS_SCHEMA,sourceHash:value.sourceHash,renderings:checked.data};
  } catch (_) { return {schema:STORYBOARD_RENDERINGS_SCHEMA,invalid:true}; }
}

// Casting may resolve aliases to archive IDs, but may not rewrite the extracted visual facts.
export function remapStoryboardPromptRenderings(renderings, before, after) {
  const source = captureProjection(before), target = captureProjection(after);
  const checked = validateStoryboardPromptRenderings(renderings, {formats:Object.keys(renderings || {}),characterIds:source.characters.map(character=>character.id)});
  if (!checked.ok || source.characters.length !== target.characters.length) fail('人物表达与本镜人物不一致，请重新提取');
  const remap = new Map(source.characters.map((character,index)=>[character.id,target.characters[index].id]));
  const expected = {...source,characters:source.characters.map(character=>({...character,id:remap.get(character.id)}))};
  if (Object.hasOwn(expected,'primarySubjectId')) expected.primarySubjectId = remap.get(expected.primarySubjectId) || expected.primarySubjectId;
  if (JSON.stringify(expected) !== JSON.stringify(target)) fail('人物归档改变了画面事实，不能沿用旧表达');
  const mapped = Object.fromEntries(Object.entries(checked.data).map(([format,row])=>[format,{...row,characters:row.characters.map(character=>({...character,character_id:remap.get(character.character_id)}))}]));
  const result = validateStoryboardPromptRenderings(mapped,{formats:Object.keys(mapped),characterIds:target.characters.map(character=>character.id)});
  if (!result.ok) fail(result.errors[0].message);
  return result.data;
}

export async function bindStoryboardPromptRenderings(shot, renderings, { formats = Object.keys(renderings || {}), guard = async () => {} } = {}) {
  const source = captureProjection(shot);
  const checked = validateStoryboardPromptRenderings(renderings, { formats, characterIds: source.characters.map(character => character.id) });
  if (!checked.ok) fail(checked.errors[0].message);
  await guard();
  const sourceHash = await digest(source); await guard();
  if (JSON.stringify(captureProjection(shot)) !== JSON.stringify(source)) fail('镜头事实已变化，请重新提取');
  return freeze({ schema: STORYBOARD_RENDERINGS_SCHEMA, sourceHash, renderings: checked.data });
}

export async function resolveStoryboardPromptRendering(shot, pack, format, { guard = async () => {} } = {}) {
  normalizeStoryboardPromptFormats([format]);
  if (!object(pack) || pack.invalid || pack.schema !== STORYBOARD_RENDERINGS_SCHEMA || !/^[a-f0-9]{64}$/.test(pack.sourceHash || '')) fail('缺少有效的提示表达快照，请重新提取');
  const capturedHash = pack.sourceHash, source = captureProjection(shot);
  const checked = validateStoryboardPromptRenderings(pack.renderings, { formats: Object.keys(pack.renderings || {}), characterIds: source.characters.map(character => character.id) });
  if (!checked.ok) fail(checked.errors[0].message);
  if (!Object.hasOwn(checked.data, format)) fail('本镜缺少工作流要求的提示格式，请重新提取');
  await guard();
  const actualHash = await digest(source); await guard();
  if (actualHash !== capturedHash || JSON.stringify(captureProjection(shot)) !== JSON.stringify(source)) fail('镜头事实已变化，旧提示表达已失效，请重新提取');
  return freeze({ format, ...checked.data[format], sourceHash: capturedHash, executionAuthorized: false });
}
