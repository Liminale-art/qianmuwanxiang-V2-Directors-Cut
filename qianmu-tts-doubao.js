// 千幕 · 豆包语音 V3 适配器
// 使用官方 HTTP Chunked unidirectional 端点，并与 Siren-Voice 的浏览器直连实现保持一致。

export const DOUBAO_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const QIANMU_DOUBAO_PROXY_ENDPOINT = '/api/plugins/qianmu-tts/doubao/synthesize';
export const DOUBAO_AUTO_MODEL = 'auto';

export const DOUBAO_MODELS = Object.freeze([
  { value: 'seed-tts-2.0', label: '官方合成 2.0' },
  { value: 'seed-icl-2.0', label: '声音复刻 2.0' },
  { value: 'seed-icl-1.0', label: '声音复刻 1.0' },
]);

const DOUBAO_MODEL_VALUES = new Set(DOUBAO_MODELS.map((item) => item.value));

export function normalizeDoubaoModel(value, allowAuto = false) {
  const model = String(value || '').trim();
  if (allowAuto && model === DOUBAO_AUTO_MODEL) return DOUBAO_AUTO_MODEL;
  return DOUBAO_MODEL_VALUES.has(model) ? model : 'seed-tts-2.0';
}

export function isDoubaoResourceMismatch(error) {
  const message = String(error?.message || error || '');
  return /55000000|resource\s*id.*mismatch|资源.*不匹配/i.test(message);
}

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
  // 1.9.0 曾保存 /sse 为默认值；自动收敛到可直连的 chunked JSON 端点，无需用户重填。
  const source = (String(endpoint || DOUBAO_ENDPOINT).trim() || DOUBAO_ENDPOINT)
    .replace(/\/unidirectional\/sse\/?$/i, '/unidirectional');
  const proxy = String(proxyBase || '').trim().replace(/\/+$/, '');
  if (!proxy) return source;
  if (/\/api\/v3\/tts\//i.test(proxy)) return proxy;
  try { return proxy + new URL(source).pathname; }
  catch (_) { return source; }
}

function stRequestHeaders() {
  const context = globalThis.SillyTavern?.getContext?.() || {};
  const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
  const csrf = typeof document !== 'undefined'
    ? document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || globalThis.token || ''
    : '';
  return { ...headers, 'Content-Type': 'application/json', ...(csrf && !headers['X-CSRF-Token'] ? { 'X-CSRF-Token': csrf } : {}) };
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

// HTTP Chunked 可能返回换行 JSON，也可能在代理/缓冲后变成 }{ 连续 JSON；同时兼容旧 /sse 的 data: 前缀。
function parseJsonFrames(raw) {
  const source = String(raw || '');
  const frames = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { frames.push(JSON.parse(source.slice(start, i + 1))); } catch (_) {}
      start = -1;
    }
  }
  return frames;
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

