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
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const installGuide = await readFile(new URL('../INSTALL-DOUBAO-APIKEY.md', import.meta.url), 'utf8');
const shellInstaller = await readFile(new URL('../install-server-plugin.sh', import.meta.url), 'utf8');
const powershellInstaller = await readFile(new URL('../install-server-plugin.ps1', import.meta.url), 'utf8');
assert.equal(packageJson.main, 'server-plugin.js');
assert.equal(packageJson.version, '1.22.0');
assert.equal(manifest.version, packageJson.version);
assert.match(installGuide, /install-server-plugin\.sh \| sh/);
assert.match(installGuide, /install-server-plugin\.ps1 \| iex/);
assert.match(installGuide, /云端 \/ VPS 部署/);
assert.match(installGuide, /本地部署/);
assert.match(installGuide, /重启 SillyTavern 后端服务或 Docker 容器/);
assert.match(installGuide, /不是只刷新、关闭或重新打开 ST 网页/);
assert.match(installGuide, /st\.example\.com\/api\/plugins\/qianmu-tts\/health/);
assert.match(shellInstaller, /enableServerPlugins: true/);
assert.match(shellInstaller, /mkdir -p "\$PLUGIN_PARENT"/);
assert.match(shellInstaller, /config\/config\.yaml/);
assert.match(shellInstaller, /docker compose restart sillytavern/);
assert.match(shellInstaller, /\/home\/node\/app\/plugins/);
assert.match(powershellInstaller, /enableServerPlugins: true/);
assert.match(powershellInstaller, /New-Item -ItemType Directory/);
assert.match(installGuide, /api\/plugins\/qianmu-tts\/health/);

const health = mockResponse();
await routes.get('GET /health')({}, health);
assert.deepEqual(health.body, { ok: true, plugin: 'qianmu-tts', version: '1.22.0' });

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
      resourceId: 'seed-icl-2.0',
      request: {
        user: { uid: 'test' },
        req_params: {
          text: '你好', speaker: 'zh_female_vv_uranus_bigtts',
          audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 10, loudness_rate: 5 },
          additions: JSON.stringify({ context_texts: ['温柔地说'] }),
          model: 'seed-tts-2.0-expressive',
        },
      },
    },
  }, response);

  assert.equal(upstreamRequest.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(upstreamRequest.init.headers['X-Api-Key'], 'new-api-key');
  assert.equal(upstreamRequest.init.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
  assert.equal(JSON.parse(upstreamRequest.init.body).req_params.audio_params.sample_rate, 24000);
  assert.equal(JSON.parse(upstreamRequest.init.body).req_params.model, 'seed-tts-2.0-expressive');
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

  const invalidResource = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: { apiKey: 'key', resourceId: 'https://example.com' } }, invalidResource);
  assert.equal(invalidResource.statusCode, 400);
  assert.match(String(invalidResource.body), /资源 ID 不在允许列表/);

  const invalidInference = mockResponse();
  await routes.get('POST /doubao/synthesize')({ body: {
    apiKey: 'key', resourceId: 'seed-icl-2.0',
    request: { req_params: { text: '你好', speaker: 'S_test', model: 'untrusted-model', audio_params: {} } },
  } }, invalidInference);
  assert.equal(invalidInference.statusCode, 400);
  assert.match(String(invalidInference.body), /推理模型不在允许列表/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('TTS server plugin OK');
