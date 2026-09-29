import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const css=await readFile(new URL('../qianmu-prose-assistant.css',import.meta.url),'utf8');
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>({selector:selector.trim(),body}));
const rule=selector=>{
 const found=rules.find(item=>item.selector===selector);
 assert.ok(found,`missing scoped rule: ${selector}`);
 return found.body;
};
const scope='.qm-prose-assistant-dialog';

test('assistant visual rules stay inside its window and use inherited theme tokens',()=>{
 for(const {selector} of rules){
  if(/^[\d%,\s]+$/.test(selector))continue;
  for(const part of selector.split(/,(?![^()]*\))/))assert.ok(part.trim().startsWith(scope),`unscoped rule: ${part}`);
 }
 assert.match(rule(scope),/background:var\(--sd-sticky-bg,/);
 assert.match(rule(scope),/color:var\(--sd-text,/);
 assert.match(rule(`${scope} select option`),/background:var\(--sd-sticky-bg,/);
});

test('settings controls share one quiet input style without a focus outer frame',()=>{
 const fields=rule(`${scope} input:not([type="checkbox"]),${scope} select,${scope} textarea`);
 assert.match(fields,/border:1px solid var\(--sd-hairline,/);
 assert.match(fields,/border-radius:10px/);
 assert.match(fields,/background:var\(--sd-input-bg,/);
 const focus=rule(`${scope} :is(input,select,textarea):is(:focus,:focus-visible)`);
 assert.match(focus,/outline:0!important/);assert.match(focus,/box-shadow:none!important/);
 assert.match(rule(`${scope} textarea[data-pa-prompt]`),/resize:vertical/);
 assert.match(rule(`${scope} .qm-pa-stream input[type="checkbox"]`),/width:17px;height:17px;min-height:0/);
});

test('composer and conversation share typography with right-aligned user bubbles',()=>{
 assert.match(rule(scope),/font-size:16px/);
 for(const selector of [`.qm-pa-composer [data-pa-question]`,'.qm-pa-user','.qm-pa-reply']){
  assert.match(rule(`${scope} ${selector}`),/font:inherit;line-height:1\.6/);
 }
 assert.match(rule(`${scope} .qm-pa-user`),/align-self:flex-end/);
 assert.match(rule(`${scope} .qm-pa-user`),/max-width:88%/);
 assert.doesNotMatch(css,/@media\s*\(max-width:620px\)[\s\S]*font-size:/);
});

test('send and stop remain a single rounded-square control with a filled stop glyph',()=>{
 const control=rule(`${scope} .qm-pa-composer :is([data-pa-action="send"],[data-pa-action="stop"])`);
 assert.match(control,/width:44px;height:auto;min-height:44px/);
 assert.match(control,/border-radius:12px;background:var\(--sd-accent,/);
 assert.match(rule(`${scope} .qm-pa-composer [data-pa-action="stop"] svg`),/fill:currentColor/);
});

test('markdown and waiting dots have scoped reading styles and reduced-motion support',()=>{
 assert.match(rule(`${scope} .qm-pa-reply`),/white-space:normal/);
 assert.match(rule(`${scope} .qm-pa-reply pre`),/overflow:auto;white-space:pre/);
 assert.match(rule(`${scope} .qm-pa-reply table`),/overflow-x:auto/);
 assert.match(rule(`${scope} .qm-pa-typing > span`),/animation:qm-pa-typing-dot 1\.1s/);
 assert.match(rule(`${scope} .qm-pa-typing > span:nth-child(2)`),/animation-delay:\.18s/);
 assert.match(rule(`${scope} .qm-pa-typing > span:nth-child(3)`),/animation-delay:\.36s/);
 assert.match(css,/@media \(prefers-reduced-motion:reduce\).*animation:none/);
 assert.match(rule(`${scope} [data-pa-turn-menu] button`),/width:auto;height:auto;min-height:34px/);
});

test('resize cue uses the theme accent and stays clear of the bottom send control',()=>{
 const handle=rule(`${scope} [data-pa-resize]`),cue=rule(`${scope} [data-pa-resize]::after`);
 assert.match(handle,/width:28px;height:28px/);
 assert.match(cue,/var\(--sd-accent,/);assert.match(cue,/border-bottom-right-radius:/);
 assert.match(cue,/pointer-events:none/);
 for(const footer of rules.filter(item=>item.selector===`${scope} > footer`)){
  const bottom=Number(footer.body.match(/padding:\d+px \d+px (\d+)px/)[1]);
  assert.ok(bottom>28,'resize handle must not intercept the send or stop button');
 }
});

test('plain-text fallback preserves line breaks and the current clear action remains full width until the conversation list replaces it',()=>{
 assert.match(rule(`${scope} .qm-pa-reply.qm-pa-plain`),/white-space:pre-wrap/);
 assert.match(rule(`${scope} .qm-pa-config [data-pa-action="clear"]`),/width:100%;height:auto/);
});
