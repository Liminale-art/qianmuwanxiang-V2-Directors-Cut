import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('assistant uses the existing host refresh and cleanup, outside storyboard enablement, without loading its panel eagerly',async()=>{
  const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),wrapper=await readFile(new URL('../qianmu-prose-floor-tools.js',import.meta.url),'utf8'),floor=await readFile(new URL('../qianmu-prose-assistant-floor.js',import.meta.url),'utf8');
  assert.match(entry,/const collectionFloorTools=createProseFloorTools\(/);assert.match(wrapper,/createTextCollectionFloorTools\(\{\.\.\.options,extraFloorTools:assistant\}\)/);
  const render=entry.slice(entry.indexOf('function storyboardRenderInlineImages('),entry.indexOf('function storyboardScheduleInlineRender('));assert.ok(render.indexOf('collectionFloorTools.refresh(chatRoot)')<render.indexOf('if (!storyboardState().enabled)'));
  assert.doesNotMatch(floor,/^import.*panel|new MutationObserver|setInterval\(/m);assert.match(floor,/await import\('\.\/qianmu-prose-assistant-panel.js'\)/);assert.match(floor,/floorCollectionText\(candidate\?\.querySelector\('\.mes_text'\)\)/);
  assert.match(floor,/controller.abort\(\)/);assert.match(entry,/assistantConfig:\(\)=>\(\{\.\.\.settings.proseAssistant,profiles:settings.apiProfiles\}\)/);
});
