// Persistent focus voice identity is a character avatar, never a chat or display name.
const providers = new Set(['minimax', 'doubao', 'elevenlabs']);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const focusVoiceCharacterKey = avatar => avatar ? `character:${encodeURIComponent(String(avatar))}` : '';

export function cleanFocusVoice(value) {
  if (!record(value) || typeof value.voiceId !== 'string' || !value.voiceId.trim()) return null;
  return {
    voiceId: String(value.voiceId).trim().slice(0, 1024), name: String(value.name || value.voiceId).slice(0, 160),
    model: String(value.model || '').slice(0, 160),
    speed: typeof value.speed === 'number' && Number.isFinite(value.speed) ? Math.max(.5, Math.min(2, value.speed)) : null,
    emotion: String(value.emotion || 'auto').slice(0, 80),
  };
}

export function focusVoiceProfile(state, characterKey, providerId) {
  if (!characterKey || !providers.has(providerId)) return null;
  const profile = state?.voiceProfiles?.[characterKey]?.[providerId];
  return record(profile) ? profile : null;
}

export function saveFocusVoiceProfile(state, characterKey, providerId, voice, enabled = false) {
  if (!/^character:.+/.test(characterKey) || !providers.has(providerId)) return null;
  if (!record(state.voiceProfiles)) state.voiceProfiles = {};
  if (!record(state.voiceProfiles[characterKey])) state.voiceProfiles[characterKey] = {};
  const previous = focusVoiceProfile(state, characterKey, providerId);
  const revision = Number.isSafeInteger(previous?.revision) && previous.revision < Number.MAX_SAFE_INTEGER ? previous.revision + 1 : 1;
  const result = { voice: cleanFocusVoice(voice), enabled: Boolean(enabled), revision };
  state.voiceProfiles[characterKey][providerId] = result;
  return result;
}

export function focusVoiceOptions({ library = [], current = null, chat = [] } = {}) {
  const options = [], seen = new Set();
  const add = (source, suffix) => {
    const voice = cleanFocusVoice(source);
    if (!voice) return;
    const key = JSON.stringify([voice.voiceId, voice.model, voice.speed, voice.emotion]);
    if (seen.has(key)) return;
    seen.add(key); options.push({ ...voice, key, label: `${voice.name} · ${suffix} · ${voice.voiceId.slice(-12)}` });
  };
  if (current) add(current, '已绑定');
  for (const row of Array.isArray(library) ? library : []) add(row, '音色库');
  for (const row of Array.isArray(chat) ? chat : []) add(row, '当前聊天');
  return options;
}
