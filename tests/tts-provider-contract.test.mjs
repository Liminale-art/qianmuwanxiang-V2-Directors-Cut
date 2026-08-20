import assert from 'node:assert/strict';

import { cacheKeyFor as legacyMinimaxCacheKey } from '../qianmu-tts.js';
import {
  DEFAULT_TTS_PROVIDER_ID,
  assertTtsProviderContract,
  cacheKeyForTts,
  createTtsProviderDefaults,
  getTtsEmotionOptions,
  getTtsProvider,
  listTtsProviders,
  migrateTtsProviderSettingsState,
  normalizeTtsProviderId,
  outputExtensionForTts,
  ttsProviderHasCredentials,
  ttsProviderSupports,
} from '../qianmu-tts-providers.js';

const providers = listTtsProviders();
assert.deepEqual(providers.map((provider) => provider.id), ['minimax', 'doubao', 'elevenlabs']);
assert.ok(providers.some((provider) => provider.id === DEFAULT_TTS_PROVIDER_ID));
for (const provider of providers) assert.equal(assertTtsProviderContract(provider.id), true);

assert.equal(normalizeTtsProviderId('MINIMAX'), 'minimax');
assert.equal(normalizeTtsProviderId('not-installed'), DEFAULT_TTS_PROVIDER_ID);
assert.equal(getTtsProvider('minimax').label, 'MiniMax');
assert.equal(getTtsProvider('doubao').label, '豆包语音');
assert.equal(getTtsProvider('elevenlabs').label, 'ElevenLabs');
assert.deepEqual(getTtsProvider('doubao').modelOptions, [{ value: 'seed-tts-2.0', label: 'Seed TTS 2.0' }]);

const a = createTtsProviderDefaults('minimax');
const b = createTtsProviderDefaults('minimax');
a.voiceLibrary.push({ id: 'one' });
assert.deepEqual(b.voiceLibrary, [], 'Provider 默认配置必须深拷贝，不能跨用户/模型串数据');

const params = {
  text: '测试台词',
  voiceId: 'male-qn-qingse',
  model: 'speech-2.8-hd',
  speed: 1,
  pitch: 0,
  vol: 1,
  emotion: 'auto',
  format: 'mp3',
};
assert.equal(
  cacheKeyForTts('minimax', params),
  legacyMinimaxCacheKey(params),
  'MiniMax 升级后必须继续命中旧音频缓存',
);

const emotions28 = getTtsEmotionOptions('minimax', { model: 'speech-2.8-hd' }).map((item) => item.value);
assert.ok(emotions28.includes('fluent'));
assert.ok(!emotions28.includes('whisper'));
const emotions26 = getTtsEmotionOptions('minimax', { model: 'speech-2.6-hd' }).map((item) => item.value);
assert.ok(emotions26.includes('fluent'));
assert.ok(emotions26.includes('whisper'));
assert.ok(getTtsEmotionOptions('doubao', { model: 'seed-tts-2.0' }).some((item) => item.value === 'whisper'));
assert.deepEqual(getTtsEmotionOptions('elevenlabs', { model: 'eleven_multilingual_v2' }).map((item) => item.value), ['auto']);
assert.ok(getTtsEmotionOptions('elevenlabs', { model: 'eleven_v3' }).some((item) => item.value === 'angry'));
assert.equal(ttsProviderSupports('elevenlabs', 'speed', { model: 'eleven_v3' }), false);
assert.equal(ttsProviderSupports('elevenlabs', 'speed', { model: 'eleven_multilingual_v2' }), true);

const commonCacheParams = { text: '同一句', voiceId: 'voice', speed: 1, emotion: 'auto' };
assert.match(cacheKeyForTts('doubao', commonCacheParams), /^tts:doubao:/);
assert.match(cacheKeyForTts('elevenlabs', commonCacheParams), /^tts:elevenlabs:/);
assert.notEqual(cacheKeyForTts('doubao', commonCacheParams), cacheKeyForTts('elevenlabs', commonCacheParams));
assert.equal(outputExtensionForTts('doubao', { format: 'ogg_opus' }), 'ogg');
assert.equal(outputExtensionForTts('elevenlabs', { format: 'pcm_24000' }), 'pcm');
assert.equal(ttsProviderHasCredentials('doubao', { appId: 'app', accessKey: 'key' }), true);
assert.equal(ttsProviderHasCredentials('doubao', { appId: 'app' }), false);
assert.equal(ttsProviderHasCredentials('doubao', { authMode: 'apiKey', apiKey: 'key' }), true, '豆包 API Key 应交由本机服务端插件中转');
assert.equal(ttsProviderHasCredentials('doubao', { apiKey: 'key', proxyBase: 'https://tts-proxy.example' }), true);
assert.equal(ttsProviderHasCredentials('doubao', { authMode: 'legacy', apiKey: 'key' }), false);
assert.equal(ttsProviderHasCredentials('elevenlabs', { apiKey: 'key' }), true);

const legacy = {
  enabled: true,
  apiKey: 'legacy-key',
  model: 'speech-2.6-hd',
  voiceLibrary: [{ id: 'v1', name: '旧音色', voiceId: 'voice-1' }],
  pronunciationDict: [{ from: '处理', to: '(chu3)(li3)' }],
  defaultSpeed: 1.15,
  defaultVol: 1.2,
  defaultPitch: 2,
};
migrateTtsProviderSettingsState(legacy);
assert.equal(legacy.provider, 'minimax');
assert.equal(legacy.providers.minimax.apiKey, 'legacy-key');
assert.equal(legacy.providers.minimax.model, 'speech-2.6-hd');
assert.equal(legacy.providers.minimax.voiceLibrary[0].voiceId, 'voice-1');
assert.equal(legacy.providers.minimax.pronunciationDict[0].from, '处理');
assert.equal(legacy.providers.minimax.defaultSpeed, 1.15);
assert.equal(legacy.providers.minimax.defaultVol, 1.2);
assert.equal(legacy.providers.minimax.defaultPitch, 2);
assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'apiKey'));
assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'voiceLibrary'));
assert.ok(legacy.providers.doubao);
assert.ok(legacy.providers.elevenlabs);
migrateTtsProviderSettingsState(legacy);
assert.equal(legacy.providers.minimax.apiKey, 'legacy-key', '重复迁移不得重置已保存的 Provider 配置');

const corsEndpointMigration = {
  provider: 'doubao',
  providers: { doubao: { endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse' } },
  _providerSettingsMigrated: true,
  _providerParamsMigrated: true,
};
migrateTtsProviderSettingsState(corsEndpointMigration);
assert.equal(corsEndpointMigration.providers.doubao.endpoint, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');

const doubaoModelMigration = {
  provider: 'doubao',
  providers: { doubao: { model: 'seed-icl-2.0' } },
  _providerSettingsMigrated: true,
  _providerParamsMigrated: true,
};
migrateTtsProviderSettingsState(doubaoModelMigration);
assert.equal(doubaoModelMigration.providers.doubao.model, 'seed-tts-2.0');
assert.equal(doubaoModelMigration.providers.doubao.authMode, 'apiKey');

const legacyAuthMigration = {
  provider: 'doubao',
  providers: { doubao: { appId: 'app', accessKey: 'token', authMode: '' } },
  _providerSettingsMigrated: true,
  _providerParamsMigrated: true,
};
migrateTtsProviderSettingsState(legacyAuthMigration);
assert.equal(legacyAuthMigration.providers.doubao.authMode, 'legacy');

console.log(`TTS Provider contract OK (${providers.length} provider)`);
