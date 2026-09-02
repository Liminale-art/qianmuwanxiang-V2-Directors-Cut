import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  QIANMU_DATA_NAMESPACE,
  QIANMU_DATA_SCHEMA_VERSION,
  migrateQianmuChatStoreV2,
  migrateQianmuSettingsV2,
} from '../qianmu-data-migrations.js';

assert.equal(QIANMU_DATA_NAMESPACE, 'story_director_liminale', 'V2 must keep the public-version storage namespace');
assert.equal(QIANMU_DATA_SCHEMA_VERSION, 1);

const publicSettings = {
  enabled: true,
  systemPrompt: '我的推演提示词',
  outputSchemaText: '{"custom":true}',
  apiProfiles: [{ id: 'director-api', name: '导演模型', model: 'model-a' }],
  templates: [{ id: 'script-1', name: '我的剧本', content: '保留正文' }],
  tts: {
    enabled: true,
    provider: 'doubao',
    providers: { doubao: { appId: 'app-public', resourceId: 'seed-tts-2.0' } },
    guidanceSchemes: [{ id: 'voice-guide', name: '台词指导', content: '轻声' }],
  },
  theater: {
    scripts: [{ id: 'scene-1', title: '旧小剧场', instruction: '番外内容' }],
    favorites: [{ id: 'fav-1', title: '收藏成片' }],
  },
  theme: 'dark',
  futureUserField: { keep: true },
};
const publicResult = migrateQianmuSettingsV2(publicSettings);
assert.equal(publicResult.value.systemPrompt, '我的推演提示词');
assert.equal(publicResult.value.tts.providers.doubao.appId, 'app-public');
assert.equal(publicResult.value.tts.guidanceSchemes[0].content, '轻声');
assert.equal(publicResult.value.theater.scripts[0].instruction, '番外内容');
assert.equal(publicResult.value.theater.favorites[0].title, '收藏成片');
assert.deepEqual(publicResult.value.futureUserField, { keep: true }, 'unknown user data must survive migration');

const legacySettings = {
  directorSettings: { systemPrompt: '嵌套旧提示词', injectEnabled: false },
  apiPresets: [{ id: 'legacy-api', name: '旧 API' }],
  ttsSettings: { enabled: true, provider: 'minimax', guidanceSchemes: [{ id: 'g1' }] },
  theaterScripts: [{ id: 'legacy-scene', title: '旧剧札' }],
  theaterFavorites: [{ id: 'legacy-fav' }],
};
const legacySettingsBeforeMigration = structuredClone(legacySettings);
const migratedSettings = migrateQianmuSettingsV2(legacySettings);
assert.equal(migratedSettings.failed, false);
assert.deepEqual(legacySettings, legacySettingsBeforeMigration, 'a successful migration must commit from an isolated copy rather than mutate live legacy settings in place');
assert.equal(migratedSettings.value.systemPrompt, '嵌套旧提示词');
assert.equal(migratedSettings.value.injectEnabled, false);
assert.equal(migratedSettings.value.apiProfiles[0].id, 'legacy-api');
assert.equal(migratedSettings.value.tts.provider, 'minimax');
assert.equal(migratedSettings.value.theater.scripts[0].id, 'legacy-scene');
assert.equal(migratedSettings.value.theater.favorites[0].id, 'legacy-fav');
const settingsAfterFirstRun = JSON.stringify(migratedSettings.value);
const migratedSettingsAgain = migrateQianmuSettingsV2(migratedSettings.value);
assert.equal(JSON.stringify(migratedSettingsAgain.value), settingsAfterFirstRun, 'settings migration must be idempotent');
assert.equal(migratedSettingsAgain.changed, false);
assert.equal(migratedSettingsAgain.value, migratedSettings.value, 'already-current data must bypass another full clone');

