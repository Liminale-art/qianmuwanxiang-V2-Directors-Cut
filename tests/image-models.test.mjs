import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeModelEntry, finalizeModelList, modelArrayFromJson, collectImageModelPages,
  modelsFromComfyObjectInfo, IMAGE_MODEL_LIST_LIMIT, IMAGE_MODEL_ID_LIMIT } from '../qianmu-image-models.js';
import { listDirectImageModels, isDirectImageTransportError } from '../qianmu-image-direct.js';
import { listImageModels } from '../qianmu-image-gateway.js';

const json = (value, options) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
const input = (provider = 'openai') => ({ provider, baseUrl: 'https://relay.example/v1', apiKey: 'test-key' });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('model names are opaque, unknown aliases survive and Gemini resource names are distinct', () => {
  const id = 'models/vendor/team:Banana-Custom@v2';
  assert.equal(normalizeModelEntry({ id }, 'banana').id, id);
  const resource = normalizeModelEntry({ name: 'models/gemini-image' }, 'banana');
  assert.equal(resource.id, 'gemini-image'); assert.equal(resource.rawId, 'models/gemini-image');
  assert.equal(normalizeModelEntry({ modelId: 'relay/任意前缀' }, 'seedream').id, 'relay/任意前缀');
  assert.equal(normalizeModelEntry({ id: 'not-an-image-name', displayName: 'Unknown' }, 'openai').imageCapable, false);
  const result = finalizeModelList('openai', [{ id: 'not-an-image-name' }, { id: 'gpt-image-2' }, { id: '__proto__' }, { id: 'constructor' }]);
  assert.equal(result.total, 4);
  assert.ok(result.models.some((item) => item.id === '__proto__'));
  assert.equal(result.models[0].id, 'gpt-image-2');
});

test('model catalog is bounded, deduplicated and never truncates an ID into a different model', () => {
  const id = 'x'.repeat(IMAGE_MODEL_ID_LIMIT + 1);
  assert.equal(normalizeModelEntry({ id }, 'openai'), null);
  assert.equal(normalizeModelEntry({ id: 'bad\nname' }, 'openai'), null);
  assert.equal(normalizeModelEntry({ id: { toString: () => 'unexpected' } }, 'openai'), null);
  const result = finalizeModelList('openai', [{ id: 'same', apiKey: 'never-copy', headers: { Authorization: 'never-copy' } }, { id: 'same' }, { id }]);
  assert.equal(result.total, 1); assert.equal(result.invalidCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /never-copy|Authorization|apiKey/);
  const large = finalizeModelList('openai', Array.from({ length: 4001 }, (_, i) => `relay-${i}`));
  assert.equal(large.total, IMAGE_MODEL_LIST_LIMIT); assert.equal(large.truncated, true);
});

test('common relay envelopes share one parser', () => {
  const rows = [{ modelId: 'relay-1' }];
  for (const value of [rows, { data: rows }, { models: rows }, { items: rows }, { data: { models: rows } }, { result: { list: rows } }, { result: rows }]) {
    assert.equal(modelArrayFromJson(value), rows);
  }
  assert.deepEqual(modelArrayFromJson({ error: 'not a catalog' }), []);
});

test('pagination halts on repeated tokens and never repeats an endless ten-page loop', async () => {
  const tokens = [];
  const result = await collectImageModelPages('banana', async (token) => {
    tokens.push(token); return { models: [{ name: `models/id-${tokens.length}` }], nextPageToken: 'repeat' };
  });
  assert.deepEqual(tokens, ['', 'repeat']); assert.equal(result.total, 2); assert.equal(result.truncated, true);
});

test('pagination stops at the row and page budgets', async () => {
  let calls = 0;
  const result = await collectImageModelPages('banana', async () => {
    calls++; return { models: Array.from({ length: 5000 }, (_, i) => ({ id: `model-${i}` })), nextPageToken: 'next' };
  });
  assert.equal(calls, 1); assert.equal(result.total, IMAGE_MODEL_LIST_LIMIT); assert.equal(result.truncated, true);
  calls = 0;
  const pages = await collectImageModelPages('banana', async () => ({ models: [], nextPageToken: String(++calls) }));
  assert.equal(calls, 10); assert.equal(pages.truncated, true);
});

