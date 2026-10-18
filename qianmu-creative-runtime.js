// Creative defaults and one-request state. No storage, network or model calls.
import { hashText } from './qianmu-storyboard-utils.js';
import { validateCreativePlan } from './qianmu-creative-contract.js?v=1.59.464';

// Exact bundled defaults from prior releases, not phrase-based DIY detection.
// Exact defaults through v1.59.463 are included so this release can migrate prior
// built-in prose while preserving any text the author actually edited.
const LEGACY_DEFAULT_HASHES = Object.freeze({
  systemPrompt: Object.freeze(['2045b006', '91ad6303', 'a4c1bafd', '39271a80', 'bba2effb', 'c7c6f33d', 'b7f8c92b', 'e2441079', 'c3b76978', 'dd2092c1', '355e4aed', '24243610', '04b8c901', '473373cb']),
  outputSchemaText: Object.freeze(['05c30a9e', '1bc3cd38', '241c5ebc', '3826d107', '51ab8d18', 'e8981ef7', '5e96c8fa', 'd3522824', '2013edaf', '2776c64f', 'f57a17f7', '2705ca8b', '8c9d7978']),
  blueprint: Object.freeze(['4c919687', '1d95c305', '261d4a1a', '1d8cdeb6', 'af9d17bf', '352d7c3f', '321cc304', '87904bd2', '40c652ba', '370762df', 'e8c57aa2']),
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
  // A meta-fictional experience must not become a later narrative reference.
  // Only form and cast metadata may identify a recent side page, never its words.
  if (card.type === 'fourth_wall') return JSON.stringify({ type: 'fourth_wall', form: short(card.form, 16), character: short(card.character, 60) });
  const first = card.type === 'forum' || (card.type === 'phone' && ['moments', 'microblog'].includes(card.view_type))
    ? card.posts?.[0]?.content : card.type === 'phone' ? card.messages?.[0]?.content : card.content;
  const hint = { type: short(card.type, 16), title: short(card.title, 80), first_excerpt: short(first, 180) };
  if (card.type === 'phone' && short(card.owner, 60)) hint.owner = short(card.owner, 60);
  return hint.title || hint.first_excerpt ? JSON.stringify(hint) : '';
}

export function selectCreativeOptions(settings = {}, { chat = [], personaNames = [], characterName = '', characterNames, sourceText = '', narrativeText = '', previousInterlude, random = Math.random } = {}) {
  const normalize = name => String(name || '').trim().toLocaleLowerCase();
  const excluded = new Set(personaNames.map(normalize).filter(Boolean));
  for (const message of chat) if (message?.is_user) excluded.add(normalize(message.name));
  // A host's group-chat label is not evidence of an in-world phone.
  const hasPhone = /手机|短信|微信|移动终端|smartphone|cell\s*phone|text\s*message/i.test(sourceText);
  const interludeEnabled = settings.interludeEnabled !== false;
  // Draw once from applicable leaf forms: phone subtypes are not progressively
  // diluted by nested lotteries, and the model cannot always pick its easiest form.
  // No fixed rotation, persisted bag, prior candidate text, or extra request.
  const pool = [{ interludeType: 'forum' }];
  if (hasPhone) pool.push(
    { interludeType: 'phone', phoneViewType: 'chat', phoneConversationKind: 'direct' },
    { interludeType: 'phone', phoneViewType: 'chat', phoneConversationKind: 'group' },
    { interludeType: 'phone', phoneViewType: 'moments' },
    { interludeType: 'phone', phoneViewType: 'microblog' },
  );
  // Settings alone do not establish anyone's actual appearance in the mainline.
  if (String(narrativeText || '').trim()) pool.push(
    { interludeType: 'fourth_wall', fourthWallForm: 'diary' },
    { interludeType: 'fourth_wall', fourthWallForm: 'scene' },
  );
  const selected = !interludeEnabled ? {} : pool[pool.length === 1 ? 0 : Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))];
  const { interludeType = null, phoneViewType = null, phoneConversationKind = null, fourthWallForm = null } = selected;
  return Object.freeze({
    worldChatterEnabled: Boolean(settings.worldChatterEnabled), geopoliticsEnabled: Boolean(settings.geopoliticsEnabled),
    parallelSceneEnabled: settings.parallelSceneEnabled !== false, interludeEnabled, interludeType, phoneViewType, phoneConversationKind, fourthWallForm,
    newcomerMode: settings.newcomerMode === true,
    recentInterludeHint: interludeEnabled ? recentInterludeHint(previousInterlude) : '',
    personaNames: [...excluded], characterName,
    characterNames: [...new Set((Array.isArray(characterNames) ? characterNames : [characterName])
      .filter(name => typeof name === 'string').map(name => name.trim()).filter(name => name && !excluded.has(normalize(name))))],
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
    if (missing && field === 'story_status') {
      const accepted = [...(Array.isArray(entries) ? entries : [])];
      const present = new Set(accepted.map(item => item?.horizon));
      let remaining = missing;
      for (const candidate of additions) {
        if (!remaining) break;
        if (!candidate || !['near', 'far'].includes(candidate.horizon) || present.has(candidate.horizon)) continue;
        const directions = [...accepted, candidate];
        const invalid = validateCreativePlan({ ...plan, story_status: { ...plan.story_status, directions } }, options)
          .some(issue => issue.field === 'story_status' && issue.indices?.includes(directions.length - 1));
        if (invalid) continue;
        accepted.push(candidate); present.add(candidate.horizon); remaining--;
      }
      setEntries(accepted);
    }
    else if (missing) setEntries([...(Array.isArray(entries) ? entries : []), ...additions.slice(0, missing)]);
    else if (field === 'faction_relations' && !Array.isArray(entries)) setEntries(additions);
  }
  if (Array.isArray(patch.limitations)) plan.limitations = patch.limitations;
  const gaps = validateCreativePlan({ ...plan, limitations: [] }, options);
  if (Array.isArray(plan.limitations)) plan.limitations = plan.limitations.filter(item =>
    item?.missing > 0 && gaps.some(issue => issue.field === item.field && issue.missing === item.missing));
  return plan;
}
