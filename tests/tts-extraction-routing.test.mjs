import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const proxyHelper = source.match(/async function callTtsExternalExtractModel[\s\S]*?\n}\n\n\/\/ 调用模型做提取/)?.[0] || '';
const dispatcher = source.match(/async function callTtsExtractModel[\s\S]*?\n}\n\n\/\/ TTS 专用标签清洗/)?.[0] || '';

assert.ok(proxyHelper, '台词提取必须具备独立的外部 API 路由');
assert.match(proxyHelper, /generateViaSTProxy\(apiUrl, `Authorization: Bearer \$\{apiKey\}`/, '真实提取必须复用测试连接所使用的 ST 内置代理');
assert.match(proxyHelper, /normalizeQianmuChatApiRoot\(config\?\.apiUrl\)/, '完整 chat/completions 地址必须先折回 API 根地址');
assert.match(proxyHelper, /Unauthorized\|Forbidden/, '代理封装上游鉴权错误后仍须兼容裸 API Key');
assert.match(proxyHelper, /callExternalApi\(messages, null, \{ \.\.\.config, stream: false \}, controller\)/, '旧版 ST 缺少生成代理时必须保留直连回退');
assert.match(dispatcher, /callTtsExternalExtractModel\(messages, eff\)/, '外部预设和千幕主 API 必须汇入同一条可靠提取链路');
assert.match(dispatcher, /const mainExternalReady =[\s\S]*const useExternal = !!cfg \|\| mainExternalReady/, '空的千幕外部配置不得阻断 ST 当前文本模型');
assert.match(dispatcher, /callSillyTavernModel\(userPrompt, systemPrompt, null\)/, '跟随 SillyTavern 当前 API 的路径必须保持不变');
assert.match(source, /parseQianmuDialoguePayload\(content\)/, '台词提取必须兼容思考块、顶层数组与分段内容');

console.log('TTS extraction routing contract OK');
