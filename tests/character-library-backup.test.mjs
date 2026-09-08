import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as codec from '../qianmu-character-library-backup.js';
import * as files from '../qianmu-character-backup-file.js';
import { createCharacterArchiveStore } from '../qianmu-character-archive-store.js';
import { newCharacterArchive, normalizeCharacterArchive, selectCharacterBinding } from '../qianmu-character-archive.js';
import { normalizeComfyLibraryDocument, inspectComfyLibraryDocument } from '../qianmu-comfy-library.js';
import { COMFY_LIBRARY_BACKUP_SCHEMA } from '../qianmu-comfy-library-backup.js';
import { comfyWorkflowReferenceHash } from '../qianmu-comfy-references.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
import { renderCharacterArchive } from '../qianmu-character-archive-view.js';
const namespace = 'st-user:character-backup', clone = structuredClone;
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', png = new Uint8Array(Buffer.from(data, 'base64'));
const receipt = { url: '/user/images/Qianmu-References/ref.png', name: 'Original', mime: 'image/png', bytes: png.length, sha256: await vibeDigest(png) };
function row(id = 'alice', version = 1, category = 'char') {
  const document = normalizeCharacterArchive({ ...newCharacterArchive(category), name: id, aliases: ['Alias'], ageStatus: 'adult', imagegen: { appearance: 'black hair', negative: 'exclude', sensitiveAppearance: 'private annotation', reference: receipt, preview: { ...receipt, name: 'Preview', url: '/user/images/Qianmu-References/preview.png', sourceSha256: receipt.sha256 }, novelReference: { strength: 0, fidelity: 1 } } });
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  return { document, head: { id, revision: `${id}-rev${version}`, version, category, name: id, aliases: document.aliases, cover: document.imagegen.preview.url, bytes, createdAt: 1, updatedAt: version } };
}
const bindings = () => [{ category: 'char', subjectKey: 'char:alice.png', scope: 'default', chatKey: '', archiveId: 'alice', revision: 'bind1', updatedAt: 1 },
  { category: 'char', subjectKey: 'char:alice.png', scope: 'chat', chatKey: 'chat-one', archiveId: '', revision: 'bind2', updatedAt: 2 }];
const packet = (archives = [row()], selected = bindings()) => ({ schema: codec.CHARACTER_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, archives: clone(archives), bindings: clone(selected), usage: { count: archives.length, bytes: archives.reduce((sum, item) => sum + item.head.bytes, 0), bindings: selected.length } });
const empty = () => packet([], []);
const imageReader = async receipts => receipts.map(() => ({ mime: 'image/png', data }));

