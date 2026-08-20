import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { info, init } from '../server-plugin.js';

const routes = new Map();
await init({
  get(path, handler) { routes.set(`GET ${path}`, handler); },
  post(path, handler) { routes.set(`POST ${path}`, handler); },
});

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

assert.equal(info.id, 'qianmu-tts');
assert.ok(routes.has('GET /health'));
assert.ok(routes.has('POST /doubao/synthesize'));

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const installGuide = await readFile(new URL('../INSTALL-DOUBAO-APIKEY.md', import.meta.url), 'utf8');
assert.equal(packageJson.main, 'server-plugin.js');
assert.equal(packageJson.version, '1.10.0');
assert.match(installGuide, /enableServerPlugins:\s*true/);
assert.match(installGuide, /New-Item -ItemType Directory -Force plugins/);
assert.match(installGuide, /mkdir -p plugins/);
assert.match(installGuide, /plugins\/Omniscene/);
assert.match(installGuide, /api\/plugins\/qianmu-tts\/health/);

const health = mockResponse();
await routes.get('GET /health')({}, health);
assert.deepEqual(health.body, { ok: true, plugin: 'qianmu-tts', version: '1.10.0' });

const originalFetch = globalThis.fetch;
try {
  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init };
    const frame = JSON.stringify({ code: 0, data: Buffer.from('server-audio').toString('base64') });
    return new Response(frame, { status: 200, headers: { 'content-type': 'text/plain', 'x-tt-logid': 'server-log' } });
  };

  const response = mockResponse();
  await routes.get('POST /doubao/synthesize')({
    body: {
      apiKey: 'new-api-key',
      request: {
        user: { uid: 'test' },
        req_params: {
          text: '你好', speaker: 'zh_female_vv_uranus_bigtts',
          audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 10, loudness_rate: 5 },
          additions: JSON.stringify({ context_texts: ['温柔地说'] }),
        },
      },
    },
  }, response);

  assert.equal(upstreamRequest.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(upstreamRequest.init.headers['X-Api-Key'], 'new-api-key');
  assert.equal(upstreamRequest.init.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.equal(JSON.parse(upstreamRequest.init.body).req_params.audio_params.sample_rate, 24000);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-tt-logid'], 'server-log');
  assert.equal(Buffer.from(response.body).toString(), JSON.stringify({ code: 0, data: Buffer.from('server-audio').toString('base64') }));

  const missingKey = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: {} }, missingKey);
  assert.equal(missingKey.statusCode, 400);
  assert.match(String(missingKey.body), /缺少豆包 API Key/);

  const invalid = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: { apiKey: 'key', request: { req_params: { text: '你好' } } } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.match(String(invalid.body), /未指定豆包音色 ID/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('TTS server plugin OK');
