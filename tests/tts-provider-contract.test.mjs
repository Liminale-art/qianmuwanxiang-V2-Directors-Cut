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
} from '../qianmu-tts-providers.js';

const providers = listTtsProviders();
assert.ok(providers.some((provider) => provider.id === DEFAULT_TTS_PROVIDER_ID));
for (const provider of providers) assert.equal(assertTtsProviderContract(provider.id), true);

assert.equal(normalizeTtsProviderId('MINIMAX'), 'minimax');
assert.equal(normalizeTtsProviderId('not-installed'), DEFAULT_TTS_PROVIDER_ID);
assert.equal(getTtsProvider('minimax').label, 'MiniMax');

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

const legacy = {
  enabled: true,
  apiKey: 'legacy-key',
  model: 'speech-2.6-hd',
  voiceLibrary: [{ id: 'v1', name: '旧音色', voiceId: 'voice-1' }],
  pronunciationDict: [{ from: '处理', to: '(chu3)(li3)' }],
};
migrateTtsProviderSettingsState(legacy);
assert.equal(legacy.provider, 'minimax');
assert.equal(legacy.providers.minimax.apiKey, 'legacy-key');
assert.equal(legacy.providers.minimax.model, 'speech-2.6-hd');
assert.equal(legacy.providers.minimax.voiceLibrary[0].voiceId, 'voice-1');
assert.equal(legacy.providers.minimax.pronunciationDict[0].from, '处理');
assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'apiKey'));
assert.ok(!Object.prototype.hasOwnProperty.call(legacy, 'voiceLibrary'));
migrateTtsProviderSettingsState(legacy);
assert.equal(legacy.providers.minimax.apiKey, 'legacy-key', '重复迁移不得重置已保存的 Provider 配置');

console.log(`TTS Provider contract OK (${providers.length} provider)`);
