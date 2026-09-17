import { readModelResponse } from './qianmu-model-response.js';

// The official factory supplies source-specific settings; it does not send the request.
// Sending here retains raw content and end metadata that generateRaw strips away.
export function hostChatModelAvailable(context) {
  return context?.mainApi === 'openai' && typeof context.ChatCompletionService?.presetToGeneratePayload === 'function'
    && typeof context.getChatCompletionModel === 'function' && !!context.chatCompletionSettings;
}

export async function callHostChatModel({ context, messages, stream = false, maxTokens, temperature, signal,
  guard = () => true, fetchImpl = globalThis.fetch, onDelta, onReasoning, onResponse } = {}) {
  const check = async () => {
    if (signal?.aborted) throw Object.assign(new Error('已取消生成'), { name: 'AbortError' });
    if (await guard() === false) throw new Error('生成所属的聊天或账户已变化');
    if (signal?.aborted) throw Object.assign(new Error('已取消生成'), { name: 'AbortError' });
  };
  await check();
  if (!hostChatModelAvailable(context)) throw new Error('当前 ST 连接没有独立聊天补全接口，无法启用此流式路径');
  const settings = structuredClone(context.chatCompletionSettings), model = context.getChatCompletionModel();
  const overrides = { model, messages: structuredClone(messages), stream: Boolean(stream) };
  if (Number(maxTokens) > 0) overrides.max_tokens = Number(maxTokens);
  if (Number.isFinite(temperature)) overrides.temperature = temperature;
  const payload = await context.ChatCompletionService.presetToGeneratePayload(settings, {}, overrides);
  await check();
  if (!payload || !Array.isArray(payload.messages) || !payload.model || !payload.chat_completion_source) throw new Error('ST 未提供完整模型配置，未发送请求');
  payload.stream = Boolean(stream);
  const endpoint = '/api/backends/chat-completions/generate';
  const origin = globalThis.location?.origin;
  const response = await fetchImpl(origin ? new URL(endpoint, origin).href : endpoint, {
    method: 'POST', headers: { ...context.getRequestHeaders(), 'Content-Type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify(payload), signal,
  });
  return readModelResponse(response, { stream, signal, guard: check, onDelta, onReasoning, onResponse });
}
