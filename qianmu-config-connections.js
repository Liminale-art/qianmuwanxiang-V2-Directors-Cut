// Configuration-package policy only. Never scan/rewrite user prose, prompt text or media.
export const API_CONFIG_KEYS = Object.freeze(['apiUrl', 'apiKey', 'model', 'availableModels', 'apiProfiles', 'providerMode']);
const own = (value, key) => value && Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(key);
const ttsKeys = ['apiKey', 'appId', 'accessKey', 'groupId', 'authMode', 'endpoint', 'proxyBase', 'model'];
const paths = [
  ...API_CONFIG_KEYS.map(key => [key]),
  ['tts', 'provider'], ['tts', 'extractApiProfileId'], ['theater', 'apiProfileId'],
  ['coread', 'assistant', 'apiProfileId'], ['coread', 'comic', 'visionApiProfileId'],
  ['coread', 'memory', 'dialogProvider'], ['coread', 'memory', 'dialogApiProfileId'],
  ...['vector', 'rerank', 'summary'].flatMap(kind => ['ApiUrl', 'ApiKey', 'Model', 'Models', 'Profiles', 'ProfileSel'].map(suffix => ['coread', 'memory', kind + suffix])),
  ['imagegen', 'connections'], ['imagegen', 'promptCompiler', 'apiProfileId'], ['imagegen', 'promptCompiler', 'connectionPresetId'],
];

function connectionPaths(...sources) {
  const result = [...paths, ...ttsKeys.map(key => ['tts', key])]; // pre-provider legacy settings
  for (const [container, fields] of [[['tts', 'providers'], ttsKeys], [['imagegen', 'profiles'], ['comfyUrl']]]) {
    const ids = new Set(sources.flatMap(source => Object.keys(container.reduce((value, key) => value?.[key], source) || {})));
    for (const id of ids) if (safeKey(id)) for (const field of fields) result.push([...container, id, field]);
  }
  return result;
}

function parent(source, path, create = false) {
  let cursor = source;
  for (const key of path.slice(0, -1)) {
    if (!record(cursor)) return null;
    if (!own(cursor, key) || !record(cursor[key])) {
      if (!create) return null;
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  return record(cursor) ? cursor : null;
}

// Call only with the detached export/import copy, never live settings.
export function omitConfigConnections(snapshot) {
  for (const path of connectionPaths(snapshot)) {
    const target = parent(snapshot, path);
    if (target) delete target[path.at(-1)];
  }
  return snapshot;
}

export function restoreConfigConnections(snapshot, current) {
  for (const path of connectionPaths(snapshot, current)) {
    const key = path.at(-1), source = parent(current, path);
    if (own(source, key)) parent(snapshot, path, true)[key] = structuredClone(source[key]);
    else { const target = parent(snapshot, path); if (target) delete target[key]; }
  }
  return snapshot;
}

export function readConfigEnvelope(data) {
  if (!record(data) || data.type !== 'qianmu-config' || ![1, 2].includes(data.version) || !record(data.settings)
    || ((data.version === 2 || own(data, 'includeApi')) && typeof data.includeApi !== 'boolean')) throw Error('格式不符');
  // Reject unsafe object keys before the existing merge-defaults path; never partially import.
  const pending = [data.settings];
  while (pending.length) {
    const value = pending.pop();
    for (const key of Object.keys(value)) {
      if (!safeKey(key)) throw Error('配置包含不支持的字段');
      if (value[key] && typeof value[key] === 'object') pending.push(value[key]);
    }
  }
  return { settings: data.settings, preserveConnections: data.includeApi === false || (data.includeApi === undefined && !API_CONFIG_KEYS.some(key => own(data.settings, key))) };
}
