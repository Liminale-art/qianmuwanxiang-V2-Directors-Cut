import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {glyphs, fixedVariants} from '../scripts/vendor-iconsax.mjs';
import {ICONSAX_ICON_MARKUP, ICONSAX_GLYPH_NAMES, ICONSAX_FIXED_VARIANTS, qianmuIconMarkup} from '../qianmu-icon-renderer.js';

const wavePath = 'M3 12C4.5 8 6 8 7.5 12S10.5 16 12 12S15 8 16.5 12S19.5 16 21 12';

test('reader wave is one original continuous rounded line in every appearance', () => {
  assert.equal(glyphs['underline-wave'], 'qianmu-underline-wave');
  assert.equal(ICONSAX_GLYPH_NAMES['underline-wave'], glyphs['underline-wave']);
  assert.equal(fixedVariants['underline-wave'], 'outline');
  assert.equal(ICONSAX_FIXED_VARIANTS['underline-wave'], fixedVariants['underline-wave']);
  const expected = `<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${wavePath}"/></g>`;
  for (const variant of ['outline', 'bold', 'twotone']) {
    assert.equal(ICONSAX_ICON_MARKUP['qianmu-underline-wave'][variant], expected);
  }
  const rendered = qianmuIconMarkup('underline-wave');
  assert.match(rendered, /viewBox="0 0 24 24"/);
  assert.match(rendered, /data-qm-icon-variant="outline" data-qm-icon-fixed/);
  assert.equal((rendered.match(/data-qm-icon-variant=/g) || []).length, 1);
  assert.equal((rendered.match(/<path\b/g) || []).length, 1);
  assert.ok(rendered.includes(expected));
  assert.doesNotMatch(rendered, /\bopacity=|stroke-dash|href=|url\(/);
  assert.equal((wavePath.match(/[mM]/g) || []).length, 1, 'one unbroken contour, without stacked wind lines');
  assert.doesNotMatch(wavePath, /[zZ]/, 'an open line, never filled or closed');
});

test('only the reader underline action adopts the drawing; generic sound stays unchanged', async () => {
  assert.deepEqual(Object.entries(ICONSAX_GLYPH_NAMES).filter(([, name]) => name === 'qianmu-underline-wave').map(([semantic]) => semantic), ['underline-wave']);
  assert.equal(ICONSAX_GLYPH_NAMES['wave-sine'], 'sound');
  assert.notEqual(qianmuIconMarkup('fa-wave-square'), qianmuIconMarkup('underline-wave'));
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /data-style="wavy"[^\n]*data-qm-icon="underline-wave"/);
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /单线波浪下划线图标为千幕原创轮廓/);
});
