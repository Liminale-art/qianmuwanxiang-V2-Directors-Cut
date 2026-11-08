import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fontPreviewFamily, fontScopeCss} from '../qianmu-font-runtime.js';

const css = (await readFile(new URL('../style.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const barRule = () => {
  const found = [...css.matchAll(/(?:^|[}\s])\.sd-tts-bar\s*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(found.length, 'missing .sd-tts-bar rule');
  return found.join(';').replace(/\s+/g, ' ');
};

test('line list uses small text in the font library body font', () => {
  const bar = barRule();
  assert.match(bar, /font-size:\s*12px\s*!important/);
  assert.match(bar, /font-family:\s*var\(--qm-body-font,\s*inherit\)\s*!important/);
  const family = fontPreviewFamily('body-font');
  assert.ok(fontScopeCss('body', family).includes(`:root { --qm-body-font:"${family}",var(--mainFontFamily,system-ui,sans-serif); }`));
  assert.doesNotMatch(fontScopeCss('st', fontPreviewFamily('ui-font')), /--qm-body-font/, 'the interface font never feeds the line list');
});