const cyclicSettings = { directorSettings: { enabled: true } };
cyclicSettings.self = cyclicSettings;
const cyclicResult = migrateQianmuSettingsV2(cyclicSettings);
assert.equal(cyclicResult.failed, false, 'cyclic legacy data must remain migratable without JSON serialization');
assert.equal(cyclicResult.value.self, cyclicResult.value, 'isolated migration copy must retain cycles');

const brokenSettings = {};
Object.defineProperty(brokenSettings, 'directorSettings', {
  enumerable: true,
  get() { throw new Error('simulated legacy read failure'); },
});
const brokenResult = migrateQianmuSettingsV2(brokenSettings);
assert.equal(brokenResult.failed, true);
assert.equal(brokenResult.value, brokenSettings, 'failed migration must return the exact untouched source object');
assert.equal(Object.hasOwn(brokenSettings, 'dataSchemaVersion'), false, 'failed migration must not leave a partial schema marker');
assert.match(brokenResult.error, /simulated legacy read failure/);

const legacyChat = {
  directorPlan: { story_status: { title: '旧推演' } },
  directorHistory: [{ id: 'history-1', plan: { story_status: { title: '历史' } } }],
  directorBlueprint: '我的剧本',
  ttsVoiceMap: [{ role: 'Alice', voiceId: 'voice-a' }],
  customChatField: { keep: true },
};
const migratedChat = migrateQianmuChatStoreV2(legacyChat);
assert.equal(migratedChat.failed, false);
assert.equal(migratedChat.value.plan.story_status.title, '旧推演');
assert.equal(migratedChat.value.history[0].id, 'history-1');
assert.equal(migratedChat.value.blueprint, '我的剧本');
assert.equal(migratedChat.value.ttsVoiceMaps.minimax[0].voiceId, 'voice-a');
assert.ok(Array.isArray(migratedChat.value.ttsVoiceMap), 'legacy voice map must remain available for rollback');
assert.deepEqual(migratedChat.value.customChatField, { keep: true });
const chatAfterFirstRun = JSON.stringify(migratedChat.value);
assert.equal(JSON.stringify(migrateQianmuChatStoreV2(migratedChat.value).value), chatAfterFirstRun, 'chat migration must be idempotent');

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const blobStore = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
assert.match(source, /const MODULE_NAME = 'story_director_liminale'/, 'repository and display-name changes must not rename the storage namespace');
assert.match(source, /migrateQianmuSettingsV2\(extensionSettings\[MODULE_NAME\]\)[\s\S]*mergeDefaults\(extensionSettings\[MODULE_NAME\], DEFAULT_SETTINGS\)/, 'legacy settings must migrate before new defaults are applied');
assert.match(source, /migrateQianmuChatStoreV2\(meta\[MODULE_NAME\]\)/, 'each chat store must pass through the V2 compatibility façade');
assert.match(source, /acceptMigrationResult\('settings'/, 'settings must pass through the migration commit boundary');
assert.match(source, /acceptMigrationResult\('chat'/, 'chat metadata must pass through the migration commit boundary');
assert.match(source, /function acceptMigrationResult[\s\S]*status: 'rolled_back'[\s\S]*已保留原数据并回退/, 'runtime diagnostics must expose rollback while keeping migration errors session-only');
assert.match(await readFile(new URL('../qianmu-data-migrations.js', import.meta.url), 'utf8'), /runAdditiveMigration[\s\S]*const target = cloneData\(source\)[\s\S]*value: source[\s\S]*failed: true/, 'migration must stage on a copy and return the original on failure');
assert.doesNotMatch(source, /delete meta\[MODULE_NAME\]\.ttsVoiceMap/, 'the first V2 cycle must retain the old TTS voice-map read path');
assert.match(blobStore, /DB_NAME = 'qianmu-blobstore'[\s\S]*STORE_AUDIO = 'audio'[\s\S]*STORE_CHATS = 'reader_chats'[\s\S]*STORE_TTS_LINES = 'tts_lines'/, 'V2 must retain the public IndexedDB database and store names');

console.log('V2 data migration contract OK');
