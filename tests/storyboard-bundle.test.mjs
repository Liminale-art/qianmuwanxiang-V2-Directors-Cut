import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryboardBundle, openStoryboardBundle, STORYBOARD_BUNDLE_LIMITS } from '../qianmu-storyboard-bundle.js';
import { randomUUID, createHash } from 'node:crypto';
import { captureStoryboardResourceBundle, inspectStoryboardResourceBundle } from '../qianmu-storyboard-bundle-resources.js';
import { runStoryboardBundle, closeStoryboardBundleRuntime } from '../qianmu-storyboard-bundle-runtime.js';
import { normalizeComfyLibraryDocument, inspectComfyLibraryDocument } from '../qianmu-comfy-library.js';
import { COMFY_LIBRARY_BACKUP_SCHEMA } from '../qianmu-comfy-library-backup.js';
import { COMFY_POOL_BACKUP_SCHEMA } from '../qianmu-comfy-pool-backup.js';
import { normalizeComfyAutoPool, COMFY_SELECTION_SCHEMA } from '../qianmu-comfy-selection.js';
import { normalizeCharacterArchive, newCharacterArchive } from '../qianmu-character-archive.js';
import { CHARACTER_LIBRARY_BACKUP_SCHEMA } from '../qianmu-character-library-backup.js';
import { comfyWorkflowReferenceHash, readStaticReferenceBlobs, readStaticReferenceImages } from '../qianmu-comfy-references.js';
import { vibeDigest } from '../qianmu-vibe-file.js';

