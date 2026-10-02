import test from 'node:test';
import assert from 'node:assert/strict';
import {suppliedIcons} from '../scripts/iconsax-selected-sources.mjs';
import {glyphs, normalizeIcon} from '../scripts/vendor-iconsax.mjs';
import {ICONSAX_ICON_MARKUP, ICONSAX_GLYPH_NAMES, ICONSAX_FIXED_VARIANTS, qianmuIconMarkup} from '../qianmu-icon-renderer.js';

test('continuous playback alone uses the two supplied linear paths in all themes', () => {
  for (const [semantic, name] of [['voice-playall','tts-play'],['voice-stopall','tts-stop']]) {
    assert.equal(glyphs[semantic], name);
    assert.equal(ICONSAX_GLYPH_NAMES[semantic], name);
    assert.equal(ICONSAX_FIXED_VARIANTS[semantic], 'outline');
    assert.deepEqual(Object.keys(ICONSAX_ICON_MARKUP[name]), ['outline']);
    const body = normalizeIcon(suppliedIcons[`${name}/outline`]);
    assert.equal(ICONSAX_ICON_MARKUP[name].outline, body);
    assert.deepEqual(Object.entries(ICONSAX_GLYPH_NAMES).filter(([, candidate]) => candidate === name).map(([key]) => key), [semantic]);
    const rendered = qianmuIconMarkup(semantic);
    assert.ok(rendered.includes(body));
    assert.match(rendered, /viewBox="0 0 24 24"/);
    assert.match(rendered, /data-qm-icon-variant="outline" data-qm-icon-fixed/);
    assert.equal((rendered.match(/data-qm-icon-variant=/g) || []).length, 1);
    assert.equal((rendered.match(/<path\b/g) || []).length, 1, 'no surrounding play/pause circle');
    assert.match(body, /stroke="currentColor" stroke-width="2\.5"/);
    assert.doesNotMatch(rendered, /clip-path|\bid=|<defs|href=|url\(/);
  }
});

test('generic play, stop, headphones and focus retain their own distinct graphics', () => {
  for (const [semantic, name] of [['play','qianmu-play'],['stop','qianmu-stop'],['play-circle','play-circle'],['stop-circle','stop-circle'],['headphones','headphone'],['focus','notification']]) {
    assert.equal(ICONSAX_GLYPH_NAMES[semantic], name);
    assert.ok(ICONSAX_ICON_MARKUP[name]);
    assert.notEqual(name, ICONSAX_GLYPH_NAMES['voice-playall']);
    assert.notEqual(name, ICONSAX_GLYPH_NAMES['voice-stopall']);
  }
});
