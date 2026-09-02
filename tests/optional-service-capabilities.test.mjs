import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  QIANMU_OPTIONAL_SERVICE_ENDPOINT,
  probeQianmuOptionalService,
} from '../qianmu-service-capabilities.js';

let request;
const ready = await probeQianmuOptionalService({
  headers: { 'X-CSRF-Token': 'test-token' },
  fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      ok: true,
      plugin: 'qianmu-tts',
      version: '1.58.11',
      services: ['doubao-tts', 'storyboard-image', 'doubao-tts'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(request.url, QIANMU_OPTIONAL_SERVICE_ENDPOINT);
assert.equal(request.init.method, 'GET');
assert.equal(request.init.cache, 'no-store');
assert.equal(request.init.headers['X-CSRF-Token'], 'test-token');
assert.equal(ready.status, 'ready');
assert.equal(ready.available, true);
assert.equal(ready.version, '1.58.11');
assert.deepEqual(ready.services, ['doubao-tts', 'storyboard-image']);

const missing = await probeQianmuOptionalService({
  fetchImpl: async () => new Response('', { status: 404 }),
});
assert.equal(missing.status, 'missing');
assert.equal(missing.available, false);

const invalid = await probeQianmuOptionalService({
  fetchImpl: async () => new Response(JSON.stringify({ ok: true, plugin: 'another-plugin' }), { status: 200 }),
});
assert.equal(invalid.status, 'error');

const failed = await probeQianmuOptionalService({
  fetchImpl: async () => { throw new TypeError('network details must not leak'); },
});
assert.equal(failed.status, 'error');
assert.equal(failed.message, '增强服务暂不可达');
assert.doesNotMatch(JSON.stringify(failed), /network details/);

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(source, /if \(activeTab === 'plug'\)[\s\S]*refreshOptionalServiceState\(false\)/, '能力检测只应随 API 与日志页进入');
assert.match(source, /function paintOptionalServiceState\(\)[\s\S]*\.sd-optional-service-label[\s\S]*\.sd-optional-service-detail/, '检测结果必须局部更新诊断卡');
assert.doesNotMatch(source, /setInterval\([^\n]*refreshOptionalServiceState/, '能力检测不得变成后台轮询');

console.log('Optional service capability contract OK');
