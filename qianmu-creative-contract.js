// Pure output contract. It checks structure and explicit empty/duplicate items,
// not narrative truth or literary quality; those remain in the creative guidance.
import { CREATIVE_COUNTS, CREATIVE_SECTION_LABELS } from './qianmu-creative-prompts.js?v=1.59.443';

const CORE_ARRAYS = ['quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents'];
const WORLD_ARRAYS = ['world_chatter', 'factions', 'faction_relations', 'world_events'];
const CARD_FIELDS = ['parallel_scene', 'interlude'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : structuredClone(value);
const text = value => typeof value === 'string' ? value : '';
const canonical = value => text(value).normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase();
const names = value => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).map(canonical).filter(Boolean);
const PLACEHOLDER = /^(?:无|暂无|暂无内容|暂无变化|无变化|无内容|没有内容|待补充|待定|略|省略|暗流涌动|有所察觉|n\/?a|none|null|undefined|tbd|todo|\.\.\.|…|—|-)$/iu;
function substantive(value) {
  return typeof value === 'string' && Boolean(value.trim()) && !PLACEHOLDER.test(value.trim().replace(/[。.!！]+$/u, ''));
}
const has = (item, ...keys) => keys.some(key => substantive(item?.[key]));
const joined = (item, keys) => keys.map(key => Array.isArray(item?.[key])
  ? item[key].filter(value => typeof value === 'string').map(canonical).join('|')
  : canonical(item?.[key])).filter(Boolean).join('|');

function enabled(field, options) {
  if (field === 'world_chatter') return options.worldChatterEnabled === true;
  if (['factions', 'faction_relations', 'world_events'].includes(field)) return options.geopoliticsEnabled === true;
  if (field === 'parallel_scene') return options.parallelSceneEnabled !== false;
  if (field === 'interlude') return options.interludeEnabled !== false;
  return true;
}

/** A model-facing JSON shape plus concise field/count requirements. */
export function createCreativeSchema(options = {}) {
  const shape = {
    story_status: { title: '本轮标题', current_arc: '当前脉络', current_stage: '当前阶段', cycle: '故事内日期或时段；未知留空，不按推演轮数推进', progress: 0, mood: '当前基调', summary: '已成立处境与本轮焦点，候选不是既成事实' },
    quests: [{ title: '际遇名称', description: '可亲历、可回应的完整情境', trigger: '靠近此情境的条件', inject_prompt: '供正文选择使用的情境提示，不代替 USER 接受或行动' }],
    character_dynamics: [{ title: '此间一人', content: 'CHAR 此刻具体而完整的事务' }],
    npc_updates: [{ name: '人物名', role: '身份', current_goal: '眼前在意', emotional_state: '有依据的当下状态', next_action: '具体做法及其条件', hidden_agenda: '已有依据或本轮授权的隐秘打算', relations: '有作用的关系', inject_prompt: '可承接提示，不将候选写成已发生' }],
    chain_reactions: [{ spark: '具体起因', chain: '传导动作、当前后果及未发生部分的成立条件' }],
    relation_undercurrents: [{ parties: '关系双方或各方', tone: '关系基调', tension: '独立关系关切与具体表现', drift: '有条件的可能走向', user_awareness: 'USER 实际知情范围' }],
  };
  if (enabled('world_chatter', options)) shape.world_chatter = [{ text: '短声景', who: '人物或群体', where: '所在之处' }];
  if (enabled('factions', options)) {
    shape.factions = [{ id: '沿用已有 id；新增留空', name: '组织名', type: '组织类型', agenda: '诉求', standing: '当前处境', trend: 'rising/stable/declining/turbulent 之一', scale: '城邦内/区域性/跨区域/全局性 之一，按实际规模选择', clues: ['具体风声或应对'] }];
    shape.faction_relations = [{ between: ['组织名或 id', '组织名或 id'], kind: '冲突/同盟/张力/中立/依附', note: '实际联系及其依据' }];
    shape.world_events = [{ id: '沿用已有 id；新增留空', title: '局势名称', essence: '有作用的持续局势及当下影响', scope: '实际涉及范围', stage: '酝酿/爆发/蔓延/消退/落定', drift: '可能走向及其条件', touched: 'advance/mention/idle', status: 'active/closed' }];
  }
  if (enabled('parallel_scene', options)) shape.parallel_scene = { title: '未映之幕标题', content: '明确成立于平行番外的完整场景' };
  if (enabled('interlude', options)) shape.interlude = { type: ['theater', 'phone'].includes(options.interludeType) ? options.interludeType : '本轮指定：theater 或 phone', title: '幕间拾趣标题', owner: options.interludeType === 'phone' ? '从本轮正文及有效记忆已经出现的非 USER 人物中选择手机所属者' : '', content: '指定形式的完整小卡' };
  shape.limitations = [{ field: '仅在确实受限时填写输出字段名', missing: 1, reason: '必然越界的具体来源或设定限制；missing 为实际正整数缺口；正常完成时 limitations 为 []' }];
  const quotas = Object.entries(CREATIVE_COUNTS).filter(([field]) => enabled(field, options)).map(([field, count]) => {
    const label = CREATIVE_SECTION_LABELS[field] || ({ factions: '世界格局组织', world_events: '世界格局局势' })[field];
    return `${field}（${label}）：${count.max === count.min ? `恰好 ${count.min}` : count.max ? `${count.min}–${count.max}` : `至少 ${count.min}`} ${CARD_FIELDS.includes(field) ? '张完整卡片' : '条有效内容'}`;
  });
  const ownerRule = options.interludeType === 'phone' && Array.isArray(options.eligiblePhoneOwners)
    ? `\n手机所属者仅可从本轮已确认名单选择：${JSON.stringify(options.eligiblePhoneOwners)}。排除 USER 及全部别名；名单为空时不得虚构所属者。` : '';
  return `只返回一个 JSON 对象，字段形状如下（数组展示一个结构示例，实际数量按下方底线）：\n${JSON.stringify(shape, null, 2)}\n\n${quotas.join('\n')}\nfaction_relations 仅按实际联系填写，不强制连线或新增。缺口由 limitations 如实报告，不因此当作已足额。候选与已成立经历分清；已成立状态有当前作用即可承接。关闭的栏目不生成。未映之幕与幕间拾趣独立，不提供正文注入字段。${ownerRule}`;
}

