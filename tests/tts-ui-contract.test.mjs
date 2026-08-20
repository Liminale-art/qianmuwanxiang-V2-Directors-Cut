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
];

for (const marker of requiredInteractions) {
  assert.ok(source.includes(marker), `正文配音兼容契约缺失：${marker}`);
}

assert.match(source, /if \(ttsClickTimer\).*ttsOpenQuickPopup\(btn\)/s, '双击小耳机必须继续打开单句面板');
assert.match(source, /ttsPlayResolvedLine\(line, mesEl, idx, btn, true\)/, '重新生成必须强制绕过缓存并播放');

console.log('TTS inline UI contract OK');

