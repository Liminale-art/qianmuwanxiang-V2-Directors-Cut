import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const skins=await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
const rules=[...skins.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>({selector:selector.trim(),body:body.trim()}));

test('new-theme shelf keeps the native fixed import button anchored without restoring blur or changing unrelated windows',()=>{
  const rulesWithContainment=rules.filter(rule=>/\bcontain\s*:\s*layout\s*;/.test(rule.body));
  assert.equal(rulesWithContainment.length,1);
  assert.equal(rulesWithContainment[0].selector,'#story-director-modal:is([data-qm-theme="editorial"], [data-qm-theme="glass"]) .sd-window:has(.sd-reader-lib)');
  assert.equal(rulesWithContainment[0].body,'contain: layout;','restore only the containing block, not window dimensions or a second import widget');
  const windowSkin=rules.find(rule=>rule.selector==='#story-director-modal[data-qm-theme] .sd-window');
  assert.ok(windowSkin);
  assert.match(windowSkin.body,/backdrop-filter:\s*none\s*!important/);
  assert.match(css,/#story-director-modal \.sd-reader-import-fab\s*\{[^}]*position:\s*fixed;[^}]*right:\s*26px;[^}]*bottom:\s*26px;/);
  assert.match(css,/#story-director-modal \.sd-reader-import-fab\s*\{[^}]*width:\s*58px;[^}]*height:\s*58px;/);
  assert.doesNotMatch(rulesWithContainment[0].body,/transform|filter|overflow|width|height|position/);
});

test('only the five glass main-header actions and storyboard/workbench close get circular chrome',()=>{
  const roundRule=rules.find(rule=>rule.selector.includes('.sd-header-actions :is(')&&/border-radius:\s*50%\s*!important/.test(rule.body));
  assert.ok(roundRule);
  assert.equal(roundRule.selector,'#story-director-modal[data-qm-theme="glass"] .sd-header-actions :is(.sd-coread-shortcut, .sd-storyboard-shortcut, .sd-plug-shortcut, .sd-theme-btn, .sd-close),\n#story-director-modal[data-qm-theme="glass"] .sd-storyboard-titlebar > .sd-storyboard-close');
  assert.equal(roundRule.body,'border-radius: 50% !important;','hit areas, glyph size and action behavior remain unchanged');
  assert.doesNotMatch(roundRule.selector,/editorial|classic|\.sd-icon-btn|\.sd-btn\b/);
  const start=entry.indexOf('function renderModal()'),modal=entry.slice(start,entry.indexOf('\nfunction ',start+1));
  for(const role of ['sd-coread-shortcut','sd-storyboard-shortcut','sd-plug-shortcut','sd-close'])assert.match(modal,new RegExp('<button class="'+role+'\\b'));
  assert.match(modal,/renderQianmuThemeMenu\(/);
  assert.match(entry,/<header class="sd-storyboard-titlebar">[\s\S]*?<button type="button" class="sd-icon-btn sd-storyboard-close"/);
});

test('editorial shelf import is square while classic/glass keep their round 58px native target',()=>{
  const importRules=rules.filter(rule=>rule.selector.includes('.sd-reader-import-fab'));
  assert.equal(importRules.length,1,'only editorial overrides the existing import silhouette');
  assert.equal(importRules[0].selector,'#story-director-modal[data-qm-theme="editorial"] .sd-reader-import-fab');
  assert.equal(importRules[0].body,'border-radius: 0 !important;','theme shape must not alter the hit area, position or native input');
  assert.match(css,/#story-director-modal \.sd-reader-import-fab\s*\{[^}]*position:\s*fixed;[^}]*right:\s*26px;[^}]*bottom:\s*26px;[^}]*width:\s*58px;[^}]*height:\s*58px;[^}]*border-radius:\s*50%;/);
});