/** Preserve legacy/unknown data; normalize only new section shapes and quests. */
export function normalizeCreativeSections(plan, _options = {}) {
  const result = isObject(plan) ? clone(plan) : {};
  const asItem = value => typeof value === 'string' ? { content: value } : value;
  if (Array.isArray(result.quests)) result.quests = result.quests.map(item => {
    if (typeof item === 'string') return { description: item };
    if (!isObject(item)) return item;
    if (!has(item, 'description') && substantive(item.content)) return { ...item, description: item.content };
    if (!has(item, 'description') && substantive(item.objective)) return { ...item, description: item.objective };
    return item;
  });
  if (result.character_dynamics === undefined || result.character_dynamics === null) result.character_dynamics = [];
  else if (Array.isArray(result.character_dynamics)) result.character_dynamics = result.character_dynamics.map(asItem);
  else if (isObject(result.character_dynamics) || typeof result.character_dynamics === 'string') result.character_dynamics = [asItem(result.character_dynamics)];
  for (const field of CARD_FIELDS) {
    if (result[field] === undefined) result[field] = null;
    else if (typeof result[field] === 'string') result[field] = { content: result[field] };
    // Never choose/correct a type, unwrap a multiple-card array, or invent text.
  }
  if (result.limitations === undefined || result.limitations === null) result.limitations = [];
  return result;
}

const CONTENT_FIELDS = {
  quests: ['description', 'content', 'objective'],
  character_dynamics: ['content', 'current_goal', 'next_action', 'hidden_agenda', 'relations'],
  npc_updates: ['content', 'current_goal', 'next_action', 'hidden_agenda', 'relations'],
  chain_reactions: ['spark', 'chain'], relation_undercurrents: ['tension', 'drift', 'content'],
  world_chatter: ['text'], factions: ['agenda', 'standing', 'trend', 'clues'],
  faction_relations: ['between', 'kind', 'note'], world_events: ['essence', 'content'],
};
function itemProblem(field, item) {
  if (!isObject(item)) return '条目不是有效对象';
  switch (field) {
    case 'quests': return has(item, 'description', 'content', 'objective') ? '' : '缺少可回应的具体情境';
    case 'character_dynamics': return has(item, 'content', 'current_goal', 'next_action', 'hidden_agenda', 'relations') ? '' : '缺少具体人物事务';
    case 'npc_updates': return has(item, 'name', 'title') && has(item, ...CONTENT_FIELDS[field]) ? '' : '缺少人物或具体事务';
    case 'chain_reactions': return has(item, 'spark') && has(item, 'chain') ? '' : '缺少具体起因或传导内容';
    case 'relation_undercurrents': return (has(item, 'parties') || (Array.isArray(item.parties) && item.parties.filter(substantive).length >= 2)) && has(item, ...CONTENT_FIELDS[field]) ? '' : '缺少关系参与者或具体关切';
    case 'world_chatter': return has(item, 'text') ? '' : '缺少有效短声景';
    case 'factions': return has(item, 'name') && (has(item, 'agenda', 'standing', 'trend') || (Array.isArray(item.clues) && item.clues.some(substantive))) ? '' : '缺少组织名或有效处境';
    case 'faction_relations': return Array.isArray(item.between) && item.between.length === 2 && item.between.every(substantive) && canonical(item.between[0]) !== canonical(item.between[1]) && has(item, 'kind', 'note') ? '' : '缺少两方实际联系';
    case 'world_events': return has(item, 'title') && has(item, 'essence', 'content') ? '' : '缺少局势名或实际内容';
    default: return '';
  }
}

