import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMFY_SELECTION_SCHEMA } from '../qianmu-comfy-selection.js';
import { createComfyPoolStore, exportComfyPoolDocument, importComfyPoolDocument, COMFY_POOL_DOCUMENT_SCHEMA, COMFY_POOL_LIMITS } from '../qianmu-comfy-pool-store.js';
import { createComfyWorkflowStore } from '../qianmu-comfy-library.js';

const namespace = 'st-user:pool-tester';
export function poolFixture() {
  return { schema: COMFY_SELECTION_SCHEMA, namespace, id: 'pool-a', revision: 'revision-a', enabled: true, styleLock: true,
    candidates: [{ id: 'member-a', enabled: true, priority: 3,
      classification: { version: 1, visualKinds: ['environment'], contentClasses: ['sfw'], promptFormat: 'natural_language', maxSubjects: 0 },
      target: { providerId: 'comfy', modelId: 'comfy-workflow', connectionPresetId: 'connection-a', comfyCharacterEnabled: false,
        comfyWorkflowBinding: { schemaVersion: 1, namespace, id: 'workflow-a', revision: 'workflow-r1', version: 1, name: 'environment', workflowHash: 'a'.repeat(64), recipeHash: 'b'.repeat(64) } },
    }] };
}
test('export contains only bounded candidate references and never imported graphs, credentials or eligibility', () => {
  const pool = poolFixture(); Object.assign(pool, { apiKey: 'do-not-store', executionAuthorized: true, lock: { secret: 'not-a-lock' } });
  Object.assign(pool.candidates[0].target, { workflow: 'graph', apiKey: 'do-not-store' }); pool.candidates[0].automaticEligible = true;
  const result = exportComfyPoolDocument('  selection  ', pool, namespace);
  assert.equal(result.name, 'selection'); assert.equal(result.schema, COMFY_POOL_DOCUMENT_SCHEMA);
  assert.equal(result.pool.candidates[0].target.comfyWorkflowBinding.revision, 'workflow-r1');
  assert.doesNotMatch(JSON.stringify(result), /do-not-store|executionAuthorized|automaticEligible|not-a-lock|"workflow":/);
  assert.notEqual(result.pool, pool); assert.notEqual(result.pool.candidates[0].classification, pool.candidates[0].classification);
});
test('imported automation and every imported member are disabled, while references/priority/style preference remain', () => {
  const source = exportComfyPoolDocument('selection', poolFixture(), namespace), before = structuredClone(source);
  const result = importComfyPoolDocument(JSON.stringify(source), namespace);
  assert.equal(result.pool.enabled, false); assert.ok(result.pool.candidates.every(row => row.enabled === false));
  assert.equal(result.requiresReview, true); assert.equal(result.disabledImportedChoices, true);
  assert.equal(result.pool.styleLock, true); assert.equal(result.pool.candidates[0].priority, 3);
  assert.deepEqual(result.pool.candidates[0].target, source.pool.candidates[0].target); assert.deepEqual(source, before);
});
test('disabled imported choices stay disabled and empty candidate schemes do not enroll the workflow library', () => {
  const pool = poolFixture(); pool.enabled = false; pool.candidates = [];
  const result = importComfyPoolDocument(JSON.stringify(exportComfyPoolDocument('empty', pool, namespace)), namespace);
  assert.equal(result.disabledImportedChoices, false); assert.deepEqual(result.pool.candidates, []); assert.equal(result.requiresReview, true);
});
test('cross-account import/export and unknown schema fail without remapping same-name references', () => {
  const value = exportComfyPoolDocument('test', poolFixture(), namespace);
  assert.throws(() => exportComfyPoolDocument('test', value.pool, 'st-user:other'), { code: 'comfy_pool_account' });
  assert.throws(() => importComfyPoolDocument(JSON.stringify(value), 'st-user:other'), { code: 'comfy_pool_account' });
  assert.throws(() => importComfyPoolDocument(JSON.stringify({ ...value, schema: 'future' }), namespace), { code: 'comfy_pool_version' });
  value.pool.candidates[0].target.comfyWorkflowBinding.namespace = 'st-user:other';
  assert.throws(() => importComfyPoolDocument(JSON.stringify(value), namespace), { code: 'comfy_pool_invalid' });
});
test('bounded files, names, identifiers and malformed classification cannot be silently truncated', () => {
  for (const value of [null, '', ' ', 'long'.repeat(30), 'with\nnewline']) assert.throws(() => exportComfyPoolDocument(value, poolFixture(), namespace), { code: 'comfy_pool_name' });
  for (const value of [null, '{', 'a'.repeat(1024 * 1024 + 1)]) assert.throws(() => importComfyPoolDocument(value, namespace), { code: 'comfy_pool_import' });
  for (const change of [pool => pool.id = 'bad/id', pool => pool.revision = '', pool => pool.candidates[0].classification.version = 2, pool => pool.candidates[0].classification.maxSubjects = 13,
    pool => pool.candidates = Array.from({ length: 33 }, (_, i) => ({ ...pool.candidates[0], id: `member-${i}` }))]) {
    const pool = poolFixture(); change(pool); assert.throws(() => exportComfyPoolDocument('bad', pool, namespace), { code: 'comfy_pool_invalid' });
  }
});
test('store is lazy, does not upgrade old databases, and rejects invalid capacity', () => {
  let opens = 0; const store = createComfyPoolStore({ indexedDB: { open() { opens++; } } }); store.close(); assert.equal(opens, 0);
  assert.equal(COMFY_POOL_LIMITS.plans, 32); assert.equal(COMFY_POOL_LIMITS.versions, 64);
  for (const maxBytes of [0, -1, NaN, Infinity, COMFY_POOL_LIMITS.totalBytes + 1]) assert.throws(() => createComfyPoolStore({ maxBytes }), { code: 'comfy_pool_capacity' });
});
test('individually valid reference receipts cannot inflate a candidate document beyond its bounded size', async () => {
  const pool = poolFixture(), first = pool.candidates[0];
  first.target.comfyReferences = { version: 1, enabled: true, namespace, workflowHash: 'a'.repeat(64), items: Array.from({ length: 16 }, () => ({
    url: `/user/images/${'x'.repeat(1800)}.png`, name: 'reference', bytes: 1, mime: 'image/png', sha256: 'c'.repeat(64),
  })) };
  pool.candidates = Array.from({ length: 32 }, (_, i) => ({ ...first, id: `member-${i}` }));
  assert.throws(() => exportComfyPoolDocument('large', pool, namespace), { code: 'comfy_pool_capacity' });
  let opens = 0; const store = createComfyPoolStore({ indexedDB: { open() { opens++; } } });
  await assert.rejects(() => store.save(namespace, { name: 'large', pool }), { code: 'comfy_pool_capacity' });
  assert.equal(opens, 0); store.close();
});
test('invalid identity, stale draft and wrong account are rejected before a transaction opens', async () => {
  let opens = 0; const store = createComfyPoolStore({ indexedDB: { open() { opens++; } } });
  for (const ns of ['', 'st-user:', 'st-user:bad\n', 'st-user: bad', 'account']) await assert.rejects(() => store.list(ns), { code: 'comfy_pool_account' });
  await assert.rejects(() => store.versions(namespace, 'bad/key'), { code: 'comfy_pool_identity' });
  await assert.rejects(() => store.load(namespace, 'pool-a', ''), { code: 'comfy_pool_identity' });
  await assert.rejects(() => store.save(namespace, { name: 'bad', pool: poolFixture(), id: 'different', expectedRevision: 'revision-a' }), { code: 'comfy_pool_conflict' });
  await assert.rejects(() => store.save(namespace, { name: 'bad', pool: poolFixture(), id: 'pool-a', expectedRevision: 'different' }), { code: 'comfy_pool_conflict' });
  await assert.rejects(() => store.save(namespace, { name: 'bad', pool: poolFixture(), expectedRevision: 'revision-a' }), { code: 'comfy_pool_conflict' });
  await assert.rejects(() => store.save('st-user:other', { name: 'bad', pool: poolFixture() }), { code: 'comfy_pool_account' });
  await assert.rejects(() => store.archive(namespace, 'pool-a', 'revision-a', 1), { code: 'comfy_pool_invalid' });
  assert.equal(opens, 0); store.close();
});
test('an unavailable open can be retried, and uses only the new independent database at version one', async () => {
  let opens = 0; const store = createComfyPoolStore({ indexedDB: { open(name, version) { opens++; assert.equal(name, 'qianmu-comfy-pools'); assert.equal(version, 1); throw Error('unavailable'); } } });
  await assert.rejects(() => store.list(namespace), { code: 'comfy_pool_storage' });
  await assert.rejects(() => store.usage(namespace), { code: 'comfy_pool_storage' }); assert.equal(opens, 2); store.close();
});
for (const scenario of ['blocked', 'timeout', 'closed']) test(`pool ${scenario} opening closes a late handle instead of reviving it`, async () => {
  const request = {}; let closes = 0; const store = createComfyPoolStore({ indexedDB: { open: () => request }, timeoutMs: 100 });
  const loading = store.list(namespace);
  if (scenario === 'blocked') request.onblocked();
  if (scenario === 'closed') { store.close(); request.result = { close: () => closes++ }; request.onsuccess(); }
  await assert.rejects(() => loading, { code: `comfy_pool_${scenario}` });
  if (scenario !== 'closed') { request.result = { close: () => closes++ }; request.onsuccess(); }
  assert.equal(closes, 1); store.close();
});
test('new storage is packaged but not loaded at startup or connected to generation in this foundation unit', async () => {
  const module = await readFile(new URL('../qianmu-comfy-pool-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /fetch\(|\.generate\(|qianmu-blobstore|localStorage|extension_settings/);
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8'); assert.doesNotMatch(index, /import[^\n]*qianmu-comfy-pool-store/);
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8')); assert.ok(release.files.includes('qianmu-comfy-pool-store.js'));
});
for (const kind of ['pool', 'workflow']) test(`${kind} native numeric-code storage exceptions reject immediately without a second handler exception`, async () => {
  const request = result => { const item = {}; queueMicrotask(() => { item.result = result; item.onsuccess?.(); }); return item; };
  let aborts = 0;
  const indexedDB = { open() {
    return request({ close() {}, transaction() {
      const tx = { abort() { aborts++; queueMicrotask(() => tx.onabort?.()); }, objectStore() {
        return { get: () => request(undefined), index: () => ({ getAll: () => request([]) }), add: () => { throw new DOMException('closed transaction', 'InvalidStateError'); } };
      } }; return tx;
    } });
  } };
  const store = kind === 'pool' ? createComfyPoolStore({ indexedDB, keyRange: { only: x => x } }) : createComfyWorkflowStore({ indexedDB, keyRange: { only: x => x } });
  const document = { workflow: JSON.stringify({ save: { class_type: 'SaveImage', inputs: { text: '%qianmu_prompt%' } } }) };
  await assert.rejects(() => store.save(namespace, { name: 'native failure', pool: poolFixture(), document }), { code: kind === 'pool' ? 'comfy_pool_storage' : 'comfy_library_storage' });
  assert.equal(aborts, 1); store.close();
});
