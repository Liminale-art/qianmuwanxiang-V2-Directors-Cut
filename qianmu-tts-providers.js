// 千幕 · TTS Provider 注册与统一路由
//
// 本模块只负责供应商差异：配置默认值、能力声明、模型/情绪门控、合成与缓存键。
// 正文台词展示、播放、双击面板、收藏和下载继续由 index.js 的通用交互层负责，
// 因此新增 Provider 不得绕开这里直接操作 DOM 或 IndexedDB。

import {
  synthesize as synthesizeMinimax,
  cacheKeyFor as minimaxCacheKey,
  MINIMAX_ENDPOINTS,
  MINIMAX_MODELS,
  MINIMAX_LANGUAGE_BOOST,
  MINIMAX_SOUND_EFFECTS,
  emotionAllowedForModel,
} from './qianmu-tts.js';

export const DEFAULT_TTS_PROVIDER_ID = 'minimax';

const COMMON_LINE_ACTIONS = Object.freeze({
  play: true,
  regenerate: true,
  download: true,
  favorite: true,
});

const MINIMAX_EMOTION_OPTIONS = Object.freeze([
  { value: 'auto', label: '自动 (auto)' },
  { value: 'happy', label: '高兴 (happy)' },
  { value: 'sad', label: '悲伤 (sad)' },
  { value: 'angry', label: '愤怒 (angry)' },
  { value: 'fearful', label: '害怕 (fearful)' },
  { value: 'disgusted', label: '厌恶 (disgusted)' },
  { value: 'surprised', label: '惊讶 (surprised)' },
  { value: 'calm', label: '中性 (calm)' },
  { value: 'fluent', label: '生动 (fluent)' },
  { value: 'whisper', label: '低语 (whisper)' },
]);

const PROVIDERS = Object.freeze({
  minimax: Object.freeze({
    id: 'minimax',
    label: 'MiniMax',
    description: 'MiniMax Speech 系列',
    testVoiceId: 'male-qn-qingse',
    defaults: Object.freeze({
      apiKey: '',
      endpoint: MINIMAX_ENDPOINTS['国内 api.minimaxi.com'],
      proxyBase: '',
      groupId: '',
      model: 'speech-2.8-hd',
      format: 'mp3',
      voiceLibrary: [],
      pronunciationDict: [],
      languageBoost: 'auto',
      vmPitch: 0,
      vmIntensity: 0,
      vmTimbre: 0,
      soundEffects: '',
      soundFxAuto: false,
      voiceFxById: {},
      npcArchetypes: [],
      npcAssignByChat: {},
    }),
    models: MINIMAX_MODELS,
    endpoints: MINIMAX_ENDPOINTS,
    languageBoostOptions: MINIMAX_LANGUAGE_BOOST,
    soundEffectOptions: MINIMAX_SOUND_EFFECTS,
    capabilities: Object.freeze({
      ...COMMON_LINE_ACTIONS,
      emotion: true,
      speed: true,
      volume: true,
      pitch: true,
      pronunciationDictionary: true,
      languageBoost: true,
      voiceEffects: true,
    }),
    emotionOptions(config = {}) {
      const model = MINIMAX_MODELS.includes(config.model) ? config.model : 'speech-2.8-hd';
      return MINIMAX_EMOTION_OPTIONS.filter((option) => emotionAllowedForModel(option.value, model));
    },
    async synthesize(params) {
      return synthesizeMinimax(params);
    },
    cacheKey(params) {
      // 保留既有 MiniMax 键格式，升级 Provider 架构后仍能命中用户原缓存。
      return minimaxCacheKey(params);
    },
  }),
});

export function listTtsProviders() {
  return Object.values(PROVIDERS);
}

export function normalizeTtsProviderId(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? id : DEFAULT_TTS_PROVIDER_ID;
}

export function getTtsProvider(providerId) {
  return PROVIDERS[normalizeTtsProviderId(providerId)];
}

export function createTtsProviderDefaults(providerId) {
  const defaults = getTtsProvider(providerId).defaults;
  return JSON.parse(JSON.stringify(defaults));
}

function copySetting(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mergeMissing(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = copySetting(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      mergeMissing(target[key], value);
    }
  }
}

export function migrateTtsProviderSettingsState(tts) {
  const state = tts && typeof tts === 'object' && !Array.isArray(tts) ? tts : {};
  state.provider = normalizeTtsProviderId(state.provider);
  if (!state.providers || typeof state.providers !== 'object' || Array.isArray(state.providers)) state.providers = {};
  if (!state.providers[state.provider] || typeof state.providers[state.provider] !== 'object') {
    state.providers[state.provider] = createTtsProviderDefaults(state.provider);
  }

  if (!state._providerSettingsMigrated) {
    const minimax = state.providers.minimax && typeof state.providers.minimax === 'object'
      ? state.providers.minimax
      : createTtsProviderDefaults('minimax');
    const legacyKeys = [
      'apiKey', 'endpoint', 'proxyBase', 'groupId', 'model', 'format',
      'voiceLibrary', 'pronunciationDict', 'languageBoost',
      'vmPitch', 'vmIntensity', 'vmTimbre', 'soundEffects', 'soundFxAuto',
      'voiceFxById', 'npcArchetypes', 'npcAssignByChat',
    ];
    for (const key of legacyKeys) {
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        minimax[key] = copySetting(state[key]);
      }
      delete state[key];
    }
    state.providers.minimax = minimax;
    state._providerSettingsMigrated = true;
  }

  for (const provider of listTtsProviders()) {
    if (!state.providers[provider.id] || typeof state.providers[provider.id] !== 'object') {
      state.providers[provider.id] = createTtsProviderDefaults(provider.id);
    } else {
      mergeMissing(state.providers[provider.id], createTtsProviderDefaults(provider.id));
    }
  }
  return state;
}

export function getTtsEmotionOptions(providerId, config = {}) {
  const provider = getTtsProvider(providerId);
  return typeof provider.emotionOptions === 'function'
    ? provider.emotionOptions(config).map((option) => ({ ...option }))
    : [{ value: 'auto', label: '自动' }];
}

export function ttsProviderSupports(providerId, capability) {
  return getTtsProvider(providerId).capabilities?.[capability] === true;
}

export async function synthesizeTts(providerId, params = {}) {
  const provider = getTtsProvider(providerId);
  return provider.synthesize({ ...params, providerId: provider.id });
}

export function cacheKeyForTts(providerId, params = {}) {
  const provider = getTtsProvider(providerId);
  if (typeof provider.cacheKey !== 'function') throw new Error(`配音模型 ${provider.label} 未实现缓存键`);
  return provider.cacheKey({ ...params, providerId: provider.id });
}

// 开发期守卫：任何可选 Provider 都必须保留正文三项核心动作。
export function assertTtsProviderContract(providerId) {
  const provider = getTtsProvider(providerId);
  for (const action of ['regenerate', 'download', 'favorite']) {
    if (!provider.capabilities?.[action]) throw new Error(`配音模型 ${provider.label} 缺少必需能力：${action}`);
  }
  if (typeof provider.synthesize !== 'function' || typeof provider.cacheKey !== 'function') {
    throw new Error(`配音模型 ${provider.label} 未完成合成/缓存适配`);
  }
  return true;
}
