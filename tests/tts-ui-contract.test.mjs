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
assert.match(source, /value="provider"[\s\S]*value="generic"[\s\S]*value="custom"/, '提取提示词必须提供模型默认、通用与自定义方案');
assert.match(source, /a\.download = `\$\{ttsSafeName[\s\S]*params\.fileExtension/, '下载扩展名必须经过 Provider 映射');

console.log('TTS inline UI contract OK');
