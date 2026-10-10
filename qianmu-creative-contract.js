// Pure output contract. It checks structure and explicit empty/duplicate items,
// not narrative truth or literary quality; those remain in the creative guidance.
import { CREATIVE_COUNTS, CREATIVE_DETAIL_COUNTS, CREATIVE_SECTION_LABELS } from './qianmu-creative-prompts.js?v=1.59.448';

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
const userNames = options => new Set(['user', '{{user}}', '<user>', '用户', ...names(options.personaNames)]);
const charNames = options => new Set(['char', '{{char}}', '<char>', ...names(characterNames(options))]);
const arrayValue = (plan, field) => field === 'story_status' ? plan.story_status?.directions : plan[field];
function setArrayValue(plan, field, value) {
  if (field === 'story_status') {
    if (!isObject(plan.story_status)) plan.story_status = {};
    plan.story_status.directions = value;
  } else plan[field] = value;
}
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
    story_status: { title: 'Title for this run', current_arc: 'Current narrative thread', cycle: 'In-story date or time period, preferably a natural window or threshold; leave blank if unknown, do not advance it by generation count, and do not invent minute-level precision', directions: [{ horizon: 'near', title: 'Near-range trajectory anchored to a concrete upcoming time window (natural, not minute-precise)', content: "Definite candidate prose using a causal dramatic beat: named actor or group acts, another interest counters, and a verifiable new condition changes what someone can do, know, risk, keep, or lose; cross beyond USER/CHAR recap and end on a concrete recoverable hook, not a log-like next-step conclusion" }, { horizon: 'far', title: 'Far-range trajectory anchored to a named later phase or threshold', content: 'A distinct long-form development with a natural time anchor, subplot or delayed consequence, setup/payoff or side-character life; write definite planned events rather than forecasts, leave unresolved USER choices open, and stop on a concrete hook rather than deciding the next scene' }] },
    quests: [{ subject: 'Explicit person, group, or clearly named affair this preview concerns; never infer a person from the poetic title', title: 'Near-scene preview title', trigger: 'First of three linked third-person prose beats: write a standalone narrative sentence stating the established cause, access or limitation that lets this scene begin; use a natural sentence, not a XX time / trigger task notice', description: 'Second linked prose beat: continue from the condition into the concrete situation and its immediate consequence, naming the subject again when needed so this paragraph stands alone; this is the new opening beyond the source stopping point', inject_prompt: 'Third linked prose beat: write the first concrete action or line already entering the scene; prose, not an instruction to describe or arrange a scene, and no action decided for USER' }],
    character_dynamics: [{ name: 'The CHAR who owns this affair; use an established name, never USER or an alias; group chats may include several CHARs', title: 'Title for 此间一人', content: "Standalone third-person prose naming CHAR and carrying an independent affair into concrete action or changed conditions; not a summary of the latest interaction with USER or a writing instruction", emotional_state: 'A concise grounded emotional phrase, 4–32 characters; do not write an explanatory paragraph' }],
    npc_updates: [{ name: 'Other character name, excluding USER and every CHAR in the current chat', role: 'Identity or role', current_goal: "Third-person prose naming this person and their present concern, not an assigned objective", emotional_state: 'A concise grounded emotional phrase, 4–32 characters; do not write an explanatory paragraph', next_action: 'Standalone third-person narrative naming this person and the specific next action, resulting change and natural conditions; no task instructions', hidden_agenda: 'Leave blank unless a concealed intention has a concrete basis; privacy or uncertainty alone does not imply malice or a conspiracy', relations: 'Standalone third-person prose naming the people whose actual ties matter to this affair, not automatically USER or CHAR', inject_prompt: 'A short third-person opening beat naming this person in a concrete scene; naturally retain any needed future condition, rather than issuing writing instructions or declaring an unadopted possibility a mainline fact' }],
    chain_reactions: [{ spark: 'Concrete cause, briefly identifying what is already established', chain: '3–5 concise causal nodes joined by →, extending into a downstream consequence not yet present in the narrative; identify needed conditions. At least one chain spreads laterally across other affairs. Do not develop the USER–CHAR relationship' }],
    relation_undercurrents: [{ parties: ['Exact name of participant one', 'Exact name of participant two; optionally add one third participant'], tone: 'Brief relationship tone', tension: 'One concise relational concern and its concrete expression', drift: 'Its practical effect or constrained next development; exclude the USER–CHAR pair even when a third person is added. At least two entries involve supporting people only' }],
  };
  if (enabled('world_chatter', options)) shape.world_chatter = [{ text: 'A brief situated human voice: dialogue, self-talk, a call, complaint or joke, with just enough context to convey a life; not a clue report or pure ambient sound', who: 'The person or group whose voice is heard', where: 'Location' }];
  if (enabled('factions', options)) {
    shape.factions = [{ id: 'Reuse the existing id; leave blank for a new entry', name: 'Organization name', type: 'Organization type', agenda: 'Aims', standing: 'Current circumstances', trend: 'One of rising/stable/declining/turbulent', scale: 'One of 城邦内/区域性/跨区域/全局性, chosen according to actual scale', clues: ['Concrete signs, rumors, or responses'] }];
    shape.faction_relations = [{ between: ['Organization name or id', 'Organization name or id'], kind: '冲突/同盟/张力/中立/依附', note: 'Actual connection and its basis' }];
    shape.world_events = [{ id: 'Reuse the existing id; leave blank for a new entry', title: 'Situation title', essence: 'An ongoing situation with active effects and its present impact', scope: 'Actual scope involved', stage: '酝酿/爆发/蔓延/消退/落定', drift: 'Possible direction and its conditions', touched: 'advance/mention/idle', status: 'active/closed' }];
  }
  if (enabled('parallel_scene', options)) shape.parallel_scene = { content: 'An independently readable literary parallel scene connected to the mainline, set in the past, near future or distant future. Start with a natural time/place anchor, narrate one concrete alternate fact through 3–6 paragraphs with a turn and changed condition, and end on a specific action, object, line or situation rather than an abstract uplift or forecast; no title required, no prescribed emotion, no mainline factual effect' };
  if (enabled('interlude', options)) shape.interlude = options.interludeType === 'phone'
    ? { type: 'phone', title: 'The actual group name for a group chat, or the other contact display name for a direct chat; not a literary chapter title', owner: "Choose the phone's owner from non-USER characters already present in this run's narrative or valid memory; supporting people are eligible, not only CHAR or CHAR's immediate circle", conversation_kind: 'direct or group', messages: [{ sender: 'Speaker name', content: 'Plain-text message in this relationship and daily life, not automatically the current mainline assignment', time: 'Setting-appropriate message time' }] }
    : { type: options.interludeType === 'forum' ? 'forum' : 'Selected for this run: forum or phone', title: 'A lived-in, setting-appropriate forum or community name, not a literary chapter title', posts: [{ author: 'Author name', handle: 'Display handle', content: 'Plain-text social post with its own subject and voice, not automatically a report on the main cast', time: 'Setting-appropriate post time', replies: [{ author: 'Reply author', reply_to: 'Optional displayed author being answered; use for a direct back-and-forth or the original poster following up', content: 'Plain-text reply that responds naturally to the exchange' }] }] };
  shape.limitations = [{ field: 'Name the output field only when it is genuinely constrained', missing: 1, reason: 'The specific source or setting constraint that makes completion necessarily cross a boundary; missing is the actual positive-integer shortfall; use limitations: [] when complete' }];
  const quotas = Object.entries(CREATIVE_COUNTS).filter(([field]) => enabled(field, options)).map(([field, count]) => {
    const label = CREATIVE_SECTION_LABELS[field] || ({ factions: '世界格局: organizations', world_events: '世界格局: situations' })[field];
    return `${field} (${label}): ${count.max === count.min ? `exactly ${count.min}` : count.max ? `${count.min}–${count.max}` : `at least ${count.min}`} ${CARD_FIELDS.includes(field) ? 'complete card' : 'substantive entries'}`;
  });
  const ownerRule = options.interludeType === 'phone' && Array.isArray(options.eligiblePhoneOwners)
    ? `\nChoose the phone's owner only from this run's confirmed list: ${JSON.stringify(options.eligiblePhoneOwners)}. Exclude USER and every alias; do not invent an owner when the list is empty.` : '';
  const roleRule = names(characterNames(options)).length
    ? `\nConfirmed CHAR names for this request: ${JSON.stringify(characterNames(options))}. Use a name from this list for character_dynamics.name; npc_updates covers other people. USER and aliases ${JSON.stringify(options.personaNames || [])} are excluded from both sections as the subject. They may appear in an interaction without becoming its subject.` : '';
  const formRule = options.interludeType === 'phone'
    ? `Phone form: ${CREATIVE_DETAIL_COUNTS.phoneMessages.min}–${CREATIVE_DETAIL_COUNTS.phoneMessages.max} messages; conversation_kind is exactly direct or group. A direct exchange has exactly ${CREATIVE_DETAIL_COUNTS.phoneSpeakers.min} distinct speakers; a group exchange has at least ${CREATIVE_DETAIL_COUNTS.phoneSpeakers.min}.`
    : `Forum form: ${CREATIVE_DETAIL_COUNTS.forumPosts.min}–${CREATIVE_DETAIL_COUNTS.forumPosts.max} posts, each with ${CREATIVE_DETAIL_COUNTS.forumReplies.min}–${CREATIVE_DETAIL_COUNTS.forumReplies.max} replies. Adapt the fictional public exchange to the era rather than invent modern devices.`;
  return `Return only one JSON object with the following field shapes (use the required counts below for the actual output). Write narrative text in the current chat's language; default to Chinese when no language is established. English instructions and field descriptions do not require English story output. Preserve JSON keys and enum values exactly.\n${JSON.stringify(shape, null, 2)}\n\n${quotas.join('\n')}\nThe story_status count applies to its directions array: exactly one horizon near and one horizon far. Near and far are temporal anchors, not camera distance: each direction names a natural time window or threshold and contains an actionable dramatic beat beyond the current recap. Do not invent minute-level precision unless it is established in the source. At least one direction begins with a non-USER, non-CHAR actor or group unless the source is explicitly closed. Every direction must change a concrete condition and end on a specific recoverable hook; do not use vague forecasts, personality summaries, task assignments, log-like next-step conclusions, or abstract uplift. Every preview requires an explicit subject. Preview paragraphs are ordered 发生条件 → 情境 → 落笔 and must read as three linked prose beats: the condition is a natural narrative opening rather than a timestamp trigger, the situation continues it, and the short opening action closes the fragment. Selectable narrative fields must stand alone as third-person prose with the actual subject and natural conditions, without bracketed field labels or instructions for writing. Each CHAR and NPC emotional_state, when present, is a concise 4–32 character phrase, never an explanatory paragraph. Each ripple chain has 3–5 substantive nodes separated by →. Every relation uses an array of 2–3 exact participant names; across the three minimum relations include both a two-person and a three-person relation, and at least two relations include neither USER nor CHAR. A USER–CHAR pair remains excluded when a third person is present.\nFill faction_relations only from actual connections; do not force links or new additions. World events must include at least one non-USER, non-CHAR institutional, regional, neighborhood, trade, or public-service situation and must not duplicate a 命运之脉 trajectory. Report shortfalls honestly in limitations; reporting a shortfall does not satisfy the required count. Distinguish possibilities from established experiences. Write candidates concretely without turning them into mainline facts. Every preview provides a new opening, every CHAR entry carries an affair forward, and every ripple extends into a new downstream consequence; recaps and repeated emotional readings do not satisfy these purposes. 未映之幕, when enabled, is one independently readable 3–6 paragraph scene with a natural time/place anchor, a concrete turn and a specific ending; it is not a synopsis, branch analysis, or moral epilogue. Enduring world states and relationships can remain in force when their current effects add distinct information. Do not generate disabled sections. 未映之幕 and 幕间拾趣 are independent and have no narrative-injection fields. ${enabled('interlude', options) ? formRule + ' All generated fields are plain text, never HTML. Do not generate legacy theater/content cards.' : ''}${roleRule}${ownerRule}`;
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
  story_status: ['content'],
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
  if (['character_dynamics', 'npc_updates'].includes(field) && item?.emotional_state !== undefined && item?.emotional_state !== null) {
    const emotion = text(item.emotional_state).trim();
    const length = [...emotion].length;
    if (!emotion || length < CREATIVE_DETAIL_COUNTS.emotionChars.min || length > CREATIVE_DETAIL_COUNTS.emotionChars.max) {
      return `情绪需为 ${CREATIVE_DETAIL_COUNTS.emotionChars.min}–${CREATIVE_DETAIL_COUNTS.emotionChars.max} 字的简短短语`;
    }
  }
  switch (field) {
    case 'story_status': return ['near', 'far'].includes(item.horizon) && has(item, 'title') && has(item, 'content') ? '' : '命运之脉须标明 near 或 far，并包含标题与具体内容';
    case 'quests': return has(item, 'subject') && has(item, 'description', 'content', 'objective') ? '' : '缺少明确主体或可回应的具体情境';
    case 'character_dynamics': return has(item, 'content', 'current_goal', 'next_action', 'hidden_agenda', 'relations') ? '' : '缺少具体人物事务';
    case 'npc_updates': return has(item, 'name', 'title') && has(item, ...CONTENT_FIELDS[field]) ? '' : '缺少人物或具体事务';
    case 'chain_reactions': {
      const nodes = text(item.chain).split('→').map(value => value.trim());
      return has(item, 'spark') && nodes.length >= CREATIVE_DETAIL_COUNTS.rippleNodes.min && nodes.length <= CREATIVE_DETAIL_COUNTS.rippleNodes.max && nodes.every(substantive) ? '' : '涟漪须有具体起因及用 → 连接的 3–5 个有效短节点';
    }
    case 'relation_undercurrents': {
      if (!Array.isArray(item.parties) || item.parties.length < CREATIVE_DETAIL_COUNTS.relationParties.min || item.parties.length > CREATIVE_DETAIL_COUNTS.relationParties.max
        || !item.parties.every(substantive) || new Set(names(item.parties)).size !== item.parties.length || !has(item, ...CONTENT_FIELDS[field])) return '关系须包含 2–3 个明确姓名及具体关切';
      const participants = names(item.parties);
      return participants.some(name => userNames(options).has(name)) && participants.some(name => charNames(options).has(name)) ? '关系暗涌不包含 USER–CHAR 关系，加入第三人也不能替代这一边界' : '';
    }
    case 'world_chatter': return has(item, 'text') && has(item, 'who') ? '' : '缺少具体当事者或有效信息';
    case 'factions': return has(item, 'name') && (has(item, 'agenda', 'standing', 'trend') || (Array.isArray(item.clues) && item.clues.some(substantive))) ? '' : '缺少组织名或有效处境';
    case 'faction_relations': return Array.isArray(item.between) && item.between.length === 2 && item.between.every(substantive) && canonical(item.between[0]) !== canonical(item.between[1]) && has(item, 'kind', 'note') ? '' : '缺少两方实际联系';
    case 'world_events': return has(item, 'title') && has(item, 'essence', 'content') ? '' : '缺少局势名或实际内容';
    default: return '';
  }
}

