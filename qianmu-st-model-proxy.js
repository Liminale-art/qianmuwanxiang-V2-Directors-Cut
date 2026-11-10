// 千幕 · 经 ST 后端 custom 渠道调用外部 OpenAI 兼容接口（伴读总结／对话／小助手／识图、台词提取、千幕主 API 目录与测试）。
// 地址、鉴权回退、请求体与目录解析统一走 qianmu-model-compat.js；回复解析走 qianmu-model-response.js。
// 始终非流式：ST 代理不透传 SSE。失败文字保持 “HTTP <状态> · <详情>” 形式，调用方据此判断是否回落浏览器直连。
import { resolveApiRoot, stProxyBody, chatPayload, probePayload, sendWithAuthFallback, proxyPayloadError,
  parseModelList, probeConnection, redactSecrets } from './qianmu-model-compat.js?v=1.59.484';
import { createModelResponseAccumulator } from './qianmu-model-response.js?v=1.59.452';
import { qianmuChatCompletionText } from './qianmu-llm-output.js?v=1.59.202';

const GENERATE = '/api/backends/chat-completions/generate';
const STATUS = '/api/backends/chat-completions/status';

export function createStModelProxy({ fetchImpl = (...args) => fetch(...args), headers = () => ({}) } = {}) {
  // send 返回已解析的 JSON；ST 把上游失败包成 200 + {error}，在此抛出交鉴权回退判断（Unauthorized 换裸 Key 重试一次）。
  async function post(path, apiUrl, apiKey, payload, signal, label) {
    const root = resolveApiRoot(apiUrl);
    return sendWithAuthFallback(apiKey, async authorization => {
      const response = await fetchImpl(path, { method: 'POST', signal,
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(stProxyBody(root, authorization, payload)) });
      if (!response.ok) {
        const detail = String(await response.text().catch(() => '')).trim().slice(0, 300);
        throw Object.assign(new Error(`HTTP ${response.status}${detail ? ` · ${detail}` : ''}`), { status: response.status });
      }
      const json = await response.json().catch(() => null);
      const problem = proxyPayloadError(json);
      if (problem) throw new Error(`${label}：${problem}`);
      return json;
    }, { rejected: () => false });
  }

  const guarded = run => async (options = {}) => {
    try { return await run(options); }
    catch (error) {
      if (error?.name !== 'AbortError') error.message = redactSecrets(error?.message, [options.apiKey]);
      throw error;
    }
  };

  const generate = guarded(async ({ apiUrl, apiKey, model, messages, temperature, maxTokens = 0, signal, onReasoning }) => {
    const json = await post(GENERATE, apiUrl, apiKey,
      chatPayload({ model, messages, temperature: temperature ?? 0.75, maxTokens, stream: false }), signal, '上游模型请求失败');
    if (!json || typeof json !== 'object') throw new Error('上游模型未返回可用正文');
    // 只借解析器收敛多家回复形态（OpenAI／reasoning／Anthropic／Gemini／Cohere）；
    // 结束原因不在此拦截，保持伴读既有行为（截断的总结由上层 JSON 校验与重试处理）。
    const accumulator = createModelResponseAccumulator({ onReasoning });
    accumulator.consume(json, { streaming: false });
    const parsed = accumulator.snapshot().text;
    // 强制函数调用等形态把正文放在 tool_calls.arguments 里，解析器不收，沿用旧的取文规则兜底。
    const text = String(parsed || '').trim() ? parsed : qianmuChatCompletionText(json);
    if (!String(text || '').trim()) throw new Error('上游模型未返回可用正文');
    return text;
  });

  // 返回去重排序后的模型名；目录为空时返回空数组，由调用方决定提示。
  const listModels = guarded(async ({ apiUrl, apiKey, signal }) =>
    parseModelList(await post(STATUS, apiUrl, apiKey, {}, signal, '模型目录不可用')));

  // 1 token 生成探测：只确认能生成，不读取正文、不看结束原因。
  const probe = guarded(async ({ apiUrl, apiKey, model, signal }) => {
    await post(GENERATE, apiUrl, apiKey, probePayload(model), signal, '上游模型请求失败');
  });

  // 先查目录；目录失败或为空且已选模型时补一次 1 token 探测（统一网关 /models 503 不再误判）。
  // chatModel:false 用于向量／重排：这类模型不能用对话探测，只查目录。
  const testConnection = guarded(options => probeConnection({
    model: options.chatModel === false ? '' : options.model,
    listModels: async () => {
      const models = await listModels(options);
      if (!models.length) throw new Error('接口没返回模型列表');
      return models;
    },
    probe: () => probe(options),
  }));

  return { generate, listModels, probe, testConnection };
}
