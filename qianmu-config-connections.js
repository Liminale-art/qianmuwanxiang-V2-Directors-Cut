// Configuration-package policy only. Never scan/rewrite user prose, prompt text or media.
import {migrateQianmuSettingsV2} from './qianmu-data-migrations.js';
import {parseBoundedJson} from './qianmu-json-input.js';
export const CONFIG_INPUT_LIMITS = Object.freeze({bytes:32*1048576,depth:40,nodes:500000});
export async function readConfigFile(file) {
  const fail=message=>{throw Object.assign(new Error(message),{code:'qianmu_config_input'});};
  if (!file || typeof file.text !== 'function') fail('请选择千幕配置文件。');
  if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > CONFIG_INPUT_LIMITS.bytes)) fail('配置文件须为32 MiB以内；请保留原包，大型素材使用各模块备份。');
  const text = await file.text();
  try { return parseBoundedJson(text,{maxBytes:CONFIG_INPUT_LIMITS.bytes,maxDepth:CONFIG_INPUT_LIMITS.depth,maxNodes:CONFIG_INPUT_LIMITS.nodes,label:'配置'}); }
  catch (_) { fail('配置文件无效、含重复字段或超过32 MiB/结构上限；未应用任何内容，请保留原包。'); }
}
export const API_CONFIG_KEYS = Object.freeze(['apiUrl', 'apiKey', 'model', 'availableModels', 'apiProfiles', 'providerMode']);
const own = (value, key) => value && Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(key);
const ttsKeys = ['apiKey', 'appId', 'accessKey', 'groupId', 'authMode', 'endpoint', 'proxyBase', 'model'];
const paths = [
  ...API_CONFIG_KEYS.map(key => [key]),
  ...['directorSettings','director'].flatMap(alias => API_CONFIG_KEYS.map(key => [alias,key])),
  ['apiPresets'], ...['theaterSettings','theaters'].map(alias => [alias,'apiProfileId']),
  ['tts', 'provider'], ['tts', 'extractApiProfileId'], ['theater', 'apiProfileId'],
  ['coread', 'assistant', 'apiProfileId'], ['coread', 'comic', 'visionApiProfileId'],
  ['coread', 'memory', 'dialogProvider'], ['coread', 'memory', 'dialogApiProfileId'],
  ...['vector', 'rerank', 'summary'].flatMap(kind => ['ApiUrl', 'ApiKey', 'Model', 'Models', 'Profiles', 'ProfileSel'].map(suffix => ['coread', 'memory', kind + suffix])),
  ['imagegen', 'connections'], ['imagegen', 'promptCompiler', 'apiProfileId'], ['imagegen', 'promptCompiler', 'connectionPresetId'],
];

