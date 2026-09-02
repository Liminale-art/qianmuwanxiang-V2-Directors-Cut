import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VideoGatewayError,
  MINIMAX_H3_RESULT_MAX_BYTES,
  cancelMiniMaxH3Video,
  createMiniMaxH3Video,
  openMiniMaxH3VideoResult,
  queryMiniMaxH3Video,
  sanitizeMiniMaxH3GatewayCreate,
  sanitizeMiniMaxH3MediaInputs,
  videoGatewayErrorPayload,
} from '../qianmu-video-gateway.js';

const baseInput = (extra = {}) => ({
  apiKey: 'private-api-key',
  idempotencyKey: 'qianmu-video-attempt-a',
  spec: { shotId: 'shot-a', summary: 'A curtain moves in a quiet room.', durationSeconds: 6, resolution: '768p' },
  manifest: { shotId: 'shot-a', assets: [] },
  prompt: 'A curtain moves in a quiet room.',
  ...extra,
});

test('the same-origin gateway injects the key only into the upstream request', async () => {
  const cache = new Map();
  let calls = 0;
  let captured;
  const fetchImpl = async (url, init) => {
    calls += 1;
    captured = { url, init };
    return new Response(JSON.stringify({ task_id: 'remote-a' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const first = await createMiniMaxH3Video(baseInput(), { fetchImpl, submissionCache: cache, now: 1000 });
  assert.equal(first.remoteTaskId, 'remote-a');
  assert.equal(first.reused, false);
  assert.equal(captured.url, 'https://api.minimax.io/v2/video_generation');
  assert.equal(captured.init.headers.Authorization, 'Bearer private-api-key');
  assert.equal(JSON.parse(captured.init.body).model, 'MiniMax-H3');
  assert.doesNotMatch(JSON.stringify(first), /private-api-key|Authorization|prompt/);

  const repeated = await createMiniMaxH3Video(baseInput(), { fetchImpl, submissionCache: cache, now: 1100 });
  assert.equal(repeated.reused, true);
  assert.equal(calls, 1);
});

test('one idempotency key cannot be reused for different video content', async () => {
  const cache = new Map();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ task_id: 'remote-a' }), { status: 200 });
  };
  await createMiniMaxH3Video(baseInput(), { fetchImpl, submissionCache: cache, now: 1000 });
  await assert.rejects(
    createMiniMaxH3Video(baseInput({ prompt: 'Different content.' }), { fetchImpl, submissionCache: cache, now: 1100 }),
    (error) => error.code === 'idempotency_payload_mismatch' && error.status === 409,
  );
  assert.equal(calls, 1);
});

test('an ambiguous network result is cached and never auto-resubmitted', async () => {
  const cache = new Map();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('connection closed');
  };
  await assert.rejects(
    createMiniMaxH3Video(baseInput(), { fetchImpl, submissionCache: cache, now: 1000 }),
    (error) => error.code === 'submission_outcome_unknown' && error.retryable === false,
  );
  await assert.rejects(
    createMiniMaxH3Video(baseInput(), { fetchImpl, submissionCache: cache, now: 1100 }),
    (error) => error.code === 'submission_outcome_unknown',
  );
  assert.equal(calls, 1);
});

test('gallery images may cross the gateway as validated transient data without entering results', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const input = baseInput({
    spec: { shotId: 'image-shot', summary: 'The portrait blinks.', requestedMode: 'i2va' },
    manifest: {
      shotId: 'image-shot',
      assets: [{ assetId: 'frame-a', kind: 'image', roles: ['first_frame'], locator: { kind: 'gallery', ref: 'chat-a␟record-a' } }],
    },
    mediaInputs: [{ assetId: 'frame-a', mime: 'image/png', data: png.toString('base64') }],
  });
  let upstreamBody;
  const result = await createMiniMaxH3Video(input, {
    submissionCache: new Map(),
    now: 1000,
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ task_id: 'remote-image' }), { status: 200 });
    },
  });
  assert.match(upstreamBody.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(upstreamBody.content[1].role, 'first_frame');
  assert.doesNotMatch(JSON.stringify(result), /data:image|iVBOR|private-api-key/);
});

