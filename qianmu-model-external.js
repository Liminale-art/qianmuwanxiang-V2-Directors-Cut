import { readModelResponse } from './qianmu-model-response.js?v=1.59.452';
import { resolveApiRoot, chatEndpoint, sendWithAuthFallback } from './qianmu-model-compat.js?v=1.59.484';

// 浏览器直连 OpenAI 兼容接口。地址按兼容层统一规则解析（裸域名补 /v1，/api/v3 等原路径保留，结尾 # 原样使用）；
// 401/403 时以裸 Key 重试一次。normalizeUrl / normalizeQianmuChatApiRoot 参数保留仅为兼容旧调用方，不再使用。
export async function callExternalModel(messages, onDelta, cfg, controller, { settings, createQianmuChatCompletionResponseFormat }, fetchImpl = globalThis.fetch) {
  const apiUrl = cfg?.apiUrl ?? settings.apiUrl;
  const apiKey = cfg?.apiKey ?? settings.apiKey;
  const model = cfg?.model ?? settings.model;
  const temperature = cfg?.temperature ?? settings.temperature;
  if (!(String(apiUrl ?? '').trim() && apiKey && model)) throw new Error('INVALID_API_SETTINGS');
  const root = resolveApiRoot(apiUrl);
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
  const payload = JSON.stringify(body);
  const res = await sendWithAuthFallback(apiKey, authorization => fetchImpl(chatEndpoint(root), {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: payload,
    signal: ac.signal,
  }));
  const result = await readModelResponse(res, { stream, signal: ac.signal, guard: cfg?.guard,
    onDelta, onReasoning: cfg?.onReasoning, onResponse: cfg?.onResponse });
  return result.text;
}