test('cancelled discovery does not return a late catalog or request another page', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(collectImageModelPages('banana', async () => {
    calls++; controller.abort(); return { models: [{ id: 'late' }], nextPageToken: 'another' };
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('browser and enhanced gateway return the same catalog without generation', async () => {
  for (const provider of ['openai', 'banana', 'seedream', 'novel']) {
    const rows = { data: [{ id: 'models/vendor-x/alias' }, { id: 'gpt-image-2' }] };
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'GET'); assert.match(String(url), /\/models(?:\?|$)/);
      assert.doesNotMatch(String(url), /generate|generations|edits|test-key/);
      assert.equal(init.body, undefined); return json(rows);
    };
    const direct = await listDirectImageModels(input(provider), { fetchImpl });
    const gateway = await listImageModels(input(provider), { fetchImpl, resolveHost: publicDns });
    assert.deepEqual(direct, gateway);
    assert.ok(direct.models.some(item => item.id === 'models/vendor-x/alias'));
  }
});

test('browser model listing respects compatibility paths and headers but does not export credentials', async () => {
  const compatibility = { endpoints: { models: 'catalog/models' }, customHeaderNames: ['X-Project'] };
  const result = await listDirectImageModels({ ...input(), compatibility, customHeaders: { 'X-Project': 'workspace', Authorization: 'forbidden' } }, {
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://relay.example/v1/catalog/models');
      assert.equal(init.headers.Authorization, 'Bearer test-key'); assert.equal(init.headers['X-Project'], 'workspace');
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      return json({ data: [{ id: 'relay-alias' }] });
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /test-key|workspace|Authorization/);
});

test('official NAI and disabled discovery do not send a network request', async () => {
  const fetchImpl = async () => { throw new Error('must not fetch'); };
  const nai = await listDirectImageModels({ provider: 'novel', baseUrl: 'https://image.novelai.net' }, { fetchImpl });
  const gateway = await listImageModels({ provider: 'novel', apiKey: 'key' }, { fetchImpl, resolveHost: publicDns });
  assert.deepEqual(nai, gateway); assert.equal(nai.source, 'builtin');
  const disabled = await listDirectImageModels({ ...input(), compatibility: { modelDiscovery: 'off' } }, { fetchImpl });
  assert.equal(disabled.source, 'disabled'); assert.equal(disabled.total, 0);
});

test('Comfy model discovery is a bounded catalog, not a workflow execution', async () => {
  const info = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['folder/x.safetensors']] } } },
    TextEncoder: { input: { required: { model_name: [['not-a-checkpoint']] } } } };
  const result = await listDirectImageModels({ provider: 'comfy', baseUrl: 'http://127.0.0.1:8188' }, {
    fetchImpl: async (url, init) => { assert.equal(String(url), 'http://127.0.0.1:8188/object_info'); assert.equal(init.method, 'GET'); return json(info); },
  });
  assert.deepEqual(result, modelsFromComfyObjectInfo(info));
  assert.equal(result.total, 1); assert.equal(result.models[0].kind, 'checkpoint');
  const big = modelsFromComfyObjectInfo({ CheckpointLoader: { input: { required: { ckpt_name: [Array.from({ length: 5000 }, (_, i) => `m${i}`)] } } } });
  assert.equal(big.total, IMAGE_MODEL_LIST_LIMIT); assert.equal(big.truncated, true);
});

test('404 and permission errors are brief and do not imply that image generation failed', async () => {
  for (const status of [401, 403, 404, 405, 429, 500]) {
    await assert.rejects(listDirectImageModels(input(), { fetchImpl: async () => new Response('private-upstream-detail', { status }) }), error => {
      assert.equal(error.status, status); assert.doesNotMatch(error.message, /private-upstream-detail/);
      if ([404, 405].includes(status)) { assert.equal(error.code, 'models_unavailable'); assert.match(error.message, /不代表生图失败/); }
      return true;
    });
  }
});

test('catalog request cancellation and total timeout are not retried', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const fetchImpl = async (_url, init) => { calls++; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); };
  await assert.rejects(listDirectImageModels({ ...input(), signal: controller.signal }, { fetchImpl }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(listDirectImageModels(input(), { fetchImpl, timeoutMs: 100 }), { code: 'model_list_timeout' });
  assert.equal(calls, 1);
  const live = new AbortController(); const pending = listDirectImageModels({ ...input(), signal: live.signal }, { fetchImpl }); live.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 2);
});

test('streaming response size guard cancels oversized bodies, including chunked responses', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(listDirectImageModels(input(), { fetchImpl: async () => new Response(stream) }), { code: 'model_list_too_large' });
  assert.equal(cancelled, true);
  await assert.rejects(listDirectImageModels(input(), { fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }) }), { code: 'model_list_too_large' });
  await assert.rejects(listDirectImageModels(input(), { fetchImpl: async () => new Response('<html>login</html>') }), { code: 'invalid_model_list' });
});

test('UTF-8 chunk boundaries do not corrupt model labels', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ id: 'relay-test', displayName: '第三方模型' }] }));
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const result = await listDirectImageModels(input(), { fetchImpl: async () => new Response(stream) });
  assert.equal(result.models[0].label, '第三方模型');
});

test('invalid addresses and transport failure never fall back to generation', async () => {
  let calls = 0;
  for (const baseUrl of ['not a url', 'ftp://relay.example', 'https://name:password@relay.example']) {
    await assert.rejects(listDirectImageModels({ ...input(), baseUrl }, { fetchImpl: async () => { calls++; } }), { code: 'invalid_base_url' });
  }
  assert.equal(calls, 0);
  await assert.rejects(listDirectImageModels(input(), { fetchImpl: async () => { calls++; throw new TypeError('CORS'); } }), isDirectImageTransportError);
  assert.equal(calls, 1);
});

test('catalog helper is shared by the two transports and included in the release whitelist', async () => {
  const config = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.ok(config.files.includes('qianmu-image-models.js'));
  for (const file of ['qianmu-image-direct.js', 'qianmu-image-gateway.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /from '\.\/qianmu-image-models.js'/);
    assert.doesNotMatch(source, /function imageModelHeuristic|function normalizeModelEntry/);
  }
});
