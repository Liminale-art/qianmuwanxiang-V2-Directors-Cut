// 千幕 V2 兼容门面。
// 只做“缺什么补什么”的加法迁移，不删除旧键、不改写已有新键，确保旧版可回退读取。
export const QIANMU_DATA_SCHEMA_VERSION = 1;
export const QIANMU_DATA_NAMESPACE = 'story_director_liminale';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const cloneData = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

function mergeMissing(target, source, imported, prefix) {
  if (!isRecord(target) || !isRecord(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (!hasOwn(target, key) || target[key] == null) {
      target[key] = cloneData(value);
      imported.push(path);
    } else if (isRecord(target[key]) && isRecord(value)) {
      mergeMissing(target[key], value, imported, path);
    }
  }
}

function assignMissing(target, key, value, imported, label = key) {
  if (value === undefined || value === null || hasOwn(target, key)) return;
  target[key] = cloneData(value);
  imported.push(label);
}

function finishMigration(target, imported) {
  const fromVersion = Math.max(0, Number(target.dataSchemaVersion) || 0);
  let changed = imported.length > 0;
  if (fromVersion < QIANMU_DATA_SCHEMA_VERSION) {
    target.dataSchemaVersion = QIANMU_DATA_SCHEMA_VERSION;
    changed = true;
  }
  if (!isRecord(target.migrationState)) {
    target.migrationState = {};
    changed = true;
  }
  if (target.migrationState.v2Namespace !== QIANMU_DATA_NAMESPACE) {
    target.migrationState.v2Namespace = QIANMU_DATA_NAMESPACE;
    changed = true;
  }
  if (target.migrationState.v2Compatibility !== true) {
    target.migrationState.v2Compatibility = true;
    changed = true;
  }
  return { value: target, changed, imported, fromVersion, toVersion: QIANMU_DATA_SCHEMA_VERSION };
}

export function migrateQianmuSettingsV2(value) {
  const target = isRecord(value) ? value : {};
  const imported = [];

  // 少量早期构建曾把导演设置包在 director/directorSettings 下；只补目标中不存在的键。
  const legacyDirector = isRecord(target.directorSettings)
    ? target.directorSettings
    : (isRecord(target.director) ? target.director : null);
  if (legacyDirector) {
    const directorKeys = [
      'enabled', 'providerMode', 'apiUrl', 'apiKey', 'model', 'availableModels', 'apiProfiles',
      'temperature', 'maxOutputTokens', 'contextBudget', 'streamEnabled', 'floatingButton',
      'floatSize', 'floatPosition', 'theme', 'systemPrompt', 'outputSchemaText', 'templates',
      'contextOptions', 'injectEnabled', 'injectDepth', 'injectSections', 'autoRefresh',
      'autoRefreshEvery', 'liveStageEnabled', 'worldChatterEnabled', 'geopoliticsEnabled',
    ];
    for (const key of directorKeys) assignMissing(target, key, legacyDirector[key], imported, `director.${key}`);
  }

  if (!Array.isArray(target.apiProfiles) && Array.isArray(target.apiPresets)) {
    target.apiProfiles = cloneData(target.apiPresets);
    imported.push('apiPresets→apiProfiles');
  }
  if (!hasOwn(target, 'floatingButton') && typeof target.floatingEnabled === 'boolean') {
    target.floatingButton = target.floatingEnabled;
    imported.push('floatingEnabled→floatingButton');
  }

  const legacyTts = isRecord(target.ttsSettings)
    ? target.ttsSettings
    : (isRecord(target.speechSettings) ? target.speechSettings : null);
  if (legacyTts) {
    if (!isRecord(target.tts)) {
      target.tts = cloneData(legacyTts);
      imported.push('ttsSettings→tts');
    } else {
      mergeMissing(target.tts, legacyTts, imported, 'tts');
    }
  }

  const legacyTheater = isRecord(target.theaterSettings)
    ? target.theaterSettings
    : (isRecord(target.theaters) ? target.theaters : null);
  if (legacyTheater) {
    if (!isRecord(target.theater)) {
      target.theater = cloneData(legacyTheater);
      imported.push('theaterSettings→theater');
    } else {
      mergeMissing(target.theater, legacyTheater, imported, 'theater');
    }
  }
  if (!isRecord(target.theater)) target.theater = {};
  const legacyScripts = Array.isArray(target.theaterScripts)
    ? target.theaterScripts
    : (Array.isArray(target.theaters) ? target.theaters : null);
  assignMissing(target.theater, 'scripts', legacyScripts, imported, 'theaterScripts→theater.scripts');
  assignMissing(target.theater, 'favorites', target.theaterFavorites, imported, 'theaterFavorites→theater.favorites');

  return finishMigration(target, imported);
}

export function migrateQianmuChatStoreV2(value) {
  const target = isRecord(value) ? value : {};
  const imported = [];
  const legacyDirector = isRecord(target.directorStore)
    ? target.directorStore
    : (isRecord(target.director) ? target.director : (isRecord(target.inference) ? target.inference : null));
  if (legacyDirector) {
    for (const key of [
      'blueprint', 'plan', 'history', 'lastPlanIdx', 'planAtLen', 'updatedAt', 'threads',
      'threadSeq', 'factions', 'worldEvents', 'geoSeq', 'ttsLines', 'ttsLineKeyByMes',
      'ttsVoiceMaps', 'storyboardImages',
    ]) assignMissing(target, key, legacyDirector[key], imported, `director.${key}`);
  }
  assignMissing(target, 'blueprint', target.directorBlueprint, imported, 'directorBlueprint→blueprint');
  assignMissing(target, 'plan', target.directorPlan, imported, 'directorPlan→plan');
  assignMissing(target, 'history', target.directorHistory, imported, 'directorHistory→history');

  if (Array.isArray(target.ttsVoiceMap)) {
    if (!isRecord(target.ttsVoiceMaps)) target.ttsVoiceMaps = {};
    assignMissing(target.ttsVoiceMaps, 'minimax', target.ttsVoiceMap, imported, 'ttsVoiceMap→ttsVoiceMaps.minimax');
  }

  return finishMigration(target, imported);
}