function inspectArray(field, value) {
  const validIndices = [], invalidIndices = [], duplicateIndices = [], seen = new Set();
  if (!Array.isArray(value)) return { validIndices, invalidIndices, duplicateIndices };
  value.forEach((item, index) => {
    if (itemProblem(field, item)) { invalidIndices.push(index); return; }
    const key = joined(item, CONTENT_FIELDS[field]);
    if (seen.has(key)) { duplicateIndices.push(index); return; }
    seen.add(key);
    validIndices.push(index);
  });
  return { validIndices, invalidIndices, duplicateIndices };
}

function cardProblem(field, card, options) {
  if (!isObject(card) || !has(card, 'title') || !has(card, 'content')) return '缺少一张完整的标题与正文卡片';
  if (field !== 'interlude') return '';
  if (!['theater', 'phone'].includes(options.interludeType)) return '本轮未指定幕间拾趣形式';
  if (card.type !== options.interludeType) return '幕间拾趣形式与本轮指定形式不符';
  if (card.type !== 'phone') return '';
  if (!has(card, 'owner')) return '缺少手机所属者';
  const owner = canonical(card.owner);
  const excluded = new Set(['user', '{{user}}', '<user>', '用户', ...names(options.personaNames)]);
  if (excluded.has(owner)) return '手机所属者不能是 USER 或其别名';
  if (Array.isArray(options.eligiblePhoneOwners) && !names(options.eligiblePhoneOwners).includes(owner)) return '手机所属者不在本聊天已出现的非 USER 人物名单内';
  if (typeof options.phoneSourceText === 'string' && !phoneOwnerInSource(card.owner, options.phoneSourceText)) return '手机所属者未见于本轮正文及有效记忆';
  return '';
}

function phoneOwnerInSource(owner, source) {
  const name = text(owner).normalize('NFKC').trim().toLocaleLowerCase();
  const body = text(source).normalize('NFKC').toLocaleLowerCase();
  if (!name) return false;
  // This is lexical source evidence, not a second character-recognition model.
  // Avoid matching a short Latin name inside an unrelated word (Ann/annual).
  for (let at = body.indexOf(name); at >= 0; at = body.indexOf(name, at + 1)) {
    const before = body[at - 1] || '', after = body[at + name.length] || '';
    if (/^[a-z0-9]/u.test(name) && /[a-z0-9]/u.test(before)) continue;
    if (/[a-z0-9]$/u.test(name) && /[a-z0-9]/u.test(after)) continue;
    return true;
  }
  return false;
}

/** Each issue identifies invalid indices; shortfalls do not erase valid entries. */
export function validateCreativePlan(plan, options = {}) {
  const source = isObject(plan) ? plan : {};
  const issues = [];
  for (const field of [...CORE_ARRAYS, ...WORLD_ARRAYS]) {
    const value = source[field], count = CREATIVE_COUNTS[field];
    if (!enabled(field, options)) {
      if (Array.isArray(value) ? value.length > 0 : value != null) issues.push({ field, reason: '关闭的栏目不应生成', indices: Array.isArray(value) ? value.map((_, index) => index) : [], disabled: true });
      continue;
    }
    if (!Array.isArray(value)) {
      issues.push({ field, reason: '栏目必须是数组', missing: count?.min || 0, indices: [], validIndices: [] });
      continue;
    }
    const { validIndices, invalidIndices, duplicateIndices } = inspectArray(field, value);
    if (invalidIndices.length) issues.push({ field, reason: '空白、占位或缺少栏目必要内容的条目不计数', indices: invalidIndices, validIndices });
    if (duplicateIndices.length) issues.push({ field, reason: '同栏目重复内容不重复计数', indices: duplicateIndices, validIndices });
    if (count && validIndices.length < count.min) issues.push({ field, reason: '有效内容不足', missing: count.min - validIndices.length, indices: [...invalidIndices, ...duplicateIndices].sort((a, b) => a - b), validIndices });
    if (count?.max && validIndices.length > count.max) issues.push({ field, reason: '本次输出超过栏目数量上限', excess: validIndices.length - count.max, max: count.max, validIndices });
  }
  for (const field of CARD_FIELDS) {
    const value = source[field];
    if (!enabled(field, options)) {
      if (value != null) issues.push({ field, reason: '关闭的栏目不应生成', disabled: true });
      continue;
    }
    const reason = cardProblem(field, value, options);
    if (reason) issues.push({ field, reason, missing: 1 });
  }
  if (source.limitations !== undefined && !Array.isArray(source.limitations)) issues.push({ field: 'limitations', reason: '受限说明必须是数组', indices: [] });
  else if (Array.isArray(source.limitations)) {
    const invalid = source.limitations.flatMap((item, index) => {
      if (!isObject(item) || !Object.hasOwn(CREATIVE_COUNTS, item.field) || !enabled(item.field, options)
        || !Number.isInteger(item.missing) || item.missing < 1 || !has(item, 'reason')) return [index];
      const actualMissing = Math.max(0, ...issues.filter(issue => issue.field === item.field).map(issue => issue.missing || 0));
      return item.missing === actualMissing ? [] : [index];
    });
    if (invalid.length) issues.push({ field: 'limitations', reason: '受限说明须包含启用的栏目、准确缺口与具体原因', indices: invalid });
  }
  return issues;
}