const namespace = 'st-user:bundle', chatKey = 'chat-one', clone = structuredClone;
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const png = Buffer.from(data, 'base64'), sha256 = await vibeDigest(png), blob = new Blob([png], { type: 'image/png' });
const file = value => new Blob([JSON.stringify(value)], { type: 'application/json' });
const receipt = { name: 'original', url: '/user/images/reference.png', mime: 'image/png', bytes: png.length, sha256 };
async function fixture() {
  let totalBytes = 0;
  const versions = [0, 77].map((seed, index) => {
    const document = normalizeComfyLibraryDocument({ workflow: { text: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } }, load: { class_type: 'LoadImage', inputs: { image: '%qianmu_reference_1%' } } }, parameters: { seed }, classification: { version: 1 } });
    const inspected = inspectComfyLibraryDocument(document); totalBytes += inspected.bytes;
    const meta = { id: 'workflow', revision: `wrev${index+1}`, version: index+1, name: `Recipe${index+1}`, createdAt: 1, updatedAt: index+1, archived: false, bytes: inspected.bytes, totalBytes,
      nodes: inspected.nodes, slots: inspected.slots, issue: inspected.issue, classification: document.classification, parentRevision: index ? 'wrev1' : '' };
    return { meta, document };
  });
  const { parentRevision: _, ...head } = versions.at(-1).meta, workflows = { schema: COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [{ head, versions }] };
  const binding = { schemaVersion: 1, namespace, id: 'workflow', revision: 'wrev1', version: 1, name: 'First recipe', workflowHash: await comfyWorkflowReferenceHash(versions[0].document.workflow), recipeHash: await vibeDigest(JSON.stringify(versions[0].document)) };
  const references = { version: 1, enabled: false, namespace, workflowHash: binding.workflowHash, items: [{ ...receipt, url: '/user/images/pool.png' }] };
  const pool = normalizeComfyAutoPool({ schema: COMFY_SELECTION_SCHEMA, namespace, id: 'pool', revision: 'prev1', enabled: true, styleLock: true, candidates: [{ id: 'candidate', enabled: true, priority: 0, classification: versions[0].document.classification,
    target: { providerId: 'comfy', modelId: 'comfy-workflow', connectionPresetId: 'connection', comfyCharacterEnabled: false, comfyWorkflowBinding: binding, comfyReferences: references } }] });
  const poolBytes = file(pool).size, poolHead = { id: 'pool', revision: 'prev1', version: 1, name: 'Pool', createdAt: 1, updatedAt: 1, archived: true, bytes: poolBytes, totalBytes: poolBytes, candidateCount: 1, enabled: true, styleLock: true };
  const pools = { schema: COMFY_POOL_BACKUP_SCHEMA, namespace, credentialsIncluded: false, pools: [{ head: poolHead, versions: [{ meta: { ...poolHead, archived: false }, pool }] }] };
  const document = normalizeCharacterArchive({ ...newCharacterArchive('char'), name: 'Alice', ageStatus: 'adult', imagegen: { appearance: 'dark hair', sensitiveAppearance: 'private annotation', reference: receipt,
    preview: { ...receipt, url: '/user/images/cover.png', sourceSha256: sha256 }, novelReference: { strength: 0, fidelity: 1 } },
    comfy: { version: 1, implementations: [{ version: 1, name: 'Reference', workflow: { id: 'workflow', revision: 'wrev1', version: 1, hash: binding.workflowHash }, referenceSlot: 1, loras: [], conditioning: [] }] } });
  const roleHead = { id: 'alice', revision: 'arev1', version: 1, category: 'char', name: 'Alice', aliases: [], cover: document.imagegen.preview.url, bytes: file(document).size, createdAt: 1, updatedAt: 1 };
  const characters = { schema: CHARACTER_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, archives: [{ head: roleHead, document }], bindings: [{ category: 'char', subjectKey: 'char:alice.png', scope: 'chat', chatKey, archiveId: '', revision: 'bind1', updatedAt: 1 }], usage: { count: 1, bytes: roleHead.bytes, bindings: 1 } };
  const config = { type: 'qianmu-storyboard', version: 7, credentialsIncluded: false, settings: { profiles: { comfy: { comfyWorkflowBinding: binding, comfyReferences: { ...references, items: [{ ...receipt, url: '/user/images/config.png' }] } } }, connections: { comfy: { presets: [{ id: 'connection', credentialId: '' }] } } },
    chat: { images: [{ id: 'frame', url: '/user/images/frame.png' }], collections: [] }, media: [{ id: 'frame', mime: 'image/png', b64: data }], vibeAccount: namespace, vibeAssets: [] };
  const sources = { workflows, pools, characters }, reads = { workflows: 0, pools: 0, characters: 0, images: 0 };
  const store = key => ({ backup: async () => { reads[key]++; return clone(sources[key]); } });
  const options = { namespace, chatKey, storyboard: file(config), workflowStore: store('workflows'), poolStore: store('pools'), characterStore: store('characters'),
    readImages: async rows => { reads.images++; assert.equal(rows.length, 1); return [blob]; }, now: () => 123 };
  return { sources, config, options, reads, build: () => captureStoryboardResourceBundle(options) };
}
async function replaceSection(built, id, replacement) {
  const opened = await openStoryboardBundle(built.file), entries = [];
  for (const row of opened.manifest.entries) entries.push({ id: row.id, file: row.id === id ? file(replacement) : (await opened.read(row.id)).file, ...(row.mime ? { mime: row.mime } : {}) });
  return buildStoryboardBundle({ namespace, chatKey, entries, createdAt: 123 });
}

test('unified bundle shares complete workflow history once and deduplicates original bytes without dropping any use', async () => {
  const f = await fixture(), before = clone(f.sources), result = await f.build(), inspected = await inspectStoryboardResourceBundle(result.file);
  assert.equal(result.manifest.entries.length, 6); assert.equal(f.reads.images, 1); assert.equal(result.summary.originalPaths, 4); assert.equal(result.summary.originalFiles, 1);
  assert.equal(result.summary.workflows.versions, 2); assert.equal(result.summary.identityVerified, false); assert.equal(result.summary.restoreAuthorized, false);
  assert.deepEqual(inspected.summary, result.summary); assert.equal(inspected.originals.length, 4); assert.equal(inspected.fingerprint, result.fingerprint);
  assert.deepEqual(f.sources, before); assert.deepEqual(f.reads, { workflows: 2, pools: 2, characters: 2, images: 1 });
  const opened = await openStoryboardBundle(result.file);
  for (const id of ['workflows', 'pools', 'characters']) assert.deepEqual(await opened.readJson(id), f.sources[id]);
  assert.deepEqual(await opened.readJson('storyboard'), f.config);
  assert.equal((await opened.readJson('characters')).archives[0].document.comfy.implementations[0].workflow.version, 1);
  assert.deepEqual(Buffer.from((await opened.read(`image:${sha256}`)).bytes), png);
});

