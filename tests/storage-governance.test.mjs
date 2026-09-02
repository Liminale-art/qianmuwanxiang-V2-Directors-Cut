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

const plugTab = source.slice(source.indexOf('function renderPlugTab'), source.indexOf('/* ============================================================', source.indexOf('function renderPlugTab')));
const tasksTab = source.slice(source.indexOf('function renderTasksNodesTab'), source.indexOf('function renderCastWorldTab'));
assert.match(plugTab, /配置备份[\s\S]*renderStorageManagementCard\(\)/, 'storage management must be the final API/log card');
assert.doesNotMatch(tasksTab, /renderStorageManagementCard|storageCard/, 'the task page must remain focused on task data');
assert.match(source, /sd-storage-ios-bar[\s\S]*sd-storage-legend/, 'storage must use an iOS-style multicolor bar and legend');
assert.match(styles, /\.sd-storage-ios-bar[\s\S]*\.sd-storage-segment[\s\S]*--sd-storage-color/, 'each category must own a visual segment');
assert.match(source, /浏览器 \/ ST 来源[\s\S]*千幕已盘点[\s\S]*可安全清理/, 'origin, attributable, and recoverable totals must remain separate');
assert.match(source, /ST 总空间包含同一站点及其他扩展/, 'origin use must never be mislabeled as Qianmu-only storage');
assert.match(source, /if \(activeTab === 'plug'\)[\s\S]*refreshStorageInventory/, 'inventory refresh belongs to API and logs');
assert.match(source, /blobStore\.clearRecoverableStorage\(\)[\s\S]*storyboard\.logs = \[\][\s\S]*storyboard\.pipelineLogs = \[\]/, 'safe cleanup may clear diagnostics but never protected media');
const refreshInventory = source.slice(source.indexOf('async function refreshStorageInventory'), source.indexOf('const STORAGE_CATEGORY_LABELS'));
assert.match(refreshInventory, /paintStorageManagementCard\(\)/, 'inventory completion must patch only its own card');
assert.doesNotMatch(refreshInventory, /renderModal\(\)/, 'inventory completion must not rebuild the full Qianmu window');
assert.match(source, /function paintStorageManagementCard\(\)[\s\S]*current\.replaceWith\(next\)[\s\S]*bindStorageManagementEvents\(next\)/, 'a replaced storage card must restore its own controls');

console.log('Storage governance contract OK');
