import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as pools from '../qianmu-comfy-pool-backup.js';
import * as resources from '../qianmu-comfy-resource-backup.js';
import * as workflows from '../qianmu-comfy-library-backup.js';
import { normalizeComfyLibraryDocument, inspectComfyLibraryDocument } from '../qianmu-comfy-library.js';
import { normalizeComfyAutoPool, COMFY_SELECTION_SCHEMA } from '../qianmu-comfy-selection.js';
import { createComfyPoolStore, importComfyPoolDocument, exportComfyPoolDocument } from '../qianmu-comfy-pool-store.js';
import { comfyWorkflowReferenceHash } from '../qianmu-comfy-references.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
import { renderComfyPools } from '../qianmu-comfy-pool-view.js';
const namespace = 'st-user:backup', clone = value => JSON.parse(JSON.stringify(value));
async function fixture(count = 2, poolId = 'pool') {
  const document = normalizeComfyLibraryDocument({ workflow: { p: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } }, save: { class_type: 'SaveImage', inputs: { images: ['p', 0] } } }, outputNodeId: 'save', parameters: { seed: 0 }, classification: { version: 1, visualKinds: ['environment'], maxSubjects: 0, contentClasses: ['sfw'], promptFormat: 'natural_language' } });
  const inspection = inspectComfyLibraryDocument(document), meta = { id: 'workflow', revision: 'wrev', version: 1, name: 'landscape', createdAt: 1, updatedAt: 1, archived: false, bytes: inspection.bytes, totalBytes: inspection.bytes, nodes: inspection.nodes, slots: inspection.slots, issue: inspection.issue, classification: document.classification };
  const binding = { schemaVersion: 1, namespace, id: meta.id, revision: meta.revision, version: meta.version, name: 'old display name', workflowHash: await comfyWorkflowReferenceHash(document.workflow), recipeHash: await vibeDigest(JSON.stringify(document)) };
  const wf = { schema: workflows.COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [{ head: meta, versions: [{ meta: { ...meta, parentRevision: '' }, document }] }] };
  let totalBytes = 0;
  const versions = Array.from({ length: count }, (_, i) => {
    const pool = normalizeComfyAutoPool({ schema: COMFY_SELECTION_SCHEMA, namespace, id: poolId, revision: `prev${i}`, enabled: true, styleLock: true, candidates: [{ id: 'candidate', enabled: i % 2 === 0, priority: i, classification: document.classification,
      target: { providerId: 'comfy', modelId: 'comfy-workflow', connectionPresetId: 'connection', comfyCharacterEnabled: false, comfyWorkflowBinding: binding,
        comfyReferences: { version: 1, enabled: true, namespace, workflowHash: binding.workflowHash, items: [{ url: '/user/images/reference.png', name: 'reference', mime: 'image/png', bytes: 12, sha256: 'a'.repeat(64) }] } } }] });
    const bytes = new TextEncoder().encode(JSON.stringify(pool)).byteLength; totalBytes += bytes;
    return { pool, meta: { id: poolId, revision: pool.revision, version: i + 1, name: `Pool ${i}`, createdAt: 1, updatedAt: i + 1, archived: false, bytes, totalBytes, candidateCount: 1, enabled: pool.enabled, styleLock: pool.styleLock } };
  });
  return clone({ schema: resources.COMFY_RESOURCE_BACKUP_SCHEMA, namespace, credentialsIncluded: false, externalFilesIncluded: false, workflows: wf,
    pools: { schema: pools.COMFY_POOL_BACKUP_SCHEMA, namespace, credentialsIncluded: false, pools: [{ head: versions.at(-1).meta, versions }] } });
}
const emptyPools = () => ({ schema: pools.COMFY_POOL_BACKUP_SCHEMA, namespace, credentialsIncluded: false, pools: [] });
const emptyWorkflows = () => ({ schema: workflows.COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [] });
function fakeStore(initial, key, planner, limit) {
  let value = clone(initial), writes = 0;
  return { get writes() { return writes; }, backup: async () => clone(value), usage: async () => ({ limit }),
    restoreBackup: async (_namespace, incoming, { expectedDigest, confirmed, isCurrent }) => {
      assert.equal(confirmed, true); assert.equal(isCurrent(), true); assert.equal(await workflows.comfyLibraryBackupDigest(value), expectedDigest); writes++;
      const plan = planner(value, incoming), next = new Map(value[key].map(row => [row.head.id, row]));
      for (const row of plan.writes) { const old = next.get(row.head.id); next.set(row.head.id, { head: clone(row.head), versions: [...(old?.versions || []), ...clone(row.versions)] }); }
      value[key] = [...next.values()]; return plan.summary;
    } };
}
const stores = () => ({ workflowStore: fakeStore(emptyWorkflows(), 'workflows', workflows.planComfyLibraryRestore, 64 * 1048576), poolStore: fakeStore(emptyPools(), 'pools', pools.planComfyPoolRestore, 16 * 1048576) });

