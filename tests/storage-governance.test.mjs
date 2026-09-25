import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyStoragePressure, estimateStoredValueBytes, normalizeChatScopedStorageSelections } from '../qianmu-blobstore.js';
import {NOTES_BACKUP_LIMITS,FAVORITES_BACKUP_LIMITS} from '../qianmu-library-backup.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const storeSource = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
const notesSource = await readFile(new URL('../qianmu-notes.js', import.meta.url), 'utf8');

assert.equal(estimateStoredValueBytes('千幕'), 6, 'UTF-8 text must use real byte size');
assert.equal(estimateStoredValueBytes(new Blob(['12345'])), 5, 'Blob inventory must use its real size');
assert.equal(estimateStoredValueBytes(new Uint8Array(9)), 9, 'Typed arrays must use byteLength');
const cyclic = { label: 'ok' };
cyclic.self = cyclic;
assert.doesNotThrow(() => estimateStoredValueBytes(cyclic), 'cyclic settings must not break inventory');
assert.deepEqual(classifyStoragePressure({ usage: 79, quota: 100 }), {
  available: true, level: 'normal', usage: 79, quota: 100, ratio: 0.79, freeBytes: 21,
});
assert.equal(classifyStoragePressure({ usage: 80, quota: 100 }).level, 'warning', '80% origin usage must become a non-destructive warning');
assert.equal(classifyStoragePressure({ usage: 90, quota: 100 }).level, 'critical', '90% origin usage must become a critical warning');
assert.equal(classifyStoragePressure({ usage: 20, quota: 0 }).level, 'unknown', 'missing browser quota must not manufacture pressure');
assert.deepEqual(normalizeChatScopedStorageSelections([
  { name: 'tts_lines', chatKey: 'chat-a' },
  { store: 'tts_lines', chatKey: 'chat-a' },
  { name: 'video_drafts', chatKey: 'chat-a' },
  { name: 'video_timelines', chatKey: 'chat-a' },
  { name: 'video_postproduction', chatKey: 'chat-a' },
  { name: 'storyboard_inbox', chatKey: 'chat-a' },
  { name: 'notes', chatKey: 'chat-a' },
  { name: 'audio', chatKey: '' },
]), [{ name: 'tts_lines', chatKey: 'chat-a' }, { name: 'video_drafts', chatKey: 'chat-a' }, { name: 'video_timelines', chatKey: 'chat-a' }, { name: 'video_postproduction', chatKey: 'chat-a' }], 'chat cleanup must deduplicate valid scopes and reject unfiled/protected stores');

