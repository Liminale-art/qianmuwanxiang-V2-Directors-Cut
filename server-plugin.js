// 千幕 · SillyTavern Server Plugin
// 为豆包 TTS 与分镜生图提供同源请求边界，密钥只在单次上游请求中使用。
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  IMAGE_GATEWAY_PROVIDERS,
  checkImageConnection,
  generateImage,
  imageGatewayErrorPayload,
  listImageModels,
} from './qianmu-image-gateway.js';

const DOUBAO_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const MAX_TEXT_LENGTH = 10000;
const MAX_ADDITIONS_LENGTH = 20000;
const REQUEST_TIMEOUT_MS = 90000;
const ALLOWED_FORMATS = new Set(['mp3', 'ogg_opus', 'pcm']);
const ALLOWED_SAMPLE_RATES = new Set([16000, 24000, 32000, 48000]);
const ALLOWED_RESOURCE_IDS = new Set(['seed-tts-2.0', 'seed-icl-2.0', 'seed-icl-1.0']);
const ALLOWED_INFERENCE_MODELS = new Set(['seed-tts-2.0-expressive', 'seed-tts-1.1']);

async function pluginVersion() {
  try {
    const module = await import('./package.json', { with: { type: 'json' } });
    return String(module.default?.version || 'unknown');
  } catch (_) { return 'unknown'; }
}

export const info = Object.freeze({
  id: 'qianmu-tts',
  name: '千幕同源服务',
  description: '为千幕提供豆包语音与分镜图像供应商的同源网关。',
});

function asString(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sanitizeRequest(input) {
  const request = input && typeof input === 'object' ? input : {};
  const reqParams = request.req_params && typeof request.req_params === 'object' ? request.req_params : {};
  const text = asString(reqParams.text, MAX_TEXT_LENGTH);
  const speaker = asString(reqParams.speaker, 240);
  if (!text) throw new Error('文本为空');
  if (!speaker) throw new Error('未指定豆包音色 ID');

  const audio = reqParams.audio_params && typeof reqParams.audio_params === 'object' ? reqParams.audio_params : {};
  const format = ALLOWED_FORMATS.has(audio.format) ? audio.format : 'mp3';
  const sampleRate = ALLOWED_SAMPLE_RATES.has(Number(audio.sample_rate)) ? Number(audio.sample_rate) : 24000;
  const additions = asString(reqParams.additions, MAX_ADDITIONS_LENGTH);
  if (additions) {
    try { JSON.parse(additions); }
    catch (_) { throw new Error('豆包 additions 不是有效 JSON'); }
  }
  const inferenceModel = asString(reqParams.model, 80);
  if (inferenceModel && !ALLOWED_INFERENCE_MODELS.has(inferenceModel)) throw new Error('豆包推理模型不在允许列表');

  return {
    user: { uid: asString(request.user?.uid, 120) || 'qianmu-tts' },
    req_params: {
      text,
      speaker,
      audio_params: {
        format,
        sample_rate: sampleRate,
        speech_rate: Math.round(clampNumber(audio.speech_rate, -50, 100, 0)),
        loudness_rate: Math.round(clampNumber(audio.loudness_rate, -50, 100, 0)),
        bit_rate: Math.round(clampNumber(audio.bit_rate, 32000, 256000, 128000)),
      },
      ...(additions ? { additions } : {}),
      ...(inferenceModel ? { model: inferenceModel } : {}),
    },
  };
}

export async function init(router) {
  router.get('/health', async (_req, res) => res.json({
    ok: true,
    plugin: info.id,
    version: await pluginVersion(),
    services: ['doubao-tts', 'storyboard-image'],
  }));

  router.get('/image/capabilities', (_req, res) => res.json({
    ok: true,
    version: 2,
    modelListing: true,
    providers: Object.values(IMAGE_GATEWAY_PROVIDERS).map(({ id, label, protocol, requiresKey }) => ({ id, label, protocol, requiresKey, modelListing: true })),
  }));

  const prepareImageResponse = (res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    return res;
  };

  router.post('/image/check', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await checkImageConnection(req.body));
    } catch (error) {
      const result = imageGatewayErrorPayload(error);
      console.warn('[千幕分镜网关] 连接检查失败', result.body.code);
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/image/models', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await listImageModels(req.body));
    } catch (error) {
      const result = imageGatewayErrorPayload(error);
      console.warn('[千幕分镜网关] 模型列表读取失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/image/generate', async (req, res) => {
    prepareImageResponse(res);
    try {
      return res.json(await generateImage(req.body));
    } catch (error) {
      const result = imageGatewayErrorPayload(error);
      console.warn('[千幕分镜网关] 生成失败', result.body.code, result.body.upstreamStatus || '');
      return res.status(result.status).json(result.body);
    }
  });

  router.post('/doubao/synthesize', async (req, res) => {
    const apiKey = asString(req.body?.apiKey, 512);
    if (!apiKey) return res.status(400).send('缺少豆包 API Key');
    const resourceId = asString(req.body?.resourceId, 80) || 'seed-tts-2.0';
    if (!ALLOWED_RESOURCE_IDS.has(resourceId)) return res.status(400).send('豆包资源 ID 不在允许列表');

    let request;
    try { request = sanitizeRequest(req.body?.request); }
    catch (error) { return res.status(400).send(error?.message || '请求参数无效'); }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const upstream = await fetch(DOUBAO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': randomUUID(),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const data = Buffer.from(await upstream.arrayBuffer());
      const logId = upstream.headers.get('x-tt-logid') || '';
      if (logId) res.set('X-Tt-Logid', logId);
      res.set('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status).send(data);
    } catch (error) {
      const message = error?.name === 'AbortError' ? '豆包请求超时' : `豆包网络请求失败：${error?.message || error}`;
      console.warn('[千幕豆包语音中转]', message);
      return res.status(502).send(message);
    } finally {
      clearTimeout(timer);
    }
  });
}
