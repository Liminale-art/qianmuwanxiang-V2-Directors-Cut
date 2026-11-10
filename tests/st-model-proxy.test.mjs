import test from 'node:test';
import assert from 'node:assert/strict';
import { createStModelProxy } from '../qianmu-st-model-proxy.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = text => json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

function harness(replies) {
  const calls = [];
  const proxy = createStModelProxy({
    headers: () => ({ 'X-CSRF-Token': 't' }),
    fetchImpl: async (path, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path, body, auth: JSON.parse(body.custom_include_headers).Authorization, headers: init.headers });
      const next = replies.shift();
      if (!next) throw new Error('unexpected request');
      return typeof next === 'function' ? next(body) : next;
    },
  });
  return { proxy, calls };
}

test('generation goes through the ST custom channel with the unified root and JSON auth header', async () => {
  const { proxy, calls } = harness([ok('正文')]);
  const text = await proxy.generate({ apiUrl: 'https://api.deepseek.com', apiKey: 'sk-test-0001', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, maxTokens: 64 });
  assert.equal(text, '正文');
  assert.equal(calls.length, 1);
  const [{ path, body, auth, headers }] = calls;
  assert.equal(path, '/api/backends/chat-completions/generate');
  assert.equal(body.chat_completion_source, 'custom');
  assert.equal(body.custom_url, 'https://api.deepseek.com/v1');
  assert.equal(body.reverse_proxy, '');
  assert.equal(auth, 'Bearer sk-test-0001');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.temperature, 0.3);
  assert.equal(headers['X-CSRF-Token'], 't');
});

test('vendor paths are kept and pasted endpoints are folded back to the root', async () => {
  const { proxy, calls } = harness([ok('a'), ok('b')]);
  await proxy.generate({ apiUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k-1234', model: 'm', messages: [] });
  await proxy.generate({ apiUrl: 'https://relay.example/v1/chat/completions', apiKey: 'k-1234', model: 'm', messages: [] });
  assert.deepEqual(calls.map(call => call.body.custom_url), ['https://ark.cn-beijing.volces.com/api/v3', 'https://relay.example/v1']);
  assert.equal(calls[0].body.max_tokens, undefined, 'max_tokens is only sent when positive');
});

test('rejected auth retries exactly once with the bare key, including ST-wrapped Unauthorized', async () => {
  for (const rejection of [json({ error: 'x' }, 401), json({ error: 'x' }, 403), json({ error: { message: 'Unauthorized' } }), new Response('Unauthorized', { status: 400 })]) {
    const { proxy, calls } = harness([rejection, ok('好')]);
    assert.equal(await proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'Bearer raw-key-9', model: 'm', messages: [] }), '好');
    assert.deepEqual(calls.map(call => call.auth), ['Bearer raw-key-9', 'raw-key-9']);
  }
  const { proxy, calls } = harness([json({ error: 'x' }, 401), json({ error: 'x' }, 401)]);
  await assert.rejects(proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'raw-key-9', model: 'm', messages: [] }), /HTTP 401/);
  assert.equal(calls.length, 2);
});

test('non-auth failures neither retry nor lose the HTTP status that callers use to fall back', async () => {
  const { proxy, calls } = harness([new Response('nope', { status: 404 })]);
  await assert.rejects(proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'raw-key-9', model: 'm', messages: [] }), /^Error: HTTP 404 · nope$/);
  assert.equal(calls.length, 1);
  const network = harness([() => { throw new TypeError('Failed to fetch'); }]);
  await assert.rejects(network.proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'raw-key-9', model: 'm', messages: [] }), /Failed to fetch/);
});

test('upstream errors wrapped in a 200 reply fail and never echo the key', async () => {
  const { proxy } = harness([json({ error: { message: 'bad key sk-abcdefgh12345 rejected' } })]);
  await assert.rejects(proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'other-key-77', model: 'm', messages: [] }), error => {
    assert.match(error.message, /^上游模型请求失败：/);
    assert.doesNotMatch(error.message, /sk-abcdefgh12345/);
    return true;
  });
});

