// Settings that Qianmu keeps per chat, inside the shared ST settings file.
//
// They are keyed by the chat file name and used to be kept forever: every chat ever opened left an entry,
// and ST rewrites the whole settings file on each save. This module lists those tables in one place so a
// deleted chat's entries are removed and a renamed chat's entries move with it.
//
// Caveat: ST chat names are only unique per character, so two characters with an identically named chat
// share these entries (as they always have). ST's default names contain the character name and a
// timestamp, so in practice this only happens with hand-made names.
const ROOT_TABLES = ['selectedPresetNamesByChat', 'selectedPresetItemsByChat', 'selectedWorldBookNamesByChat', 'selectedWorldBookItemsByChat', 'enabledWorldBooksByChat'];
const FOCUS_TABLES = ['voiceEnabledByChat', 'voiceSpeakerByChat', 'voiceRelationByChat'];
const PROVIDER_TABLES = ['npcAssignByChat'];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// ST reports deleted chats without the extension and renamed ones with it.
export const chatKeyFromFileName = name => String(name ?? '').replace(/\.jsonl$/i, '');

export function chatScopedTables(settings) {
  const tables = [];
  if (!plain(settings)) return tables;
  for (const name of ROOT_TABLES) if (plain(settings[name])) tables.push(settings[name]);
  for (const name of FOCUS_TABLES) if (plain(settings.focusClock?.[name])) tables.push(settings.focusClock[name]);
  for (const provider of Object.values(plain(settings.tts?.providers) ? settings.tts.providers : {})) {
    for (const name of PROVIDER_TABLES) if (plain(provider?.[name])) tables.push(provider[name]);
  }
  return tables;
}

/** Removes the chat's entries from every per-chat table. Returns true when something was removed. */
export function forgetChatSettings(settings, chatKey) {
  const key = chatKeyFromFileName(chatKey);
  if (!key) return false;
  let changed = false;
  for (const table of chatScopedTables(settings)) if (Object.hasOwn(table, key)) { delete table[key]; changed = true; }
  return changed;
}

/** Moves the chat's entries to its new name. An existing entry under the new name is kept as is. */
export function renameChatSettings(settings, fromName, toName) {
  const from = chatKeyFromFileName(fromName), to = chatKeyFromFileName(toName);
  if (!from || !to || from === to) return false;
  let changed = false;
  for (const table of chatScopedTables(settings)) {
    if (!Object.hasOwn(table, from)) continue;
    if (!Object.hasOwn(table, to)) table[to] = table[from];
    delete table[from];
    changed = true;
  }
  return changed;
}
