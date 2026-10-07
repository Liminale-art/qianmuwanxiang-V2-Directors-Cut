// Pure output contract. It checks structure and explicit empty/duplicate items,
// not narrative truth or literary quality; those remain in the creative guidance.
import { CREATIVE_COUNTS, CREATIVE_SECTION_LABELS } from './qianmu-creative-prompts.js?v=1.59.445';

const CORE_ARRAYS = ['quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents'];
const WORLD_ARRAYS = ['world_chatter', 'factions', 'faction_relations', 'world_events'];
const CARD_FIELDS = ['parallel_scene', 'interlude'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : structuredClone(value);
const text = value => typeof value === 'string' ? value : '';
const canonical = value => text(value).normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase();
const names = value => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).map(canonical).filter(Boolean);
const characterNames = options => Array.isArray(options.characterNames) ? options.characterNames
  : typeof options.characterName === 'string' && options.characterName.trim() ? [options.characterName.trim()] : [];
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
    story_status: { title: 'Title for this run', current_arc: 'Current narrative thread', current_stage: 'Current stage', cycle: 'In-story date or time period; leave blank if unknown, and do not advance it by generation count', progress: 0, mood: 'Current tone', summary: 'Established circumstances and the focus of this run; possibilities are not established facts' },
    quests: [{ title: 'Encounter title', description: 'A new actionable opening beyond the source stopping point: another actor or event changes the situation before USER chooses a response', trigger: 'Concrete access or timing conditions, not a repeated source event or an instruction for USER to invent the next development', inject_prompt: 'An optional situational cue for the narrative; do not accept or act on behalf of USER' }],
    character_dynamics: [{ name: 'The CHAR who owns this affair; use an established name, never USER or an alias; group chats may include several CHARs', title: 'Title for 此间一人', content: "CHAR's own affair carried into a concrete action, resulting condition, or consequential next step beyond the source recap; not a summary of the latest interaction with USER" }],
    npc_updates: [{ name: 'Other character name, excluding USER and every CHAR in the current chat', role: 'Identity or role', current_goal: "This person's own present concern", emotional_state: 'Grounded present state', next_action: 'Specific next action and what it changes, with its conditions; not a request for USER to supply the development', hidden_agenda: 'Leave blank unless a concealed intention has a concrete basis; privacy or uncertainty alone does not imply malice or a conspiracy', relations: 'Specific ties with other people that matter to this affair, not automatically a tie to USER or CHAR', inject_prompt: 'A cue that can be carried forward; do not portray a possibility as already having happened' }],
    chain_reactions: [{ spark: 'Concrete cause, briefly identifying what is already established', chain: 'Extend beyond the already narrated effects: affected party, transmission, action, and a downstream consequence not yet present in the narrative; identify conditions and candidate status for what has not happened' }],
    relation_undercurrents: [{ parties: 'The two or more people involved; include independently motivated supporting relationships, not only USER and CHAR', tone: 'Relationship tone grounded in their actual circumstances', tension: 'A distinct relational concern expressed through a specific behavior or exchange not already recapped in another entry', drift: 'What this expression changes or keeps constrained, with conditions for a possible next development', user_awareness: "The actual extent of USER's knowledge, not everything the reader can see" }],
  };
  if (enabled('world_chatter', options)) shape.world_chatter = [{ text: 'Brief soundscape', who: 'Person or group', where: 'Location' }];
  if (enabled('factions', options)) {
    shape.factions = [{ id: 'Reuse the existing id; leave blank for a new entry', name: 'Organization name', type: 'Organization type', agenda: 'Aims', standing: 'Current circumstances', trend: 'One of rising/stable/declining/turbulent', scale: 'One of 城邦内/区域性/跨区域/全局性, chosen according to actual scale', clues: ['Concrete signs, rumors, or responses'] }];
    shape.faction_relations = [{ between: ['Organization name or id', 'Organization name or id'], kind: '冲突/同盟/张力/中立/依附', note: 'Actual connection and its basis' }];
    shape.world_events = [{ id: 'Reuse the existing id; leave blank for a new entry', title: 'Situation title', essence: 'An ongoing situation with active effects and its present impact', scope: 'Actual scope involved', stage: '酝酿/爆发/蔓延/消退/落定', drift: 'Possible direction and its conditions', touched: 'advance/mention/idle', status: 'active/closed' }];
  }
  if (enabled('parallel_scene', options)) shape.parallel_scene = { title: 'Title for 未映之幕', content: 'A complete scene explicitly true within a parallel side story' };
  if (enabled('interlude', options)) shape.interlude = { type: ['theater', 'phone'].includes(options.interludeType) ? options.interludeType : 'Selected for this run: theater or phone', title: 'Title for 幕间拾趣', owner: options.interludeType === 'phone' ? "Choose the phone's owner from non-USER characters already present in this run's narrative or valid memory" : '', content: 'A complete card in the specified form' };
  shape.limitations = [{ field: 'Name the output field only when it is genuinely constrained', missing: 1, reason: 'The specific source or setting constraint that makes completion necessarily cross a boundary; missing is the actual positive-integer shortfall; use limitations: [] when complete' }];
  const quotas = Object.entries(CREATIVE_COUNTS).filter(([field]) => enabled(field, options)).map(([field, count]) => {
    const label = CREATIVE_SECTION_LABELS[field] || ({ factions: '世界格局: organizations', world_events: '世界格局: situations' })[field];
    return `${field} (${label}): ${count.max === count.min ? `exactly ${count.min}` : count.max ? `${count.min}–${count.max}` : `at least ${count.min}`} ${CARD_FIELDS.includes(field) ? 'complete card' : 'substantive entries'}`;
  });
  const ownerRule = options.interludeType === 'phone' && Array.isArray(options.eligiblePhoneOwners)
    ? `\nChoose the phone's owner only from this run's confirmed list: ${JSON.stringify(options.eligiblePhoneOwners)}. Exclude USER and every alias; do not invent an owner when the list is empty.` : '';
  const roleRule = names(characterNames(options)).length
    ? `\nConfirmed CHAR names for this request: ${JSON.stringify(characterNames(options))}. Use a name from this list for character_dynamics.name; npc_updates covers other people. USER and aliases ${JSON.stringify(options.personaNames || [])} are excluded from both sections as the subject. They may appear in an interaction without becoming its subject.` : '';
  return `Return only one JSON object with the following field shapes (arrays show one structural example; use the required counts below for the actual output). Write narrative text in the current chat's language; default to Chinese when no language is established. English instructions and field descriptions do not require English story output. Preserve JSON keys and enum values exactly.\n${JSON.stringify(shape, null, 2)}\n\n${quotas.join('\n')}\nFill faction_relations only from actual connections; do not force links or new additions. Report shortfalls honestly in limitations; reporting a shortfall does not satisfy the required count. Distinguish possibilities from established experiences. Write candidates concretely without turning them into mainline facts. Every encounter provides a new opening, every CHAR entry carries an affair forward, and every ripple extends into a new downstream consequence; recaps and repeated emotional readings do not satisfy these purposes. Enduring world states and relationships can remain in force when their current effects add distinct information. Do not generate disabled sections. 未映之幕 and 幕间拾趣 are independent and have no narrative-injection fields.${roleRule}${ownerRule}`;
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
function itemProblem(field, item, options) {
  if (!isObject(item)) return '条目不是有效对象';
  // Only an explicit structured subject can prove a role violation. Do not
  // infer it from mentions in prose/title or reject existing unnamed DIY cards.
  if (['character_dynamics', 'npc_updates'].includes(field) && has(item, 'name')) {
    const subject = canonical(item.name);
    const users = new Set(['user', '{{user}}', '<user>', '用户', ...names(options.personaNames)]);
    const characters = new Set(names(characterNames(options)));
    if (users.has(subject)) return '人物动态主体不能是 USER 或其别名';
    if (field === 'character_dynamics' && characters.size && !characters.has(subject)) return '此间一人的主体须为本聊天的 CHAR';
    if (field === 'npc_updates' && characters.has(subject)) return 'CHAR 的事务应在此间一人，不计入其他人物动向';
  }
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

function inspectArray(field, value, options) {
  const validIndices = [], invalidIndices = [], duplicateIndices = [], seen = new Set();
  if (!Array.isArray(value)) return { validIndices, invalidIndices, duplicateIndices };
  value.forEach((item, index) => {
    if (itemProblem(field, item, options)) { invalidIndices.push(index); return; }
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
    const { validIndices, invalidIndices, duplicateIndices } = inspectArray(field, value, options);
    if (invalidIndices.length) issues.push({ field, reason: `空白、占位或栏目内容不合要求的条目不计数：${[...new Set(invalidIndices.map(index => itemProblem(field, value[index], options)))].join('；')}`, indices: invalidIndices, validIndices });
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
