// Creative defaults and one-request state. No storage, network or model calls.
import { hashText } from './qianmu-storyboard-utils.js';
import { validateCreativePlan } from './qianmu-creative-contract.js?v=1.59.446';

// Exact bundled defaults from v1.59.442 through v1.59.445, not phrase-based DIY detection.
const LEGACY_DEFAULT_HASHES = Object.freeze({
  systemPrompt: Object.freeze(['2045b006', '91ad6303', 'a4c1bafd', '39271a80']),
  outputSchemaText: Object.freeze(['05c30a9e', '1bc3cd38', '241c5ebc', '3826d107']),
  blueprint: Object.freeze(['4c919687', '1d95c305', '261d4a1a']),
});
const unchangedDefault = (value, current, legacyHashes, appliedHash) => {
  const text = String(value ?? '');
  return !text.trim() || text === current || legacyHashes.includes(hashText(text))
    || (appliedHash && appliedHash !== '__legacy__' && hashText(text) === appliedHash);
};

export function upgradeCreativeDefaults(settings, { systemPrompt, outputSchemaText, blueprint }) {
  for (const [field, next, applied, marker] of [
    ['systemPrompt', systemPrompt, 'appliedPromptDefaultHash', 'systemPromptHash'],
    ['outputSchemaText', outputSchemaText, 'appliedSchemaDefaultHash', 'outputSchemaHash'],
  ]) {
    if (unchangedDefault(settings[field], next, LEGACY_DEFAULT_HASHES[field], settings[applied])) settings[field] = next;
    settings[applied] = hashText(next);
    settings[marker] = settings[field] === next ? hashText(next) : '';
  }
  // A library item's identity alone never authorizes replacing edited content.
  for (const template of Array.isArray(settings.templates) ? settings.templates : []) {
    if (template?.id === 'default-free-blueprint' && !template.edited
      && unchangedDefault(template.content, blueprint, LEGACY_DEFAULT_HASHES.blueprint)) template.content = blueprint;
  }
  delete settings._promptFirstSeedLegacy;
  delete settings._schemaFirstSeedLegacy;
  return settings;
}

export function upgradeCreativeBlueprint(store, blueprint, revision) {
  if (!store.blueprintEdited && unchangedDefault(store.blueprint, blueprint, LEGACY_DEFAULT_HASHES.blueprint, store.appliedBlueprintDefaultHash)) {
    store.blueprint = blueprint;
  }
  store.appliedBlueprintDefaultHash = hashText(blueprint);
  store.blueprintRevision = revision;
  return store;
}

export function recentInterludeHint(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return '';
  const short = (value, max) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
  const first = card.type === 'forum' ? card.posts?.[0]?.content : card.type === 'phone' ? card.messages?.[0]?.content : card.content;
  const hint = { type: short(card.type, 16), title: short(card.title, 80), first_excerpt: short(first, 180) };
  return hint.title || hint.first_excerpt ? JSON.stringify(hint) : '';
}

export function selectCreativeOptions(settings = {}, { chat = [], personaNames = [], characterName = '', characterNames, sourceText = '', narrativeText = '', previousInterlude, random = Math.random } = {}) {
  const normalize = name => String(name || '').trim().toLocaleLowerCase();
  const excluded = new Set(personaNames.map(normalize).filter(Boolean));
  for (const message of chat) if (message?.is_user) excluded.add(normalize(message.name));
  const owners = [...new Set(chat.filter(message => message && !message.is_user && !message.is_system)
    .map(message => String(message.name || '').trim()).filter(name => name && !excluded.has(normalize(name))))];
  const hasPhone = /手机|短信|群聊|微信|移动终端|smartphone|cell\s*phone|text\s*message|group\s*chat/i.test(sourceText);
  const interludeEnabled = settings.interludeEnabled !== false;
  const interludeType = !interludeEnabled ? null : hasPhone && owners.length && random() >= .5 ? 'phone' : 'forum';
  return Object.freeze({
    worldChatterEnabled: Boolean(settings.worldChatterEnabled), geopoliticsEnabled: Boolean(settings.geopoliticsEnabled),
    parallelSceneEnabled: settings.parallelSceneEnabled !== false, interludeEnabled, interludeType,
    newcomerMode: settings.newcomerMode === true,
    recentInterludeHint: interludeEnabled ? recentInterludeHint(previousInterlude) : '',
    personaNames: [...excluded], characterName,
    characterNames: [...new Set((Array.isArray(characterNames) ? characterNames : [characterName])
      .filter(name => typeof name === 'string').map(name => name.trim()).filter(name => name && !excluded.has(normalize(name))))],
    phoneSourceText: narrativeText,
  });
}

export function mergeCreativeRepair(plan, patch, issues, options = {}) {
  const fields = [...new Set(issues.map(issue => issue.field))];
  for (const field of fields) {
    if (['parallel_scene', 'interlude'].includes(field)) {
      if (patch[field] && typeof patch[field] === 'object' && !Array.isArray(patch[field])) plan[field] = patch[field];
      continue;
    }
    const entries = field === 'story_status' ? plan.story_status?.directions : plan[field];
    const additions = field === 'story_status' ? patch.story_status?.directions : patch[field];
    const setEntries = value => {
      if (field === 'story_status') {
        if (!plan.story_status || typeof plan.story_status !== 'object' || Array.isArray(plan.story_status)) plan.story_status = {};
        plan.story_status.directions = value;
      } else plan[field] = value;
    };
    const excess = issues.find(issue => issue.field === field && issue.excess > 0);
    if (excess) {
      // A repair may select existing entries, never rewrite good entries to meet an upper bound.
      const indices = patch.keep_indices?.[field];
      if (Array.isArray(entries) && Array.isArray(indices) && indices.length === excess.max
        && new Set(indices).size === indices.length && indices.every(index => Number.isInteger(index) && excess.validIndices.includes(index))) {
        setEntries(indices.map(index => entries[index]));
      }
      continue;
    }
    if (!Array.isArray(additions)) continue;
    const missing = Math.max(0, ...issues.filter(issue => issue.field === field).map(issue => Number(issue.missing) || 0));
    if (missing) setEntries([...(Array.isArray(entries) ? entries : []), ...additions.slice(0, missing)]);
    else if (field === 'faction_relations' && !Array.isArray(entries)) setEntries(additions);
  }
  if (Array.isArray(patch.limitations)) plan.limitations = patch.limitations;
  const gaps = validateCreativePlan({ ...plan, limitations: [] }, options);
  if (Array.isArray(plan.limitations)) plan.limitations = plan.limitations.filter(item =>
    item?.missing > 0 && gaps.some(issue => issue.field === item.field && issue.missing === item.missing));
  return plan;
}
