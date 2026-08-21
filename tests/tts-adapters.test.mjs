import assert from 'node:assert/strict';

import { synthesizeDoubao } from '../qianmu-tts-doubao.js';
import { synthesizeElevenLabs } from '../qianmu-tts-elevenlabs.js';

const originalFetch = globalThis.fetch;

try {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    const audio = Buffer.from('doubao-audio');
    const sse = `data: ${JSON.stringify({ code: 0, data: audio.toString('base64') })}\n\ndata: ${JSON.stringify({ code: 20000000 })}\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-tt-logid': 'db-log' } });
  };
  const doubao = await synthesizeDoubao({
    apiKey: 'doubao-key', text: '等一下<#0.4#>再走', voiceId: 'voice-db',
    proxyBase: 'https://tts-proxy.example',
    model: 'seed-tts-2.0', format: 'ogg_opus', sampleRate: 24000,
    speed: 1.2, vol: 1.1, pitch: 2, emotion: 'sad',
  });
  assert.equal(await doubao.blob.text(), 'doubao-audio');
  assert.equal(doubao.blob.type, 'audio/ogg');
  assert.equal(request.url, '/api/plugins/qianmu-tts/doubao/synthesize');
  const proxyRequest = JSON.parse(request.init.body);
  assert.equal(proxyRequest.apiKey, 'doubao-key');
  assert.equal(proxyRequest.resourceId, 'seed-tts-2.0');
  const doubaoBody = proxyRequest.request;
  assert.equal(doubaoBody.req_params.speaker, 'voice-db');
  assert.equal(doubaoBody.req_params.audio_params.speech_rate, 20);
  assert.equal(doubaoBody.req_params.audio_params.sample_rate, 24000);
  assert.equal(doubaoBody.req_params.text, '等一下，再走');
  assert.deepEqual(JSON.parse(doubaoBody.req_params.additions).context_texts, ['用悲伤克制的语气演绎']);

  globalThis.fetch = async (url, init) => {
    request = { url, init };
    const first = JSON.stringify({ code: 0, data: Buffer.from('leg').toString('base64') });
    const second = JSON.stringify({ code: 0, data: Buffer.from('acy').toString('base64') });
    return new Response(`${first}${second}`, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const legacy = await synthesizeDoubao({
    appId: 'app-id', accessKey: 'access-key',
    proxyBase: 'https://stale-proxy.example',
    endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
    text: '旧凭证', voiceId: 'voice', model: 'seed-tts-2.0',
  });
  assert.equal(await legacy.blob.text(), 'legacy', '应解析没有换行分隔的连续 Chunked JSON 帧');
  assert.equal(request.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', '1.9.0 的 /sse 默认值应自动迁移');
  assert.equal(request.init.headers['X-Api-App-Key'], 'app-id');
  assert.equal(request.init.headers['X-Api-Access-Key'], 'access-key');
  assert.ok(!Object.prototype.hasOwnProperty.call(request.init.headers, 'X-Api-App-Id'));

  const detectedResources = [];
  globalThis.fetch = async (_url, init) => {
    const outer = JSON.parse(init.body);
    detectedResources.push(outer.resourceId);
    if (outer.resourceId === 'seed-tts-2.0') {
      return new Response(JSON.stringify({ code: 55000000, message: 'resource ID is mismatched with speaker related resource' }), { status: 200 });
    }
    const chunk = JSON.stringify({ code: 0, data: Buffer.from('icl2-audio').toString('base64') });
    request = { outer };
    return new Response(chunk, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const autoDetected = await synthesizeDoubao({
    authMode: 'apiKey', apiKey: 'key', model: 'auto', defaultModel: 'seed-tts-2.0',
    text: '自动识别', voiceId: 'S_cloned', delivery: '悲伤地说',
  });
  assert.deepEqual(detectedResources, ['seed-tts-2.0', 'seed-icl-2.0']);
  assert.equal(autoDetected.resolvedModel, 'seed-icl-2.0');
  assert.equal(await autoDetected.blob.text(), 'icl2-audio');
  assert.equal(request.outer.request.req_params.model, 'seed-tts-2.0-expressive');
  assert.deepEqual(JSON.parse(request.outer.request.req_params.additions).context_texts, ['悲伤地说']);

  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    const chunk = JSON.stringify({ code: 0, data: Buffer.from('icl1-audio').toString('base64') });
    return new Response(chunk, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const icl1 = await synthesizeDoubao({
    authMode: 'apiKey', apiKey: 'key', model: 'seed-icl-1.0',
    text: '旧复刻', voiceId: 'S_old', delivery: '开心地说',
  });
  assert.equal(icl1.resolvedModel, 'seed-icl-1.0');
  assert.equal(request.resourceId, 'seed-icl-1.0');
  assert.equal(request.request.req_params.model, 'seed-tts-1.1');
  assert.ok(!JSON.parse(request.request.req_params.additions).context_texts, '复刻 1.0 不应收到高级演绎参数');

  let ordinaryErrorRequests = 0;
  globalThis.fetch = async () => {
    ordinaryErrorRequests++;
    return new Response(JSON.stringify({ code: 55000001, message: 'quota exhausted' }), { status: 200 });
  };
  await assert.rejects(
    () => synthesizeDoubao({ authMode: 'apiKey', apiKey: 'key', model: 'auto', text: '额度错误', voiceId: 'voice' }),
    /55000001/,
  );
  assert.equal(ordinaryErrorRequests, 1, '非资源不匹配错误不得触发模型轮询');

  globalThis.fetch = async () => new Response('Not Found', { status: 404 });
  await assert.rejects(
    () => synthesizeDoubao({ authMode: 'apiKey', apiKey: 'api-only', text: '本机中转', voiceId: 'voice', model: 'seed-tts-2.0' }),
    /未检测到千幕豆包服务端插件/,
  );

  globalThis.fetch = async (url, init) => {
    request = { url, init };
    const chunk = JSON.stringify({ code: 0, data: Buffer.from('legacy-wins').toString('base64') });
    return new Response(`${chunk}\n`, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await synthesizeDoubao({
    apiKey: 'stale-api-key', appId: 'app-id', accessKey: 'access-key',
    text: '旧凭证优先', voiceId: 'voice', model: 'seed-tts-2.0',
  });
  assert.equal(request.init.headers['X-Api-App-Key'], 'app-id');
  assert.ok(!Object.prototype.hasOwnProperty.call(request.init.headers, 'X-Api-Key'), '同时保存两套凭证时应优先可直连凭证');

  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(new Blob(['eleven-audio'], { type: 'audio/mpeg' }), {
      status: 200, headers: { 'content-type': 'audio/mpeg', 'request-id': 'el-log' },
    });
  };
  const eleven = await synthesizeElevenLabs({
    apiKey: 'eleven-key', text: '别<#0.2#>过来', voiceId: 'voice/el',
    model: 'eleven_v3', format: 'mp3_44100_128', speed: 1.1,
    stability: 0.4, similarityBoost: 0.9, style: 0.8, speakerBoost: true, emotion: 'angry',
  });
  assert.equal(await eleven.blob.text(), 'eleven-audio');
  assert.match(request.url, /\/text-to-speech\/voice%2Fel\?output_format=mp3_44100_128$/);
  assert.equal(request.init.headers['xi-api-key'], 'eleven-key');
  const elevenBody = JSON.parse(request.init.body);
  assert.equal(elevenBody.text, '[angry] 别…过来');
  assert.equal(elevenBody.model_id, 'eleven_v3');
  assert.ok(!Object.prototype.hasOwnProperty.call(elevenBody.voice_settings, 'speed'));
  assert.equal(elevenBody.voice_settings.stability, 0.4);
  assert.ok(!Object.prototype.hasOwnProperty.call(elevenBody.voice_settings, 'similarity_boost'));
  assert.ok(!Object.prototype.hasOwnProperty.call(elevenBody.voice_settings, 'style'));

  globalThis.fetch = async (_url, init) => {
    request = { init };
    return new Response(new Blob(['v2'], { type: 'audio/mpeg' }), { status: 200 });
  };
  await synthesizeElevenLabs({
    apiKey: 'key', text: '你好', voiceId: 'voice', model: 'eleven_multilingual_v2',
    similarityBoost: 0.8, style: 0.2, speakerBoost: false,
  });
  const v2Body = JSON.parse(request.init.body);
  assert.equal(v2Body.voice_settings.similarity_boost, 0.8);
  assert.equal(v2Body.voice_settings.style, 0.2);
  assert.equal(v2Body.voice_settings.use_speaker_boost, false);
  assert.equal(v2Body.voice_settings.speed, 1);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('TTS provider adapters OK');
