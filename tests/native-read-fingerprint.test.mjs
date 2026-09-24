import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeComfyWorkflowStore } from '../qianmu-comfy-native-store.js';
import { createNativeVibeAssetStore, VIBE_NATIVE_SLOT } from '../qianmu-vibe-native-store.js';
import { COMFY_NATIVE_SLOT } from '../qianmu-comfy-native-contract.js';
import { characterNativeFixture, namespace } from './helpers/character-native-fixture.mjs';
import { vibeLegacyFixture, vibeInput } from './helpers/vibe-legacy-fixture.mjs';

const gate = () => { let resolve; return { promise: new Promise(done => resolve = done), resolve }; };
const headName = (f, slot) => [...f.files.keys()].find(name => name.endsWith(`-${slot}.json`));
const bodyName = (f, slot) => [...f.files.keys()].find(name => new RegExp(`-${slot}-[a-f0-9]{64}\\.json$`).test(name));
const comfyDocument = { workflow: JSON.stringify({ text: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } },
  save: { class_type: 'SaveImage', inputs: { images: ['text', 0] } } }), outputNodeId: 'save', parameters: { width: 832, seed: 0 } };

async function library(t, family, { oldAdapter = false } = {}) {
  const f = await characterNativeFixture(t), legacy = vibeLegacyFixture(t), input = await vibeInput();
  const createStorage = async options => {
    const client = await f.createStorage(options);
    return oldAdapter ? { ...client, readFingerprint: undefined } : client;
  };
  const store = family === 'comfy' ? createNativeComfyWorkflowStore({ createStorage })
    : createNativeVibeAssetStore({ createStorage, legacy: legacy.open() });
  t.after(() => store.close());
  if (family === 'comfy') await store.save(namespace, { name: 'Workflow', document: comfyDocument });
  else await store.putFile(namespace, input.asset.serialized);
  f.reset();
  return { ...f, store, input, slot: family === 'comfy' ? COMFY_NATIVE_SLOT : VIBE_NATIVE_SLOT,
    list: () => family === 'comfy' ? store.view(namespace) : store.list(namespace) };
}

test('fingerprint verification reads one guarded head, returns exact revisions or null, and does not fetch a body', async t => {
  const f = await characterNativeFixture(t), store = f.storage;
  const first = await store.write('read-cost', { text: 'first' }, { expectedFingerprint: null });
  f.reset();
  assert.equal(await store.readFingerprint('read-cost'), first.fingerprint);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.method, 'GET');
  assert.ok(f.calls[0].path.endsWith('-read-cost.json')); assert.equal(f.uploads, 0);
  const next = await store.write('read-cost', { text: 'second' }, { expectedFingerprint: first.fingerprint });
  f.reset(); assert.equal(await store.readFingerprint('read-cost'), next.fingerprint); assert.equal(f.calls.length, 1);
  f.reset(); assert.equal(await store.readFingerprint('not-created'), null); assert.equal(f.calls.length, 1);
  const before = f.calls.length;
  assert.throws(() => store.readFingerprint('../wrong'), { code: 'st_account_storage_slot' });
  await assert.rejects(store.readFingerprint('read-cost', { guard: () => false }), { code: 'st_account_storage_scope' });
  assert.equal(f.calls.length, before);
});

test('fingerprint verification validates head scope, slot, schema and bounded JSON rather than trusting raw text', async t => {
  for (const kind of ['scope', 'slot', 'schema', 'hash', 'duplicate', 'oversized']) {
    const f = await characterNativeFixture(t), store = f.storage;
    await store.write('read-cost', { text: 'valid' }, { expectedFingerprint: null });
    const name = headName(f, 'read-cost'), head = JSON.parse(f.files.get(name));
    if (kind === 'scope') head.scope = 'b'.repeat(64);
    if (kind === 'slot') head.slot = 'another';
    if (kind === 'schema') head.schema = 'unknown';
    if (kind === 'hash') head.fingerprint = 'invalid';
    f.files.set(name, kind === 'duplicate' ? JSON.stringify(head).replace('"slot":', '"slot":"another","slot":')
      : kind === 'oversized' ? JSON.stringify({ ...head, extra: 'x'.repeat(4096) }) : JSON.stringify(head));
    f.reset(); await assert.rejects(store.readFingerprint('read-cost'));
    assert.equal(f.calls.length, 1); assert.equal(f.uploads, 0);
  }
});

test('late account, source, lifecycle and abort changes prevent a fingerprint from being returned', async t => {
  for (const mode of ['account', 'source', 'current', 'abort', 'close']) {
    const f = await characterNativeFixture(t), store = f.storage, controller = new AbortController(); let source = true;
    await store.write('read-cost', {}, { expectedFingerprint: null }); f.reset();
    f.hook(() => {
      if (mode === 'account') f.account('st-user:changed');
      if (mode === 'source') source = false;
      if (mode === 'current') f.live(false);
      if (mode === 'abort') controller.abort();
      if (mode === 'close') store.close();
    });
    await assert.rejects(store.readFingerprint('read-cost', { signal: controller.signal, guard: () => source }), error => error.writeState === 'not_started');
    assert.equal(f.calls.length, 1); assert.equal(f.uploads, 0);
  }
});

