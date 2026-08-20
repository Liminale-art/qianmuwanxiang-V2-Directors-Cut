// 千幕 · 豆包语音 V3 SSE 适配器
// 官方接口：一次性输入文本，SSE 返回 base64 音频分片。

export const DOUBAO_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';

export const DOUBAO_MODELS = Object.freeze([
  { value: 'seed-tts-2.0', label: 'Seed TTS 2.0（推荐）' },
  { value: 'seed-tts-1.0', label: 'Seed TTS 1.0' },
  { value: 'seed-icl-2.0', label: '声音复刻 ICL 2.0' },
  { value: 'volc.service_type.10029', label: '大模型音色兼容资源' },
]);

export const DOUBAO_FORMATS = Object.freeze([
  { value: 'mp3', label: 'MP3' },
  { value: 'ogg_opus', label: 'OGG Opus' },
  { value: 'pcm', label: 'PCM' },
]);

export const DOUBAO_EMOTIONS = Object.freeze([
  { value: 'auto', label: '自动' },
  { value: 'happy', label: '开心' },
  { value: 'sad', label: '悲伤' },
  { value: 'angry', label: '生气' },
  { value: 'fearful', label: '害怕' },
  { value: 'surprised', label: '惊讶' },
  { value: 'calm', label: '平静' },
  { value: 'whisper', label: '低语' },
]);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function resolveUrl(endpoint, proxyBase) {
  const source = String(endpoint || DOUBAO_ENDPOINT).trim() || DOUBAO_ENDPOINT;
  const proxy = String(proxyBase || '').trim().replace(/\/+$/, '');
  if (!proxy) return source;
  if (/\/api\/v3\/tts\//i.test(proxy)) return proxy;
  try { return proxy + new URL(source).pathname; }
  catch (_) { return source; }
}

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `qm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function base64Bytes(value) {
  const raw = String(value || '');
  if (typeof atob === 'function') {
    const decoded = atob(raw);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(raw, 'base64'));
  throw new Error('当前环境不支持 base64 音频解码');
}

function mimeFor(format) {
  if (format === 'ogg_opus') return 'audio/ogg';
  if (format === 'pcm') return 'audio/basic';
  return 'audio/mpeg';
}

export function doubaoOutputExtension(format) {
  if (format === 'ogg_opus') return 'ogg';
  return format === 'pcm' ? 'pcm' : 'mp3';
}

function deliveryHint(params) {
  const custom = String(params.delivery || '').trim();
  if (custom) return custom;
  const hints = {
    happy: '用开心自然的语气演绎', sad: '用悲伤克制的语气演绎', angry: '用生气有力的语气演绎',
    fearful: '用紧张害怕的语气演绎', surprised: '用惊讶的语气演绎', calm: '用平静自然的语气演绎',
    whisper: '用轻声低语的方式演绎',
  };
  return hints[params.emotion] || '';
}

export async function synthesizeDoubao(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  const appId = String(opts.appId || '').trim();
  const accessKey = String(opts.accessKey || '').trim();
  if (!apiKey && !(appId && accessKey)) throw new Error('未配置豆包 API Key，或旧版 App ID + Access Key');
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('文本为空');
  const voiceId = String(opts.voiceId || '').trim();
  if (!voiceId) throw new Error('未指定豆包音色 ID');

  const model = DOUBAO_MODELS.some((item) => item.value === opts.model) ? opts.model : 'seed-tts-2.0';
  const format = DOUBAO_FORMATS.some((item) => item.value === opts.format) ? opts.format : 'mp3';
  const speed = clamp(opts.speed, 0.5, 2, 1);
  const volume = clamp(opts.vol, 0.5, 2, 1);
  const speechRate = Math.round((speed - 1) * 100);
  const loudnessRate = Math.round((volume - 1) * 100);
  const additions = {
    disable_markdown_filter: false,
    enable_latex_tn: false,
    post_process: { pitch: Math.round(clamp(opts.pitch, -12, 12, 0)) },
  };
  const hint = deliveryHint(opts);
  if (hint) additions.context_texts = [hint];

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': model,
    'X-Api-Request-Id': requestId(),
  };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  else {
    headers['X-Api-App-Id'] = appId;
    headers['X-Api-Access-Key'] = accessKey;
  }
  const body = {
    user: { uid: String(opts.uid || 'qianmu-tts') },
    req_params: {
      // MiniMax 历史提取结果可能含 <#秒#>，跨 Provider 时转成自然停顿，避免被豆包念出标记。
      text: text.replace(/<#\s*\d+(?:\.\d+)?\s*#>/g, '，'),
      speaker: voiceId,
      sample_rate: Number(opts.sampleRate) || 24000,
      audio_params: { format, speech_rate: speechRate, loudness_rate: loudnessRate, bit_rate: 128000 },
      additions: JSON.stringify(additions),
    },
  };

  let response;
  try {
    response = await fetch(resolveUrl(opts.endpoint, opts.proxyBase), { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(`豆包网络请求失败（可能是跨域或网络问题）：${error?.message || error}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`豆包 HTTP ${response.status}${detail ? `：${detail.slice(0, 180)}` : ''}`);
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (/^audio\//i.test(contentType)) {
    const blob = await response.blob();
    return { blob, mime: blob.type || mimeFor(format), extra: {}, traceId: response.headers?.get?.('x-tt-logid') || '' };
  }

  const raw = await response.text();
  const chunks = [];
  let errorMessage = '';
  for (const line of raw.split(/\r?\n/)) {
    const payload = line.trim().replace(/^data:\s*/i, '');
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      const code = Number(event.code ?? 0);
      if (code !== 0 && code !== 20000000) errorMessage = `错误码 ${code}${event.message ? `：${event.message}` : ''}`;
      if (event.data) chunks.push(base64Bytes(event.data));
    } catch (_) {}
  }
  if (!chunks.length) throw new Error(errorMessage || '豆包返回结果缺少音频数据');
  const mime = mimeFor(format);
  return { blob: new Blob(chunks, { type: mime }), mime, extra: {}, traceId: response.headers?.get?.('x-tt-logid') || '' };
}

export function doubaoCacheKey(opts = {}) {
  const parts = [
    opts.text, opts.voiceId, opts.model || 'seed-tts-2.0', opts.format || 'mp3',
    Number.isFinite(opts.speed) ? opts.speed : 1, Number.isFinite(opts.vol) ? opts.vol : 1,
    Number.isFinite(opts.pitch) ? opts.pitch : 0, opts.emotion || 'auto', opts.delivery || '',
    opts.sampleRate || 24000,
  ];
  return `tts:doubao:${djb2(parts.map((value) => String(value ?? '')).join('\u0001'))}`;
}

function djb2(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