test('source-labelled v3 bundles preserve complete contents and validate the account digest without upgrading legacy evidence', async () => {
  const f = await fixture(), old = await f.build(); assert.equal(old.manifest.schema, 'qianmu.storyboard.bundle.v2'); assert.equal(old.manifest.source, undefined);
  const source = { ok: true, version: 1, state: 'ready', expectedAccount: 'st-user:' + createHash('sha256').update(namespace.slice(8)).digest('hex'),
    instanceId: randomUUID(), accountId: randomUUID(), proof: 'installation-labels', automaticRebinding: false };
  f.options.source = source; const result = await f.build(), opened = await openStoryboardBundle(result.file);
  assert.equal(opened.manifest.schema, 'qianmu.storyboard.bundle.v3'); assert.deepEqual(opened.manifest.source, source);
  assert.deepEqual(result.manifest.entries, old.manifest.entries); assert.notEqual(result.fingerprint, old.fingerprint);
  const checked = await inspectStoryboardResourceBundle(result.file); assert.equal(checked.summary.identityVerified, false); assert.equal(checked.summary.restoreAuthorized, false);
  const prefixSize = new TextEncoder().encode('QIANMU-BUNDLE/1\n').length, prefix = new Uint8Array(await result.file.slice(0, prefixSize + 4).arrayBuffer());
  const oldLength = new DataView(prefix.buffer).getUint32(prefixSize, true), body = result.file.slice(prefixSize + 4 + oldLength);
  for (const tampered of [{ ...result.manifest, source: null }, { ...result.manifest, schema: 'qianmu.storyboard.bundle.v2' },
    { ...result.manifest, source: { ...source, expectedAccount: 'st-user:' + 'a'.repeat(64) } }, { ...result.manifest, source: { ...source, proof: 'verified' } }]) {
    const encoded = new TextEncoder().encode(JSON.stringify(tampered)), changedPrefix = prefix.slice(); new DataView(changedPrefix.buffer).setUint32(prefixSize, encoded.length, true);
    await assert.rejects(openStoryboardBundle(new Blob([changedPrefix, encoded, body])));
  }
  f.options.source = { ...source, expectedAccount: 'st-user:' + 'a'.repeat(64) };
  const before = structuredClone(f.reads); await assert.rejects(f.build(), /账户不一致/); assert.deepEqual(f.reads, before);
});

test('opening and checking a bundle reads slices only, not the full binary envelope, and ignores caller manifest edits', async () => {
  const result = await (await fixture()).build(), sizes = [];
  class SliceOnly extends Blob { arrayBuffer() { assert.fail('must never unpack the complete file'); } slice(start, end, mime) { sizes.push(end-start); return super.slice(start, end, mime); } }
  const source = new SliceOnly([result.file]); const opened = await openStoryboardBundle(source);
  assert.equal(sizes.length, 2); opened.manifest.entries[0].bytes = 1; opened.manifest.namespace = 'st-user:other';
  assert.equal((await opened.readJson('storyboard')).version, 7);
  await inspectStoryboardResourceBundle(source); assert.ok(Math.max(...sizes) < source.size);
});

test('the section directory rejects unknown IDs, missing libraries, duplicates and oversize before reading file contents', async () => {
  class NeverRead extends Blob { get size() { return this.claim || super.size; } arrayBuffer() { assert.fail('must preflight before reads'); } }
  const parts = ['storyboard', 'workflows', 'pools', 'characters'].map(id => ({ id, file: new NeverRead(['{}']) }));
  for (const entries of [parts.slice(1), [...parts, parts[0]], [...parts, { id: '../escape', file: new NeverRead(['{}']) }], [...parts, { id: 'image:bad', file: new NeverRead(['{}']) }]]) await assert.rejects(buildStoryboardBundle({ namespace, chatKey, entries }));
  parts[0].file.claim = STORYBOARD_BUNDLE_LIMITS.storyboard + 1;
  await assert.rejects(buildStoryboardBundle({ namespace, chatKey, entries: parts }), /大小/);
  for (const row of parts) row.file.claim = STORYBOARD_BUNDLE_LIMITS[row.id];
  const images = Array.from({ length: 16 }, (_, index) => { const original = new NeverRead(['x']); original.claim = STORYBOARD_BUNDLE_LIMITS.image; return { id: `image:${index.toString(16).padStart(64, '0')}`, file: original, mime: 'image/png' }; });
  await assert.rejects(buildStoryboardBundle({ namespace, chatKey, entries: [...parts, ...images] }), /超过 512 MiB/);
});