test('inline image validation rejects spoofed, duplicate and insecure media', () => {
  const fake = Buffer.from('not-a-real-png').toString('base64');
  assert.throws(() => sanitizeMiniMaxH3MediaInputs([{ assetId: 'a', mime: 'image/png', data: fake }]), (error) => error.code === 'invalid_inline_image');
  assert.throws(() => sanitizeMiniMaxH3MediaInputs([
    { assetId: 'a', url: 'https://media.example/a.png' },
    { assetId: 'a', url: 'https://media.example/b.png' },
  ]), (error) => error.code === 'media_asset_duplicate');
  assert.throws(() => sanitizeMiniMaxH3MediaInputs([{ assetId: 'a', url: 'http://127.0.0.1/private.png' }]), (error) => error.code === 'media_url_invalid');
  assert.throws(() => sanitizeMiniMaxH3MediaInputs(Array.from({ length: 13 }, (_, index) => ({
    assetId: `asset-${index}`,
    url: `https://media.example/${index}.png`,
  }))), (error) => error.code === 'media_assets_exceeded');
  assert.throws(() => sanitizeMiniMaxH3MediaInputs([{
    assetId: 'bad-base64',
    mime: 'image/png',
    data: 'iVBORw0KGgo===',
  }]), (error) => error.code === 'invalid_inline_image');
});

test('credential and idempotency identifiers are rejected instead of silently truncated', () => {
  assert.throws(
    () => sanitizeMiniMaxH3GatewayCreate(baseInput({ apiKey: 'k'.repeat(4097) })),
    (error) => error.code === 'invalid_api_key',
  );
  assert.throws(
    () => sanitizeMiniMaxH3GatewayCreate(baseInput({ idempotencyKey: 'i'.repeat(301) })),
    (error) => error.code === 'idempotency_key_invalid',
  );
});

test('a saturated pending cache blocks only new submissions and keeps in-flight deduplication intact', async () => {
  const cache = new Map();
  const never = new Promise(() => {});
  for (let index = 0; index < 200; index += 1) {
    cache.set(`occupied-${index}`, {
      state: 'pending',
      payloadFingerprint: `fingerprint-${index}`,
      expiresAt: 0,
      promise: never,
    });
  }
  await assert.rejects(
    createMiniMaxH3Video(baseInput(), { submissionCache: cache, now: 1000 }),
    (error) => error.code === 'submission_cache_busy' && error.retryable === true,
  );
  assert.equal(cache.size, 200);

  const dedupeCache = new Map();
  let calls = 0;
  let resolveFetch;
  const fetchImpl = () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };
  const first = createMiniMaxH3Video(baseInput(), { submissionCache: dedupeCache, fetchImpl, now: 1000 });
  for (let index = 0; index < 199; index += 1) {
    dedupeCache.set(`occupied-${index}`, {
      state: 'pending', payloadFingerprint: `fingerprint-${index}`, expiresAt: 0, promise: never,
    });
  }
  const repeated = createMiniMaxH3Video(baseInput(), { submissionCache: dedupeCache, fetchImpl, now: 1100 });
  resolveFetch(new Response(JSON.stringify({ task_id: 'remote-deduped' }), { status: 200 }));
  const [firstResult, repeatedResult] = await Promise.all([first, repeated]);
  assert.equal(firstResult.reused, false);
  assert.equal(repeatedResult.reused, true);
  assert.equal(calls, 1);
});

test('query maps remote completion while the gateway response stays credential-free', async () => {
  let captured;
  const result = await queryMiniMaxH3Video({ apiKey: 'private-api-key', taskId: 'remote/a', connection: { region: 'cn' } }, {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ task: {
        id: 'remote/a', status: 'succeeded', content: { url: 'https://media.example/result.mp4' },
        resolution: '768P', duration: 6, ratio: '16:9', task_type: 'generation', modality: 'video',
      } }), { status: 200 });
    },
  });
  assert.equal(captured.url, 'https://api.minimaxi.com/v2/query/video_generation/remote%2Fa');
  assert.equal(captured.init.headers.Authorization, 'Bearer private-api-key');
  assert.equal(result.state, 'succeeded');
  assert.equal(result.result.downloadUrl, 'https://media.example/result.mp4');
  assert.doesNotMatch(JSON.stringify(result), /private-api-key/);
});

test('running tasks never call the destructive endpoint while queued tasks may cancel', async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    assert.equal(init.method, 'DELETE');
    return new Response(JSON.stringify({ task_id: 'remote-a', action: 'cancelled', status: 'cancelled' }), { status: 200 });
  };
  await assert.rejects(
    cancelMiniMaxH3Video({ apiKey: 'key', taskId: 'remote-a', providerStatus: 'running' }, { fetchImpl }),
    (error) => error.code === 'running_task_cannot_cancel' && error.status === 409,
  );
  assert.equal(calls, 0);
  const cancelled = await cancelMiniMaxH3Video({ apiKey: 'key', taskId: 'remote-a', providerStatus: 'queued' }, { fetchImpl });
  assert.equal(cancelled.ok, true);
  assert.equal(calls, 1);
});