test('fingerprint reads settle on abort, close or timeout without retrying an unresponsive transport', async t => {
  for (const mode of ['abort', 'close', 'timeout']) {
    const f = await characterNativeFixture(t), entered = gate(), controller = new AbortController();
    const store = await f.createStorage({ timeoutMs: 100 }); t.after(() => store.close());
    f.hook(() => { entered.resolve(); return new Promise(() => {}); });
    const pending = store.readFingerprint('read-cost', { signal: controller.signal }); await entered.promise;
    if (mode === 'abort') controller.abort(); if (mode === 'close') store.close();
    await assert.rejects(pending, error => error.writeState === 'not_started');
    assert.equal(f.calls.length, 1); assert.equal(f.uploads, 0);
  }
});

test('head-only verification stays behind pending writes in the same account and slot queue', async t => {
  const f = await characterNativeFixture(t), a = f.storage, b = await f.createStorage({}), entered = gate(), release = gate();
  t.after(() => b.close());
  const first = await a.write('read-cost', { text: 'first' }, { expectedFingerprint: null }); let once = false;
  f.hook(async call => { if (!once && call.request.method === 'POST') { once = true; entered.resolve(); await release.promise; } });
  const saving = a.write('read-cost', { text: 'next' }, { expectedFingerprint: first.fingerprint }); await entered.promise;
  let finished = false;
  const checking = b.readFingerprint('read-cost').then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  release.resolve(); const next = await saving; assert.equal(await checking, next.fingerprint);
});

test('Comfy and Vibe lists download the validated catalogue body once and verify its head at the end', async t => {
  for (const family of ['comfy', 'vibe']) {
    const f = await library(t, family); await f.list();
    const heads = f.calls.filter(call => call.path.endsWith(`-${f.slot}.json`));
    const bodies = f.calls.filter(call => new RegExp(`-${f.slot}-[a-f0-9]{64}\\.json$`).test(call.path));
    assert.equal(heads.length, 2); assert.equal(bodies.length, 1); assert.equal(f.calls.length, 3); assert.equal(f.uploads, 0);
    if (family === 'vibe') {
      f.reset(); const blob = await f.store.preview(namespace, f.input.asset.assetId);
      assert.ok(blob.size > 0); assert.equal(f.calls.length, 5); assert.equal(f.uploads, 0);
      assert.equal(f.calls.filter(call => call.path.includes('-vibe-preview-part-')).length, 1);
      assert.equal(f.calls.filter(call => new RegExp(`-${f.slot}-[a-f0-9]{64}\\.json$`).test(call.path)).length, 1);
    }
  }
});

test('injected older clients keep their full-read fallback without weakening the guard contract', async t => {
  for (const family of ['comfy', 'vibe']) {
    const f = await library(t, family, { oldAdapter: true }); await f.list();
    assert.equal(f.calls.length, 4); assert.equal(f.uploads, 0);
    f.account('st-user:changed'); await assert.rejects(f.list());
  }
});

test('head-only final checks do not replace the initial full catalogue integrity validation', async t => {
  for (const family of ['comfy', 'vibe']) {
    const f = await library(t, family), name = bodyName(f, f.slot), body = JSON.parse(f.files.get(name));
    f.files.set(name, JSON.stringify({ ...body, value: { malformed: true } }));
    await assert.rejects(f.list(), /校验失败/); assert.equal(f.calls.length, 2); assert.equal(f.uploads, 0);
  }
});

test('a changed, deleted, malformed or foreign final head rejects both native lists instead of returning the old snapshot', async t => {
  for (const family of ['comfy', 'vibe']) for (const mode of ['changed', 'deleted', 'malformed', 'foreign']) {
    const f = await library(t, family), name = headName(f, f.slot); let reads = 0;
    f.hook(call => {
      if (call.path.endsWith(`-${f.slot}.json`) && ++reads === 2) {
        const head = JSON.parse(f.files.get(name));
        if (mode === 'deleted') f.files.delete(name);
        else if (mode === 'malformed') f.files.set(name, '{');
        else f.files.set(name, JSON.stringify({ ...head, ...(mode === 'foreign' ? { scope: 'b'.repeat(64) } : { fingerprint: 'b'.repeat(64) }) }));
      }
    });
    await assert.rejects(f.list()); assert.equal(reads, 2); assert.equal(f.calls.length, 3); assert.equal(f.uploads, 0);
  }
});

test('native lists reject an account switch or closed page while the final head is being read', async t => {
  for (const family of ['comfy', 'vibe']) for (const mode of ['account', 'current', 'close']) {
    const f = await library(t, family); let reads = 0;
    f.hook(call => {
      if (call.path.endsWith(`-${f.slot}.json`) && ++reads === 2) {
        if (mode === 'account') f.account('st-user:other');
        if (mode === 'current') f.live(false);
        if (mode === 'close') f.store.close();
      }
    });
    await assert.rejects(f.list()); assert.equal(reads, 2); assert.equal(f.calls.length, 3); assert.equal(f.uploads, 0);
  }
});
