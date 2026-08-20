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
import {
  DOUBAO_EMOTIONS,
  DOUBAO_ENDPOINT,
  DOUBAO_FORMATS,
  DOUBAO_MODELS,
  doubaoCacheKey,
  doubaoOutputExtension,
  synthesizeDoubao,
} from './qianmu-tts-doubao.js';
import {
  ELEVENLABS_ENDPOINT,
  ELEVENLABS_FORMATS,
  ELEVENLABS_MODELS,
  elevenLabsCacheKey,
  elevenLabsEmotionOptions,
  elevenLabsOutputExtension,
  synthesizeElevenLabs,
} from './qianmu-tts-elevenlabs.js';

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
    speedRange: Object.freeze({ min: 0.5, max: 2, step: 0.05 }),
    defaults: Object.freeze({
      apiKey: '',
      endpoint: MINIMAX_ENDPOINTS['国内 api.minimaxi.com'],
      proxyBase: '',
      groupId: '',
      model: 'speech-2.8-hd',
      format: 'mp3',
      defaultSpeed: 1,
      defaultVol: 1,
      defaultPitch: 0,
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
    modelOptions: MINIMAX_MODELS.map((value) => ({ value, label: value })),
    formatOptions: [
      { value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' },
      { value: 'flac', label: 'FLAC' }, { value: 'opus', label: 'Opus' },
    ],
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
    hasCredentials(config = {}) { return !!String(config.apiKey || '').trim(); },
    async synthesize(params) {
      return synthesizeMinimax(params);
    },
    cacheKey(params) {
      // 保留既有 MiniMax 键格式，升级 Provider 架构后仍能命中用户原缓存。
      return minimaxCacheKey(params);
    },
    outputExtension(config = {}) {
      return ['mp3', 'wav', 'flac', 'opus'].includes(config.format) ? config.format : 'mp3';
    },
  }),
  doubao: Object.freeze({
    id: 'doubao',
    label: '豆包语音',
    description: '火山引擎豆包语音合成 V3',
    testVoiceId: 'zh_female_vv_uranus_bigtts',
    speedRange: Object.freeze({ min: 0.5, max: 2, step: 0.05 }),
    defaults: Object.freeze({
      authMode: '', apiKey: '', appId: '', accessKey: '', endpoint: DOUBAO_ENDPOINT, proxyBase: '',
      model: 'seed-tts-2.0', format: 'mp3', sampleRate: 24000,
      defaultSpeed: 1, defaultVol: 1, defaultPitch: 0,
      voiceLibrary: [], npcArchetypes: [], npcAssignByChat: {},
    }),
    modelOptions: DOUBAO_MODELS,
    formatOptions: DOUBAO_FORMATS,
    capabilities: Object.freeze({
      ...COMMON_LINE_ACTIONS,
      emotion: true, speed: true, volume: true, pitch: true,
      naturalLanguageDelivery: true,
    }),
    emotionOptions() { return DOUBAO_EMOTIONS; },
    hasCredentials(config = {}) {
      const mode = config.authMode === 'apiKey' || config.authMode === 'legacy'
        ? config.authMode
        : (String(config.appId || '').trim() && String(config.accessKey || '').trim() ? 'legacy' : 'apiKey');
      return mode === 'legacy'
        ? !!String(config.appId || '').trim() && !!String(config.accessKey || '').trim()
        : !!String(config.apiKey || '').trim();
    },
    async synthesize(params) { return synthesizeDoubao(params); },
    cacheKey(params) { return doubaoCacheKey(params); },
    outputExtension(config = {}) { return doubaoOutputExtension(config.format); },
  }),
  elevenlabs: Object.freeze({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'ElevenLabs v3 / Multilingual / Flash',
    testVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
    speedRange: Object.freeze({ min: 0.7, max: 1.2, step: 0.05 }),
    defaults: Object.freeze({
      apiKey: '', endpoint: ELEVENLABS_ENDPOINT, proxyBase: '',
      model: 'eleven_multilingual_v2', format: 'mp3_44100_128',
      defaultSpeed: 1,
      stability: 0.5, similarityBoost: 0.75, style: 0, speakerBoost: true,
      languageCode: '', applyTextNormalization: 'auto',
      voiceLibrary: [], npcArchetypes: [], npcAssignByChat: {},
    }),
    modelOptions: ELEVENLABS_MODELS,
    formatOptions: ELEVENLABS_FORMATS,
    capabilities: Object.freeze({
      ...COMMON_LINE_ACTIONS,
      emotion: true, speed: true, voiceStability: true, voiceSimilarity: true,
      style: true, speakerBoost: true, languageCode: true,
    }),
    capabilityFor(capability, config = {}) {
      // Eleven v3 的语速由音频标签/文本结构控制，API speed 参数不可用。
      if (capability === 'speed' && config.model === 'eleven_v3') return false;
      return this.capabilities?.[capability] === true;
    },
    emotionOptions(config = {}) { return elevenLabsEmotionOptions(config); },
    hasCredentials(config = {}) { return !!String(config.apiKey || '').trim(); },
    async synthesize(params) { return synthesizeElevenLabs(params); },
    cacheKey(params) { return elevenLabsCacheKey(params); },
    outputExtension(config = {}) { return elevenLabsOutputExtension(config.format); },
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

  // 单元 1 曾暂时把三项默认参数保留在通用层；单元 2 起按 Provider 分别记忆。
  if (!state._providerParamsMigrated) {
    const minimax = state.providers.minimax || (state.providers.minimax = createTtsProviderDefaults('minimax'));
    for (const key of ['defaultSpeed', 'defaultVol', 'defaultPitch']) {
      if (Object.prototype.hasOwnProperty.call(state, key)) minimax[key] = copySetting(state[key]);
      delete state[key];
    }
    state._providerParamsMigrated = true;
  }

  for (const provider of listTtsProviders()) {
    if (!state.providers[provider.id] || typeof state.providers[provider.id] !== 'object') {
      state.providers[provider.id] = createTtsProviderDefaults(provider.id);
    } else {
      mergeMissing(state.providers[provider.id], createTtsProviderDefaults(provider.id));
    }
  }
  // 1.9.0 默认使用 /sse；统一迁移到当前 HTTP Chunked 实现，仅处理已知旧值，不覆盖用户自定义端点。
  const doubao = state.providers.doubao;
  if (/\/api\/v3\/tts\/unidirectional\/sse\/?$/i.test(String(doubao?.endpoint || ''))) {
    doubao.endpoint = DOUBAO_ENDPOINT;
  }
  // 配音页当前只开放稳定验证过的 Seed TTS 2.0；旧选择统一回落，音色库与其他设置保持不动。
  if (doubao && doubao.model !== 'seed-tts-2.0') doubao.model = 'seed-tts-2.0';
  // 首次升级时保留已可用的旧凭证路径；未配置旧凭证的用户默认进入新版 API Key。
  if (doubao && !['apiKey', 'legacy'].includes(doubao.authMode)) {
    doubao.authMode = String(doubao.appId || '').trim() && String(doubao.accessKey || '').trim() ? 'legacy' : 'apiKey';
  }
  return state;
}

export function getTtsEmotionOptions(providerId, config = {}) {
  const provider = getTtsProvider(providerId);
  return typeof provider.emotionOptions === 'function'
    ? provider.emotionOptions(config).map((option) => ({ ...option }))
    : [{ value: 'auto', label: '自动' }];
}

export function ttsProviderSupports(providerId, capability, config = {}) {
  const provider = getTtsProvider(providerId);
  return typeof provider.capabilityFor === 'function'
    ? provider.capabilityFor(capability, config)
    : provider.capabilities?.[capability] === true;
}

export function ttsProviderHasCredentials(providerId, config = {}) {
  const provider = getTtsProvider(providerId);
  return typeof provider.hasCredentials === 'function'
    ? provider.hasCredentials(config)
    : !!String(config.apiKey || '').trim();
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

export function outputExtensionForTts(providerId, config = {}) {
  const provider = getTtsProvider(providerId);
  return typeof provider.outputExtension === 'function' ? provider.outputExtension(config) : 'mp3';
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
