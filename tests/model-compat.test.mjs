import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApiRoot, chatEndpoint, modelsEndpoint, authCandidates, authRejected, sendWithAuthFallback, chatPayload, probePayload,
  stProxyBody, proxyPayloadError, describeHttpFailure, redactSecrets, parseModelList, probeConnection,
} from '../qianmu-model-compat.js';

test('API root matrix: bare hosts gain /v1, explicit vendor paths are preserved, known endpoint suffixes are folded once', () => {
  const cases = [
    ['https://api.openai.com', 'https://api.openai.com/v1'],
    ['https://api.openai.com/', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1/models', 'https://api.openai.com/v1'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1'],
    ['https://api.siliconflow.cn/v1', 'https://api.siliconflow.cn/v1'],
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://open.bigmodel.cn/api/paas/v4/', 'https://open.bigmodel.cn/api/paas/v4'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1'],
    ['https://relay.example/proxy/openai/v1/embeddings', 'https://relay.example/proxy/openai/v1'],
    ['https://relay.example/v1/rerank', 'https://relay.example/v1'],
    ['  https://relay.example/custom/  ', 'https://relay.example/custom'],
    ['https://relay.example/chat/completions', 'https://relay.example/v1'],
  ];
  for (const [input, expected] of cases) assert.equal(resolveApiRoot(input), expected, input);
  assert.equal(chatEndpoint(resolveApiRoot('https://ark.cn-beijing.volces.com/api/v3')), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(modelsEndpoint(resolveApiRoot('https://api.deepseek.com')), 'https://api.deepseek.com/v1/models');
});

test('a trailing # keeps the address verbatim without folding suffixes or adding /v1', () => {
  assert.equal(resolveApiRoot('https://gateway.example#'), 'https://gateway.example');
  assert.equal(resolveApiRoot('https://gateway.example/odd/models#'), 'https://gateway.example/odd/models');
  assert.equal(resolveApiRoot('https://gateway.example/raw/#'), 'https://gateway.example/raw');
});

test('missing, malformed or credential-bearing addresses are refused before any request', () => {
  for (const [input, code] of [['', 'MODEL_URL_MISSING'], ['not a url', 'MODEL_URL_INVALID'], ['ftp://host/v1', 'MODEL_URL_UNSAFE'],
    ['https://user:pass@host/v1', 'MODEL_URL_UNSAFE'], ['https://host/v1?key=secret', 'MODEL_URL_UNSAFE'], ['https://host/v1#frag', 'MODEL_URL_UNSAFE']]) {
    assert.throws(() => resolveApiRoot(input), { code }, input);
  }
});

test('auth candidates try a single Bearer form then the bare key, and keep an explicit empty value for keyless endpoints', () => {
  assert.deepEqual(authCandidates('sk-abc'), ['Bearer sk-abc', 'sk-abc']);
  assert.deepEqual(authCandidates('Bearer sk-abc'), ['Bearer sk-abc', 'sk-abc']);
  assert.deepEqual(authCandidates('  bearer   sk-abc '), ['Bearer sk-abc', 'sk-abc']);
  assert.deepEqual(authCandidates(''), ['']);
  assert.throws(() => authCandidates('sk\r\nInjected: yes'), { code: 'MODEL_KEY_INVALID' });
  assert.equal(authRejected({ status: 403 }), true);
  assert.equal(authRejected(new Error('HTTP 401 · nope')), true);
  assert.equal(authRejected(new Error('上游模型请求失败：Unauthorized')), true);
  assert.equal(authRejected(new Error('HTTP 503')), false);
});

test('auth fallback resends exactly once and only after a rejection, never after cancel or other failures', async () => {
  const seen = [];
  const reply = status => new Response('{}', { status });
  let result = await sendWithAuthFallback('k-1', async auth => { seen.push(auth); return reply(seen.length === 1 ? 401 : 200); });
  assert.deepEqual(seen, ['Bearer k-1', 'k-1']); assert.equal(result.status, 200);

  seen.length = 0;
  result = await sendWithAuthFallback('k-1', async auth => { seen.push(auth); return reply(503); });
  assert.deepEqual(seen, ['Bearer k-1']); assert.equal(result.status, 503);

  seen.length = 0;
  await assert.rejects(sendWithAuthFallback('k-1', async auth => { seen.push(auth); throw Object.assign(new Error('HTTP 401'), { name: 'AbortError' }); }));
  assert.deepEqual(seen, ['Bearer k-1']);

  seen.length = 0;
  result = await sendWithAuthFallback('k-1', async auth => { seen.push(auth); if (seen.length === 1) throw new Error('上游模型请求失败：Unauthorized'); return 'ok'; });
  assert.deepEqual(seen, ['Bearer k-1', 'k-1']); assert.equal(result, 'ok');

  seen.length = 0;
  result = await sendWithAuthFallback('', async auth => { seen.push(auth); return reply(401); });
  assert.deepEqual(seen, ['']); assert.equal(result.status, 401);
});

test('chat payload sends optional fields only when meaningful; probe asks for a single token', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  assert.deepEqual(chatPayload({ model: ' m ', messages, temperature: 0.7 }), { model: 'm', messages, stream: false, temperature: 0.7 });
  const full = chatPayload({ model: 'm', messages, temperature: '0', maxTokens: 512.9, stream: true, responseFormat: { type: 'json_schema' } });
  assert.deepEqual(full, { model: 'm', messages, stream: true, temperature: 0, max_tokens: 512, response_format: { type: 'json_schema' } });
  assert.equal('max_tokens' in chatPayload({ model: 'm', messages, maxTokens: 0 }), false);
  assert.equal('temperature' in chatPayload({ model: 'm', messages, temperature: 'x' }), false);
  assert.deepEqual(probePayload('m'), { model: 'm', messages: [{ role: 'user', content: '连接测试' }], temperature: 0, max_tokens: 1, stream: false });
});

test('ST proxy body routes through the custom channel with JSON headers that payload fields cannot override', () => {
  const body = stProxyBody('https://host/v1', 'Bearer k:"#x', { model: 'm', custom_url: 'https://evil', chat_completion_source: 'openai' });
  assert.equal(body.chat_completion_source, 'custom'); assert.equal(body.custom_url, 'https://host/v1');
  assert.equal(body.reverse_proxy, ''); assert.equal(body.proxy_password, ''); assert.equal(body.model, 'm');
  assert.deepEqual(JSON.parse(body.custom_include_headers), { Authorization: 'Bearer k:"#x' });
  assert.deepEqual(JSON.parse(stProxyBody('https://host/v1', '').custom_include_headers), { Authorization: '' });
});

test('ST proxy 200 envelopes are read as failures; HTTP failures map to actionable Chinese text', () => {
  assert.equal(proxyPayloadError({ error: true, data: { data: [] } }), '上游接口未通过检查');
  assert.equal(proxyPayloadError({ error: { message: 'Service Unavailable' } }), 'Service Unavailable');
  assert.equal(proxyPayloadError({ error: 'bad' }), 'bad');
  assert.equal(proxyPayloadError({ choices: [] }), '');
  assert.match(describeHttpFailure(401), /Key/); assert.match(describeHttpFailure(404), /地址与模型名/);
  assert.match(describeHttpFailure(429), /限流/); assert.match(describeHttpFailure(503), /上游服务异常/);
  assert.match(describeHttpFailure(400), /HTTP 400/); assert.match(describeHttpFailure(418), /HTTP 418/);
});

test('error text never carries keys, bearer tokens or sk- secrets', () => {
  const text = redactSecrets('failed Bearer sk-live-123456789 at https://host/v1 with sk-other-abcdefghij and raw-key-1', ['raw-key-1', 'Bearer sk-live-123456789']);
  assert.doesNotMatch(text, /sk-live|sk-other|raw-key-1/); assert.match(text, /\[已隐藏\]/);
  assert.equal(redactSecrets('short ab', ['ab']), 'short ab');
});

test('model list accepts every common shape, dedupes, sorts, and treats proxy error envelopes as empty', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { name: 'c' }, 'a'] }), ['a', 'b', 'c']);
  assert.deepEqual(parseModelList({ models: [{ name: 'x' }, ' y '] }), ['x', 'y']);
  assert.deepEqual(parseModelList(['m2', { id: 'm1' }]), ['m1', 'm2']);
  assert.deepEqual(parseModelList({ data: { 'k-1': {}, 'k-0': {} } }), ['k-0', 'k-1']);
  assert.deepEqual(parseModelList({ error: true, data: { data: [] } }), []);
  assert.deepEqual(parseModelList(null), []);
});

test('connection probe falls back to one tiny generation only when the catalogue fails for a non-cancel reason and a model is set', async () => {
  let probes = 0;
  const probe = async () => { probes++; };
  assert.deepEqual(await probeConnection({ listModels: async () => ['m'], probe, model: 'm' }), { ok: true, scope: 'model-list', models: ['m'] });
  assert.equal(probes, 0);
  assert.deepEqual(await probeConnection({ listModels: async () => { throw new Error('HTTP 503'); }, probe, model: 'm' }), { ok: true, scope: 'chat-probe', models: [] });
  assert.equal(probes, 1);
  for (const [error, model] of [[new Error('HTTP 503'), ''], [Object.assign(new Error('x'), { name: 'AbortError' }), 'm'], [Object.assign(new Error('x'), { code: 'MODEL_TIMEOUT' }), 'm']]) {
    await assert.rejects(probeConnection({ listModels: async () => { throw error; }, probe, model }), error);
  }
  assert.equal(probes, 1);
  await assert.rejects(probeConnection({ listModels: async () => { throw new Error('HTTP 503'); }, probe: async () => { throw new Error('probe failed'); }, model: 'm' }), /probe failed/);
});