function inspectArray(field, value, options) {
  const validIndices = [], invalidIndices = [], duplicateIndices = [], seen = new Set(), horizons = new Set();
  if (!Array.isArray(value)) return { validIndices, invalidIndices, duplicateIndices };
  value.forEach((item, index) => {
    if (itemProblem(field, item, options)) { invalidIndices.push(index); return; }
    const key = joined(item, CONTENT_FIELDS[field]);
    if (seen.has(key) || (field === 'story_status' && horizons.has(item.horizon))) { duplicateIndices.push(index); return; }
    seen.add(key);
    if (field === 'story_status') horizons.add(item.horizon);
    validIndices.push(index);
  });
  return { validIndices, invalidIndices, duplicateIndices };
}

function cardProblem(field, card, options) {
  if (field === 'parallel_scene') return isObject(card) && has(card, 'content') ? '' : '缺少一幕完整可读的正文';
  if (!isObject(card) || !has(card, 'title')) return '缺少幕间拾趣卡片或名称';
  if (!['forum', 'phone'].includes(options.interludeType)) return '本轮未指定幕间拾趣形式';
  if (card.type !== options.interludeType) return '幕间拾趣形式与本轮指定形式不符';
  if (card.type === 'forum') {
    if (!Array.isArray(card.posts) || card.posts.length < CREATIVE_DETAIL_COUNTS.forumPosts.min || card.posts.length > CREATIVE_DETAIL_COUNTS.forumPosts.max) return '论坛须有 3–5 帖';
    if (new Set(card.posts.map(post => canonical(post?.content))).size !== card.posts.length) return '论坛不能以重复帖子凑数';
    for (const post of card.posts) {
      if (!isObject(post) || !['author', 'handle', 'content', 'time'].every(key => has(post, key))) return '论坛帖子缺少作者、称呼、正文或时间';
      if (!Array.isArray(post.replies) || post.replies.length < CREATIVE_DETAIL_COUNTS.forumReplies.min || post.replies.length > CREATIVE_DETAIL_COUNTS.forumReplies.max
        || !post.replies.every(reply => isObject(reply) && has(reply, 'author') && has(reply, 'content'))) return '每帖须有 1–3 条完整回复';
    }
    return '';
  }
  if (!['direct', 'group'].includes(card.conversation_kind)) return '手机会话须明确为 direct 或 group';
  if (!Array.isArray(card.messages) || card.messages.length < CREATIVE_DETAIL_COUNTS.phoneMessages.min || card.messages.length > CREATIVE_DETAIL_COUNTS.phoneMessages.max
    || !card.messages.every(message => isObject(message) && ['sender', 'content', 'time'].every(key => has(message, key)))) return '手机须有 6–10 条包含发送者、内容与时间的完整消息';
  const speakerCount = new Set(names(card.messages.map(message => message.sender))).size;
  if (speakerCount < CREATIVE_DETAIL_COUNTS.phoneSpeakers.min) return '手机消息至少由两位说话者组成';
  if (card.conversation_kind === 'direct' && speakerCount !== CREATIVE_DETAIL_COUNTS.phoneSpeakers.min) return '私聊须恰好由两位说话者组成';
  if (new Set(card.messages.map(message => joined(message, ['sender', 'content', 'time']))).size !== card.messages.length) return '手机不能以完全相同的消息记录凑数';
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
  for (const field of ['story_status', ...CORE_ARRAYS, ...WORLD_ARRAYS]) {
    const value = arrayValue(source, field), count = CREATIVE_COUNTS[field];
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
    if (duplicateIndices.length) issues.push({ field, reason: field === 'story_status' ? '命运之脉内容不得重复，近线 near 与远线 far 各一条' : '同栏目重复内容不重复计数', indices: duplicateIndices, validIndices });
    if (count && validIndices.length < count.min) issues.push({ field, reason: '有效内容不足', missing: count.min - validIndices.length, indices: [...invalidIndices, ...duplicateIndices].sort((a, b) => a - b), validIndices });
    if (count?.max && validIndices.length > count.max) issues.push({ field, reason: '本次输出超过栏目数量上限', excess: validIndices.length - count.max, max: count.max, validIndices });
    if (field === 'relation_undercurrents') {
      const principals = new Set([...userNames(options), ...charNames(options)]);
      const supporting = validIndices.filter(index => names(value[index].parties).every(name => !principals.has(name)));
      if (supporting.length < CREATIVE_DETAIL_COUNTS.supportingRelations.min) issues.push({ field, reason: '至少两条关系须在配角之间，不以 USER 或 CHAR 为参与者', missing: CREATIVE_DETAIL_COUNTS.supportingRelations.min - supporting.length, indices: [], validIndices });
      if (validIndices.length >= (CREATIVE_COUNTS[field]?.min || 0)) {
        const sizes = new Set(validIndices.map(index => value[index]?.parties?.length));
        if (!sizes.has(CREATIVE_DETAIL_COUNTS.relationParties.min) || !sizes.has(CREATIVE_DETAIL_COUNTS.relationParties.max)) {
          issues.push({ field, reason: '关系暗涌至少要混合一条双人关系与一条三人关系', missing: 1, indices: [], validIndices });
        }
      }
    }
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
    const value = arrayValue(result, field);
    if (!Array.isArray(value)) {
      if (value !== undefined) removed.push({ field, value: clone(value), reason: relevant[0].reason });
      setArrayValue(result, field, []);
      continue;
    }
    const indices = new Set(relevant.flatMap(issue => issue.indices || []));
    setArrayValue(result, field, value.filter((item, index) => {
      if (!indices.has(index)) return true;
      removed.push({ field, index, value: clone(item), reason: relevant.find(issue => issue.indices?.includes(index))?.reason || '' });
      return false;
    }));
    // Excess but otherwise valid entries are not arbitrarily discarded here.
  }
  return { plan: result, removed };
}

// Whitelist scalar properties at every level: a custom schema's nested extra
// content cannot sneak a parallel/interlude payload into mainline continuity.
const CONTINUITY_FIELDS = {
  story_status: ['title', 'current_arc', 'current_stage', 'cycle', 'progress', 'mood', 'summary'],
  quests: ['id', 'type', 'subject', 'title', 'objective', 'description', 'priority', 'status', 'deadline', 'trigger', 'reward'],
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
      const value = projectItem(plan[field], allowed) || {};
      if (Array.isArray(plan[field]?.directions)) value.directions = plan[field].directions.map(item => projectItem(item, ['horizon', 'title', 'content'])).filter(Boolean);
      if (Object.keys(value).length) result[field] = value;
    } else if (Array.isArray(plan[field])) result[field] = plan[field].map(item => projectItem(item, allowed)).filter(Boolean);
  }
  return result;
}
