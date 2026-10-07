// Creative defaults and one-request state. No storage, network or model calls.
import { hashText } from './qianmu-storyboard-utils.js';
import { validateCreativePlan } from './qianmu-creative-contract.js?v=1.59.443';

const LEGACY_DEFAULT_HASHES = Object.freeze({ systemPrompt: '2045b006', outputSchemaText: '05c30a9e', blueprint: '4c919687' });
const unchangedDefault = (value, current, legacyHash, appliedHash) => {
  const text = String(value ?? '');
  return !text.trim() || text === current || hashText(text) === legacyHash
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

export function selectCreativeOptions(settings = {}, { chat = [], personaNames = [], characterName = '', sourceText = '', narrativeText = '', random = Math.random } = {}) {
  const normalize = name => String(name || '').trim().toLocaleLowerCase();
  const excluded = new Set(personaNames.map(normalize).filter(Boolean));
  for (const message of chat) if (message?.is_user) excluded.add(normalize(message.name));
  const owners = [...new Set(chat.filter(message => message && !message.is_user && !message.is_system)
    .map(message => String(message.name || '').trim()).filter(name => name && !excluded.has(normalize(name))))];
  const hasPhone = /手机|短信|群聊|微信|移动终端|smartphone|cell\s*phone|text\s*message|group\s*chat/i.test(sourceText);
  const interludeEnabled = settings.interludeEnabled !== false;
  const interludeType = !interludeEnabled ? null : hasPhone && owners.length && random() >= .5 ? 'phone' : 'theater';
  return Object.freeze({
    worldChatterEnabled: Boolean(settings.worldChatterEnabled), geopoliticsEnabled: Boolean(settings.geopoliticsEnabled),
    parallelSceneEnabled: settings.parallelSceneEnabled !== false, interludeEnabled, interludeType,
    personaNames: [...excluded], characterName, phoneSourceText: narrativeText,
  });
}

export function mergeCreativeRepair(plan, patch, issues, options = {}) {
  const fields = [...new Set(issues.map(issue => issue.field))];
  for (const field of fields) {
    if (['parallel_scene', 'interlude'].includes(field)) {
      if (patch[field] && typeof patch[field] === 'object' && !Array.isArray(patch[field])) plan[field] = patch[field];
      continue;
    }
    const excess = issues.find(issue => issue.field === field && issue.excess > 0);
    if (excess) {
      // A repair may select existing entries, never rewrite good entries to meet an upper bound.
      const indices = patch.keep_indices?.[field];
      if (Array.isArray(plan[field]) && Array.isArray(indices) && indices.length === excess.max
        && new Set(indices).size === indices.length && indices.every(index => Number.isInteger(index) && excess.validIndices.includes(index))) {
        plan[field] = indices.map(index => plan[field][index]);
      }
      continue;
    }
    if (!Array.isArray(patch[field])) continue;
    const missing = Math.max(0, ...issues.filter(issue => issue.field === field).map(issue => Number(issue.missing) || 0));
    if (missing) plan[field] = [...(Array.isArray(plan[field]) ? plan[field] : []), ...patch[field].slice(0, missing)];
    else if (field === 'faction_relations' && !Array.isArray(plan[field])) plan[field] = patch[field];
  }
  if (Array.isArray(patch.limitations)) plan.limitations = patch.limitations;
  const gaps = validateCreativePlan({ ...plan, limitations: [] }, options);
  if (Array.isArray(plan.limitations)) plan.limitations = plan.limitations.filter(item =>
    item?.missing > 0 && gaps.some(issue => issue.field === item.field && issue.missing === item.missing));
  return plan;
}