test('character backup keeps original identities, all binding scopes, explicit unbound state and zero-valued engine fields', () => {
  const value = packet(), before = clone(value), summary = codec.validateCharacterLibraryBackup(value);
  assert.equal(summary.count, 1); assert.equal(summary.bindings, 2); assert.equal(summary.references, 1); assert.deepEqual(value, before);
  assert.equal(value.archives[0].document.imagegen.novelReference.strength, 0); assert.equal(value.archives[0].document.imagegen.sensitiveAppearance, 'private annotation');
  assert.equal(selectCharacterBinding(value.bindings, { category: 'char', subjectKey: 'char:alice.png' }, 'chat-one').archiveId, '');
  assert.equal(selectCharacterBinding(value.bindings, { category: 'char', subjectKey: 'char:alice.png' }, 'chat-two').archiveId, 'alice');
  const records = { archives: value.archives.map(item => ({ ...item, head: { ...item.head, key: JSON.stringify([namespace, item.head.id]), namespace } })), bindings: value.bindings.map(item => ({ ...item, key: JSON.stringify([namespace, item.category, item.subjectKey, item.scope, item.chatKey]), namespace })), usage: { ...value.usage, key: namespace } };
  const packed = codec.packCharacterLibraryRecords(namespace, records); assert.deepEqual(packed.archives, value.archives); assert.deepEqual(new Set(packed.bindings.map(JSON.stringify)), new Set(value.bindings.map(JSON.stringify)));
});
test('unknown or normalized-away fields, missing targets, wrong covers and dishonest usage reject the complete character backup', () => {
  for (const change of [v => v.archives[0].document.apiKey = 'never-copy', v => v.archives[0].document.comfy = { version: 999 }, v => v.archives[0].document.ageStatus = 'unrecognized',
    v => v.archives[0].head.bytes++, v => v.archives[0].head.cover = '', v => v.usage.bytes++, v => v.archives.push(v.archives[0]), v => v.bindings.push(v.bindings[0]), v => v.bindings[0].archiveId = 'missing',
    v => v.bindings[0].category = 'user', v => v.bindings[0].chatKey = 'ignored default', v => v.credentialsIncluded = true, v => v.archives[0].head.updatedAt = 0]) {
    const value = packet(); change(value); assert.throws(() => codec.validateCharacterLibraryBackup(value));
  }
});
test('different character documents require explicit decisions, never an ancestry guess from larger version numbers', () => {
  const local = packet([row('alice', 5)]), incoming = packet(), pending = codec.planCharacterLibraryRestore(local, incoming);
  assert.equal(pending.ready, false); assert.equal(pending.conflicts.length, 1); assert.equal(pending.archiveWrites.length, 0);
  assert.equal(codec.planCharacterLibraryRestore(local, incoming, { decisions: Object.create({ 'archive:alice': 'incoming' }) }).ready, false);
  assert.equal(codec.planCharacterLibraryRestore(local, incoming, { decisions: { 'archive:alice': 'local' } }).value.archives[0].head.version, 5);
  const accepted = codec.planCharacterLibraryRestore(local, incoming, { decisions: { 'archive:alice': 'incoming' } });
  assert.equal(accepted.ready, true); assert.equal(accepted.value.archives[0].head.version, 1); assert.equal(accepted.value.archives[0].head.revision, 'alice-rev1');
  assert.throws(() => codec.planCharacterLibraryRestore(local, incoming, { decisions: { 'archive:unknown': 'incoming' } }), /过期/);
  assert.deepEqual(local, packet([row('alice', 5)]));
});
test('binding conflicts are independent decisions and never silently undo an explicit chat-level unbind', () => {
  const local = packet(), incoming = packet(); incoming.bindings[1].archiveId = 'alice'; incoming.bindings[1].revision = 'bind3';
  const pending = codec.planCharacterLibraryRestore(local, incoming); assert.equal(pending.conflicts[0].kind, 'binding'); assert.equal(pending.ready, false);
  const key = pending.conflicts[0].key;
  const kept = codec.planCharacterLibraryRestore(local, incoming, { decisions: { [key]: 'local' } }); assert.equal(kept.value.bindings.find(row => row.scope === 'chat').archiveId, '');
  const used = codec.planCharacterLibraryRestore(local, incoming, { decisions: { [key]: 'incoming' } }); assert.equal(used.value.bindings.find(row => row.scope === 'chat').archiveId, 'alice');
});
test('merged backup keeps unrelated archives, is idempotent, and rejects cross-account/category/capacity errors', () => {
  const local = packet([row('alice'), row('other', 1, 'other')]), incoming = packet();
  const plan = codec.planCharacterLibraryRestore(local, incoming); assert.equal(plan.ready, true); assert.equal(plan.archiveWrites.length, 0); assert.equal(plan.value.archives.length, 2);
  assert.throws(() => codec.planCharacterLibraryRestore({ ...empty(), namespace: 'st-user:elsewhere' }, incoming), /另一 ST 账户/);
  assert.throws(() => codec.planCharacterLibraryRestore(packet([row('alice', 1, 'user')], []), incoming), /分类不同/);
  const full = packet(Array.from({ length: 512 }, (_, i) => row(`id-${i}`, 1, 'other')), []);
  assert.throws(() => codec.planCharacterLibraryRestore(full, incoming), /数量/);
});
test('restore cannot open storage before consent or transfer binding keys into a different ST account', async () => {
  let opens = 0; const store = createCharacterArchiveStore({ indexedDB: { open() { opens++; throw Error('must not open'); } } });
  await assert.rejects(() => store.restoreBackup(namespace, packet(), { expectedDigest: 'a'.repeat(64) }), /确认/);
  await assert.rejects(() => store.restoreBackup('st-user:other', packet(), { expectedDigest: 'a'.repeat(64), confirmed: true }), /另一 ST 账户/); assert.equal(opens, 0); store.close();
});
test('resource file includes verified original bytes and thumbnail receipt, deduplicates content rather than discarding uses', async () => {
  const library = packet(); let reads = 0;
  const built = await files.buildCharacterBackupFile(library, { readImages: async items => { reads++; return imageReader(items); } });
  assert.equal(reads, 1); assert.equal(built.summary.images, 1); assert.equal(built.summary.imageUses, 2);
  const parsed = await files.readCharacterBackupFile(built.file); assert.deepEqual(parsed.library, library); assert.equal(parsed.images[0].data, data); assert.equal(parsed.workflows, null);
  assert.equal(parsed.library.archives[0].document.imagegen.preview.sourceSha256, receipt.sha256);
});
test('missing, altered, repeated, extra, mismatched-MIME or invalid-image originals cannot masquerade as a successful backup', async () => {
  const built = await files.buildCharacterBackupFile(packet(), { readImages: imageReader }), original = JSON.parse(await built.file.text());
  for (const change of [v => v.images.pop(), v => v.images.push(v.images[0]), v => v.images[0].sha256 = 'b'.repeat(64), v => v.images[0].bytes++, v => v.images[0].mime = 'image/jpeg', v => v.images[0].data = v.images[0].data.slice(4), v => v.images[0].unknown = true, v => v.originalsIncluded = false]) {
    const value = clone(original); change(value); await assert.rejects(() => files.inspectCharacterBackupFile(value));
  }
  await assert.rejects(() => files.buildCharacterBackupFile(packet(), { readImages: async () => [] }), /读取结果/);
  await assert.rejects(() => files.buildCharacterBackupFile(packet(), { readImages: async () => { throw Error('source missing'); } }), /source missing/);
});
test('resource files require every fixed Comfy implementation version and preserve graph identity, not same-name substitutes', async () => {
  const document = normalizeComfyLibraryDocument({ workflow: { image: { class_type: 'LoadImage', inputs: { image: '%qianmu_reference_1%' } } }, parameters: { seed: 0 } }), hash = await comfyWorkflowReferenceHash(document.workflow), inspection = inspectComfyLibraryDocument(document);
  const library = packet(); library.archives[0].document.comfy = { version: 1, implementations: [{ version: 1, name: 'Reference slot', workflow: { id: 'workflow', revision: 'wrev', version: 1, hash }, referenceSlot: 1, loras: [], conditioning: [] }] };
  library.archives[0].head.bytes = new TextEncoder().encode(JSON.stringify(library.archives[0].document)).byteLength; library.usage.bytes = library.archives[0].head.bytes;
  const meta = { id: 'workflow', revision: 'wrev', version: 1, name: 'Different display name', createdAt: 1, updatedAt: 1, archived: false, bytes: inspection.bytes, totalBytes: inspection.bytes, nodes: inspection.nodes, slots: inspection.slots, issue: inspection.issue };
  const workflows = { schema: COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [{ head: meta, versions: [{ meta: { ...meta, parentRevision: '' }, document }] }] };
  const built = await files.buildCharacterBackupFile(library, { workflows, readImages: imageReader }); assert.equal(built.summary.workflowVersions, 1);
  assert.equal((await files.readCharacterBackupFile(built.file)).library.archives[0].document.comfy.implementations[0].workflow.hash, hash);
  await assert.rejects(() => files.buildCharacterBackupFile(library, { workflows: { ...workflows, workflows: [] }, readImages: imageReader }), /原版本/);
  library.archives[0].document.comfy.implementations[0].workflow.hash = 'a'.repeat(64); await assert.rejects(() => files.buildCharacterBackupFile(library, { workflows, readImages: imageReader }), /原文不符/);
});
test('strict file reader refuses duplicate decoded keys, malformed UTF8, unknown resources and oversized input before read', async () => {
  const built = await files.buildCharacterBackupFile(packet(), { readImages: imageReader }), text = await built.file.text();
  class Oversized extends Blob { get size() { return files.CHARACTER_BACKUP_FILE_BYTES + 1; } arrayBuffer() { assert.fail('must not read'); } }
  for (const file of [new Oversized(['x']), new Blob([Uint8Array.of(0xc3, 0x28)]), new Blob([text.replace('"originalsIncluded":true', '"originalsIncluded":false,"\\u006friginalsIncluded":true')]), new Blob([text.replace('"images":[', '"unrecognized":true,"images":[')])]) await assert.rejects(() => files.readCharacterBackupFile(file));
});
test('complete encoded-size preflight prevents downloading a library that cannot fit the backup envelope', async () => {
  const archives = Array.from({ length: 7 }, (_, index) => { const value = row(`large-${index}`); value.document.imagegen.preview = null; value.document.imagegen.reference = { ...receipt, url: `/user/images/large-${index}.png`, bytes: 16 * 1048576, sha256: String(index + 1).repeat(64) }; value.head.cover = ''; value.head.bytes = new TextEncoder().encode(JSON.stringify(value.document)).byteLength; return value; });
  let reads = 0; await assert.rejects(() => files.buildCharacterBackupFile(packet(archives, []), { readImages: async () => { reads++; } }), /128 MiB/); assert.equal(reads, 0);
});
test('resource export checks cancellation and never writes a role, uploads an image or starts a generation', async () => {
  let reads = 0; await assert.rejects(() => files.buildCharacterBackupFile(packet(), { readImages: async items => { reads++; return imageReader(items); }, guard: async () => { throw Error('cancel'); } }), /cancel/); assert.equal(reads, 0);
  const module = await readFile(new URL('../qianmu-character-backup-file.js', import.meta.url), 'utf8'); assert.doesNotMatch(module, /\.save\(|\.generate\(|\.restoreBackup\(/);
});
test('list-only backup control and staged restore boundary are explicit, with both codecs in the release allowlist', async () => {
  const view = { rows: [], bindings: [], subjects: [], chatKey: '', search: '', collapsed: {}, shown: {} };
  assert.match(renderCharacterArchive(view), /data-archive-action="backup-library"/);
  assert.doesNotMatch(renderCharacterArchive({ ...view, draft: { document: row().document, id: 'alice' } }), /data-archive-action="backup-library"/);
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8')); for (const file of ['qianmu-character-library-backup.js', 'qianmu-character-backup-file.js']) assert.ok(release.files.includes(file));
});
test('native numeric-code storage failures reject without losing the abort handler to a second TypeError', async () => {
  let aborted = 0; const request = value => { const result = {}; queueMicrotask(() => { result.result = value; result.onsuccess?.(); }); return result; };
  const tx = { objectStore: () => ({ index: () => ({ getAll: () => { throw new DOMException('synthetic', 'QuotaExceededError'); } }) }), abort() { aborted++; queueMicrotask(() => tx.onabort?.()); } };
  const store = createCharacterArchiveStore({ indexedDB: { open: () => request({ transaction: () => tx, close() {} }) }, keyRange: { only: value => value } });
  await assert.rejects(() => store.list(namespace), { code: 'character_archive_storage' }); assert.equal(aborted, 1); store.close();
});
