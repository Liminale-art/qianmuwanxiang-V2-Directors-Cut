// Development-only request-cost baseline. All records, ST files, identity
// replies, Workers and fetches are synthetic and kept in this process's memory.
// No live ST, account, API, disk file, migration or generation is touched.
// Run: node scripts/check-native-read-cost.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStAccountStorage, configureStAccountStorage } from '../qianmu-st-account-storage.js';
import { resolveImageAccountNamespace } from '../qianmu-account-identity.js';
import { createCharacterArchiveSession } from '../qianmu-character-archive-session.js';
import { createNativeComfyWorkflowStore } from '../qianmu-comfy-native-store.js';
import { createNativeVibeAssetStore } from '../qianmu-vibe-native-store.js';
import { createVibeAssetStore } from '../qianmu-vibe-asset-store.js';
import { createVibeEncodingStore } from '../qianmu-vibe-encoding-store.js';
import { createVibeAssetOperations } from '../qianmu-vibe-assets-worker.js';
import { vibeFileError } from '../qianmu-vibe-file.js';
import { characterWorkerStorageOptions } from '../qianmu-character-worker-storage.js';
import { callVibeAsset, closeVibeAssetRuntime } from '../qianmu-vibe-assets.js';
import { characterNativeFixture, namespace, document } from '../tests/helpers/character-native-fixture.mjs';
import { vibeLegacyFixture, vibeInput } from '../tests/helpers/vibe-legacy-fixture.mjs';
import { receiptWritableFixture } from '../tests/helpers/vibe-receipt-writable-fixture.mjs';

