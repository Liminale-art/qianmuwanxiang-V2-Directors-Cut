import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createStoryboardDefaults,normalizeStoryboardAutomation} from '../qianmu-storyboard.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');

test('streaming is opt-in for new, old and imported settings without changing the duplicate-switch migration',()=>{
  assert.equal(createStoryboardDefaults().automation.streamEnabled,false);
  for(const streamEnabled of [undefined,null,'true','false',0,1,[],{}])assert.equal(normalizeStoryboardAutomation({streamEnabled}).streamEnabled,false);
  assert.equal(normalizeStoryboardAutomation({streamEnabled:true}).streamEnabled,true);
  const migrated=normalizeStoryboardAutomation({autoCapture:false,autoGenerate:true,streamEnabled:true});assert.equal(migrated.autoGenerate,false);assert.equal(migrated.streamEnabled,true);
});

for(const family of ['novel','comfy'])test(`${family} has exactly one opt-in under shared generation settings with the cost and continue boundary`,()=>{
  const f=createStoryboardFormFixture({family});assert.equal((f.content.match(/class="sd-storyboard-stream-enabled"/g)||[]).length,1);
  const render=()=>f.context.renderStoryboardGenerationCard(f.state),input=()=>render().match(/<input[^>]*class="sd-storyboard-stream-enabled"[^>]*>/)?.[0];
  assert.doesNotMatch(input(),/checked/);assert.doesNotMatch(input(),/disabled/);
  f.state.automation.streamEnabled=true;assert.match(input(),/checked/);
  f.state.automation.autoGenerate=false;assert.match(input(),/disabled/);assert.match(input(),/checked/);
  f.state.automation.autoGenerate=true;f.state.enabled=false;assert.match(input(),/disabled/);
  assert.match(render(),/续写完成后补图/);assert.match(render(),/可能增加取景次数/);assert.doesNotMatch(f.context.renderStoryboardAutomationCard(f.state),/stream-enabled|auto-capture/);
});

test('the actual stream checkbox stores only its preference and stops future early work without deleting queued pictures',()=>{
  let change,saved=0,rendered=0,stopped=0;const state=createStoryboardDefaults();state.enabled=true;
  const code=source.slice(source.indexOf("root.querySelector('.sd-storyboard-stream-enabled')"),source.indexOf("root.querySelector('.sd-storyboard-world-side')"));
  vm.runInNewContext(code,{state,root:{querySelector:()=>({addEventListener:(_name,fn)=>change=fn})},storyboardStreamRuntime:{takeover:()=>stopped++},saveSettings:()=>saved++,renderModal:()=>rendered++});
  change({target:{checked:true}});assert.equal(state.automation.streamEnabled,true);assert.equal(stopped,0);
  change({target:{checked:false}});assert.equal(state.automation.streamEnabled,false);assert.equal(stopped,1);assert.equal(saved,2);assert.equal(rendered,2);
  assert.doesNotMatch(code,/discardRequested|ClearWaitingQueue|Delete|clear\(/);
});

test('production wiring mounts once with ST events, resets and closes with ownership, and wakes only from existing queue handoffs',()=>{
  assert.match(section('bindEvents'),/storyboardStreamRuntime=storyboardCreateStreamHost\(\)/);
  assert.match(section('unbindEvents'),/storyboardStreamRuntime\?\.close\(\);storyboardStreamRuntime=null/);
  assert.match(section('storyboardResetAutomaticCapture'),/storyboardStreamRuntime\?\.reset\(\)/);
  assert.match(section('storyboardScheduleAutomaticCapture'),/storyboardStreamRuntime\?\.wake\(\)/);
  const create=section('storyboardCreateStreamHost');assert.match(create,/settings\.enabled&&state\.enabled&&state\.promptCompiler\?\.enabled&&state\.automation\.autoGenerate&&state\.automation\.streamEnabled===true/);
  assert.match(create,/storyboardCompilerBusy\|\|Boolean\(storyboardAutomaticCurrent\)/);assert.match(create,/runStoryboardStreamPass/);
  assert.doesNotMatch(create,/setInterval|fetch\(|Generate\(|saveSettings\(/);
});

test('actual host factory requires every opt-in gate and gives existing automatic work priority',()=>{
  const state=createStoryboardDefaults(),settings={enabled:true};state.enabled=true;state.promptCompiler.enabled=true;state.automation.streamEnabled=true;
  const context=vm.createContext({settings,storyboardState:()=>state,ctx:()=>({}),getChatKey:()=> 'chat-a',storyboardAutomaticEpoch:0,document:{},setTimeout,clearTimeout,
    storyboardCompilerBusy:false,storyboardAutomaticCurrent:null,storyboardQueueBatches:new Set(),createStoryboardStreamHost:options=>options});
  vm.runInContext(section('storyboardCreateStreamHost'),context);const host=context.storyboardCreateStreamHost();assert.equal(host.enabled(),true);assert.equal(host.busy(),false);
  for(const [owner,key] of [[settings,'enabled'],[state,'enabled'],[state.promptCompiler,'enabled'],[state.automation,'autoGenerate'],[state.automation,'streamEnabled']]){
    owner[key]=false;assert.equal(host.enabled(),false);owner[key]=true;
  }
  context.storyboardAutomaticCurrent={};assert.equal(host.busy(),true);context.storyboardAutomaticCurrent=null;context.storyboardCompilerBusy=true;assert.equal(host.busy(),true);
  context.storyboardCompilerBusy=false;
  const batch={stream:true,complete:false,chatKey:'chat-a'};context.storyboardQueueBatches.add(batch);assert.equal(host.busy(),true);
  batch.complete=true;assert.equal(host.busy(),false);batch.complete=false;batch.chatKey='another-chat';assert.equal(host.busy(),false);
});