function connectionPaths(...sources) {
  const ttsRoots = ['tts','ttsSettings','speechSettings'];
  const result = [...paths, ...ttsRoots.flatMap(root => [...ttsKeys,'provider','extractApiProfileId'].map(key => [root,key]))];
  for (const [container, fields] of [...ttsRoots.map(root => [[root,'providers'],ttsKeys]), [['imagegen', 'profiles'], ['comfyUrl']]]) {
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
  const pending = [[data.settings,0]]; let nodes=0;
  while (pending.length) {
    const [value,depth] = pending.pop();
    if (depth >= CONFIG_INPUT_LIMITS.depth) throw Error('配置结构不受支持');
    for (const key of Object.keys(value)) {
      if (++nodes > CONFIG_INPUT_LIMITS.nodes) throw Error('配置条目过多');
      if (!safeKey(key)) throw Error('配置包含不支持的字段');
      if (value[key] && typeof value[key] === 'object') pending.push([value[key],depth+1]);
    }
  }
  return { settings: data.settings, preserveConnections: data.includeApi === false || (data.includeApi === undefined && !API_CONFIG_KEYS.some(key => own(data.settings, key))) };
}

// Short-lived import guard only. Never persist/log this snapshot: it may contain keys.
// Reference equality alone misses progress/preferences updated while the dialog is open.
export function configRestoreGuard(owner) {
  let baseline;
  try { baseline = JSON.stringify(owner); } catch (_) { return () => false; }
  return current => {
    if (current !== owner || typeof baseline !== 'string') return false;
    try { return JSON.stringify(current) === baseline; } catch (_) { return false; }
  };
}

export function configRestoreGate(owner, activity, notify) {
  const unchanged = configRestoreGuard(owner);
  const reasons = {reader:'请先退出阅读并完成伴读任务，再恢复配置。',focus:'请先结束本轮专注及语音准备，再恢复配置。',director:'请等待推演或幕外任务完成后恢复配置。',image:'请等待分镜生成与队列完成后恢复配置。',transfer:'请先完成分镜备份或恢复，再恢复配置。'};
  return current => {
    const state = activity();
    reasons.voice = '请等待本轮台词提取或配音完成，停止连播后再恢复配置。';
    const key = Object.keys(reasons).find(key => state[key]);
    const reason = key ? reasons[key] : unchanged(current) ? '' : '设置已变化，请重新导入。';
    if (reason) notify(reason, 'warning');
    return !reason;
  };
}

// Only fixed copy and array length enter the confirmation, never imported names/HTML/keys.
export function configRestoreSummary(incoming, preserveConnections) {
  const books = incoming?.coread?.books;
  return [
    '将以文件中的配置替换当前设置，不会自动合并。缺失的设置会补为默认值。',
    '范围包含书目索引与读位、专注设置与台词、音色选择、分镜配置，以及外观、排版与小组件位置。',
    Array.isArray(books) ? `文件中有 ${books.length} 项书目索引；这不表示书籍正文已备份或可读取。` : '文件未提供书目索引；恢复后当前书架索引可能被重置。',
    '书籍正文、图片、录音等独立原件不会随此配置包恢复或清空。原件请使用对应模块的备份。',
    '专注任务、周期及完成记录保留；导入后计时待启动，不恢复旧锁屏、待播语音或临时重听/清理队列。',
    preserveConnections ? '当前连接与密钥保留。' : '连接与密钥也将以文件中的配置替换。',
    '请先保留当前配置的备份。确认恢复？',
  ].join('\n\n');
}

// Prepare a detached configuration before host/cache writes. Missing nested fields use
// defaults; existing values are retained. Local archive references are not portable.
export function resetRestoredFocusSession(settings) {
  const f=settings?.focusClock;
  if(!record(f))return settings;
  // Match the existing reset/phase duration contract without invoking timer, voice,
  // lock, history cleanup or persistence callbacks on the current device.
  const phases={focus:['focusMinutes',25,240],shortBreak:['shortBreakMinutes',5,60],longBreak:['longBreakMinutes',15,120]};
  const phase=Object.hasOwn(phases,f.phase)?f.phase:'focus', [field,fallback,max]=phases[phase];
  const duration=Math.max(1,Math.min(max,Math.round(Number(f[field])||fallback)))*60000;
  Object.assign(f,{phase,status:'idle',lock:null,readingExitPaused:false,remainingMs:duration,sessionPlannedMs:duration,
    endsAt:0,runStartedAt:0,sessionStartedAt:0,sessionElapsedMs:0,sessionBookId:'',sessionProgressStart:0,sessionToken:'',sessionVoiceCues:[],
    voiceRoundId:'',voiceReplayCues:[],voiceCleanupCues:[]});
  return settings;
}

export function prepareConfigRestore(incoming, current, defaults, preserveConnections, {clone, mergeDefaults, normalizeStoryboardState, migrateSettings = () => {}}) {
  const migration = migrateQianmuSettingsV2(clone(incoming));
  if (migration.failed) throw Error('配置迁移失败');
  const merged = migration.value;
  mergeDefaults(merged, defaults);
  if (record(merged.imagegen)) {
    merged.imagegen = normalizeStoryboardState(merged.imagegen);
    for (const plan of merged.imagegen.shotPlans || []) {
      delete plan.archiveRef;
      delete plan.archiveVersion;
      delete plan.archivedAt;
    }
  }
  migrateSettings(merged);
  resetRestoredFocusSession(merged);
  // Resolve legacy aliases before restoring recipient connections; never refill foreign keys later.
  if (preserveConnections) restoreConfigConnections(merged, current);
  return merged;
}
