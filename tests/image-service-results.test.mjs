import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceResults } from '../qianmu-image-service-results.js';
import { pinnedImageResultFetch, validateGatewayBaseUrl } from '../qianmu-image-gateway.js';
import { verifyComfyCloudImageDigest } from '../qianmu-comfy-cloud-digest.js';
import { COMFY_CLOUD_STAGE_SCHEMA } from '../qianmu-comfy-cloud-stage-contract.js';
import { COMFY_CLOUD_RECEIPT_SCHEMA } from '../qianmu-comfy-cloud-receipt.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const identity = (attemptId = 'one', extra = {}) => ({ namespace: 'account', channelKey: 'a'.repeat(64), requestDigest: 'b'.repeat(64), fence: 'private-fence', attemptId, ...extra });
const result = { ok: true, provider: 'novel', model: 'nai-diffusion-5-full', images: [{ data: PNG }] };
async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-result-test-'));
  const store = createImageServiceStore({ dataRoot: root, ...(options.scope === 'comfy-cloud' ? { scope: 'comfy-cloud' } : {}) }), cache = createImageServiceResults({ dataRoot: root, store, ...options });
  t.after(async () => { await store.close(); const real = await fs.realpath(root); assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^qianmu-result-test-/); await fs.rm(real, { recursive: true }); });
  return { root, store, cache };
}

