import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  QIANMU_STRUCTURED_SCHEMA_MAX_BYTES,
  createQianmuChatCompletionResponseFormat,
  normalizeQianmuStructuredOutputMode,
} from '../qianmu-llm-output.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'items'],
  properties: {
    schema: { type: 'string', const: 'qianmu.test.v1' },
    items: { type: 'array', items: { type: 'string' } },
  },
};

assert.equal(normalizeQianmuStructuredOutputMode(undefined), 'none');
assert.equal(normalizeQianmuStructuredOutputMode('json_object'), 'none');
assert.equal(normalizeQianmuStructuredOutputMode('json_schema'), 'json_schema');
assert.equal(createQianmuChatCompletionResponseFormat(schema, { mode: 'none' }), null, '兼容模式不得添加未知请求字段');

const format = createQianmuChatCompletionResponseFormat(schema, {
  mode: 'json_schema', name: 'qianmu.test/response', strict: true,
});
assert.deepEqual(format, {
  type: 'json_schema',
  json_schema: {
    name: 'qianmu_test_response',
    strict: true,
    schema,
  },
});
assert.notEqual(format.json_schema.schema, schema, '请求格式必须持有安全副本，不能被调用方事后篡改');
assert.equal(createQianmuChatCompletionResponseFormat({ type: 'array' }, { mode: 'json_schema' }), null);
assert.equal(createQianmuChatCompletionResponseFormat({ type: 'object', value: 'x'.repeat(QIANMU_STRUCTURED_SCHEMA_MAX_BYTES) }, { mode: 'json_schema' }), null, '过大 Schema 不得进入请求');

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(source, /if \(!stream && cfg\?\.jsonSchema\)[\s\S]*body\.response_format = responseFormat/, '结构化字段只能在明确提供 Schema 的非流式请求中出现');
assert.match(source, /structuredOutputMode: 'none'/, '全新安装必须默认兼容模式');
assert.match(source, /profile\.structuredOutputMode[\s\S]*normalizeQianmuStructuredOutputMode/, 'API 预设必须独立保存能力声明');
assert.match(source, /storyboardCallCompiler[\s\S]*jsonSchema: requestOptions\.jsonSchema/, '分镜编译器必须具备传入严格 Schema 的能力门面');

console.log('LLM structured-output capability negotiation OK');
