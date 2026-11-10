import test from 'node:test';
import assert from 'node:assert/strict';
import { callExternalModel } from '../qianmu-model-external.js';

const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const deps = { settings: { temperature: 0.5 }, createQianmuChatCompletionResponseFormat: () => null };

async function call(apiUrl, replies = [reply()], apiKey = 'k-1234') {
  const calls = [];
  const text = await callExternalModel([], null, { apiUrl, apiKey, model: 'm' }, new AbortController(), deps, async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return replies.shift();
  });
  return { text, calls };
}

test('storyboard direct calls keep vendor paths instead of forcing /v1', async () => {
  const cases = [
    ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'],
    ['https://open.bigmodel.cn/api/paas/v4/', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://relay.example/v1/chat/completions', 'https://relay.example/v1/chat/completions'],
    ['https://relay.example/custom/path#', 'https://relay.example/custom/path/chat/completions'],
  ];
  for (const [input, expected] of cases) assert.equal((await call(input)).calls[0].url, expected, input);
});

test('storyboard direct calls retry a rejected Bearer key once with the bare key', async () => {
  const { text, calls } = await call('https://relay.example/v1', [new Response('no', { status: 401 }), reply()], 'raw-key-9');
  assert.equal(text, 'ok');
  assert.deepEqual(calls.map(item => item.auth), ['Bearer raw-key-9', 'raw-key-9']);
});

test('missing settings still fail before any request', async () => {
  await assert.rejects(callExternalModel([], null, { apiUrl: '', apiKey: 'k', model: 'm' }, null, deps, async () => { throw new Error('sent'); }), /INVALID_API_SETTINGS/);
});