test('pool backup preserves every revision, zero classification, references, toggles and archive head without rewriting', async () => {
  const packet = (await fixture()).pools; packet.pools[0].head.archived = true; packet.pools[0].head.updatedAt = 10;
  const before = JSON.stringify(packet), summary = pools.validateComfyPoolBackup(packet); assert.equal(summary.versions, 2); assert.equal(summary.count, 1);
  const unpacked = packet.pools.map(row => pools.unpackComfyPoolRecord(namespace, row));
  const packed = pools.packComfyPoolRecords(namespace, unpacked.map(row => ({ head: row.head, versions: row.versions.map(v => ({ meta: v.meta, pool: v.document.pool })) })));
  assert.deepEqual(packed, packet); assert.equal(JSON.stringify(packet), before); assert.equal(packed.pools[0].versions[0].pool.candidates[0].classification.maxSubjects, 0);
  const oldImport = importComfyPoolDocument(JSON.stringify(exportComfyPoolDocument('draft', packed.pools[0].versions[0].pool, namespace)), namespace);
  assert.equal(oldImport.pool.enabled, false); assert.equal(oldImport.pool.candidates[0].enabled, false);
});
test('pool history rejects missing or duplicate versions, silent normalization, foreign state, metadata mismatch and unknown fields', async () => {
  const original = (await fixture()).pools;
  for (const change of [v => v.pools[0].versions.pop(), v => v.pools.push(v.pools[0]), v => v.pools[0].versions[1].meta.revision = 'prev0', v => v.pools[0].versions.reverse(),
    v => v.pools[0].versions[0].pool.apiKey = 'never-copy', v => v.pools[0].versions[0].pool.candidates[0].target.grantId = 'never-copy', v => v.pools[0].versions[0].meta.bytes++,
    v => v.pools[0].head.candidateCount = 0, v => v.pools[0].head.archived = 'false', v => v.credentialsIncluded = true, v => v.pools[0].versions[0].pool.candidates[0].target.comfyReferences.namespace = 'st-user:other']) {
    const value = clone(original); change(value); assert.throws(() => pools.validateComfyPoolBackup(value));
  }
});
test('matching prefixes append original revisions; duplicate or older backups keep local archive state and unrelated plans', async () => {
  const short = (await fixture(1)).pools, long = (await fixture(3)).pools, other = (await fixture(1, 'other')).pools;
  short.pools.push(other.pools[0]); const before = clone(short), plan = pools.planComfyPoolRestore(short, long);
  assert.equal(plan.summary.extended, 1); assert.equal(plan.summary.addedVersions, 2); assert.deepEqual(short, before);
  long.pools[0].head.archived = true; assert.equal(pools.planComfyPoolRestore(long, (await fixture()).pools).writes.length, 0);
  assert.equal(pools.planComfyPoolRestore(long, long).writes.length, 0);
  const fork = (await fixture(1)).pools; fork.pools[0].head.name = fork.pools[0].versions[0].meta.name = 'different';
  assert.throws(() => pools.planComfyPoolRestore(short, fork), /同编号/);
});
test('pool capacity and cross-account binding are checked without opening storage or evicting rows', async () => {
  const packet = (await fixture()).pools; assert.throws(() => pools.planComfyPoolRestore(emptyPools(), packet, { maxBytes: 1 }), /容量/);
  assert.throws(() => pools.planComfyPoolRestore({ ...emptyPools(), namespace: 'st-user:other' }, packet), /同一 ST 账户/);
  assert.throws(() => pools.unpackComfyPoolRecord('st-user:other', packet.pools[0]), /另一 ST 账户/);
  let opens = 0; const store = createComfyPoolStore({ indexedDB: { open() { opens++; throw Error('must not open'); } } });
  await assert.rejects(() => store.restoreBackup(namespace, packet, { expectedDigest: 'a'.repeat(64) }), /确认/);
  await assert.rejects(() => store.restoreBackup('st-user:other', packet, { expectedDigest: 'a'.repeat(64), confirmed: true }), /另一 ST 账户/); assert.equal(opens, 0); store.close();
});
test('combined backup resolves actual original workflow and recipe hashes, not names or newest revisions', async () => {
  const packet = await fixture(), before = JSON.stringify(packet), summary = await resources.validateComfyResourcesBackup(packet);
  assert.equal(summary.dependencies.pinnedVersions, 1); assert.equal(summary.dependencies.candidates, 2); assert.equal(summary.dependencies.connectionPresets, 1); assert.equal(summary.dependencies.referenceFiles, 1);
  assert.equal(JSON.stringify(packet), before);
  const missing = clone(packet); missing.workflows.workflows = []; await assert.rejects(() => resources.validateComfyResourcesBackup(missing), /原版本缺失/);
  const wrong = clone(packet); wrong.pools.pools[0].versions[0].pool.candidates[0].target.comfyWorkflowBinding.recipeHash = '0'.repeat(64);
  await assert.rejects(() => resources.validateComfyResourcesBackup(wrong), /摘要不符/);
});
test('classification and reference namespace mismatches cannot be restored as verified candidates', async () => {
  const wrong = await fixture(); wrong.pools.pools[0].versions[0].pool.candidates[0].classification.maxSubjects = 1;
  await assert.rejects(() => resources.validateComfyResourcesBackup(wrong), /分类/);
  const packet = await fixture(); packet.pools.namespace = 'st-user:other'; await assert.rejects(() => resources.validateComfyResourcesBackup(packet), /账户/);
});
test('repeated historical bindings share digest work and remain cancellable during a large dependency scan', async () => {
  const packet = await fixture(3); let totalBytes = 0;
  for (const version of packet.pools.pools[0].versions) {
    const first = version.pool.candidates[0]; version.pool.candidates = Array.from({ length: 32 }, (_, i) => ({ ...clone(first), id: `member${i}` }));
    const bytes = new TextEncoder().encode(JSON.stringify(version.pool)).byteLength; totalBytes += bytes;
    Object.assign(version.meta, { bytes, totalBytes, candidateCount: 32 });
  }
  packet.pools.pools[0].head = clone(packet.pools.pools[0].versions.at(-1).meta);
  let guards = 0; const summary = await resources.validateComfyResourcesBackup(packet, { guard: async () => { guards++; } });
  assert.equal(summary.dependencies.candidates, 96); assert.equal(summary.dependencies.pinnedVersions, 1); assert.ok(guards < 10);
  guards = 0; await assert.rejects(() => resources.validateComfyResourcesBackup(packet, { guard: async () => { if (++guards === 3) throw Error('cancel dependency scan'); } }), /cancel dependency scan/);
});
test('combined reader rejects duplicate decoded fields, future resource fields, bad UTF8 and oversized files before reading', async () => {
  const packet = await fixture(); assert.deepEqual(await resources.readComfyResourcesBackup(new Blob([JSON.stringify(packet)])), packet);
  class Oversized extends Blob { get size() { return resources.COMFY_RESOURCE_BACKUP_BYTES + 1; } arrayBuffer() { assert.fail('must not read'); } }
  for (const file of [new Oversized(['x']), new Blob([Uint8Array.of(0xc3, 0x28)]), new Blob([JSON.stringify({ ...packet, grants: [] })]), new Blob([JSON.stringify(packet).replace('"externalFilesIncluded":false', '"externalFilesIncluded":true,"\\u0065xternalFilesIncluded":false')])]) await assert.rejects(() => resources.readComfyResourcesBackup(file));
});
test('restore requires an explicit source and destination approval; changed source and target write neither library', async () => {
  const packet = await fixture(), options = stores(), prepared = await resources.previewComfyResourcesRestore(namespace, packet, options);
  await assert.rejects(() => resources.restoreComfyResourcesBackup(namespace, packet, { ...options, prepared }), /确认/);
  const changed = clone(packet); changed.pools.pools[0].head.archived = true;
  await assert.rejects(() => resources.restoreComfyResourcesBackup(namespace, changed, { ...options, prepared, confirmed: true }), /确认后已变化/);
  await assert.rejects(() => resources.previewComfyResourcesRestore('st-user:other', packet, options), /同一 ST 账户/);
  assert.equal(options.workflowStore.writes, 0); assert.equal(options.poolStore.writes, 0);
  await options.poolStore.restoreBackup(namespace, packet.pools, { expectedDigest: prepared.poolDigest, confirmed: true, isCurrent: () => true });
  await assert.rejects(() => resources.restoreComfyResourcesBackup(namespace, packet, { ...options, prepared, confirmed: true }), /确认后已变化/);
  assert.equal(options.workflowStore.writes, 0); assert.equal(options.poolStore.writes, 1);
});
test('two-store interruption retains committed originals and same-file retry restores only missing history without execution', async () => {
  const packet = await fixture(), options = stores(), save = options.poolStore.restoreBackup;
  let prepared = await resources.previewComfyResourcesRestore(namespace, packet, options); options.poolStore.restoreBackup = async () => { throw Error('synthetic quota'); };
  await assert.rejects(() => resources.restoreComfyResourcesBackup(namespace, packet, { ...options, prepared, confirmed: true }), { code: 'comfy_resources_partial' });
  assert.equal((await options.workflowStore.backup()).workflows.length, 1); assert.equal((await options.poolStore.backup()).pools.length, 0);
  options.poolStore.restoreBackup = save; prepared = await resources.previewComfyResourcesRestore(namespace, packet, options); assert.equal(prepared.workflows.kept, 1);
  const result = await resources.restoreComfyResourcesBackup(namespace, packet, { ...options, prepared, confirmed: true }); assert.equal(result.workflows.addedVersions, 0); assert.equal(result.pools.addedVersions, 2);
  assert.deepEqual(await options.poolStore.backup(), packet.pools); assert.deepEqual(await options.workflowStore.backup(), packet.workflows);
});
test('leaving the page during dependency checks never starts a storage write', async () => {
  const packet = await fixture(), options = stores(), prepared = await resources.previewComfyResourcesRestore(namespace, packet, options);
  await assert.rejects(() => resources.restoreComfyResourcesBackup(namespace, packet, { ...options, prepared, confirmed: true, isCurrent: () => false }), /页面已变化/);
  assert.equal(options.poolStore.writes + options.workflowStore.writes, 0);
});
test('pool list exposes separate whole-resource backup controls; draft import and current selection remain separate', async () => {
  const html = renderComfyPools({ rows: [] }); for (const action of ['backup-resources', 'restore-resources', 'import']) assert.match(html, new RegExp(`data-pool-action="${action}"`));
  assert.match(html, /data-pool-backup-file/);
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  for (const file of ['qianmu-comfy-pool-backup.js', 'qianmu-comfy-resource-backup.js']) assert.ok(release.files.includes(file));
});