async function cloudResult(owner = identity()) {
  const checked = await verifyComfyCloudImageDigest(Buffer.from(PNG, 'base64'), null);
  const task = bindComfyCloudTask(bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2'), 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const assetId = '00000000-0000-4000-8000-000000000001';
  return { ok: true, provider: 'comfy-cloud', model: 'workflow', upstreamId: 'original', images: [{ bytes: checked.bytes }],
    cloud: { schema: COMFY_CLOUD_STAGE_SCHEMA, identity: owner, receipt: { schema: COMFY_CLOUD_RECEIPT_SCHEMA, task, requestDigest: owner.requestDigest,
      workflow: { templateHash: 'c'.repeat(64), executionHash: 'd'.repeat(64) }, stillOutput: { version: 1, model: 'workflow', previewNodeIds: [], execution: { version: 1, automatic: true, maxImages: 1, expectedImages: 1, outputNodeIds: ['save'] } } },
    selection: [{ assetId, nodeId: 'save', mime: 'image/png', sizeBytes: checked.bytes.length, hash: null }],
    images: [{ assetId, hash: null, integrity: checked.integrity }] } };
}

test('cloud staging reuses private storage but remains separate from native images and reads bytes without base64', async t => {
  const { root, store, cache } = await fixture(t, { scope: 'comfy-cloud' }), packet = await cloudResult();
  await cache.reserve(identity());
  const saved = await cache.save(identity(), packet), loaded = await cache.load(identity());
  assert.equal(saved.ready, true); assert.equal(loaded.receipt, saved.receipt); assert.equal(loaded.cloud.schema, COMFY_CLOUD_STAGE_SCHEMA);
  assert.deepEqual(Buffer.from(loaded.images[0].bytes), Buffer.from(PNG, 'base64'));
  assert.equal(loaded.images[0].data, undefined); assert.equal(loaded.images[0].url, undefined);
  const inventory = await cache.inventory(identity().namespace);
  assert.equal(inventory.totals.count, 1); assert.equal(inventory.totals.imageBytes, Buffer.from(PNG, 'base64').length);
  assert.equal((await cache.inventory('other-account')).totals.count, 0);
  assert.equal(await createImageServiceResults({ dataRoot: root, store, scope: 'comfy' }).load(identity()), null);
  assert.equal(await createImageServiceResults({ dataRoot: root, store }).load(identity()), null);
  await assert.rejects(cache.save(identity(), packet), { code: 'image_service_result_exists' });
  await cache.discard(identity(), saved.receipt); assert.equal(await cache.load(identity()), null);
});

test('cloud staging rejects URLs, base64, stale proof and mismatched owner before saving any image file', async t => {
  for (const kind of ['url', 'data', 'bytes', 'owner']) {
    const { root, cache } = await fixture(t, { scope: 'comfy-cloud' }), packet = await cloudResult(); await cache.reserve(identity());
    if (kind === 'url') packet.images = [{ url: 'https://private.test/?sig=private' }];
    if (kind === 'data') packet.images = [{ data: PNG }];
    if (kind === 'bytes') packet.images[0].bytes.fill(0);
    if (kind === 'owner') packet.cloud.identity = { ...identity(), fence: 'other' };
    await assert.rejects(cache.save(identity(), packet));
    const folders = await fs.readdir(path.join(root, '.qianmu-service', 'comfy-cloud-results-v1'));
    assert.deepEqual(await fs.readdir(path.join(root, '.qianmu-service', 'comfy-cloud-results-v1', folders[0])), ['manifest.json']);
    assert.equal((await cache.load(identity(), { metadataOnly: true })).ready, false);
  }
});

test('cloud staging rechecks the stored bytes and the proof-to-manifest relationship on recovery', async t => {
  for (const kind of ['binary', 'proof']) {
    const { root, cache } = await fixture(t, { scope: 'comfy-cloud' }); await cache.reserve(identity()); await cache.save(identity(), await cloudResult());
    const base = path.join(root, '.qianmu-service', 'comfy-cloud-results-v1'), folders = await fs.readdir(base), folder = path.join(base, folders[0]);
    if (kind === 'binary') { const file = path.join(folder, 'image-0.bin'), bytes = await fs.readFile(file); bytes[20] ^= 1; await fs.writeFile(file, bytes); }
    else { const file = path.join(folder, 'manifest.json'), body = JSON.parse(await fs.readFile(file, 'utf8')); body.cloud.images[0].integrity.sha256 = '0'.repeat(64); await fs.writeFile(file, JSON.stringify(body)); }
    await assert.rejects(cache.load(identity()), { code: 'image_service_result_corrupt' });
  }
});

test('public media lookup is pinned to copied validated addresses and never forwards authentication', async () => {
  const url = 'https://image.example.test/p.png?sig=mock', addresses = [{ address: '8.8.8.8', family: 4 }]; let options;
  const fetcher = pinnedImageResultFetch(url, addresses, (_url, init, callback) => {
    options = init; const request = new EventEmitter();
    request.end = () => { const incoming = Readable.from([Buffer.from(PNG, 'base64')]); incoming.statusCode = 200; incoming.headers = { 'content-type': 'image/png' }; callback(incoming); };
    return request;
  });
  addresses[0].address = '127.0.0.1';
  const response = await fetcher(url, { method: 'GET', headers: { Authorization: 'must-not-forward', Cookie: 'private-cookie' } });
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'), PNG);
  assert.deepEqual(options.headers, { Accept: 'image/*' });
  assert.equal(options.agent, false, 'a pooled socket must not bypass the validated DNS answers');
  assert.equal(options.maxHeaderSize, 16384, 'media headers use the same bound as the Comfy transport');
  const pinned = await new Promise((resolve, reject) => options.lookup('image.example.test', { all: true }, (error, records) => error ? reject(error) : resolve(records)));
  assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(fetcher('https://elsewhere.example.test/p.png', { method: 'GET' }), { code: 'unsafe_image_host' });
});

test('media bytes wait for a consumer and cancelling the web body releases the incoming stream', async () => {
  const url = 'https://image.example.test/p.png'; let reads = 0, incoming;
  const fetcher = pinnedImageResultFetch(url, [{ address: '8.8.8.8', family: 4 }], (_url, _init, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      incoming = new Readable({ read() { reads++; this.push(Buffer.alloc(65536)); } });
      incoming.statusCode = 200; incoming.headers = { 'content-type': 'image/png' }; callback(incoming);
    };
    return request;
  });
  const response = await fetcher(url, { method: 'GET' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0, 'checking metadata or permissions must not eagerly buffer the file body');
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 65536);
  await reader.cancel(); reader.releaseLock();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(incoming.destroyed, true, 'cancelled downloads must not keep reading into a closed web stream');
});

test('private addresses, changed methods and redirects cannot turn media retrieval into another request', async () => {
  const url = 'https://image.example.test/p.png';
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.1.1']) assert.throws(() => pinnedImageResultFetch(url, [{ address, family: 4 }]), { code: 'unsafe_image_host' });
  const fetcher = pinnedImageResultFetch(url, [{ address: '8.8.8.8', family: 4 }], (_url, _init, callback) => {
    const request = new EventEmitter(); request.end = () => { const incoming = Readable.from([]); incoming.statusCode = 302; incoming.headers = { location: 'https://private.example.test' }; callback(incoming); }; return request;
  });
  await assert.rejects(fetcher(url, { method: 'POST' }), { code: 'unsafe_image_host' });
  await assert.rejects(fetcher(url, { method: 'GET' }), { code: 'image_redirect_blocked' });
});

