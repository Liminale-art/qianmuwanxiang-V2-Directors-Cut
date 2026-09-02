import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { estimateStoredValueBytes } from '../qianmu-blobstore.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const storeSource = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

assert.equal(estimateStoredValueBytes('千幕'), 6, 'UTF-8 text must use real byte size');
assert.equal(estimateStoredValueBytes(new Blob(['12345'])), 5, 'Blob inventory must use its real size');
assert.equal(estimateStoredValueBytes(new Uint8Array(9)), 9, 'Typed arrays must use byteLength');
const cyclic = { label: 'ok' };
cyclic.self = cyclic;
assert.doesNotThrow(() => estimateStoredValueBytes(cyclic), 'cyclic settings must not break inventory');

assert.match(storeSource, /STORE_AUDIO.*recoverable: true/s);
assert.match(storeSource, /STORE_TTS_LINES.*recoverable: true/s);
assert.match(storeSource, /STORE_RETLOG.*recoverable: true/s);
assert.match(storeSource, /STORE_FAVORITES.*recoverable: false/s);
assert.match(storeSource, /STORE_BOOKS.*recoverable: false/s);
assert.match(storeSource, /export async function clearRecoverableStorage\(\)/);
assert.match(storeSource, /Object\.entries\(STORAGE_STORE_INFO\)[\s\S]*filter\(\(\[, info\]\) => info\.recoverable\)/);
assert.match(storeSource, /export async function clearRecoverableCategories\(categories = \[\]\)/, 'must expose category-scoped cleanup');
assert.match(storeSource, /allowedCategories = new Set\(\['audio', 'logs', 'cache'\]\)/, 'category cleanup must use an explicit allow-list');
assert.match(storeSource, /export async function clearStorageItems\(storeNames = \[\]\)/, 'explicit per-store cleanup must be available');
assert.match(storeSource, /allowedNames = new Set\(Object\.keys\(STORAGE_STORE_INFO\)\)/, 'per-store cleanup must remain constrained to registered Qianmu stores');
assert.match(storeSource, /export async function auditOrphanedReaderBlobs\(\)/, 'reader blob orphan audit must be available');
assert.match(storeSource, /STORE_COVERS[\s\S]*STORE_IMAGES[\s\S]*books\.has\(bookId\)/, 'only reader cover/image records without a canonical book may be marked orphaned');
assert.match(storeSource, /auditOrphanedStore[\s\S]*openCursor\(\)[\s\S]*estimateStoredValueBytes\(current\.value\)/, 'blob audit must stream values through a cursor instead of retaining the full library in memory');
assert.match(storeSource, /\u4f34\u8bfb\u4f1a\u8bdd\/\u5411\u91cf[\s\S]*\u7edd\u4e0d\u81ea\u52a8\u5224\u5b64/, 'retained reader memories and vectors must not be treated as orphaned blobs');
assert.match(storeSource, /export async function clearOrphanedReaderBlobs\(\)[\s\S]*await getBook\(item\.bookId\)/, 'orphan deletion must re-check the canonical book immediately before deletion');
assert.match(storeSource, /function storageRecordChatKey\(name, key, value\)[\s\S]*STORE_TTS_LINES[\s\S]*STORE_CHATS[\s\S]*STORE_VECTORS[\s\S]*STORE_STORYBOARD_INBOX[\s\S]*STORE_AUDIO/, 'chat-scoped stores must use an explicit scope extractor');
assert.match(storeSource, /estimateStoreUsage\(name\)[\s\S]*scopeMap[\s\S]*recordBytes[\s\S]*chatScopes:/, 'chat scope sizes must be collected during the existing store inventory pass');

const plugTab = source.slice(source.indexOf('function renderPlugTab'), source.indexOf('/* ============================================================', source.indexOf('function renderPlugTab')));
const tasksTab = source.slice(source.indexOf('function renderTasksNodesTab'), source.indexOf('function renderCastWorldTab'));
assert.match(plugTab, /配置备份[\s\S]*renderStorageManagementCard\(\)/, 'storage management must be the final API/log card');
assert.doesNotMatch(tasksTab, /renderStorageManagementCard|storageCard/, 'the task page must remain focused on task data');
assert.match(source, /sd-storage-ios-bar[\s\S]*sd-storage-legend/, 'storage must use an iOS-style multicolor bar and legend');
assert.match(styles, /\.sd-storage-ios-bar[\s\S]*\.sd-storage-segment[\s\S]*--sd-storage-color/, 'each category must own a visual segment');
assert.match(source, /浏览器 \/ ST 来源[\s\S]*千幕已盘点[\s\S]*可管理项目/, 'origin, attributable, and manageable totals must remain separate');
assert.match(source, /浏览器分配给当前 ST 站点来源的空间[\s\S]*千幕仅统计可明确归因的本地内容/, 'origin use must never be mislabeled as Qianmu-only storage');
assert.match(source, /不代表 VPS 磁盘总容量/, 'browser quota must not be confused with server disk capacity');
assert.match(source, /if \(activeTab === 'plug'\)[\s\S]*refreshStorageInventory/, 'inventory refresh belongs to API and logs');
assert.match(source, /openStorageCleanupDialog[\s\S]*data\?\.idb\?\.stores[\s\S]*不可恢复[\s\S]*input type="checkbox"/, 'cleanup must list every registered store and require explicit item selection');
assert.match(source, /blobStore\.clearStorageItems\(stores\)[\s\S]*selected\.includes\('__diagnostics__'\)[\s\S]*storyboard\.pipelineLogs = \[\]/, 'selected stores and diagnostics must be cleared independently');
assert.match(source, /portableTtsBytes[\s\S]*item\.name === 'tts_lines'[\s\S]*cleared\.has\('tts_lines'\)[\s\S]*ttsLineCache\.clear\(\)/, 'the TTS cache item must include and clear its portable chat snapshot');
assert.match(source, /orphanReaderBlobs[\s\S]*\u5b64\u513f\u56fe\u7247[\s\S]*__orphan_reader_blobs__/, 'orphaned reader blobs must be visible as a separate cleanup choice');
assert.match(source, /selected\.includes\('__orphan_reader_blobs__'\)[\s\S]*clearOrphanedReaderBlobs\(\)/, 'orphan cleanup must only run after explicit selection');
assert.match(source, /scopeCount: Array\.isArray\(item\.scopes\)[\s\S]*item\.scopeCount[\s\S]*个聊天/, 'cleanup rows must reveal how many chat buckets each registered store contains');
assert.doesNotMatch(source, /navigator\.storage\.persist|申请持久保存/, 'persistent-storage prompts must be removed');
const refreshInventory = source.slice(source.indexOf('async function refreshStorageInventory'), source.indexOf('const STORAGE_CATEGORY_LABELS'));
assert.match(refreshInventory, /paintStorageManagementCard\(\)/, 'inventory completion must patch only its own card');
assert.doesNotMatch(refreshInventory, /renderModal\(\)/, 'inventory completion must not rebuild the full Qianmu window');
assert.match(source, /function paintStorageManagementCard\(\)[\s\S]*current\.replaceWith\(next\)[\s\S]*bindStorageManagementEvents\(next\)/, 'a replaced storage card must restore its own controls');

console.log('Storage governance contract OK');