test('truncation, appended data, corrupt magic and altered content are rejected before a restore can be authorized', async () => {
  const result = await (await fixture()).build(), bytes = new Uint8Array(await result.file.arrayBuffer());
  await assert.rejects(openStoryboardBundle(result.file.slice(0, -1)), /截断/);
  await assert.rejects(openStoryboardBundle(new Blob([result.file, 'x'])), /多余/);
  const magic = bytes.slice(); magic[0] = 0; await assert.rejects(openStoryboardBundle(new Blob([magic])), /不是支持/);
  bytes[bytes.length-1] ^= 1; await assert.rejects(inspectStoryboardResourceBundle(new Blob([bytes])), /内容校验/);
});

test('directory duplicate escaped keys and noncanonical sections are never silently accepted', async () => {
  const result = await (await fixture()).build(), bytes = new Uint8Array(await result.file.arrayBuffer()), headerSize = new TextEncoder().encode('QIANMU-BUNDLE/1\n').length;
  const length = new DataView(bytes.buffer).getUint32(headerSize, true), header = new TextDecoder().decode(bytes.subarray(headerSize+4, headerSize+4+length));
  const changed = new TextEncoder().encode(header.replace('"credentialsIncluded":false', '"credentialsIncluded":true,"credentialsIncluded":false'));
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, changed.length, true);
  await assert.rejects(openStoryboardBundle(new Blob([bytes.subarray(0,headerSize), size, changed, bytes.subarray(headerSize+4+length)])), /重复/);
  const f = await fixture(), config = clone(f.config); config.unknownLibrary = [];
  const invalid = await replaceSection(result, 'storyboard', config); await assert.rejects(inspectStoryboardResourceBundle(invalid.file), /不支持/);
});

test('valid checksums cannot hide cross-account data, missing pinned versions or a wrong original receipt', async () => {
  const f = await fixture(), result = await f.build();
  const foreign = clone(f.sources.characters); foreign.namespace = 'st-user:other';
  await assert.rejects(inspectStoryboardResourceBundle((await replaceSection(result, 'characters', foreign)).file), /账户不一致/);
  const missing = clone(f.sources.workflows); missing.workflows = [];
  await assert.rejects(inspectStoryboardResourceBundle((await replaceSection(result, 'workflows', missing)).file), /原版本缺失/);
  const reordered = clone(f.sources.workflows); for (const row of reordered.workflows) for (const version of row.versions) version.document = Object.fromEntries(Object.entries(version.document).reverse());
  assert.equal((await inspectStoryboardResourceBundle((await replaceSection(result, 'workflows', reordered)).file)).summary.workflows.versions, 2);
  const config = clone(f.config); config.settings.profiles.comfy.comfyWorkflowBinding.recipeHash = 'f'.repeat(64);
  await assert.rejects(inspectStoryboardResourceBundle((await replaceSection(result, 'storyboard', config)).file), /摘要互相冲突|原文不符/);
  config.settings.profiles.comfy.comfyWorkflowBinding = f.config.settings.profiles.comfy.comfyWorkflowBinding;
  config.settings.profiles.comfy.comfyReferences.items[0].sha256 = 'f'.repeat(64);
  await assert.rejects(inspectStoryboardResourceBundle((await replaceSection(result, 'storyboard', config)).file), /数量不符|收据不符/);
});

test('credential declarations are not trusted, while an empty credential slot does not become a grant', async () => {
  const f = await fixture(); f.config.settings.connections.comfy.presets[0].credentialId = 'private-local-reference'; f.options.storyboard = file(f.config);
  await assert.rejects(f.build(), /结构化连接凭据/); assert.equal(f.reads.images, 0);
  const g = await fixture(); g.config.settings.profiles.comfy.comfyReferences.namespace = 'st-user:other'; g.options.storyboard = file(g.config);
  await assert.rejects(g.build(), /另一账户/); assert.equal(g.reads.images, 0);
});