test('upstream errors return bounded public diagnostics without exposing credentials', async () => {
  await assert.rejects(
    queryMiniMaxH3Video({ apiKey: 'private-api-key', taskId: 'remote-a' }, {
      fetchImpl: async () => new Response(JSON.stringify({
        type: 'error', error: { type: 'rate_limit_error', message: 'retry later', http_code: 429 }, request_id: 'request-a',
      }), { status: 429 }),
    }),
    (error) => {
      const payload = videoGatewayErrorPayload(error);
      assert.equal(payload.status, 429);
      assert.equal(payload.body.code, 'rate_limited');
      assert.equal(payload.body.retryable, true);
      assert.equal(payload.body.requestId, 'request-a');
      assert.doesNotMatch(JSON.stringify(payload), /private-api-key/);
      return true;
    },
  );
  const fallback = videoGatewayErrorPayload(new VideoGatewayError(500, 'test_error', 'safe'));
  assert.deepEqual(fallback.body, { ok: false, code: 'test_error', message: 'safe', retryable: false });
});

test('completed media is re-queried from MiniMax and downloaded without forwarding its API key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ task: {
        id: 'remote-a', status: 'succeeded', content: { url: 'https://cdn.minimax.example/result.mp4' },
        resolution: '768P', duration: 6,
      } }), { status: 200 });
    }
    return new Response(Buffer.from('small-video'), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '11' },
    });
  };
  const opened = await openMiniMaxH3VideoResult({ apiKey: 'private-api-key', taskId: 'remote-a' }, {
    fetchImpl,
    resolveHost: async () => [{ address: '93.184.216.34' }],
  });
  assert.match(calls[0].url, /\/v2\/query\/video_generation\/remote-a$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-api-key');
  assert.equal(calls[1].url, 'https://cdn.minimax.example/result.mp4');
  assert.equal(Object.hasOwn(calls[1].init.headers, 'Authorization'), false);
  assert.equal(opened.contentType, 'video/mp4');
  assert.equal(opened.contentLength, 11);
  assert.equal(opened.maxBytes, MINIMAX_H3_RESULT_MAX_BYTES);
  assert.match(opened.fileName, /^qianmu-h3-[a-f0-9]{16}\.mp4$/);
  assert.equal(Buffer.from(await opened.response.arrayBuffer()).toString(), 'small-video');
});

test('result download rejects unfinished tasks, literal hosts, non-video content and oversized files', async () => {
  let mediaCalls = 0;
  await assert.rejects(openMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    fetchImpl: async () => new Response(JSON.stringify({ task: { id: 'remote-a', status: 'running' } }), { status: 200 }),
  }), (error) => error.code === 'video_result_not_ready' && error.retryable === true);

  await assert.rejects(openMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    fetchImpl: async () => {
      mediaCalls += 1;
      return new Response(JSON.stringify({ task: { id: 'remote-a', status: 'succeeded', content: { url: 'https://127.0.0.1/private.mp4' } } }), { status: 200 });
    },
  }), (error) => error.code === 'result_url_unsafe');
  assert.equal(mediaCalls, 1, 'unsafe provider URLs are rejected before a second fetch');

  let calls = 0;
  await assert.rejects(openMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    resolveHost: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ task: { id: 'remote-a', status: 'succeeded', content: { url: 'https://cdn.example/result' } } }), { status: 200 })
        : new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    },
  }), (error) => error.code === 'result_content_type_invalid');

  calls = 0;
  await assert.rejects(openMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    resolveHost: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ task: { id: 'remote-a', status: 'succeeded', content: { url: 'https://cdn.example/result.mp4' } } }), { status: 200 })
        : new Response('x', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MINIMAX_H3_RESULT_MAX_BYTES + 1) } });
    },
  }), (error) => error.code === 'video_result_too_large' && error.status === 413);

  calls = 0;
  await assert.rejects(openMiniMaxH3VideoResult({ apiKey: 'key', taskId: 'remote-a' }, {
    resolveHost: async () => [{ address: '10.0.0.8' }],
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ task: { id: 'remote-a', status: 'succeeded', content: { url: 'https://cdn.example/result.mp4' } } }), { status: 200 });
    },
  }), (error) => error.code === 'result_url_unsafe');
  assert.equal(calls, 1, 'private DNS results are rejected before downloading media');
});

test('gateway input normalization returns only bounded execution fields', () => {
  const sanitized = sanitizeMiniMaxH3GatewayCreate(baseInput());
  assert.equal(sanitized.connection.transport, 'same_origin_gateway');
  assert.equal(sanitized.request.auth.source, 'runtime_api_key');
  assert.equal(Object.hasOwn(sanitized, 'spec'), false);
  assert.equal(Object.hasOwn(sanitized, 'manifest'), false);
});