const origin = 'https://st.fixture.invalid';
const rttMs = Number(process.argv.find(arg => arg.startsWith('--rtt-ms='))?.slice(9) || 0);
assert.ok(Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= 100, 'Synthetic RTT must be between 0 and 100 ms');
const handle = namespace.slice('st-user:'.length);
const workerSource = await readFile(new URL('../qianmu-vibe-assets-worker.js', import.meta.url), 'utf8');
const workerEntry = workerSource.indexOf('let pending=Promise.resolve()');
assert.ok(workerEntry >= 0, 'The real Worker entry must be identified, not replaced with a simulated algorithm');
const globals = new Map(['fetch', 'Worker'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
// Install this before any measurement. A new/unexpected code path must fail
// instead of silently reaching the network or spawning a real browser Worker.
globalThis.fetch = async () => { throw new Error('Live network is forbidden in this baseline'); };
globalThis.Worker = class { constructor() { throw new Error('A real Worker is forbidden in this baseline'); } };
const results = [];

async function scenario(identityMode) {
  const cleanup = [], t = { after: callback => cleanup.push(callback) };
  let identityChecks = 0, identityHttpRequests = 0, measuring = false, began = 0, waterfall = [];
  const waitForRtt = async kind => {
    if (!measuring) return;
    const event = {kind, startMs: +(performance.now() - began).toFixed(3)};waterfall.push(event);
    if (rttMs) await new Promise(resolve => setTimeout(resolve, rttMs));
    event.endMs = +(performance.now() - began).toFixed(3);
  };
  const fixture = await characterNativeFixture(t), local = vibeLegacyFixture(t), ledger = receiptWritableFixture();
  const keep = client => { cleanup.push(() => client.close()); return client; };
  const input = await vibeInput();
  // Seed one native record of each type through the actual store. Uploads here
  // only fill the fixture's Map, outside the read-only measurement window.
  await fixture.open().save(namespace, { document: document() });
  const comfySeed = keep(createNativeComfyWorkflowStore({ createStorage: fixture.createStorage }));
  await comfySeed.save(namespace, { name: 'Workflow', document: {
    workflow: JSON.stringify({ one: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_prompt%' } },
      two: { class_type: 'SaveImage', inputs: { images: ['one', 0] } } }),
    outputNodeId: 'two', parameters: { seed: 0, width: 832 },
  } });
  const vibeSeed = keep(createNativeVibeAssetStore({ createStorage: fixture.createStorage, legacy: local.open() }));
  await vibeSeed.putFile(namespace, input.asset.serialized);
  fixture.hook(call => {
    if (measuring && call.request.method !== 'GET') throw new Error('A measured read attempted a write');
  });

  const resolveNamespace = async () => {
    identityChecks++;
    return resolveImageAccountNamespace({
      loadUser: async () => ({ currentUser: identityMode === 'initialized-user' ? { handle } : null }),
      fetchImpl: async (url, options) => {
        assert.equal(url, '/api/users/me'); assert.equal(options.credentials, 'same-origin');
        assert.equal(options.cache, 'no-store'); identityHttpRequests++;
        await waitForRtt('identity');return Response.json({ handle });
      },
    });
  };
  const storageOptions = { resolveNamespace, isCurrent: () => true, origin, cryptoImpl: webcrypto,
    headers: () => ({ 'X-CSRF-Token': 'synthetic' }), fetchImpl: async (...args) => {
      await waitForRtt('file');return fixture.fetchImpl(...args);
    } };
  const createStorage = options => createStAccountStorage({ ...storageOptions, ...options,
    resolveNamespace, isCurrent: () => !options?.isCurrent || options.isCurrent() === true });
  const workers = [];
  async function measure(surface, operation, run) {
    fixture.reset(); identityChecks = 0; identityHttpRequests = 0;waterfall=[];began=performance.now();
    const eventsBefore = workers.reduce((sum, worker) => sum + worker.received.length, 0);
    const before = new Map(fixture.files);
    measuring = true;
    try { await run(); } finally { measuring = false; }
    assert.deepEqual(fixture.files, before, 'Measured reads must leave synthetic ST files unchanged');
    const events = workers.flatMap(worker => worker.received).slice(eventsBefore);
    results.push({ identityMode, surface, operation, identityChecks, identityHttpRequests, elapsedMs: +(performance.now()-began).toFixed(3), waterfall,
      fileGetRequests: fixture.calls.filter(call => call.request.method === 'GET').length,
      fileWriteRequests: fixture.calls.filter(call => call.request.method !== 'GET').length,
      workerGuardMessages: events.filter(event => Object.hasOwn(event, 'guard')).length,
      workerProgressMessages: events.filter(event => Object.hasOwn(event, 'progress')).length,
      fileRequests: fixture.calls.map(call => call.path.replace(/[a-f0-9]{64}/g, 'HASH')) });
  }

  try {
    const characters = keep(createCharacterArchiveSession({ createStorage,
      createLocal: () => { throw new Error('Existing native library unexpectedly entered local storage'); },
      requestMigration: () => {}, // The benchmark deliberately excludes separate idle migration work.
    }));
    await measure('native-store', 'character-cold-overview', () => characters.overview(namespace));
    await measure('native-store', 'character-warm-overview', () => characters.overview(namespace));
    const comfy = keep(createNativeComfyWorkflowStore({ createStorage }));
    await measure('native-store', 'comfy-cold-view', () => comfy.view(namespace));
    await measure('native-store', 'comfy-warm-view', () => comfy.view(namespace));
    const vibes = keep(createNativeVibeAssetStore({ createStorage, legacy: local.open() }));
    await measure('native-store', 'vibe-cold-list', () => vibes.list(namespace));
    await measure('native-store', 'vibe-warm-list', () => vibes.list(namespace));
    await measure('native-store', 'vibe-warm-preview-one-part', () => vibes.preview(namespace, input.asset.assetId));

    // Real client and real Worker message-handler source, with only browser
    // Worker transport and readonly IDB supplied by the isolated test fixtures.
    class MemoryWorker extends EventTarget {
      constructor() {
        super(); workers.push(this); this.received = []; this.closed = false;
        const self = { location: { origin }, addEventListener: (_, handler) => this.receive = handler,
          postMessage: value => {
            this.received.push(structuredClone(value));
            queueMicrotask(() => { if (!this.closed) this.dispatchEvent(new MessageEvent('message', { data: structuredClone(value) })); });
          } };
        this.realm = vm.createContext({ self, characterWorkerStorageOptions, vibeFileError, createVibeAssetOperations,
          createVibeAssetStore: options => createVibeAssetStore({ ...options, indexedDB: local.indexedDB, keyRange: local.keyRange }),
          createVibeEncodingStore: options => createVibeEncodingStore({ ...options, indexedDB: ledger.indexedDB, keyRange: ledger.keyRange }),
        });
        vm.runInContext(workerSource.slice(workerEntry), this.realm);
      }
      postMessage(message) { queueMicrotask(() => { if (!this.closed) this.receive({ data: structuredClone(message) }); }); }
      terminate() { this.closed = true; vm.runInContext('runtime?.store.close();runtime?.encodings.close();', this.realm); }
    }
    configureStAccountStorage(storageOptions);
    globalThis.fetch = storageOptions.fetchImpl; globalThis.Worker = MemoryWorker;
    await measure('worker-bridge', 'vibe-cold-list', () => callVibeAsset('list', { namespace }));
    await measure('worker-bridge', 'vibe-warm-preview-one-part', () => callVibeAsset('preview', { namespace, id: input.asset.assetId }));
  } finally {
    closeVibeAssetRuntime();
    for (const callback of cleanup.reverse()) await callback();
  }
}

try {
  await scenario('initialized-user');
  await scenario('identity-fallback');
  console.log(JSON.stringify({ schema: 'qianmu.native-read-cost.v1', isolation: 'in-memory-only',
    input: { syntheticRttMs:rttMs, recordsPerLibrary: 1, previewParts: 1, responseDataChunks: 1, migrations: false, controllers: false,
      realNetwork: false, realWorkers: false, realAccounts: false, realWrites: false },
    notes: ['Counts are measured, not hard-coded expectations.',
      'Native-store measurements exclude the two controller authorization checks around a cold list.',
      'Worker measurements include the actual native client, guard RPC and progress guard paths.',
      'Vibe library cards come from settings; the native list case is an adapter baseline, not a claim that every UI mount calls list.',
      'More stream chunks, preview parts, migrations or retries change request counts; these are not universal upper bounds.',
      'Elapsed time and request waterfalls use only the specified synthetic RTT, never production latency.'], results }, null, 2));
} finally {
  closeVibeAssetRuntime();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
