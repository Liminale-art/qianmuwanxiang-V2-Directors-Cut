import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const requiredInteractions = [
  'function ttsHandleLinePlayClick',
  'ttsOpenQuickPopup(btn)',
  'sd-tts-pop-regen',
  'sd-tts-pop-download',
  'sd-tts-pop-fav',
  'async function ttsDownloadLine',
  'async function ttsFavoriteLine',
  'cacheKeyForTts(params.providerId, params)',
  'synthesizeTts(params.providerId, params)',
  "providerId === 'doubao'",
  "providerId === 'elevenlabs'",
  'ttsResolvedExtractPrompt()',
  'outputExtensionForTts(providerId, p)',
  'ttsProviderHasCredentials(params.providerId, params)',
  'delivery: String(l?.delivery ||',
];

for (const marker of requiredInteractions) {
  assert.ok(source.includes(marker), `正文配音兼容契约缺失：${marker}`);
}

assert.match(source, /if \(ttsClickTimer\).*ttsOpenQuickPopup\(btn\)/s, '双击小耳机必须继续打开单句面板');
assert.match(source, /ttsPlayResolvedLine\(line, mesEl, idx, btn, true\)/, '重新生成必须强制绕过缓存并播放');
assert.match(source, /sd-tts-provider[\s\S]*MiniMax|listTtsProviders\(\)/, '配音设置必须从 Provider 注册表渲染');
assert.match(source, /value="provider"[\s\S]*value="custom"/, '提取提示词必须提供模型默认与自定义方案');
assert.doesNotMatch(source, /<option value="generic"/, '界面不应继续暴露通用智能模板');
assert.ok(source.includes('function ttsRefreshProviderChat('), 'Provider 切换必须原地刷新已提取台词');
assert.match(source, /icon\.disabled = !voiced/, '未匹配新 Provider 音色时应保留禁用态正文耳机');
assert.match(source, /<label>App ID<\/label>[\s\S]*<label>Access Key<\/label>/, '豆包旧版凭证标题必须保持精简');
assert.doesNotMatch(source, /切换模型只替换连接/, '配音模型下方不应保留切换说明');
assert.doesNotMatch(source, /App ID（浏览器直连）|Access Key（浏览器直连）|新版 API Key \/ 高级连接/, '豆包面板不应保留重复标注');
assert.match(source, /<summary>新版 API Key（仅反代）<\/summary>/, '新版 Key 折叠区只保留一个标题');
assert.match(source, /<label>模型<\/label><select class="text_pole sd-tts-model">/, '模型字段标题必须精简');
assert.match(source, /跟随当前模型（\$\{htmlEscape\(provider\.label\)\}）/, '跟随模型方案不应附加“推荐”');
assert.match(source, /t\.extractSchemes\[providerId\] = `library:\$\{sch\.id\}`/, '载入方案库后必须记录方案身份');
assert.match(source, /activeGuidanceScheme\.name/, '载入方案后下拉框必须显示方案标题');
assert.match(source, /a\.download = `\$\{ttsSafeName[\s\S]*params\.fileExtension/, '下载扩展名必须经过 Provider 映射');

console.log('TTS inline UI contract OK');
