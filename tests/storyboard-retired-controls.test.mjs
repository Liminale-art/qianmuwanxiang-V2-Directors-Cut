import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeStoryboardAutomation,normalizeStoryboardState,createStoryboardDefaults} from '../qianmu-storyboard.js';
import {createStoryboardFormFixture} from './helpers/storyboard-form-fixture.mjs';

test('legacy extraction-off migrates once to image-off without mutating source settings',()=>{
  for(const autoGenerate of [true,false,undefined]){
    const old={autoCapture:false,...(autoGenerate===undefined?{}:{autoGenerate})},saved=structuredClone(old);
    const next=normalizeStoryboardAutomation(old);assert.deepEqual(next,{autoGenerate:false,streamEnabled:false});assert.deepEqual(old,saved);
    assert.deepEqual(normalizeStoryboardAutomation(next),next);
    next.autoGenerate=true;assert.deepEqual(normalizeStoryboardAutomation(next),{autoGenerate:true,streamEnabled:false});
  }
});

test('removing extraction choice preserves enabled image preferences and the master opt-in',()=>{
  assert.deepEqual(normalizeStoryboardAutomation({autoCapture:true,autoGenerate:true}),{autoGenerate:true,streamEnabled:false});
  assert.deepEqual(normalizeStoryboardAutomation({autoGenerate:false}),{autoGenerate:false,streamEnabled:false});
  const defaults=createStoryboardDefaults();assert.equal(defaults.enabled,false);assert.deepEqual(defaults.automation,{autoGenerate:true,streamEnabled:false});
  const old=createStoryboardDefaults();old.enabled=false;old.automation={autoCapture:false,autoGenerate:true};
  const next=normalizeStoryboardState(old);assert.equal(next.enabled,false);assert.equal(next.automation.autoGenerate,false);
  assert.equal(Object.hasOwn(next.automation,'autoCapture'),false);
});

for(const enabled of [false,true])test(`the ${enabled?'enabled':'disabled'} master owns two equal options without a hidden extraction gate`,()=>{
  const f=createStoryboardFormFixture({enabled}),card=f.context.renderStoryboardAutomationCard(f.state);
  assert.equal((card.match(/class="sd-option-chip"/g)||[]).length,2);
  assert.doesNotMatch(card,/auto-capture|自动提取生成词/);
  const image=card.match(/<input[^>]*class="sd-storyboard-auto-generate"[^>]*>/)?.[0];assert.ok(image);
  assert.equal(/disabled/.test(image),!enabled);
});

test('retired presentation CSS and binding helpers are removed without removing actual task guards',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),css=await readFile(new URL('../style.css',import.meta.url),'utf8');
  assert.doesNotMatch(source,/autoCapture|renderStoryboardVideoConnectionCard|renderStoryboardVideoBudgetCard|storyboardPaintVideoConnectionState/);
  assert.doesNotMatch(css,/sd-video-channel-|sd-video-budget-/);
  assert.match(css,/sd-storyboard-automation-options\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(source,/!state\.enabled \|\| !state\.promptCompiler\?\.enabled/);
  assert.match(source,/storyboardAutomaticJobEnabled\(job,\s*(?:state|storyboardState\(\))\)/);
});
