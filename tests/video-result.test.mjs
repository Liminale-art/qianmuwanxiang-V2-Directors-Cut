import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QIANMU_VIDEO_RESULT_ENDPOINT,
  QIANMU_VIDEO_RESULT_MAX_BYTES,
  VideoResultError,
  createMiniMaxH3ResultArchiver,
  downloadMiniMaxH3VideoResult,
} from '../qianmu-video-result.js';

function storage(overrides = {}) {
  return {
    hasVideoMedia: async () => false,
    putVideoMedia: async () => ({}),
    ...overrides,
  };
}

const callback = (extra = {}) => ({
  idempotencyKey: 'qianmu-video-result-video-task-a-attempt-1',
  taskId: 'video-task-a',
  shotId: 'shot-a',
  owner: { chatKey: 'chat-a', floor: 6, messageId: 'message-a' },
  remoteTaskId: 'remote-a',
  downloadUrl: 'https://attacker.example/never-use-this.mp4',
  result: { durationSeconds: 6, resolution: '768P', ratio: '16:9' },
  ...extra,
});

test('an existing local result is reused without another network request', async () => {
  let fetches = 0;
  const archive = createMiniMaxH3ResultArchiver(storage({ hasVideoMedia: async () => true }), {
    apiKey: 'private-key',
    fetchImpl: async () => { fetches++; throw new Error('must not fetch'); },
  });
  const result = await archive(callback());
  assert.equal(result.reused, true);
  assert.match(result.assetId, /^video-asset-[a-f0-9]{16,32}$/);
  assert.equal(fetches, 0);
});

test('a completed result uses only the same-origin endpoint and stores credential-free metadata', async () => {
  let request;
  let written;
  const archive = createMiniMaxH3ResultArchiver(storage({
    putVideoMedia: async (assetId, blob, meta) => { written = { assetId, blob, meta }; return { assetId }; },
  }), {
    apiKey: 'private-key',
    connection: { region: 'global', baseUrl: 'https://attacker.example' },
    headers: { 'X-CSRF-Token': 'csrf', 'X-Api-Key': 'must-not-forward' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('video-bytes', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '11' } });
    },
  });
  const result = await archive(callback());
  assert.equal(request.url, QIANMU_VIDEO_RESULT_ENDPOINT);
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['X-Api-Key'], undefined);
  const body = JSON.parse(request.options.body);
  assert.equal(body.apiKey, 'private-key');
  assert.equal(body.taskId, 'remote-a');
  assert.deepEqual(body.connection, { region: 'global', connectionId: '' });
  assert.equal(written.blob.type, 'video/mp4');
  assert.equal(written.meta.chatKey, 'chat-a');
  assert.equal(written.meta.floor, 6);
  assert.equal(result.assetId, written.assetId);
  assert.doesNotMatch(JSON.stringify({ result, meta: written.meta }), /private-key|attacker\.example|downloadUrl/);
});

test('direct result downloads reject non-video and declared oversize responses', async () => {
  await assert.rejects(downloadMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    fetchImpl: async () => new Response('<html>bad</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  }), (error) => error instanceof VideoResultError && error.code === 'result_content_type_invalid');
  await assert.rejects(downloadMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    fetchImpl: async () => new Response('x', { status: 200, headers: {
      'content-type': 'video/mp4',
      'content-length': String(QIANMU_VIDEO_RESULT_MAX_BYTES + 1),
    } }),
  }), (error) => error instanceof VideoResultError && error.code === 'video_result_too_large');
});

test('gateway errors remain bounded and do not expose the submitted key', async () => {
  await assert.rejects(downloadMiniMaxH3VideoResult({ apiKey: 'private-key', taskId: 'remote-a' }, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, code: 'video_result_not_ready', message: '尚未完成' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
  }), (error) => error instanceof VideoResultError
    && error.code === 'video_result_not_ready'
    && !error.message.includes('private-key'));
});
