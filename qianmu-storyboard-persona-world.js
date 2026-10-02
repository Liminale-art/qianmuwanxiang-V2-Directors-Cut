// Binding metadata only. No host imports, worldbook reads, persistence or activation scan.
const own = (value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
const text = value => typeof value === 'string' && value.trim() ? value : '';
const strings = value => Array.isArray(value) ? [...new Set(value.filter(item => text(item))) ] : [];
const kindOf = value => value === 'char' || value === 'user' ? value : '';

function requireOwner(kind, id, books) {
  if (!id && books.length) {
    throw Object.assign(new Error(kind === 'char'
      ? '当前角色身份未能确认，未引用其绑定世界书，请重新打开当前聊天。'
      : '当前用户人设身份未能确认，未引用其绑定世界书，请重新选择当前人设。'),
    {code:'storyboard_persona_world_owner_unavailable',kind});
  }
  return id ? {kind,id,books} : null;
}

export function readPersonaWorldBindings(context, {userAvatar,worldInfo} = {}) {
  const characters = own(context,'characters'), characterId = own(context,'characterId');
  // Only ST's current character is in scope, even in a group. Never scan group members.
  const character = characterId !== undefined && characterId !== null ? own(characters,characterId) : undefined;
  const avatar = text(own(character,'avatar'));
  const primary = text(own(own(own(character,'data'),'extensions'),'world'));
  const filename = avatar.replace(/\.[^/.]+$/, ''); // ST getCharaFilename semantics.
  const lore = own(worldInfo,'charLore');
  const extra = avatar && Array.isArray(lore) ? lore.find(row => own(row,'name') === filename) : undefined;
  const charBooks = strings([primary,...strings(own(extra,'extraBooks'))]);
  const power = own(context,'powerUserSettings');
  const userBook = text(own(power,'persona_description_lorebook'));
  const owners = [requireOwner('char',avatar,charBooks),requireOwner('user',text(userAvatar),userBook ? [userBook] : [])].filter(Boolean);
  return {owners,signature:JSON.stringify(owners)};
}

// Use tuples, not separators: book names and avatar keys may contain punctuation.
export function personaWorldSelectionKey(record) {
  const kind = kindOf(own(record,'kind')), owner = text(own(record,'owner')), book = text(own(record,'book'));
  return kind && owner && book ? JSON.stringify([kind,owner,book]) : '';
}

export function normalizePersonaWorldSelections(value) {
  if (!Array.isArray(value)) return [];
  const records = new Map();
  for (const item of value) {
    const key = personaWorldSelectionKey(item), enabled = own(item,'enabled'), entries = own(item,'entryIds');
    // Old implicit selections and malformed records cannot become new consent.
    if (!key || typeof enabled !== 'boolean' || !Array.isArray(entries)) continue;
    records.set(key,{kind:own(item,'kind'),owner:own(item,'owner'),book:own(item,'book'),entryIds:strings(entries),enabled});
  }
  return [...records.values()];
}

export function activePersonaWorldSelections(records, bindings) {
  const allowed = new Set();
  const owners = own(bindings,'owners');
  for (const owner of Array.isArray(owners) ? owners : []) {
    for (const book of strings(own(owner,'books'))) {
      const key = personaWorldSelectionKey({kind:own(owner,'kind'),owner:own(owner,'id'),book});
      if (key) allowed.add(key);
    }
  }
  // An explicitly confirmed empty entry list remains empty; newly added entries
  // are never inferred here. Disabled records stay stored but are not active.
  return normalizePersonaWorldSelections(records).filter(record => record.enabled && allowed.has(personaWorldSelectionKey(record)));
}