test('expanded IPv6 and translated targets obey the same public-only rule for API and media DNS', async () => {
  const unsafe = [
    '::', '0:0:0:0:0:0:0:0', '::1', '0000:0000:0000:0000:0000:0000:0000:0001',
    '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::127.0.0.1', '::ffff:8.8.8.8',
    'fe80::1', 'fc00::1', 'ff02::1', '0064:ff9b:0000:0000:0000:0000:7f00:0001',
    '2002:7f00:1::', '2001:0db8::1', '2001:0002::1', '2001:0000:0000:0000:0000:0000:0000:0001',
  ];
  for (const address of unsafe) {
    const records = [{ address, family: 6 }];
    assert.throws(() => pinnedImageResultFetch('https://image.example.test/p.png', records), { code: 'unsafe_image_host' }, address);
    await assert.rejects(validateGatewayBaseUrl('https://api.example.test', { resolveHost: async () => records }), { code: 'private_network_blocked' }, address);
  }
});

test('public IPv6 spellings remain usable and explicit local Comfy access keeps its existing authorization path', async () => {
  for (const address of ['2606:4700:4700::1111', '2606:4700:4700:0000:0000:0000:0000:1111']) {
    const records = [{ address, family: 6 }];
    assert.equal(typeof pinnedImageResultFetch('https://image.example.test/p.png', records), 'function');
    assert.equal((await validateGatewayBaseUrl('https://api.example.test', { resolveHost: async () => records })).origin, 'https://api.example.test');
  }
  assert.equal((await validateGatewayBaseUrl('http://[::1]:8188', { allowPrivateNetwork: true })).origin, 'http://[::1]:8188');
});

test('result reservation counts worst-case bytes and does not create an over-capacity slot', async t => {
  const { root, cache } = await fixture(t, { maxSlots: 3, maxBytes: 96 * 1024 * 1024 });
  await cache.reserve(identity('a')); await cache.reserve(identity('b'));
  await assert.rejects(cache.reserve(identity('c')), { code: 'image_service_result_full' });
  assert.equal((await fs.readdir(path.join(root, '.qianmu-service', 'image-results-v1'))).length, 2);
  const first = await cache.load(identity('a'), { metadataOnly: true });
  await cache.discard(identity('a'), first.receipt);
  await cache.reserve(identity('c'));
});

test('request fences and exact receipts protect result ownership and cleanup', async t => {
  const { cache } = await fixture(t);
  await cache.reserve(identity()); const saved = await cache.save(identity(), result);
  await assert.rejects(cache.load(identity('one', { fence: 'different-fence' })), { code: 'image_service_result_corrupt' });
  await assert.rejects(cache.discard(identity(), saved.receipt, { valid: () => false }), { code: 'image_service_result_cancelled' });
  assert.equal((await cache.load(identity())).images[0].data, PNG);
  await assert.rejects(cache.save(identity(), result), { code: 'image_service_result_exists' });
});

test('unknown files and directory junctions are never swept by temporary result cleanup', async t => {
  const { root, cache } = await fixture(t); await cache.reserve(identity()); const saved = await cache.save(identity(), result);
  const base = path.join(root, '.qianmu-service', 'image-results-v1'), [name] = await fs.readdir(base), folder = path.join(base, name);
  await fs.writeFile(path.join(folder, 'user-note.txt'), 'keep');
  await assert.rejects(cache.discard(identity(), saved.receipt), { code: 'image_service_result_corrupt' });
  assert.equal(await fs.readFile(path.join(folder, 'user-note.txt'), 'utf8'), 'keep');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const staged = path.join(root, '.qianmu-service', 'image-results-saved'); await fs.rename(base, staged); await fs.symlink(outside, base, 'junction');
  await assert.rejects(cache.reserve(identity('new')), { code: 'image_service_result_path' });
  assert.deepEqual(await fs.readdir(outside), []);
});
