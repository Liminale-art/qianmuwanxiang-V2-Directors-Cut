import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const proxyHelper = source.match(/async function callTtsExternalExtractModel[\s\S]*?\n}\n\n\/\/ 调用模型做提取/)?.[0] || '';
const dispatcher = source.match(/async function callTtsExtractModel[\s\S]*?\n}\n\n\/\/ TTS 专用标签清洗/)?.[0] || '';

assert.ok(proxyHelper, '台词提取必须具备独立的外部 API 路由');
assert.match(proxyHelper, /generateViaSTProxy\(apiUrl, `Authorization: Bearer \$\{apiKey\}`/, '真实提取必须复用测试连接所使用的 ST 内置代理');
assert.match(proxyHelper, /HTTP\\s\*\(\?:401\|403\)/, '代理鉴权失败后必须兼容裸 API Key');
assert.match(proxyHelper, /callExternalApi\(messages, null, \{ \.\.\.config, stream: false \}, controller\)/, '旧版 ST 缺少生成代理时必须保留直连回退');
assert.match(dispatcher, /callTtsExternalExtractModel\(messages, eff\)/, '外部预设和千幕主 API 必须汇入同一条可靠提取链路');
assert.match(dispatcher, /callSillyTavernModel\(userPrompt, systemPrompt, null\)/, '跟随 SillyTavern 当前 API 的路径必须保持不变');

console.log('TTS extraction routing contract OK');
