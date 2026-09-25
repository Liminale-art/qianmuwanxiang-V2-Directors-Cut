import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../qianmu-gallery-snapshot-migration.js', import.meta.url), 'utf8');
const deliveryDrain = readFileSync(new URL('../qianmu-storyboard-delivery-drain.js', import.meta.url), 'utf8');
const galleryArchive = readFileSync(new URL('../qianmu-gallery-archive-coordinator.js', import.meta.url), 'utf8');
const galleryRecord = readFileSync(new URL('../qianmu-gallery-archive-record.js', import.meta.url), 'utf8');

test('storyboard redraw snapshots use an additive private IndexedDB store', () => {
assert.match(store, /const DB_VERSION = 15/);
  assert.match(store, /STORE_STORYBOARD_SNAPSHOTS = 'storyboard_snapshots'/);
  assert.match(store, /if \(!db\.objectStoreNames\.contains\(STORE_STORYBOARD_SNAPSHOTS\)\) db\.createObjectStore\(STORE_STORYBOARD_SNAPSHOTS\)/);
  assert.match(store, /STORE_STORYBOARD_SNAPSHOTS\]: \{[^}]*recoverable: false/);
  assert.match(store, /name === STORE_STORYBOARD_SNAPSHOTS[\s\S]*CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_STORYBOARD_SNAPSHOTS/);
});

test('snapshot writes are transactional and reads stay bounded', () => {
  const write = store.slice(store.indexOf('export async function putStoryboardSnapshots'), store.indexOf('export async function getStoryboardSnapshots'));
  assert.match(write, /db\.transaction\(STORE_STORYBOARD_SNAPSHOTS, 'readwrite'\)/);
  assert.match(write, /transaction\.oncomplete/);
  assert.match(write, /transaction\.onabort/);
  assert.match(write, /transaction\.abort\(\)/);
  assert.match(store, /export async function getStoryboardSnapshots[\s\S]*?\.slice\(0, 500\)/);
});

test('inline snapshots win during migration and are stripped only after durable storage', () => {
  const reader=source.slice(source.indexOf('function storyboardSnapshotForRecord'),source.indexOf('async function storyboardStoreSnapshotForRecord'));
  assert.match(reader, /record\?\.snapshot/);assert.doesNotMatch(reader,/storyboardSnapshotCache\.get/);assert.match(reader,/readCurrentGalleryLocalRecipe/);
  assert.match(source,/return await migrateGallerySnapshots\(records,/);
  const archive = migration;
  const writeAt=archive.indexOf('await preserveCapturedSnapshotArchives');
  assert.ok(writeAt >= 0 && writeAt < archive.indexOf('delete item.record.snapshot'));
  assert.match(archive, /await server\.preserve\(record\)[\s\S]*?confirmed\.push\(item\)/);
  assert.match(archive, /preserveCapturedSnapshotArchives\(confirmed,/);
  assert.match(archive, /await save\(\)[\s\S]*?await server\.guardIdentity\(\)/);
  assert.match(archive, /item\.record\.snapshot!==item\.source/);
  assert.match(archive, /await save\(\)[\s\S]*?item\.record\.snapshot=item\.source/);
  assert.match(archive, /epoch!==readEpoch\(\)/);
});

test('redraw, edit, attach and export hydrate exact snapshots on demand', () => {
  assert.match(source, /async function storyboardAttachProductionRecord[\s\S]*?await storyboardReadSnapshotForRecord/);
  assert.match(source, /async function storyboardRedrawRecord[\s\S]*?await storyboardReadSnapshotForRecord/);
  assert.match(source, /async function storyboardEditPrompt[\s\S]*?await storyboardReadSnapshotForRecord/);
  assert.match(source, /async function storyboardExportPackage[\s\S]*?await storyboardReadSnapshotForRecord/);
});

test('gallery view binding and export cannot prewarm recipes or retain an unused full-gallery memory cache', () => {
  assert.doesNotMatch(source, /storyboardHydrateGallerySnapshots|storyboardSnapshotCache|storyboardSnapshotReads/);
  const binding = source.slice(source.indexOf('function bindStoryboardTabEvents'), source.indexOf('\nfunction ', source.indexOf('function bindStoryboardTabEvents') + 1));
  assert.ok(binding.includes('storyboardBindGalleryNarrative'));
  assert.doesNotMatch(binding, /storyboardArchiveGallerySnapshots|getStoryboardSnapshots/);
});

test('gallery lifecycle archives, prunes, clears and invalidates snapshots safely', () => {
  assert.match(source, /async function storyboardHandleChatChanged[\s\S]*?storyboardSnapshotEpoch\+\+[\s\S]*?storyboardArchiveGallerySnapshots/);
  // Current and deferred results share the metadata-save path. The idle
  // preservation pass archives the saved inline snapshot with its record;
  // eager per-result migration is no longer required for delivery.
  const metadataSave = source.slice(source.indexOf('async function saveMetadata()'), source.indexOf('\nfunction getChatKey()'));
  const gatewayDelivery = source.slice(source.indexOf('async function storyboardDeliverGatewayResult'), source.indexOf('async function storyboardRunJob'));
  assert.match(metadataSave, /await ctx\(\)\.saveMetadata\(\); storyboardScheduleGalleryPreservation\(\)/);
  assert.match(gatewayDelivery, /gallery\.push\(record\)[\s\S]*?saveStoryboardFloorTakes\(gallery,async\(\)=>\{[\s\S]*?await saveMetadata\(\)/);
  assert.match(deliveryDrain, /receivedRecords\.push\(record\)[\s\S]*?saveStoryboardFloorTakes\(gallery, async \(\) => \{[\s\S]*?await saveMetadata\(\)/);
  assert.match(source, /function storyboardScheduleGalleryPreservation\(\)[\s\S]*?storyboardGalleryPreserver\.schedule\(\)/);
  assert.match(galleryArchive, /await opened\.preserveAll\(\)/);
  assert.match(galleryRecord, /galleryArchiveRecordEnvelope\(source,raw\)[\s\S]*?record:checked/);
  assert.match(galleryRecord, /if\(record\.snapshot!=null\)[\s\S]*?return 'inline'/);
  assert.match(source, /storyboard_snapshots: \['不可恢复 · 阅片精确重绘设置', true\]/);
  assert.match(source, /STORAGE_CHAT_CLEARABLE[^\n]*storyboard_snapshots/);
  assert.match(source, /cleared\.has\('storyboard_snapshots'\)[\s\S]*?delete record\.snapshotRef/);
  assert.match(source, /storyboardDeleteRecordSnapshots\(removedRecords\)/);
});