async function synthesizeDoubaoResource(opts, credentials, model) {
  const { apiKey, appId, accessKey, useLegacyCredentials } = credentials;
  const text = String(opts.text || '').trim();
  const voiceId = String(opts.voiceId || '').trim();
  const format = DOUBAO_FORMATS.some((item) => item.value === opts.format) ? opts.format : 'mp3';
  const speed = clamp(opts.speed, 0.5, 2, 1);
  const volume = clamp(opts.vol, 0.5, 2, 1);
  const speechRate = Math.round((speed - 1) * 100);
  const loudnessRate = Math.round((volume - 1) * 100);
  const additions = model === 'seed-icl-1.0' ? {} : {
    disable_markdown_filter: false,
    enable_latex_tn: false,
  };
  if (model === 'seed-tts-2.0') additions.post_process = { pitch: Math.round(clamp(opts.pitch, -12, 12, 0)) };
  const hint = deliveryHint(opts);
  // 合成 2.0 与复刻 2.0 均支持自然语言上下文演绎；复刻 1.0 保持纯文本，避免传入不支持的控制项。
  if (hint && model !== 'seed-icl-1.0') additions.context_texts = [hint];

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': model,
  };
  if (useLegacyCredentials) {
    // 旧版火山凭证的正确头名是 App-Key，不是 App-Id（对齐 Siren-Voice 已验证实现）。
    headers['X-Api-App-Key'] = appId;
    headers['X-Api-Access-Key'] = accessKey;
  }
  const body = {
    user: { uid: String(opts.uid || 'qianmu-tts') },
    req_params: {
      // MiniMax 历史提取结果可能含 <#秒#>，跨 Provider 时转成自然停顿，避免被豆包念出标记。
      text: text.replace(/<#\s*\d+(?:\.\d+)?\s*#>/g, '，'),
      speaker: voiceId,
      sample_rate: Number(opts.sampleRate) || 24000,
      audio_params: { format, sample_rate: Number(opts.sampleRate) || 24000, speech_rate: speechRate, loudness_rate: loudnessRate, bit_rate: 128000 },
      additions: JSON.stringify(additions),
    },
  };
  if (model === 'seed-icl-2.0') body.req_params.model = 'seed-tts-2.0-expressive';
  if (model === 'seed-icl-1.0') body.req_params.model = 'seed-tts-1.1';

  let response;
  const useInternalProxy = !useLegacyCredentials;
  try {
    response = useInternalProxy
      ? await fetch(QIANMU_DOUBAO_PROXY_ENDPOINT, {
        method: 'POST', headers: stRequestHeaders(), body: JSON.stringify({ apiKey, resourceId: model, request: body }),
      })
      : await fetch(resolveUrl(opts.endpoint, ''), { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (error) {
    const prefix = useInternalProxy ? '千幕豆包服务端插件请求失败' : '豆包网络请求失败（可能是跨域或网络问题）';
    throw new Error(`${prefix}：${error?.message || error}`);
  }
  if (useInternalProxy && response.status === 404) {
    throw new Error('未检测到千幕豆包服务端插件，请按 INSTALL-DOUBAO-APIKEY.md 完成安装并重启 SillyTavern');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`豆包 HTTP ${response.status}${detail ? `：${detail.slice(0, 180)}` : ''}`);
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (/^audio\//i.test(contentType)) {
    const blob = await response.blob();
    return { blob, mime: blob.type || mimeFor(format), extra: {}, traceId: response.headers?.get?.('x-tt-logid') || '', resolvedModel: model };
  }

  const raw = await response.text();
  const chunks = [];
  let errorMessage = '';
  for (const event of parseJsonFrames(raw)) {
    const code = Number(event.code ?? 0);
    if (code !== 0 && code !== 20000000) errorMessage = `错误码 ${code}${event.message ? `：${event.message}` : ''}`;
    if (event.data) chunks.push(base64Bytes(event.data));
  }
  if (!chunks.length) throw new Error(errorMessage || '豆包返回结果缺少音频数据');
  const mime = mimeFor(format);
  return { blob: new Blob(chunks, { type: mime }), mime, extra: {}, traceId: response.headers?.get?.('x-tt-logid') || '', resolvedModel: model };
}

export async function synthesizeDoubao(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  const appId = String(opts.appId || '').trim();
  const accessKey = String(opts.accessKey || '').trim();
  const authMode = opts.authMode === 'apiKey' || opts.authMode === 'legacy'
    ? opts.authMode
    : (appId && accessKey ? 'legacy' : 'apiKey');
  const useLegacyCredentials = authMode === 'legacy';
  if (useLegacyCredentials && !(appId && accessKey)) throw new Error('未配置豆包 App ID + Access Key');
  if (!useLegacyCredentials && !apiKey) throw new Error('未配置豆包 API Key');
  if (!String(opts.text || '').trim()) throw new Error('文本为空');
  if (!String(opts.voiceId || '').trim()) throw new Error('未指定豆包音色 ID');

  const requestedModel = String(opts.model || '').trim() === DOUBAO_AUTO_MODEL
    ? DOUBAO_AUTO_MODEL
    : normalizeDoubaoModel(opts.model);
  const defaultModel = normalizeDoubaoModel(opts.defaultModel);
  const candidates = requestedModel === DOUBAO_AUTO_MODEL
    ? [defaultModel, ...DOUBAO_MODELS.map((item) => item.value).filter((value) => value !== defaultModel)]
    : [requestedModel];
  const credentials = { apiKey, appId, accessKey, useLegacyCredentials };
  let lastMismatch = null;
  for (const model of candidates) {
    try {
      return await synthesizeDoubaoResource(opts, credentials, model);
    } catch (error) {
      if (requestedModel !== DOUBAO_AUTO_MODEL || !isDoubaoResourceMismatch(error)) throw error;
      lastMismatch = error;
    }
  }
  throw new Error(`无法自动识别该音色所属资源，请在音色编辑中手动选择类型${lastMismatch ? `：${lastMismatch.message}` : ''}`);
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
