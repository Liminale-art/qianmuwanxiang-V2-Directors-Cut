import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sendWithStreamUsage, stProxyBody, STREAM_USAGE_OPTIONS } from '../qianmu-model-compat.js';
import * as yimu from '../yimu/model-compat.mjs';
import { createModelResponseAccumulator, modelCacheText } from '../qianmu-model-response.js';

const reply = (status, body = '') => new Response(body, { status });

test('stream requests ask for usage at the end; non-stream requests are sent as they are', async () => {
  const seen = [];
  await sendWithStreamUsage('https://a/v1', true, async usage => { seen.push(usage); return reply(200); });
  await sendWithStreamUsage('https://a/v1', false, async usage => { seen.push(usage); return reply(200); });
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(STREAM_USAGE_OPTIONS, { include_usage: true });
});

test('a channel that refuses the field gets one resend without it and is remembered; other failures are never resent', async () => {
  let seen = [];
  // 渠道明确说不认这个字段（响应体）。
  let result = await sendWithStreamUsage('https://refuse-body/v1', true, async usage => { seen.push(usage); return usage ? reply(400, '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}') : reply(200, 'ok'); });
  assert.deepEqual(seen, [true, false]); assert.equal(result.status, 200);
  seen = [];
  await sendWithStreamUsage('https://refuse-body/v1', true, async usage => { seen.push(usage); return reply(200); });
  assert.deepEqual(seen, [false], 'the address is remembered for this session');
  // 经 ST 代理：失败是抛出的错误，文字里带着上游原话。
  seen = [];
  result = await sendWithStreamUsage('https://refuse-throw/v1', true, async usage => { seen.push(usage); if (usage) throw new Error('HTTP 400 · unknown parameter: stream_options'); return reply(200); });
  assert.deepEqual(seen, [true, false]); assert.equal(result.status, 200);
  // 其余失败原样交还：模型不存在、参数别的问题、限流、鉴权、取消。
  for (const [status, body] of [[404, 'model not found'], [400, 'context length exceeded'], [429, 'rate limited'], [401, 'unauthorized'], [500, 'stream_options upstream crashed']]) {
    seen = [];
    result = await sendWithStreamUsage(`https://plain-${status}/v1`, true, async usage => { seen.push(usage); return reply(status, body); });
    assert.deepEqual(seen, [true], `HTTP ${status} is not resent`); assert.equal(result.status, status);
  }
  seen = [];
  await assert.rejects(sendWithStreamUsage('https://plain-throw/v1', true, async usage => { seen.push(usage); throw new Error('上游模型请求失败'); }), /上游模型请求失败/);
  await assert.rejects(sendWithStreamUsage('https://plain-abort/v1', true, async usage => { seen.push(usage); throw Object.assign(new Error('stream_options'), { name: 'AbortError' }); }), /stream_options/);
  assert.deepEqual(seen, [true, true]);
  // 去掉字段后仍然失败：不记住这个地址，下次照常带上。
  seen = [];
  await sendWithStreamUsage('https://still-bad/v1', true, async usage => { seen.push(usage); return reply(400, 'unknown field stream_options'); });
  await sendWithStreamUsage('https://still-bad/v1', true, async usage => { seen.push(usage); return reply(200); });
  assert.deepEqual(seen, [true, false, true]);
});

test('through the ST proxy the field travels in the additional request body, and both copies of the helper agree', async () => {
  const plain = stProxyBody('https://host/v1', 'Bearer k', { model: 'm', stream: true });
  assert.equal(plain.custom_include_body, '');
  const body = stProxyBody('https://host/v1', 'Bearer k', { model: 'm', stream: true }, { streamUsage: true });
  assert.deepEqual(JSON.parse(body.custom_include_body), { stream_options: { include_usage: true } });
  assert.equal(body.stream_options, undefined, 'ST drops unknown top-level fields, so it is not sent there');
  assert.deepEqual(yimu.stProxyBody('https://host/v1', 'Bearer k', { model: 'm', stream: true }, { streamUsage: true }), body);
  const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const [qianmu, memory, external, proxy, settings] = await Promise.all(['qianmu-model-compat.js', 'yimu/model-compat.mjs', 'qianmu-model-external.js', 'qianmu-st-model-proxy.js', 'yimu/api-settings.mjs'].map(read));
  assert.equal(qianmu.replace(/\r/g, ''), memory.replace(/\r/g, ''), 'the two compat modules stay identical');
  assert.match(external, /sendWithStreamUsage\(root, stream, streamUsage => \{ const payload = JSON\.stringify\(streamUsage \? \{ \.\.\.body, stream_options: STREAM_USAGE_OPTIONS \} : body\);/);
  assert.match(proxy, /sendWithStreamUsage\(root, payload\?\.stream === true, streamUsage => sendWithAuthFallback\(/);
  assert.match(settings, /sendWithStreamUsage\(root, body\?\.stream === true, streamUsage => sendWithAuthFallback\(config\.apiKey, send\(streamUsage\)\)\)/);
});

test('the usage-only closing chunk of a stream is read without disturbing the text', () => {
  const stream = createModelResponseAccumulator();
  stream.consume({ choices: [{ delta: { content: '你好' } }] });
  stream.consume({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  stream.consume({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 800 } } });
  const done = stream.finish();
  assert.equal(done.text, '你好');
  assert.equal(modelCacheText(done.usage), '↓ 80%（800 / 1.0k）');
});
