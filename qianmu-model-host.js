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
  // Apply Qianmu's limits before official model-specific conversion (for example,
  // max_completion_tokens and temperature omission), not over the finished payload.
  const presetOverrides = {};
  if (Number(maxTokens) > 0) presetOverrides.openai_max_tokens = Number(maxTokens);
  if (Number.isFinite(temperature)) presetOverrides.temperature = temperature;
  const payload = await context.ChatCompletionService.presetToGeneratePayload(settings, presetOverrides, overrides);
  await check();
  if (!payload || !Array.isArray(payload.messages) || !payload.model || !payload.chat_completion_source) throw new Error('ST 未提供完整模型配置，未发送请求');
  // Borrow transport/sampling settings only. Host preset factories must not
  // append their own prompt, worldbook, chat, or instruction messages here.
  const convertedMessages = payload.messages;
  payload.messages = structuredClone(messages).map((message, index) => {
    // ST's official o1 adapter converts system to user. Preserve that narrow
    // transport conversion only when order, length and content are unchanged.
    const converted = convertedMessages[index];
    if (/^(openai\/)?o1/.test(model) && convertedMessages.length === messages.length
      && message.role === 'system' && converted?.role === 'user' && converted.content === message.content) {
      message.role = 'user';
    }
    return message;
  });
  payload.stream = Boolean(stream);
  const endpoint = '/api/backends/chat-completions/generate';
  const origin = globalThis.location?.origin;
  const response = await fetchImpl(origin ? new URL(endpoint, origin).href : endpoint, {
    method: 'POST', headers: { ...context.getRequestHeaders(), 'Content-Type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: JSON.stringify(payload), signal,
  });
  return readModelResponse(response, { stream, signal, guard: check, onDelta, onReasoning, onResponse });
}
