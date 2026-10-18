import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {suppliedIcons, officialSelectedIcons} from '../scripts/iconsax-selected-sources.mjs';
import {normalizeIcon, suppliedArtwork} from '../scripts/vendor-iconsax.mjs';
import {ICONSAX_ICON_MARKUP, ICONSAX_GLYPH_NAMES, QIANMU_FA_ICON_MAP, qianmuIconMarkup} from '../qianmu-icon-renderer.js';

const parts = markup => [...markup.matchAll(/<g data-qm-icon-variant="(outline|bold|twotone)"[^>]*>([\s\S]*?)<\/g>(?=<g data-qm-icon-variant=|<\/svg>)/g)];
test('all eleven attached exports preserve their actual geometry and root paint in the bundled renderer', () => {
  assert.equal(Object.keys(suppliedIcons).length,11);
  assert.equal(ICONSAX_GLYPH_NAMES.theater,'gift-9');
  for (const [key, svg] of Object.entries(suppliedIcons)) {
    const [name, variant] = key.split('/');
    for (const target of name === 'maximize' ? ['maximize-3','maximize-4'] : [name]) {
      assert.equal(ICONSAX_ICON_MARKUP[target][variant], normalizeIcon(svg), key);
      assert.deepEqual([...ICONSAX_ICON_MARKUP[target][variant].matchAll(/ d="([^"]+)"/g)].map(m=>m[1]), [...svg.matchAll(/ d="([^"]+)"/g)].map(m=>m[1]), key+' exact paths');
      assert.doesNotMatch(ICONSAX_ICON_MARKUP[target][variant], /#[a-f\d]+|clip-path|\bid=|<defs|href=/i);
      if (/^<svg[^>]*fill="#ffffff"/.test(svg)) assert.match(ICONSAX_ICON_MARKUP[target][variant], /^<g fill="currentColor">/);
    }
  }
});
test('classic notification uses the supplied tone geometry without muted paths; microphone maps to the supplied family', () => {
  assert.equal(ICONSAX_GLYPH_NAMES.focus, 'notification');
  assert.equal(ICONSAX_GLYPH_NAMES['microphone-stage'], 'microphone');
  assert.equal(ICONSAX_ICON_MARKUP.notification.outline, normalizeIcon(suppliedIcons['notification/twotone']).replace(/ opacity="0\.4"/g,''));
  assert.doesNotMatch(ICONSAX_ICON_MARKUP.notification.outline,/opacity=/);
  assert.equal(suppliedArtwork('maximize-3','outline'), null, 'non-paper expand stays with original source');
  assert.equal(suppliedArtwork('maximize-4','twotone'), null);
});
test('font-management artwork is the exact selected official linear subset; application state stays local', () => {
  assert.deepEqual(Object.keys(officialSelectedIcons), ['document-filter/outline']);
  const svg = officialSelectedIcons['document-filter/outline'];
  assert.deepEqual(Object.keys(ICONSAX_ICON_MARKUP['document-filter']), ['outline']);
  assert.equal(ICONSAX_ICON_MARKUP['document-filter'].outline, normalizeIcon(svg));
  assert.equal(suppliedArtwork('document-filter', 'outline').markup, normalizeIcon(svg));
  assert.deepEqual([...ICONSAX_ICON_MARKUP['document-filter'].outline.matchAll(/ d="([^"]+)"/g)].map(m => m[1]), [...svg.matchAll(/ d="([^"]+)"/g)].map(m => m[1]));
  for (const [semantic, name, variant] of [['font-manage', 'document-filter', 'outline'], ['font-apply', 'tick-square', 'outline'], ['font-applied', 'tick-square', 'bold']]) {
    const markup = qianmuIconMarkup(semantic), groups = parts(markup);
    assert.equal(ICONSAX_GLYPH_NAMES[semantic], name); assert.equal(groups.length, 1);
    assert.equal(groups[0][1], variant); assert.equal(groups[0][2], ICONSAX_ICON_MARKUP[name][variant]);
    assert.match(markup, /data-qm-icon-fixed/); assert.doesNotMatch(markup, /undefined|https?:|clip-path|<defs|href=/i);
  }
  assert.equal(QIANMU_FA_ICON_MAP['fa-check-double'], 'qm-regular-checks');
  assert.equal(parts(qianmuIconMarkup('fa-check-double')).length, 3);
  assert.equal(parts(qianmuIconMarkup('fa-square-check')).length, 3);
});
test('paper prediction/world map use classic geometry while glass keeps its own tone', () => {
  for (const [semantic, name] of [['dashboard','unlimited'],['world-map','share']]) {
    const rendered = parts(qianmuIconMarkup(semantic));
    assert.equal(rendered.length,3);
    for (const [,variant,body] of rendered) assert.equal(body,ICONSAX_ICON_MARKUP[name][variant==='bold'?'outline':variant]);
  }
});
test('only the paper entrance heart is solid, independent of floor collection state', async () => {
  const rendered=parts(qianmuIconMarkup('bookmarks'));
  assert.equal(rendered.length,3);
  for (const [,variant,body] of rendered) assert.match(body,new RegExp('fill="'+(variant==='bold'?'currentColor':'none')+'"'));
  const floor=await readFile(new URL('../qianmu-text-collection-floor.js',import.meta.url),'utf8');
  assert.match(floor,/setAttribute\('fill', collected \? 'currentColor' : 'none'\)/);
});