/** Use only on this run's candidate output, not stored history. */
export function pruneInvalidCreativeItems(plan, options = {}) {
  const result = normalizeCreativeSections(plan, options);
  const issues = validateCreativePlan(result, options), removed = [];
  const fields = new Set(issues.map(issue => issue.field));
  for (const field of fields) {
    const relevant = issues.filter(issue => issue.field === field);
    if (CARD_FIELDS.includes(field)) {
      if (result[field] != null) removed.push({ field, value: clone(result[field]), reason: relevant[0].reason });
      result[field] = null;
      continue;
    }
    if (!Array.isArray(result[field])) {
      if (result[field] !== undefined) removed.push({ field, value: clone(result[field]), reason: relevant[0].reason });
      result[field] = [];
      continue;
    }
    const indices = new Set(relevant.flatMap(issue => issue.indices || []));
    result[field] = result[field].filter((item, index) => {
      if (!indices.has(index)) return true;
      removed.push({ field, index, value: clone(item), reason: relevant.find(issue => issue.indices?.includes(index))?.reason || '' });
      return false;
    });
    // Excess but otherwise valid entries are not arbitrarily discarded here.
  }
  return { plan: result, removed };
}

// Whitelist scalar properties at every level: a custom schema's nested extra
// content cannot sneak a parallel/interlude payload into mainline continuity.
const CONTINUITY_FIELDS = {
  story_status: ['title', 'current_arc', 'current_stage', 'cycle', 'progress', 'mood', 'summary'],
  quests: ['id', 'type', 'title', 'objective', 'description', 'priority', 'status', 'deadline', 'trigger', 'reward'],
  character_dynamics: ['title', 'content', 'name', 'role', 'current_goal', 'emotional_state', 'next_action', 'hidden_agenda', 'relations'],
  npc_updates: ['name', 'role', 'current_goal', 'emotional_state', 'next_action', 'hidden_agenda', 'relations', 'title', 'content'],
  world_updates: ['type', 'title', 'content', 'scope', 'timing'],
  chain_reactions: ['spark', 'chain'],
  relation_undercurrents: ['parties', 'tone', 'tension', 'drift', 'user_awareness'],
  factions: ['id', 'name', 'type', 'agenda', 'standing', 'trend', 'scale', 'clues'],
  faction_relations: ['between', 'kind', 'note'],
  world_events: ['id', 'title', 'essence', 'scope', 'stage', 'drift', 'touched', 'status'],
};
const LIST_PROPERTIES = new Set(['parties', 'clues', 'between', 'scope']);
function projectItem(item, fields) {
  if (!isObject(item)) return null;
  const result = {};
  for (const field of fields) {
    const value = item[field];
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[field] = value;
    else if (LIST_PROPERTIES.has(field) && Array.isArray(value)) result[field] = value.filter(entry => typeof entry === 'string');
  }
  return Object.keys(result).length ? result : null;
}

/** Reference, never a declaration that generated possibilities already happened. */
export function projectCreativeContinuity(plan) {
  const result = { reference_kind: 'candidate_reference' };
  if (!isObject(plan)) return result;
  for (const [field, allowed] of Object.entries(CONTINUITY_FIELDS)) {
    if (field === 'story_status') {
      const value = projectItem(plan[field], allowed);
      if (value) result[field] = value;
    } else if (Array.isArray(plan[field])) result[field] = plan[field].map(item => projectItem(item, allowed)).filter(Boolean);
  }
  return result;
}
