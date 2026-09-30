import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const css=await readFile(new URL('../qianmu-prose-assistant.css',import.meta.url),'utf8');
const skins=await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>({selector:selector.trim(),body}));
const rule=selector=>{
 const found=rules.find(item=>item.selector===selector);
 assert.ok(found,`missing scoped rule: ${selector}`);
 return found.body;
};
const scope='.qm-prose-assistant-dialog';
const portal=`html body :is(#story-director-modal,[data-qm-prose-assistant-portal]) ${scope}`;
const textFields=':is(input:not([type="checkbox"]),select,textarea)';

test('assistant visual rules stay inside its window and use inherited theme tokens',()=>{
 for(const {selector} of rules){
  if(/^[\d%,\s]+$/.test(selector))continue;
  assert.ok(selector.startsWith(scope),`unscoped rule: ${selector}`);
  if(selector.includes('html body'))assert.ok(selector.includes(portal),'higher-priority rule must retain its assistant-only boundary');
 }
 assert.match(rule(scope),/background:var\(--sd-sticky-bg,/);
 assert.match(rule(scope),/color:var\(--sd-text,/);
 assert.match(rule(`${scope} select option`),/background:var\(--sd-sticky-bg,/);
});

test('settings controls share one quiet input style without a focus outer frame',()=>{
 const fields=rule(`${scope} input:not([type="checkbox"]),${scope} select,${scope} textarea`);
 assert.match(fields,/border:1px solid var\(--sd-border,/);
 assert.match(fields,/border-radius:10px/);
 assert.match(fields,/background:var\(--sd-input-bg,/);
 assert.match(rule(`${scope} .qm-pa-config label > span`),/font:inherit;font-size:calc\(1em - 2px\);line-height:1\.45;color:var\(--sd-text,/);
 const focus=rule(`${scope} ${textFields}:is(:focus,:focus-visible),\n${portal} ${textFields}:is(:focus,:focus-visible)`);
 assert.match(focus,/outline:0!important/);assert.match(focus,/box-shadow:none!important/);
 // The real skin selector carries ID specificity through :is(). The portal
 // branch deliberately matches that level and adds the owned dialog boundary.
 assert.match(skins,/:is\(#story-director-modal, \[data-qm-theme\]\)\[data-qm-theme\] :is\(button, input, select, textarea, summary, a\):focus-visible\s*\{\s*outline: 2px solid var\(--qm-ink\) !important/);
 assert.match(rule(`${scope} ${textFields}:focus-visible,\n${portal} ${textFields}:focus-visible`),/border-color:var\(--sd-accent,.*!important/);
 assert.match(rule(`${scope} textarea[data-pa-prompt]`),/resize:vertical/);
 assert.match(rule(`${scope} .qm-pa-stream input[type="checkbox"]`),/width:17px;height:17px;min-height:0/);
});

test('composer and conversation share typography with right-aligned user bubbles',()=>{
 assert.match(rule(scope),/font-size:var\(--mainFontSize,16px\)/);
 for(const selector of [`.qm-pa-composer [data-pa-question]`,'.qm-pa-user','.qm-pa-reply']){
  assert.match(rule(`${scope} ${selector}`),/font:inherit;line-height:1\.6/);
 }
 assert.match(rule(`${scope} .qm-pa-user`),/align-self:flex-end/);
 assert.match(rule(`${scope} .qm-pa-user`),/max-width:88%/);
 assert.match(rule(`${scope} .qm-pa-composer [data-pa-question]`),/height:calc\(1\.6em \+ 16px\);min-height:44px/);
 assert.match(rule(`${scope} :is(.qm-pa-user,.qm-pa-reply,.qm-pa-composer,.qm-pa-edit)`),/font-size:var\(--sd-prose-font-size,var\(--qm-pa-prose-size,var\(--mainFontSize,16px\)\)\)/);
 const mobile=css.split('\n').filter(line=>line.startsWith('@media (max-width:620px)'));
 assert.equal(mobile.length,1);assert.doesNotMatch(mobile[0],/font-size:/);
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
 assert.doesNotMatch(css,/data-pa-turn-menu/);
 assert.match(rule(`${scope} .qm-pa-user-actions`),/align-self:flex-end/);
 assert.match(rule(`${scope} .qm-pa-reply-actions`),/align-self:flex-start/);
 assert.match(rule(`${scope} .qm-pa-edit button`),/width:34px;height:34px/);
});

test('resize cue uses the theme accent and stays clear of the bottom send control',()=>{
 const handle=rule(`${scope} [data-pa-resize]`),cue=rule(`${scope} [data-pa-resize]::after`);
 assert.match(handle,/width:28px;height:28px/);
 assert.match(handle,/clip-path:polygon\(100% 0,100% 100%,0 100%\)/);
 assert.match(cue,/var\(--sd-accent,/);assert.match(cue,/border-bottom-right-radius:/);
 assert.match(cue,/pointer-events:none/);
 assert.match(rule(`${scope} > footer`),/padding:10px 14px/);
 assert.match(rule(`${scope} .qm-pa-composer`),/padding:4px;border:1px/);
 // A 28px lower-right triangular hit area cannot reach the nearest corner of
 // send: right=14+4+1 and bottom=10+4+1, whose sum is greater than 28.
 assert.ok((14+4+1)+(10+4+1)>28);
 assert.match(rule(`${scope} .qm-pa-composer textarea,\n${portal} .qm-pa-composer textarea`),/border:0!important;background:transparent!important/);
});

test('plain-text fallback preserves line breaks and the recent-conversation list replaces the former clear action',()=>{
 assert.match(rule(`${scope} .qm-pa-reply.qm-pa-plain`),/white-space:pre-wrap/);
 assert.doesNotMatch(css,/data-pa-action="clear"/);
 assert.match(rule(`${scope}[hidden]`),/display:none!important/);
});

test('message action glyphs shrink without shrinking hit areas and only question resubmit uses the accent fill',()=>{
 assert.match(rule(`${scope} :is(.qm-pa-message-actions,.qm-pa-edit) button :is(i,svg)`),/width:14\.4px;height:14\.4px;font-size:14\.4px/);
 assert.match(rule(`${scope} button`),/width:34px;height:34px/);
 assert.match(rule(`${scope} .qm-pa-edit button`),/width:34px;height:34px/);
 assert.match(rule(`${scope} .qm-pa-edit`),/justify-content:flex-end/);
 assert.match(rule(`${scope} .qm-pa-edit[data-pa-edit-kind="question"] [data-pa-action="save-reply"]`),/background:var\(--sd-accent,.*color:var\(--sd-primary-text,/);
 assert.doesNotMatch(rule(`${scope} .qm-pa-edit button`),/--sd-accent/);
});

test('recent conversation rows stay compact with fixed metadata, no current fill and matched-height search',()=>{
 assert.doesNotMatch(css,/\.qm-pa-conversation[^{}]*\.is-current/);
 const item=rule(`${scope} .qm-pa-conversation-item`),row=rule(`${scope} button.qm-pa-conversation-row`);
 assert.match(item,/display:flex;align-items:center/);assert.match(item,/min-height:42px/);assert.match(row,/display:flex;flex:1;align-items:center/);assert.doesNotMatch(row,/flex-direction:column/);
 assert.match(rule(`${scope} .qm-pa-conversation-title`),/flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
 assert.match(rule(`${scope} .qm-pa-conversation-meta`),/display:flex;flex:none/);assert.match(rule(`${scope} .qm-pa-conversation-meta`),/white-space:nowrap/);
 assert.match(rule(`${scope} .qm-pa-conversation-toolbar input`),/height:34px;min-height:34px;padding:4px 8px/);
 assert.match(rule(`${scope} button`),/width:34px;height:34px/);
 assert.match(rule(`${scope} .qm-pa-conversation-item > button[data-pa-list-action="rename"] svg,${scope} .qm-pa-conversation-edit button svg`),/width:14\.4px;height:14\.4px/);
});

test('settings prompt fills remaining panel height while long settings and manual resize can scroll',()=>{
 assert.match(rule(`${scope} > [data-pa-settings]`),/display:flex;flex-direction:column/);
 assert.match(rule(`${scope} > main,${scope} > [data-pa-settings]`),/flex:1;min-height:0;overflow:auto/);
 assert.match(rule(`${scope} .qm-pa-config`),/display:flex;flex-direction:column;flex:1 0 auto/);
 assert.match(rule(`${scope} .qm-pa-config .qm-pa-prompt-field`),/display:flex;flex-direction:column;flex:1 0 auto/);
 assert.match(rule(`${scope} textarea[data-pa-prompt]`),/flex:1 0 auto;height:120px;min-height:120px;max-height:none;resize:vertical;overflow:auto/);
});

test('history navigation stays quiet and compact while manual prepend controls scroll anchoring',()=>{
 assert.match(rule(`${scope} > main`),/overflow-anchor:none/);
 const actions=rule(`${scope} :is([data-pa-action="older-messages"],[data-pa-action="latest-messages"],[data-pa-action="capacity-new"])`);
 assert.match(actions,/width:auto;height:auto;min-height:28px;max-width:100%/);
 assert.match(actions,/padding:3px 8px;font-size:calc\(1em - 2px\);line-height:1\.4/);
 assert.match(actions,/color:var\(--sd-muted,/);
 const centered=rule(`${scope} :is([data-pa-action="older-messages"],[data-pa-action="latest-messages"])`);
 assert.match(centered,/display:flex;max-width:max-content;margin:0 auto 6px/);
 assert.match(rule(`${scope} [hidden]`),/display:none!important/);
});

test('capacity hint wraps above the composer without changing the input or send control dimensions',()=>{
 const capacity=rule(`${scope} [data-pa-capacity]`);
 assert.match(capacity,/display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:0 0 6px/);
 assert.match(rule(`${scope} [data-pa-capacity] > small`),/flex:1 1 160px;margin:0;overflow-wrap:anywhere/);
 assert.match(rule(`${scope} [data-pa-action="capacity-new"]`),/color:var\(--sd-accent,/);
 assert.match(rule(`${scope} > footer`),/flex:none;padding:10px 14px/);
 assert.match(rule(`${scope} .qm-pa-composer [data-pa-question]`),/min-height:44px/);
 assert.match(rule(`${scope} .qm-pa-composer :is([data-pa-action="send"],[data-pa-action="stop"])`),/min-height:44px/);
});