test('missing gallery originals cannot be exported as complete, and local legacy Vibe originals are included', async () => {
  const f = await fixture(); f.config.media = []; f.options.storyboard = file(f.config);
  await assert.rejects(f.build(), /成片原图/); assert.equal(f.reads.images, 0);
  const g = await fixture(); g.config.settings.vibeLibrary = [{ id: 'legacy', previewUrl: '/user/images/legacy.png' }]; g.options.storyboard = file(g.config);
  g.options.legacyFetch = async () => new Response(png);
  const result = await g.build(); assert.equal(result.summary.legacyVibeUrls, 1); assert.equal((await inspectStoryboardResourceBundle(result.file)).summary.legacyVibeOriginals, 1);
});

test('a changed source library, unreadable original or cancelled page prevents output without any library writes', async () => {
  const f = await fixture(); f.options.readImages = async () => { f.sources.characters.bindings[0].revision = 'changed'; return [blob]; };
  await assert.rejects(f.build(), /打包期间/);
  const g = await fixture(); g.options.readImages = async () => [new Blob(['invalid'])]; await assert.rejects(g.build(), /读取结果/);
  const h = await fixture(); let current = true; h.options.isCurrent = () => current; h.options.readImages = async () => { current = false; return [blob]; };
  await assert.rejects(h.build(), /页面已变化/);
});

test('binary original reader retains old image-call format and verifies bytes before producing a Blob', async () => {
  const fetchImpl = async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  const [saved] = await readStaticReferenceBlobs([receipt], { fetchImpl }); assert.equal(saved.type, 'image/png'); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), png);
  const [image] = await readStaticReferenceImages([receipt], { fetchImpl }); assert.equal(image.data, data); assert.equal(image.name, 'reference-1.png');
  await assert.rejects(readStaticReferenceBlobs([{ ...receipt, sha256: 'f'.repeat(64) }], { fetchImpl }), /内容已变化/);
});

class FakeWorker {
  static latest; listeners = new Map(); messages = []; terminated = false;
  constructor(url, options) { this.url = url; this.options = options; FakeWorker.latest = this; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.listeners.get('message')({ data }); }
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
test('background runtime sends a Blob only, guards worker reads, and releases its worker on success', async () => {
  let guards = 0; const pending = runStoryboardBundle('capture', blob, { namespace, chatKey, guard: async () => { guards++; }, WorkerClass: FakeWorker }); await turn();
  const worker = FakeWorker.latest; assert.equal(worker.messages[0].file, blob); assert.equal(worker.messages[0].namespace, namespace); assert.equal(worker.options.type, 'module');
  worker.emit({ guard: 1 }); await turn(); assert.equal(worker.messages[1].guard, 1);
  worker.emit({ result: { file: blob, summary: {}, manifest: {}, fingerprint: sha256 } }); await pending; assert.equal(worker.terminated, true); assert.equal(guards, 3);
});

test('background runtime cancels, rejects late results and never retries work synchronously', async () => {
  const signal = new AbortController(), pending = runStoryboardBundle('inspect', blob, { guard: async () => {}, signal: signal.signal, WorkerClass: FakeWorker }); await turn();
  await assert.rejects(runStoryboardBundle('inspect', blob, { guard: async () => {}, WorkerClass: FakeWorker }), /已有/);
  const worker = FakeWorker.latest; signal.abort(); await assert.rejects(pending, /取消/); assert.equal(worker.terminated, true);
  worker.emit({ result: { summary: {}, manifest: {}, fileBytes: 1, fingerprint: sha256 } });
  const again = runStoryboardBundle('inspect', blob, { guard: async () => {}, WorkerClass: FakeWorker }); await turn(); closeStoryboardBundleRuntime(); await assert.rejects(again, /取消/);
  await assert.rejects(runStoryboardBundle('inspect', blob, { guard: async () => {}, WorkerClass: null }), /无法启动/);
});

test('background runtime stops when the account guard rejects, and refuses malformed completion', async () => {
  let ok = true; const pending = runStoryboardBundle('inspect', blob, { guard: async () => { if (!ok) throw Error('account changed'); }, WorkerClass: FakeWorker }); await turn();
  ok = false; FakeWorker.latest.emit({ guard: 1 }); await assert.rejects(pending, /account changed/); assert.equal(FakeWorker.latest.terminated, true);
  const malformed = runStoryboardBundle('inspect', blob, { guard: async () => {}, WorkerClass: FakeWorker }); await turn(); FakeWorker.latest.emit({ result: {} }); await assert.rejects(malformed, /不完整/);
});
