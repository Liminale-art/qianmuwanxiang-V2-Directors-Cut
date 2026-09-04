// 千幕 · 对话模型输出能力协商。只生成请求选项，不发起网络请求。
export const QIANMU_STRUCTURED_OUTPUT_MODES = Object.freeze(['none', 'json_schema']);
export const QIANMU_STRUCTURED_SCHEMA_MAX_BYTES = 128 * 1024;

const plain = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function normalizeQianmuStructuredOutputMode(value) {
  return value === 'json_schema' ? 'json_schema' : 'none';
}

function safeSchemaClone(value) {
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch (_) { return null; }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > QIANMU_STRUCTURED_SCHEMA_MAX_BYTES) return null;
  try { return JSON.parse(serialized); } catch (_) { return null; }
}

export function createQianmuChatCompletionResponseFormat(schema, options = {}) {
  if (normalizeQianmuStructuredOutputMode(options.mode) !== 'json_schema') return null;
  if (!plain(schema) || schema.type !== 'object') return null;
  const cleanSchema = safeSchemaClone(schema);
  if (!cleanSchema) return null;
  const name = String(options.name || 'qianmu_response')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64) || 'qianmu_response';
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: options.strict !== false,
      schema: cleanSchema,
    },
  };
}

// ST 的 custom 渠道会自行在 custom_url 后拼接 /chat/completions。
// 用户既可能填写 API 根地址，也可能粘贴完整生成地址；统一折回 API 根，避免
// /chat/completions/chat/completions 这类“测试似乎成功、真实生成必失败”的路径。
export function normalizeQianmuChatApiRoot(value) {
  let url = String(value || '').trim().replace(/\/+$/, '');
  url = url.replace(/\/(?:chat\/completions|completions|models)\/?$/i, '');
  return url.replace(/\/+$/, '');
}

function contentPartText(part) {
  if (typeof part === 'string') return part;
  if (!plain(part)) return '';
  const value = part.text ?? part.content ?? part.output_text ?? part.value;
  return typeof value === 'string' ? value : '';
}

// OpenAI 兼容渠道并不都把正文放在 message.content 字符串中：有的返回
// content parts，有的通过被强制调用的 function arguments 回传 JSON。
// 在传输层把这些形态收敛为纯文本，业务解析器不再感知供应商差异。
export function qianmuChatCompletionText(payload) {
  if (typeof payload === 'string') return payload;
  if (!plain(payload)) return '';
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = plain(choice?.message) ? choice.message : {};
  const direct = message.content ?? choice?.text ?? payload.output_text ?? payload.response?.output_text;
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) return direct.map(contentPartText).filter(Boolean).join('');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    const args = call?.function?.arguments ?? call?.arguments;
    if (typeof args === 'string' && args.trim()) return args;
  }
  const legacyArgs = message.function_call?.arguments;
  return typeof legacyArgs === 'string' ? legacyArgs : '';
}

export function qianmuChatCompletionError(payload) {
  if (!plain(payload) || !payload.error) return '';
  if (typeof payload.error === 'string') return payload.error;
  return String(payload.error?.message || payload.error?.error || payload.message || '上游模型请求失败');
}

function balancedJsonFragments(text) {
  const fragments = [];
  const source = String(text || '');
  let start = -1;
  let quote = false;
  let escape = false;
  const stack = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') { quote = true; continue; }
    if (char === '{' || char === '[') {
      if (!stack.length) start = index;
      stack.push(char);
      continue;
    }
    if (char !== '}' && char !== ']') continue;
    const expected = char === '}' ? '{' : '[';
    if (stack.at(-1) !== expected) { stack.length = 0; start = -1; continue; }
    stack.pop();
    if (!stack.length && start >= 0) {
      fragments.push(source.slice(start, index + 1));
      start = -1;
    }
  }
  return fragments;
}

// 机器任务只接受真正包含 lines 的结果。先去掉可见思考块，再从完整文本、
// JSON 代码块与平衡括号片段中逐个尝试，兼容顶层数组且不会误吃 think 中的对象。
export function parseQianmuDialoguePayload(value) {
  const source = String(value || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .trim();
  if (!source) return null;
  const candidates = [source];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(...balancedJsonFragments(source));
  for (const candidate of [...new Set(candidates)].reverse()) {
    let parsed;
    try { parsed = JSON.parse(candidate.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim().replace(/,\s*([}\]])/g, '$1')); }
    catch (_) { continue; }
    if (Array.isArray(parsed)) return { lines: parsed };
    if (plain(parsed) && Array.isArray(parsed.lines)) return parsed;
  }
  return null;
}
