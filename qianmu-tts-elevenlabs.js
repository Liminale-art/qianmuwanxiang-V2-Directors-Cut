// 千幕 · ElevenLabs TTS 适配器

export const ELEVENLABS_ENDPOINT = 'https://api.elevenlabs.io/v1';

export const ELEVENLABS_MODELS = Object.freeze([
  { value: 'eleven_v3', label: 'Eleven v3（表现力）' },
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2（长文本稳定）' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5（低延迟）' },
]);

export const ELEVENLABS_FORMATS = Object.freeze([
  { value: 'mp3_44100_128', label: 'MP3 44.1kHz / 128kbps' },
  { value: 'mp3_22050_32', label: 'MP3 22.05kHz / 32kbps' },
  { value: 'opus_48000_64', label: 'Opus 48kHz / 64kbps' },
  { value: 'pcm_24000', label: 'PCM 24kHz' },
]);

const V3_EMOTIONS = Object.freeze([
  { value: 'auto', label: '自动' }, { value: 'happy', label: '开心' }, { value: 'sad', label: '悲伤' },
  { value: 'angry', label: '生气' }, { value: 'fearful', label: '害怕' }, { value: 'surprised', label: '惊讶' },
  { value: 'calm', label: '平静' }, { value: 'whisper', label: '低语' },
]);

export function elevenLabsEmotionOptions(config = {}) {
  return config.model === 'eleven_v3' ? V3_EMOTIONS : [{ value: 'auto', label: '自动（由文本语境判断）' }];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function resolveBase(endpoint, proxyBase) {
  const proxy = String(proxyBase || '').trim().replace(/\/+$/, '');
  return proxy || String(endpoint || ELEVENLABS_ENDPOINT).trim().replace(/\/+$/, '') || ELEVENLABS_ENDPOINT;
}

function v3Text(text, emotion) {
  const tags = {
    happy: '[happy]', sad: '[sad]', angry: '[angry]', fearful: '[fearful]', surprised: '[surprised]',
    calm: '[calm]', whisper: '[whispers]',
  };
  const clean = String(text || '').replace(/<#\s*\d+(?:\.\d+)?\s*#>/g, '…');
  return tags[emotion] ? `${tags[emotion]} ${clean}` : clean;
}

function mimeFor(format) {
  if (String(format).startsWith('opus_')) return 'audio/ogg';
  if (String(format).startsWith('pcm_')) return 'audio/basic';
  return 'audio/mpeg';
}

export function elevenLabsOutputExtension(format) {
  if (String(format).startsWith('opus_')) return 'ogg';
  if (String(format).startsWith('pcm_')) return 'pcm';
  return 'mp3';
}

export async function synthesizeElevenLabs(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('未配置 ElevenLabs API Key');
  const voiceId = String(opts.voiceId || '').trim();
  if (!voiceId) throw new Error('未指定 ElevenLabs Voice ID');
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('文本为空');
  const model = ELEVENLABS_MODELS.some((item) => item.value === opts.model) ? opts.model : 'eleven_multilingual_v2';
  const format = ELEVENLABS_FORMATS.some((item) => item.value === opts.format) ? opts.format : 'mp3_44100_128';
  const voiceSettings = {
    stability: clamp(opts.stability, 0, 1, 0.5),
  };
  if (model !== 'eleven_v3') {
    voiceSettings.speed = clamp(opts.speed, 0.7, 1.2, 1);
    voiceSettings.similarity_boost = clamp(opts.similarityBoost, 0, 1, 0.75);
    voiceSettings.style = clamp(opts.style, 0, 1, 0);
    voiceSettings.use_speaker_boost = opts.speakerBoost !== false;
  }
  const body = {
    text: model === 'eleven_v3' ? v3Text(text, opts.emotion) : v3Text(text, 'auto'),
    model_id: model,
    voice_settings: voiceSettings,
  };
  const languageCode = String(opts.languageCode || '').trim();
  if (languageCode && model !== 'eleven_multilingual_v2') body.language_code = languageCode;
  if (opts.applyTextNormalization) body.apply_text_normalization = opts.applyTextNormalization;

  const url = `${resolveBase(opts.endpoint, opts.proxyBase)}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, Accept: mimeFor(format) },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`ElevenLabs 网络请求失败（可能是跨域或网络问题）：${error?.message || error}`);
  }
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data?.detail?.message || data?.detail || data?.message || '';
    } catch (_) { detail = await response.text().catch(() => ''); }
    throw new Error(`ElevenLabs HTTP ${response.status}${detail ? `：${String(detail).slice(0, 180)}` : ''}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('ElevenLabs 返回空音频');
  return { blob, mime: blob.type || mimeFor(format), extra: {}, traceId: response.headers?.get?.('request-id') || '' };
}

export function elevenLabsCacheKey(opts = {}) {
  const parts = [
    opts.text, opts.voiceId, opts.model || 'eleven_multilingual_v2', opts.format || 'mp3_44100_128',
    opts.model === 'eleven_v3' ? '' : (Number.isFinite(opts.speed) ? opts.speed : 1), opts.emotion || 'auto', opts.delivery || '',
    opts.stability ?? 0.5, opts.similarityBoost ?? 0.75, opts.style ?? 0, opts.speakerBoost !== false,
    opts.languageCode || '', opts.applyTextNormalization || '',
  ];
  return `tts:elevenlabs:${djb2(parts.map((value) => String(value ?? '')).join('\u0001'))}`;
}

function djb2(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