test('reply shapes from several vendors decode to plain text; reasoning is reported separately', async () => {
  const thoughts = [];
  const { proxy } = harness([
    json({ choices: [{ message: { content: '答', reasoning_content: '想' }, finish_reason: 'stop' }] }),
    json({ type: 'message', content: [{ type: 'thinking', thinking: '思' }, { type: 'text', text: 'Claude' }], stop_reason: 'end_turn' }),
    json({ candidates: [{ content: { parts: [{ text: 'Gemini' }] }, finishReason: 'STOP' }] }),
    json({ choices: [{ message: { content: null, tool_calls: [{ function: { arguments: '{"lines":[]}' } }] } }] }),
    json({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }] }),
  ]);
  const call = () => proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'k-1234', model: 'm', messages: [], onReasoning: value => thoughts.push(value) });
  assert.equal(await call(), '答');
  assert.equal(await call(), 'Claude');
  assert.equal(await call(), 'Gemini');
  assert.equal(await call(), '{"lines":[]}', 'forced function-call arguments still count as the reply');
  assert.equal(await call(), '半截', 'finish reason handling stays with the caller, as before');
  assert.deepEqual(thoughts, ['想', '思']);
});

test('an empty reply is an error', async () => {
  const { proxy } = harness([json({ choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] })]);
  await assert.rejects(proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'k-1234', model: 'm', messages: [] }), /上游模型未返回可用正文/);
});

test('model listing uses the status channel and the shared catalogue parser', async () => {
  const { proxy, calls } = harness([json({ data: [{ id: 'b' }, { id: 'a' }, 'a'] }), json({ error: true })]);
  assert.deepEqual(await proxy.listModels({ apiUrl: 'https://api.deepseek.com/v1/models', apiKey: 'k-1234' }), ['a', 'b']);
  assert.equal(calls[0].path, '/api/backends/chat-completions/status');
  assert.equal(calls[0].body.custom_url, 'https://api.deepseek.com/v1');
  await assert.rejects(proxy.listModels({ apiUrl: 'https://api.deepseek.com', apiKey: 'k-1234' }), /模型目录不可用/);
});

test('connection test falls back to a 1-token probe only when a chat model is selected', async () => {
  let h = harness([json({ error: true }), ok('x')]);
  assert.equal((await h.proxy.testConnection({ apiUrl: 'https://gw.example/v1', apiKey: 'k-1234', model: 'chat-1' })).scope, 'chat-probe');
  assert.equal(h.calls[1].path, '/api/backends/chat-completions/generate');
  assert.equal(h.calls[1].body.max_tokens, 1);
  assert.equal(h.calls[1].body.model, 'chat-1');

  h = harness([json({ data: [] }), ok('x')]);
  assert.equal((await h.proxy.testConnection({ apiUrl: 'https://gw.example/v1', apiKey: 'k-1234', model: 'chat-1' })).scope, 'chat-probe', 'an empty catalogue is not proof of a working chat model');

  h = harness([json({ data: [{ id: 'm' }] })]);
  assert.equal((await h.proxy.testConnection({ apiUrl: 'https://gw.example/v1', apiKey: 'k-1234', model: 'chat-1' })).scope, 'model-list');

  h = harness([json({ error: true })]);
  await assert.rejects(h.proxy.testConnection({ apiUrl: 'https://gw.example/v1', apiKey: 'k-1234', model: 'embed-1', chatModel: false }), /模型目录不可用/);
  assert.equal(h.calls.length, 1, 'embedding / rerank models are never sent a chat probe');

  h = harness([json({ error: true })]);
  await assert.rejects(h.proxy.testConnection({ apiUrl: 'https://gw.example/v1', apiKey: 'k-1234', model: '' }), /模型目录不可用/);
  assert.equal(h.calls.length, 1);
});

test('bad addresses are refused before anything is sent', async () => {
  const { proxy, calls } = harness([]);
  await assert.rejects(proxy.generate({ apiUrl: 'relay.example/v1', apiKey: 'k-1234', model: 'm', messages: [] }), /API 地址格式无效/);
  await assert.rejects(proxy.listModels({ apiUrl: 'https://user:pw@relay.example/v1', apiKey: 'k-1234' }), /不含账号密码/);
  assert.equal(calls.length, 0);
});

test('cancellation is passed through and not retried', async () => {
  const controller = new AbortController(); controller.abort();
  const { proxy, calls } = harness([(body) => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }]);
  await assert.rejects(proxy.generate({ apiUrl: 'https://relay.example/v1', apiKey: 'k-1234', model: 'm', messages: [], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});
