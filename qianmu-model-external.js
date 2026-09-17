import { readModelResponse } from './qianmu-model-response.js';
export async function callExternalModel(messages, onDelta, cfg, controller, { settings, normalizeUrl, normalizeQianmuChatApiRoot, createQianmuChatCompletionResponseFormat }, fetchImpl = globalThis.fetch) {
  const apiUrl = cfg?.apiUrl ?? settings.apiUrl;
  const apiKey = cfg?.apiKey ?? settings.apiKey;
  const model = cfg?.model ?? settings.model;
  const temperature = cfg?.temperature ?? settings.temperature;
  const base = normalizeUrl(normalizeQianmuChatApiRoot(apiUrl));
  if (!(base && apiKey && model)) throw new Error('INVALID_API_SETTINGS');
  const ac = controller || new AbortController();   // 调用方可传入独立句柄（幕外/推演各管各的）
  // stream/max_tokens 默认取全局设置，cfg 可逐调用覆盖（伴读总结卡自带 gen-params）
  const wantStream = cfg?.stream != null ? !!cfg.stream : !!settings.streamEnabled;
  const stream = wantStream && typeof onDelta === 'function';
  const body = { model, messages, temperature: Number(temperature ?? 0.75), stream };
  const maxTokens = Number(cfg?.maxTokens != null ? cfg.maxTokens : settings.maxOutputTokens || 0);
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (!stream && cfg?.jsonSchema) {
    const responseFormat = createQianmuChatCompletionResponseFormat(cfg.jsonSchema, {
      mode: cfg.structuredOutputMode ?? settings.structuredOutputMode,
      name: cfg.jsonSchemaName,
      strict: cfg.jsonSchemaStrict,
    });
    if (responseFormat) body.response_format = responseFormat;
  }
  if (await cfg?.guard?.() === false) throw new Error('生成所属的聊天或账户已变化');
  if (ac.signal.aborted) throw Object.assign(new Error('已取消生成'), { name: 'AbortError' });
  const res = await fetchImpl(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  });
  const result = await readModelResponse(res, { stream, signal: ac.signal, guard: cfg?.guard,
    onDelta, onReasoning: cfg?.onReasoning, onResponse: cfg?.onResponse });
  return result.text;
}
