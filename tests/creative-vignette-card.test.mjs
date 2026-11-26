import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCreativeSocialCard } from '../qianmu-creative-social.js';
import { completeDirectorCards } from '../qianmu-director-live.js';

test('a 人间小传 card renders as its own side story; an old 旁观一幕 card stays readable', () => {
  const html = renderCreativeSocialCard({ type: 'vignette', title: '收摊<以后>', character: '老周', content: '老周把撑杆放倒。\n\n他数了三遍零钱。' });
  assert.match(html, /人间小传 · 独立番外/);
  assert.match(html, /<h4>收摊&lt;以后&gt;<\/h4>/);
  assert.match(html, /<span>老周<\/span><span aria-hidden="true">·<\/span><span>小传<\/span>/);
  assert.match(html, /<p>老周把撑杆放倒。<\/p><p>他数了三遍零钱。<\/p>/);
  assert.match(html, /aria-label="人间小传"/);
  assert.doesNotMatch(html, /一幕之遥/);
  const old = renderCreativeSocialCard({ type: 'fourth_wall', form: 'scene', title: '留一扇窗', character: '阿岚', content: '她把纸条留在窗沿。' });
  assert.match(old, /一幕之遥 · 独立番外/);assert.match(old, /<span>旁观<\/span>/);
});

test('a streamed 人间小传 card is shown once its object closes', () => {
  const card = { type: 'vignette', title: '收摊以后', character: '老周', content: '老周把撑杆放倒。' };
  const cards = completeDirectorCards(`{"interlude":${JSON.stringify(card)}`);
  assert.ok(cards.some((item) => item.key === 'interlude' || /收摊以后/.test(JSON.stringify(item))), JSON.stringify(cards).slice(0, 200));
});
