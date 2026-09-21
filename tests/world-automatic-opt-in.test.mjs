import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createStoryboardDefaults,normalizeStoryboardState,STORYBOARD_SCHEMA_VERSION} from '../qianmu-storyboard.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');

test('world automatic count defaults conservatively and cannot migrate invalid values into a larger batch',()=>{
  assert.equal(createStoryboardDefaults().directorBridge.worldAutoMaxImages,1);
  for(const value of [undefined,null,0,-1,5,NaN,Infinity,'bad'])assert.equal(normalizeStoryboardState({schemaVersion:STORYBOARD_SCHEMA_VERSION,directorBridge:{worldAutoMaxImages:value}}).directorBridge.worldAutoMaxImages,1);
  for(const value of [1,2,3,4,'2'])assert.equal(normalizeStoryboardState({schemaVersion:STORYBOARD_SCHEMA_VERSION,directorBridge:{worldAutoMaxImages:value}}).directorBridge.worldAutoMaxImages,Number(value));
});

for(const family of ['novel','openai','comfy'])test(`${family} exposes one default-off world control even with no discovered source`,()=>{
  const f=createStoryboardFormFixture({family});Object.assign(f.context,{getChatKey:()=> 'chat',directorProductionPacketState:{chatKey:'chat',packets:[]}});
  vm.runInContext(section('renderStoryboardProductionSources'),f.context);f.state.directorBridge.worldSideShotsEnabled=true;
  const render=()=>f.context.renderStoryboardCreate(f.state);let content=render();
  assert.equal((content.match(/class="sd-storyboard-world-auto"/g)||[]).length,1);assert.match(content,/仅新完成的推演/);assert.match(content,/value="1" selected/);
  assert.doesNotMatch(content.match(/<input[^>]*class="sd-storyboard-world-auto"[^>]*>/)[0],/checked/);
  assert.match(content.match(/<select[^>]*class="text_pole sd-storyboard-world-limit"[^>]*>/)[0],/disabled/);
  f.state.directorBridge.worldAutoGenerate=true;f.state.automation.autoGenerate=false;content=render();
  assert.match(content.match(/<input[^>]*class="sd-storyboard-world-auto"[^>]*>/)[0],/checked/);
  assert.doesNotMatch(content.match(/<select[^>]*class="text_pole sd-storyboard-world-limit"[^>]*>/)[0],/disabled/);
  f.state.directorBridge.worldSideShotsEnabled=false;assert.doesNotMatch(render(),/sd-storyboard-world-auto"/);
});

test('actual world controls save preferences and stop unstarted work without replaying or deleting history',()=>{
  const state=createStoryboardDefaults(),handlers=new Map();let saved=0,rendered=0,closed=0;
  const code=source.slice(source.indexOf("  root.querySelector('.sd-storyboard-world-auto')"),source.indexOf("  if (state.view === 'create')",source.indexOf("  root.querySelector('.sd-storyboard-world-auto')")));
  const context=vm.createContext({state,root:{querySelector:selector=>({addEventListener:(_,fn)=>handlers.set(selector,fn)})},
    storyboardWorldAutomaticEpoch:0,storyboardWorldAutomaticRuntime:{close:()=>closed++},saveSettings:()=>saved++,renderModal:()=>rendered++});
  vm.runInContext(section('storyboardResetWorldAutomatic')+'\n'+code,context);
  handlers.get('.sd-storyboard-world-auto')({target:{checked:true}});assert.equal(state.directorBridge.worldAutoGenerate,true);assert.equal(closed,1);
  handlers.get('.sd-storyboard-world-limit')({target:{value:'4'}});assert.equal(state.directorBridge.worldAutoMaxImages,4);
  handlers.get('.sd-storyboard-world-limit')({target:{value:'99'}});assert.equal(state.directorBridge.worldAutoMaxImages,1);
  assert.equal(saved,3);assert.equal(rendered,3);assert.equal(context.storyboardWorldAutomaticEpoch,3);
  assert.doesNotMatch(code,/GenerateProductionPacket|QueueNewWorldPlan|refreshDirectorProductionPackets|discardRequested|\.clear\(/);
});

test('only a successfully adopted new director plan dispatches the automatic world entry',()=>{
  assert.equal((source.match(/storyboardQueueNewWorldPlan\(newPlan,/g)||[]).length,1);
  const generation=section('generateDirectorPlan');assert.ok(generation.indexOf('storyboardQueueNewWorldPlan(newPlan')>generation.indexOf('await saveMetadata()'));
  assert.ok(generation.indexOf('storyboardQueueNewWorldPlan(newPlan')>generation.indexOf('await applyDirectorInjection()'));
  for(const name of ['init','renderStoryboardProductionSources','prepareDirectorWorldEntryLinks','refreshDirectorProductionPackets'])assert.doesNotMatch(section(name),/storyboardQueueNewWorldPlan/);
  assert.match(section('resetDirectorNarrativeBridge'),/storyboardResetWorldAutomatic\(\)/);
});