assert.match(storeSource, /STORE_AUDIO.*recoverable: true/s);
assert.match(storeSource, /STORE_TTS_LINES.*recoverable: true/s);
assert.match(storeSource, /STORE_RETLOG.*recoverable: true/s);
assert.match(storeSource, /STORE_STORYBOARD_PIPELINE_LOGS.*category: 'logs'.*recoverable: true/s);
assert.match(storeSource, /STORE_VIDEO_MEDIA.*category: 'video'.*recoverable: false/s);
assert.match(storeSource, /STORE_VIDEO_DRAFTS.*category: 'video'.*recoverable: false/s);
assert.match(storeSource, /STORE_VIDEO_TIMELINES.*category: 'video'.*recoverable: false/s);
assert.match(storeSource, /STORE_VIDEO_POSTPRODUCTION.*category: 'video'.*recoverable: false/s);
assert.match(storeSource, /STORE_FAVORITES.*recoverable: false/s);
assert.match(storeSource, /STORE_BOOKS.*recoverable: false/s);
assert.match(storeSource, /export async function clearRecoverableStorage\(\)/);
assert.match(storeSource, /Object\.entries\(STORAGE_STORE_INFO\)[\s\S]*filter\(\(\[, info\]\) => info\.recoverable\)/);
assert.match(storeSource, /export async function clearRecoverableCategories\(categories = \[\]\)/, 'must expose category-scoped cleanup');
assert.match(storeSource, /allowedCategories = new Set\(\['audio', 'logs', 'cache'\]\)/, 'category cleanup must use an explicit allow-list');
assert.match(storeSource, /export async function clearStorageItems\(storeNames = \[\], \{check = \(\) => \{\}\} = \{\}\)/, 'explicit per-store cleanup must retain optional scope checks');
assert.match(storeSource, /allowedNames = new Set\(Object\.keys\(STORAGE_STORE_INFO\)\.filter\(name => name !== STORE_STORYBOARD_INBOX\)\)/, 'per-store cleanup must exclude account-owned pending originals');
assert.match(storeSource, /clearStorageItems[\s\S]*const failed = \[\][\s\S]*catch \(error\)[\s\S]*failed\.push/, 'one failed store must not prevent later selected stores from being cleared');
assert.match(storeSource, /export async function auditOrphanedReaderBlobs\(\)/, 'reader blob orphan audit must be available');
assert.match(storeSource, /STORE_COVERS[\s\S]*STORE_IMAGES[\s\S]*books\.has\(bookId\)/, 'only reader cover/image records without a canonical book may be marked orphaned');
assert.match(storeSource, /auditOrphanedStore[\s\S]*openCursor\(\)[\s\S]*estimateStoredValueBytes\(current\.value\)/, 'blob audit must stream values through a cursor instead of retaining the full library in memory');
assert.match(storeSource, /\u4f34\u8bfb\u4f1a\u8bdd\/\u5411\u91cf[\s\S]*\u7edd\u4e0d\u81ea\u52a8\u5224\u5b64/, 'retained reader memories and vectors must not be treated as orphaned blobs');
assert.match(storeSource, /function deleteOrphanedReaderBlob[\s\S]*db\.transaction\(\[STORE_BOOKS, item\.store\][\s\S]*objectStore\(STORE_BOOKS\)\.get\(item\.bookId\)/, 'orphan deletion must re-check the canonical book inside the same transaction');
assert.match(storeSource, /function storageRecordChatKey\(name, key, value\)[\s\S]*STORE_TTS_LINES[\s\S]*STORE_CHATS[\s\S]*STORE_VECTORS[\s\S]*STORE_STORYBOARD_INBOX[\s\S]*STORE_AUDIO/, 'chat-scoped stores must use an explicit scope extractor');
assert.match(storeSource, /estimateStoreUsage\(name\)[\s\S]*scopeMap[\s\S]*recordBytes[\s\S]*chatScopes:/, 'chat scope sizes must be collected during the existing store inventory pass');
assert.match(storeSource, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_AUDIO[\s\S]*STORE_TTS_LINES[\s\S]*STORE_CHATS[\s\S]*STORE_VECTORS/, 'chat cleanup must use an explicit store allow-list');
assert.match(storeSource, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_VIDEO_TASKS[\s\S]*STORE_VIDEO_BUDGET[\s\S]*STORE_VIDEO_MEDIA/, 'video tasks, ledgers and media must remain independently chat-cleanable');
assert.match(storeSource, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_VIDEO_DRAFTS/, 'video drafts must be explicitly chat-cleanable');
assert.match(storeSource, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_VIDEO_TIMELINES/, 'video timelines must be explicitly chat-cleanable');
assert.match(storeSource, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_VIDEO_POSTPRODUCTION/, 'film postproduction decisions must be explicitly chat-cleanable');
assert.doesNotMatch(storeSource.slice(storeSource.indexOf('const CHAT_SCOPED_CLEARABLE_STORES'), storeSource.indexOf('async function clearStoreChatScope')), /STORE_STORYBOARD_INBOX/, 'unfiled storyboard deliveries must not be chat-cleanable');
assert.match(storeSource, /export function normalizeChatScopedStorageSelections\(selections = \[\]\)[\s\S]*allowed\.has\(name\)[\s\S]*export async function clearChatScopedStorage[\s\S]*clearStoreChatScope/, 'chat cleanup must reject stores outside the allow-list');

const plugTab = source.slice(source.indexOf('function renderPlugTab'), source.indexOf('/* ============================================================', source.indexOf('function renderPlugTab')));
const tasksTab = source.slice(source.indexOf('function renderTasksNodesTab'), source.indexOf('function renderCastWorldTab'));
assert.match(plugTab, /renderStorageManagementCard\(\)/, 'storage management must remain the final API/log card');
assert.doesNotMatch(plugTab, /renderRuntimeHealthCard|运行与性能/, 'runtime diagnostics must not compete with data management');
assert.doesNotMatch(plugTab, /sd-export-config|<h3>配置备份/, 'configuration backup must live inside storage management, not a competing card');
assert.doesNotMatch(tasksTab, /renderStorageManagementCard|storageCard/, 'the task page must remain focused on task data');
assert.match(source, /class="sd-storage-legend"[\s\S]*class="sd-storage-ios-bar"/, 'Qianmu categories must be separate from the browser quota bar');
assert.match(styles, /\.sd-storage-ios-bar[\s\S]*\.sd-storage-segment[\s\S]*--sd-storage-color/, 'the browser quota bar retains distinct used and free segments');
assert.match(source, /千幕资料已盘点[\s\S]*浏览器暂存空间[\s\S]*本设备 ST 站点已用 \/ 配额/, 'browser quota is a separate collapsed section, not the Qianmu total');
assert.match(source,/const manageableBytes[\s\S]*manageableBytes,/,'cleanup eligibility still uses the independently calculated manageable total');
assert.match(source, /浏览器额度不含 ST 服务器上的聊天和资料[\s\S]*两者不可相加/, 'origin use must never be mislabeled as Qianmu or VPS storage');
assert.match(source, /不代表 VPS 总容量/, 'browser quota must not be confused with server disk capacity');
assert.match(source, /classifyStoragePressure\(originEstimate \|\| \{\}\)[\s\S]*pressureNotice[\s\S]*千幕不会自动清理/, 'high origin usage must produce a visible warning without automatic cleanup');
assert.match(styles, /\.sd-storage-pressure[\s\S]*\.sd-storage-pressure\.is-critical/, 'warning and critical storage pressure need distinct restrained styles');
assert.doesNotMatch(source.slice(source.indexOf("if (activeTab === 'plug')")),/^\s*void refreshStorageInventory\(false\);/m,'opening API and logs must not auto-start a full inventory');
assert.match(source, /openStorageCleanupDialog[\s\S]*data\?\.idb\?\.stores[\s\S]*item\.name !== 'storyboard_inbox'[\s\S]*不可恢复[\s\S]*input type="checkbox"/, 'cleanup must show registered stores except account-owned pending originals');
assert.match(source, /blobStore\.clearStorageItems\(stores, cleanup\)[\s\S]*selected\.includes\('__diagnostics__'\)[\s\S]*storyboard\.pipelineLogs = \[\]/, 'selected stores and diagnostics must be cleared independently under the initiating session');
assert.match(source, /cleared\.has\('storyboard_pipeline_logs'\)[\s\S]*storyboardPipelineArchiveEpoch\+\+[\s\S]*filter\(\(item\) => !storyboardPipelineIsTerminal\(item\)\)/, 'clearing detailed logs must invalidate archive callbacks while preserving active pipelines');
assert.match(source, /portableTtsBytes[\s\S]*item\.name === 'tts_lines'[\s\S]*cleared\.has\('tts_lines'\)[\s\S]*ttsLineCache\.clear\(\)/, 'the TTS cache item must include and clear its portable chat snapshot');
assert.match(source, /__orphan_reader_blobs__[\s\S]*孤儿封面与书内插图/, 'orphaned reader blobs retain a clearly labelled explicit cleanup choice, not a duplicate accounting row');
assert.match(source, /selected\.includes\('__orphan_reader_blobs__'\)[\s\S]*clearOrphanedReaderBlobs\(cleanup\)/, 'orphan cleanup must only run after explicit selection under its initiating session');
assert.match(source, /scopeCount: Array\.isArray\(item\.scopes\)[\s\S]*item\.scopeCount[\s\S]*个聊天/, 'cleanup rows must reveal how many chat buckets each registered store contains');
assert.match(source, /openStorageChatCleanupDialog[\s\S]*clearChatScopedStorage\(selected, cleanup\)/, 'chat cleanup retains session-scoped per-item deletion');
assert.doesNotMatch(source,/sd-storage-export-(?:reader|audio)/,'cleanup must not run duplicate exports while holding the cleanup lock');
assert.doesNotMatch(source, /sd-storage-backup-home|先返回资料管理备份/, 'cleanup choosers must not duplicate the backup navigation or own backup actions');
const notesExport=source.slice(source.indexOf('async function exportPinnedNotesBackup'),source.indexOf('async function importPinnedNotesBackup'));
assert.match(notesExport, /listQianmuNotes\(/, 'notes backup reads the current account library, not the unowned legacy library');
assert.doesNotMatch(notesExport,/filter\(\(note\) => note\.pinned\)/,'non-prominent automatically saved notes must be included in backups');
for (const [start, end] of [['async function importPinnedNotesBackup','async function exportTtsFavoritesBackup'],['async function importTtsFavoritesBackup','const STORAGE_CHAT_CLEARABLE'],['async function transferAudioCache','// 试听某音色：']]) {
  const action = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  assert.match(action,/invalidateStorageInventory\(\)/,'successful imports invalidate totals until the next explicit scan');
  assert.doesNotMatch(action,/await refreshStorageInventory\(true\)/,'successful imports must not wait for a full inventory scan');
}
assert.match(source, /function importPinnedNotesBackup[\s\S]*importQianmuNotesBackup\(file, \{check, confirm:confirmDialog, read:\(\)=>listQianmuNotes\(\{strict:true\}\), write:note=>saveImportedQianmuNote\(note,\{check\}\), uid, progress\}\)/, 'the guarded entry must confirm, use strict inventory and preserve confirmed progress through later failures');
assert.equal(NOTES_BACKUP_LIMITS.bytes,12*1024*1024);assert.equal(NOTES_BACKUP_LIMITS.entries,1000);
assert.match(notesSource, /function importQianmuNotesBackup[\s\S]*readLibraryBackupFile\(file,'qianmu-notes',\{check\}\)[\s\S]*await read\(\)/, 'notes restore must finish shared strict preflight before accessing the destination; boundary behavior is verified in library-backup tests');
assert.match(notesSource, /occupiedIds\.has\(id\)[\s\S]*uid\('note-import'\)[\s\S]*pinned: Boolean\(raw\.pinned\), floating: false/, 'restoring notes preserves collisions as independent copies and keeps prominence separate from persistence');
assert.match(source, /function exportTtsFavoritesBackup[\s\S]*qianmu-tts-favorites[\s\S]*credentialsIncluded: false/, 'voice favorites need a credential-free binary backup before destructive cleanup');
assert.equal(FAVORITES_BACKUP_LIMITS.bytes,256*1024*1024);assert.equal(FAVORITES_BACKUP_LIMITS.entries,2000);
assert.match(source, /function importTtsFavoritesBackup[\s\S]*readLibraryBackupFile\(file,'qianmu-tts-favorites',\{check\}\)[\s\S]*hasFavorite\(id\)[\s\S]*uid\('fav-import'\)/, 'favorite restore must preflight before destination lookup and preserve ID collisions as copies; limits are behavior-tested');
assert.match(source, /storageSafeFavoriteMeta[\s\S]*const allowed = \['speaker'[\s\S]*credentialsIncluded: false/, 'favorite packages must use an explicit metadata allow-list');
assert.match(source, /bindStoragePackageActions\(backup,[\s\S]*reader:coreadExportData[\s\S]*imports:[\s\S]*reader:coreadImportDataFile/, 'the unified storage backup home retains both initiating control identities through the shared bindings');
assert.match(source, /STORAGE_CHAT_CLEARABLE[\s\S]*reader_chats[\s\S]*reader_vectors/, 'the UI must expose only the same chat-scoped store subset');
assert.doesNotMatch(source, /navigator\.storage\.persist|申请持久保存/, 'persistent-storage prompts must be removed');
const refreshInventory = source.slice(source.indexOf('async function refreshStorageInventory'), source.indexOf('function renderStorageManagementCard'));
assert.match(refreshInventory, /paintStorageManagementCard\(\)/, 'inventory completion must patch only its own card');
assert.doesNotMatch(refreshInventory, /renderModal\(\)/, 'inventory completion must not rebuild the full Qianmu window');
assert.match(source, /function paintStorageManagementCard\(\)[\s\S]*replaceStorageManagementCard\(current, renderStorageManagementCard\(\), \{[\s\S]*bind:bindStorageManagementEvents/, 'a replaced storage card must restore its own controls through the existing view module');

console.log('Storage governance contract OK');
