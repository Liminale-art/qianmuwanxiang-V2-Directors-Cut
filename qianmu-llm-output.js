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
