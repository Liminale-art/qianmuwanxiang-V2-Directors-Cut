import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base=await readFile(new URL('../style.css',import.meta.url),'utf8');
const skins=await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const rule=(css,selector)=>{const start=css.indexOf(selector+' {');assert.notEqual(start,-1,selector);return css.slice(start+selector.length+2,css.indexOf('}',start));};
const owner='dialog:is(.sd-comfy-route-dialog,.sd-ensemble-target-dialog)';
test('classic owned popup protects its own shell against the observed host-important surface without opting in host popups',()=>{
  const body=rule(base,owner);
  for(const property of ['background','color','border','border-radius'])assert.match(body,new RegExp('(?:^|;)\\s*'+property+':[^;]+!important\\s*;'));
  assert.match(body,/color:var\(--sd-text\)/);assert.match(body,/background:var\(--sd-bg,var\(--sd-glass\)\)/);
  assert.doesNotMatch(owner,/\.popup(?:\W|$)|\.dialogue_popup/);
});
test('glass and editorial owned popup retain their theme surface, shape and shadow over the classic-important baseline',()=>{
  const body=rule(skins,owner+'[data-qm-theme]');
  for(const property of ['background','color','border-color','border-radius','box-shadow'])assert.match(body,new RegExp('(?:^|;)\\s*'+property+':[^;]+!important\\s*;'));
  assert.match(body,/background:\s*var\(--qm-skin-window\)/);assert.match(body,/color:\s*var\(--qm-ink\)/);
  assert.match(body,/border-radius:\s*var\(--qm-card-radius\)/);
});
test('owned popup notes inherit readable theme ink even when host small text is forced',()=>{
  assert.match(rule(base,owner+' :is(h3,label,p,span,small)'),/color:inherit!important/);
});
